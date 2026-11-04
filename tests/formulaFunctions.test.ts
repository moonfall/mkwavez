import { describe, expect, it } from 'vitest';
import { compileFormula } from '../src/browser/formulaEval';
import { KMAX, TABLE_SIZE } from '../src/core/constants';
import {
  basicWave,
  compactContour,
  contourPoints,
  CycleMemo,
  DEFAULT_CONTOUR,
  formulaTable,
  glyphInputs,
  modeFormula,
  parseContour,
  pulse,
  renderRecipe,
  SEED_LIBRARY,
  seedBatch,
  seedEntry,
  seedFormulaExpr,
  seedParams,
  seedTable,
  sourceExpr,
  waveFunctions,
  WAVE_FUNCTION_DOCS,
  WAVE_FUNCTION_NAMES,
  type ExprSource,
  type SeedEntry,
  type SeedRequest,
} from '../src/core/generators';
import { shape } from '../src/core/shape';
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

/** A stand-in for the browser's glyph tracer: a distinct polygon per character and weight. */
const fakeTrace = (ch: string, weight: number): string => {
  const c = ch.codePointAt(0)! % 7;
  const pts: number[] = [];
  const m = 5 + c;
  for (let j = 0; j < m; j++) {
    const a = (2 * Math.PI * j) / m;
    const r = 0.25 + 0.1 * Math.sin(3 * a + c) + weight / 9000;
    pts.push(0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a));
  }
  return pts.map((v, i) => (i % 2 ? '' : ' ') + v.toFixed(3)).join(',').replace(/^ /, '').replace(/, /g, ' ');
};

