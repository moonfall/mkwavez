import { describe, expect, it } from 'vitest';
import { KMAX, TABLE_SIZE } from '../src/core/constants';
import { drawingSpan, drawingValue, drawingWeight, lerpDrawing, MAX_DRAW_POINTS, normalizeDrawing, resampleStroke, StrokeBuffer, type Drawing } from '../src/core/drawing';
import { basicWave, generateBasic, renderRecipe } from '../src/core/generators';
import { mutate } from '../src/core/mutations';
import { shape } from '../src/core/shape';
import {
  applyChain,
  chainJson,
  chainStages,
  chainSweeps,
  chainUsesSeed,
  MAX_STEPS,
  normalizeChain,
  recipeChain,
  shapeRecipe,
  stepSeed,
  type ShapeChain,
} from '../src/core/shapeChain';
import { applyStep, bandLimit, drawOp, harmonicSet, newStep, normalizeStep, STEP_INFO, type ShapeStep, type StepOp } from '../src/core/shapeSteps';
import { describeRecipe, makeTable } from '../src/core/table';

const N = TABLE_SIZE;
const saw = basicWave('saw', 0);
const sine = basicWave('sine', 0);
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const peak = (x: ArrayLike<number>) => Array.from(x).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
/** Harmonic magnitudes 1..KMAX (index k) of a cycle. */
function mags(x: ArrayLike<number>): number[] {
  const out = [0];
  for (let k = 1; k <= KMAX; k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < N; i++) {
      re += x[i] * Math.cos((2 * Math.PI * k * i) / N);
      im -= x[i] * Math.sin((2 * Math.PI * k * i) / N);
    }
    out.push((2 * Math.hypot(re, im)) / N);
  }
  return out;
}
const chain = (steps: unknown[], extra: Partial<ShapeChain> = {}): ShapeChain => normalizeChain({ name: 'Test', seed: 7, steps, ...extra });
const step = (op: StepOp, over: Record<string, unknown> = {}) => normalizeStep({ ...newStep(op, 'x'), ...over }, 'x')!;
const line = (y: number, x0 = 0, x1 = 1): Drawing => ({ tool: 'line', pts: [[x0, y], [x1, y]] });

describe('drawings', () => {
  it('lines, curves through their points, spans and the edge fade', () => {
    const l: Drawing = { tool: 'line', pts: [[0.2, 0], [0.6, 1]] };
    expect(drawingValue(l, 0.4)).toBeCloseTo(0.5, 12);
    expect(drawingValue(l, 0.1)).toBeNull();
    expect(drawingSpan(l)).toEqual([0.2, 0.6]);
    expect(drawingWeight(l, 0.4)).toBe(1);
    expect(drawingWeight(l, 0.2)).toBe(0);
    expect(drawingWeight(l, 0.21)).toBeGreaterThan(0);
    expect(drawingWeight(line(0.5), 0)).toBe(1); // reaches the edge: no fade
    const c: Drawing = { tool: 'curve', pts: [[0, 0], [0.3, 1], [0.7, -0.5], [1, 0]] };
    for (const [x, y] of c.pts) expect(drawingValue(c, x)).toBeCloseTo(y, 12);
    expect(drawingValue({ tool: 'line', pts: [[0.5, 0.3]] }, 0.9)).toBe(0.3);
  });

  it('freehand strokes resample to at most MAX_DRAW_POINTS; normalising is idempotent and clamps', () => {
    const raw = Array.from({ length: 500 }, (_, i) => [((i * 37) % 500) / 500, Math.sin(i)] as const);
    const r = resampleStroke(raw);
    expect(r.length).toBeLessThanOrEqual(MAX_DRAW_POINTS);
    expect(r.every((p, i) => i === 0 || p[0] > r[i - 1][0])).toBe(true);
    const fb = line(0.5);
    const n = normalizeDrawing({ tool: 'free', pts: [...raw, [2, 9], [NaN, 1]] }, -4, 4, fb);
    expect(n.pts.every(([x, y]) => x >= 0 && x <= 1 && y >= -4 && y <= 4)).toBe(true);
    expect(normalizeDrawing(n, -4, 4, fb)).toEqual(n);
    expect(normalizeDrawing({ tool: 'line', pts: [[0, 0], [0.5, 1], [1, 0]] }, -4, 4, fb).pts).toEqual([[0, 0], [1, 0]]);
    expect(normalizeDrawing({ tool: 'nope', pts: [] }, -4, 4, fb)).toEqual(fb);
  });
});

