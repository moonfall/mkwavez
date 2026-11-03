import { describe, expect, it } from 'vitest';
import { AppModel } from '../src/app/model';
import { parseProject } from '../src/app/project';
import { applyStartState } from '../src/app/startState';
import { DEFAULT_PERLIN, generatePerlin } from '../src/core/generators';
import { mutateBatch } from '../src/core/mutateBatch';
import { GRID_WAVETABLE_ID } from '../src/core/wavetable';

function busyModel() {
  const m = new AppModel(12);
  applyStartState(m);
  m.addTables(generatePerlin(DEFAULT_PERLIN, 42, 6));
  m.addTables(mutateBatch({ mutation: 'fold', amount: 0.6, seed: 7, mode: 'lin', count: 4 }, m.timeline[2]));
  m.setWavetableInterp(GRID_WAVETABLE_ID, 'step');
  m.updateVoice(2, { wavetableId: GRID_WAVETABLE_ID, position: 0.2 });
  m.setBreedParents([m.timeline[3].id, m.timeline[5].id]);
  m.updateSequence(1, { gate: 0.8, length: 12 });
  m.setTransport({ bpm: 150 });
  return m;
}

const state = (m: AppModel) => ({
  timeline: m.timeline.map((t) => ({ id: t.id, recipe: t.recipe, data: Array.from(t.data) })),
  wavetables: m.wavetables,
  voices: m.voices,
  sequences: m.sequences,
  selectedId: m.selectedId,
  breedParents: m.breedParents,
  bpm: m.bpm,
});

describe('project save / load', () => {
  it('round-trips a self-contained project through JSON', () => {
    const a = busyModel();
    const json = JSON.stringify(a.toProject(true, { k: 'v' }));
    const b = new AppModel(12);
    b.loadProject(parseProject(json));
    expect(state(b)).toEqual(state(a));
    expect(b.undoDepth).toBe(0);
    expect(b.toProject(true, { k: 'v' })).toEqual(a.toProject(true, { k: 'v' }));
  });

  it('loads with samples supplied separately, and ids keep counting', () => {
    const a = busyModel();
    const p = parseProject(JSON.stringify(a.toProject(false)));
    expect(p.tables.every((t) => t.data === undefined)).toBe(true);
    const b = new AppModel(12);
    expect(() => b.loadProject(p)).toThrow(/no sample data/);
    expect(b.timeline.length).toBe(0); // unchanged on failure
    b.loadProject(p, new Map(a.timeline.map((t) => [t.id, t.data])));
    expect(state(b)).toEqual(state(a));
    const before = a.timeline.at(-1)!.id;
    const added = b.addTables(generatePerlin(DEFAULT_PERLIN, 1, 1));
    expect(added[0].id).toBe(before + 1);
    expect(b.addVoice()!.id).toBe(Math.max(...a.voices.map((v) => v.id)) + 1);
  });

  it('rejects things that are not projects', () => {
    expect(() => parseProject('{"format":"other"}')).toThrow(/not an mkwavez project/);
    expect(() => parseProject('{"format":"mkwavez-project","version":99}')).toThrow(/version/);
    expect(() => parseProject('null')).toThrow();
  });
});
