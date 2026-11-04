/**
 * Shape chain steps (UI: ui/shapeTab.ts; chains and the engine: core/shapeChain.ts). Each
 * step maps a working cycle (TABLE_SIZE samples, not normalised: levels carry between
 * steps) to a new one at an amount a ∈ [0, 1]; the engine band-limits after every step.
 * Amount 0 is always the input unchanged (the engine skips the step). DOM-free, seeded.
 */
import { KMAX, TABLE_SIZE } from './constants';
import { lerpDrawing, normalizeDrawing, drawingValue, drawingWeight, type Drawing } from './drawing';
import { fft } from './fft';
import { MUTATION_CHOICES, MUTATION_REV, mutate, mutationUsesSeed, type MutationId } from './mutations';
import { Prng } from './prng';

const N = TABLE_SIZE;

export type DrawOp = 'clip' | 'soft' | 'fold' | 'replace' | 'push' | 'pull' | 'add' | 'mult';
export type Side = 'above' | 'below' | 'both';
export type HarmSetMode = 'keep' | 'remove' | 'add' | 'replace';
export type HarmPhase = 'sine' | 'cos' | 'schroeder' | 'random';
export type HarmSet =
  | { readonly kind: 'multiples'; readonly of: readonly number[] }
  | { readonly kind: 'list'; readonly of: readonly number[] }
  | { readonly kind: 'drawn'; readonly mags: readonly number[] }
  | { readonly kind: 'odd' | 'even' | 'primes' | 'fibonacci' };
export type HarmModKind = 'shift' | 'stretch' | 'tilt' | 'mirror' | 'randomize';
export type LimitMode = 'limit' | 'floor' | 'fit' | 'scale';

interface StepBase {
  /** Stable id (UI selection / reorder; seeds derive from it, so they survive reordering). */
  readonly id: string;
  readonly on: boolean;
  /** 0–1: wet / dry for most steps, the mutation amount for mutations. */
  readonly amount: number;
  /** Set: the amount sweeps from `amount` to this across a batch (u = index / (count − 1)). */
  readonly amountEnd?: number;
  /**
   * Draw steps and Limit to curve: the drawing at the end of a batch. Set = the drawing moves
   * from `draw` to this across a batch (lerpDrawing at u = index / (count − 1)).
   */
  readonly drawEnd?: Drawing;
}
export type ShapeStep = StepBase &
  (
    | { readonly op: 'clip' | 'soft' | 'fold'; readonly side: Side; readonly knee: number; readonly draw: Drawing }
    | { readonly op: 'replace' | 'add' | 'mult'; readonly draw: Drawing }
    | { readonly op: 'push' | 'pull'; readonly radius: number; readonly draw: Drawing }
    | {
        readonly op: 'harmSet';
        readonly mode: HarmSetMode;
        readonly set: HarmSet;
        readonly fundamental: boolean;
        readonly law: number;
        readonly phase: HarmPhase;
      }
    | { readonly op: 'harmMod'; readonly kind: HarmModKind; readonly value: number; readonly range: readonly [number, number] }
    | { readonly op: 'harmLimit'; readonly mode: LimitMode; readonly draw: Drawing }
    // rev: the mutation revision (mutations.ts MUTATION_REV); steps saved without one are revision 1.
    | { readonly op: 'mutation'; readonly mutation: MutationId; readonly rev?: number }
    | { readonly op: 'gain' | 'rotate'; readonly value: number }
    | { readonly op: 'invert' | 'reverse' }
  );
export type StepOp = ShapeStep['op'];