describe('steps', () => {
  it('every step at amount 0 passes its input through (spectral steps up to the float32 residue above KMAX)', () => {
    const x = Float64Array.from(saw, (v) => v * 0.8);
    for (const info of STEP_INFO) {
      if (info.op === 'mutation') continue;
      const y = applyStep(newStep(info.op, 'z'), x, 0, 1);
      expect(maxDiff(y, x), info.op).toBeLessThan(1e-6);
    }
    // The engine skips a step at amount 0 entirely, mutations included.
    const st = chainStages(saw, chain([{ ...newStep('mutation', 'm'), amount: 0 }]), { index: 0, count: 1 });
    expect(same(st[0], saw)).toBe(true);
  });

  it('clip / soft clip / fold respect their thresholds and sides', () => {
    const at = (s: ShapeStep, x: number) => drawOp(s as Parameters<typeof drawOp>[0], x, 0.5);
    const clip = step('clip', { side: 'both' });
    expect(at(clip, 0.9)).toBe(0.5);
    expect(at(clip, -0.9)).toBe(-0.5);
    expect(at(step('clip', { side: 'above' }), -0.9)).toBe(-0.9);
    expect(at(step('clip', { side: 'below' }), 0.2)).toBe(0.5);
    const soft = step('soft', { side: 'both', knee: 0.1 });
    for (let x = -2; x <= 2; x += 0.01) {
      expect(Math.abs(at(soft, x))).toBeLessThanOrEqual(0.5 + 0.1 * Math.LN2 + 1e-12);
      expect(Math.abs(at(step('fold', { side: 'both' }), x))).toBeLessThanOrEqual(0.5 + 1e-12);
    }
    expect(at(step('fold', { side: 'both' }), 0.7)).toBeCloseTo(0.3, 12);
    expect(at(step('fold', { side: 'above' }), 0.7)).toBeCloseTo(0.3, 12);
  });

  it('push and pull are continuous and never reverse the wave; pull reaches the line', () => {
    for (const op of ['push', 'pull'] as const) {
      const s = step(op, { radius: 0.4 });
      let prev = -Infinity;
      for (let x = -1; x <= 1.5; x += 0.001) {
        const y = drawOp(s as Parameters<typeof drawOp>[0], x, 0.5);
        expect(y, `${op} at ${x}`).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = y;
      }
    }
    expect(drawOp(step('pull') as Parameters<typeof drawOp>[0], 0.5, 0.5)).toBe(0.5);
  });

  it('a drawing acts only over its span (with the edge fade)', () => {
    const x = Float64Array.from(saw);
    const y = applyStep(step('replace', { draw: line(0.3, 0.25, 0.5) }), x, 1, 1);
    for (let i = 0; i < N; i++) {
      const t = i / N;
      if (t < 0.25 || t > 0.5) expect(y[i]).toBe(x[i]);
      if (t > 0.3 && t < 0.45) expect(y[i]).toBeCloseTo(0.3, 12);
    }
  });

  it('harmonic sets: keep multiples, replace with a 1/k law', () => {
    const keep = bandLimit(applyStep(step('harmSet', { mode: 'keep', set: { kind: 'multiples', of: [3] }, fundamental: true }), Float64Array.from(saw), 1, 1));
    const m = mags(keep);
    for (let k = 1; k <= 12; k++) {
      if (k === 1 || k % 3 === 0) expect(m[k], `h${k}`).toBeGreaterThan(1e-3);
      else expect(m[k], `h${k}`).toBeLessThan(1e-9);
    }
    const s = step('harmSet', { mode: 'replace', set: { kind: 'odd' }, law: 1 });
    expect(Array.from(harmonicSet(s as Parameters<typeof harmonicSet>[0])).slice(1, 6)).toEqual([1, 0, 1, 0, 1]);
    const rep = mags(bandLimit(applyStep(s, Float64Array.from(sine), 1, 1)));
    expect(rep[3] / rep[1]).toBeCloseTo(1 / 3, 6);
    expect(rep[5] / rep[1]).toBeCloseTo(1 / 5, 6);
    expect(rep[2]).toBeLessThan(1e-9);
  });

  it('modify harmonics: shift moves h2 to h4, tilt −6 dB/octave halves h2 relative to h1', () => {
    const x = Float64Array.from(saw);
    const m0 = mags(x);
    const sh = mags(applyStep(step('harmMod', { kind: 'shift', value: 2 }), x, 1, 1));
    expect(sh[4]).toBeCloseTo(m0[2], 6);
    expect(sh[1]).toBeCloseTo(m0[1], 6);
    expect(sh[2]).toBeLessThan(1e-9);
    const tl = mags(applyStep(step('harmMod', { kind: 'tilt', value: -6 }), x, 1, 1));
    expect(tl[2] / tl[1]).toBeCloseTo((m0[2] / m0[1]) * Math.pow(10, -6 / 20), 6);
  });

  it('limit to curve caps every harmonic at the drawn level', () => {
    const x = Float64Array.from(saw);
    const m0 = mags(x);
    const top = Math.max(...m0);
    const lim = mags(applyStep(step('harmLimit', { mode: 'limit', draw: { tool: 'line', pts: [[0, -20], [1, -20]] } }), x, 1, 1));
    for (let k = 1; k <= KMAX; k++) expect(20 * Math.log10(lim[k] / top), `h${k}`).toBeLessThanOrEqual(-20 + 1e-6);
  });

  it('whole-wave steps: gain, invert, reverse, rotate, mutation (level restored)', () => {
    const x = Float64Array.from(saw, (v) => v * 0.5);
    expect(maxDiff(applyStep(step('gain', { value: 2 }), x, 1, 1), x.map((v) => v * 2))).toBeLessThan(1e-12);
    expect(maxDiff(applyStep(step('invert'), x, 1, 1), x.map((v) => -v))).toBeLessThan(1e-12);
    expect(applyStep(step('reverse'), x, 1, 1)[1]).toBe(x[N - 1]);
    const rot = applyStep(step('rotate', { value: 0.25 }), Float64Array.from(sine), 1, 1);
    expect(maxDiff(rot, Float64Array.from({ length: N }, (_, i) => sine[(i - N / 4 + N) % N]))).toBeLessThan(1e-6);
    const mu = applyStep(step('mutation', { mutation: 'fold' }), x, 0.6, 3);
    expect(peak(mu)).toBeCloseTo(0.5, 6);
    expect(maxDiff(mu.map((v) => v / 0.5), mutate('fold', Float32Array.from(x, (v) => v / 0.5), 0.6, 3))).toBeLessThan(1e-6);
  });
});

