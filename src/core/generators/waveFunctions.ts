/**
 * Waveform functions for formulas: the basic waves sine, tri, saw, square and pulse. Each
 * takes a phase x in radians (`saw(2*p)`, `square(p + u)`).
 *
 * Every function returns its generator's own cycle *before* shape() (the raw values shape()
 * then makes DC-free, band-limited, phase-aligned and peak-normalised), so a lone call at
 * x = p renders bit-identically to the library entry: `saw(p)` is the Saw preset. Levels
 * are the generators' own (saw peaks ≈ 1.85, square ≈ 0.93, tri ≈ 1.23, sine 1).
 *
 * Sampling at x:
 *  - On the 2048-sample grid (x·2048/2π within 1e-9 of an integer — p, 2p, p + 2πk/2048,
 *    …) the generator's sample itself, so grid phases are exact.
 *  - Between grid points: sine / tri / saw / square evaluate their KMAX-harmonic Fourier
 *    sum in closed form (the true band-limited value at any phase); pulse is the naive
 *    pulse the Pulse preset band-limits (+1 while x/2π mod 1 < width).
 */
import { KMAX, TABLE_SIZE } from '../constants';
import { additiveRaw, sawAmp, squareAmp, triAmp } from './basic';

export interface WaveFunctions {
  sine(x: number): number;
  tri(x: number): number;
  saw(x: number): number;
  square(x: number): number;
  pulse(x: number, width?: number): number;
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

/** The waveform functions for one table render (`seed`: unused by the basic waves). */
export function waveFunctions(seed: number): WaveFunctions {
  void seed;
  return {
    sine: basicAt('sine'),
    tri: basicAt('tri'),
    saw: basicAt('saw'),
    square: basicAt('square'),
    pulse: (x, width = 0.5) => pulseAt(x, Number(width)),
  };
}