/** Library of step types: group, label, one-line hint, and which view its drawing lives in. */
export const STEP_INFO: readonly { op: StepOp; group: string; label: string; hint: string; draws: 'wave' | 'harm' | null }[] = [
  { op: 'clip', group: 'Draw on waveform', label: 'Hard clip', hint: 'Cuts the wave off at the line', draws: 'wave' },
  { op: 'soft', group: 'Draw on waveform', label: 'Soft clip', hint: 'Clips with a rounded knee', draws: 'wave' },
  { op: 'fold', group: 'Draw on waveform', label: 'Fold', hint: 'Reflects the wave back from the line', draws: 'wave' },
  { op: 'replace', group: 'Draw on waveform', label: 'Replace', hint: 'The drawing becomes the wave where you drew', draws: 'wave' },
  { op: 'push', group: 'Draw on waveform', label: 'Push', hint: 'Moves the wave away from the line, within the radius', draws: 'wave' },
  { op: 'pull', group: 'Draw on waveform', label: 'Pull', hint: 'Draws the wave toward the line, within the radius', draws: 'wave' },
  { op: 'add', group: 'Draw on waveform', label: 'Add', hint: 'Adds the drawing to the wave', draws: 'wave' },
  { op: 'mult', group: 'Draw on waveform', label: 'Multiply', hint: 'Uses the drawing as an amplitude shape', draws: 'wave' },
  { op: 'harmSet', group: 'Harmonics', label: 'Set harmonics', hint: 'Keep, remove, add or replace a set of harmonics', draws: null },
  { op: 'harmMod', group: 'Harmonics', label: 'Modify harmonics', hint: 'Shift, stretch, tilt, mirror or randomize the harmonics', draws: null },
  { op: 'harmLimit', group: 'Harmonics', label: 'Limit to curve', hint: 'Caps, floors, fits or scales the harmonics to a drawn curve', draws: 'harm' },
  { op: 'mutation', group: 'Whole wave', label: 'Mutation', hint: 'Any Mutate mutation at an amount', draws: null },
  { op: 'gain', group: 'Whole wave', label: 'Gain', hint: 'Scales the level, to drive the next step', draws: null },
  { op: 'invert', group: 'Whole wave', label: 'Invert', hint: 'Flips the wave upside down', draws: null },
  { op: 'reverse', group: 'Whole wave', label: 'Reverse', hint: 'Plays the cycle backwards', draws: null },
  { op: 'rotate', group: 'Whole wave', label: 'Rotate', hint: 'Shifts the cycle by a fraction of a period', draws: null },
];
export const stepInfo = (op: StepOp) => STEP_INFO.find((s) => s.op === op)!;
export const DRAW_OPS: readonly DrawOp[] = ['clip', 'soft', 'fold', 'replace', 'push', 'pull', 'add', 'mult'];
export const isDrawOp = (op: string): op is DrawOp => (DRAW_OPS as readonly string[]).includes(op);

/** Level range of waveform drawings (beyond ±1 so driven waves can be clipped). */
export const WAVE_Y: readonly [number, number] = [-4, 4];
/** dB range of harmonic drawings and drawn sets (relative to the strongest harmonic). */
export const HARM_DB: readonly [number, number] = [-60, 0];
export const KNEE_RANGE: readonly [number, number] = [0.01, 0.5];
export const RADIUS_RANGE: readonly [number, number] = [0.05, 1];
export const LAW_RANGE: readonly [number, number] = [0, 3];
export const GAIN_RANGE: readonly [number, number] = [0.25, 8];
export const ROTATE_RANGE: readonly [number, number] = [-0.5, 0.5];
export const MOD_RANGES: Readonly<Record<HarmModKind, readonly [number, number]>> = {
  shift: [-24, 24],
  stretch: [0.5, 2],
  tilt: [-12, 12],
  mirror: [0, 0],
  randomize: [0, 1],
};
const MOD_DEFAULTS: Readonly<Record<HarmModKind, number>> = { shift: 2, stretch: 1.25, tilt: -3, mirror: 0, randomize: 0.3 };
/** Most numbers a harmonic list ("2, 3") holds. */
export const MAX_SET_NUMBERS = 16;

const DEFAULT_WAVE_LINE: Drawing = { tool: 'line', pts: [[0, 0.6], [1, 0.6]] };
const DEFAULT_DRAWS: Readonly<Record<DrawOp, Drawing>> = {
  clip: DEFAULT_WAVE_LINE,
  soft: DEFAULT_WAVE_LINE,
  fold: DEFAULT_WAVE_LINE,
  replace: { tool: 'curve', pts: [[0.05, 0], [0.15, 0.85], [0.3, 0.2]] },
  push: { tool: 'line', pts: [[0, 0.1], [1, 0.1]] },
  pull: { tool: 'line', pts: [[0, 0.1], [1, 0.1]] },
  add: { tool: 'curve', pts: [[0, 0], [0.25, 0.35], [0.5, 0], [0.75, -0.35], [1, 0]] },
  mult: { tool: 'curve', pts: [[0, 1], [0.5, 0.25], [1, 1]] },
};
export const DEFAULT_LIMIT_DRAW: Drawing = { tool: 'line', pts: [[0, -4], [1, -40]] };
export const defaultDrawing = (op: DrawOp): Drawing => DEFAULT_DRAWS[op];

