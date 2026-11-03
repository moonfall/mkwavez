/**
 * Main-thread side of the audio engine. Owns the AudioContext + AudioWorkletNode and
 * reconciles AppModel state into worklet messages. Mip sets are built here (off the
 * audio thread) in small chunks and transferred.
 */
import type { AppModel } from '../app/model';
import { emptyStatus, type EngineStatus } from '../core/engine/engine';
import { buildMipSet } from '../core/mipmap';
import type { TableId, WaveTable } from '../core/table';
import { playbackIds } from '../core/wavetable';
import { PROCESSOR_NAME, type FromWorklet, type ToWorklet } from './protocol';
import workletUrl from './worklet.ts?worker&url';

export type AudioState = 'off' | 'starting' | 'running' | 'error';

/** Tables whose mip sets are built per main-thread tick while catching up. */
const MIP_CHUNK = 48;

export class AudioBridge {
  state: AudioState = 'off';
  error = '';
  status: EngineStatus = emptyStatus();
  workletTableCount = 0;
  onState?: (s: AudioState) => void;
  onStatus?: (s: EngineStatus) => void;

  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private sentTables = new Set<TableId>();
  private pending: WaveTable[] = [];
  private pumpScheduled = false;
  private sentVoices = new Set<number>();
  private sentSequences = new Set<number>();
  private sentWavetables = new Set<number>();
  private model: AppModel;

  constructor(model: AppModel) {
    this.model = model;
    model.on('timeline', () => this.syncTables());
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

  private setState(s: AudioState): void {
    this.state = s;
    this.onState?.(s);
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

  private post(m: ToWorklet, transfer: Transferable[] = []): void {
    this.node?.port.postMessage(m, transfer);
  }

  private syncAll(): void {
    this.syncTables();
    this.syncVoices();
    this.syncSequences();
    this.syncTransport();
  }

  private syncTables(): void {
    if (!this.node) return;
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
    this.pump();
    for (const wt of this.model.wavetables) {
      this.sentWavetables.add(wt.id);
      this.post({ type: 'wavetable/set', id: wt.id, ids: Int32Array.from(playbackIds(wt)) });
    }
    for (const id of [...this.sentWavetables]) {
      if (!this.model.wavetable(id)) {
        this.sentWavetables.delete(id);
        this.post({ type: 'wavetable/remove', id });
      }
    }
  }

  private pump(): void {
    if (this.pumpScheduled || !this.pending.length) return;
    const chunk = this.pending.splice(0, MIP_CHUNK);
    const items = chunk.map((t) => ({ id: t.id, mips: buildMipSet(t.data) }));
    for (const t of chunk) this.sentTables.add(t.id);
    this.post(
      { type: 'tables/add', items },
      items.map((i) => i.mips.buffer as ArrayBuffer),
    );
    if (this.pending.length) {
      this.pumpScheduled = true;
      setTimeout(() => {
        this.pumpScheduled = false;
        this.pump();
      }, 0);
    }
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

  private syncTransport(): void {
    this.post({ type: 'transport', playing: this.model.playing, bpm: this.model.bpm });
  }
}
