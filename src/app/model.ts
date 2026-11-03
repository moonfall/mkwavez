/**
 * Main-thread application state + actions. Plain data in, plain data out; the UI and
 * the audio bridge subscribe to topics. Tables are immutable, so undo snapshots are
 * reference copies.
 */
import { MAX_STEPS, TIMELINE_CAP, UNDO_DEPTH } from '../core/constants';
import { emptySteps, normalizeSteps, type SequenceData } from '../core/sequence';
import { IdAllocator, makeTable, type GeneratedTable, type TableId, type WaveTable } from '../core/table';
import { appendWithEviction } from '../core/timeline';
import { DEFAULT_VOICE, followAppend, type VoiceParams } from '../core/voice';
import {
  allWavetable,
  ALL_WAVETABLE_ID,
  clampWindow,
  pinnedIds,
  wavetableLength,
  type Wavetable,
  type WavetableId,
} from '../core/wavetable';

/** 'undo' = undo depth changed (any snapshot or undo); 'undone' = an undo was applied. */
export type Topic = 'timeline' | 'selection' | 'voices' | 'sequences' | 'transport' | 'undo' | 'undone' | 'batchTargets';

export const MAX_VOICES = 8;

interface Snapshot {
  timeline: readonly WaveTable[];
  selectedId: TableId | null;
  windows: Map<number, [number, number]>;
  steps: Map<number, readonly number[]>;
}

export class AppModel {
  timeline: readonly WaveTable[] = [];
  wavetables: readonly Wavetable[] = [allWavetable([])];
  voices: readonly VoiceParams[] = [];
  sequences: readonly SequenceData[] = [];
  batchTargets: ReadonlySet<number> = new Set();
  selectedId: TableId | null = null;
  playing = false;
  bpm = 132;
  readonly cap: number;

  private byId = new Map<TableId, WaveTable>();
  private tableIds = new IdAllocator(1);
  private nextVoiceId = 1;
  private nextSeqId = 1;
  private undoStack: Snapshot[] = [];
  /** Coalesces a continuous gesture (e.g. a window-slider drag) into one undo step. */
  private gestureKey: string | null = null;
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

  /** Resolve a wavetable position to a table. */
  tableAt(wtId: WavetableId, index: number): WaveTable | undefined {
    const wt = this.wavetable(wtId);
    if (!wt) return undefined;
    const id = wt.ids[index];
    return id === null || id === undefined ? undefined : this.byId.get(id);
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
   * Append generated tables to the timeline. 'single' extends following windows;
   * 'batch' sets the windows of batch-target voices to the batch.
   */
  addTables(gen: readonly GeneratedTable[], mode: 'single' | 'batch', selectNew = true): WaveTable[] {
    if (!gen.length) return [];
    this.snapshot();
    const added = gen.map((g) => makeTable(this.tableIds.take(), g));
    const oldLen = this.timeline.length;
    const pinned = pinnedIds(this.wavetables);
    const r = appendWithEviction(this.timeline, added, this.cap, (id) => pinned.has(id));
    this.setTimeline(r.list);
    this.voices = followAppend(
      this.voices,
      ALL_WAVETABLE_ID,
      oldLen,
      r.list.length,
      r.evictedIndices,
      mode === 'single'
        ? { kind: 'single' }
        : { kind: 'batch', count: Math.min(added.length, r.list.length), targets: this.batchTargets },
    );
    if (selectNew) this.selectedId = added[added.length - 1].id;
    else if (this.selectedId !== null && !this.byId.has(this.selectedId)) this.selectedId = r.list[0]?.id ?? null;
    this.emit('timeline', 'voices', 'selection', 'undo');
    return added;
  }

  private setTimeline(list: readonly WaveTable[]): void {
    this.timeline = list;
    this.byId = new Map(list.map((t) => [t.id, t]));
    // Pinned tables live in the timeline, so user wavetables never dangle.
    this.wavetables = this.wavetables.map((w) => (w.auto === 'all' ? allWavetable(list.map((t) => t.id)) : w));
  }

  select(id: TableId): void {
    if (!this.byId.has(id) || id === this.selectedId) return;
    this.selectedId = id;
    this.emit('selection');
  }

  // ---- voices ----

  addVoice(patch: Partial<VoiceParams> = {}): VoiceParams | null {
    if (this.voices.length >= MAX_VOICES) return null;
    const id = this.nextVoiceId++;
    const len = wavetableLength(this.wavetable(ALL_WAVETABLE_ID)!);
    const v: VoiceParams = {
      ...DEFAULT_VOICE,
      windowStart: 0,
      windowEnd: Math.max(0, len - 1),
      ...patch,
      id,
      name: patch.name ?? `V${id}`,
    };
    this.voices = [...this.voices, v];
    this.emit('voices');
    return v;
  }

  /**
   * Update voice params. Window edits are undoable (undo restores windows, so they must
   * be snapshotted too); a drag is one step until endGesture() or another action.
   */
  updateVoice(id: number, patch: Partial<VoiceParams>): void {
    const windowEdit = 'windowStart' in patch || 'windowEnd' in patch;
    if (windowEdit && this.gestureKey !== `window:${id}`) {
      this.snapshot();
      this.gestureKey = `window:${id}`;
    }
    let changed = false;
    this.voices = this.voices.map((v) => {
      if (v.id !== id) return v;
      const next = { ...v, ...patch, id };
      const wt = this.wavetable(next.wavetableId);
      const max = Math.max(0, (wt ? wavetableLength(wt) : 0) - 1);
      const c = (x: number) => Math.max(0, Math.min(max, Math.round(x)));
      let s = c(next.windowStart);
      let e = c(next.windowEnd);
      // Keep start <= end by pushing the other handle, not the one being dragged.
      if (s > e) {
        if ('windowEnd' in patch && !('windowStart' in patch)) s = e;
        else e = s;
      }
      changed = true;
      return { ...next, windowStart: s, windowEnd: e };
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
    if (this.batchTargets.has(id)) {
      const s = new Set(this.batchTargets);
      s.delete(id);
      this.batchTargets = s;
    }
    this.emit('voices', 'sequences', 'batchTargets');
  }

  setBatchTarget(voiceId: number, on: boolean): void {
    const s = new Set(this.batchTargets);
    if (on) s.add(voiceId);
    else s.delete(voiceId);
    this.batchTargets = s;
    this.emit('batchTargets');
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
      windows: new Map(this.voices.map((v) => [v.id, [v.windowStart, v.windowEnd]])),
      steps: new Map(this.sequences.map((s) => [s.id, s.steps])),
    });
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
  }

  undo(): void {
    this.gestureKey = null;
    const s = this.undoStack.pop();
    if (!s) return;
    this.setTimeline(s.timeline);
    this.selectedId = s.selectedId !== null && this.byId.has(s.selectedId) ? s.selectedId : (s.timeline.at(-1)?.id ?? null);
    const len = this.timeline.length;
    this.voices = this.voices.map((v) => {
      const w = s.windows.get(v.id);
      const [a, b] = clampWindow(w ? w[0] : v.windowStart, w ? w[1] : v.windowEnd, len);
      return { ...v, windowStart: a, windowEnd: b };
    });
    this.sequences = this.sequences.map((q) => {
      const st = s.steps.get(q.id);
      return st ? { ...q, steps: st } : q;
    });
    this.emit('timeline', 'voices', 'sequences', 'selection', 'undo', 'undone');
  }

  clearUndo(): void {
    this.undoStack = [];
    this.emit('undo');
  }
}