/** A new step of type `op` with its defaults. */
export function newStep(op: StepOp, id: string): ShapeStep {
  const base = { id, on: true, amount: 1 };
  switch (op) {
    case 'clip':
    case 'soft':
    case 'fold':
      return { ...base, op, side: 'both', knee: 0.1, draw: DEFAULT_DRAWS[op] };
    case 'replace':
    case 'add':
    case 'mult':
      return { ...base, op, draw: DEFAULT_DRAWS[op] };
    case 'push':
    case 'pull':
      return { ...base, op, radius: 0.4, draw: DEFAULT_DRAWS[op] };
    case 'harmSet':
      return { ...base, op, mode: 'keep', set: { kind: 'multiples', of: [2, 3] }, fundamental: true, law: 1, phase: 'sine' };
    case 'harmMod':
      return { ...base, op, kind: 'tilt', value: -3, range: [1, KMAX] };
    case 'harmLimit':
      return { ...base, op, mode: 'limit', draw: DEFAULT_LIMIT_DRAW };
    case 'mutation':
      return { ...base, op, mutation: 'smooth', amount: 0.4, rev: MUTATION_REV };
    case 'gain':
      return { ...base, op, value: 2 };
    case 'rotate':
      return { ...base, op, value: 0.25 };
    case 'invert':
    case 'reverse':
      return { ...base, op };
  }
}

// ---------------- normalising untrusted steps ----------------

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const num = (v: unknown, lo: number, hi: number, d: number) => {
  const x = Number(v);
  return Number.isFinite(x) ? clamp(x, lo, hi) : d;
};
const pick = <T extends string>(v: unknown, opts: readonly T[], d: T): T => (opts.includes(v as T) ? (v as T) : d);
const ints = (v: unknown): number[] =>
  Array.isArray(v)
    ? [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= KMAX))].sort((a, b) => a - b).slice(0, MAX_SET_NUMBERS)
    : [];

function normalizeSet(raw: unknown): HarmSet {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  switch (o.kind) {
    case 'multiples':
    case 'list': {
      const of = ints(o.of);
      return { kind: o.kind, of: of.length ? of : [2] };
    }
    case 'drawn': {
      const src = Array.isArray(o.mags) ? o.mags : [];
      return { kind: 'drawn', mags: Array.from({ length: KMAX }, (_, i) => Math.round(num(src[i], HARM_DB[0], HARM_DB[1], HARM_DB[0]) * 100) / 100) };
    }
    case 'odd':
    case 'even':
    case 'primes':
    case 'fibonacci':
      return { kind: o.kind };
    default:
      return { kind: 'multiples', of: [2, 3] };
  }
}

/**
 * A valid step from untrusted data, or null if its op is unknown. Fields are written in a
 * fixed order (canonical JSON for recipes) and numbers clamped; idempotent.
 */
