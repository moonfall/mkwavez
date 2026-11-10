/**
 * Harmonic rules: an additive generator defined by an ordered list of rules, each
 * (condition, value), both expressions in the formula language. Harmonic amplitudes
 * (k = 1..KMAX, linear; negative = phase-inverted) start at 0 (Seed) or at the input's
 * magnitudes (the Shape step "Rules", core/shapeSteps.ts); every enabled rule is then one
 * pass over k = 1..KMAX in ascending order, updating the amplitudes in place: where the
 * condition is non-zero (an empty condition = always), the harmonic takes the value.
 *
 * Variables in both expressions: k (harmonic number), K (= KMAX), v (this harmonic's
 * current value), a(j) (harmonic j's current value: for j < k already updated by this
 * rule, for j > k as earlier rules left it; out of range → 0), n and u (batch index /
 * position), prime(x) (1 if round(x) is prime), db(x) (dB → linear), rand(x = k) (seeded,
 * 0..1, fixed per seed, rule and x), pnoise(freq, z, oct, pers) (loop-seamless noise read
 * at phase 2π(k−1)/K), noise(x, y, z), every Math member and the waveform functions.
 *
 * Like formulas, the core never parses expressions: a host passes a RuleCompiler
 * (browser: src/browser/formulaEval.ts compileRule). Rules are plain data; recipes store
 * them as canonical JSON (rulesJson), so a waveform re-renders exactly.
 */
import { KMAX, TABLE_SIZE } from '../constants';
import { fft } from '../fft';
import { noise3, noiseField, pnoiseAt } from '../perlin';
import { deriveSeed } from '../prng';
import { shape } from '../shape';
import { FormulaAborted, FormulaError, type PNoise } from './formula';
import { batchU } from './perlin';
import { isPrime } from './series';
import { WAVE_FUNCTION_NAMES, waveFunctions, type WaveFunctions } from './waveFunctions';

export interface HarmonicRule {
  /** Condition (empty = always). */
  readonly when: string;
  /** The harmonic's new value where the condition holds. */
  readonly value: string;
  readonly on: boolean;
}

/** Most rules in a list. */
export const MAX_RULES = 16;
/** Longest expression (characters). */
export const MAX_RULE_EXPR = 400;

/** a(j): harmonic j's current value (0 out of range). */
export type RuleRead = (j: number) => number;

/**
 * A compiled rule expression: k, K, v, a(j), n, u, then the helpers (prime, db, rand,
 * pnoise, noise) and the waveform functions bound to this render's seed.
 */
export type RuleFn = (
  k: number,
  K: number,
  v: number,
  a: RuleRead,
  n: number,
  u: number,
  prime: (x: number) => number,
  db: (x: number) => number,
  rand: (x?: number) => number,
  pnoise: PNoise,
  noise: (x: number, y: number, z: number) => number,
  fx: WaveFunctions,
) => unknown;

export type RuleCompiler = (expr: string) => RuleFn;

/** A rule failed: `rule` is its index in the list (0-based; messages say "Rule 1"). */
export class RuleError extends FormulaError {
  constructor(
    readonly rule: number,
    message: string,
  ) {
    super(`Rule ${rule + 1}: ${message}`);
  }
}

/** The variables and helpers a rule expression may name. */
export const RULE_VARIABLES: readonly string[] = ['k', 'K', 'v', 'a', 'n', 'u', 'prime', 'db', 'rand', 'pnoise', 'noise'];
/** The Math members a rule may name (Math.random is left out: rules must re-render exactly). */
export const RULE_MATH: readonly string[] = [
  'abs', 'acos', 'acosh', 'asin', 'asinh', 'atan', 'atan2', 'atanh', 'cbrt', 'ceil', 'clz32', 'cos', 'cosh', 'exp', 'expm1',
  'floor', 'fround', 'hypot', 'imul', 'log', 'log10', 'log1p', 'log2', 'max', 'min', 'pow', 'round', 'sign', 'sin', 'sinh',
  'sqrt', 'tan', 'tanh', 'trunc', 'E', 'LN10', 'LN2', 'LOG10E', 'LOG2E', 'PI', 'SQRT1_2', 'SQRT2',
];
const RULE_NAMES = new Set<string>([...RULE_VARIABLES, ...RULE_MATH, ...WAVE_FUNCTION_NAMES]);
/** Operators a rule may use, longest first (no assignment, no ++ / --, no arrows). */
const RULE_OPS = ['>>>', '===', '!==', '**', '==', '!=', '<=', '>=', '&&', '||', '??', '<<', '>>', '+', '-', '*', '/', '%', '<', '>', '!', '~', '&', '|', '^', '?', ':', '(', ')', ','];
const REJECTED_OPS = ['=>', '++', '--', '?.'];
/** Operators that, followed by =, assign. */
const ASSIGNING = ['+', '-', '*', '/', '%', '**', '<<', '>>', '>>>', '&', '|', '^', '&&', '||', '??'];
const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const NAME = /^[A-Za-z_$][\w$]*/;