describe('chains', () => {
  it('an empty chain is shape(source); realign off keeps the drawn phase', () => {
    expect(same(applyChain(saw, chain([])), shape(saw))).toBe(true);
    const rot = [{ ...newStep('rotate', 'r'), value: 0.2 }];
    const on = applyChain(sine, chain(rot));
    const off = applyChain(sine, chain(rot, { realign: false }));
    expect(maxDiff(on, sine)).toBeLessThan(1e-5);
    expect(maxDiff(off, sine)).toBeGreaterThan(0.5);
  });

  it('levels carry between steps: gain then clip drives the clipper', () => {
    const driven = applyChain(sine, chain([{ ...newStep('gain', 'g'), value: 4 }, { ...newStep('clip', 'c'), draw: line(1) }]));
    const plain = applyChain(sine, chain([{ ...newStep('clip', 'c'), draw: line(1) }]));
    expect(maxDiff(plain, sine)).toBeLessThan(1e-6); // a sine at peak 1 never reaches the line
    expect(mags(driven)[3]).toBeGreaterThan(0.05); // driven ×4 into it: square-ish
  });

  it('sweeps: the first waveform uses amount, the last amountEnd', () => {
    const c = chain([{ ...newStep('clip', 'c'), amount: 0, amountEnd: 1, draw: line(0.3) }]);
    expect(chainSweeps(c)).toBe(true);
    expect(same(applyChain(saw, c, { index: 0, count: 5 }), shape(saw))).toBe(true);
    const full = chain([{ ...newStep('clip', 'c'), amount: 1, draw: line(0.3) }]);
    expect(same(applyChain(saw, c, { index: 4, count: 5 }), applyChain(saw, full))).toBe(true);
    expect(chainSweeps(chain([{ ...newStep('clip', 'c'), amount: 0.5, amountEnd: 0.5 }]))).toBe(false);
  });

  it('seeds come from the step id: stable when other steps change; varySeed differs per waveform', () => {
    const r = { ...newStep('harmMod', 'rnd'), kind: 'randomize', value: 0.5 };
    const a = chain([r]);
    const b = chain([newStep('gain', 'g'), r, newStep('invert', 'i')]);
    expect(chainUsesSeed(a)).toBe(true);
    expect(stepSeed(a, a.steps[0], { index: 0, count: 1 })).toBe(stepSeed(b, b.steps[1], { index: 3, count: 8 }));
    const v = chain([r], { varySeed: true });
    expect(stepSeed(v, v.steps[0], { index: 0, count: 2 })).not.toBe(stepSeed(v, v.steps[0], { index: 1, count: 2 }));
    expect(same(applyChain(saw, a, { index: 0, count: 2 }), applyChain(saw, a, { index: 1, count: 2 }))).toBe(true);
    expect(same(applyChain(saw, v, { index: 0, count: 2 }), applyChain(saw, v, { index: 1, count: 2 }))).toBe(false);
  });

  it('normalizeChain: idempotent canonical JSON, unknown steps dropped, ids repaired, ranges clamped', () => {
    const raw = {
      name: '  Mine  ',
      seed: -5,
      steps: [
        { op: 'clip', id: 'a', knee: 99, side: 'sideways', amount: 3 },
        { op: 'teleport', id: 'b' },
        { op: 'gain', id: 'a', value: 100 },
        { op: 'harmSet', set: { kind: 'multiples', of: [0, 3, 3, 500, 2.5, 4] } },
      ],
    };
    const c = normalizeChain(raw);
    expect(c.name).toBe('Mine');
    expect(c.seed).toBe(-5 >>> 0);
    expect(c.steps.map((s) => s.op)).toEqual(['clip', 'gain', 'harmSet']);
    expect(new Set(c.steps.map((s) => s.id)).size).toBe(3);
    const clip = c.steps[0] as unknown as { knee: number; side: string; amount: number };
    expect([clip.knee, clip.side, clip.amount]).toEqual([0.5, 'both', 1]);
    expect((c.steps[1] as unknown as { value: number }).value).toBe(8);
    expect((c.steps[2] as Extract<ShapeStep, { op: 'harmSet' }>).set).toEqual({ kind: 'multiples', of: [3, 4] });
    expect(normalizeChain(c)).toEqual(c);
    expect(chainJson(JSON.parse(chainJson(c)))).toBe(chainJson(c));
    expect(normalizeChain({ steps: Array.from({ length: 40 }, () => ({ op: 'invert' })) }).steps.length).toBe(MAX_STEPS);
    expect(normalizeChain(null).steps).toEqual([]);
  });

  it('recipes: re-rendering a shape recipe reproduces Add exactly; a shaped-on-add recipe applies its chain', () => {
    const src = makeTable(5, generateBasic('saw', 0));
    const c = chain([
      { ...newStep('fold', 'f'), draw: line(0.45) },
      { ...newStep('soft', 's'), draw: { tool: 'curve', pts: [[0, 0.5], [0.5, 0.2], [1, 0.5]] } },
      newStep('harmSet', 'h'),
      { ...newStep('harmMod', 'r'), kind: 'randomize' },
      newStep('harmLimit', 'l'),
    ]);
    const b = { index: 2, count: 4 };
    const r = shapeRecipe(5, c, b);
    expect(r.op).toBe('shape');
    expect(r.parents).toEqual([5]);
    expect(recipeChain(r)).toEqual(c);
    expect(same(renderRecipe(r, { resolveTable: (id) => (id === 5 ? src.data : undefined) }), applyChain(src.data, c, b))).toBe(true);
    expect(describeRecipe(r)).toBe('Test · 5 steps 3/4 of id 5');
    const shaped = { ...src.recipe, shape: chainJson(c) };
    expect(same(renderRecipe(shaped), applyChain(src.data, c))).toBe(true);
    expect(describeRecipe(shaped)).toBe('saw · shaped: Test');
  });
});