export function normalizeStep(raw: unknown, id: string): ShapeStep | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const op = o.op as StepOp;
  if (!STEP_INFO.some((s) => s.op === op)) return null;
  const d = newStep(op, id) as Record<string, unknown> & ShapeStep;
  const amount = num(o.amount, 0, 1, d.amount);
  const base: StepBase = {
    id,
    on: o.on === undefined ? true : !!o.on,
    amount,
    ...(o.amountEnd !== undefined && o.amountEnd !== null ? { amountEnd: num(o.amountEnd, 0, 1, amount) } : {}),
  };
  const wave = (fb: Drawing) => normalizeDrawing(o.draw, WAVE_Y[0], WAVE_Y[1], fb);
  /** A draw step's end drawing, if it has one (same range; falls back to its start drawing). */
  const end = (draw: Drawing, lo: number, hi: number) =>
    o.drawEnd && typeof o.drawEnd === 'object' ? { drawEnd: normalizeDrawing(o.drawEnd, lo, hi, draw) } : {};
  switch (op) {
    case 'clip':
    case 'soft':
    case 'fold':
      return {
        ...base,
        op,
        side: pick(o.side, ['above', 'below', 'both'] as const, 'both'),
        knee: num(o.knee, KNEE_RANGE[0], KNEE_RANGE[1], 0.1),
        draw: wave(DEFAULT_DRAWS[op]),
        ...end(wave(DEFAULT_DRAWS[op]), WAVE_Y[0], WAVE_Y[1]),
      };
    case 'replace':
    case 'add':
    case 'mult':
      return { ...base, op, draw: wave(DEFAULT_DRAWS[op]), ...end(wave(DEFAULT_DRAWS[op]), WAVE_Y[0], WAVE_Y[1]) };
    case 'push':
    case 'pull':
      return {
        ...base,
        op,
        radius: num(o.radius, RADIUS_RANGE[0], RADIUS_RANGE[1], 0.4),
        draw: wave(DEFAULT_DRAWS[op]),
        ...end(wave(DEFAULT_DRAWS[op]), WAVE_Y[0], WAVE_Y[1]),
      };
    case 'harmSet':
      return {
        ...base,
        op,
        mode: pick(o.mode, ['keep', 'remove', 'add', 'replace'] as const, 'keep'),
        set: normalizeSet(o.set),
        fundamental: o.fundamental === undefined ? true : !!o.fundamental,
        law: num(o.law, LAW_RANGE[0], LAW_RANGE[1], 1),
        phase: pick(o.phase, ['sine', 'cos', 'schroeder', 'random'] as const, 'sine'),
      };
    case 'harmMod': {
      const kind = pick(o.kind, ['shift', 'stretch', 'tilt', 'mirror', 'randomize'] as const, 'tilt');
      const [lo, hi] = MOD_RANGES[kind];
      let value = num(o.value, lo, hi, MOD_DEFAULTS[kind]);
      if (kind === 'shift') value = Math.round(value);
      const r = Array.isArray(o.range) ? o.range : [1, KMAX];
      const k0 = Math.round(num(r[0], 1, KMAX, 1));
      const k1 = Math.round(num(r[1], 1, KMAX, KMAX));
      return { ...base, op, kind, value, range: [Math.min(k0, k1), Math.max(k0, k1)] };
    }
    case 'harmLimit': {
      const draw = normalizeDrawing(o.draw, HARM_DB[0], HARM_DB[1], DEFAULT_LIMIT_DRAW);
      return { ...base, op, mode: pick(o.mode, ['limit', 'floor', 'fit', 'scale'] as const, 'limit'), draw, ...end(draw, HARM_DB[0], HARM_DB[1]) };
    }
    case 'mutation': {
      const ids = MUTATION_CHOICES.map((m) => m.id);
      // A valid later revision is kept; anything else (absent, invalid) is revision 1.
      const rev = typeof o.rev === 'number' && Number.isInteger(o.rev) && o.rev >= 2 && o.rev <= MUTATION_REV ? { rev: o.rev } : {};
      return { ...base, op, mutation: pick(o.mutation, ids, 'smooth'), ...rev };
    }
    case 'gain':
      return { ...base, op, value: num(o.value, GAIN_RANGE[0], GAIN_RANGE[1], 2) };
    case 'rotate':
      return { ...base, op, value: num(o.value, ROTATE_RANGE[0], ROTATE_RANGE[1], 0.25) };
    case 'invert':
    case 'reverse':
      return { ...base, op };
  }
}

/** True if the step's result depends on its seed. */
export function stepUsesSeed(s: ShapeStep): boolean {
  if (s.op === 'mutation') return mutationUsesSeed(s.mutation);
  if (s.op === 'harmSet') return (s.mode === 'add' || s.mode === 'replace') && s.phase === 'random';
  if (s.op === 'harmMod') return s.kind === 'randomize';
  return false;
}

// ---------------- harmonic sets ----------------

const FIB = new Set([1, 2, 3, 5, 8, 13, 21, 34, 55]);
const isPrime = (n: number) => {
  if (n < 2) return false;
  for (let d = 2; d * d <= n; d++) if (n % d === 0) return false;
  return true;
};

/** Membership of harmonics 1..KMAX (index k) in a set step's set, with the fundamental rule applied. */
export function harmonicSet(s: Extract<ShapeStep, { op: 'harmSet' }>): Uint8Array {
  const out = new Uint8Array(KMAX + 1);
  const set = s.set;
  for (let k = 1; k <= KMAX; k++) {
    let m: boolean;
    switch (set.kind) {
      case 'multiples':
        m = set.of.some((b) => k % b === 0);
        break;
      case 'list':
        m = set.of.includes(k);
        break;
      case 'drawn':
        m = set.mags[k - 1] > HARM_DB[0];
        break;
      case 'odd':
        m = k % 2 === 1;
        break;
      case 'even':
        m = k % 2 === 0;
        break;
      case 'primes':
        m = isPrime(k);
        break;
      case 'fibonacci':
        m = FIB.has(k);
        break;
    }
    out[k] = (k === 1 ? s.fundamental : m) ? 1 : 0;
  }
  return out;
}

