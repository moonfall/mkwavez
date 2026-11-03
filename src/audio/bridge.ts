/**
 * Main-thread side of the audio engine. Owns the AudioContext + AudioWorkletNode and
 * reconciles AppModel state into worklet messages. Mip sets are built here (off the
 * audio thread) in small chunks and transferred.
 */
import type { AppModel } from '../app/model';
import { emptyStatus, type EngineStatus } from '../core/engine/engine';
import type { MidiVoiceEvent } from '../core/midi';
import { buildMipSet } from '../core/mipmap';
import type { TableId, WaveTable } from '../core/table';
import type { VoiceParams } from '../core/voice';
import type { Wavetable } from '../core/wavetable';
import { packWavetable } from '../core/wavetablePlayback';
import { PROCESSOR_NAME, type FromWorklet, type ToWorklet } from './protocol';
import workletUrl from './worklet.ts?worker&url';

export type AudioState = 'off' | 'starting' | 'running' | 'error';

/** Tables whose mip sets are built per main-thread tick while catching up. */
const MIP_CHUNK = 48;
/**
 * Fresh tables built synchronously and sent in the same batch as (and before) the
 * wavetable that references them. Covers any UI batch (max 64); larger bulk adds
 * fall back to chunking, during which the engine holds the previous table.
 */
const SYNC_MIPS = 128;

export class AudioBridge {
  state: AudioState = 'off';
  error = '';
  status: EngineStatus = emptyStatus();
  workletTableCount = 0;
  onState?: (s: AudioState) => void;
  onStatus?: (s: EngineStatus) => void;

  private stateFns: ((s: AudioState) => void)[] = [];
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  /** Table ids the worklet holds → the data sent (a restored / imported session may reuse an id). */
  private sentTables = new Map<TableId, Float32Array>();
  private pending: WaveTable[] = [];
  private pumpScheduled = false;
  private sentVoices = new Set<number>();
  private sentSequences = new Set<number>();
  /** Wavetables as last sent (by object identity: they are immutable). */
  private sentWavetables = new Map<number, Wavetable>();
  private model: AppModel;
  private outbox: ToWorklet[] = [];
  private transfers: Transferable[] = [];
  private flushScheduled = false;

