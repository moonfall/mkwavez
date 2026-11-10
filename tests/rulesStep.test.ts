import { describe, expect, it } from 'vitest';
import { AppModel } from '../src/app/model';
import { compileRule } from '../src/browser/formulaEval';
import { KMAX } from '../src/core/constants';
import { harmonicMagnitudes } from '../src/core/fft';
import { basicWave, compileRules, FormulaAborted, generateBasic, renderRecipe, RuleError, seedBatch, seedEntry, seedRules, type HarmonicRule } from '../src/core/generators';
import { gridRowTable, row1Fits } from '../src/core/grid';
import {
  applyChain,
  chainJson,
  chainStages,
  chainSweeps,
  chainUsesSeed,
  normalizeChain,
  renderShapeRecipe,
  shapeRecipe,
  ShapeStepError,
  type ShapeChain,
} from '../src/core/shapeChain';
import { applyStep, newStep, normalizeStep, rulesStepEval, type ShapeStep } from '../src/core/shapeSteps';
import { decodeSession, encodeMeta, encodeWaveforms, packSessionFile, unpackSessionFile, type SessionState } from '../src/core/session';
import { makeTable } from '../src/core/table';

const R = (when: string, value: string, on = true): HarmonicRule => ({ when, value, on });
const env = { compileRule };
const saw = basicWave('saw', 0);
const square = basicWave('square', 0);
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const rulesStep = (rules: HarmonicRule[], over: Partial<ShapeStep> = {}): ShapeStep => ({ id: 'r', on: true, amount: 1, op: 'rules', rules, ...over }) as ShapeStep;
const chain = (steps: ShapeStep[], over: Partial<ShapeChain> = {}): ShapeChain => normalizeChain({ v: 1, name: 'Rules test', seed: 9, varySeed: false, realign: true, steps, ...over });
const mags = (x: ArrayLike<number>) => harmonicMagnitudes(x, KMAX);