// ---------------- the maths ----------------

/** Smooth min / max with knee k (log-sum-exp; exact min / max as k → 0). */
const smin = (x: number, c: number, k: number) => Math.min(x, c) - k * Math.log1p(Math.exp(-Math.abs(x - c) / k));
const smax = (x: number, c: number, k: number) => Math.max(x, c) + k * Math.log1p(Math.exp(-Math.abs(x - c) / k));
/** Triangle fold of u into [−1, 1] (identity inside). */
const triFold = (u: number) => {
  const v = (((u + 1) % 4) + 4) % 4;
  return v < 2 ? v - 1 : 3 - v;
};
/** Threshold floor for mirrored ("both") ops, so |c| ≈ 0 doesn't divide by zero. */
const MIN_C = 0.02;

/** op(x, c) for one sample of a draw step. */
export function drawOp(s: Extract<ShapeStep, { draw: Drawing }>, x: number, c: number): number {
  switch (s.op) {
    case 'clip': {
      if (s.side === 'above') return Math.min(x, c);
      if (s.side === 'below') return Math.max(x, c);
      const cc = Math.max(MIN_C, Math.abs(c));
      return clamp(x, -cc, cc);
    }
    case 'soft': {
      const k = s.knee;
      if (s.side === 'above') return smin(x, c, k);
      if (s.side === 'below') return smax(x, c, k);
      const cc = Math.max(MIN_C, Math.abs(c));
      return smax(smin(x, cc, k), -cc, k);
    }
    case 'fold': {
      if (s.side === 'above') return x > c ? 2 * c - x : x;
      if (s.side === 'below') return x < c ? 2 * c - x : x;
      const cc = Math.max(MIN_C, Math.abs(c));
      return cc * triFold(x / cc);
    }
    case 'replace':
      return c;
    case 'push': {
      const d = x - c;
      const ad = Math.abs(d);
      if (ad >= s.radius) return x;
      const f = (1 - ad / s.radius) ** 2;
      return x + 2 * d * f;
    }
    case 'pull': {
      const d = x - c;
      const ad = Math.abs(d);
      if (ad >= s.radius) return x;
      const f = (1 - ad / s.radius) ** 2;
      return x - d * f;
    }
    case 'add':
      return x + c;
    case 'mult':
      return x * c;
    case 'harmLimit':
      return x;
  }
}

function spectrum(x: ArrayLike<number>): { re: Float64Array; im: Float64Array } {
  const re = Float64Array.from(x);
  const im = new Float64Array(N);
  fft(re, im, false);
  return { re, im };
}

/**
 * Bins 0..KMAX back to a real cycle (everything above KMAX dropped). DC is kept: it carries
 * between steps like the level does (so an offset then a clip is an asymmetric clip); the
 * chain's finish (shape()) removes it.
 */
export function fromSpectrum(re: Float64Array, im: Float64Array): Float64Array {
  im[0] = 0;
  for (let k = KMAX + 1; k <= N / 2; k++) {
    re[k] = 0;
    im[k] = 0;
  }
  for (let k = 1; k < N / 2; k++) {
    re[N - k] = re[k];
    im[N - k] = -im[k];
  }
  fft(re, im, true);
  return re;
}

/** Harmonics above KMAX dropped (what is heard); level and DC kept (see fromSpectrum). */
export function bandLimit(x: ArrayLike<number>): Float64Array {
  const { re, im } = spectrum(x);
  return fromSpectrum(re, im);
}

function peak(x: ArrayLike<number>): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

/**
 * The circular shift shape() would apply to align x (radians of the fundamental: harmonic k
 * gains phase k·delta): the lowest harmonic with meaningful energy goes to sine phase.
 */
