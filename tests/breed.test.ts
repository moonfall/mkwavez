import { describe, expect, it } from 'vitest';
import { LAST_BATCH_WAVETABLE_ID } from '../src/core/wavetable';
import { AppModel } from '../src/app/model';
import {
  breed,
  breedBatch,
  breedWeights,
  BREED_OPS,
  childSeed,
  MAX_PARENTS,
  mutationAmount,
  type BiasWalk,
  type BreedMode,
  type BreedOpId,
} from '../src/core/breed';
import { KMAX } from '../src/core/constants';
import { harmonicMagnitudes, realFft } from '../src/core/fft';
import { DEFAULT_PERLIN, generateBasic, generatePerlin, renderRecipe } from '../src/core/generators';
import { shape } from '../src/core/shape';
import { describeRecipe, makeTable, type WaveTable } from '../src/core/table';

const A = makeTable(10, generatePerlin(DEFAULT_PERLIN, 4242, 1)[0]);
const B = makeTable(11, generateBasic('square', 0));
const C = makeTable(12, generatePerlin({ ...DEFAULT_PERLIN, freq: 3 }, 99, 1)[0]);
const D = makeTable(13, generateBasic('saw', 0));
const sine = makeTable(14, generateBasic('sine', 0));
const OPS = BREED_OPS.map((o) => o.id);
const WALKS: BiasWalk[] = ['path', 'ring', 'weights'];
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const run = (op: BreedOpId, parents: WaveTable[], bias: number, extra: Partial<Parameters<typeof breed>[1]> = {}) =>
  breed(
    parents.map((p) => p.data),
    { op, bias, walk: 'path', rate: 0, seed: 1234, ...extra },
  );

describe('breedWeights', () => {
  it('bias 0 is exactly parent A for every walk; weights sum to 1', () => {
    for (const walk of WALKS) {
      for (const n of [1, 2, 3, 8]) {
        expect(breedWeights(n, 0, walk, [0.2, 3, 1])).toEqual([1, ...new Array(n - 1).fill(0)]);
        for (const t of [0.1, 0.37, 0.5, 0.99, 1]) {
          const w = breedWeights(n, t, walk, [0.2, 3, 1]);
          expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
          expect(w.every((v) => v >= 0)).toBe(true);
        }
      }
    }
  });

  it('path walks A → B → C; ring returns to A; weights move toward the custom mix', () => {
    expect(breedWeights(2, 0.25, 'path')).toEqual([0.75, 0.25]);
    expect(breedWeights(3, 0.5, 'path')).toEqual([0, 1, 0]);
    expect(breedWeights(3, 0.75, 'path')).toEqual([0, 0.5, 0.5]);
    expect(breedWeights(3, 1, 'path')).toEqual([0, 0, 1]);
    expect(breedWeights(2, 0.5, 'ring')).toEqual([0, 1]);
    expect(breedWeights(3, 1, 'ring')).toEqual([1, 0, 0]);
    expect(breedWeights(3, 5 / 6, 'ring')[2]).toBeCloseTo(0.5);
    const w = breedWeights(3, 1, 'weights', [1, 1, 2]);
    expect(w).toEqual([0.25, 0.25, 0.5]);
    expect(breedWeights(2, 0.5, 'weights', [0, 0])).toEqual([0.75, 0.25]);
  });

  it('mutation amount is zero at pure parents, full at an even two-way mix', () => {
    expect(mutationAmount(0.4, [1, 0])).toBe(0);
    expect(mutationAmount(0.4, [0, 1])).toBe(0);
    expect(mutationAmount(0.4, [0.5, 0.5])).toBeCloseTo(0.4);
    expect(mutationAmount(0.4, [0.75, 0.25])).toBeCloseTo(0.2);
  });
});

