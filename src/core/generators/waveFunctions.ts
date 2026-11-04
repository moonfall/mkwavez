/**
 * Waveform functions for formulas: the basic waves (sine, tri, saw, square, pulse) and one
 * function per parameter mode (perlin, ca, dyn, ks, additive, seq, rd, life, spline, glyph).
 * Each takes a phase x in radians first (`saw(2*p)`, `ca(p + u, 30, 32, n)`), then the
 * mode's arguments; seeded ones take the render's seed unless given an explicit last one.
 *
 * Every function returns its generator's own cycle *before* shape() (the raw values shape()
 * then makes DC-free, band-limited, phase-aligned and peak-normalised), so a lone call at
 * x = p renders bit-identically to the library entry: `saw(p)` is the Saw preset, `ca(p,
 * 30, 32, n)` the Cellular automaton batch. Levels are each generator's own (saw peaks ≈
 * 1.85, square ≈ 0.93, tri ≈ 1.23, sine 1; CA ±1; Life 0/1 or cell counts; …).
 *
 * Sampling at x:
 *  - On the 2048-sample grid (x·2048/2π within 1e-9 of an integer — p, 2p, p + 2πk/2048,
 *    …) the generator's sample itself, so grid phases are exact.
 *  - Between grid points: sine / tri / saw / square evaluate their KMAX-harmonic Fourier
 *    sum in closed form (the true band-limited value at any phase); pulse is the naive
 *    pulse the Pulse preset band-limits (+1 while x/2π mod 1 < width); perlin is evaluated
 *    directly (loop-seamless noise at that phase); the whole-cycle generators interpolate
 *    their cycle with a 4-point Catmull-Rom cubic (exact at grid points, continuous; their
 *    cycles are ≥ 14× oversampled for 72 harmonics, and shape() band-limits the result).
 *
 * Whole-cycle generators run once per distinct argument set per table render (a bounded LRU
 * memo, plus a last-call fast path), so per-sample evaluation is a cache hit and a lookup.
 */
import { KMAX, TABLE_SIZE } from '../constants';
import { noiseField, pnoiseAt, type NoiseField } from '../perlin';
import { additiveAmpsAt, designerRaw } from './additive';
import { additiveRaw, sawAmp, squareAmp, triAmp } from './basic';
import { caRawGenerations } from './ca';
import { dynamicalRaw } from './dynamical';
import { contourPoints, glyphRaw } from './glyph';
import { karplusRaw } from './karplus';
import { lifeRaw } from './life';
import { rdRaw } from './reactionDiffusion';
import { sequenceRaw, sequenceValuesAt } from './sequences';
import { SPLINE_MAX_POINTS, splinePointsAt, splineRaw } from './spline';

type Arg = number | string | undefined;

export interface WaveFunctions {
  sine(x: number): number;
  tri(x: number): number;
  saw(x: number): number;
  square(x: number): number;
  pulse(x: number, width?: number): number;
  perlin(x: number, freq?: number, z?: number, oct?: number, pers?: number, seed?: number): number;
  ca(x: number, rule?: number, cells?: number, gen?: number, seed?: number): number;
  dyn(x: number, map?: number, control?: number, iters?: number, spread?: number, output?: number): number;
  ks(x: number, passes?: number, damping?: number, pos?: number, length?: number, excite?: number, seed?: number): number;
  additive(x: number, slope?: number, balance?: number, move?: number, phase?: number, ...formantsAndSeed: number[]): number;
  seq(x: number, source?: number, steps?: number, smoothing?: number, pos?: number, pulses?: number): number;
  rd(x: number, system?: number, step?: number, cells?: number, spots?: number, feed?: number, kill?: number, seed?: number): number;
  life(x: number, rule?: number, read?: number, size?: number, density?: number, gen?: number, seed?: number): number;
  spline(x: number, points?: number, kind?: number, tension?: number, jitter?: number, seed?: number): number;
  glyph(x: number, contour?: string, skew?: number): number;
}

export type WaveFunctionName = keyof WaveFunctions;

/** One line of the formula reference (README, Seed legend). */
export interface WaveFunctionDoc {
  readonly name: WaveFunctionName;
  /** Signature, e.g. "pulse(x, width)". */
  readonly sig: string;
  readonly about: string;
}