describe('Shape step: Rules', () => {
  it('is a harmonic step with an editable default rule', () => {
    const s = newStep('rules', 's1');
    expect(s.op).toBe('rules');
    expect(s.op === 'rules' && s.rules.length).toBeGreaterThan(0);
    expect(normalizeStep(s, 's1')).toEqual(s);
    expect(normalizeStep({ op: 'rules', rules: [{ value: 'v' }, 5], amount: 2 }, 'x')).toEqual({ id: 'x', on: true, amount: 1, op: 'rules', rules: [R('', 'v'), R('', '')] });
    expect(normalizeStep({ op: 'rules' }, 'x')).toMatchObject({ op: 'rules', rules: [] });
  });

  it('the identity rule v → v leaves the waveform unchanged after shaping', () => {
    for (const src of [saw, square, basicWave('tri', 0)]) {
      const out = applyChain(src, chain([rulesStep([R('', 'v')])]), { index: 0, count: 1 }, env);
      expect(maxDiff(out, applyChain(src, chain([]), { index: 0, count: 1 }))).toBeLessThan(1e-9);
    }
    // No rules, a rule that never matches, a disabled rule: the same.
    for (const rules of [[], [R('k>100', '0')], [R('', '0', false)]])
      expect(maxDiff(applyChain(saw, chain([rulesStep(rules)]), undefined, env), applyChain(saw, chain([])))).toBeLessThan(1e-9);
  });

  it('v starts at each harmonic’s magnitude relative to the strongest; harmonics keep their phase', () => {
    // Saw: v = 1/k. Keeping the odd harmonics gives the square (same phases).
    const sq = applyChain(saw, chain([rulesStep([R('k%2==0', '0')])]), undefined, env);
    expect(maxDiff(sq, square)).toBeLessThan(1e-6);
    // v * k on a saw: every harmonic at the fundamental's level.
    const m = mags(applyChain(saw, chain([rulesStep([R('', 'v*k')])]), undefined, env));
    for (const k of [2, 10, 40, 72]) expect(m[k] / m[1]).toBeCloseTo(1, 6);
    const r = rulesStepEval(rulesStep([R('', 'v')]), Float64Array.from(saw), 1, env);
    for (const k of [1, 2, 5, 33]) expect(r.amps[k]).toBeCloseTo(1 / k, 6);
  });

  it('a negative value flips that harmonic', () => {
    const flipped = applyChain(saw, chain([rulesStep([R('', '-v')])], { realign: false }), undefined, env);
    expect(maxDiff(flipped, applyChain(saw, chain([], { realign: false })).map((v) => -v))).toBeLessThan(1e-9);
  });

  it('new harmonics on an absent one take sine phase; from silence the scale is unit amplitude', () => {
    const out = applyChain(basicWave('sine', 0), chain([rulesStep([R('k==2', '0.5')])], { realign: false }), undefined, env);
    const want = Float64Array.from({ length: out.length }, (_, i) => Math.sin((2 * Math.PI * i) / out.length) + 0.5 * Math.sin((4 * Math.PI * i) / out.length));
    const p = Math.max(...Array.from(want, Math.abs));
    expect(maxDiff(out, want.map((v) => v / p))).toBeLessThan(1e-6);
    const silent = new Float64Array(2048);
    const y = applyStep(rulesStep([R('', '1/k')]), silent, 1, 1, 0, env);
    expect(maxDiff(applyChain(Float32Array.from(y), chain([])), saw)).toBeLessThan(1e-6);
  });

  it('amount blends from the input (0 = unchanged, even without a compiler)', () => {
    const x = Float64Array.from(saw);
    expect(maxDiff(applyStep(rulesStep([R('', '0')]), x, 0, 1), x)).toBe(0);
    const half = mags(applyStep(rulesStep([R('k==3', '0')]), x, 0.5, 1, 0, env));
    expect(half[3] / half[1]).toBeCloseTo(1 / 6, 6);
  });

  it('sweeps across a batch via u and n; seeded via rand', () => {
    const c = chain([rulesStep([R('k>1', 'v*(1-u)')])]);
    expect(chainSweeps(c)).toBe(true);
    expect(chainSweeps(chain([rulesStep([R('k>1', 'v*0.5')])]))).toBe(false);
    const first = applyChain(saw, c, { index: 0, count: 4 }, env);
    const last = applyChain(saw, c, { index: 3, count: 4 }, env);
    expect(maxDiff(first, saw)).toBeLessThan(1e-6);
    expect(mags(last)[2] / mags(last)[1]).toBeLessThan(1e-6);
    expect(chainSweeps(chain([rulesStep([R('k == 2+n', '0')])]))).toBe(true);
    const seeded = chain([rulesStep([R('rand(k) < 0.5', '0')])]);
    expect(chainUsesSeed(seeded)).toBe(true);
    expect(chainUsesSeed(c)).toBe(false);
    const a = applyChain(saw, seeded, undefined, env);
    expect(maxDiff(a, applyChain(saw, seeded, undefined, env))).toBe(0);
    expect(maxDiff(a, applyChain(saw, { ...seeded, seed: 10 }, undefined, env))).toBeGreaterThan(1e-3);
  });

  it('errors: no compiler, a syntax error, a non-finite value — as ShapeStepError naming the step', () => {
    expect(() => applyChain(saw, chain([rulesStep([R('', 'v')])]))).toThrow(/rule compiler/);
    let e: unknown;
    try {
      chainStages(saw, chain([newStep('gain', 'g'), rulesStep([R('', 'v'), R('k==4', 'v/0')])]), { index: 0, count: 1 }, [], env);
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(ShapeStepError);
    const se = e as ShapeStepError;
    expect(se.index).toBe(1);
    expect(se.stepId).toBe('r');
    expect(se.cause).toBeInstanceOf(RuleError);
    expect((se.cause as RuleError).rule).toBe(1);
    expect(se.stages.length).toBe(1); // the steps before it
    expect(se.message).toMatch(/Rule 2: non-finite value at k = 4/);
    expect(() => applyChain(saw, chain([rulesStep([R('k>', 'v')])]), undefined, env)).toThrow(/Rule 1: condition/);
  });

  it('a runaway rule is stopped by the chain’s abort hook', () => {
    let calls = 0;
    let e: unknown;
    try {
      applyChain(saw, chain([rulesStep([R('', 'v')])]), undefined, { compileRule, abort: () => ++calls > 2 });
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(ShapeStepError);
    expect((e as ShapeStepError).cause).toBeInstanceOf(FormulaAborted);
  });

  it('chains with a Rules step round-trip (canonical JSON, recipes, shape-on-add, sessions)', () => {
    const c = chain([rulesStep([R('k%3==0', '-v*u'), R('k>8', 'v*db(-6)', false)]), newStep('gain', 'g')]);
    expect(normalizeChain(JSON.parse(chainJson(c)))).toEqual(c);
    const src = makeTable(7, generateBasic('saw', 0));
    const b = { index: 2, count: 4 };
    const r = shapeRecipe(src.id, c, b);
    const data = applyChain(src.data, c, b, env);
    expect(renderShapeRecipe(r, () => src.data, env)).toEqual(data);
    expect(renderRecipe(r, { resolveTable: () => src.data, compileRule })).toEqual(data);
    // Shaped on add: a Seed recipe with the chain.
    const req = { entry: seedEntry('rules-formant-sweep')!, expr: '', params: {}, seed: 3, count: 4 };
    const t = seedBatch(req, compileRules(seedRules(req), compileRule))[1];
    const shaped = { data: applyChain(t.data, c, t.recipe.batch!, env), recipe: { ...t.recipe, shape: chainJson(c) } };
    expect(renderRecipe(shaped.recipe, { compileRule })).toEqual(shaped.data);
    // The session keeps the Shape tab's chain and saved chains with the step.
    const m = new AppModel(64);
    m.addTables([src, shaped].map((x) => ({ data: x.data, recipe: x.recipe })));
    m.setShapeChain(c);
    m.saveShapeChain('With rules');
    const s: SessionState = { model: m.exportState(), ui: {} };
    const { meta, records } = unpackSessionFile(packSessionFile(encodeMeta(s, 1), encodeWaveforms(s.model.timeline)));
    const out = decodeSession(meta, records).state.model;
    expect(out.shapeChain).toEqual(m.exportState().shapeChain);
    expect(out.shapeChains).toEqual(m.exportState().shapeChains);
    expect(out.shapeChain!.steps[0]).toMatchObject({ op: 'rules', rules: [R('k%3==0', '-v*u'), R('k>8', 'v*db(-6)', false)] });
    expect(out.timeline.at(-1)!.recipe).toEqual(shaped.recipe);
  });

  it('works in Grid rows (a Shape chain row operation)', () => {
    const c = chain([rulesStep([R('k>1', 'v*(1-u)')])]);
    const col = makeTable(3, generateBasic('saw', 0));
    const rows = [0, 1, 2].map((j) => gridRowTable({ kind: 'shape', chain: c }, col, j, 3, undefined, env));
    expect(maxDiff(rows[0].data, saw)).toBeLessThan(1e-6);
    expect(mags(rows[2].data)[5] / mags(rows[2].data)[1]).toBeLessThan(1e-6);
    expect(row1Fits({ kind: 'shape', chain: c }, col, 4, env)).toBe(true);
    expect(renderRecipe(rows[1].recipe, { resolveTable: () => col.data, compileRule })).toEqual(rows[1].data);
  });
});