/**
 * Why a rule expression is not allowed, or null. Expressions come from imports, sessions and
 * recipes, and the browser compiles them as JavaScript, so only a small language passes:
 * numbers, the arithmetic / comparison / logical / bitwise / ternary operators, parentheses,
 * commas and the names in scope (RULE_VARIABLES, RULE_MATH, the waveform functions). No member
 * access, brackets, braces, strings, keywords, assignment, ++ / --, arrows or `;` — so no loops
 * or function definitions, and nothing outside the scope can be reached. compileRules checks
 * every expression before compiling it (and the browser compiler checks again).
 */
export function ruleExprError(expr: string): string | null {
  let i = 0;
  while (i < expr.length) {
    const rest = expr.slice(i);
    const ws = /^\s+/.exec(rest);
    if (ws) {
      i += ws[0].length;
      continue;
    }
    const num = NUMBER.exec(rest);
    if (num) {
      // A name straight after a number (0x10, 1e, 2k) isn't a number.
      if (NAME.test(rest.slice(num[0].length))) return `“${rest.slice(0, num[0].length + 1)}” is not a number`;
      i += num[0].length;
      continue;
    }
    const name = NAME.exec(rest);
    if (name) {
      if (!RULE_NAMES.has(name[0])) return `unknown name “${name[0]}”`;
      i += name[0].length;
      continue;
    }
    const bad = REJECTED_OPS.find((o) => rest.startsWith(o) && !(o === '?.' && /^\?\.\d/.test(rest)));
    if (bad) return `“${bad}” is not allowed`;
    const op = RULE_OPS.find((o) => rest.startsWith(o));
    if (op) {
      // Compound assignment (+=, **=, >>>=, ??=, …); a lone = is caught below.
      if (expr[i + op.length] === '=' && ASSIGNING.includes(op)) return `“${op}=” is not allowed`;
      i += op.length;
      continue;
    }
    const ch = rest[0];
    return ch === '.' ? '“.” is not allowed (no member access)' : `“${ch}” is not allowed`;
  }
  return null;
}

const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, MAX_RULE_EXPR) : '');

/**
 * A valid rule list from untrusted data (recipes, chains, imports): at most MAX_RULES,
 * expressions as strings (trimmed of nothing, cut at MAX_RULE_EXPR), fields in a fixed
 * order (canonical JSON). Idempotent.
 */
export function normalizeRules(raw: unknown): HarmonicRule[] {
  if (!Array.isArray(raw)) return [];
  const out: HarmonicRule[] = [];
  for (const r of raw) {
    if (out.length >= MAX_RULES) break;
    const o = r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
    out.push({ when: str(o.when), value: str(o.value), on: o.on === undefined ? true : !!o.on });
  }
  return out;
}

/** Canonical JSON of a rule list (what recipes store). */
export const rulesJson = (rules: readonly HarmonicRule[]) => JSON.stringify(normalizeRules(rules));

/** The rule list in a recipe's JSON (empty if unreadable). */
export function parseRules(json: unknown): HarmonicRule[] {
  if (typeof json !== 'string') return [];
  try {
    return normalizeRules(JSON.parse(json));
  } catch {
    return [];
  }
}

/** The enabled rules' expressions, one per line (search, seed / batch detection). */
export const rulesText = (rules: readonly HarmonicRule[]) =>
  rules
    .filter((r) => r.on)
    .map((r) => `${r.when}\n${r.value}`)
    .join('\n');

