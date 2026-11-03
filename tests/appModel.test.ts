import { describe, expect, it } from 'vitest';
import { AppModel } from '../src/app/model';
import { generateBasic, generatePerlin, DEFAULT_PERLIN, renderRecipe } from '../src/core/generators';
import { mutateBatch } from '../src/core/mutateBatch';
import { copyRecipe, describeRecipe } from '../src/core/table';
import {
  BATCHES_WAVETABLE_ID,
  GRID_WAVETABLE_ID,
  LAST_BATCH_WAVETABLE_ID,
  make1D,
  TIMELINE_WAVETABLE_ID,
} from '../src/core/wavetable';

/** n copies of a sine (cheap filler for eviction tests). */
const sines = (n: number) => Array.from({ length: n }, () => generateBasic('sine', 0));


function model(cap = 8) {
  const m = new AppModel(cap);
  for (const w of ['sine', 'tri', 'saw'] as const) m.addTables([generateBasic(w, 0)]);
  const a = m.addVoice({ windowStart: 0, windowEnd: 2 })!;
  const b = m.addVoice({ windowStart: 0, windowEnd: 1 })!;
  m.clearUndo();
  return { m, a, b };
}

describe('AppModel', () => {
  it('assigns stable ids and keeps the Timeline wavetable in sync', () => {
    const { m } = model();
    expect(m.timeline.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(m.wavetable(TIMELINE_WAVETABLE_ID)!.rows).toEqual([[1, 2, 3]]);
    expect(m.timeline[2].recipe.op).toBe('basic');
  });

  it('single add follows windows ending on the newest table', () => {
    const { m, a, b } = model();
    m.addTables([generateBasic('square', 0)]);
    expect(m.voice(a.id)!.windowEnd).toBe(3);
    expect(m.voice(b.id)!.windowEnd).toBe(1);
    expect(m.selectedId).toBe(4);
  });

  it('a batch extends Timeline windows ending on the newest table', () => {
    const { m, a, b } = model();
    m.addTables(generatePerlin(DEFAULT_PERLIN, 1, 4));
    expect([m.voice(a.id)!.windowStart, m.voice(a.id)!.windowEnd]).toEqual([0, 6]);
    expect([m.voice(b.id)!.windowStart, m.voice(b.id)!.windowEnd]).toEqual([0, 1]);
  });

  it('evicts oldest unpinned at the cap and shifts windows; undo restores', () => {
    // The Grid pins the latest 64 tables and Last batch the latest batch, so caps are > 64 here.
    const { m, a, b } = model(70);
    m.updateVoice(b.id, { windowStart: 1, windowEnd: 2 });
    m.clearUndo();
    m.addTables(sines(68), false);
    expect(m.timeline.length).toBe(70);
    expect(m.timeline[0].id).toBe(2);
    expect([m.voice(a.id)!.windowStart, m.voice(a.id)!.windowEnd]).toEqual([0, 69]);
    expect([m.voice(b.id)!.windowStart, m.voice(b.id)!.windowEnd]).toEqual([0, 69]);
    expect(m.wavetable(TIMELINE_WAVETABLE_ID)!.rows[0]).toEqual(m.timeline.map((t) => t.id));
    expect(m.wavetable(BATCHES_WAVETABLE_ID)!.rows.length).toBe(3); // [1]'s row is gone
    m.undo();
    expect(m.timeline.map((t) => t.id)).toEqual([1, 2, 3]);
    expect([m.voice(a.id)!.windowEnd, m.voice(b.id)!.windowStart]).toEqual([2, 1]);
  });

  it('never evicts tables referenced by a pinning wavetable', () => {
    const { m } = model(70);
    (m as unknown as { wavetables: unknown[] }).wavetables = [...m.wavetables, make1D(16, 'Keep', [1])];
    m.addTables(sines(68));
    expect(m.timeline.map((t) => t.id).slice(0, 2)).toEqual([1, 3]);
    // Never past the cap: an add that would need to evict its own waveforms is refused.
    const small = new AppModel(2);
    expect(small.addTables(sines(3))).toEqual([]);
    expect([small.timeline.length, small.undoDepth]).toEqual([0, 0]);
    expect(small.notice).toMatch(/^Timeline full/);
  });

  it('undo covers note edits', () => {
    const { m, a } = model();
    const s = m.addSequence(a.id);
    m.updateSequence(s.id, { steps: [3] }, true);
    expect(m.sequences[0].steps[0]).toBe(3);
    m.undo();
    expect(m.sequences[0].steps[0]).toBe(-1);
  });

  it('window drags are one undo step and undo does not clobber later edits', () => {
    const { m, a } = model();
    const s = m.addSequence(a.id);
    m.updateVoice(a.id, { windowStart: 1 });
    m.updateVoice(a.id, { windowStart: 2 });
    m.endGesture();
    m.updateSequence(s.id, { steps: [4] }, true);
    expect(m.undoDepth).toBe(2);
    m.undo(); // reverts the note only
    expect(m.sequences[0].steps[0]).toBe(-1);
    expect(m.voice(a.id)!.windowStart).toBe(2);
    m.undo(); // reverts the whole drag
    expect(m.voice(a.id)!.windowStart).toBe(0);
  });

  it('window edits push the other handle', () => {
    const { m, b } = model();
    m.updateVoice(b.id, { windowStart: 2 });
    expect([m.voice(b.id)!.windowStart, m.voice(b.id)!.windowEnd]).toEqual([2, 2]);
    m.updateVoice(b.id, { windowEnd: 0 });
    expect([m.voice(b.id)!.windowStart, m.voice(b.id)!.windowEnd]).toEqual([0, 0]);
  });
});

describe('copyToEnd', () => {
  const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((v, i) => v === b[i]);

  it('appends a copy as a single add: new id, shared data, follows windows, selects it, undoable', () => {
    const { m, a, b } = model();
    const src = m.timeline[0];
    const c = m.copyToEnd(src.id)!;
    expect(c.id).toBe(4);
    expect(m.timeline.map((t) => t.id)).toEqual([1, 2, 3, 4]);
    expect(c.data).toBe(src.data);
    expect(c.recipe).toEqual(copyRecipe(src.id, src.recipe));
    expect(c.recipe.params.copyOf).toBe(src.id);
    expect(describeRecipe(c.recipe)).toBe('sine · copy of id 1');
    expect(m.selectedId).toBe(c.id);
    expect(m.voice(a.id)!.windowEnd).toBe(3); // window ending on the newest follows
    expect(m.voice(b.id)!.windowEnd).toBe(1);
    expect(m.undoDepth).toBe(1);
    m.undo();
    expect(m.timeline.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(m.voice(a.id)!.windowEnd).toBe(2);
    expect(m.copyToEnd(null)).toBeNull();
    expect(m.copyToEnd(999)).toBeNull();
    expect(m.timeline.length).toBe(3);
  });

  it('a copy re-renders from its own recipe even after the copied table is evicted', () => {
    const { m } = model(70);
    const source = m.timeline[2]; // saw: the mutation's source, kept for re-rendering below
    m.addTables(mutateBatch({ mutation: 'fold', amount: 0.6, seed: 3, mode: 'chain', count: 2 }, source), false);
    m.addTables(generatePerlin(DEFAULT_PERLIN, 7, 4), false);
    // Copy a batched seed table and a chain mutation table.
    const perlin = m.timeline.find((t) => t.recipe.op === 'perlin' && t.recipe.batch?.index === 2)!;
    const mut = m.timeline.find((t) => t.recipe.op === 'mutate' && t.recipe.batch?.index === 1)!;
    const cp = m.copyToEnd(perlin.id)!;
    const cm = m.copyToEnd(mut.id)!;
    const cc = m.copyToEnd(cm.id)!;
    expect(cc.recipe.params.copyOf).toBe(cm.id); // a copy of a copy points at its source
    expect(cc.recipe.parents).toEqual(mut.recipe.parents);
    // Fill past the cap so the copied tables are evicted (and no longer in the Grid / Last batch).
    m.addTables(sines(70), false);
    expect(m.table(perlin.id)).toBeUndefined();
    expect(m.table(mut.id)).toBeUndefined();
    expect(m.table(source.id)).toBeUndefined();
    const resolve = (id: number) => (id === source.id ? source.data : m.table(id)?.data);
    for (const t of [cp, cm, cc]) expect(same(t.data, renderRecipe(t.recipe, { resolveTable: resolve }))).toBe(true);
  });
});

describe('built-in wavetables', () => {
  const rowsOf = (m: AppModel, id: number) => m.wavetable(id)!.rows;

  it('update on single adds and batches', () => {
    const { m } = model();
    expect(rowsOf(m, LAST_BATCH_WAVETABLE_ID)).toEqual([[3]]);
    expect(rowsOf(m, BATCHES_WAVETABLE_ID)).toEqual([[1], [2], [3]]);
    expect(rowsOf(m, GRID_WAVETABLE_ID)[0]).toEqual([1, 2, 3, null, null, null, null, null]);
    m.addTables(sines(4));
    expect(rowsOf(m, TIMELINE_WAVETABLE_ID)).toEqual([[1, 2, 3, 4, 5, 6, 7]]);
    expect(rowsOf(m, LAST_BATCH_WAVETABLE_ID)).toEqual([[4, 5, 6, 7]]);
    expect(rowsOf(m, BATCHES_WAVETABLE_ID)).toEqual([[1], [2], [3], [4, 5, 6, 7]]);
    expect(rowsOf(m, GRID_WAVETABLE_ID)[0]).toEqual([1, 2, 3, 4, 5, 6, 7, null]);
    m.copyToEnd(1);
    expect(rowsOf(m, LAST_BATCH_WAVETABLE_ID)).toEqual([[8]]);
    expect(rowsOf(m, BATCHES_WAVETABLE_ID).at(-1)).toEqual([8]);
    expect(rowsOf(m, GRID_WAVETABLE_ID)[1][0]).toBe(null);
    expect(rowsOf(m, GRID_WAVETABLE_ID)[0][7]).toBe(8);
  });

  it('a voice on Last batch plays each new batch in full', () => {
    const { m } = model(100);
    const v = m.addVoice({ wavetableId: LAST_BATCH_WAVETABLE_ID })!;
    expect([v.windowStart, v.windowEnd]).toEqual([0, 0]);
    m.addTables(sines(8));
    expect([m.voice(v.id)!.windowStart, m.voice(v.id)!.windowEnd]).toEqual([0, 7]);
    expect(m.windowTables(m.voice(v.id)!).map((t) => t.id)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    m.addTables(sines(1));
    expect([m.voice(v.id)!.windowStart, m.voice(v.id)!.windowEnd]).toEqual([0, 0]);
    m.addTables(sines(3));
    expect([m.voice(v.id)!.windowStart, m.voice(v.id)!.windowEnd]).toEqual([0, 2]);
  });

  it('undo of an add also undoes the built-in updates', () => {
    const { m } = model();
    const before = m.wavetables;
    m.addTables(sines(5));
    m.addTables(sines(1));
    m.undo();
    m.undo();
    expect(m.wavetables).toEqual(before);
  });

  it('eviction never leaves a dangling id', () => {
    const m = new AppModel(70);
    for (let i = 0; i < 30; i++) m.addTables(sines(1 + (i % 7)));
    const live = new Set(m.timeline.map((t) => t.id));
    expect(m.timeline.length).toBeLessThanOrEqual(70);
    for (const w of m.wavetables) for (const r of w.rows) for (const id of r) if (id !== null) expect(live.has(id)).toBe(true);
    expect(m.wavetable(TIMELINE_WAVETABLE_ID)!.rows[0]).toEqual(m.timeline.map((t) => t.id));
    expect(m.wavetable(BATCHES_WAVETABLE_ID)!.rows.flat()).toEqual(m.timeline.map((t) => t.id));
  });

  it('emits timeline, wavetables, voices in that order (one worklet batch)', () => {
    const { m } = model();
    const seen: string[] = [];
    for (const t of ['timeline', 'wavetables', 'voices'] as const) m.on(t, () => seen.push(t));
    m.addTables(sines(2));
    expect(seen).toEqual(['timeline', 'wavetables', 'voices']);
  });

  it('interpolation is a wavetable setting, kept across undo', () => {
    const { m } = model();
    let n = 0;
    m.on('wavetables', () => n++);
    m.addTables(sines(1));
    m.setWavetableInterp(GRID_WAVETABLE_ID, 'step');
    expect(m.wavetable(GRID_WAVETABLE_ID)!.interp).toBe('step');
    m.undo();
    expect(m.wavetable(GRID_WAVETABLE_ID)!.interp).toBe('step');
    expect(n).toBe(3);
  });
});

describe('voices on 2D / Rows wavetables', () => {
  it('switching wavetable selects all of it; windows clamp per axis and push the other handle', () => {
    const { m, a } = model();
    m.updateVoice(a.id, { wavetableId: GRID_WAVETABLE_ID });
    let v = m.voice(a.id)!;
    expect([v.windowStart, v.windowEnd, v.windowStartY, v.windowEndY]).toEqual([0, 7, 0, 7]);
    m.updateVoice(a.id, { windowStartY: 99 });
    v = m.voice(a.id)!;
    expect([v.windowStartY, v.windowEndY]).toEqual([7, 7]);
    m.updateVoice(a.id, { windowEndY: 2 });
    v = m.voice(a.id)!;
    expect([v.windowStartY, v.windowEndY]).toEqual([2, 2]);
    expect(m.windowTables({ ...v, windowStartY: 0, windowEndY: 0, windowStart: 0, windowEnd: 7 }).map((t) => t.id)).toEqual([1, 2, 3]);
    m.updateVoice(a.id, { wavetableId: BATCHES_WAVETABLE_ID });
    v = m.voice(a.id)!;
    expect([v.windowStart, v.windowEnd, v.windowStartY, v.windowEndY]).toEqual([0, 0, 0, 2]);
    m.addTables(sines(2));
    expect(m.voice(a.id)!.windowEndY).toBe(3); // the row window follows new rows
  });

  it('undo restores 2D windows (Y too)', () => {
    const { m, a } = model();
    m.updateVoice(a.id, { wavetableId: GRID_WAVETABLE_ID });
    m.updateVoice(a.id, { windowStartY: 3, windowEndY: 5 });
    m.endGesture();
    m.undo();
    const v = m.voice(a.id)!;
    expect([v.windowStartY, v.windowEndY]).toEqual([0, 7]);
  });
});
