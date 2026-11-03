import { describe, expect, it } from 'vitest';
import { TABLE_SIZE } from '../src/core/constants';
import {
  DYN_MAPS,
  PARAM_MODES,
  renderRecipe,
  seedBatch,
  seedEntry,
  seedParams,
  seedTable,
  type SeedRequest,
} from '../src/core/generators';
import { describeRecipe } from '../src/core/table';

const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const maxDiff = (a: Float32Array, b: Float32Array) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
const req = (id: string, params: Record<string, number> = {}, count = 4, seed = 99): SeedRequest => {
  const entry = seedEntry(id)!;
  return { entry, expr: '', params, seed, count };
};

describe('parameter modes', () => {
  it('every mode is in the library, re-renders exactly and varies across a batch', () => {
    for (const m of PARAM_MODES) {
      const e = seedEntry(m.id);
      expect(e, m.id).toBeDefined();
      expect(e!.mode).toBe(m.mode);
      const b = seedBatch(req(m.id, {}, 5));
      b.forEach((t) => {
        expect(t.data.length).toBe(TABLE_SIZE);
        expect(t.data.every(Number.isFinite), m.id).toBe(true);
        expect(t.recipe.op).toBe(m.mode);
        expect(same(t.data, renderRecipe(t.recipe)), m.id).toBe(true);
        expect(describeRecipe(t.recipe)).toContain(m.name);
      });
      expect(maxDiff(b[0].data, b[4].data), `${m.id}: +N varies`).toBeGreaterThan(1e-3);
      // Every param is recorded, so the recipe is complete.
      for (const p of m.params) expect(b[0].recipe.params[p.key], `${m.id}.${p.key}`).toBe(seedParams(e!)[p.key]);
    }
  });

  it('dynamical systems: every map is finite; the control sweep changes the waveform', () => {
    DYN_MAPS.forEach((_, map) => {
      const b = seedBatch(req('dynamical-systems', { map, iterations: 40, control: 0, controlEnd: 1 }, 3));
      for (const t of b) expect(t.data.every(Number.isFinite), `map ${map}`).toBe(true);
      expect(maxDiff(b[0].data, b[2].data), `map ${map}`).toBeGreaterThan(1e-3);
    });
    const a = seedTable(req('dynamical-systems', {}, 1, 1), 0).data;
    expect(same(a, seedTable(req('dynamical-systems', {}, 1, 2), 0).data)).toBe(true);
  });

  it('Karplus-Strong: the string darkens over the batch; noise is seeded, the pluck shape is not', () => {
    const hf = (x: Float32Array) => {
      let s = 0;
      for (let i = 1; i < x.length; i++) s += Math.abs(x[i] - x[i - 1]);
      return s;
    };
    const b = seedBatch(req('karplus-strong', {}, 6));
    expect(hf(b[5].data)).toBeLessThan(hf(b[0].data));
    const t = (excite: number, seed: number) => seedTable(req('karplus-strong', { excite }, 3, seed), 1).data;
    expect(same(t(0, 1), t(0, 2))).toBe(false);
    expect(same(t(1, 1), t(1, 2))).toBe(true);
    // Snapshot i of a batch = the string after start + i·passes, whatever the batch size.
    const s = seedTable(req('karplus-strong', { start: 12, passes: 6 }, 8), 0).data;
    expect(same(s, seedTable(req('karplus-strong', { start: 6, passes: 6 }, 3), 1).data)).toBe(true);
  });
});