/** Calls that make a rule depend on the seed: rand(), pnoise() and the seeded waveform functions. */
const SEEDED = /\b(rand|pnoise|perlin|ca|ks|additive|rd|life|spline|supersaw|converge)\s*\(/;
/** True if the enabled rules use the seed. */
export const rulesUseSeed = (rules: readonly HarmonicRule[]) => SEEDED.test(rulesText(rules));
/** True if the enabled rules read the batch position (n or u), so a batch gives different waveforms. */
export const rulesUseBatch = (rules: readonly HarmonicRule[]) => /\b[nu]\b/.test(rulesText(rules));

export interface CompiledRule {
  /** null = an empty condition (always). */
  readonly when: RuleFn | null;
  readonly value: RuleFn;
}

/** A rule list compiled: per rule its functions (null if disabled or it didn't compile) and compile error. */
export interface RuleProgram {
  readonly rules: readonly HarmonicRule[];
  readonly compiled: readonly (CompiledRule | null)[];
  /** Compile errors by rule (enabled rules only; the UI shows them on the row). */
  readonly errors: readonly (string | undefined)[];
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Compile every enabled rule; a rule that doesn't compile records its error (see programError). */
export function compileRules(list: readonly HarmonicRule[], compile: RuleCompiler): RuleProgram {
  // Normalised, so the program (and the recipe made from it) is exactly what renders.
  const rules = normalizeRules(list);
  const compiled: (CompiledRule | null)[] = [];
  const errors: (string | undefined)[] = [];
  for (const r of rules) {
    if (!r.on) {
      compiled.push(null);
      errors.push(undefined);
      continue;
    }
    let part = 'value';
    try {
      if (!r.value.trim()) throw new SyntaxError('the value is empty');
      // Validate both before compiling either: nothing unvalidated reaches the compiler.
      part = 'condition';
      const whenErr = ruleExprError(r.when);
      if (whenErr) throw new SyntaxError(whenErr);
      part = 'value';
      const valueErr = ruleExprError(r.value);
      if (valueErr) throw new SyntaxError(valueErr);
      part = 'condition';
      const when = r.when.trim() ? compile(r.when) : null;
      part = 'value';
      compiled.push({ when, value: compile(r.value) });
      errors.push(undefined);
    } catch (e) {
      compiled.push(null);
      errors.push(`${part}: ${errText(e)}`);
    }
  }
  return { rules, compiled, errors };
}

/** The first compile error of a program ("Rule 2: value: …"), or null when every enabled rule compiled. */
export function programError(p: RuleProgram): string | null {
  const i = p.errors.findIndex((e) => e !== undefined);
  return i < 0 ? null : `Rule ${i + 1}: ${p.errors[i]}`;
}

/** Amplitudes after the rules, and which rule set each harmonic last. */
export interface RulesResult {
  /** Index = harmonic (0 unused). */
  readonly amps: Float64Array;
  /** Index of the last rule that matched harmonic k (−1: none). */
  readonly last: Int16Array;
}

/** abort() is polled every this many harmonics. */
const ABORT_STRIDE = 8;

/**
 * Run the rules on starting amplitudes `init` (index = harmonic; omitted = all 0) for batch
 * table `index` of `count`. Throws RuleError when a rule didn't compile, throws or gives a
 * non-finite value; FormulaAborted when the optional `abort()` returns true.
 */
export function evalRules(
  prog: RuleProgram,
  init: ArrayLike<number> | null,
  seed: number,
  index: number,
  count: number,
  abort?: () => boolean,
): RulesResult {
  const amps = new Float64Array(KMAX + 1);
  if (init) for (let k = 1; k <= KMAX; k++) amps[k] = init[k] ?? 0;
  const last = new Int16Array(KMAX + 1).fill(-1);
  const bad = prog.errors.findIndex((e) => e !== undefined);
  if (bad >= 0) throw new RuleError(bad, String(prog.errors[bad]));
  const u = batchU(index, count);
  const field = noiseField(seed >>> 0);
  let k = 1;
  const pnoise: PNoise = (freq = 2, z = 0, octaves = 4, persistence = 0.5) =>
    pnoiseAt(field, (2 * Math.PI * (k - 1)) / KMAX, freq, z || 0, octaves, persistence);
  const fx = waveFunctions(seed >>> 0, undefined, () => {
    if (abort && abort()) throw new FormulaAborted('stopped in a waveform function');
  });
  const a: RuleRead = (j) => {
    const i = Math.round(j);
    return i >= 1 && i <= KMAX ? amps[i] : 0;
  };
  const prime = (x: number) => (isPrime(Math.round(x)) ? 1 : 0);
  const db = (x: number) => Math.pow(10, x / 20);
  for (let ri = 0; ri < prog.compiled.length; ri++) {
    const c = prog.compiled[ri];
    if (!c) continue;
    const ruleSeed = deriveSeed(seed >>> 0, 0x52554c45 + ri);
    const rand = (x?: number) => deriveSeed(ruleSeed, Math.round((x ?? k) * 1024) | 0) / 4294967296;
    for (k = 1; k <= KMAX; k++) {
      if (abort && k % ABORT_STRIDE === 1 && abort()) throw new FormulaAborted(`stopped at rule ${ri + 1}`);
      let cond = 1;
      let val: number;
      try {
        if (c.when) cond = Number(c.when(k, KMAX, amps[k], a, index, u, prime, db, rand, pnoise, noise3, fx));
        if (!Number.isFinite(cond)) throw new RuleError(ri, `the condition is not a number at k = ${k}`);
        if (cond === 0) continue;
        val = Number(c.value(k, KMAX, amps[k], a, index, u, prime, db, rand, pnoise, noise3, fx));
      } catch (e) {
        if (e instanceof FormulaAborted || e instanceof RuleError) throw e;
        throw new RuleError(ri, `${errText(e)} (k = ${k})`);
      }
      if (!Number.isFinite(val)) throw new RuleError(ri, `non-finite value at k = ${k}`);
      amps[k] = val;
      last[k] = ri;
    }
  }
  return { amps, last };
}

/** The raw cycle (before shape()) of amplitudes A (index = harmonic): Σ A_k·sin(k·p), sine phase like the Additive designer. */
export function rulesRaw(A: ArrayLike<number>): Float64Array {
  const N = TABLE_SIZE;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let k = 1; k <= KMAX; k++) {
    // A·sin(kθ) = A·(e^{ikθ} − e^{−ikθ}) / 2i: bin k = −i·N·A/2, bin N−k its conjugate.
    im[k] = (-N * (A[k] ?? 0)) / 2;
    im[N - k] = -im[k];
  }
  fft(re, im, true);
  return re;
}

/** Table `index` of a Harmonic rules batch (shaped). Throws like evalRules. */
export function rulesTable(prog: RuleProgram, seed: number, index: number, count: number, abort?: () => boolean): Float32Array {
  return shape(rulesRaw(evalRules(prog, null, seed, index, count, abort).amps));
}

/** A Seed preset: a named rule list (library group "Harmonic rules"). */
export interface RulesPreset {
  readonly id: string;
  readonly name: string;
  readonly about: string;
  readonly rules: readonly HarmonicRule[];
}

const R = (when: string, value: string): HarmonicRule => ({ when, value, on: true });

/**
 * Starting points; each renders a finite, non-silent waveform at every batch position, and
 * (like the formula presets) uses n or u so a batch sweeps.
 */
export const RULES_PRESETS: readonly RulesPreset[] = [
  {
    id: 'rules-odd',
    name: 'Odd harmonics',
    about: 'Odd harmonics at 1/k (a square wave); the even ones fade in across the batch, ending at a saw.',
    rules: [R('k%2==1', '1/k'), R('k%2==0', 'u/k')],
  },
  {
    id: 'rules-all',
    name: 'All harmonics',
    about: 'Every harmonic at 1/k (a saw), darkening across the batch.',
    rules: [R('', 'pow(k, -(1+u))')],
  },
  {
    id: 'rules-primes',
    name: 'Primes',
    about: 'The fundamental and the prime harmonics at 1/k, brightening across the batch.',
    rules: [R('k==1', '1'), R('prime(k)', 'pow(k, -(1-0.5*u))')],
  },
  {
    id: 'rules-comb',
    name: 'Comb notch',
    about: 'A saw with every (3+n)th harmonic removed: the notches spread out across the batch.',
    rules: [R('', '1/k'), R('k%(3+n)==0', '0')],
  },
  {
    id: 'rules-smear',
    name: 'Upward smear',
    about: 'A recurrence: each harmonic adds a share of the one below it (already updated), smearing energy upward; the share grows across the batch.',
    rules: [R('k<=3', '1/k'), R('k>1', 'v + (0.3+0.6*u)*a(k-1)')],
  },
  {
    id: 'rules-formant',
    name: 'Formant',
    about: 'A soft saw plus a resonance around harmonic 8 that widens across the batch.',
    rules: [R('', '0.3/k'), R('', 'v + exp(-pow(k-8, 2)/(2+14*u))')],
  },
  {
    id: 'rules-formant-sweep',
    name: 'Formant sweep',
    about: 'The resonance moves from harmonic 4 to 24 across the batch (u).',
    rules: [R('', '0.3/k'), R('', 'v + exp(-pow(k-(4+20*u), 2)/6)')],
  },
  {
    id: 'rules-random',
    name: 'Random partials',
    about: 'A saw (darkening across the batch) with a seeded random 40% of its harmonics above the fundamental removed (Reroll for another).',
    rules: [R('', 'pow(k, -(1+0.5*u))'), R('k>1 && rand(k) < 0.4', '0')],
  },
];
