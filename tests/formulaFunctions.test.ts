import { describe, expect, it } from 'vitest';
import { compileFormula } from '../src/browser/formulaEval';
import { KMAX, TABLE_SIZE } from '../src/core/constants';
import {
  basicWave,
  pulse,
  renderRecipe,
  SEED_LIBRARY,
  seedBatch,
  seedEntry,
  seedFormulaExpr,
  seedParams,
  sourceExpr,
  waveFunctions,
  WAVE_FUNCTION_DOCS,
  WAVE_FUNCTION_NAMES,
  type ExprSource,
  type SeedEntry,
  type SeedRequest,
} from '../src/core/generators';
import type { ParamValue } from '../src/core/table';

const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const blank = seedEntry('blank-formula')!;
/** The formula `expr` rendered as a batch (through the Blank formula entry, as the UI does). */
const formulaBatch = (expr: string, seed: number, count: number) =>
  seedBatch({ entry: blank, expr, params: {}, seed, count }, compileFormula(expr)).map((t) => t.data);
const fnFor = (r: SeedRequest) => {
  const e = seedFormulaExpr(r);
  return e === null ? undefined : compileFormula(e);
};
const req = (entry: SeedEntry, over: Partial<SeedRequest> = {}): SeedRequest => ({ entry, expr: '', params: {}, seed: 7, count: 8, ...over });

describe('basic waveform functions (Part 1)', () => {
  const WAVES = [
    ['sine', 'sine'],
    ['tri', 'tri'],
    ['saw', 'saw'],
    ['square', 'square'],
  ] as const;

  it('sine(p) / tri(p) / saw(p) / square(p) render exactly the basic generators', () => {
    for (const [fn, wave] of WAVES) {
      const [t] = formulaBatch(`${fn}(p)`, 1, 1);
      expect(same(t, basicWave(wave, 1)), fn).toBe(true);
    }
  });

  it('pulse(p, w) renders exactly the Pulse generator at any width', () => {
    for (const w of [0.25, 0.1, 0.05, 0.5, 0.02, 0.37, 1 / 3]) {
      const [t] = formulaBatch(`pulse(p, ${w})`, 1, 1);
      expect(same(t, pulse(w)), `pulse ${w}`).toBe(true);
    }
  });

  it('off-grid phases evaluate the closed-form band-limited sum', () => {
    const fx = waveFunctions(1);
    for (const x of [0.1234, 1, 2.5, -3.3, 100.7, 2 * Math.PI * 0.30001]) {
      let saw = 0;
      let sq = 0;
      let tri = 0;
      for (let k = 1; k <= KMAX; k++) {
        saw += Math.sin(k * x) / k;
        if (k % 2) sq += Math.sin(k * x) / k;
        if (k % 2) tri += ((((k - 1) / 2) % 2 ? -1 : 1) * Math.sin(k * x)) / (k * k);
      }
      expect(Math.abs(fx.saw(x) - saw)).toBeLessThan(1e-11);
      expect(Math.abs(fx.square(x) - sq)).toBeLessThan(1e-11);
      expect(Math.abs(fx.tri(x) - tri)).toBeLessThan(1e-11);
      expect(fx.sine(x)).toBe(Math.sin(x));
    }
    // Continuous across grid points (grid value vs closed form just beside it).
    const h = (2 * Math.PI) / TABLE_SIZE;
    expect(Math.abs(fx.saw(5 * h) - fx.saw(5 * h + 1e-7))).toBeLessThan(1e-5);
  });

  it('phase arguments: harmonics, shifts and sums', () => {
    // saw(2p) is the saw an octave up: exactly the grid samples 2i.
    const fx = waveFunctions(1);
    const h = (2 * Math.PI) / TABLE_SIZE;
    for (const i of [1, 100, 1500]) expect(fx.saw(2 * (i * h))).toBe(fx.saw(((2 * i) % TABLE_SIZE) * h));
    // A phase shift only rotates the cycle: shape() aligns it back (to float precision).
    const [shifted] = formulaBatch('saw(p + 1.234)', 1, 1);
    expect(maxDiff(shifted, basicWave('saw', 1))).toBeLessThan(1e-6);
    const [sq] = formulaBatch('square(p + u)', 1, 1);
    expect(maxDiff(sq, basicWave('square', 1))).toBeLessThan(1e-6);
    // pulse(p, 0.5) is a naive square: band-limited by shape() like the Pulse preset.
    const [p50] = formulaBatch('pulse(p, 0.5)', 1, 1);
    expect(same(p50, pulse(0.5))).toBe(true);
  });

  it('basic presets: Built-in function (default) renders the generator; Formula renders the naive formula', () => {
    for (const e of SEED_LIBRARY.filter((x) => x.mode === 'basic')) {
      expect(e.fn).toMatch(/^(sine|tri|saw|square)\(p\)$/);
      expect(sourceExpr(e, 'builtin')).toBe(e.fn);
      expect(sourceExpr(e, 'formula')).toBe(e.asFormula);
      const gen = seedBatch(req(e));
      for (const r of [req(e, { source: 'builtin', expr: e.fn! }), req(e, { source: 'builtin' })]) {
        expect(seedFormulaExpr(r)).toBeNull();
        const b = seedBatch(r, fnFor(r));
        b.forEach((t, i) => {
          expect(t.recipe.op).toBe('basic');
          expect(same(t.data, gen[i].data)).toBe(true);
        });
      }
      // The built-in function through the formula path: bit-identical too.
      formulaBatch(e.fn!, 7, 2).forEach((d) => expect(same(d, gen[0].data), e.id).toBe(true));
      // Formula source: the naive formula (exactly what "Edit as formula" gave before), recorded as a formula.
      const fr = req(e, { source: 'formula', count: 3 });
      const f = seedBatch(fr, fnFor(fr));
      const viaBlank = formulaBatch(e.asFormula!, 7, 3);
      f.forEach((t, i) => {
        expect(t.recipe).toMatchObject({ op: 'formula', params: { expr: e.asFormula, name: e.name, edited: false, preset: e.id } });
        expect(same(t.data, viaBlank[i])).toBe(true);
        expect(same(renderRecipe(t.recipe, { compileFormula }), t.data)).toBe(true);
        expect(maxDiff(t.data, gen[i].data)).toBeLessThan(1e-5);
      });
      // An edited built-in expression is a formula (edited), and re-renders.
      const er = req(e, { source: 'builtin', expr: `${e.fn!.replace('(p)', '(2*p)')}`, count: 2 });
      const ed = seedBatch(er, fnFor(er));
      expect(ed[0].recipe).toMatchObject({ op: 'formula', params: { edited: true, name: e.name, preset: e.id } });
      expect(same(renderRecipe(ed[1].recipe, { compileFormula }), ed[1].data)).toBe(true);
    }
  });

  it('Pulse: both sources render exactly the Pulse parameter mode (width sweep via u)', () => {
    const e = seedEntry('pulse')!;
    const sets: Record<string, number>[] = [{}, { width: 0.4, widthEnd: 0.1 }, { width: 0.3, widthEnd: 0.3 }, { width: 0.02, widthEnd: 0.5 }];
    for (const params of sets) {
      for (const count of [1, 5, 8]) {
        const gen = seedBatch(req(e, { params, count }));
        for (const source of ['builtin', 'formula'] as ExprSource[]) {
          const expr = sourceExpr(e, source, seedParams(e, params));
          const f = formulaBatch(expr, 7, count);
          f.forEach((d, i) => expect(same(d, gen[i].data), `${source} ${expr} #${i}`).toBe(true));
        }
        const fr = req(e, { params, count, source: 'formula' });
        seedBatch(fr, fnFor(fr)).forEach((t, i) => {
          expect(t.recipe.op).toBe('formula');
          expect(same(t.data, gen[i].data)).toBe(true);
        });
        // Built-in, unedited: still the pulse generator (recipe op 'pulse').
        expect(seedBatch(req(e, { params, count, source: 'builtin' }))[0].recipe.op).toBe('pulse');
      }
    }
    expect(sourceExpr(e, 'builtin')).toBe('pulse(p, 0.25+(0.05-0.25)*u)');
    expect(sourceExpr(e, 'formula')).toBe('t < 0.25+(0.05-0.25)*u ? 1 : -1');
  });
});