describe('parameter modes as functions (Part 2)', () => {
  const modes = SEED_LIBRARY.filter((e) => e.params?.length);

  /** Random params within each slider's range (on its step grid). */
  const randomParams = (e: SeedEntry, r: () => number): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const p of e.params!) {
      if (p.options) out[p.key] = p.options[Math.floor(r() * p.options.length)][0];
      else out[p.key] = Math.min(p.max, p.min + Math.round((r() * (p.max - p.min)) / p.step) * p.step);
    }
    return out;
  };

  it('every parameter mode has a formula that renders its batch bit for bit', () => {
    let s = 12345;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
    const chars = ['m', 'k', 'w'];
    const exact: string[] = [];
    for (const e of modes) {
      const sets = [{}, ...Array.from({ length: 4 }, () => randomParams(e, rnd))];
      for (const over of sets) {
        const params = seedParams(e, over);
        for (const [seed, count] of [
          [7, 8],
          [0xdeadbeef, 5],
          [3, 1],
        ]) {
          const inputs = e.mode === 'glyph' ? glyphInputs(chars, { batch: params.batch, weight: params.weight, weightEnd: params.weightEnd }, count, fakeTrace) : undefined;
          const gen = seedBatch(req(e, { params, seed, count, inputs }));
          const expr = modeFormula(e, params, { glyphChars: chars, contourOf: fakeTrace })!;
          expect(expr, e.id).toBeTruthy();
          const f = formulaBatch(expr, seed, count);
          f.forEach((d, i) => expect(same(d, gen[i].data), `${e.id} ${JSON.stringify(over)} seed ${seed} #${i}/${count}: ${expr.slice(0, 120)}`).toBe(true));
        }
      }
      exact.push(e.id);
    }
    expect(exact.length).toBe(modes.length);
    expect(exact).toEqual(expect.arrayContaining(['pulse', 'perlin-noise', 'cellular-automaton', 'dynamical-systems', 'karplus-strong', 'additive-designer', 'number-sequences', 'reaction-diffusion', 'life-like-ca', 'spline', 'glyph-contour']));
  });

  it('formulas at the defaults read as expected', () => {
    const f = (id: string) => modeFormula(seedEntry(id)!, seedParams(seedEntry(id)!));
    expect(f('pulse')).toBe('pulse(p, 0.25+(0.05-0.25)*u)');
    expect(f('perlin-noise')).toBe('perlin(p, 2, 1.5*u, 4, 0.5)');
    expect(f('cellular-automaton')).toBe('ca(p, 30, 32, n)');
    expect(f('dynamical-systems')).toBe('dyn(p, 0, 0.6+(1-0.6)*u, 12, 0.8, 0)');
    expect(f('karplus-strong')).toBe('ks(p, pow(1001,u)-1, 0.6, 0.2, 96, 0)');
    expect(f('additive-designer')).toBe('additive(p, 1+(1.6-1)*u, 0, pow(2,1*u), 0, 6, 2, 3, 15, 3, 2)');
    expect(f('number-sequences')).toBe('seq(p, 0, 16, 0, n)');
    expect(f('reaction-diffusion')).toBe('rd(p, 0, 200+400*n, 128, 3)');
    expect(f('life-like-ca')).toBe('life(p, 0, 0, 32, 0.35, 8+n)');
    expect(f('spline')).toBe('spline(p, 8, 0, 0, 0.6*u)');
    expect(f('glyph-contour')).toBe('glyph(p, "", 0)');
  });

  it('glyph formulas carry the contours (compact, exact) and render without the tracer', () => {
    const e = seedEntry('glyph-contour')!;
    const chars = ['a', 'b'];
    const sets: Record<string, number>[] = [{}, { batch: 1 }, { batch: 2, skew: -0.3, skewEnd: 0.4 }, { batch: 1, weight: 300, weightEnd: 300 }];
    for (const over of sets) {
      const params = seedParams(e, over);
      const expr = modeFormula(e, params, { glyphChars: chars, contourOf: fakeTrace })!;
      expect(expr).not.toContain(',0.'); // compact contours, not "x,y" polylines
      const inputs = glyphInputs(chars, { batch: params.batch, weight: params.weight, weightEnd: params.weightEnd }, 6, fakeTrace);
      const gen = seedBatch(req(e, { params, count: 6, inputs }));
      formulaBatch(expr, 7, 6).forEach((d, i) => expect(same(d, gen[i].data), `${JSON.stringify(over)} #${i}`).toBe(true));
    }
    // The compact form decodes to exactly the parsed polyline; others fall back to the plain string.
    for (const c of [DEFAULT_CONTOUR, fakeTrace('q', 700), '0.200,0.200 0.800,0.200 0.800,0.800 0.200,0.800', '-1.500,0.001 2.047,-2.048']) {
      const k = compactContour(c)!;
      expect(k.length).toBe((parseContour(c).length / 2) * 4);
      expect(contourPoints(k)).toEqual(parseContour(c));
    }
    expect(compactContour('0.1234,0.5 0.2,0.2 0.3,0.9')).toBeNull();
    expect(contourPoints('0.1234,0.5 0.2,0.2')).toEqual([0.1234, 0.5, 0.2, 0.2]);
    // A 64-point contour stays a short literal (4 characters per point).
    expect(compactContour(Array.from({ length: 64 }, () => '0.123,0.456').join(' '))!.length).toBe(256);
  });

  it('seeded functions use the recipe seed, or an explicit last argument', () => {
    const a = formulaBatch('ca(p, 30, 32, 0)', 5, 1)[0];
    const b = formulaBatch('ca(p, 30, 32, 0)', 6, 1)[0];
    const c = formulaBatch('ca(p, 30, 32, 0, 5)', 6, 1)[0];
    expect(same(a, b)).toBe(false);
    expect(same(a, c)).toBe(true);
    expect(same(formulaBatch('perlin(p, 2, 0, 4, 0.5, 9)', 1, 1)[0], formulaBatch('pnoise(2, 0, 4, 0.5)', 9, 1)[0])).toBe(true);
  });
});