  constructor(model: AppModel) {
    this.model = model;
    model.on('timeline', () => this.syncTables());
    model.on('wavetables', () => this.syncWavetables());
    model.on('voices', () => this.syncVoices());
    model.on('sequences', () => this.syncSequences());
    model.on('transport', () => this.syncTransport());
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  /** Create the context on a user gesture. Safe to call repeatedly. */
  async start(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state !== 'running') await this.ctx.resume();
      return;
    }
    this.setState('starting');
    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      await ctx.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      node.port.onmessage = (e: MessageEvent<FromWorklet>) => this.onMessage(e.data);
      node.connect(ctx.destination);
      this.node = node;
      if (ctx.state !== 'running') await ctx.resume();
      this.syncAll();
      this.setState('running');
    } catch (err) {
      this.error = String(err);
      this.setState('error');
      throw err;
    }
  }

  /** Extra state listeners (besides `onState`, which the transport bar owns). */
  onStateChange(fn: (s: AudioState) => void): void {
    this.stateFns.push(fn);
  }

  private setState(s: AudioState): void {
    this.state = s;
    this.onState?.(s);
    for (const fn of this.stateFns) fn(s);
  }

  private onMessage(m: FromWorklet): void {
    if (m.type === 'status') {
      this.status = m.status;
      this.workletTableCount = m.tableCount;
      this.onStatus?.(m.status);
    } else if (m.type === 'error') {
      console.warn('[worklet]', m.message);
    }
  }

  /**
   * Queue a message. Everything queued in one task (e.g. one model action emitting
   * 'timeline' + 'voices') is delivered as a single batch, which the worklet applies
   * atomically between render quanta — so a re-indexed wavetable and the remapped
   * voice windows always arrive together.
   */
  private post(m: ToWorklet, transfer: Transferable[] = []): void {
    if (!this.node) return;
    this.outbox.push(m);
    this.transfers.push(...transfer);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  private flush(): void {
    this.flushScheduled = false;
    if (!this.node || !this.outbox.length) return;
    const ops = this.outbox;
    const transfer = this.transfers;
    this.outbox = [];
    this.transfers = [];
    this.node.port.postMessage({ type: 'batch', ops } satisfies ToWorklet, transfer);
  }

  private syncAll(): void {
    this.syncTables();
    this.syncWavetables();
    this.syncVoices();
    this.syncSequences();
    this.syncTransport();
  }

  private syncTables(): void {
    if (!this.node) return;
    const live = new Map<TableId, Float32Array>(this.model.timeline.map((t) => [t.id, t.data]));
    const removed = [...this.sentTables].filter(([id, data]) => live.get(id) !== data).map(([id]) => id);
    if (removed.length) {
      for (const id of removed) this.sentTables.delete(id);
      this.post({ type: 'tables/remove', ids: removed });
    }
    this.pending = this.pending.filter((t) => live.get(t.id) === t.data);
    const queued = new Set(this.pending.map((t) => t.id));
    // Newest first (and ahead of any backlog) so fresh tables become audible immediately.
    const fresh: WaveTable[] = [];
    for (let i = this.model.timeline.length - 1; i >= 0; i--) {
      const t = this.model.timeline[i];
      if (!this.sentTables.has(t.id) && !queued.has(t.id)) fresh.push(t);
    }
    this.pending = fresh.concat(this.pending);
    // Tables first, then the wavetable that references them (same batch).
    if (this.pending.length) this.sendChunk(Math.min(SYNC_MIPS, fresh.length || MIP_CHUNK));
    this.pump();
  }

  /**
   * Changed wavetables, packed (row offsets + ids). The model emits 'wavetables' right
   * after 'timeline' and before 'voices', so fresh tables, the wavetables referencing
   * them and the voices' new windows land in the same batch, in that order.
   */
  private syncWavetables(): void {
    if (!this.node) return;
    for (const wt of this.model.wavetables) {
      if (this.sentWavetables.get(wt.id) === wt) continue;
      this.sentWavetables.set(wt.id, wt);
      const packed = packWavetable(wt);
      this.post({ type: 'wavetable/set', id: wt.id, wavetable: packed }, [packed.rowStart.buffer as ArrayBuffer, packed.ids.buffer as ArrayBuffer]);
    }
    for (const id of [...this.sentWavetables.keys()]) {
      if (!this.model.wavetable(id)) {
        this.sentWavetables.delete(id);
        this.post({ type: 'wavetable/remove', id });
      }
    }
  }

  private sendChunk(n: number): void {
    const chunk = this.pending.splice(0, n);
    if (!chunk.length) return;
    const items = chunk.map((t) => ({ id: t.id, mips: buildMipSet(t.data) }));
    for (const t of chunk) this.sentTables.set(t.id, t.data);
    this.post(
      { type: 'tables/add', items },
      items.map((i) => i.mips.buffer as ArrayBuffer),
    );
  }

  /** Drain the backlog in chunks, one per main-thread tick. */
  private pump(): void {
    if (this.pumpScheduled || !this.pending.length) return;
    this.pumpScheduled = true;
    setTimeout(() => {
      this.pumpScheduled = false;
      this.sendChunk(MIP_CHUNK);
      this.pump();
    }, 0);
  }

  private syncVoices(): void {
    if (!this.node) return;
    const live = new Set<number>();
    for (const v of this.model.voices) {
      live.add(v.id);
      this.sentVoices.add(v.id);
      this.post({ type: 'voice/set', voice: v });
    }
    for (const id of [...this.sentVoices]) {
      if (!live.has(id)) {
        this.sentVoices.delete(id);
        this.post({ type: 'voice/remove', id });
      }
    }
  }

  private syncSequences(): void {
    if (!this.node) return;
    const live = new Set<number>();
    for (const s of this.model.sequences) {
      live.add(s.id);
      this.sentSequences.add(s.id);
      this.post({ type: 'sequence/set', sequence: s });
    }
    for (const id of [...this.sentSequences]) {
      if (!live.has(id)) {
        this.sentSequences.delete(id);
        this.post({ type: 'sequence/remove', id });
      }
    }
  }

  /**
   * Routed MIDI events, straight from the MIDI input handler (not the frame loop). They
   * join this task's batch, so a CC's voice/set and a note land in the same quantum.
   * Dropped while audio isn't running.
   */
  sendMidi(events: readonly MidiVoiceEvent[]): void {
    if (events.length) this.post({ type: 'midi', events: [...events] });
  }

  /** Light per-voice param change (MIDI CCs); the model's voice/set follows at frame rate. */
  patchVoice(id: number, patch: Partial<VoiceParams>): void {
    if (this.sentVoices.has(id)) this.post({ type: 'voice/patch', id, patch });
  }

  private syncTransport(): void {
    this.post({ type: 'transport', playing: this.model.playing, bpm: this.model.bpm });
  }
}
