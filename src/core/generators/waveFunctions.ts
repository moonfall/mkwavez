/**
 * Waveform functions for formulas: the basic waves (sine, tri, saw, square, pulse) and one
 * function per parameter mode (perlin, ca, dyn, ks, additive, seq, rd, life, spline, glyph).
 * Each takes a phase x in radians first (`saw(2*p)`, `ca(p + u, 30, 32, n)`), then the
 * mode's arguments; seeded ones take the render's seed unless given an explicit last one.
 *
 * Output is normalised: every function's cycle peaks at ±1 (its generator's cycle before
 * shape(), divided by that cycle's peak |value|), so compositions such as `ks(p) +
 * perlin(p)` or `tanh(3*saw(p))` behave alike whatever the generator's own levels. DC is
 * kept (a pulse stays ±1, a Life row 0 / 1); shape() removes it from the final waveform.
 * A lone call at x = p therefore renders like its library entry after shape() (to float
 * rounding, ≪ 1e-6: scaling and DC commute with shape()). The library entries themselves
 * still render through their generators.
 *
 * Sampling at x:
 *  - On the 2048-sample grid (x·2048/2π within 1e-9 of an integer — p, 2p, p + 2πk/2048,
 *    …) the generator's own sample (normalised).
 *  - Between grid points: sine / tri / saw / square evaluate their KMAX-harmonic Fourier
 *    sum in closed form (the true band-limited value at any phase); pulse is the naive
 *    pulse the Pulse preset band-limits (+1 while x/2π mod 1 < width, else −1); perlin is
 *    evaluated directly; the whole-cycle generators interpolate their cycle with a 4-point
 *    Catmull-Rom cubic (exact at grid points; cycles are ≥ 14× oversampled for 72 harmonics,
 *    and shape() band-limits the result).
 *
 * Whole-cycle generators run once per distinct argument set per table render (a bounded LRU
 * memo, plus a last-call fast path), so per-sample evaluation is a cache hit and a lookup.
 * Every argument is checked (a finite number in range, or a RangeError naming it), the
 * arguments that set a generator's cost are bounded by what its library entry can ask for,
 * and a cache miss polls the render's abort deadline (simulations also between chunks).
 */
import { KMAX, TABLE_SIZE } from '../constants';
import { noiseCycle, noiseField, pnoiseAt, type NoiseField } from '../perlin';
import { additiveAmpsAt, designerRaw } from './additive';
import { additiveRaw, sawAmp, squareAmp, triAmp } from './basic';
import { caRawGenerations } from './ca';
import { dynamicalRaw } from './dynamical';
import { contourPoints, glyphRaw } from './glyph';
import { karplusRaw } from './karplus';
import { lifeBoard, lifeRaw } from './life';
import { rdRaw, rdState } from './reactionDiffusion';
import { sequenceRaw, sequenceValuesAt } from './sequences';
import { SPLINE_MAX_POINTS, splinePointsAt, splineRaw } from './spline';

type Arg = number | string;

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
  { name: 'pulse', sig: 'pulse(x, width)', about: 'pulse, +1 for the first `width` (0–1) of the cycle, else −1 (the Pulse preset)' },
  { name: 'perlin', sig: 'perlin(x, freq, z, oct, pers, seed?)', about: 'loop-seamless Perlin noise (Perlin noise)' },
  { name: 'ca', sig: 'ca(x, rule, cells, gen, seed?)', about: 'generation `gen` (0–1000) of an elementary cellular automaton (Cellular automaton)' },
  { name: 'dyn', sig: 'dyn(x, map, control, iters, spread, output)', about: 'chaotic map 0–4, control 0–1, iters 1–64 (Dynamical systems)' },
  { name: 'ks', sig: 'ks(x, passes, damping, pos, length, excite, seed?)', about: 'Karplus-Strong string after `passes` (0–4096) round trips' },
  {
    name: 'additive',
    sig: 'additive(x, slope, balance, move, phase, f1, w1, g1, f2, w2, g2, f3, w3, g3, seed?)',
    about: 'Additive designer: k^−slope, odd / even balance, formants at f × move',
  },
  { name: 'seq', sig: 'seq(x, source, steps, smoothing, pos, pulses)', about: 'number sequence window at `pos` (0–5000) (Number sequences)' },
  { name: 'rd', sig: 'rd(x, system, step, cells, spots, feed, kill, seed?)', about: 'reaction-diffusion ring after `step` (0–70000) steps' },
  { name: 'life', sig: 'life(x, rule, read, size, density, gen, seed?)', about: 'Life-like automaton, generation `gen` (0–2000)' },
  { name: 'spline', sig: 'spline(x, points, kind, tension, jitter, seed?)', about: 'seeded periodic spline (Spline)' },
  { name: 'glyph', sig: 'glyph(x, contour, skew)', about: 'radius vs angle of a stored contour polyline, skew −10–10 (Glyph contour)' },
];

