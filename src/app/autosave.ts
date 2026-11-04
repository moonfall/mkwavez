/**
 * Autosave: watches the model (and UI prefs) and writes the session to a backend
 * (IndexedDB in the browser) incrementally:
 *  - waveforms are immutable, so each id is written once (samples, recipe or a reference to
 *    a record with the same samples), in small chunks at idle time so a big backlog (e.g.
 *    4096 waveforms after an import) never blocks the main thread for long;
 *  - the small meta record (timeline order, wavetables, voices, ...) is rewritten on every
 *    save, after the waveforms it references, in the same transaction that deletes records
 *    no longer referenced (evicted waveforms);
 *  - saves are debounced (`delay` after the last change, at most `maxWait` after the first);
 *    `flushNow()` (page hidden / closing) writes meta and every unwritten waveform in one
 *    transaction issued synchronously, superseding a chunked save in progress;
 *  - only records reachable from the restored meta count as saved; anything else in the
 *    store (left by a save that never committed its meta) is deleted, and new ids are
 *    allocated above every stored id, so a stale record can never stand in for a new one;
 *  - one tab owns the store at a time (`setActive`, driven by a tab lock in the browser):
 *    a paused tab doesn't write; taking over (`adopt`) rewrites everything.
 * No DOM here: the scheduler and backend are injected (tests use fakes).
 */
import { encodeMeta, encodeWaveform, RenderCache, type SessionMeta, type SessionState, type UiPrefs, type WaveformRecord } from '../core/session';
import type { TableId, WaveTable } from '../core/table';
import type { AppModel, Topic } from './model';

export interface SessionBackend {
  putWaveforms(records: readonly WaveformRecord[]): Promise<void>;
  /**
   * One transaction: put `records`, write the meta record, delete `remove`. Implementations
   * must create the transaction synchronously (before their first await), so a commit
   * issued while the page unloads is already queued.
   */
  commit(meta: SessionMeta, remove: readonly TableId[], records?: readonly WaveformRecord[]): Promise<void>;
  /** Delete waveform records. */
  remove(ids: readonly TableId[]): Promise<void>;
  /** Delete the session (meta and waveforms). */
  clear(): Promise<void>;
}

export interface SaveScheduler {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
  /** Run `fn` when the main thread is idle (or soon). */
  idle(fn: () => void): void;
}

/** 'paused' = another tab owns autosave; 'off' = no storage. */
export type AutosaveStatus = 'saved' | 'pending' | 'saving' | 'error' | 'off' | 'paused';

export interface AutosaveOptions {
  delay?: number;
  maxWait?: number;
  /** Main-thread budget per chunk while not urgent (ms). */
  budgetMs?: number;
  /** Waveform records per backend write. */
  chunk?: number;
}

const TOPICS: Topic[] = ['timeline', 'wavetables', 'selection', 'voices', 'sequences', 'transport', 'parents', 'presets', 'shape'];

export function isQuotaError(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === 'QuotaExceededError' || (e instanceof Error && /quota/i.test(e.message));
}

export class Autosaver {
  status: AutosaveStatus;
  lastSaved: number | null = null;
  lastError = '';
  /** The last error was the browser's storage quota. */
  quotaFull = false;
  /** Status / error listeners (UI). */
  onChange?: () => void;

  private stored = new Set<TableId>();
  /** Stored 'ref' records → the record holding their samples (kept while referenced). */
  private refs = new Map<TableId, TableId>();
  /** Samples array → the stored record holding it (for copies). */
  private owners = new WeakMap<Float32Array, TableId>();
  /** Records in the store that nothing current references (deleted with the next commit). */
  private garbage = new Set<TableId>();
  private cache = new RenderCache();
  private dirty = false;
  private firstDirty = 0;
  private timer: unknown = null;
  private running: Promise<void> | null = null;
  private urgent = false;
  private suspended = false;
  private active = true;
  /** The next save writes everything in one transaction (after `adopt`). */
  private atomicNext = false;
  /** Bumped by every save; a save whose number is stale doesn't commit (superseded). */
  private seq = 0;
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

  get isActive(): boolean {
    return this.active;
  }

  /**
   * After a restore: `records` = everything in the store. Only records the restored
   * timeline reaches (its waveforms and the samples their refs use) count as saved; the
   * rest are orphans (from a save whose meta never landed) and are deleted. New waveform
   * ids are allocated above every stored id. A tab that doesn't own autosave
   * (`setActive(false)` first) deletes nothing: the owner may be mid-save, and those
   * records are only "orphans" until its meta lands.
   */
  init(records: Iterable<Pick<WaveformRecord, 'id' | 'enc' | 'ref'>>): void {
    const all = new Map<TableId, Pick<WaveformRecord, 'id' | 'enc' | 'ref'>>();
    for (const r of records) all.set(r.id, r);
    if (!this.active) {
      this.reserveAbove(all.keys());
      return;
    }
    for (const t of this.model.timeline) {
      const r = all.get(t.id);
      if (!r) continue;
      this.stored.add(t.id);
      if (r.enc === 'ref') {
        if (r.ref !== undefined && all.has(r.ref)) {
          this.refs.set(t.id, r.ref);
          this.stored.add(r.ref);
        }
      } else if (!this.owners.has(t.data)) this.owners.set(t.data, t.id);
    }
    this.reserveAbove(all.keys());
    const orphans = [...all.keys()].filter((id) => !this.stored.has(id));
    if (orphans.length && this.backend) {
      // Unreachable from any meta: safe to delete now (else with the next commit).
      this.backend.remove(orphans).catch(() => {
        for (const id of orphans) this.garbage.add(id);
      });
    }
  }