describe('breed operators', () => {
  for (const op of OPS) {
    it(`${op}: bias 0 is shape(A) for any walk, parent count and mutation rate`, () => {
      for (const walk of WALKS) {
        for (const parents of [[A, B], [A, C, B, D]]) {
          const y = run(op, parents, 0, { walk, rate: 0.5, weights: [1, 2, 3, 4] });
          expect(maxDiff(y, shape(A.data)), `${op} ${walk} ${parents.length}`).toBeLessThan(1e-5);
          expect(maxDiff(y, A.data)).toBeLessThan(2e-3);
        }
      }
    });

    it(`${op}: deterministic, nonzero bias changes the table`, () => {
      const a = run(op, [A, B, C], 0.6, { rate: 0.1 });
      const b = run(op, [A, B, C], 0.6, { rate: 0.1 });
      expect(maxDiff(a, b)).toBe(0);
      expect(maxDiff(a, A.data)).toBeGreaterThan(1e-3);
      expect(a.length).toBe(A.data.length);
      expect(Math.max(...a.map(Math.abs))).toBeCloseTo(1, 5);
    });
  }

  for (const op of ['mix', 'spectral', 'split', 'genetic', 'bands', 'splice'] as BreedOpId[]) {
    it(`${op}: bias 1 of two parents is B (even with mutation)`, () => {
      expect(maxDiff(run(op, [A, B], 1, { rate: 0.5 }), B.data)).toBeLessThan(2e-3);
      expect(maxDiff(run(op, [A, B], 1, { walk: 'ring' }), A.data)).toBeLessThan(2e-3);
    });
  }

  it('seeded operators depend on the seed; mutation rate depends on the seed too', () => {
    for (const op of ['genetic', 'bands', 'splice'] as BreedOpId[]) {
      expect(maxDiff(run(op, [A, B], 0.5, { seed: 1 }), run(op, [A, B], 0.5, { seed: 2 }))).toBeGreaterThan(1e-3);
    }
    expect(maxDiff(run('mix', [A, B], 0.5, { seed: 1 }), run('mix', [A, B], 0.5, { seed: 2 }))).toBe(0);
    expect(maxDiff(run('mix', [A, B], 0.5, { seed: 1, rate: 0.2 }), run('mix', [A, B], 0.5, { seed: 2, rate: 0.2 }))).toBeGreaterThan(1e-3);
  });

  it('phase-interpolating operators sweep continuously, even through antiphase harmonics', () => {
    const tri = makeTable(21, generateBasic('tri', 0));
    const pairs: [string, WaveTable[]][] = [
      ['square→tri', [B, tri]],
      ['saw→tri', [D, tri]],
      ['saw→square', [D, B]],
      ['tri→square→saw', [tri, B, D]],
    ];
    // 1% steps per parent-to-parent segment. A crossfade's worst step here is ~0.025;
    // the old unit-phasor mean jumped ~0.7 at an even mix.
    for (const op of ['spectral', 'magsA', 'phasesA'] as BreedOpId[]) {
      for (const [name, ps] of pairs) {
        const steps = 100 * (ps.length - 1);
        let prev = run(op, ps, 0);
        let worst = 0;
        for (let i = 1; i <= steps; i++) {
          const y = run(op, ps, i / steps);
          worst = Math.max(worst, maxDiff(prev, y));
          prev = y;
        }
        expect(worst, `${op} ${name}`).toBeLessThan(0.06);
      }
    }
  });

  it('spectral mix keeps magnitudes from cancelling (saw vs its inversion)', () => {
    const inv = makeTable(20, { data: shape(D.data.map((v) => -v)), recipe: D.recipe });
    const y = run('spectral', [D, inv], 0.5);
    const m = harmonicMagnitudes(y, KMAX);
    const md = harmonicMagnitudes(D.data, KMAX);
    // Same magnitude spectrum shape as the saw (relative to the fundamental).
    for (const k of [2, 3, 5, 10]) expect(m[k] / m[1]).toBeCloseTo(md[k] / md[1], 3);
  });

  it('magsA keeps A’s magnitude spectrum; phasesA takes the others’ magnitudes', () => {
    const rel = (x: Float32Array) => {
      const m = harmonicMagnitudes(x, KMAX);
      return Array.from(m.slice(1, 20), (v) => v / m[1]);
    };
    const ma = rel(run('magsA', [A, C], 1));
    rel(A.data).forEach((v, i) => expect(ma[i]).toBeCloseTo(v, 3));
    const pa = rel(run('phasesA', [A, D], 1));
    rel(D.data).forEach((v, i) => expect(pa[i]).toBeCloseTo(v, 3));
    // A sine has no phases above the fundamental: the donor's phases are used, so a
    // sine with a saw's magnitudes is a saw.
    expect(maxDiff(run('phasesA', [sine, D], 1), D.data)).toBeLessThan(2e-3);
  });

  it('envelope transfer cannot add harmonics A lacks', () => {
    const y = run('envelope', [sine, D], 1);
    expect(maxDiff(y, sine.data)).toBeLessThan(2e-3);
    // …but reshapes the ones A has.
    const z = run('envelope', [D, A], 1);
    expect(maxDiff(z, D.data)).toBeGreaterThan(1e-2);
  });

  it('split at 50%: harmonics 1–8 from A, 9+ from B (same complex values up to one gain)', () => {
    const y = realFft(run('split', [A, C], 0.5));
    const a = realFft(A.data);
    const c = realFft(C.data);
    // Fundamentals have sine phase (re ≈ 0), so take the gain from the imaginary part.
    const g = y.im[1] / a.im[1];
    const tol = 1e-5 * Math.abs(y.im[1]);
    for (let k = 1; k <= 20; k++) {
      const src = k <= 8 ? a : c;
      expect(Math.abs(y.re[k] - g * src.re[k])).toBeLessThan(tol);
      expect(Math.abs(y.im[k] - g * src.im[k])).toBeLessThan(tol);
    }
  });

  it('genetic: a one-seed bias sweep hands harmonics over monotonically', () => {
    // B is a square (no even harmonics): an even harmonic taken from B is ~0.
    const fromB = (x: Float32Array) => {
      const y = realFft(x);
      const ref = Math.hypot(y.re[1], y.im[1]);
      const s = new Set<number>();
      for (let k = 2; k <= KMAX; k += 2) if (Math.hypot(y.re[k], y.im[k]) < 1e-6 * ref) s.add(k);
      return s;
    };
    let prev = new Set<number>();
    for (const t of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      const cur = fromB(run('genetic', [A, B], t));
      for (const k of prev) expect(cur.has(k), `harmonic ${k} at ${t}`).toBe(true);
      prev = cur;
    }
    expect(prev.size).toBe(KMAX / 2);
  });
});