export const WAVE_FUNCTION_NAMES: readonly WaveFunctionName[] = WAVE_FUNCTION_DOCS.map((d) => d.name);

/**
 * Bounds on the arguments that set a generator's cost: what its library entry can ask for
 * (largest start + per-waveform step × 63, the largest batch's last index), with headroom.
 */
export const WAVE_FUNCTION_LIMITS = {
  caCells: 256,
  caGen: 1000,
  ksPasses: 4096,
  dynIters: 64,
  seqPos: 5000,
  rdStep: 70000,
  lifeGen: 2000,
  perlinOct: 10,
  glyphSkew: 10,
} as const;
const L = WAVE_FUNCTION_LIMITS;

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

/** The peak |value| of a cycle (0 for silence). */
function peakOf(c: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < c.length; i++) m = Math.max(m, Math.abs(c[i]));
  return m;
}

/** A cycle divided by its peak |value| (a silent cycle stays all zeros). */
export function normalizeCycle(c: Float64Array): Float64Array {
  const m = peakOf(c);
  if (!(m > 1e-12)) return new Float64Array(c.length);
  for (let i = 0; i < c.length; i++) c[i] /= m;
  return c;
}

const ampsOf = (amp: (k: number) => number) => Float64Array.from({ length: KMAX + 1 }, (_, k) => (k ? amp(k) : 0));
const AMPS = {
  sine: ampsOf((k) => (k === 1 ? 1 : 0)),
  tri: ampsOf(triAmp),
  saw: ampsOf(sawAmp),
  square: ampsOf(squareAmp),
};
type BasicName = keyof typeof AMPS;
/** The basic generators' cycles (basicWave() before shape()) and their peaks, built on first use. */
let basic: Record<BasicName, { raw: Float64Array; peak: number }> | null = null;
const basicCycle = (w: BasicName) => {
  basic ??= Object.fromEntries(
    (Object.keys(AMPS) as BasicName[]).map((k) => {
      const raw = additiveRaw((h) => AMPS[k][h]);
      return [k, { raw, peak: peakOf(raw) }];
    }),
  ) as Record<BasicName, { raw: Float64Array; peak: number }>;
  return basic[w];
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

const show = (v: unknown) => (typeof v === 'string' ? JSON.stringify(v.length > 24 ? `${v.slice(0, 24)}…` : v) : String(v));

/** The phase argument: a finite number. */
function phase(fn: string, x: unknown): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new RangeError(`${fn}(): the phase x must be a finite number (got ${show(x)})`);
  return x;
}

/** An argument: `def` when omitted, else a finite number within [lo, hi] — or a RangeError naming it. */
function num(fn: string, name: string, v: unknown, def: number, lo = -Infinity, hi = Infinity): number {
  if (v === undefined) return def;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new RangeError(`${fn}(): ${name} must be a finite number (got ${show(v)})`);
  if (v < lo || v > hi) throw new RangeError(`${fn}(): ${name} must be from ${lo} to ${hi} (got ${v})`);
  return v;
}

const basicAt = (w: BasicName) => (x: number) => {
  phase(w, x);
  const { raw, peak } = basicCycle(w);
  const g = gridIndex(x);
  return (g >= 0 ? raw[g] : w === 'sine' ? Math.sin(x) : sinSeries(x, AMPS[w])) / peak;
};

