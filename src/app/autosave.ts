/**
 * Autosave: watches the model (and UI prefs) and writes the session to a backend
 * (IndexedDB in the browser) incrementally:
 *  - waveforms are immutable, so each id is written once (samples, recipe or a reference to
 *    a record with the same samples), in small chunks at idle time so a big backlog (e.g.
 *    4096 waveforms after an import) never blocks the main thread for long;
 *  - the small meta record (timeline order, wavetables, voices, ...) is rewritten on every
 *    save, after the waveforms it references, in the same transaction that deletes records
 *    no longer referenced (evicted waveforms);
 *  - saves are debounced (`delay` after the last change, at most `maxWait` after the first)
 *    and flushed at once (no idle yielding) when the page is hidden.
 * No DOM here: the scheduler and backend are injected (tests use fakes).
 */
import { encodeMeta, encodeWaveform, RenderCache, type SessionMeta, type SessionState, type UiPrefs, type WaveformRecord } from '../core/session';
import type { TableId } from '../core/table';
import type { AppModel, Topic } from './model';

export interface SessionBackend {
  putWaveforms(records: readonly WaveformRecord[]): Promise<void>;
  /** Write the meta record and delete `remove` waveform records, atomically. */
  commit(meta: SessionMeta, remove: readonly TableId[]): Promise<void>;
  /** Delete everything (meta and waveforms). */
  clear(): Promise<void>;
}

export interface SaveScheduler {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
  /** Run `fn` when the main thread is idle (or soon). */
  idle(fn: () => void): void;
}

export type AutosaveStatus = 'saved' | 'pending' | 'saving' | 'error' | 'off';

export interface AutosaveOptions {
  delay?: number;
  maxWait?: number;
  /** Main-thread budget per chunk while not urgent (ms). */
  budgetMs?: number;
  /** Waveform records per backend write. */
  chunk?: number;
}

const TOPICS: Topic[] = ['timeline', 'wavetables', 'selection', 'voices', 'sequences', 'transport', 'parents'];

export class Autosaver {
  status: AutosaveStatus;
  lastSaved: number | null = null;
  lastError = '';
  /** Status / error listeners (UI). */
  onChange?: () => void;

  private stored = new Set<TableId>();
  /** Stored 'ref' records → the record holding their samples (kept while referenced). */
  private refs = new Map<TableId, TableId>();
  /** Samples array → the stored record holding it (for copies). */
  private owners = new WeakMap<Float32Array, TableId>();
  private cache = new RenderCache();
  private dirty = false;
  private firstDirty = 0;
  private timer: unknown = null;
  private running: Promise<void> | null = null;
  private urgent = false;
  private paused = false;
  private readonly delay: number;
  private readonly maxWait: number;
  private readonly budget: number;
  private readonly chunk: number;

  constructor(
    private model: AppModel,
    private uiPrefs: () => UiPrefs,
    private backend: SessionBackend | null,
    private sched: SaveScheduler,
    o: AutosaveOptions = {},
  ) {
    this.delay = o.delay ?? 1500;
    this.maxWait = o.maxWait ?? 6000;
    this.budget = o.budgetMs ?? 4;
    this.chunk = o.chunk ?? 64;
    this.status = backend ? 'saved' : 'off';
    if (backend) for (const t of TOPICS) model.on(t, () => this.markDirty());
  }

  get enabled(): boolean {
    return !!this.backend;
  }

  /** What the backend already holds (after a restore): ids, refs and the decoded tables' data. */
  init(records: Iterable<Pick<WaveformRecord, 'id' | 'enc' | 'ref'>>): void {
    const byId = new Map(this.model.timeline.map((t) => [t.id, t]));
    for (const r of records) {
      this.stored.add(r.id);
      if (r.enc === 'ref' && r.ref !== undefined) this.refs.set(r.id, r.ref);
      else {
        const t = byId.get(r.id);
        if (t && !this.owners.has(t.data)) this.owners.set(t.data, t.id);
      }
    }
  }

  /** Something changed: save after `delay` (at most `maxWait` after the first change). */
  markDirty(): void {
    if (!this.backend || this.paused) return;
    const now = this.sched.now();
    if (!this.dirty) this.firstDirty = now;
    this.dirty = true;
    if (this.status === 'saved') this.setStatus('pending');
    if (this.running) return; // re-scheduled when the running save ends
    if (this.timer !== null) this.sched.clearTimer(this.timer);
    const wait = Math.max(0, Math.min(this.delay, this.firstDirty + this.maxWait - now));
    this.timer = this.sched.setTimer(() => {
      this.timer = null;
      void this.save();
    }, wait);
  }

