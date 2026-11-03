import { describe, expect, it } from 'vitest';
import { TABLE_SIZE } from '../src/core/constants';
import {
  additiveAmps,
  DEFAULT_ADDITIVE,
  DEFAULT_LIFE,
  DEFAULT_RD,
  lifeBoard,
  lifeLine,
  parseRule,
  DEFAULT_SEQUENCE,
  rdState,
  DYN_MAPS,
  euclid,
  sequenceValues,
  splinePoints,
  DEFAULT_SPLINE,
  type SequenceParams,
  PARAM_MODES,
  RESERVED_OPS,
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

  it('additive designer: slope, balance, formants and phase modes', () => {
    const amps = (params: Record<string, number>, i = 0, n = 1) =>
      additiveAmps({ ...DEFAULT_ADDITIVE, g1: 0, g2: 0, g3: 0, ...params }, i, n);
    const saw = amps({ slope: 1 });
    expect(saw[4] / saw[1]).toBeCloseTo(0.25);
    const odd = amps({ balance: 1 });
    expect(odd[2]).toBe(0);
    expect(odd[3]).toBeGreaterThan(0);
    const f = amps({ slope: 0, g1: 4, f1: 10, w1: 1 });
    expect(f[10]).toBeCloseTo(5);
    // The formant moves an octave up by the end of the batch.
    const moved = amps({ slope: 0, slopeEnd: 0, g1: 4, f1: 10, w1: 1, shift: 1 }, 2, 3);
    expect(moved[20]).toBeCloseTo(5);
    const phase = (ph: number, seed: number) => seedTable(req('additive-designer', { phase: ph }, 1, seed), 0).data;
    expect(same(phase(2, 1), phase(2, 2))).toBe(false);
    expect(same(phase(1, 1), phase(1, 2))).toBe(true);
    expect(maxDiff(phase(0, 1), phase(1, 1))).toBeGreaterThan(0.01);
  });

  it('number sequences: π / e digits, Collatz, prime gaps, Euclidean', () => {
    const v = (params: Partial<SequenceParams>, i = 0) => sequenceValues({ ...DEFAULT_SEQUENCE, ...params }, i);
    expect(v({ source: 0, steps: 8 }).join('')).toBe('31415926');
    expect(v({ source: 0, steps: 4 }, 2).join('')).toBe('4159');
    expect(v({ source: 1, steps: 8 }).join('')).toBe('27182818');
    expect(v({ source: 3, steps: 6 })).toEqual([1, 2, 2, 4, 2, 4]);
    expect(v({ source: 2, steps: 4, offset: 0 }).map((x) => Math.round(2 ** x))).toEqual([27, 82, 41, 124]);
    expect(v({ source: 4, steps: 8, pulses: 3 }).reduce((s, x) => s + x, 0)).toBe(3);
    expect(v({ source: 4, steps: 8, pulses: 3 }, 2).reduce((s, x) => s + x, 0)).toBe(5);
    expect(euclid(5, 16).reduce((s, x) => s + x, 0)).toBe(5);
  });

  it('reaction-diffusion: checkpointed stepping equals stepping from scratch; seeded', () => {
    const p = { ...DEFAULT_RD, cells: 64 };
    rdState({ ...p, spots: 2 }, 3, 0); // a different simulation: the cache starts afresh
    rdState(p, 3, 300);
    const viaCheckpoint = rdState(p, 3, 700).slice(); // continues from step 300
    rdState({ ...p, spots: 2 }, 3, 0);
    const fresh = rdState(p, 3, 700); // from step 0
    expect(Array.from(viaCheckpoint)).toEqual(Array.from(fresh));
    const t = (seed: number) => seedTable(req('reaction-diffusion', {}, 2, seed), 1).data;
    expect(same(t(1), t(2))).toBe(false);
  });

  it('registry: modes never reuse another op; old recipes missing a param use its default', () => {
    const modes = PARAM_MODES.map((m) => m.mode);
    expect(new Set(modes).size).toBe(modes.length);
    for (const m of modes) expect(RESERVED_OPS.includes(m), m).toBe(false);
    const t = seedTable(req('karplus-strong', {}, 3), 1);
    const { position: _drop, ...older } = t.recipe.params;
    expect(same(renderRecipe({ ...t.recipe, params: older }), t.data)).toBe(true);
  });

  it('no silent tables: late Karplus-Strong snapshots, a sine map settling on a fixed point', () => {
    const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const late = seedTable(req('karplus-strong', { damping: 1, passes: 64, start: 256 }, 64), 63).data;
    expect(peak(late)).toBeCloseTo(1, 5);
    const sine = seedTable(req('dynamical-systems', { map: 1, control: 0, controlEnd: 0, iterations: 64 }, 1), 0).data;
    expect(peak(sine)).toBeCloseTo(1, 5);
  });

  it('Life-like: B/S rules step a glider; generations are reproducible from any checkpoint', () => {
    const life = parseRule('B3/S23');
    expect(life.birth[3] && life.survive[2] && life.survive[3] && !life.birth[2]).toBe(true);
    const p = { ...DEFAULT_LIFE, size: 16 };
    const g10 = lifeBoard(p, 5, 10).slice();
    lifeBoard({ ...p, size: 12 }, 5, 0); // another board: the cache starts afresh
    lifeBoard(p, 5, 4);
    expect(Array.from(lifeBoard(p, 5, 10))).toEqual(Array.from(g10));
    // Uniform lines fall back to a non-uniform one.
    const board = new Uint8Array(64);
    board[8 * 2 + 3] = 1;
    expect(lifeLine(board, 8, 0).some((v) => v)).toBe(true);
  });

  it('spline: jitter sweep moves the points; adding points keeps the earlier ones', () => {
    const sweep = (i: number) => splinePoints({ ...DEFAULT_SPLINE, jitter: 0, jitterEnd: 1 }, 4, i, 3);
    expect(sweep(0)).not.toEqual(sweep(2));
    const add = (i: number) => splinePoints({ ...DEFAULT_SPLINE, batch: 1 }, 4, i, 4);
    expect(add(3).length).toBe(add(0).length + 3);
    expect(add(3).slice(0, add(0).length)).toEqual(add(0));
    for (const kind of [0, 1]) {
      const t = seedTable(req('spline', { kind, tension: 0.5 }, 3), 1).data;
      expect(t.every(Number.isFinite)).toBe(true);
    }
  });
});
