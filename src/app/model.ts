/**
 * Main-thread application state + actions. Plain data in, plain data out; the UI and
 * the audio bridge subscribe to topics. Tables are immutable, so undo snapshots are
 * reference copies.
 */
import { MAX_PARENTS } from '../core/breed';
import { MAX_STEPS, TIMELINE_CAP, UNDO_DEPTH } from '../core/constants';
import type { ModelState } from '../core/session';
import { DEFAULT_STEP_LENGTH, emptySteps, isStepLength, normalizeSteps, type SequenceData } from '../core/sequence';
import { copyRecipe, IdAllocator, makeTable, type GeneratedTable, type TableId, type WaveTable } from '../core/table';
import { appendWithEviction } from '../core/timeline';
import { PREVIEW_BATCH_WAVETABLE_ID, PREVIEW_ID_BASE } from '../core/wavetable';
import { chainJson, MAX_CHAIN_NAME, normalizeChain, type ShapeChain } from '../core/shapeChain';
import { DEFAULT_CHAIN, MAX_SAVED_CHAINS, uniqueName, type SavedChain } from '../core/shapeFactory';
import { MAX_USER_PRESETS, presetPatch, resolvePresetWavetable, soundOf as presetSoundOf, type PresetSound, type VoicePreset } from '../core/presets';

import { DEFAULT_SYNTH, SYNTH_AMP_DEFAULTS, type VoiceType } from '../core/synth';

import {
  applyVoicePatch,
  clampOscB,
  clampVoiceWindow,
  DEFAULT_VOICE,
  followEdit,
  fullWindow,
  oscASource,
  rehomeVoice,
  voiceWindow,
  type VoicePatch,
  type VoiceParams,
} from '../core/voice';
import {
  builtinWavetables,
  cellAt,
  clearSlot,
  composeMaps,
  duplicateWavetable,
  FIRST_USER_WAVETABLE_ID,
  LAST_BATCH_WAVETABLE_ID,
  moveSlot,
  newWavetable,
  normalizeWrite,
  pinnedIds,
  placeTable,
  removeSlot,
  removeTables,
  resize1D,
  resize2D,
  setHead,
  setWrite,
  TIMELINE_WAVETABLE_ID,
  writeTables,
  type Cell,
  type Interp,
  type SlotTarget,
  type Wavetable,
  type WavetableEdit,
  type WavetableId,
  type WavetableShape,
  type WriteSettings,
} from '../core/wavetable';
import { windowIds } from '../core/wavetablePlayback';

/**
 * 'wavetables' = wavetable contents or settings changed (always emitted with 'timeline'
 * on adds / undo, so the bridge sends tables, wavetables and voices in one batch);
 * 'undo' = undo depth changed (any snapshot or undo);
 * 'parents' = the Breed parent list changed (including tables dropping out of the timeline);
 * 'notice' = a non-blocking message for the user (`notice`), e.g. an add refused because
 * the Timeline is full of waveforms that wavetables use;
 * 'shape' = the Shape tab's chain changed (an edit, undo, load);
 * 'preview' = the preview tables (Generate's unadded waveforms) and the Preview wavetable
 * changed (not saved, not undoable; frequent while editing).
 */
export type Topic =
  | 'timeline'
  | 'wavetables'
  | 'selection'
  | 'voices'
  | 'sequences'
  | 'transport'
  | 'undo'
  | 'parents'
  | 'notice'
  | 'presets'
  | 'shape'
  | 'preview';

export const MAX_VOICES = 8;

type Windows = Pick<VoiceParams, 'wavetableId' | 'windowStart' | 'windowEnd' | 'windowStartY' | 'windowEndY'>;
const WINDOW_KEYS = ['windowStart', 'windowEnd', 'windowStartY', 'windowEndY'] as const;
/**
 * Voice fields the Synth voice panel edits: on a Synth voice an edit of any of them is an
 * undo step (a slider drag is one), and undo restores them. A type switch is an undo step
 * on any voice. (Simple voices' slider moves stay non-undoable, as before.)
 */
const SYNTH_UNDO_KEYS = ['type', 'synth', 'attack', 'decay', 'sustain', 'release', 'level', 'octave', 'position', 'positionY'] as const;
type SynthSound = Pick<VoiceParams, (typeof SYNTH_UNDO_KEYS)[number]>;

interface Snapshot {
  timeline: readonly WaveTable[];
  /** Wavetable contents (built-ins update on every add, so undo of an add reverts them too). */
  wavetables: readonly Wavetable[];
  selectedId: TableId | null;
  windows: Map<number, Windows>;
  /** Osc B's wavetable and windows per voice (adds / wavetable edits move them, like osc A's). */
  bWindows: Map<number, Windows>;
  /**
   * The sound of the one voice the undone action edits (a synth edit, type switch, preset,
   * paste): its type, synth block and, on a Synth voice, the shared params the Synth panel
   * edits. Other voices' sounds are never touched by undo (so live, non-undoable changes such
   * as MIDI controller moves survive undoing something else).
   */
  sound: { id: number; sound: SynthSound } | null;
  steps: Map<number, readonly number[]>;
  shapeChain: ShapeChain;
}