describe('drawing sweeps (start → end drawing)', () => {
  it('lerpDrawing: ends are the drawings; lines stay lines; points travel along their spans', () => {
    const a: Drawing = { tool: 'line', pts: [[0, 0.2], [0.5, 0.2]] };
    const b: Drawing = { tool: 'line', pts: [[0.5, 0.8], [1, 0.4]] };
    expect(lerpDrawing(a, b, 0)).toBe(a);
    expect(lerpDrawing(a, b, 1)).toBe(b);
    const m = lerpDrawing(a, b, 0.5);
    expect(m.tool).toBe('line');
    expect(m.pts[0][0]).toBeCloseTo(0.25, 12);
    expect(m.pts[0][1]).toBeCloseTo(0.5, 12);
    expect(m.pts[1][1]).toBeCloseTo(0.3, 12);
    const c: Drawing = { tool: 'curve', pts: [[0, 0], [0.5, 1], [1, 0]] };
    const half = lerpDrawing(c, b, 0.5);
    expect(half.tool).toBe('free');
    expect(drawingSpan(half)![0]).toBeCloseTo(0.25, 12);
    expect(drawingValue(half, 0.25)).toBeCloseTo(0.4, 6); // (0 + 0.8) / 2 at the start of both spans
  });

  it('a step with an end drawing sweeps: first waveform = start drawing, last = end drawing; normalised and replayable', () => {
    const start: Drawing = { tool: 'line', pts: [[0, 0.9], [1, 0.9]] };
    const endD: Drawing = { tool: 'line', pts: [[0, 0.2], [1, 0.2]] };
    const c = chain([{ ...newStep('clip', 'c'), draw: start, drawEnd: endD }]);
    expect(c.steps[0].drawEnd).toEqual(endD);
    expect(chainSweeps(c)).toBe(true);
    const at = (d: Drawing) => applyChain(saw, chain([{ ...newStep('clip', 'c'), draw: d }]));
    expect(same(applyChain(saw, c, { index: 0, count: 5 }), at(start))).toBe(true);
    expect(same(applyChain(saw, c, { index: 4, count: 5 }), at(endD))).toBe(true);
    const mid = applyChain(saw, c, { index: 2, count: 5 });
    expect(maxDiff(mid, at(start))).toBeGreaterThan(1e-3);
    expect(maxDiff(mid, at(endD))).toBeGreaterThan(1e-3);
    expect(chainSweeps(chain([{ ...newStep('clip', 'c'), draw: start, drawEnd: start }]))).toBe(false);
    expect(normalizeChain(c)).toEqual(c);
    const r = shapeRecipe(5, c, { index: 3, count: 5 });
    expect(same(renderRecipe(r, { resolveTable: () => saw }), applyChain(saw, c, { index: 3, count: 5 }))).toBe(true);
    // Limit to curve too.
    const lim = chain([{ ...newStep('harmLimit', 'l'), draw: { tool: 'line', pts: [[0, -6], [1, -6]] }, drawEnd: { tool: 'line', pts: [[0, -40], [1, -40]] } }]);
    expect(maxDiff(applyChain(saw, lim, { index: 0, count: 3 }), applyChain(saw, lim, { index: 2, count: 3 }))).toBeGreaterThan(1e-3);
  });
});

