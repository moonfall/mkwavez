import { describe, expect, it } from 'vitest';
import { AppModel } from '../src/app/model';
import { generateBasic, generatePerlin, DEFAULT_PERLIN } from '../src/core/generators';
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

  it('window edits push the other handle', () => {
    const { m, b } = model();
    m.updateVoice(b.id, { windowStart: 2 });
    expect([m.voice(b.id)!.windowStart, m.voice(b.id)!.windowEnd]).toEqual([2, 2]);
    m.updateVoice(b.id, { windowEnd: 0 });
    expect([m.voice(b.id)!.windowStart, m.voice(b.id)!.windowEnd]).toEqual([0, 0]);
  });
});