  /**
   * Take over a store another tab wrote: nothing in it counts as saved (its ids may hold
   * other waveforms); the next save rewrites every waveform and deletes the rest, all in
   * one transaction, so an interruption never pairs the old meta with overwritten records.
   */
  adopt(storedIds: Iterable<TableId>): void {
    this.seq++;
    this.atomicNext = true;
    this.stored.clear();
    this.refs.clear();
    this.owners = new WeakMap();
    this.garbage = new Set(storedIds);
    this.reserveAbove(this.garbage);
  }

  /** Whether this tab owns autosave (another tab may take it over). */
  setActive(active: boolean): void {
    if (!this.backend || active === this.active) return;
    this.active = active;
    if (!active) {
      this.seq++; // a save in progress must not commit any more
      if (this.timer !== null) this.sched.clearTimer(this.timer);
      this.timer = null;
      this.setStatus('paused');
    } else {
      this.setStatus('pending');
      this.dirty = false;
      this.markDirty();
    }
  }

  /** Something changed: save after `delay` (at most `maxWait` after the first change). */
  markDirty(): void {
    if (!this.backend || this.suspended) return;
    const now = this.sched.now();
    if (!this.dirty) this.firstDirty = now;
    this.dirty = true;
    if (!this.active) return;
    if (this.status === 'saved') this.setStatus('pending');
    if (this.running) return; // re-scheduled when the running save ends
    if (this.timer !== null) this.sched.clearTimer(this.timer);
    const wait = Math.max(0, Math.min(this.delay, this.firstDirty + this.maxWait - now));
    this.timer = this.sched.setTimer(() => {
      this.timer = null;
      void this.save();
    }, wait);
  }