export const WAVE_FUNCTION_DOCS: readonly WaveFunctionDoc[] = [
  { name: 'sine', sig: 'sine(x)', about: 'sine (the Sine preset)' },
  { name: 'tri', sig: 'tri(x)', about: 'band-limited triangle, odd harmonics 1/k² (the Triangle preset)' },
  { name: 'saw', sig: 'saw(x)', about: 'band-limited saw, harmonics 1/k (the Saw preset)' },
  { name: 'square', sig: 'square(x)', about: 'band-limited square, odd harmonics 1/k (the Square preset)' },
  { name: 'pulse', sig: 'pulse(x, width)', about: 'pulse, high for the first `width` (0–1) of the cycle (the Pulse preset)' },
  { name: 'perlin', sig: 'perlin(x, freq, z, oct, pers, seed?)', about: 'loop-seamless Perlin noise (Perlin noise)' },
  { name: 'ca', sig: 'ca(x, rule, cells, gen, seed?)', about: 'generation `gen` of an elementary cellular automaton (Cellular automaton)' },
  { name: 'dyn', sig: 'dyn(x, map, control, iters, spread, output)', about: 'chaotic map, control 0–1 (Dynamical systems)' },
  { name: 'ks', sig: 'ks(x, passes, damping, pos, length, excite, seed?)', about: 'Karplus-Strong string after `passes` round trips' },
  {
    name: 'additive',
    sig: 'additive(x, slope, balance, move, phase, f1, w1, g1, f2, w2, g2, f3, w3, g3, seed?)',
    about: 'Additive designer: k^−slope, odd / even balance, formants at f × move',
  },
  { name: 'seq', sig: 'seq(x, source, steps, smoothing, pos, pulses)', about: 'number sequence window at `pos` (Number sequences)' },
  { name: 'rd', sig: 'rd(x, system, step, cells, spots, feed, kill, seed?)', about: 'reaction-diffusion ring after `step` steps' },
  { name: 'life', sig: 'life(x, rule, read, size, density, gen, seed?)', about: 'Life-like automaton, generation `gen`' },
  { name: 'spline', sig: 'spline(x, points, kind, tension, jitter, seed?)', about: 'seeded periodic spline (Spline)' },
  { name: 'glyph', sig: 'glyph(x, contour, skew)', about: 'radius vs angle of a stored contour polyline (Glyph contour)' },
];

export const WAVE_FUNCTION_NAMES: readonly WaveFunctionName[] = WAVE_FUNCTION_DOCS.map((d) => d.name);

const N = TABLE_SIZE;
const PER_RAD = N / (2 * Math.PI);

/** The grid index of phase x (wrapped into 0..N−1), or −1 when x is between grid points. */
export function gridIndex(x: number): number {
  const f = x * PER_RAD;
  const j = Math.round(f);
  if (!(Math.abs(f - j) <= 1e-9 + Math.abs(f) * 1e-12)) return -1;
  return ((j % N) + N) % N;
}

/** A cycle of N samples at phase x: the sample itself on the grid, Catmull-Rom cubic between. */
export function sampleCycle(c: ArrayLike<number>, x: number): number {
  if (!Number.isFinite(x)) return NaN;
  const g = gridIndex(x);
  if (g >= 0) return c[g];
  const f = (((x * PER_RAD) % N) + N) % N;
  const i = Math.floor(f);
  const t = f - i;
  const y0 = c[(i + N - 1) % N];
  const y1 = c[i % N];
  const y2 = c[(i + 1) % N];
  const y3 = c[(i + 2) % N];
  return y1 + 0.5 * t * (y2 - y0 + t * (2 * y0 - 5 * y1 + 4 * y2 - y3 + t * (3 * (y1 - y2) + y3 - y0)));
}

const ampsOf = (amp: (k: number) => number) => Float64Array.from({ length: KMAX + 1 }, (_, k) => (k ? amp(k) : 0));
const BASIC_AMPS = {
  sine: ampsOf((k) => (k === 1 ? 1 : 0)),
  tri: ampsOf(triAmp),
  saw: ampsOf(sawAmp),
  square: ampsOf(squareAmp),
};
type BasicName = keyof typeof BASIC_AMPS;
/** The basic generators' raw cycles (basicWave() before shape()), built on first use. */
let basicRaw: Record<BasicName, Float64Array> | null = null;
const basicCycle = (w: BasicName): Float64Array => {
  basicRaw ??= {
    // The same amplitude functions basicWave() passes to additive(): identical sums.
    sine: additiveRaw((k) => (k === 1 ? 1 : 0)),
    tri: additiveRaw(triAmp),
    saw: additiveRaw(sawAmp),
    square: additiveRaw(squareAmp),
  };
  return basicRaw[w];
};

