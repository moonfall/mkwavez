/**
 * Main-thread application state + actions. Plain data in, plain data out; the UI and
 * the audio bridge subscribe to topics. Tables are immutable, so undo snapshots are
 * reference copies.
 */
import { MAX_PARENTS } from '../core/breed';
import { MAX_STEPS, TIMELINE_CAP, UNDO_DEPTH } from '../core/constants';
import { emptySteps, normalizeSteps, type SequenceData } from '../core/sequence';
import { copyRecipe, IdAllocator, makeTable, type GeneratedTable, type TableId, type WaveTable } from '../core/table';
import { appendWithEviction } from '../core/timeline';
import { clampVoiceWindow, DEFAULT_VOICE, followEdit, fullWindow, voiceWindow, type VoiceParams } from '../core/voice';
import {
  builtinWavetables,
  cellAt,
  composeMaps,
  pinnedIds,
  removeTables,
  TIMELINE_WAVETABLE_ID,
  writeTables,
  type Interp,
  type Wavetable,
  type WavetableId,
} from '../core/wavetable';
import { windowIds } from '../core/wavetablePlayback';

/**
 * 'wavetables' = wavetable contents or settings changed (always emitted with 'timeline'
 * on adds / undo, so the bridge sends tables, wavetables and voices in one batch);
 * 'undo' = undo depth changed (any snapshot or undo);
 * 'parents' = the Breed parent list changed (including tables dropping out of the timeline).
 */
export type Topic =
  | 'timeline'
  | 'wavetables'
  | 'selection'
  | 'voices'
  | 'sequences'
  | 'transport'
  | 'undo'
  | 'parents';

export const MAX_VOICES = 8;

type Windows = Pick<VoiceParams, 'wavetableId' | 'windowStart' | 'windowEnd' | 'windowStartY' | 'windowEndY'>;
const WINDOW_KEYS = ['windowStart', 'windowEnd', 'windowStartY', 'windowEndY'] as const;

interface Snapshot {
  timeline: readonly WaveTable[];
  /** Wavetable contents (built-ins update on every add, so undo of an add reverts them too). */
  wavetables: readonly Wavetable[];
  selectedId: TableId | null;
  windows: Map<number, Windows>;
  steps: Map<number, readonly number[]>;
}

export class AppModel {
  timeline: readonly WaveTable[] = [];
  /** Built-ins first (Timeline, Last batch, Batches, Grid), then user wavetables (phase 2). */
  wavetables: readonly Wavetable[] = builtinWavetables();
  voices: readonly VoiceParams[] = [];
  sequences: readonly SequenceData[] = [];
  selectedId: TableId | null = null;
  /** Breed parents in order (A first), at most MAX_PARENTS; always tables in the timeline. */
  breedParents: readonly TableId[] = [];
  playing = false;
  bpm = 132;
  /** Counts moveTable() calls that moved something (the Timeline strip reveals the moved waveform). */
  moves = 0;
  readonly cap: number;

  private byId = new Map<TableId, WaveTable>();
  private tableIds = new IdAllocator(1);
  private nextVoiceId = 1;
  private nextSeqId = 1;
  private undoStack: Snapshot[] = [];
  /** Coalesces a continuous gesture (e.g. a window-slider drag) into one undo step. */
  private gestureKey: string | null = null;
  /** Events emitted so far; a Timeline move coalesces only if nothing else happened since. */
  private emits = 0;
  private moveMark = -1;
  private listeners = new Map<Topic, Set<() => void>>();

  constructor(cap = TIMELINE_CAP) {
    this.cap = cap;
  }

  // ---- events ----

  on(topic: Topic, fn: () => void): () => void {
    let s = this.listeners.get(topic);
    if (!s) this.listeners.set(topic, (s = new Set()));
    s.add(fn);
    return () => s.delete(fn);
  }

  private emit(...topics: Topic[]): void {
    this.emits++;
    for (const t of new Set(topics)) for (const fn of this.listeners.get(t) ?? []) fn();
  }

  // ---- queries ----

  table(id: TableId | null): WaveTable | undefined {
    return id === null ? undefined : this.byId.get(id);
  }

  indexOf(id: TableId | null): number {
    if (id === null) return -1;
    return this.timeline.findIndex((t) => t.id === id);
  }

  wavetable(id: WavetableId): Wavetable | undefined {
    return this.wavetables.find((w) => w.id === id);
  }

  /** The table in a wavetable slot (x along the row, y = row). */
  tableAt(wtId: WavetableId, x: number, y = 0): WaveTable | undefined {
    const wt = this.wavetable(wtId);
    if (!wt) return undefined;
    const id = cellAt(wt, x, y);
    return id === null ? undefined : this.byId.get(id);
  }