describe('breedBatch and recipes', () => {
  const parents = [A, B, C];

  function realize(gen: ReturnType<typeof breedBatch>) {
    const tables = gen.map((g, i) => makeTable(100 + i, g));
    const all = new Map<number, Float32Array>([A, B, C, D].map((t) => [t.id, t.data]));
    return { tables, resolve: (id: number) => all.get(id) };
  }

  it('single records operator, params, seed and all parent ids', () => {
    const [t] = breedBatch({ op: 'genetic', bias: 0.4, walk: 'path', rate: 0.1, seed: 77, mode: 'single', count: 8 }, parents);
    expect(same(t.data, breed([A.data, B.data, C.data], { op: 'genetic', bias: 0.4, walk: 'path', rate: 0.1, seed: 77 }))).toBe(true);
    expect(t.recipe).toEqual({
      op: 'breed',
      params: { breed: 'genetic', bias: 0.4, batchBias: 0.4, mode: 'single', walk: 'path', weights: '', rate: 0.1 },
      seed: 77,
      parents: [10, 11, 12],
      batch: { index: 0, count: 1 },
    });
    expect(describeRecipe(t.recipe)).toBe('Genetic (harmonics) 40% of id 10×11×12');
  });

  it('sweep: biases B·(i+1)/N with one seed, last equals the preview', () => {
    const out = breedBatch({ op: 'splice', bias: 0.8, walk: 'ring', rate: 0, seed: 5, mode: 'sweep', count: 4 }, parents);
    [0.2, 0.4, 0.6, 0.8].forEach((b, i) => expect(out[i].recipe.params.bias).toBeCloseTo(b, 12));
    expect(out.every((t) => t.recipe.seed === 5)).toBe(true);
    const [pv] = breedBatch({ op: 'splice', bias: 0.8, walk: 'ring', rate: 0, seed: 5, mode: 'single', count: 1 }, parents);
    expect(same(out[3].data, pv.data)).toBe(true);
  });

  it('generation: N children at one bias with derived seeds; child 0 equals the preview', () => {
    const out = breedBatch({ op: 'bands', bias: 0.5, walk: 'path', rate: 0.05, seed: 9, mode: 'gen', count: 4 }, [A, B]);
    const [pv] = breedBatch({ op: 'bands', bias: 0.5, walk: 'path', rate: 0.05, seed: 9, mode: 'single', count: 1 }, [A, B]);
    expect(same(out[0].data, pv.data)).toBe(true);
    expect(childSeed(9, 0)).toBe(9);
    expect(out.every((t) => t.recipe.params.bias === 0.5 && t.recipe.seed === 9)).toBe(true);
    for (let i = 1; i < 4; i++) expect(maxDiff(out[i].data, out[0].data)).toBeGreaterThan(1e-4);
  });

  for (const mode of ['single', 'sweep', 'gen'] as BreedMode[]) {
    it(`re-rendering from the recipe reproduces every child (${mode}, all operators and walks)`, () => {
      for (const op of OPS) {
        for (const walk of WALKS) {
          const gen = breedBatch({ op, bias: 0.7, walk, weights: [0.5, 2, 1], rate: 0.1, seed: 4321, mode, count: 3 }, parents);
          const { tables, resolve } = realize(gen);
          for (const t of tables) {
            expect(same(t.data, renderRecipe(t.recipe, { resolveTable: resolve })), `${op} ${walk} ${mode} #${t.recipe.batch?.index}`).toBe(true);
          }
        }
      }
    });
  }

  it('custom weights are recorded per parent', () => {
    const [t] = breedBatch({ op: 'mix', bias: 1, walk: 'weights', weights: [0.25, 1], rate: 0, seed: 1, mode: 'single', count: 1 }, parents);
    expect(t.recipe.params.weights).toBe('0.25,1,1');
  });

  it('re-render needs every parent', () => {
    const [t] = breedBatch({ op: 'mix', bias: 0.5, walk: 'path', rate: 0, seed: 1, mode: 'single', count: 1 }, parents);
    expect(() => renderRecipe(t.recipe)).toThrow();
    expect(() => renderRecipe(t.recipe, { resolveTable: (id) => (id === 12 ? undefined : A.data) })).toThrow();
  });
});