function alignDelta(x: ArrayLike<number>): number {
  const { re, im } = spectrum(x);
  let mx = 0;
  for (let k = 1; k <= KMAX; k++) mx = Math.max(mx, Math.hypot(re[k], im[k]));
  for (let k = 1; k <= KMAX; k++) if (Math.hypot(re[k], im[k]) > mx * 1e-6) return (-Math.PI / 2 - Math.atan2(im[k], re[k])) / k;
  return 0;
}

/** x shifted circularly by delta radians of the fundamental (band-limited to KMAX). */
function rotate(x: ArrayLike<number>, delta: number): Float64Array {
  const { re, im } = spectrum(x);
  for (let k = 1; k <= KMAX; k++) {
    const c = Math.cos(k * delta);
    const sn = Math.sin(k * delta);
    const r = re[k] * c - im[k] * sn;
    im[k] = re[k] * sn + im[k] * c;
    re[k] = r;
  }
  return fromSpectrum(re, im);
}

/** Phase of a built harmonic k (in cosine terms: sine phase = −π/2). */
function builtPhase(phase: HarmPhase, k: number, rand: Prng): number {
  switch (phase) {
    case 'sine':
      return -Math.PI / 2;
    case 'cos':
      return 0;
    case 'schroeder':
      return -Math.PI / 2 - (Math.PI * k * (k - 1)) / KMAX;
    case 'random':
      return rand.next() * 2 * Math.PI;
  }
}

/** Harmonic steps: bins 1..KMAX of the input → target bins, then a complex blend by a. */
/** A step's drawing at batch position u (its start drawing, or on the way to its end drawing). */
export function stepDrawing(s: Extract<ShapeStep, { draw: Drawing }>, u: number): Drawing {
  return s.drawEnd ? lerpDrawing(s.draw, s.drawEnd, u) : s.draw;
}

function harmonicStep(s: ShapeStep, x: Float64Array, a: number, seed: number, u: number): Float64Array {
  const { re, im } = spectrum(x);
  const tr = new Float64Array(KMAX + 1);
  const ti = new Float64Array(KMAX + 1);
  let mx = 0;
  for (let k = 1; k <= KMAX; k++) mx = Math.max(mx, Math.hypot(re[k], im[k]));
  const rand = new Prng(seed);
  const mag = (k: number) => Math.hypot(re[k], im[k]);
  switch (s.op) {
    case 'harmSet': {
      const set = harmonicSet(s);
      // Built harmonics are relative to the strongest input harmonic (or unit level from silence).
      const A1 = mx > 0 ? mx : N / 2;
      for (let k = 1; k <= KMAX; k++) {
        const inSet = set[k] === 1;
        if (s.mode === 'keep' || s.mode === 'remove') {
          const keep = s.mode === 'keep' ? inSet : !inSet;
          tr[k] = keep ? re[k] : 0;
          ti[k] = keep ? im[k] : 0;
          continue;
        }
        const ph = builtPhase(s.phase, k, rand);
        const amp = !inSet ? 0 : s.set.kind === 'drawn' ? A1 * Math.pow(10, s.set.mags[k - 1] / 20) : A1 * Math.pow(k, -s.law);
        const br = amp * Math.cos(ph);
        const bi = amp * Math.sin(ph);
        tr[k] = s.mode === 'replace' ? br : re[k] + br;
        ti[k] = s.mode === 'replace' ? bi : im[k] + bi;
      }
      break;
    }
    case 'harmMod': {
      const [k0, k1] = s.range;
      const inR = (k: number) => k >= k0 && k <= k1;
      for (let k = 1; k <= KMAX; k++) {
        tr[k] = re[k];
        ti[k] = im[k];
      }
      if (s.kind === 'tilt') {
        for (let k = 1; k <= KMAX; k++) {
          if (!inR(k)) continue;
          const g = Math.pow(10, (s.value * Math.log2(k / k0)) / 20);
          tr[k] *= g;
          ti[k] *= g;
        }
      } else if (s.kind === 'shift' || s.kind === 'stretch') {
        // Harmonics in range (never the fundamental) move; what lands outside 2..KMAX is dropped.
        const lo = Math.max(2, k0);
        for (let k = lo; k <= k1; k++) {
          tr[k] -= re[k];
          ti[k] -= im[k];
        }
        for (let k = lo; k <= k1; k++) {
          const j = s.kind === 'shift' ? k + s.value : Math.round(1 + (k - 1) * s.value);
          if (j < 2 || j > KMAX) continue;
          tr[j] += re[k];
          ti[j] += im[k];
        }
      } else if (s.kind === 'mirror') {
        // Magnitudes reversed within the range, each harmonic keeping its own phase.
        for (let k = k0; k <= k1; k++) {
          const m = mag(k);
          const target = mag(k0 + k1 - k);
          if (m > 1e-12) {
            tr[k] = (re[k] / m) * target;
            ti[k] = (im[k] / m) * target;
          } else {
            tr[k] = 0;
            ti[k] = -target;
          }
        }
      } else {
        // Randomize: seeded magnitude scaling (±value) and phase offsets (±value·π).
        for (let k = 1; k <= KMAX; k++) {
          const g = Math.max(0, 1 + s.value * rand.bipolar());
          const dp = s.value * Math.PI * rand.bipolar();
          if (!inR(k)) continue;
          const c = Math.cos(dp);
          const sn = Math.sin(dp);
          tr[k] = g * (re[k] * c - im[k] * sn);
          ti[k] = g * (re[k] * sn + im[k] * c);
        }
      }
      break;
    }
    case 'harmLimit': {
      const limitDraw = stepDrawing(s, u);
      for (let k = 1; k <= KMAX; k++) {
        tr[k] = re[k];
        ti[k] = im[k];
        const c = drawingValue(limitDraw, (k - 1) / (KMAX - 1));
        if (c === null || mx === 0) continue;
        const m = mag(k);
        const present = m > mx * 1e-4;
        const L = 20 * Math.log10(Math.max(m, 1e-300) / mx);
        let g = 1;
        if (s.mode === 'limit') g = L > c ? Math.pow(10, (c - L) / 20) : 1;
        else if (s.mode === 'floor') g = present && L < c ? Math.pow(10, (c - L) / 20) : 1;
        else if (s.mode === 'fit') g = present ? Math.pow(10, (c - L) / 20) : 1;
        else g = Math.pow(10, c / 20);
        tr[k] *= g;
        ti[k] *= g;
      }
      break;
    }
    default:
      return x;
  }
  for (let k = 1; k <= KMAX; k++) {
    re[k] += a * (tr[k] - re[k]);
    im[k] += a * (ti[k] - im[k]);
  }
  return fromSpectrum(re, im);
}