export class AppModel {
  timeline: readonly WaveTable[] = [];
  /** Built-ins first (Timeline, Last batch, Batches, Grid), then user wavetables (ids from 16). */
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
  /** Next user wavetable id: monotonic, never reused (plain data; persist it with the wavetables). */
  nextWavetableId: WavetableId = FIRST_USER_WAVETABLE_ID;
  /** The last notice (see the 'notice' topic). */
  notice = '';
  /** User voice presets (saved with the session; topic 'presets'). Factory presets live in core/presets.ts. */
  voicePresets: readonly VoicePreset[] = [];
  /** The Shape tab's chain (normalised; edits are undo steps, a drag or stroke is one; topic 'shape'). */
  shapeChain: ShapeChain = DEFAULT_CHAIN;
  /** The user's saved Shape chains (session state, not undoable; topic 'shape'). */
  shapeChains: readonly SavedChain[] = [];
  readonly cap: number;
  private room: { tl: unknown; wts: unknown; n: number; ok: boolean } | null = null;

  private byId = new Map<TableId, WaveTable>();
  /** Generate's unadded waveforms (ids from PREVIEW_ID_BASE; never saved or undone) and the shown one. */
  previewTables: readonly WaveTable[] = [];
  previewShownId: TableId | null = null;
  private previewById = new Map<TableId, WaveTable>();
  private nextPreviewId = PREVIEW_ID_BASE;
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
    // Derived built-ins (Selection) follow the state the topics announce.
    if ((topics.includes('selection') || topics.includes('timeline')) && this.syncDerived() && !topics.includes('wavetables')) topics.push('wavetables');
    this.emits++;
    for (const t of new Set(topics)) for (const fn of this.listeners.get(t) ?? []) fn();
  }

  /**
   * Keep the derived built-ins on the state they follow (Selection: the selection; Preview:
   * the shown preview table); true if one changed. Undo and loads restore stale copies, which
   * this corrects on their emit.
   */
  private syncDerived(): boolean {
    let changed = false;
    const one = (id: TableId | null) => (w: Wavetable): Wavetable => {
      if (w.rows.length === 1 && w.rows[0].length === 1 && w.rows[0][0] === id) return w;
      changed = true;
      return { ...w, rows: [[id]] };
    };
    const sel = this.selectedId !== null && this.byId.has(this.selectedId) ? this.selectedId : null;
    const shown = this.previewShownId !== null && this.previewById.has(this.previewShownId) ? this.previewShownId : null;
    const batch = this.previewTables.map((t) => t.id);
    const all = (w: Wavetable): Wavetable => {
      const row = w.rows[0] ?? [];
      if (w.rows.length === 1 && row.length === batch.length && row.every((id, i) => id === batch[i])) return w;
      changed = true;
      return { ...w, rows: [batch], head: { x: batch.length, y: 0 } };
    };
    this.wavetables = this.wavetables.map((w) =>
      w.builtin === 'selection' ? one(sel)(w) : w.builtin === 'preview' ? one(shown)(w) : w.builtin === 'previewBatch' ? all(w) : w,
    );
    return changed;
  }

  /**
   * Generate's current preview: the batch it would add (data per waveform) and the shown one.
   * Unchanged data keeps its preview table (and id), so the engine only receives new ones.
   * Not undoable, not saved; emits 'preview'.
   */
  setPreview(batch: readonly Float32Array[], shown: number): void {
    const old = new Map(this.previewTables.map((t) => [t.data, t]));
    const tables = batch.map((data) => old.get(data) ?? makeTable(this.nextPreviewId++, { data, recipe: { op: 'preview', params: {}, seed: 0, parents: [] } }));
    const shownId = tables[Math.max(0, Math.min(tables.length - 1, shown))]?.id ?? null;
    if (shownId === this.previewShownId && tables.length === this.previewTables.length && tables.every((t, i) => t === this.previewTables[i])) return;
    this.previewTables = tables;
    this.previewById = new Map(tables.map((t) => [t.id, t]));
    this.previewShownId = shownId;
    const before = this.wavetable(PREVIEW_BATCH_WAVETABLE_ID);
    this.syncDerived();
    const voicesMoved = this.followPreviewBatch(before);
    this.emits++;
    for (const fn of this.listeners.get('preview') ?? []) fn();
    if (voicesMoved) this.emit('voices');
  }

  /**
   * Voices (osc A or B) on Preview batch after its size changed: a window that covered the
   * whole batch covers the whole new one; others are clamped. True if a window moved.
   */
  private followPreviewBatch(before: Wavetable | undefined): boolean {
    const after = this.wavetable(PREVIEW_BATCH_WAVETABLE_ID);
    if (!before || !after || before === after) return false;
    const oldLen = before.rows[0]?.length ?? 0;
    const full = fullWindow(after);
    const id = PREVIEW_BATCH_WAVETABLE_ID;
    let moved = false;
    this.voices = this.voices.map((v) => {
      let n = v;
      if (n.wavetableId === id) n = n.windowStart === 0 && n.windowEnd >= oldLen - 1 ? { ...n, ...full } : clampVoiceWindow(n, after);
      const b = n.synth.b;
      if (b.wavetableId === id)
        n = b.windowStart === 0 && b.windowEnd >= oldLen - 1 ? { ...n, synth: { ...n.synth, b: { ...b, windowStart: full.windowStart, windowEnd: full.windowEnd } } } : clampOscB(n, after);
      const same = n.windowStart === v.windowStart && n.windowEnd === v.windowEnd && n.synth.b.windowStart === v.synth.b.windowStart && n.synth.b.windowEnd === v.synth.b.windowEnd;
      if (same) return v;
      moved = true;
      return n;
    });
    return moved;
  }

  // ---- queries ----

  /** A timeline table, or a preview table (Generate's unadded waveforms). */
  table(id: TableId | null): WaveTable | undefined {
    return id === null ? undefined : (this.byId.get(id) ?? this.previewById.get(id));
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
    return this.table(id);
  }

  /** Tables inside a voice's window (slot order, each once). */
  windowTables(v: VoiceParams): WaveTable[] {
    const wt = this.wavetable(v.wavetableId);
    if (!wt) return [];
    return windowIds(wt, voiceWindow(v))
      .map((id) => this.table(id))
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
    if (!this.roomFor(gen.length)) {
      this.setNotice(this.fullMessage());
      return [];
    }
    this.snapshot();
    const added = gen.map((g) => makeTable(this.tableIds.take(), g));
    const before = this.wavetables;
    const { written, r } = this.planAdd(added);
    const gone = new Set(r.evicted.map((t) => t.id));
    let voices = this.voices;
    this.wavetables = written.map((e, i) => {
      const rem = gone.size ? removeTables(e.wt, gone) : null;
      const edit = rem ? { wt: rem.wt, map: composeMaps(e.map, rem.map), reset: e.reset } : e;
      voices = followEdit(voices, before[i], edit);
      return edit.wt;
    });
    this.voices = voices;
    const parentsChanged = this.setTimeline(r.list as WaveTable[]);
    if (selectNew) this.selectedId = added[added.length - 1].id;
    else if (this.selectedId !== null && !this.byId.has(this.selectedId)) this.selectedId = r.list[0]?.id ?? null;
    this.emit('timeline', 'wavetables', 'voices', 'selection', 'undo', ...(parentsChanged ? (['parents'] as Topic[]) : []));
    return added;
  }

  /**
   * An add of `added` (one batch): the live wavetables' writes, then oldest-first eviction
   * of unpinned waveforms (pins after the writes: the new ones are referenced, e.g. by Last
   * batch; overwritten Grid cells are not). `ok` = it fits the cap without evicting any of
   * the new waveforms themselves.
   */
  private planAdd<T extends { readonly id: TableId }>(added: readonly T[]) {
    const ids = added.map((t) => t.id);
    const written = this.wavetables.map((w) => writeTables(w, ids));
    const pinned = pinnedIds(written.map((e) => e.wt));
    const r = appendWithEviction<{ readonly id: TableId }>(this.timeline, added, this.cap, (id) => pinned.has(id));
    const fresh = new Set(ids);
    const ok = r.list.length <= this.cap && !r.evicted.some((t) => fresh.has(t.id));
    return { written, r: r as unknown as { list: (WaveTable | T)[]; evicted: (WaveTable | T)[] }, ok };
  }

  /**
   * Whether `n` new waveforms (one batch) fit: the Timeline never holds more than `cap`;
   * adds evict the oldest waveforms no wavetable uses, and are refused when there are too
   * few of those. Cached per state.
   */
  roomFor(n: number): boolean {
    if (n <= 0) return true;
    const c = this.room;
    if (c && c.tl === this.timeline && c.wts === this.wavetables && c.n === n) return c.ok;
    const ok = this.timeline.length + n <= this.cap || this.planAdd(Array.from({ length: n }, (_, i) => ({ id: -1 - i }))).ok;
    this.room = { tl: this.timeline, wts: this.wavetables, n, ok };
    return ok;
  }

  /** Why an add is refused: which wavetables hold the Timeline's waveforms. */
  fullMessage(): string {
    const names = this.wavetables.filter((w) => w.pins && w.rows.some((r) => r.some((id) => id !== null))).map((w) => w.name);
    return `Timeline full: all ${this.timeline.length} waveforms are used by wavetables — remove some from ${names.join(', ') || 'your wavetables'}.`;
  }

  setNotice(msg: string): void {
    this.notice = msg;
    this.emit('notice');
  }

  /**
   * Append a copy of table `id` to the end of the timeline, as a single add (window
   * following, undo, selects the copy). The data is shared (tables are immutable).
   */
  copyToEnd(id: TableId | null): WaveTable | null {
    const t = this.table(id);
    if (!t) return null;
    return this.addTables([{ data: t.data, recipe: copyRecipe(t.id, t.recipe) }])[0] ?? null;
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

  /**
   * Add a voice (on the Timeline unless `patch` says otherwise; window = whole wavetable).
   * A Synth voice (`type: 'synth'`) starts from the Init patch with osc B on osc A's
   * wavetable and window (unless `patch.synth` says otherwise) and synth amp defaults.
   */
  addVoice(patch: Partial<VoiceParams> = {}): VoiceParams | null {
    if (this.voices.length >= MAX_VOICES) return null;
    const id = this.nextVoiceId++;
    const wt = this.wavetable(patch.wavetableId ?? TIMELINE_WAVETABLE_ID) ?? this.wavetables[0];
    const type: VoiceType = patch.type === 'synth' ? 'synth' : 'simple';
    let v: VoiceParams = {
      ...DEFAULT_VOICE,
      ...(type === 'synth' ? SYNTH_AMP_DEFAULTS : {}),
      ...fullWindow(wt),
      ...patch,
      type,
      wavetableId: wt.id,
      id,
      name: patch.name ?? `V${id}`,
    };
    v = clampVoiceWindow(v, wt);
    if (!patch.synth) v = { ...v, synth: { ...DEFAULT_SYNTH, b: { ...oscASource(v), position: Math.min(1, v.position + 0.25) } } };
    v = rehomeVoice(v, (x) => !!this.wavetable(x), this.wavetable(TIMELINE_WAVETABLE_ID)!);
    v = clampOscB(v, this.wavetable(v.synth.b.wavetableId)!);
    this.voices = [...this.voices, v];
    this.emit('voices');
    return v;
  }

  /**
   * Update voice params. Window edits are undoable (undo restores windows, so they must
   * be snapshotted too); a drag is one step until endGesture() or another action.
   * Switching wavetable (without an explicit window) selects the whole new wavetable.
   */
  updateVoice(id: number, patch: VoicePatch, opts: { undo?: boolean } = {}): void {
    // A wavetable that doesn't exist is ignored (never an empty undo step).
    if (patch.wavetableId !== undefined && !this.wavetable(patch.wavetableId)) {
      const { wavetableId: _w, ...rest } = patch;
      patch = rest;
    }
    if (!this.voice(id) || !Object.keys(patch).length) return;
    const windowEdit = WINDOW_KEYS.some((k) => k in patch);
    const v0 = this.voice(id);
    // Switching wavetable is an undo step (undo puts the voice back, window and all).
    const switching = !!v0 && patch.wavetableId !== undefined && patch.wavetableId !== v0.wavetableId && !!this.wavetable(patch.wavetableId);
    // Synth voices: edits from the panel are undo steps (a drag is one, see endGesture); a
    // type switch is one on any voice. MIDI controller moves pass `undo: false`.
    const synthEdit =
      !!v0 &&
      opts.undo !== false &&
      ((patch.type !== undefined && patch.type !== v0.type) || ((v0.type === 'synth' || patch.type === 'synth') && SYNTH_UNDO_KEYS.some((k) => k in patch)));
    if (switching) this.snapshot(synthEdit ? id : null);
    else if (windowEdit && this.gestureKey !== `window:${id}`) {
      this.snapshot(synthEdit ? id : null);
      this.gestureKey = `window:${id}`;
    } else if (synthEdit && !windowEdit && this.gestureKey !== `synth:${id}`) {
      this.snapshot(id);
      this.gestureKey = `synth:${id}`;
    }
    let changed = false;
    this.voices = this.voices.map((v) => {
      if (v.id !== id) return v;
      let next: VoiceParams = { ...applyVoicePatch(v, patch), id };
      const wt = this.wavetable(next.wavetableId);
      if (!wt) return v;
      if (next.wavetableId !== v.wavetableId && !windowEdit) next = { ...next, ...fullWindow(wt) };
      next = this.fixOscB(v, next, patch);
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
    if (changed) this.emit('voices', ...(windowEdit || switching || synthEdit ? (['undo'] as Topic[]) : []));
  }

  /**
   * Osc B after an edit: a new wavetable selects all of it (unless the patch sets its
   * window), the window is rounded, clamped and ordered (pushing the other handle), and a
   * missing wavetable falls back to the Timeline.
   */
  private fixOscB(v: VoiceParams, next: VoiceParams, patch: VoicePatch): VoiceParams {
    const pb = patch.synth?.b;
    let b = next.synth.b;
    if (b === v.synth.b) return next;
    const bwt = this.wavetable(b.wavetableId);
    if (!bwt) return rehomeVoice(next, (x) => !!this.wavetable(x), this.wavetable(TIMELINE_WAVETABLE_ID)!);
    const old = v.synth.b;
    const winEdit = !!pb && WINDOW_KEYS.some((k) => pb[k] !== old[k]);
    if (b.wavetableId !== old.wavetableId && !winEdit) b = { ...b, ...fullWindow(bwt) };
    b = { ...b, windowStart: Math.round(b.windowStart), windowEnd: Math.round(b.windowEnd), windowStartY: Math.round(b.windowStartY), windowEndY: Math.round(b.windowEndY) };
    const xLen = bwt.shape === 'rows' ? 1 : Math.max(1, bwt.rows[0]?.length ?? 0);
    const yLen = bwt.shape === '1d' ? 1 : Math.max(1, bwt.rows.length);
    const c = (x: number, len: number) => Math.max(0, Math.min(len - 1, x));
    b = { ...b, windowStart: c(b.windowStart, xLen), windowEnd: c(b.windowEnd, xLen), windowStartY: c(b.windowStartY, yLen), windowEndY: c(b.windowEndY, yLen) };
    const ordered = (s: 'windowStart' | 'windowStartY', e: 'windowEnd' | 'windowEndY') => {
      if (b[s] <= b[e]) return;
      const movedEnd = pb && pb[e] !== old[e] && pb[s] === old[s];
      b = movedEnd ? { ...b, [s]: b[e] } : { ...b, [e]: b[s] };
    };
    ordered('windowStart', 'windowEnd');
    ordered('windowStartY', 'windowEndY');
    return { ...next, synth: { ...next.synth, b } };
  }

  /** End a coalesced gesture (slider released). */
  endGesture(): void {
    this.gestureKey = null;
  }

  // ---- Shape chain ----

  /**
   * Replace the Shape tab's chain (normalised). An undo step, unless nothing changed;
   * calls with the same `gesture` key in a row (a slider drag, one drawn stroke) are one
   * step until endGesture() or another action.
   */
  setShapeChain(next: ShapeChain, gesture?: string): void {
    const n = normalizeChain(next);
    if (chainJson(n) === chainJson(this.shapeChain)) return;
    const key = gesture === undefined ? null : `shape:${gesture}`;
    if (key === null || this.gestureKey !== key) {
      this.snapshot();
      this.gestureKey = key;
    }
    this.shapeChain = n;
    this.emit('shape', 'undo');
  }

  /** The saved chain named like the current chain, if any (what Save overwrites). */
  savedChainNamed(name: string): SavedChain | undefined {
    return this.shapeChains.find((c) => c.chain.name === name);
  }

  /**
   * Save the current chain as `name` (trimmed; a new entry, or overwriting the saved chain of
   * that name). The current chain takes the name (an undo step if it changed). Null when the
   * list is full or the name is empty.
   */
  saveShapeChain(name: string): SavedChain | null {
    const nm = name.trim().slice(0, MAX_CHAIN_NAME);
    if (!nm) return null;
    const existing = this.savedChainNamed(nm);
    if (!existing && this.shapeChains.length >= MAX_SAVED_CHAINS) return null;
    if (this.shapeChain.name !== nm) this.setShapeChain({ ...this.shapeChain, name: nm });
    const entry: SavedChain = { id: existing?.id ?? this.chainId(), chain: normalizeChain(this.shapeChain) };
    this.shapeChains = existing ? this.shapeChains.map((c) => (c.id === existing.id ? entry : c)) : [...this.shapeChains, entry];
    this.emit('shape');
    return entry;
  }

  deleteShapeChain(id: string): void {
    if (!this.shapeChains.some((c) => c.id === id)) return;
    this.shapeChains = this.shapeChains.filter((c) => c.id !== id);
    this.emit('shape');
  }

  /** Add imported chains (names made unique) up to MAX_SAVED_CHAINS; returns how many were added. */
  importShapeChains(list: readonly ShapeChain[]): number {
    const names = new Set(this.shapeChains.map((c) => c.chain.name));
    const added: SavedChain[] = [];
    for (const c of list) {
      if (this.shapeChains.length + added.length >= MAX_SAVED_CHAINS) break;
      const n = normalizeChain(c);
      const name = uniqueName(n.name, names);
      names.add(name);
      added.push({ id: this.chainId(), chain: { ...n, name } });
    }
    if (!added.length) return 0;
    this.shapeChains = [...this.shapeChains, ...added];
    this.emit('shape');
    return added.length;
  }

  /**
   * A saved-chain id never used before (not even by a deleted chain: a Shape chip that
   * pointed at a deleted chain must not pick up a new one): time-based plus a counter that
   * only ever goes up, so ids minted within one millisecond still differ. The timestamp is a
   * fixed 8 base-36 digits (1973–2059), so timestamp + counter never reads ambiguously.
   */
  private chainId(): string {
    const used = new Set(this.shapeChains.map((c) => c.id));
    for (;;) {
      const id = `chain-${Date.now().toString(36)}${(this.chainSeq++).toString(36)}`;
      if (!used.has(id)) return id;
    }
  }
  private chainSeq = 0;

  // ---- voice presets ----

  /**
   * Apply a preset's sound to a voice (it becomes a Synth voice). One undo step. Its
   * wavetables are found by reference (built-in kind, or your wavetable's name + shape);
   * one that isn't in this session falls back to Last batch, with a notice.
   */
  applyPreset(voiceId: number, sound: PresetSound, name = 'Preset'): void {
    if (!this.voice(voiceId)) return;
    const missing: string[] = [];
    const fallback = this.wavetable(LAST_BATCH_WAVETABLE_ID)!;
    const pick = (id: number, ref: PresetSound['aRef'], osc: string) => {
      const wt = resolvePresetWavetable(this.wavetables, id, ref);
      if (wt) return wt.id;
      missing.push(`osc ${osc} (“${ref?.name ?? `#${id}`}”)`);
      return fallback.id;
    };
    const aId = pick(sound.a.wavetableId, sound.aRef, 'A');
    const bId = pick(sound.synth.b.wavetableId, sound.bRef, 'B');
    const patch = presetPatch({ ...sound, a: { ...sound.a, wavetableId: aId }, synth: { ...sound.synth, b: { ...sound.synth.b, wavetableId: bId } } });
    this.updateVoice(voiceId, patch);
    this.endGesture();
    if (missing.length) this.setNotice(`${name}: wavetable not in this session for ${missing.join(' and ')} — playing Last batch instead.`);
  }

  /** How many of these presets refer to a wavetable this session doesn't have. */
  presetsMissingWavetables(list: readonly VoicePreset[]): number {
    return list.filter(
      (p) => !resolvePresetWavetable(this.wavetables, p.sound.a.wavetableId, p.sound.aRef) || !resolvePresetWavetable(this.wavetables, p.sound.synth.b.wavetableId, p.sound.bRef),
    ).length;
  }

  /** Save a voice's sound as a user preset (name trimmed, made unique). */
  savePreset(voiceId: number, name: string): VoicePreset | null {
    const v = this.voice(voiceId);
    if (!v || this.voicePresets.length >= MAX_USER_PRESETS) return null;
    const p: VoicePreset = { id: this.presetId(), name: this.presetName(name), sound: presetSoundOf(v, (id) => this.wavetable(id)) };
    this.voicePresets = [...this.voicePresets, p];
    this.emit('presets');
    return p;
  }

  deletePreset(id: string): void {
    if (!this.voicePresets.some((p) => p.id === id)) return;
    this.voicePresets = this.voicePresets.filter((p) => p.id !== id);
    this.emit('presets');
  }

  /** Add presets (an imported file): fresh ids, unique names, up to the limit. Returns how many were added. */
  importPresets(list: readonly VoicePreset[]): number {
    let n = 0;
    for (const p of list) {
      if (this.voicePresets.length >= MAX_USER_PRESETS) break;
      this.voicePresets = [...this.voicePresets, { ...p, id: this.presetId(), name: this.presetName(p.name) }];
      n++;
    }
    if (n) this.emit('presets');
    return n;
  }

  /** Copy another voice's settings onto a voice (everything but its id, name and mute). Undoable on Synth voices. */
  pasteVoice(voiceId: number, from: VoiceParams): void {
    if (!this.voice(voiceId)) return;
    const { id: _id, name: _name, mute: _mute, ...rest } = from;
    this.updateVoice(voiceId, rest);
    this.endGesture();
  }

  private presetId(): string {
    let n = 1;
    for (const p of this.voicePresets) {
      const m = /^user-(\d+)$/.exec(p.id);
      if (m) n = Math.max(n, Number(m[1]) + 1);
    }
    return `user-${n}`;
  }

  private presetName(name: string): string {
    const base = name.trim().slice(0, 40) || 'Preset';
    const used = new Set(this.voicePresets.map((p) => p.name));
    if (!used.has(base)) return base;
    for (let i = 2; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
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

  /** User wavetables only (built-ins are read-only). */
  private userWavetable(id: WavetableId): Wavetable | undefined {
    const wt = this.wavetable(id);
    return wt && !wt.builtin ? wt : undefined;
  }

  /** Replace a wavetable's settings (not content): not undoable, kept across undo. */
  private setSettings(id: WavetableId, fn: (wt: Wavetable) => Wavetable): void {
    const wt = this.userWavetable(id);
    if (!wt) return;
    const next = fn(wt);
    if (next === wt) return;
    this.wavetables = this.wavetables.map((w) => (w.id === id ? next : w));
    this.emit('wavetables');
  }

  /**
   * An undoable content edit of a user wavetable: voice windows on it follow (see
   * followEdit). Returns false if nothing changed (no undo step).
   */
  private editWavetable(id: WavetableId, fn: (wt: Wavetable) => WavetableEdit): boolean {
    const wt = this.userWavetable(id);
    if (!wt) return false;
    const e = fn(wt);
    if (e.wt === wt) return false;
    this.snapshot();
    this.wavetables = this.wavetables.map((w) => (w.id === id ? e.wt : w));
    this.voices = followEdit(this.voices, wt, e);
    this.emit('wavetables', 'voices', 'undo');
    return true;
  }

  /**
   * Add generated tables (one batch, the selection kept) and put result i into the slot at
   * cells[i] of user wavetable `id`, replacing what was there: one undo step for both (the
   * add's). Refused for built-ins and Live wavetables (the add itself would write there).
   * Returns the added tables (empty if refused).
   */
  addReplacing(gen: readonly GeneratedTable[], id: WavetableId, cells: readonly Cell[]): WaveTable[] {
    const wt0 = this.userWavetable(id);
    if (!wt0 || wt0.live || cells.length !== gen.length) return [];
    const added = this.addTables(gen, false);
    if (!added.length) return [];
    const cur = this.userWavetable(id);
    if (!cur) return added;
    let next = cur;
    cells.forEach((c, i) => {
      next = placeTable(next, { kind: 'slot', x: c.x, y: c.y }, added[i].id).wt;
    });
    if (next !== cur) {
      this.wavetables = this.wavetables.map((w) => (w.id === id ? next : w));
      this.emit('wavetables', 'voices');
    }
    return added;
  }

  /** A fresh user wavetable id (never reused, not even after undo / delete). */
  private newWavetableId(): WavetableId {
    const id = Math.max(this.nextWavetableId, ...this.wavetables.map((w) => w.id + 1));
    this.nextWavetableId = id + 1;
    return id;
  }

  /** Voices whose wavetable (osc A or B) is gone move that oscillator to the Timeline (whole window). */
  private rehomeVoices(): void {
    const tl = this.wavetable(TIMELINE_WAVETABLE_ID)!;
    this.voices = this.voices.map((v) => rehomeVoice(v, (id) => !!this.wavetable(id), tl));
  }

  /** `base`, or `base 2`, `base 3`, … — the first name no wavetable has. */
  private uniqueName(base: string, numberFirst = false): string {
    const used = new Set(this.wavetables.map((w) => w.name));
    if (!numberFirst && !used.has(base)) return base;
    for (let n = numberFirst ? 1 : 2; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
  }

  private addWavetable(wt: Wavetable): Wavetable {
    this.snapshot();
    this.wavetables = [...this.wavetables, wt];
    this.emit('wavetables', 'undo');
    return wt;
  }

  /** A new, empty user wavetable (frozen; see newWavetable): 1D variable, 2D W × H (8×8) or Rows. Undoable. */
  createWavetable(shape: WavetableShape, w?: number, h?: number): Wavetable {
    return this.addWavetable(newWavetable(this.newWavetableId(), this.uniqueName('Wavetable', true), shape, w, h));
  }

  /** An editable, frozen copy of any wavetable (built-ins included), named "… copy". Undoable. */
  duplicateWavetable(id: WavetableId): Wavetable | null {
    const wt = this.wavetable(id);
    if (!wt) return null;
    return this.addWavetable(duplicateWavetable(wt, this.newWavetableId(), this.uniqueName(`${wt.name} copy`)));
  }

  /** Rename a user wavetable (trimmed; empty names are ignored). Undoable. */
  renameWavetable(id: WavetableId, name: string): void {
    const wt = this.userWavetable(id);
    const n = name.trim().slice(0, 40);
    if (!wt || !n || n === wt.name) return;
    this.snapshot();
    this.wavetables = this.wavetables.map((w) => (w.id === id ? { ...w, name: n } : w));
    this.emit('wavetables', 'undo');
  }

  /**
   * Delete a user wavetable; voices on it fall back to the Timeline (whole window). Its
   * waveforms are no longer pinned (evictable again). Undo brings it and those voices back.
   */
  deleteWavetable(id: WavetableId): void {
    if (!this.userWavetable(id)) return;
    this.snapshot();
    this.wavetables = this.wavetables.filter((w) => w.id !== id);
    this.rehomeVoices();
    this.emit('wavetables', 'voices', 'undo');
  }

  setWavetableLive(id: WavetableId, live: boolean): void {
    this.setSettings(id, (wt) => (wt.live === live ? wt : { ...wt, live }));
  }

  /** Write head settings (coerced per shape; a head that can't write any more restarts). */
  setWavetableWrite(id: WavetableId, patch: Partial<WriteSettings>): void {
    this.setSettings(id, (wt) => setWrite(wt, patch));
  }

  /** Move the write head (clamped; see setHead). */
  setWavetableHead(id: WavetableId, x: number, y: number): void {
    this.setSettings(id, (wt) => setHead(wt, x, y));
  }

  /** 1D: variable, or fixed at `len` slots (drops slots from the end when shrinking). Undoable. */
  resizeWavetable1D(id: WavetableId, fixed: boolean, len?: number): boolean {
    return this.editWavetable(id, (wt) => resize1D(wt, fixed, len));
  }

  /** 2D: resize to W × H (cells outside are dropped). Undoable. */
  resizeWavetable2D(id: WavetableId, w: number, h: number): boolean {
    return this.editWavetable(id, (wt) => resize2D(wt, w, h));
  }

  /** Put a timeline table into a user wavetable (replace / insert / new row). Undoable. */
  placeInWavetable(id: WavetableId, target: SlotTarget, tableId: TableId): boolean {
    if (!this.byId.has(tableId)) return false;
    return this.editWavetable(id, (wt) => placeTable(wt, target, tableId));
  }

  /** Move (or copy) a slot within a user wavetable. Undoable. */
  moveInWavetable(id: WavetableId, from: Cell, target: SlotTarget, copy = false): boolean {
    return this.editWavetable(id, (wt) => moveSlot(wt, from, target, copy));
  }

  /** Empty a slot (it stays). Undoable. */
  clearWavetableSlot(id: WavetableId, x: number, y: number): boolean {
    return this.editWavetable(id, (wt) => clearSlot(wt, x, y));
  }

  /** Remove a slot (variable lines close up; see removeSlot). Undoable. */
  removeWavetableSlot(id: WavetableId, x: number, y: number): boolean {
    return this.editWavetable(id, (wt) => removeSlot(wt, x, y));
  }

  // ---- sequences ----

  addSequence(voiceId: number | null, steps: readonly number[] = [], length = 16): SequenceData {
    const s: SequenceData = {
      id: this.nextSeqId++,
      voiceId,
      length: Math.max(1, Math.min(MAX_STEPS, length)),
      steps: normalizeSteps(steps.length ? steps : emptySteps()),
      gate: 0.5,
      stepLength: DEFAULT_STEP_LENGTH,
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
            stepLength: isStepLength(patch.stepLength) ? patch.stepLength : s.stepLength,
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

  // ---- session (persistence) ----

  /** Everything a saved session holds (references: tables and wavetables are immutable). No undo history. */
  exportState(): ModelState {
    return {
      timeline: this.timeline,
      nextTableId: this.tableIds.next,
      wavetables: this.wavetables,
      nextWavetableId: this.nextWavetableId,
      voices: this.voices,
      nextVoiceId: this.nextVoiceId,
      sequences: this.sequences,
      nextSeqId: this.nextSeqId,
      selectedId: this.selectedId,
      breedParents: this.breedParents,
      bpm: this.bpm,
      voicePresets: this.voicePresets,
      shapeChain: this.shapeChain,
      shapeChains: this.shapeChains,
    };
  }

  /** Allocate future waveform ids at or above `next` (ids already in storage are never reused). */
  reserveTableIds(next: number): void {
    if (next > this.tableIds.next) this.tableIds.next = next;
  }

  /**
   * Replace the whole state (restore, import, new session). Clears undo; the transport's
   * play state is kept. Every topic is emitted, timeline first (as for an add).
   */
  loadState(s: ModelState): void {
    this.gestureKey = null;
    this.undoStack = [];
    this.timeline = s.timeline;
    this.byId = new Map(s.timeline.map((t) => [t.id, t]));
    this.tableIds = new IdAllocator(Math.max(s.nextTableId, ...s.timeline.map((t) => t.id + 1), 1));
    this.wavetables = s.wavetables;
    // Monotonic: never below a saved counter or any existing id (deleted ids aren't reused).
    this.nextWavetableId = Math.max(FIRST_USER_WAVETABLE_ID, s.nextWavetableId, ...s.wavetables.map((w) => w.id + 1));
    this.voices = s.voices;
    this.nextVoiceId = Math.max(s.nextVoiceId, ...s.voices.map((v) => v.id + 1), 1);
    this.sequences = s.sequences;
    this.nextSeqId = Math.max(s.nextSeqId, ...s.sequences.map((q) => q.id + 1), 1);
    this.selectedId = s.selectedId !== null && this.byId.has(s.selectedId) ? s.selectedId : (s.timeline.at(-1)?.id ?? null);
    this.breedParents = s.breedParents.filter((id) => this.byId.has(id)).slice(0, MAX_PARENTS);
    this.bpm = Math.max(40, Math.min(300, s.bpm));
    this.voicePresets = s.voicePresets ?? [];
    this.shapeChain = s.shapeChain ? normalizeChain(s.shapeChain) : DEFAULT_CHAIN;
    this.shapeChains = s.shapeChains ?? [];
    this.emit('timeline', 'wavetables', 'voices', 'sequences', 'selection', 'transport', 'undo', 'parents', 'presets', 'shape');
  }

  // ---- undo ----

  /** Push an undo step; `soundVoice` = the voice whose sound this action edits (see Snapshot.sound). */
  private snapshot(soundVoice: number | null = null): void {
    this.gestureKey = null;
    const sv = soundVoice === null ? undefined : this.voice(soundVoice);
    this.undoStack.push({
      timeline: this.timeline,
      selectedId: this.selectedId,
      wavetables: this.wavetables,
      windows: new Map(this.voices.map((v) => [v.id, windowsOf(v)])),
      bWindows: new Map(this.voices.map((v) => [v.id, windowsOf(v.synth.b)])),
      sound: sv ? { id: sv.id, sound: soundOf(sv) } : null,
      steps: new Map(this.sequences.map((s) => [s.id, s.steps])),
      shapeChain: this.shapeChain,
    });
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
  }

  undo(): void {
    this.gestureKey = null;
    const s = this.undoStack.pop();
    if (!s) return;
    const parentsChanged = this.setTimeline(s.timeline);
    this.selectedId = s.selectedId !== null && this.byId.has(s.selectedId) ? s.selectedId : (s.timeline.at(-1)?.id ?? null);
    // Contents (slots, head, size, name) come back; settings changed since (interpolation,
    // Live / Frozen, write head settings) are kept.
    const now = new Map(this.wavetables.map((w) => [w.id, w]));
    this.wavetables = s.wavetables.map((w) => {
      const cur = now.get(w.id);
      if (!cur || (cur.interp === w.interp && cur.live === w.live && cur.write === w.write)) return w;
      // The write settings must suit the restored size (fixed / variable 1D).
      return { ...w, interp: cur.interp, live: cur.live, write: normalizeWrite(w.shape, w.fixed, cur.write) };
    });
    // Voices go back to their wavetable and windows (switching wavetable is an undo step
    // too); a voice whose wavetable no longer exists (an undone create) moves to the Timeline.
    this.voices = this.voices.map((v) => {
      const w = s.windows.get(v.id);
      let next = w && this.wavetable(w.wavetableId) ? { ...v, ...w } : v;
      const bw = s.bWindows.get(next.id);
      if (bw && this.wavetable(bw.wavetableId)) next = { ...next, synth: { ...next.synth, b: { ...next.synth.b, ...bw } } };
      // The edited voice's sound: type and synth block; the shared params only if it was a Synth voice.
      const snd = s.sound?.id === next.id ? s.sound.sound : undefined;
      if (snd) next = snd.type === 'synth' ? { ...next, ...snd } : { ...next, type: snd.type, synth: snd.synth };
      const wt = this.wavetable(next.wavetableId);
      if (wt) next = clampVoiceWindow(next, wt);
      const bwt = this.wavetable(next.synth.b.wavetableId);
      return bwt ? clampOscB(next, bwt) : next;
    });
    this.rehomeVoices();
    this.sequences = this.sequences.map((q) => {
      const st = s.steps.get(q.id);
      return st ? { ...q, steps: st } : q;
    });
    const shapeChanged = s.shapeChain !== this.shapeChain;
    this.shapeChain = s.shapeChain;
    this.emit(
      'timeline',
      'wavetables',
      'voices',
      'sequences',
      'selection',
      'undo',
      ...(parentsChanged ? (['parents'] as Topic[]) : []),
      ...(shapeChanged ? (['shape'] as Topic[]) : []),
    );
  }

  clearUndo(): void {
    this.undoStack = [];
    this.emit('undo');
  }
}

function soundOf(v: VoiceParams): SynthSound {
  return {
    type: v.type,
    synth: v.synth,
    attack: v.attack,
    decay: v.decay,
    sustain: v.sustain,
    release: v.release,
    level: v.level,
    octave: v.octave,
    position: v.position,
    positionY: v.positionY,
  };
}

function windowsOf(v: Windows): Windows {


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