  /** Tables inside a voice's window (slot order, each once). */
  windowTables(v: VoiceParams): WaveTable[] {
    const wt = this.wavetable(v.wavetableId);
    if (!wt) return [];
    return windowIds(wt, voiceWindow(v))
      .map((id) => this.byId.get(id))
      .filter((t): t is WaveTable => !!t);
  }

  /** Voices playing a wavetable. */
  voicesOn(wtId: WavetableId): VoiceParams[] {
    return this.voices.filter((v) => v.wavetableId === wtId);
  }

  voice(id: number): VoiceParams | undefined {
    return this.voices.find((v) => v.id === id);
  }

  voiceIndex(id: number): number {
    return this.voices.findIndex((v) => v.id === id);
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  // ---- tables ----

  /**
   * Append generated tables to the timeline, as one batch (a single add is a batch of
   * one): every live wavetable writes them at its write head (Timeline appends, Last batch
   * is replaced, Batches gets a new row, Grid fills on), then the timeline evicts its
   * oldest unpinned tables, which drop out of the wavetables that mirror it. Voice windows
   * follow (see followEdit). One undo step reverts all of it.
   */
  addTables(gen: readonly GeneratedTable[], selectNew = true): WaveTable[] {
    if (!gen.length) return [];
    this.snapshot();
    const added = gen.map((g) => makeTable(this.tableIds.take(), g));
    const ids = added.map((t) => t.id);
    const before = this.wavetables;
    const written = before.map((w) => writeTables(w, ids));
    // Pins after the writes: the new tables are referenced (Last batch), overwritten Grid cells are not.
    const pinned = pinnedIds(written.map((e) => e.wt));
    const r = appendWithEviction(this.timeline, added, this.cap, (id) => pinned.has(id));
    const gone = new Set(r.evicted.map((t) => t.id));
    let voices = this.voices;
    this.wavetables = written.map((e, i) => {
      const rem = gone.size ? removeTables(e.wt, gone) : null;
      const edit = rem ? { wt: rem.wt, map: composeMaps(e.map, rem.map), reset: e.reset } : e;
      voices = followEdit(voices, before[i], edit);
      return edit.wt;
    });
    this.voices = voices;
    const parentsChanged = this.setTimeline(r.list);
    if (selectNew) this.selectedId = added[added.length - 1].id;
    else if (this.selectedId !== null && !this.byId.has(this.selectedId)) this.selectedId = r.list[0]?.id ?? null;
    this.emit('timeline', 'wavetables', 'voices', 'selection', 'undo', ...(parentsChanged ? (['parents'] as Topic[]) : []));
    return added;
  }

  /**
   * Append a copy of table `id` to the end of the timeline, as a single add (window
   * following, undo, selects the copy). The data is shared (tables are immutable).
   */
  copyToEnd(id: TableId | null): WaveTable | null {
    const t = this.table(id);
    if (!t) return null;
    return this.addTables([{ data: t.data, recipe: copyRecipe(t.id, t.recipe) }])[0];
  }

  /**
   * Move waveform `id` one place earlier (`delta` -1) or later (+1) in the Timeline: it
   * swaps with its neighbour, and the Timeline built-in wavetable follows the new order.
   * Voice windows are index ranges, so they stay put and play whatever the new order puts
   * inside them (the engine crossfades by table id). Other wavetables reference ids and
   * are unaffected. The moved waveform is selected. Consecutive moves of the same
   * waveform (nothing else in between) are one undo step. No-op at the ends.
   */
  moveTable(id: TableId | null, delta: -1 | 1): boolean {
    const i = this.indexOf(id);
    const j = i + delta;
    if (id === null || i < 0 || j < 0 || j >= this.timeline.length) return false;
    const key = `move:${id}`;
    if (this.gestureKey !== key || this.moveMark !== this.emits) {
      this.snapshot();
      this.gestureKey = key;
    }
    const list = this.timeline.slice();
    const other = list[j];
    list[j] = list[i];
    list[i] = other;
    this.timeline = list;
    this.moves++;
    this.wavetables = this.wavetables.map((w) => (w.builtin === 'timeline' ? swapSlots(w, id, other.id) : w));
    const selChanged = this.selectedId !== id;
    this.selectedId = id;
    this.emit('timeline', 'wavetables', 'undo', ...(selChanged ? (['selection'] as Topic[]) : []));
    this.moveMark = this.emits;
    return true;
  }

  /** Replace the timeline; returns true if Breed parents had to be dropped (evicted / undone). */
  private setTimeline(list: readonly WaveTable[]): boolean {
    this.timeline = list;
    this.byId = new Map(list.map((t) => [t.id, t]));
    const kept = this.breedParents.filter((id) => this.byId.has(id));
    if (kept.length === this.breedParents.length) return false;
    this.breedParents = kept;
    return true;
  }

  select(id: TableId): void {
    if (!this.byId.has(id) || id === this.selectedId) return;
    this.selectedId = id;
    this.emit('selection');
  }

  // ---- breed parents ----

  /** Set the parent list (unknown ids and duplicates dropped, capped at MAX_PARENTS). */
  setBreedParents(ids: readonly TableId[]): void {
    const next = [...new Set(ids)].filter((id) => this.byId.has(id)).slice(0, MAX_PARENTS);
    if (next.length === this.breedParents.length && next.every((id, i) => id === this.breedParents[i])) return;
    this.breedParents = next;
    this.emit('parents');
  }

  /** Add or remove one parent. Returns false if it couldn't be added (unknown id or list full). */
  toggleBreedParent(id: TableId): boolean {
    if (this.breedParents.includes(id)) {
      this.setBreedParents(this.breedParents.filter((p) => p !== id));
      return true;
    }
    if (!this.byId.has(id) || this.breedParents.length >= MAX_PARENTS) return false;
    this.setBreedParents([...this.breedParents, id]);
    return true;
  }

  /** Move a parent by `delta` places (clamped). */
  moveBreedParent(id: TableId, delta: number): void {
    const list = [...this.breedParents];
    const i = list.indexOf(id);
    const j = Math.max(0, Math.min(list.length - 1, i + delta));
    if (i < 0 || i === j) return;
    list.splice(i, 1);
    list.splice(j, 0, id);
    this.setBreedParents(list);
  }

  // ---- voices ----

  /** Add a voice (on the Timeline unless `patch` says otherwise; window = whole wavetable). */
  addVoice(patch: Partial<VoiceParams> = {}): VoiceParams | null {
    if (this.voices.length >= MAX_VOICES) return null;
    const id = this.nextVoiceId++;
    const wt = this.wavetable(patch.wavetableId ?? TIMELINE_WAVETABLE_ID) ?? this.wavetables[0];
    let v: VoiceParams = {
      ...DEFAULT_VOICE,
      ...fullWindow(wt),
      ...patch,
      wavetableId: wt.id,
      id,
      name: patch.name ?? `V${id}`,
    };
    v = clampVoiceWindow(v, wt);
    this.voices = [...this.voices, v];
    this.emit('voices');
    return v;
  }

  /**
   * Update voice params. Window edits are undoable (undo restores windows, so they must
   * be snapshotted too); a drag is one step until endGesture() or another action.
   * Switching wavetable (without an explicit window) selects the whole new wavetable.
   */
  updateVoice(id: number, patch: Partial<VoiceParams>): void {
    const windowEdit = WINDOW_KEYS.some((k) => k in patch);
    if (windowEdit && this.gestureKey !== `window:${id}`) {
      this.snapshot();
      this.gestureKey = `window:${id}`;
    }
    let changed = false;
    this.voices = this.voices.map((v) => {
      if (v.id !== id) return v;
      let next: VoiceParams = { ...v, ...patch, id };
      const wt = this.wavetable(next.wavetableId);
      if (!wt) return v;
      if (next.wavetableId !== v.wavetableId && !windowEdit) next = { ...next, ...fullWindow(wt) };
      const ordered = (a: 'windowStart' | 'windowStartY', b: 'windowEnd' | 'windowEndY') => {
        // Keep start <= end by pushing the other handle, not the one being dragged.
        if (next[a] > next[b]) next = b in patch && !(a in patch) ? { ...next, [a]: next[b] } : { ...next, [b]: next[a] };
      };
      next = { ...next, windowStart: Math.round(next.windowStart), windowEnd: Math.round(next.windowEnd), windowStartY: Math.round(next.windowStartY), windowEndY: Math.round(next.windowEndY) };
      next = clampOnly(next, wt);
      ordered('windowStart', 'windowEnd');
      ordered('windowStartY', 'windowEndY');
      changed = true;
      return next;
    });
    if (changed) this.emit('voices', ...(windowEdit ? (['undo'] as Topic[]) : []));
  }

  /** End a coalesced gesture (slider released). */
  endGesture(): void {
    this.gestureKey = null;
  }

  removeVoice(id: number): void {
    if (!this.voice(id)) return;
    this.voices = this.voices.filter((v) => v.id !== id);
    this.sequences = this.sequences.filter((s) => s.voiceId !== id);
    this.emit('voices', 'sequences');
  }

  // ---- wavetables ----

  /**
   * Interpolation of a wavetable (Blend / Step). Allowed on built-ins too: it is a
   * playback setting, not content (phase 1 has no user wavetables to choose Step on).
   */
  setWavetableInterp(id: WavetableId, interp: Interp): void {
    const wt = this.wavetable(id);
    if (!wt || wt.interp === interp) return;
    this.wavetables = this.wavetables.map((w) => (w.id === id ? { ...w, interp } : w));
    this.emit('wavetables');
  }

  // ---- sequences ----

  addSequence(voiceId: number | null, steps: readonly number[] = [], length = 16): SequenceData {
    const s: SequenceData = {
      id: this.nextSeqId++,
      voiceId,
      length: Math.max(1, Math.min(MAX_STEPS, length)),
      steps: normalizeSteps(steps.length ? steps : emptySteps()),
      gate: 0.5,
    };
    this.sequences = [...this.sequences, s];
    this.emit('sequences');
    return s;
  }

  updateSequence(id: number, patch: Partial<SequenceData>, undoable = false): void {
    if (undoable) this.snapshot();
    this.sequences = this.sequences.map((s) =>
      s.id === id
        ? {
            ...s,
            ...patch,
            id,
            steps: patch.steps ? normalizeSteps(patch.steps) : s.steps,
            length: Math.max(1, Math.min(MAX_STEPS, Math.round(patch.length ?? s.length))),
          }
        : s,
    );
    this.emit('sequences', ...(undoable ? (['undo'] as Topic[]) : []));
  }

  removeSequence(id: number): void {
    this.sequences = this.sequences.filter((s) => s.id !== id);
    this.emit('sequences');
  }

  // ---- transport ----

  setTransport(patch: { playing?: boolean; bpm?: number }): void {
    if (patch.playing !== undefined) this.playing = patch.playing;
    if (patch.bpm !== undefined) this.bpm = Math.max(40, Math.min(300, patch.bpm));
    this.emit('transport');
  }

  // ---- undo ----

  private snapshot(): void {
    this.gestureKey = null;
    this.undoStack.push({
      timeline: this.timeline,
      selectedId: this.selectedId,
      wavetables: this.wavetables,
      windows: new Map(this.voices.map((v) => [v.id, windowsOf(v)])),
      steps: new Map(this.sequences.map((s) => [s.id, s.steps])),
    });
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
  }

  undo(): void {
    this.gestureKey = null;
    const s = this.undoStack.pop();
    if (!s) return;
    const parentsChanged = this.setTimeline(s.timeline);
    this.selectedId = s.selectedId !== null && this.byId.has(s.selectedId) ? s.selectedId : (s.timeline.at(-1)?.id ?? null);
    // Contents come back; settings changed since (interpolation) are kept.
    const now = new Map(this.wavetables.map((w) => [w.id, w]));
    this.wavetables = s.wavetables.map((w) => {
      const cur = now.get(w.id);
      return cur && cur.interp !== w.interp ? { ...w, interp: cur.interp } : w;
    });
    this.voices = this.voices.map((v) => {
      const w = s.windows.get(v.id);
      // A voice that has switched wavetable since keeps its window.
      const next = w && w.wavetableId === v.wavetableId ? { ...v, ...w } : v;
      const wt = this.wavetable(next.wavetableId);
      return wt ? clampVoiceWindow(next, wt) : next;
    });
    this.sequences = this.sequences.map((q) => {
      const st = s.steps.get(q.id);
      return st ? { ...q, steps: st } : q;
    });
    this.emit('timeline', 'wavetables', 'voices', 'sequences', 'selection', 'undo', ...(parentsChanged ? (['parents'] as Topic[]) : []));
  }

  clearUndo(): void {
    this.undoStack = [];
    this.emit('undo');
  }
}

function windowsOf(v: VoiceParams): Windows {
  return { wavetableId: v.wavetableId, windowStart: v.windowStart, windowEnd: v.windowEnd, windowStartY: v.windowStartY, windowEndY: v.windowEndY };
}

/** Swap two ids' slots in a 1D wavetable (unchanged if either is missing). */
function swapSlots(wt: Wavetable, a: TableId, b: TableId): Wavetable {
  const row = wt.rows[0] ?? [];
  const ia = row.indexOf(a);
  const ib = row.indexOf(b);
  if (ia < 0 || ib < 0) return wt;
  const next = row.slice();
  next[ia] = b;
  next[ib] = a;
  return { ...wt, rows: [next, ...wt.rows.slice(1)] };
}

/** Clamp each window handle into the wavetable (ordering is done by the caller). */
function clampOnly(v: VoiceParams, wt: Wavetable): VoiceParams {
  const xLen = wt.shape === 'rows' ? 1 : Math.max(1, wt.rows[0]?.length ?? 0);
  const yLen = wt.shape === '1d' ? 1 : Math.max(1, wt.rows.length);
  const c = (x: number, len: number) => Math.max(0, Math.min(len - 1, x));
  return {
    ...v,
    windowStart: c(v.windowStart, xLen),
    windowEnd: c(v.windowEnd, xLen),
    windowStartY: c(v.windowStartY, yLen),
    windowEndY: c(v.windowEndY, yLen),
  };
}