/** Σ A[k]·sin(kx), k = 1..KMAX, by the sin(kx) recurrence (one sin / cos per call). */
function sinSeries(x: number, A: Float64Array): number {
  const c2 = 2 * Math.cos(x);
  let s0 = 0;
  let s1 = Math.sin(x);
  let sum = 0;
  for (let k = 1; k <= KMAX; k++) {
    if (A[k]) sum += A[k] * s1;
    const s2 = c2 * s1 - s0;
    s0 = s1;
    s1 = s2;
  }
  return sum;
}

const basicAt = (w: BasicName) => (x: number) => {
  if (!Number.isFinite(x)) return NaN;
  const g = gridIndex(x);
  if (g >= 0) return basicCycle(w)[g];
  return w === 'sine' ? Math.sin(x) : sinSeries(x, BASIC_AMPS[w]);
};

/** Naive pulse (the Pulse preset's cycle before shape()): +1 while the position is < width·N. */
function pulseAt(x: number, width: number): number {
  if (!Number.isFinite(x)) return NaN;
  const g = gridIndex(x);
  const f = g >= 0 ? g : (((x * PER_RAD) % N) + N) % N;
  return f < width * N ? 1 : -1;
}

/** Bounded LRU memo of generated cycles, keyed by function and arguments. */
export class CycleMemo {
  private readonly map = new Map<string, Float64Array>();
  /** Cycles generated (cache misses), for tests. */
  misses = 0;

  constructor(readonly max = 32) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string, make: () => Float64Array): Float64Array {
    let v = this.map.get(key);
    if (v) {
      this.map.delete(key);
    } else {
      v = make();
      this.misses++;
    }
    this.map.set(key, v);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
    return v;
  }
}

const keyOf = (a: Arg) => (typeof a === 'string' ? JSON.stringify(a) : Object.is(a, -0) ? '-0' : String(a));