describe('formula recipes', () => {
  it('formulas with waveform functions re-render exactly from their recipes', () => {
    const exprs = [
      'saw(2*p) + 0.3*square(3*p + u)',
      'pulse(p, 0.1 + 0.4*u) * tri(p)',
      'sine(p + u) - 0.5*saw(3*p)',
    ];
    for (const expr of exprs) {
      const b = seedBatch({ entry: blank, expr, params: {}, seed: 99, count: 4 }, compileFormula(expr));
      b.forEach((t) => {
        expect(t.recipe).toMatchObject({ op: 'formula', params: { expr } });
        expect(same(renderRecipe(t.recipe, { compileFormula }), t.data), expr).toBe(true);
      });
    }
  });

  it('documents every function', () => {
    expect(WAVE_FUNCTION_NAMES.length).toBe(5);
    for (const d of WAVE_FUNCTION_DOCS) expect(d.sig.startsWith(`${d.name}(x`)).toBe(true);
    const fx = waveFunctions(1) as unknown as Record<string, unknown>;
    for (const n of WAVE_FUNCTION_NAMES) expect(typeof fx[n]).toBe('function');
  });

  it('existing formulas are unaffected by the new names', () => {
    // A preset formula whose arrow parameters reuse function names still compiles to the same values.
    const [a] = formulaBatch('[1,2,3].reduce((s,saw)=>s+sin(saw*p),0)', 1, 1);
    const [b] = formulaBatch('[1,2,3].reduce((s,k)=>s+sin(k*p),0)', 1, 1);
    expect(same(a, b)).toBe(true);
  });
});

// Unused-import guard for ParamValue in some TS configs.
export type _P = ParamValue;
