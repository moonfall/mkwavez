import { describe, expect, it } from 'vitest';
import { AppModel } from '../src/app/model';
import { compileRule } from '../src/browser/formulaEval';
import { KMAX } from '../src/core/constants';
import { harmonicMagnitudes } from '../src/core/fft';
import {
  compileRules,
  evalRules,
  FormulaAborted,
  normalizeRules,
  parseRules,
  programError,
  renderRecipe,
  RULES_PRESETS,
  rulesJson,
  rulesRaw,
  rulesTable,
  rulesUseBatch,
  rulesUseSeed,
  RuleError,
  ruleExprError,
  SEED_LIBRARY,
  seedBatch,
  seedEntry,
  seedRules,
  seedUsesRandomness,
  type HarmonicRule,
  type SeedRequest,
} from '../src/core/generators';
import { decodeSession, encodeMeta, encodeWaveforms, packSessionFile, unpackSessionFile, type SessionState } from '../src/core/session';
import { describeRecipe } from '../src/core/table';

const R = (when: string, value: string, on = true): HarmonicRule => ({ when, value, on });
const run = (rules: HarmonicRule[], init: ArrayLike<number> | null = null, seed = 1, index = 0, count = 1) =>
  evalRules(compileRules(rules, compileRule), init, seed, index, count);
const amps = (rules: HarmonicRule[], init: ArrayLike<number> | null = null) => Array.from(run(rules, init).amps.subarray(1, 9));