/**
 * One step at amount a (> 0) on the working cycle x (TABLE_SIZE samples). Returns a new
 * array (not band-limited: the engine does that). `seed` is the step's own seed.
 */
export function applyStep(s: ShapeStep, x: Float64Array, a: number, seed: number, u = 0): Float64Array {
  if ('draw' in s && s.op !== 'harmLimit') {
    const d = stepDrawing(s, u);
    const y = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const t = i / N;
      const c = drawingValue(d, t);
      const w = c === null ? 0 : drawingWeight(d, t);
      y[i] = w > 0 ? x[i] + a * w * (drawOp(s, x[i], c!) - x[i]) : x[i];
    }
    return y;
  }
  switch (s.op) {
    case 'gain': {
      const g = 1 + (s.value - 1) * a;
      return x.map((v) => v * g);
    }
    case 'invert':
      return x.map((v) => v * (1 - 2 * a));
    case 'reverse':
      return x.map((v, i) => v + a * (x[(N - i) % N] - v));
    case 'rotate': {
      const { re, im } = spectrum(x);
      const d = -2 * Math.PI * s.value * a;
      for (let k = 1; k <= KMAX; k++) {
        const c = Math.cos(k * d);
        const sn = Math.sin(k * d);
        const r = re[k] * c - im[k] * sn;
        im[k] = re[k] * sn + im[k] * c;
        re[k] = r;
      }
      return fromSpectrum(re, im);
    }
    case 'mutation': {
      // Mutations expect a finished table (normalised, fundamental in sine phase) and return
      // one: the cycle is aligned and normalised first, then the result is rotated back and
      // rescaled, so the chain keeps its own phase (a Rotate or a drawing before it stays put).
      const p = peak(x);
      if (p < 1e-12) return Float64Array.from(x);
      const d = alignDelta(x);
      const aligned = rotate(x, d);
      const y = mutate(s.mutation, Float32Array.from(aligned, (v) => v / p), a, seed, {}, s.rev ?? 1);
      return rotate(Float64Array.from(y, (v) => v * p), -d);
    }
    default:
      return harmonicStep(s, x, a, seed, u);
  }
}
