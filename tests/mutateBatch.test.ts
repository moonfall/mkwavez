import { describe, expect, it } from 'vitest';
import { LAST_BATCH_WAVETABLE_ID } from '../src/core/wavetable';
import { AppModel } from '../src/app/model';
import { DEFAULT_PERLIN, generateBasic, generatePerlin, renderRecipe } from '../src/core/generators';
import { chainStepSeed, mutateBatch, mutateBatchTable, pickMateIndex, type MutateMode } from '../src/core/mutateBatch';
import { mutate, MUTATIONS } from '../src/core/mutations';
import { makeTable, type WaveTable } from '../src/core/table';

const src = makeTable(10, generatePerlin(DEFAULT_PERLIN, 4242, 1)[0]);
const mate = makeTable(11, generateBasic('square', 0));
const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Assign ids the way AppModel does and return a resolver over source + outputs. */
function realize(gen: ReturnType<typeof mutateBatch>, firstId = 100): { tables: WaveTable[]; resolve: (id: number) => Float32Array | undefined } {
  const tables = gen.map((g, i) => makeTable(firstId + i, g));
  const all = new Map<number, Float32Array>([src, mate, ...tables].map((t) => [t.id, t.data]));
  return { tables, resolve: (id) => all.get(id) };
}

describe('mutateBatch', () => {
  it('single: one table, same as the preview computation, recipe records everything', () => {
    const [t] = mutateBatch({ mutation: 'jitter', amount: 0.4, seed: 77, mode: 'single', count: 8 }, src);
    expect(same(t.data, mutate('jitter', src.data, 0.4, 77))).toBe(true);
    expect(t.recipe).toEqual({
      op: 'mutate',
      params: { mutation: 'jitter', amount: 0.4, batchAmount: 0.4, mode: 'single' },
      seed: 77,
      parents: [10],
      batch: { index: 0, count: 1 },
    });
  });

  it('linear sweep uses A·i/N with one shared seed; last table equals the preview', () => {
    const out = mutateBatch({ mutation: 'scramble', amount: 0.8, seed: 5, mode: 'lin', count: 4 }, src);
    [0.2, 0.4, 0.6, 0.8].forEach((a, i) => expect(out[i].recipe.params.amount).toBeCloseTo(a, 12));
    expect(out.every((t) => t.recipe.seed === 5)).toBe(true);
    expect(same(out[3].data, mutate('scramble', src.data, 0.8, 5))).toBe(true);
  });

  it('log sweep uses A·64^((i−N)/(N−1))', () => {
    const out = mutateBatch({ mutation: 'fold', amount: 0.64, seed: 1, mode: 'log', count: 4 }, src);
    const amts = out.map((t) => Number(t.recipe.params.amount));
    for (let i = 1; i <= 4; i++) expect(amts[i - 1]).toBeCloseTo(0.64 * Math.pow(64, (i - 4) / 3), 12);
    expect(amts[0]).toBeCloseTo(0.01);
  });

  it('chain compounds: step 0 is the preview, each step mutates the previous at A', () => {
    const out = mutateBatch({ mutation: 'ring', amount: 0.3, seed: 9, mode: 'chain', count: 3 }, src);
    expect(same(out[0].data, mutate('ring', src.data, 0.3, 9))).toBe(true);
    expect(same(out[1].data, mutate('ring', out[0].data, 0.3, chainStepSeed(9, 1)))).toBe(true);
    expect(same(out[2].data, mutate('ring', out[1].data, 0.3, chainStepSeed(9, 2)))).toBe(true);
    expect(out.every((t) => t.recipe.params.amount === 0.3 && t.recipe.parents[0] === 10)).toBe(true);
  });

  it('breed records the mate as second parent; mate pick is seeded', () => {
    const [t] = mutateBatch({ mutation: 'breed', amount: 0.5, seed: 3, mode: 'single', count: 1 }, src, mate);
    expect(t.recipe.parents).toEqual([10, 11]);
    expect(same(t.data, mutate('breed', src.data, 0.5, 3, { breedPool: [mate.data] }))).toBe(true);
    expect(pickMateIndex(3, 5)).toBe(pickMateIndex(3, 5));
    expect(pickMateIndex(3, 0)).toBe(-1);
  });

  for (const mode of ['single', 'lin', 'log', 'chain'] as MutateMode[]) {
    it(`re-rendering from the recipe reproduces every table (${mode}, all mutations)`, () => {
      for (const m of MUTATIONS) {
        const gen = mutateBatch({ mutation: m.id, amount: 0.55, seed: 1234, mode, count: 3 }, src, mate);
        const { tables, resolve } = realize(gen);
        for (const t of tables) {
          expect(same(t.data, renderRecipe(t.recipe, { resolveTable: resolve })), `${m.id} ${mode} #${t.recipe.batch?.index}`).toBe(true);
        }
      }
    });
  }

  for (const mode of ['lin', 'log', 'chain'] as MutateMode[]) {
    it(`mutateBatchTable (the preview) equals mutateBatch (Add batch) table by table (${mode})`, () => {
      for (const m of ['fold', 'jitter', 'formant', 'smooth'] as const) {
        const req = { mutation: m, amount: 0.7, seed: 99, mode, count: 6 };
        const batch = mutateBatch(req, src);
        // Sweeps can compute in any order (shown card first); a chain goes in order.
        const order = mode === 'chain' ? [0, 1, 2, 3, 4, 5] : [5, 2, 0, 4, 1, 3];
        const pv: Float32Array[] = [];
        for (const i of order) {
          const t = mutateBatchTable(req, src, i, pv[i - 1]);
          pv[i] = t.data;
          expect(same(t.data, batch[i].data), `${m} #${i}`).toBe(true);
          expect(t.recipe).toEqual(batch[i].recipe);
        }
      }
    });
  }

  it('Add shown: one table of a batch keeps its batch position and re-renders alone', () => {
    for (const mode of ['lin', 'log', 'chain'] as MutateMode[]) {
      const req = { mutation: 'scramble' as const, amount: 0.5, seed: 4, mode, count: 8 };
      const batch = mutateBatch(req, src);
      const { tables, resolve } = realize([batch[5]]);
      expect(tables[0].recipe.batch).toEqual({ index: 5, count: 8 });
      expect(same(renderRecipe(tables[0].recipe, { resolveTable: resolve }), batch[5].data), mode).toBe(true);
    }
    // Last card of a sweep = a single Apply at A.
    const [single] = mutateBatch({ mutation: 'fold', amount: 0.4, seed: 4, mode: 'single', count: 1 }, src);
    const lin = mutateBatch({ mutation: 'fold', amount: 0.4, seed: 4, mode: 'lin', count: 8 }, src);
    expect(same(single.data, lin[7].data)).toBe(true);
  });

  it('chain steps need the previous table', () => {
    expect(() => mutateBatchTable({ mutation: 'fold', amount: 0.4, seed: 1, mode: 'chain', count: 3 }, src, 2)).toThrow();
  });

  it('re-render needs the parent', () => {
    const [t] = mutateBatch({ mutation: 'fold', amount: 0.5, seed: 1, mode: 'single', count: 1 }, src);
    expect(() => renderRecipe(t.recipe)).toThrow();
    expect(() => renderRecipe(t.recipe, { resolveTable: () => undefined })).toThrow();
  });
});