function sameArgs(a: readonly Arg[], b: readonly Arg[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/** A finite number within [lo, hi], or a RangeError naming the function and argument. */
function need(fn: string, arg: string, v: unknown, lo: number, hi: number): number {
  const x = Number(v);
  if (!Number.isFinite(x) || x < lo || x > hi) throw new RangeError(`${fn}(): ${arg} must be a number from ${lo} to ${hi} (got ${String(v)})`);
  return x;
}

const num = (v: unknown, def: number) => (v === undefined ? def : Number(v));

/**
 * The waveform functions for one table render: seeded functions default to `seed`, and
 * generated cycles are memoised in `memo` (default: a fresh one, i.e. per render).
 */
export function waveFunctions(seed: number, memo = new CycleMemo()): WaveFunctions {
  const seedOf = (s: unknown) => (s === undefined ? seed >>> 0 : Number(s) >>> 0);

  /** A whole-cycle function: args → cycle (memoised), sampled at x. */
  const cycleFn = (name: string, make: (a: readonly Arg[]) => Float64Array) => {
    let lastArgs: readonly Arg[] | null = null;
    let last: Float64Array | null = null;
    return (x: number, args: readonly Arg[]) => {
      if (!lastArgs || !sameArgs(lastArgs, args)) {
        last = memo.get(`${name}(${args.map(keyOf).join(',')})`, () => make(args));
        lastArgs = args;
      }
      return sampleCycle(last!, x);
    };
  };

  const fields = new Map<number, NoiseField>();
  const fieldOf = (s: number) => {
    let f = fields.get(s);
    if (!f) fields.set(s, (f = noiseField(s)));
    return f;
  };

  const caC = cycleFn('ca', ([rule, cells, gen, s]) => caRawGenerations({ rule: Number(rule), cells: Number(cells) }, Number(s), Number(gen), 1)[0]);
  const dynC = cycleFn('dyn', ([map, c, it, spread, out]) => dynamicalRaw(Number(map), Number(c), Number(it), Number(spread), Number(out)));
  const ksC = cycleFn('ks', ([passes, damping, position, length, excite, s]) =>
    karplusRaw({ excite: Number(excite), length: Number(length), damping: Number(damping), position: Number(position) }, Number(passes), Number(s)),
  );
  const addC = cycleFn('additive', ([slope, balance, move, phase, f1, w1, g1, f2, w2, g2, f3, w3, g3, s]) => {
    const formants = [
      [f1, w1, g1],
      [f2, w2, g2],
      [f3, w3, g3],
    ].map((f) => f.map(Number));
    return designerRaw(additiveAmpsAt(Number(slope), Number(balance), Number(move), formants), Number(phase), Number(s));
  });
  const seqC = cycleFn('seq', ([source, steps, smoothing, pos, pulses]) =>
    sequenceRaw(sequenceValuesAt(Number(source), Number(steps), Number(pos), Number(pulses)), Number(smoothing)),
  );
  const rdC = cycleFn('rd', ([system, step, cells, spots, feed, kill, s]) =>
    rdRaw({ system: Number(system), feed: Number(feed), kill: Number(kill), cells: Number(cells), spots: Number(spots) }, Number(s), Number(step)),
  );
  const lifeC = cycleFn('life', ([rule, read, size, density, gen, s]) =>
    lifeRaw({ rule: Number(rule), read: Number(read), size: Number(size), density: Number(density) }, Number(s), Number(gen)),
  );
  const splineC = cycleFn('spline', ([points, kind, tension, jitter, s]) =>
    splineRaw(splinePointsAt(Number(points), Number(jitter), Number(s)), Number(kind), Number(tension)),
  );
  const glyphC = cycleFn('glyph', ([contour, skew]) => glyphRaw(contourPoints(String(contour)), Number(skew)));

  return {
    sine: basicAt('sine'),
    tri: basicAt('tri'),
    saw: basicAt('saw'),
    square: basicAt('square'),
    pulse: (x, width = 0.5) => pulseAt(x, Number(width)),
    perlin: (x, freq = 2, z = 0, oct = 4, pers = 0.5, s) => pnoiseAt(fieldOf(seedOf(s)), x, Number(freq), Number(z), Number(oct), Number(pers)),
    ca: (x, rule = 30, cells = 32, gen = 0, s) =>
      caC(x, [num(rule, 30), need('ca', 'cells', cells, 2, 4096), need('ca', 'gen', gen, 0, 100000), seedOf(s)]),
    dyn: (x, map = 0, control = 0.6, iters = 12, spread = 0.8, output = 0) =>
      dynC(x, [num(map, 0), need('dyn', 'control', control, -Infinity, Infinity), num(iters, 12), num(spread, 0.8), num(output, 0)]),
    ks: (x, passes = 0, damping = 0.6, pos = 0.2, length = 96, excite = 0, s) =>
      ksC(x, [need('ks', 'passes', passes, 0, 1e9), num(damping, 0.6), num(pos, 0.2), num(length, 96), num(excite, 0), seedOf(s)]),
    additive: (x, slope = 1, balance = 0, move = 1, phase = 0, ...rest) => {
      const f = (i: number, def: number) => num(rest[i], def);
      return addC(x, [
        num(slope, 1),
        num(balance, 0),
        num(move, 1),
        num(phase, 0),
        f(0, 0),
        f(1, 1),
        f(2, 0),
        f(3, 0),
        f(4, 1),
        f(5, 0),
        f(6, 0),
        f(7, 1),
        f(8, 0),
        seedOf(rest[9]),
      ]);
    },
    seq: (x, source = 0, steps = 16, smoothing = 0, pos = 0, pulses = 5) =>
      seqC(x, [num(source, 0), num(steps, 16), num(smoothing, 0), Math.round(need('seq', 'pos', pos, 0, 10000)), num(pulses, 5)]),
    rd: (x, system = 0, step = 200, cells = 128, spots = 3, feed = 0.022, kill = 0.0525, s) =>
      rdC(x, [num(system, 0), Math.round(need('rd', 'step', step, 0, 100000)), num(cells, 128), num(spots, 3), num(feed, 0.022), num(kill, 0.0525), seedOf(s)]),
    life: (x, rule = 0, read = 0, size = 32, density = 0.35, gen = 8, s) =>
      lifeC(x, [num(rule, 0), num(read, 0), num(size, 32), num(density, 0.35), Math.round(need('life', 'gen', gen, 0, 10000)), seedOf(s)]),
    spline: (x, points = 8, kind = 0, tension = 0, jitter = 0, s) =>
      splineC(x, [
        Math.min(SPLINE_MAX_POINTS, Math.max(3, Math.round(need('spline', 'points', points, -Infinity, Infinity)))),
        num(kind, 0),
        num(tension, 0),
        num(jitter, 0),
        seedOf(s),
      ]),
    glyph: (x, contour = '', skew = 0) => glyphC(x, [String(contour ?? ''), num(skew, 0)]),
  };
}
