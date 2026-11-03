/**
 * Main-thread side of the audio engine. Reconciles AppModel state into engine messages
 * and sends them through an EnginePort: the AudioWorklet in the browser (mip sets are
 * built here, off the audio thread, in small chunks and transferred) or the native
 * engine inside the plugin (raw tables; it builds the mip sets).
 */
import type { AppModel } from '../app/model';
import { emptyStatus, type EngineStatus } from '../core/engine/engine';
import type { MidiVoiceEvent } from '../core/midi';
import { buildMipSet } from '../core/mipmap';
import type { TableId, WaveTable } from '../core/table';
import type { VoiceParams } from '../core/voice';
import type { Wavetable } from '../core/wavetable';
import { packWavetable } from '../core/wavetablePlayback';
import { WorkletPort, type EnginePort } from './port';
import type { FromWorklet, ToWorklet } from './protocol';

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
  /** Messages are only sent once the port is open (then everything is synced). */
  private open = false;
  private opening: Promise<void> | null = null;
  private transportMuted = false;
  private sentTables = new Set<TableId>();
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

  readonly port: EnginePort;

  constructor(model: AppModel, port: EnginePort = new WorkletPort()) {
    this.model = model;
    this.port = port;
    model.on('timeline', () => this.syncTables());
    model.on('wavetables', () => this.syncWavetables());
    model.on('voices', () => this.syncVoices());
    model.on('sequences', () => this.syncSequences());
    model.on('transport', () => this.syncTransport());
  }

  get sampleRate(): number {
    return this.port.sampleRate;
  }

  /** Open the port (browser: create the AudioContext, on a user gesture). Safe to call repeatedly. */
  async start(): Promise<void> {
    if (this.open) return this.port.open((m) => this.onMessage(m));
    if (this.opening) return this.opening;
    this.setState('starting');
    this.opening = (async () => {
      try {
        await this.port.open((m) => this.onMessage(m));
        this.open = true;
        this.syncAll();
        this.setState('running');
      } catch (err) {
        this.error = String(err);
        this.setState('error');
        throw err;
      } finally {
        this.opening = null;
      }
    })();
    return this.opening;
  }

  /**
   * Tables the engine already holds (the plugin restored them with its state): they are
   * not sent again. Call before start().
   */
  assumeSent(ids: Iterable<TableId>): void {
    for (const id of ids) this.sentTables.add(id);
  }

  /**
   * What an already-running engine holds (the plugin's native state) before the first
   * sync: anything the model doesn't have is removed by it; voices, sequences and
   * wavetables the model has are sent again. Tables the model also has are only kept if
   * `trustTables` (same project, so same samples); otherwise they are replaced. Call before start().
   */
  adoptEngine(engine: { tables: Iterable<TableId>; voices: Iterable<number>; sequences: Iterable<number>; wavetables: Iterable<number> }, trustTables: boolean): void {
    const inModel = new Set(this.model.timeline.map((t) => t.id));
    for (const id of engine.tables) if (trustTables || !inModel.has(id)) this.sentTables.add(id);
    for (const id of engine.voices) this.sentVoices.add(id);
    for (const id of engine.sequences) this.sentSequences.add(id);
    // A placeholder never equals a model wavetable: present ones are resent, absent ones removed.
    for (const id of engine.wavetables) if (!this.sentWavetables.has(id)) this.sentWavetables.set(id, { id } as Wavetable);
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
    if (!this.open) return;
    this.outbox.push(m);
    this.transfers.push(...transfer);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  private flush(): void {
    this.flushScheduled = false;
    if (!this.open || !this.outbox.length) return;
    const ops = this.outbox;
    const transfer = this.transfers;
    this.outbox = [];
    this.transfers = [];
    this.port.post(ops, transfer);
  }

  private syncAll(): void {
    this.syncTables();
    this.syncWavetables();
    this.syncVoices();
    this.syncSequences();
    this.syncTransport();
  }

  private syncTables(): void {
    if (!this.open) return;
    const live = new Set<TableId>(this.model.timeline.map((t) => t.id));
    const removed = [...this.sentTables].filter((id) => !live.has(id));
    if (removed.length) {
      for (const id of removed) this.sentTables.delete(id);
      this.post({ type: 'tables/remove', ids: removed });
    }
    const queued = new Set(this.pending.map((t) => t.id));
    this.pending = this.pending.filter((t) => live.has(t.id));
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
    if (!this.open) return;
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
    if (this.port.rawTables) {
      for (const t of chunk) this.sentTables.add(t.id);
      this.post({ type: 'tables/addData', items: chunk.map((t) => ({ id: t.id, data: t.data })) });
      return;
    }
    const items = chunk.map((t) => ({ id: t.id, mips: buildMipSet(t.data) }));
    for (const t of chunk) this.sentTables.add(t.id);
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
    if (!this.open) return;
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
    if (!this.open) return;
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

  /** Any other engine op (e.g. the plugin's `midi/settings`); joins this task's batch. */
  sendOp(m: ToWorklet): void {
    this.post(m);
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

  /** Run `fn` (which changes the model's transport) without sending that change to the engine. */
  withoutTransportEcho(fn: () => void): void {
    this.transportMuted = true;
    try {
      fn();
    } finally {
      this.transportMuted = false;
    }
  }

  private syncTransport(): void {
    if (this.transportMuted) return;
    this.post({ type: 'transport', playing: this.model.playing, bpm: this.model.bpm });
  }
}