describe('AppModel breed parents', () => {
  function model(cap = 16) {
    const m = new AppModel(cap);
    for (const w of ['sine', 'tri', 'saw', 'square'] as const) m.addTables([generateBasic(w, 0)]);
    // Follows batches: plays the built-in Last batch.
    const target = m.addVoice({ wavetableId: LAST_BATCH_WAVETABLE_ID })!;
    m.clearUndo();
    return { m, target };
  }

  it('toggle, move, dedupe and cap', () => {
    const { m } = model();
    const ids = m.timeline.map((t) => t.id);
    let events = 0;
    m.on('parents', () => events++);
    m.toggleBreedParent(ids[2]);
    m.toggleBreedParent(ids[0]);
    expect(m.breedParents).toEqual([ids[2], ids[0]]);
    m.moveBreedParent(ids[0], -1);
    expect(m.breedParents).toEqual([ids[0], ids[2]]);
    m.toggleBreedParent(ids[0]);
    expect(m.breedParents).toEqual([ids[2]]);
    expect(m.toggleBreedParent(9999)).toBe(false);
    m.setBreedParents([ids[1], ids[1], 9999, ids[3]]);
    expect(m.breedParents).toEqual([ids[1], ids[3]]);
    expect(events).toBe(5);
    for (let i = 0; i < 10; i++) m.addTables([generateBasic('saw', 0)]);
    m.setBreedParents(m.timeline.map((t) => t.id));
    expect(m.breedParents.length).toBe(MAX_PARENTS);
    expect(m.toggleBreedParent(m.timeline.at(-1)!.id)).toBe(false);
  });

  it('evicted or undone parents drop out of the list', () => {
    const { m } = model(70); // > 64: the Grid pins the latest 64 tables
    const first = m.timeline[0].id;
    m.setBreedParents([first, m.timeline[1].id]);
    let events = 0;
    m.on('parents', () => events++);
    m.addTables(Array.from({ length: 67 }, () => generateBasic('saw', 0)));
    expect(m.table(first)).toBeUndefined();
    expect(m.breedParents).toEqual([m.timeline[0].id]);
    expect(events).toBe(1);
    const newest = m.timeline.at(-1)!.id;
    m.toggleBreedParent(newest);
    m.undo();
    expect(m.breedParents).not.toContain(newest);
  });

  it('Breed N becomes the Last batch (a voice on it plays it) and records parents; undo reverts', () => {
    const { m, target } = model();
    const ps = [m.timeline[0], m.timeline[3]];
    m.addTables(breedBatch({ op: 'spectral', bias: 1, walk: 'path', rate: 0, seed: 3, mode: 'sweep', count: 4 }, ps), false);
    expect(m.timeline.length).toBe(8);
    expect([m.voice(target.id)!.windowStart, m.voice(target.id)!.windowEnd]).toEqual([0, 3]);
    expect(m.windowTables(m.voice(target.id)!).map((t) => t.id)).toEqual(m.timeline.slice(4).map((t) => t.id));
    expect(m.timeline.slice(4).every((t) => t.recipe.parents.join() === ps.map((p) => p.id).join())).toBe(true);
    for (const t of m.timeline.slice(4)) {
      expect(same(t.data, renderRecipe(t.recipe, { resolveTable: (id) => m.table(id)?.data }))).toBe(true);
    }
    m.undo();
    expect(m.timeline.length).toBe(4);
    expect([m.voice(target.id)!.windowStart, m.voice(target.id)!.windowEnd]).toEqual([0, 0]);
  });
});