  /** Save now without yielding (tests, replace). Resolves when written. */
  async flush(): Promise<void> {
    if (!this.backend || !this.active) return;
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
   * Page hidden / closing: issue one transaction now (meta + every unwritten waveform +
   * deletions), synchronously, so it is queued before the page goes away. A chunked save
   * in progress is superseded (it won't commit its older meta).
   */
  flushNow(): Promise<void> | null {
    if (!this.backend || !this.active || this.suspended || (!this.dirty && !this.running)) return null;
    if (this.timer !== null) this.sched.clearTimer(this.timer);
    this.timer = null;
    this.seq++;
    this.dirty = false;
    let records: WaveformRecord[];
    let meta: SessionMeta;
    let remove: TableId[];
    try {
      const state = this.model.exportState();
      meta = encodeMeta({ model: state, ui: this.uiPrefs() }, Date.now());
      records = [];
      const written = new Set<TableId>();
      for (const t of state.timeline) {
        if (this.stored.has(t.id)) continue;
        records.push(this.encode(t, written));
        written.add(t.id);
      }
      remove = this.removable(this.live(state.timeline, records));
    } catch (e) {
      this.dirty = true;
      this.fail(e);
      return null;
    }
    const p = this.backend.commit(meta, remove, records);
    this.noteWritten(records);
    this.noteRemoved(remove);
    this.setStatus('saving');
    return p.then(
      () => {
        this.lastSaved = Date.now();
        this.ok();
      },
      (e) => {
        for (const r of records) this.stored.delete(r.id);
        for (const id of remove) this.garbage.add(id);
        this.dirty = true;
        this.fail(e);
      },
    );
  }

  /**
   * Replace the session (New session, Import): wait for any running save, clear the
   * backend, load the state, save everything. A paused tab (another tab owns autosave)
   * only replaces its own state.
   */
  async replace(state: SessionState, applyUi: (ui: UiPrefs) => void): Promise<void> {
    this.suspended = true;
    if (this.timer !== null) this.sched.clearTimer(this.timer);
    this.timer = null;
    try {
      if (this.running) await this.running.catch(() => {});
      if (this.backend && this.active) {
        this.seq++;
        try {
          await this.backend.clear();
          this.garbage.clear();
        } catch (e) {
          // Couldn't clear: whatever is there is unreachable from the new session.
          for (const id of this.stored) this.garbage.add(id);
          this.fail(e);
        }
      }
      this.stored.clear();
      this.refs.clear();
      this.owners = new WeakMap();
    } finally {
      this.suspended = false;
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
      if (this.dirty && this.active && this.status !== 'error') this.markDirty();
    });
    return this.running;
  }

  private async write(): Promise<void> {
    const backend = this.backend!;
    const mySeq = ++this.seq;
    const superseded = () => mySeq !== this.seq || !this.active;
    this.dirty = false;
    this.setStatus('saving');
    try {
      const state = this.model.exportState();
      const meta = encodeMeta({ model: state, ui: this.uiPrefs() }, Date.now());
      const live = this.live(state.timeline, []);
      const written = new Set<TableId>();
      if (this.atomicNext) {
        // Takeover: every waveform, the meta and the deletions in one transaction.
        const records: WaveformRecord[] = [];
        for (const t of state.timeline) {
          if (this.stored.has(t.id)) continue;
          const rec = this.encode(t, written);
          records.push(rec);
          written.add(t.id);
        }
        const all = this.live(state.timeline, records);
        const remove = this.removable(all);
        await backend.commit(meta, remove, records);
        if (superseded()) return;
        this.atomicNext = false;
        this.noteWritten(records);
        this.noteRemoved(remove);
        this.lastSaved = Date.now();
        this.ok();
        return;
      }
      // New waveforms, in chunks (yielding to the main thread unless urgent).
      let batch: WaveformRecord[] = [];
      let collected = false;
      let t0 = this.sched.now();
      const put = async () => {
        if (!batch.length) return;
        const b = batch;
        batch = [];
        try {
          await backend.putWaveforms(b);
        } catch (e) {
          // Storage full: free what the current state doesn't need, then try once more. The
          // deletions go with the current meta (one transaction), so no saved meta is
          // left pointing at a deleted record; until the rest is written, that meta lacks
          // some new waveforms, which a restore drops (with a warning).
          if (!isQuotaError(e) || collected) throw e;
          collected = true;
          const ids = this.removable(new Set([...live, ...b.map((r) => r.id)]));
          if (!ids.length || superseded()) throw e;
          await backend.commit(meta, ids);
          this.noteRemoved(ids);
          await backend.putWaveforms(b);
        }
        this.noteWritten(b);
      };
      for (const t of state.timeline) {
        if (superseded()) return;
        if (this.stored.has(t.id)) continue;
        const rec = this.encode(t, written);
        if (rec.enc === 'ref') live.add(rec.ref!);
        batch.push(rec);
        written.add(t.id);
        if (batch.length >= this.chunk || (!this.urgent && this.sched.now() - t0 > this.budget)) {
          await put();
          if (!this.urgent) await new Promise<void>((r) => this.sched.idle(r));
          t0 = this.sched.now();
        }
      }
      await put();
      if (superseded()) return;
      // Meta + garbage collection: keep the timeline's records and the samples they reference.
      const remove = this.removable(live);
      await backend.commit(meta, remove);
      this.noteRemoved(remove);
      this.lastSaved = Date.now();
      this.ok();
    } catch (e) {
      this.dirty = true;
      this.firstDirty = this.sched.now();
      this.fail(e);
    }
  }

  /** Encode one unsaved waveform; a copy references the record holding its samples. */
  private encode(t: WaveTable, written: ReadonlySet<TableId>): WaveformRecord {
    const owner = this.owners.get(t.data);
    const ref = owner !== undefined && owner !== t.id && (this.stored.has(owner) || written.has(owner)) && !this.refs.has(owner) ? owner : null;
    const rec = encodeWaveform(t, { ref, allowRecipe: true, cache: this.cache });
    if (rec.enc !== 'ref') this.owners.set(t.data, t.id);
    return rec;
  }

  /** Ids the current state needs: the timeline's and the records their refs / data point at. */
  private live(timeline: readonly WaveTable[], records: readonly WaveformRecord[]): Set<TableId> {
    const live = new Set<TableId>();
    for (const t of timeline) {
      live.add(t.id);
      const r = this.refs.get(t.id);
      if (r !== undefined) live.add(r);
      const o = this.owners.get(t.data);
      if (o !== undefined) live.add(o);
    }
    for (const r of records) if (r.enc === 'ref') live.add(r.ref!);
    return live;
  }

  private removable(live: ReadonlySet<TableId>): TableId[] {
    const out = new Set<TableId>();
    for (const id of this.stored) if (!live.has(id)) out.add(id);
    for (const id of this.garbage) if (!live.has(id)) out.add(id);
    return [...out];
  }

  private noteWritten(records: readonly WaveformRecord[]): void {
    for (const r of records) {
      this.stored.add(r.id);
      this.garbage.delete(r.id);
      if (r.enc === 'ref') this.refs.set(r.id, r.ref!);
      else this.refs.delete(r.id);
    }
  }

  private noteRemoved(ids: readonly TableId[]): void {
    for (const id of ids) {
      this.stored.delete(id);
      this.refs.delete(id);
      this.garbage.delete(id);
    }
  }

  private reserveAbove(ids: Iterable<TableId>): void {
    let max = 0;
    for (const id of ids) if (id > max) max = id;
    this.model.reserveTableIds(max + 1);
  }

  private ok(): void {
    this.lastError = '';
    this.quotaFull = false;
    this.setStatus(!this.active ? 'paused' : this.dirty ? 'pending' : 'saved');
  }

  private fail(e: unknown): void {
    this.lastError = e instanceof Error ? e.message : String(e);
    this.quotaFull = isQuotaError(e);
    console.warn('[autosave]', e);
    this.setStatus('error');
  }

  private setStatus(s: AutosaveStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.onChange?.();
  }
}
