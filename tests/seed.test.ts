import { describe, expect, it } from 'vitest';
import { compileFormula } from '../src/browser/formulaEval';
import { TABLE_SIZE } from '../src/core/constants';
import {
  FormulaAborted,
  FormulaError,
  FORMULA_PRESETS,
  generateBasic,
  renderRecipe,
  SEED_LIBRARY,
  seedBatch,
  seedEntry,
  seedParams,
  seedTable,
  DEFAULT_PERLIN,
  perlinAt,
  seedUsesRandomness,
  type SeedEntry,
  type SeedRequest,
} from '../src/core/generators';
import { describeRecipe } from '../src/core/table';

const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const fnFor = (r: SeedRequest) => (r.entry.mode === 'formula' ? compileFormula(r.expr) : undefined);
const req = (entry: SeedEntry, over: Partial<SeedRequest> = {}): SeedRequest => ({
  entry,
  expr: entry.expr ?? '',
  params: {},
  seed: 0xdeadbeef,
  count: 5,
  ...over,
});

describe('Seed library', () => {
  it('has unique ids, every formula preset, and the parameter modes', () => {
    const ids = SEED_LIBRARY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Every formula preset is in the library: as a formula, or re-made as a parameter-mode variant (same id).
    for (const p of FORMULA_PRESETS)
      expect(SEED_LIBRARY.some((e) => (e.mode === 'formula' && e.expr === p.expr) || (e.formula === p.expr && e.name === p.name && e.cat === p.group)), p.name).toBe(true);
    for (const m of ['basic', 'pulse', 'perlin', 'ca'] as const) expect(SEED_LIBRARY.some((e) => e.mode === m)).toBe(true);
    expect(SEED_LIBRARY.at(-1)!.cat).toBe('Custom');
  });

  it('every entry renders N shaped tables whose recipes re-render them exactly', () => {
    for (const entry of SEED_LIBRARY) {
      const r = req(entry);
      const tables = seedBatch(r, fnFor(r));
      expect(tables.length).toBe(5);
      tables.forEach((t, i) => {
        expect(t.data.length).toBe(TABLE_SIZE);
        expect(t.data.every(Number.isFinite), entry.id).toBe(true);
        expect(t.recipe.params.preset).toBe(entry.id);
        expect(t.recipe.batch).toEqual({ index: i, count: 5 });
        expect(t.recipe.seed).toBe(0xdeadbeef);
        expect(same(t.data, renderRecipe(t.recipe, { compileFormula })), entry.id).toBe(true);
        expect(same(t.data, seedTable(r, i, fnFor(r)).data), `${entry.id} single table = batch table`).toBe(true);
        expect(describeRecipe(t.recipe).length).toBeGreaterThan(0);
      });
    }
  });

  it('no waveform of any default batch is silent (N = 8, a few seeds)', () => {
    for (const entry of SEED_LIBRARY)
      for (const seed of [24301, 1, 0xdeadbeef]) {
        const r = req(entry, { seed, count: 8 });
        seedBatch(r, fnFor(r)).forEach((t, i) => expect(Math.max(...Array.from(t.data, Math.abs)), `${entry.id} seed ${seed} #${i}`).toBeGreaterThan(0.5));
      }
  });

  it('Superformula read from the centre: the default sweep never passes the circle (n2 = n3 = 2, silent)', () => {
    const e = seedEntry('superformula')!;
    const r = req(e, { count: 8, params: { offset: 0 } });
    for (const t of seedBatch(r)) expect(Math.max(...Array.from(t.data, Math.abs))).toBeGreaterThan(0.5);
    // The circle itself is silent from the centre (why the sweep starts at 3).
    const [circle] = seedBatch(req(e, { count: 1, params: { offset: 0, n2: 2, n2End: 2, n3: 2, n3End: 2 } }));
    expect(Math.max(...Array.from(circle.data, Math.abs))).toBe(0);
  });

  it('edited formulas and changed params are recorded and re-render', () => {
    const harm = seedEntry('harmonics')!;
    const r = req(harm, { expr: 'sin((n+2)*p)*0.9', count: 4 });
    const t = seedBatch(r, fnFor(r));
    expect(t[2].recipe.params).toMatchObject({ expr: r.expr, edited: true, name: 'Harmonics' });
    t.forEach((x) => expect(same(x.data, renderRecipe(x.recipe, { compileFormula }))).toBe(true));

    const cases: [string, Record<string, number>][] = [
      ['pulse', { width: 0.4, widthEnd: 0.1 }],
      ['perlin-noise', { freq: 3.5, z: 2, zDrift: 0.5, octaves: 6, persistence: 0.7 }],
      ['cellular-automaton', { rule: 110, cells: 24, start: 7 }],
    ];
    for (const [id, params] of cases) {
      const e = seedEntry(id)!;
      const b = seedBatch(req(e, { params, count: 3 }));
      b.forEach((x) => {
        expect(x.recipe.params).toMatchObject(params);
        expect(same(x.data, renderRecipe(x.recipe))).toBe(true);
      });
      expect(same(b[1].data, seedTable(req(e, { count: 3 }), 1).data), `${id}: params matter`).toBe(false);
    }
    const ca = seedBatch(req(seedEntry('cellular-automaton')!, { params: { start: 7 }, count: 3 }));
    expect(ca.map((x) => x.recipe.params.generation)).toEqual([7, 8, 9]);
  });

  it('Perlin noise sweeps frequency / octaves / persistence; recipes from before the batch ends don’t sweep', () => {
    const e = seedEntry('perlin-noise')!;
    const b = seedBatch(req(e, { params: { zDrift: 0, freq: 1, freqEnd: 6 }, count: 3 }));
    expect(same(b[0].data, b[2].data)).toBe(false);
    expect(b[2].recipe.params).toMatchObject({ freq: 1, freqEnd: 6, octavesEnd: 4 });
    // Octaves sweep in whole octaves.
    expect([0, 1, 2, 3].map((i) => perlinAt({ ...DEFAULT_PERLIN, octaves: 1, octavesEnd: 4 }, i, 4).octaves)).toEqual([1, 2, 3, 4]);
    // An old recipe (no ends) renders with its start values for every table.
    const old = { op: 'perlin', params: { freq: 3, z: 0, zDrift: 0, octaves: 5, persistence: 0.6, preset: 'perlin-noise' }, seed: 9, parents: [], batch: { index: 2, count: 3 } };
    expect(same(renderRecipe(old), seedTable(req(e, { params: { freq: 3, freqEnd: 3, zDrift: 0, octaves: 5, octavesEnd: 5, persistence: 0.6, persistenceEnd: 0.6 }, seed: 9, count: 3 }), 2).data)).toBe(true);
    // The Perlin presets are its starting points.
    for (const id of ['drift', 'zoom', 'add-octaves', 'roughen']) expect(seedEntry(id)).toMatchObject({ mode: 'perlin', family: 'Perlin noise', cat: 'Perlin' });
  });

  it('pulse widths sweep across the batch; basic waves match the additive generators', () => {
    const pulse = seedBatch(req(seedEntry('pulse')!, { params: { width: 0.5, widthEnd: 0.1 }, count: 3 }));
    expect(same(pulse[0].data, pulse[2].data)).toBe(false);
    expect(same(seedTable(req(seedEntry('saw')!), 0).data, generateBasic('saw', 0).data)).toBe(true);
  });

  it('the seed matters exactly when the mode uses randomness', () => {
    for (const entry of SEED_LIBRARY) {
      const a = req(entry, { seed: 1, count: 3 });
      const b = req(entry, { seed: 2, count: 3 });
      const differs = !same(seedTable(a, 1, fnFor(a)).data, seedTable(b, 1, fnFor(b)).data);
      expect(differs, entry.id).toBe(seedUsesRandomness(entry));
    }
    expect(seedUsesRandomness(seedEntry('blank-formula')!, 'pnoise(2, 0, 4, 0.5)')).toBe(true);
  });

  it('basic-wave "as formula" expressions match the additive generators closely', () => {
    for (const e of SEED_LIBRARY.filter((x) => x.mode === 'basic')) {
      const f = seedTable(req(seedEntry('blank-formula')!, { expr: e.asFormula!, count: 1 }), 0, compileFormula(e.asFormula!));
      const b = seedTable(req(e, { count: 1 }), 0);
      let err = 0;
      for (let i = 0; i < TABLE_SIZE; i++) err = Math.max(err, Math.abs(f.data[i] - b.data[i]));
      expect(err, e.id).toBeLessThan(1e-4);
    }
  });

  it('a runaway formula can be aborted; errors are per table', () => {
    const blank = seedEntry('blank-formula')!;
    const r = req(blank, { expr: 'sin(p)/u', count: 3 });
    const fn = compileFormula(r.expr);
    expect(() => seedTable(r, 0, fn)).toThrow(FormulaError); // u = 0 → non-finite
    expect(seedTable(r, 1, fn).data.every(Number.isFinite)).toBe(true);
    let calls = 0;
    expect(() => seedTable(r, 1, fn, () => ++calls > 3)).toThrow(FormulaAborted);
    expect(calls).toBe(4);
  });

  it('seedParams merges overrides into defaults', () => {
    expect(seedParams(seedEntry('cellular-automaton')!, { cells: 16 })).toEqual({ rule: 30, cells: 16, start: 0 });
  });
});