describe('StrokeBuffer (freehand strokes)', () => {
  it('going back over a stroke replaces it cleanly (no averaging jitter)', () => {
    const sb = new StrokeBuffer();
    for (let i = 0; i <= 100; i++) sb.add([i / 100, 0]); // forward at 0
    for (let i = 100; i >= 50; i--) sb.add([i / 100, 1]); // back over the right half at 1
    const pts = sb.points();
    expect(pts.length).toBeLessThanOrEqual(MAX_DRAW_POINTS);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts.at(-1)).toEqual([1, 1]);
    const d: Drawing = { tool: 'free', pts };
    for (let x = 0; x <= 0.45; x += 0.01) expect(drawingValue(d, x)).toBeCloseTo(0, 9);
    for (let x = 0.55; x <= 1; x += 0.01) expect(drawingValue(d, x)).toBeCloseTo(1, 9);
    // Monotone across the join: no wiggle.
    for (let x = 0; x < 0.99; x += 0.005) expect(drawingValue(d, x + 0.005)! - drawingValue(d, x)!).toBeGreaterThanOrEqual(-1e-12);
  });

  it('a fast jump fills the bins in between; seed() keeps an existing drawing outside the new stroke', () => {
    const sb = new StrokeBuffer();
    sb.add([0.1, 0]);
    sb.add([0.9, 0.8]);
    const d: Drawing = { tool: 'free', pts: sb.points() };
    expect(drawingValue(d, 0.5)).toBeCloseTo(0.4, 2);
    const seeded = new StrokeBuffer();
    seeded.seed({ tool: 'line', pts: [[0, 0.5], [1, 0.5]] });
    seeded.add([0.4, -0.5]);
    seeded.add([0.6, -0.5]);
    const m: Drawing = { tool: 'free', pts: seeded.points() };
    expect(drawingSpan(m)).toEqual([0, 1]);
    expect(drawingValue(m, 0.1)).toBeCloseTo(0.5, 6);
    expect(drawingValue(m, 0.5)).toBeCloseTo(-0.5, 6);
    expect(drawingValue(m, 0.9)).toBeCloseTo(0.5, 6);
  });
});