describe('AppModel with mutation batches', () => {
  function model() {
    const m = new AppModel(16);
    for (const w of ['sine', 'tri', 'saw'] as const) m.addTables([generateBasic(w, 0)]);
    const follow = m.addVoice({ windowStart: 0, windowEnd: 2 })!;
    const target = m.addVoice({ wavetableId: LAST_BATCH_WAVETABLE_ID })!;
    m.clearUndo();
    return { m, follow, target };
  }

  it('single Apply follows windows; Apply N becomes the Last batch; undo reverts both', () => {
    const { m, follow, target } = model();
    const source = m.timeline[1];
    m.addTables(mutateBatch({ mutation: 'fold', amount: 0.5, seed: 1, mode: 'single', count: 1 }, source));
    expect(m.voice(follow.id)!.windowEnd).toBe(3);
    expect(m.timeline[3].recipe.parents).toEqual([source.id]);
    m.addTables(mutateBatch({ mutation: 'fold', amount: 0.5, seed: 2, mode: 'chain', count: 4 }, source), false);
    expect(m.timeline.length).toBe(8);
    expect([m.voice(target.id)!.windowStart, m.voice(target.id)!.windowEnd]).toEqual([0, 3]);
    expect(m.windowTables(m.voice(target.id)!)[0]).toBe(m.timeline[4]);
    expect(m.voice(follow.id)!.windowEnd).toBe(7);
    expect(m.selectedId).toBe(m.timeline[3].id);
    m.undo();
    expect(m.timeline.length).toBe(4);
    expect([m.voice(target.id)!.windowStart, m.voice(target.id)!.windowEnd]).toEqual([0, 0]);
    m.undo();
    expect(m.timeline.length).toBe(3);
    expect(m.voice(follow.id)!.windowEnd).toBe(2);
  });

  it('timeline tables re-render from their recipes via the model', () => {
    const { m } = model();
    m.addTables(mutateBatch({ mutation: 'nwarp', amount: 0.7, seed: 42, mode: 'log', count: 5 }, m.timeline[2]));
    for (const t of m.timeline.slice(3)) {
      expect(same(t.data, renderRecipe(t.recipe, { resolveTable: (id) => m.table(id)?.data }))).toBe(true);
    }
  });
});