describe('memoisation', () => {
  it('generates each distinct argument set once per table render, without collisions', () => {
    const memo = new CycleMemo(8);
    const fx = waveFunctions(1, memo);
    const h = (2 * Math.PI) / TABLE_SIZE;
    const ca30 = new Float64Array(TABLE_SIZE);
    const ca110 = new Float64Array(TABLE_SIZE);
    for (let i = 0; i < TABLE_SIZE; i++) {
      ca30[i] = fx.ca(i * h, 30, 32, 3);
      ca110[i] = fx.ca(i * h, 110, 32, 3);
    }
    expect(memo.misses).toBe(2);
    expect(maxDiff(ca30, ca110)).toBeGreaterThan(0.5);
    // Generation 0 is the seeded start row, the same for every rule.
    expect(same(shape(ca30), seedTable(req(seedEntry('cellular-automaton')!, { params: { start: 3 }, seed: 1, count: 1 }), 0).data)).toBe(true);
    // Same values in different positions / types are different keys.
    fx.rd(0, 0, 200, 128, 3);
    fx.rd(0, 0, 128, 200, 3);
    fx.glyph(0, '0.1,0.1 0.9,0.1 0.5,0.9', 0);
    fx.glyph(0, '0.1,0.1 0.9,0.1 0.5,0.9', 0.5);
    expect(memo.misses).toBe(6);
    // Bounded: older cycles are dropped (and regenerated if asked for again).
    for (let r = 0; r < 20; r++) fx.ca(0, r, 16, 1);
    expect(memo.size).toBe(8);
    const before = memo.misses;
    fx.ca(0, 30, 32, 3);
    expect(memo.misses).toBe(before + 1);
  });

  it('a mixed formula renders like the sum of its parts, and n / u vary the batch', () => {
    const expr = 'ca(p, 30, 32, n) + 0.5*ca(p, 90, 16, 2*n) - dyn(p, 1, u, 8, 0.8, 0)';
    const fn = compileFormula(expr);
    for (let i = 0; i < 4; i++) {
      const fx = waveFunctions(3);
      const h = (2 * Math.PI) / TABLE_SIZE;
      const x = new Float64Array(TABLE_SIZE);
      for (let j = 0; j < TABLE_SIZE; j++) x[j] = fx.ca(j * h, 30, 32, i) + 0.5 * fx.ca(j * h, 90, 16, 2 * i) - fx.dyn(j * h, 1, i / 3, 8, 0.8, 0);
      expect(same(formulaTable(fn, 3, i, 4), shape(x))).toBe(true);
    }
    const b = formulaBatch(expr, 3, 4);
    expect(new Set(b.map((t) => t.join())).size).toBe(4);
  });

  it('per-sample evaluation stays fast (cycles are generated once per render)', () => {
    const expr = 'rd(p, 0, 200+400*n, 128, 3) + ks(p, pow(1001,u)-1, 0.6, 0.2, 96, 0) + life(p, 0, 0, 32, 0.35, 8+n)';
    const t0 = performance.now();
    formulaBatch(expr, 1, 8);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('bad arguments are errors, not hangs', () => {
    expect(() => formulaBatch('ca(p, 30, 32, 1e9)', 1, 1)).toThrow(/gen/);
    expect(() => formulaBatch('rd(p, 0, -5)', 1, 1)).toThrow(/step/);
    expect(() => formulaBatch('saw(p/0*0)', 1, 1)).toThrow();
  });
});

describe('formula recipes', () => {
  it('formulas with waveform functions re-render exactly from their recipes', () => {
    const exprs = [
      'saw(2*p) + 0.3*square(3*p + u)',
      'pulse(p, 0.1 + 0.4*u) * tri(p)',
      'ks(p, 100*n, 0.5, 0.3, 64, 0) * sine(p)',
      'perlin(p + u, 3, n, 5, 0.6)',
      'additive(p, 1+u, 0.5, 1, 2, 10, 3, 4)',
      'spline(p, 6+n, 1, 0.2, u)',
      'glyph(p, ["' + compactContour(DEFAULT_CONTOUR) + '", "0.1,0.1 0.9,0.2 0.5,0.95"][n%2], u - 0.5)',
      'seq(p, 2, 24, 0.5, 3*n) + life(p, 3, 4, 24, 0.4, n)',
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
    expect(WAVE_FUNCTION_NAMES.length).toBe(15);
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