describe('Harmonic rules: semantics', () => {
  it('starts from zero; an empty condition means always', () => {
    expect(amps([])).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(amps([R('', 'k')])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(amps([R('k%2==1', '1/k')])).toEqual([1, 0, 1 / 3, 0, 1 / 5, 0, 1 / 7, 0]);
  });

  it('applies every matching rule in list order', () => {
    expect(amps([R('', '1'), R('k>4', '2')])).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
    expect(amps([R('k>4', '2'), R('', '1')])).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    // Disabled rules are skipped.
    expect(amps([R('', '1'), R('k>4', '2', false)])).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('v is the current value, so rules accumulate', () => {
    expect(amps([R('', '1'), R('', 'v + k'), R('k==2', 'v*10')])).toEqual([2, 30, 4, 5, 6, 7, 8, 9]);
  });

  it('a(j): lower harmonics already updated by this rule, higher ones as earlier rules left them, 0 out of range', () => {
    // In place, ascending: a running sum.
    expect(amps([R('', '1'), R('', 'v + a(k-1)')])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // a(k+1) reads the previous rule's value (1), not this rule's.
    expect(amps([R('', '1'), R('', 'v + a(k+1)')]).slice(0, 3)).toEqual([2, 2, 2]);
    expect(run([R('', '1'), R('', 'v + a(k+1)')]).amps[KMAX]).toBe(1); // a(73) = 0
    expect(amps([R('', 'a(0) + a(-3) + a(1000) + 1')])).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('K, n, u and the helpers', () => {
    expect(amps([R('', 'K')])[0]).toBe(KMAX);
    expect(amps([R('prime(k)', '1')])).toEqual([0, 1, 1, 0, 1, 0, 1, 0]);
    expect(amps([R('k==1', 'db(-20)')])[0]).toBeCloseTo(0.1, 12);
    const at = (i: number) => evalRules(compileRules([R('', 'n + u')], compileRule), null, 1, i, 5).amps[1];
    expect([0, 1, 2, 3, 4].map(at)).toEqual([0, 1.25, 2.5, 3.75, 5]);
  });

  it('records the last rule that matched each harmonic', () => {
    const r = run([R('', '1'), R('k%2==0', '0.5'), R('k==4', 'v')]);
    expect(Array.from(r.last.subarray(1, 6))).toEqual([0, 1, 0, 2, 0]);
    expect(run([R('k==3', '1')]).last[1]).toBe(-1);
  });

  it('starting amplitudes (the Shape step) are where v begins', () => {
    const init = new Float64Array(KMAX + 1).map((_, k) => (k ? 1 / k : 0));
    expect(amps([R('', 'v')], init)).toEqual(Array.from(init.subarray(1, 9)));
    expect(amps([R('k>2', '-v')], init).slice(0, 4)).toEqual([1, 0.5, -1 / 3, -0.25]);
  });

  it('rand(x) is deterministic per seed, rule and x, in 0..1', () => {
    const r = (seed: number, rules: HarmonicRule[]) => Array.from(evalRules(compileRules(rules, compileRule), null, seed, 0, 1).amps.subarray(1));
    const a = r(7, [R('', 'rand(k)')]);
    expect(r(7, [R('', 'rand(k)')])).toEqual(a);
    expect(r(7, [R('', 'rand()')])).toEqual(a); // x defaults to k
    expect(a.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(new Set(a).size).toBeGreaterThan(60);
    expect(r(8, [R('', 'rand(k)')])).not.toEqual(a);
    // Another rule draws another stream; the condition and value of one rule agree.
    expect(r(7, [R('', '0'), R('', 'rand(k)')])).not.toEqual(a);
    expect(r(7, [R('rand(k) < 0.5', 'rand(k)')]).every((v) => v < 0.5)).toBe(true);
    // The batch position doesn't change it.
    const b = (i: number) => Array.from(evalRules(compileRules([R('', 'rand(k)')], compileRule), null, 7, i, 4).amps.subarray(1));
    expect(b(3)).toEqual(b(0));
  });

  it('errors name the rule: syntax, non-finite values, thrown errors', () => {
    const p = compileRules([R('', '1'), R('k>', '1')], compileRule);
    expect(p.errors[0]).toBeUndefined();
    expect(p.errors[1]).toMatch(/^condition:/);
    expect(programError(p)).toMatch(/^Rule 2: condition:/);
    expect(() => evalRules(p, null, 1, 0, 1)).toThrow(RuleError);
    expect(compileRules([R('', '')], compileRule).errors[0]).toMatch(/value/);
    // A disabled rule's errors don't count.
    expect(programError(compileRules([R('', '('), R('', '1', true)].map((r, i) => ({ ...r, on: i > 0 })), compileRule))).toBeNull();
    let e: unknown;
    try {
      run([R('', '1'), R('k==5', '1/0')]);
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(RuleError);
    expect((e as RuleError).rule).toBe(1);
    expect((e as Error).message).toMatch(/Rule 2: non-finite value at k = 5/);
    expect(() => run([R('k==2', 'nope + 1')])).toThrow(/Rule 1: .*nope/);
    expect(() => run([R('0/0', '1')])).toThrow(/condition is not a number/);
  });

  it('abort() stops a runaway rule', () => {
    let calls = 0;
    expect(() => evalRules(compileRules([R('', '1')], compileRule), null, 1, 0, 1, () => ++calls > 3)).toThrow(FormulaAborted);
  });

  it('rules are plain data: normalised, canonical JSON, parsed back', () => {
    const rules = normalizeRules([{ value: '1/k' }, { when: 'k>2', value: 'v', on: false, extra: 1 }, 7, null]);
    expect(rules).toEqual([R('', '1/k'), R('k>2', 'v', false), R('', ''), R('', '')]);
    expect(normalizeRules(rules)).toEqual(rules);
    expect(parseRules(rulesJson(rules))).toEqual(rules);
    expect(parseRules('nope')).toEqual([]);
    expect(normalizeRules(Array.from({ length: 40 }, () => R('', '1'))).length).toBe(16);
  });

  it('seed / batch detection', () => {
    expect(rulesUseSeed([R('', '1/k')])).toBe(false);
    expect(rulesUseSeed([R('rand(k)<0.5', '0')])).toBe(true);
    expect(rulesUseSeed([R('rand(k)<0.5', '0', false)])).toBe(false);
    expect(rulesUseBatch([R('', '1/k')])).toBe(false);
    expect(rulesUseBatch([R('', 'pow(k,-u)')])).toBe(true);
    expect(rulesUseBatch([R('k%(3+n)==0', '0')])).toBe(true);
  });

  it('the cycle is a sine-phase additive sum', () => {
    const A = new Float64Array(KMAX + 1);
    A[1] = 1;
    A[3] = -0.5;
    const x = rulesRaw(A);
    for (const i of [0, 100, 512, 1500]) {
      const p = (2 * Math.PI * i) / x.length;
      expect(x[i]).toBeCloseTo(Math.sin(p) - 0.5 * Math.sin(3 * p), 10);
    }
  });
});

const entries = SEED_LIBRARY.filter((e) => e.mode === 'rules');
const prog = (req: SeedRequest) => compileRules(seedRules(req), compileRule);
const req = (id: string, seed = 5, count = 8, rules?: HarmonicRule[]): SeedRequest => ({ entry: seedEntry(id)!, expr: '', params: {}, seed, count, rules });
const peak = (x: ArrayLike<number>) => Math.max(...Array.from(x, Math.abs));

describe('Harmonic rules: the expression whitelist', () => {
  const ok = [
    'k%2==1', '1/k', 'prime(k)', 'k==1 || prime(k)', 'v + 0.3*a(k-1)', 'v + exp(-pow(k-(4+20*u), 2)/6)', 'db(-6)', 'rand()',
    'k>1 && rand(k) < 0.4', '1/(k-6)', 'v/0', 'v*(1-u)', 'k%(3+n)==0', 'k ** 2', '(k & 3) ^ 1 | ~k >> 1 >>> 0', 'k <= 3 ? .5 : 1e-3',
    'k===1', 'k!==2', 'sin(PI*k/K)', 'saw(k/K*2*PI) + noise(k, 0, 0)', 'pnoise(2, u, 4, 0.5)', 'k?.5:1', 'v ?? 0', '',
  ];
  it('the rule language passes (presets, README examples)', () => {
    for (const e of ok) expect(ruleExprError(e), e).toBeNull();
    for (const p of RULES_PRESETS) for (const r of p.rules) expect([ruleExprError(r.when), ruleExprError(r.value)], p.id).toEqual([null, null]);
  });
  it('rejects member access, brackets, braces, strings, keywords, assignment, arrows, ; and unknown names', () => {
    const bad: [string, RegExp][] = [
      ['(globalThis.pwned=(globalThis.pwned||0)+1, v)', /globalThis/],
      ['(()=>{for(;;);})()', /=>|not allowed/],
      ['Math.random()', /Math/],
      ['v.constructor', /member access/],
      ['a["constructor"]', /\[/],
      ['{}', /\{/],
      ["'x'", /'/],
      ['`x`', /`/],
      ['k = 1', /=/],
      ['v += 1', /\+=/],
      ['v **= 2', /\*\*=/],
      ['k >>>= 1', />>>=/],
      ['v ??= 1', /\?\?=/],
      ['v++', /\+\+/],
      ['--v', /--/],
      ['k; 1', /;/],
      ['function(){}', /function/],
      ['new Date', /new/],
      ['this', /this/],
      ['random()', /random/],
      ['0x10', /not a number/],
      ['2k', /not a number/],
      ['1..toString()', /member access|not a number/],
      ['v?.x', /\?\./],
      ['\\u0061', /\\/],
      ['eval("1")', /eval/],
    ];
    for (const [e, re] of bad) expect(ruleExprError(e), e).toMatch(re);
  });
  it('a rejected rule is a per-rule compile error, and nothing is compiled', () => {
    const seen: string[] = [];
    const spy = (e: string) => (seen.push(e), compileRule(e));
    const p = compileRules([R('', '1/k'), R('', '(globalThis.pwned=(globalThis.pwned||0)+1, v)'), R('k.x', 'v')], spy);
    expect(p.errors[0]).toBeUndefined();
    expect(p.errors[1]).toMatch(/^value: unknown name “globalThis”/);
    expect(p.errors[2]).toMatch(/^condition: .*member access/);
    expect(seen).toEqual(['1/k']);
    expect(() => compileRule('(()=>{for(;;);})()')).toThrow(SyntaxError);
    expect((globalThis as { pwned?: number }).pwned).toBeUndefined();
  });
});

describe('Harmonic rules: Seed entries', () => {
  it('every preset is in the library (group Harmonic rules)', () => {
    expect(entries.map((e) => e.id)).toEqual(RULES_PRESETS.map((p) => p.id));
    for (const e of entries) expect(e.cat).toBe('Harmonic rules');
  });

  it('every preset renders finite, non-silent waveforms across a batch', () => {
    for (const e of entries)
      for (const count of [1, 8, 64]) {
        const r = req(e.id, 3, count);
        expect(programError(prog(r)), e.id).toBeNull();
        seedBatch(r, prog(r)).forEach((t, i) => {
          expect(t.data.every(Number.isFinite), `${e.id} #${i}/${count}`).toBe(true);
          expect(peak(t.data), `${e.id} #${i}/${count}`).toBeGreaterThan(0.99);
        });
      }
  });

  it('the Odd harmonics preset is a square wave', () => {
    const t = seedBatch(req('rules-odd', 1, 1), prog(req('rules-odd', 1, 1)))[0];
    const m = harmonicMagnitudes(t.data, 9);
    expect(m[2] / m[1]).toBeLessThan(1e-9);
    expect(m[3] / m[1]).toBeCloseTo(1 / 3, 6);
    expect(m[5] / m[1]).toBeCloseTo(1 / 5, 6);
  });

  it('records the rules in the recipe and re-renders exactly', () => {
    const edited = [R('', '1/k'), R('k%(2+n)==0', 'v*0.2'), R('rand(k)<0.2', '0')];
    for (const r of [req('rules-smear'), req('rules-random', 99, 4), req('rules-comb', 7, 5, edited)]) {
      seedBatch(r, prog(r)).forEach((t) => {
        expect(t.recipe.op).toBe('rules');
        expect(parseRules(t.recipe.params.rules)).toEqual(seedRules(r));
        expect(renderRecipe(t.recipe, { compileRule })).toEqual(t.data);
      });
    }
    const [t] = seedBatch(req('rules-comb', 7, 1, edited), prog(req('rules-comb', 7, 1, edited)));
    expect(t.recipe.params.edited).toBe(true);
    expect(describeRecipe(t.recipe)).toBe('Comb notch (rules, edited)');
    expect(seedBatch(req('rules-comb', 7, 1), prog(req('rules-comb', 7, 1)))[0].recipe.params.edited).toBe(false);
    expect(() => renderRecipe(t.recipe)).toThrow(/rule compiler/);
  });

  it('only rand() / seeded functions make the seed matter', () => {
    expect(seedUsesRandomness(seedEntry('rules-random')!)).toBe(true);
    expect(seedUsesRandomness(seedEntry('rules-odd')!)).toBe(false);
    expect(seedUsesRandomness(seedEntry('rules-odd')!, '', {}, [R('', 'rand(k)')])).toBe(true);
    const a = seedBatch(req('rules-odd', 1, 1), prog(req('rules-odd', 1, 1)))[0].data;
    const b = seedBatch(req('rules-odd', 2, 1), prog(req('rules-odd', 2, 1)))[0].data;
    expect(b).toEqual(a);
  });

  it('a batch sweep via u gives different waveforms', () => {
    const r = req('rules-formant-sweep', 1, 4);
    const b = seedBatch(r, prog(r));
    expect(b[0].data).not.toEqual(b[3].data);
  });

  it('a session round-trips Harmonic rules waveforms (recipe and samples)', () => {
    const m = new AppModel(64);
    const r = req('rules-random', 42, 3, [R('', '1/k'), R('rand(k) < 0.3', '-v')]);
    m.addTables(seedBatch(r, prog(r)));
    const s: SessionState = { model: m.exportState(), ui: {} };
    const bytes = packSessionFile(encodeMeta(s, 1), encodeWaveforms(s.model.timeline));
    const { meta, records } = unpackSessionFile(bytes);
    const out = decodeSession(meta, records).state.model;
    const added = s.model.timeline.slice(-3);
    const back = out.timeline.slice(-3);
    expect(back.map((t) => t.recipe)).toEqual(added.map((t) => t.recipe));
    back.forEach((t, i) => {
      expect(t.data).toEqual(added[i].data);
      expect(renderRecipe(t.recipe, { compileRule })).toEqual(added[i].data);
    });
  });

  it('rulesTable is the shaped rulesRaw of the evaluated amplitudes', () => {
    const p = compileRules([R('', '1/k')], compileRule);
    const t = rulesTable(p, 1, 0, 1);
    expect(t.length).toBe(2048);
    expect(peak(t)).toBeCloseTo(1, 6);
  });
});