  /** Save now without yielding (page hidden / closing, tests). Resolves when written. */
  async flush(): Promise<void> {
    if (!this.backend) return;
    this.urgent = true;
    try {
      if (this.timer !== null) {
        this.sched.clearTimer(this.timer);
        this.timer = null;
      }
      if (this.running) await this.running;
      if (this.dirty) await this.save();
    } finally {
      this.urgent = false;
    }
  }

  /**
   * Replace the session (New session, Import): wait for any running save, clear the
   * backend, load the state, save everything.
   */
  async replace(state: SessionState, applyUi: (ui: UiPrefs) => void): Promise<void> {
    this.paused = true;
    if (this.timer !== null) this.sched.clearTimer(this.timer);
    this.timer = null;
    try {
      if (this.running) await this.running.catch(() => {});
      if (this.backend) {
        try {
          await this.backend.clear();
        } catch (e) {
          this.fail(e);
        }
      }
      this.stored.clear();
      this.refs.clear();
      this.owners = new WeakMap();
    } finally {
      this.paused = false;
    }
    this.model.loadState(state.model);
    applyUi(state.ui);
    this.markDirty();
    await this.flush();
  }

  private save(): Promise<void> {
    if (this.running) return this.running;
    if (this.timer !== null) {
      this.sched.clearTimer(this.timer);
      this.timer = null;
    }
    this.running = this.write().finally(() => {
      this.running = null;
      // After an error, retry on the next change (not in a loop).
      if (this.dirty && this.status !== 'error') this.markDirty();
    });
    return this.running;
  }

  private async write(): Promise<void> {
    const backend = this.backend!;
    this.dirty = false;
    this.setStatus('saving');
    try {
      const state = this.model.exportState();
      const meta = encodeMeta({ model: state, ui: this.uiPrefs() }, Date.now());
      // New waveforms, in chunks (yielding to the main thread unless urgent).
      const written = new Set<TableId>();
      let batch: WaveformRecord[] = [];
      let t0 = this.sched.now();
      const put = async () => {
        if (!batch.length) return;
        const b = batch;
        batch = [];
        await backend.putWaveforms(b);
        for (const r of b) {
          this.stored.add(r.id);
          if (r.enc === 'ref') this.refs.set(r.id, r.ref!);
        }
      };
      for (const t of state.timeline) {
        if (this.stored.has(t.id)) continue;
        const owner = this.owners.get(t.data);
        const ref = owner !== undefined && owner !== t.id && (this.stored.has(owner) || written.has(owner)) && !this.refs.has(owner) ? owner : null;
        const rec = encodeWaveform(t, { ref, allowRecipe: true, cache: this.cache });
        if (rec.enc !== 'ref') this.owners.set(t.data, t.id);
        batch.push(rec);
        written.add(t.id);
        if (batch.length >= this.chunk || (!this.urgent && this.sched.now() - t0 > this.budget)) {
          await put();
          if (!this.urgent) await new Promise<void>((r) => this.sched.idle(r));
          t0 = this.sched.now();
        }
      }
      await put();
      // Meta + garbage collection: keep the timeline's records and the samples they reference.
      const live = new Set(meta.timeline);
      for (const id of meta.timeline) {
        const r = this.refs.get(id);
        if (r !== undefined) live.add(r);
      }
      const remove = [...this.stored].filter((id) => !live.has(id));
      await backend.commit(meta, remove);
      for (const id of remove) {
        this.stored.delete(id);
        this.refs.delete(id);
      }
      this.lastSaved = Date.now();
      this.lastError = '';
      this.setStatus(this.dirty ? 'pending' : 'saved');
    } catch (e) {
      this.dirty = true;
      this.firstDirty = this.sched.now();
      this.fail(e);
    }
  }

  private fail(e: unknown): void {
    this.lastError = e instanceof Error ? e.message : String(e);
    console.warn('[autosave]', e);
    this.setStatus('error');
  }

  private setStatus(s: AutosaveStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.onChange?.();
  }
}
