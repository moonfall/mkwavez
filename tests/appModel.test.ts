import { describe, expect, it } from 'vitest';
import { AppModel } from '../src/app/model';
import { generateBasic, generatePerlin, DEFAULT_PERLIN, renderRecipe } from '../src/core/generators';
import { mutateBatch } from '../src/core/mutateBatch';
import { copyRecipe, describeRecipe } from '../src/core/table';
import { make1D } from '../src/core/wavetable';

function model(cap = 8) {
  const m = new AppModel(cap);
  for (const w of ['sine', 'tri', 'saw'] as const) m.addTables([generateBasic(w, 0)], 'single');
  const a = m.addVoice({ windowStart: 0, windowEnd: 2 })!;
  const b = m.addVoice({ windowStart: 0, windowEnd: 1 })!;
  m.clearUndo();
  return { m, a, b };
}

describe('AppModel', () => {
  it('assigns stable ids and keeps the All wavetable in sync', () => {
    const { m } = model();
    expect(m.timeline.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(m.wavetables[0].ids).toEqual([1, 2, 3]);
    expect(m.timeline[2].recipe.op).toBe('basic');
  });

  it('single add follows windows ending on the newest table', () => {
    const { m, a, b } = model();
    m.addTables([generateBasic('square', 0)], 'single');
    expect(m.voice(a.id)!.windowEnd).toBe(3);
    expect(m.voice(b.id)!.windowEnd).toBe(1);
    expect(m.selectedId).toBe(4);
  });

  it('batch sets target windows to the batch', () => {
    const { m, b } = model();
    m.setBatchTarget(b.id, true);
    m.addTables(generatePerlin(DEFAULT_PERLIN, 1, 4), 'batch');
    expect([m.voice(b.id)!.windowStart, m.voice(b.id)!.windowEnd]).toEqual([3, 6]);
  });

  it('evicts oldest at the cap and shifts windows; undo restores', () => {
    const { m, a } = model(4);
    m.addTables(generatePerlin(DEFAULT_PERLIN, 1, 3), 'single');
    expect(m.timeline.length).toBe(4);
    expect(m.timeline[0].id).toBe(3);
    expect(m.voice(a.id)!.windowEnd).toBe(3);
    m.undo();
    expect(m.timeline.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(m.voice(a.id)!.windowEnd).toBe(2);
  });

  it('never evicts tables referenced by a user wavetable', () => {
    const { m } = model(4);
    (m as unknown as { wavetables: unknown[] }).wavetables = [...m.wavetables, make1D(5, 'Keep', [1])];
    m.addTables(generatePerlin(DEFAULT_PERLIN, 1, 3), 'single');
    expect(m.timeline.map((t) => t.id)).toEqual([1, 4, 5, 6]);
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
    const { m } = model(6);
    const source = m.timeline[2]; // saw: the mutation's source, kept for re-rendering below
    m.addTables(mutateBatch({ mutation: 'fold', amount: 0.6, seed: 3, mode: 'chain', count: 2 }, source), 'batch', false);
    m.addTables(generatePerlin(DEFAULT_PERLIN, 7, 4), 'batch', false);
    // Copy a batched seed table and a chain mutation table.
    const perlin = m.timeline.find((t) => t.recipe.op === 'perlin' && t.recipe.batch?.index === 2)!;
    const mut = m.timeline.find((t) => t.recipe.op === 'mutate' && t.recipe.batch?.index === 1)!;
    const cp = m.copyToEnd(perlin.id)!;
    const cm = m.copyToEnd(mut.id)!;
    const cc = m.copyToEnd(cm.id)!;
    expect(cc.recipe.params.copyOf).toBe(cm.id); // a copy of a copy points at its source
    expect(cc.recipe.parents).toEqual(mut.recipe.parents);
    // Fill past the cap so the copied tables are evicted.
    m.addTables(generatePerlin(DEFAULT_PERLIN, 9, 3), 'batch', false);
    expect(m.table(perlin.id)).toBeUndefined();
    expect(m.table(mut.id)).toBeUndefined();
    expect(m.table(source.id)).toBeUndefined();
    const resolve = (id: number) => (id === source.id ? source.data : m.table(id)?.data);
    for (const t of [cp, cm, cc]) expect(same(t.data, renderRecipe(t.recipe, { resolveTable: resolve }))).toBe(true);
  });
});