/** Naive pulse (the Pulse preset's cycle before shape()): +1 while the position is < width·N, else −1. */
function pulseAt(x: number, width: number): number {
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

/** Steps / generations simulated between abort checks. */
const RD_CHUNK = 2000;
const LIFE_CHUNK = 200;

/**
 * The waveform functions for one table render: seeded functions default to `seed`,
 * generated cycles are memoised in `memo` (default: a fresh one, i.e. per render), and
 * `check` (e.g. throws when the render's deadline passed) runs before each cycle is
 * generated and between simulation chunks.
 */
export function waveFunctions(seed: number, memo = new CycleMemo(), check: () => void = () => {}): WaveFunctions {
  const seedOf = (fn: string, s: unknown) => (s === undefined ? seed >>> 0 : num(fn, 'seed', s, 0) >>> 0);

  /** A whole-cycle function: (validated) args → normalised cycle (memoised), sampled at x. */
  const cycleFn = (name: string, make: (a: readonly Arg[]) => Float64Array) => {
    let lastArgs: readonly Arg[] | null = null;
    let last: Float64Array | null = null;
    return (x: number, args: readonly Arg[]) => {
      if (!lastArgs || !sameArgs(lastArgs, args)) {
        last = memo.get(`${name}(${args.map(keyOf).join(',')})`, () => {
          check();
          return normalizeCycle(make(args));
        });
        lastArgs = args;
      }
      return sampleCycle(last!, x);
    };
  };
  const n = (a: Arg) => a as number;

  const fields = new Map<number, NoiseField>();
  const fieldOf = (s: number) => {
    let f = fields.get(s);
    if (!f) fields.set(s, (f = noiseField(s)));
    return f;
  };
  /** Perlin: the grid cycle (for its peak and the grid samples); off-grid noise is evaluated directly. */
  const perlinPeaks = new Map<string, { cycle: Float64Array; peak: number }>();
  const perlinCycle = (a: readonly number[]) => {
    const key = a.join(',');
    let c = perlinPeaks.get(key);
    if (!c) {
      check();
      if (perlinPeaks.size >= memo.max) perlinPeaks.delete(perlinPeaks.keys().next().value!);
      const cycle = noiseCycle(fieldOf(a[4]), a[0], a[1], a[2], a[3]);
      perlinPeaks.set(key, (c = { cycle, peak: peakOf(cycle) }));
    }
    return c;
  };

  const caC = cycleFn('ca', ([rule, cells, gen, s]) => caRawGenerations({ rule: n(rule), cells: n(cells) }, n(s), n(gen), 1)[0]);
  const dynC = cycleFn('dyn', ([map, c, it, spread, out]) => dynamicalRaw(n(map), n(c), n(it), n(spread), n(out)));
  const ksC = cycleFn('ks', ([passes, damping, position, length, excite, s]) =>
    karplusRaw({ excite: n(excite), length: n(length), damping: n(damping), position: n(position) }, n(passes), n(s)),
  );
  const addC = cycleFn('additive', ([slope, balance, move, ph, f1, w1, g1, f2, w2, g2, f3, w3, g3, s]) => {
    const formants = [
      [f1, w1, g1],
      [f2, w2, g2],
      [f3, w3, g3],
    ].map((f) => f.map(n));
    return designerRaw(additiveAmpsAt(n(slope), n(balance), n(move), formants), n(ph), n(s));
  });
  const seqC = cycleFn('seq', ([source, steps, smoothing, pos, pulses]) =>
    sequenceRaw(sequenceValuesAt(n(source), n(steps), n(pos), n(pulses)), n(smoothing)),
  );
  const rdC = cycleFn('rd', ([system, step, cells, spots, feed, kill, s]) => {
    const p = { system: n(system), feed: n(feed), kill: n(kill), cells: n(cells), spots: n(spots) };
    // Simulate in chunks (checkpointed by rdState's cache: same result), polling the deadline.
    for (let k = RD_CHUNK; k < n(step); k += RD_CHUNK) {
      rdState(p, n(s), k);
      check();
    }
    return rdRaw(p, n(s), n(step));
  });
  const lifeC = cycleFn('life', ([rule, read, size, density, gen, s]) => {
    const p = { rule: n(rule), read: n(read), size: n(size), density: n(density) };
    for (let k = LIFE_CHUNK; k < n(gen); k += LIFE_CHUNK) {
      lifeBoard(p, n(s), k);
      check();
    }
    return lifeRaw(p, n(s), n(gen));
  });
  const splineC = cycleFn('spline', ([points, kind, tension, jitter, s]) => splineRaw(splinePointsAt(n(points), n(jitter), n(s)), n(kind), n(tension)));
  const glyphC = cycleFn('glyph', ([contour, skew]) => glyphRaw(contourPoints(String(contour)), n(skew)));

  return {
    sine: basicAt('sine'),
    tri: basicAt('tri'),
    saw: basicAt('saw'),
    square: basicAt('square'),
    pulse: (x, width) => pulseAt(phase('pulse', x), num('pulse', 'width', width, 0.5)),
    perlin: (x, freq, z, oct, pers, s) => {
      phase('perlin', x);
      const a = [
        num('perlin', 'freq', freq, 2),
        num('perlin', 'z', z, 0),
        num('perlin', 'oct', oct, 4, 0, L.perlinOct),
        num('perlin', 'pers', pers, 0.5),
        seedOf('perlin', s),
      ];
      const { cycle, peak } = perlinCycle(a);
      if (!(peak > 1e-12)) return 0;
      const g = gridIndex(x);
      return (g >= 0 ? cycle[g] : pnoiseAt(fieldOf(a[4]), x, a[0], a[1], a[2], a[3])) / peak;
    },
    ca: (x, rule, cells, gen, s) =>
      caC(phase('ca', x), [
        num('ca', 'rule', rule, 30, 0, 255),
        num('ca', 'cells', cells, 32, 2, L.caCells),
        num('ca', 'gen', gen, 0, 0, L.caGen),
        seedOf('ca', s),
      ]),
    dyn: (x, map, control, iters, spread, output) =>
      dynC(phase('dyn', x), [
        num('dyn', 'map', map, 0, 0, 4),
        num('dyn', 'control', control, 0.6),
        num('dyn', 'iters', iters, 12, 1, L.dynIters),
        num('dyn', 'spread', spread, 0.8),
        num('dyn', 'output', output, 0),
      ]),
    ks: (x, passes, damping, pos, length, excite, s) =>
      ksC(phase('ks', x), [
        num('ks', 'passes', passes, 0, 0, L.ksPasses),
        num('ks', 'damping', damping, 0.6),
        num('ks', 'pos', pos, 0.2),
        num('ks', 'length', length, 96),
        num('ks', 'excite', excite, 0),
        seedOf('ks', s),
      ]),
    additive: (x, slope, balance, move, ph, ...rest) => {
      phase('additive', x);
      const names = ['f1', 'w1', 'g1', 'f2', 'w2', 'g2', 'f3', 'w3', 'g3'];
      const defs = [0, 1, 0, 0, 1, 0, 0, 1, 0];
      return addC(x, [
        num('additive', 'slope', slope, 1),
        num('additive', 'balance', balance, 0),
        num('additive', 'move', move, 1),
        num('additive', 'phase', ph, 0),
        ...names.map((nm, i) => num('additive', nm, rest[i], defs[i])),
        seedOf('additive', rest[9]),
      ]);
    },
    seq: (x, source, steps, smoothing, pos, pulses) =>
      seqC(phase('seq', x), [
        num('seq', 'source', source, 0, 0, 4),
        num('seq', 'steps', steps, 16, 2, 64),
        num('seq', 'smoothing', smoothing, 0),
        Math.round(num('seq', 'pos', pos, 0, 0, L.seqPos)),
        num('seq', 'pulses', pulses, 5),
      ]),
    rd: (x, system, step, cells, spots, feed, kill, s) =>
      rdC(phase('rd', x), [
        num('rd', 'system', system, 0),
        Math.round(num('rd', 'step', step, 200, 0, L.rdStep)),
        num('rd', 'cells', cells, 128),
        num('rd', 'spots', spots, 3),
        num('rd', 'feed', feed, 0.022),
        num('rd', 'kill', kill, 0.0525),
        seedOf('rd', s),
      ]),
    life: (x, rule, read, size, density, gen, s) =>
      lifeC(phase('life', x), [
        num('life', 'rule', rule, 0),
        num('life', 'read', read, 0),
        num('life', 'size', size, 32),
        num('life', 'density', density, 0.35),
        Math.round(num('life', 'gen', gen, 8, 0, L.lifeGen)),
        seedOf('life', s),
      ]),
    spline: (x, points, kind, tension, jitter, s) =>
      splineC(phase('spline', x), [
        Math.min(SPLINE_MAX_POINTS, Math.max(3, Math.round(num('spline', 'points', points, 8)))),
        num('spline', 'kind', kind, 0),
        num('spline', 'tension', tension, 0),
        num('spline', 'jitter', jitter, 0),
        seedOf('spline', s),
      ]),
    glyph: (x, contour, skew) => {
      phase('glyph', x);
      if (contour !== undefined && typeof contour !== 'string')
        throw new RangeError(`glyph(): contour must be a string ("x,y x,y …" or the compact form; got ${show(contour)})`);
      return glyphC(x, [contour ?? '', num('glyph', 'skew', skew, 0, -L.glyphSkew, L.glyphSkew)]);
    },
  };
}
