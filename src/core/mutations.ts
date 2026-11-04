/**
 * Mutations ported from the prototype (UI: ui/mutate.ts). Each maps amount a in [0,1]
 * onto a source table; a = 0 returns the source unchanged (up to shape() rounding).
 * All randomness comes from `seed`.
 *
 * Revisions: a mutation whose mapping was changed keeps its old behaviour at the old
 * revision, so stored recipes re-render as they were made. Recipes and Shape steps record
 * the revision they were made at (`rev`); those without one are revision 1.
 *  - 2: Reverse morphs the harmonic phases (never silent); Hard sync caps its read ratio
 *       on high-only sources (chains stay audible).
 */
import { KMAX, TABLE_SIZE } from './constants';
import { fft, harmonicMagnitudes } from './fft';
import { additive, sawAmp, squareAmp, triAmp } from './generators/basic';
import { noiseCycle, noiseField } from './perlin';
import { Prng } from './prng';
import { lerpAt, shape, shapeFrom } from './shape';

const N = TABLE_SIZE;

/**
 * The mutation library. `hint` is a one-line description of how amount a maps onto the
 * effect (a = 0 is always the source unchanged); `seeded` marks mutations whose result
 * depends on the seed (the others ignore it).
 */
export const MUTATIONS = [
  { group: 'Morph', id: 'toSaw', label: 'Toward saw', hint: 'Blend (1−a)·x + a·saw' },
  { group: 'Morph', id: 'toSine', label: 'Toward sine', hint: 'Harmonics ≥ 2 scaled by (1−a)²' },
  { group: 'Morph', id: 'toSquare', label: 'Toward square', hint: 'Blend (1−a)·x + a·square' },
  { group: 'Morph', id: 'toTri', label: 'Toward triangle', hint: 'Blend (1−a)·x + a·triangle' },
  { group: 'Morph', id: 'toNoise', label: 'Toward noise', hint: 'Blend toward a seeded noise cycle', seeded: true },
  { group: 'Waveshape', id: 'foldSmooth', label: 'Fold + smooth', hint: 'Fold at gain 1 + 3a, then Smooth at a/2' },
  { group: 'Waveshape', id: 'fold', label: 'Fold', hint: 'Triangle folder, gain 1 + 3a' },
  { group: 'Waveshape', id: 'pm', label: 'Self phase mod', hint: 'Read x at i + 0.3·a·N·x[i]' },
  {
    group: 'Waveshape',
    id: 'sync',
    label: 'Hard sync',
    hint: 'Read x at i·r mod N, r = 1 + 3a (capped so the lowest harmonic stays below h36: chains stay audible)',
  },
  { group: 'Waveshape', id: 'ring', label: 'Ring mod', hint: '× (1−a) + a·sin(m·p), m = 2–7 seeded', seeded: true },
  { group: 'Waveshape', id: 'rect', label: 'Rectify', hint: 'Blend toward 2·|x| − 1' },
  { group: 'Waveshape', id: 'crush', label: 'Crush', hint: 'Quantise to 2 + 62·(1−a)³ levels' },
  { group: 'Waveshape', id: 'warp', label: 'Phase warp', hint: 'Read offset by 0.12·a·N·sin(p)' },
  { group: 'Waveshape', id: 'nwarp', label: 'Noise warp', hint: 'Read offset by 0.25·a·N·seeded noise', seeded: true },
  { group: 'Time', id: 'palindrome', label: 'Palindrome', hint: 'Blend toward the cycle at double speed, then reversed' },
  {
    group: 'Time',
    id: 'reverse',
    label: 'Reverse',
    hint: 'Harmonic phases morph toward the reversed cycle’s (a = 1: reversed); magnitudes kept. A sine-phase wave (saw, square, any sum of sines) reversed is the same sound',
  },
  { group: 'Time', id: 'halfSwap', label: 'Half-cycle swap', hint: 'Blend toward −x(t+½): halves swapped and inverted (even harmonics flip)' },
  { group: 'Time', id: 'repeat', label: 'Window & repeat', hint: 'First 1/n repeated n times, n = 1 + 7a (blended between whole n)' },
  { group: 'Time', id: 'slew', label: 'Slew limit', hint: 'Step per sample limited to 0.03^a × the source’s steepest step' },
  { group: 'Time', id: 'decimate', label: 'Decimate', hint: 'Sample-and-hold to 2048 / 2^(7a) steps, then band-limited' },
  { group: 'Time', id: 'window', label: 'Window impose', hint: 'Cycle squeezed into W = 1 − 0.9a (silence after), Hann-shaped by a' },
  { group: 'Time', id: 'grains', label: 'Granular shuffle', hint: 'Each of 16 segments swapped with a seeded one with probability a', seeded: true },
  { group: 'Time', id: 'stutter', label: 'Stutter', hint: 'A seeded 1/16 segment repeated over the next a·½ cycle', seeded: true },
  { group: 'Nonlinear', id: 'logisticShape', label: 'Logistic shaper', hint: 'Blend by 0.75a toward 3 logistic-map steps on (x+1)/2, r = 3.5 + 0.5a' },
  { group: 'Nonlinear', id: 'sineShape', label: 'Sine-map shaper', hint: 'x → sin(g·x)/g, g = 3π·a^1.5 (folds as a grows)' },
  { group: 'Nonlinear', id: 'asym', label: 'Asymmetric saturation', hint: 'tanh(g·(x + b)), g = 6a, bias b = 0.5a (adds even harmonics)' },
  { group: 'Nonlinear', id: 'cheby', label: 'Chebyshev mix', hint: 'Blend by 0.75a toward T_n(x), n = 2–8 seeded (the source stays in)', seeded: true },
  { group: 'Spectral', id: 'smooth', label: 'Smooth', hint: 'Gaussian low-pass at harmonic 2 / a^1.5' },
  { group: 'Spectral', id: 'spread', label: 'Spread up', hint: 'Harmonic k gains a·(k−1)/k of harmonic k−1' },
  { group: 'Spectral', id: 'stretch', label: 'Stretch', hint: 'Harmonic k moves to round(k·(1 + 0.6a))' },
  { group: 'Spectral', id: 'comb', label: 'Comb', hint: 'Harmonics weighted (1−a) + a·comb (period 6)' },
  { group: 'Spectral', id: 'formant', label: 'Formant', hint: 'Up to (1 + 2a)× around a seeded centre h4–h24', seeded: true },
  { group: 'Spectral', id: 'blur', label: 'Blur', hint: 'Magnitudes mixed by a toward their neighbours' },
  { group: 'Spectral', id: 'odd', label: 'Odd only', hint: 'Even harmonics scaled by (1−a)²' },
  { group: 'Spectral', id: 'selfConv', label: 'Self-convolution', hint: 'Toward the squared spectrum: |X|²/max, phases doubled, by a' },
  { group: 'Spectral', id: 'reslp', label: 'Resonant low-pass', hint: '2-pole low-pass, Q 4, cutoff 1.5·500^(1−a) harmonics' },
  { group: 'Spectral', id: 'hshift', label: 'Harmonic shift', hint: 'Harmonics ≥ 2 move up by 16·a^1.5 (fundamental kept)' },
  { group: 'Spectral', id: 'mirror', label: 'Spectrum mirror', hint: 'Magnitudes of h2…top reversed, blended by a' },
  { group: 'Spectral', id: 'contrast', label: 'Spectral contrast', hint: 'Magnitudes |X|^γ, γ = 1 + 2a (peaks stand out)' },
  { group: 'Spectral', id: 'flatten', label: 'Spectral flatten', hint: 'Magnitudes |X|^γ, γ = 1 − 0.85a (toward flat)' },
  { group: 'Spectral', id: 'primes', label: 'Prime sieve', hint: 'Non-prime harmonics (except h1) scaled by (1−a)²' },
  { group: 'Spectral', id: 'fibsieve', label: 'Fibonacci sieve', hint: 'Non-Fibonacci harmonics scaled by (1−a)²' },
  {
    group: 'Spectral',
    id: 'multiples',
    label: 'Multiples sieve',
    hint: 'Harmonics not a multiple of m (2–5, seeded; h1 kept) scaled by (1−a)²',
    seeded: true,
  },
  { group: 'Phase', id: 'zeroPhase', label: 'Zero phase', hint: 'Phases moved by a toward 0 (a = 1: symmetric)' },
  { group: 'Phase', id: 'schroeder', label: 'Schroeder phase', hint: 'Phases moved by a toward −πk(k−1)/K (low crest factor)' },
  {
    group: 'Phase',
    id: 'phaseRandom',
    label: 'Phase randomize',
    hint: 'Phases moved by a toward seeded random ones (a = 1: fully random)',
    seeded: true,
  },
  { group: 'Random', id: 'jitter', label: 'Jitter', hint: 'Seeded magnitude + phase noise, scaled by a', seeded: true },
  { group: 'Random', id: 'scramble', label: 'Scramble', hint: 'Seeded phase offsets up to ±a·π', seeded: true },
  // Legacy (M2): superseded by the Breed tab (core/breed.ts); kept so older recipes
  // re-render. Not offered in the Mutate picker.
  { group: 'Random', id: 'breed', label: 'Breed', hint: 'Magnitudes pulled by a toward a mate', seeded: true, legacy: true },
] as const;

/** Mutations offered in the UI (legacy ones only re-render old recipes). */
export const MUTATION_CHOICES = MUTATIONS.filter((m) => !('legacy' in m));

export type MutationId = (typeof MUTATIONS)[number]['id'];

/** The current mutation revision (new recipes and Shape steps record it; see the header). */
export const MUTATION_REV = 2;

/** Hard sync (rev ≥ 2): the result's lowest harmonic stays at or below this (non-integer: a sync edge stays). */
const SYNC_CAP = 36.5;
/** Hard sync: harmonics below this fraction of the strongest don't count as the lowest. */
const SYNC_FLOOR = 1e-3;
export type MutationInfo = (typeof MUTATIONS)[number];

/** True if the mutation's result depends on the seed. */
export function mutationUsesSeed(id: MutationId): boolean {
  const m = MUTATIONS.find((x) => x.id === id);
  return !!m && 'seeded' in m && m.seeded;
}

export interface MutationContext {
  /** Candidate tables for 'breed' (prototype: the first targeted voice's window). */
  breedPool?: readonly Float32Array[];
}

let targetCache: { saw: Float32Array; square: Float32Array; tri: Float32Array } | null = null;
function targets() {
  if (!targetCache) {
    targetCache = { saw: additive(sawAmp), square: additive(squareAmp), tri: additive(triAmp) };
  }
  return targetCache;
}

function toward(x: Float32Array, t: Float32Array, a: number): Float32Array {
  return shapeFrom((i) => (1 - a) * x[i] + a * t[i]);
}

function triFold(v: number): number {
  const m = (((v + 1) % 4) + 4) % 4;
  return 1 - Math.abs(m - 2);
}

/** Triangle folder at gain g, 4x oversampled with centred sub-sample offsets (no phase shift). */
function fold(x: Float32Array, g: number): Float32Array {
  const os = 4;
  return shapeFrom((i) => {
    let s = 0;
    for (let j = 0; j < os; j++) s += triFold(g * lerpAt(x, i + (j + 0.5) / os - 0.5));
    return s / os;
  });
}

/** Per-sample shaper f, 4x oversampled like fold() (centred sub-samples, no phase shift). */
function shaper(x: Float32Array, f: (v: number) => number): Float32Array {
  const os = 4;
  return shapeFrom((i) => {
    let s = 0;
    for (let j = 0; j < os; j++) s += f(lerpAt(x, i + (j + 0.5) / os - 0.5));
    return s / os;
  });
}

function smoothBy(x: Float32Array, a: number): Float32Array {
  return a <= 0.001 ? shape(x) : shape(x, { lowpassHarmonic: 2 / Math.pow(a, 1.5) });
}

/** Bins below this fraction of the source's strongest harmonic are float residue: dropped. */
const RESIDUE = 1e-6;
/** A result whose strongest harmonic is below this fraction of the source's is silence. */
const SILENT = 1e-3;

/**
 * Run fn on the positive-frequency bins, mirror, inverse, shape. Levels are judged
 * relative to the source: residue bins are dropped and a result that kept (almost)
 * nothing is silence, so shape()'s normalisation never blows float residue up into
 * full-scale noise or a phantom tone (e.g. a sieve on a source without kept harmonics).
 */
function viaSpec(x: Float32Array, fn: (re: Float64Array, im: Float64Array) => void): Float32Array {
  const re = Float64Array.from(x);
  const im = new Float64Array(N);
  fft(re, im, false);
  let inMax = 0;
  for (let k = 1; k < N / 2; k++) inMax = Math.max(inMax, Math.hypot(re[k], im[k]));
  fn(re, im);
  let outMax = 0;
  for (let k = 1; k < N / 2; k++) {
    const m = Math.hypot(re[k], im[k]);
    if (m < inMax * RESIDUE) re[k] = im[k] = 0;
    else outMax = Math.max(outMax, m);
  }
  if (outMax < inMax * SILENT) return new Float32Array(N);
  for (let k = 1; k < N / 2; k++) {
    re[N - k] = re[k];
    im[N - k] = -im[k];
  }
  fft(re, im, true);
  return shape(re);
}

/** Rewrite harmonics 1..KMAX in polar form: fn(k, mag, phase) -> [mag, phase]. */
function polar(
  re: Float64Array,
  im: Float64Array,
  fn: (k: number, m: number, p: number) => [number, number],
): void {
  for (let k = 1; k <= KMAX; k++) {
    const [m, p] = fn(k, Math.hypot(re[k], im[k]), Math.atan2(im[k], re[k]));
    re[k] = m * Math.cos(p);
    im[k] = m * Math.sin(p);
  }
}

/** Magnitudes and phases of harmonics 0..KMAX+1 (index = harmonic; 0 and KMAX+1 are 0). */
function harmonics(re: Float64Array, im: Float64Array): { M: Float64Array; P: Float64Array; max: number } {
  const M = new Float64Array(KMAX + 2);
  const P = new Float64Array(KMAX + 2);
  let max = 0;
  for (let k = 1; k <= KMAX; k++) {
    M[k] = Math.hypot(re[k], im[k]);
    P[k] = Math.atan2(im[k], re[k]);
    max = Math.max(max, M[k]);
  }
  return { M, P, max };
}

/** Set harmonic k from polar form. */
function setPolar(re: Float64Array, im: Float64Array, k: number, m: number, p: number): void {
  re[k] = m * Math.cos(p);
  im[k] = m * Math.sin(p);
}

function isPrime(k: number): boolean {
  if (k < 2) return false;
  for (let d = 2; d * d <= k; d++) if (k % d === 0) return false;
  return true;
}

const FIBONACCI = new Set([1, 2, 3, 5, 8, 13, 21, 34, 55, 89]);

/** Harmonics ≥ 2 that fail `keep` scaled by q (q = 1: unchanged). */
function sieve(x: Float32Array, q: number, keep: (k: number) => boolean): Float32Array {
  return viaSpec(x, (re, im) => {
    for (let k = 2; k < N / 2; k++) {
      if (keep(k)) continue;
      re[k] *= q;
      im[k] *= q;
    }
  });
}

/** Magnitudes renormalised to the peak and raised to γ (harmonics below 1e-6 of the peak dropped). */
function contrast(x: Float32Array, gamma: number): Float32Array {
  return viaSpec(x, (re, im) => {
    const { M, P, max } = harmonics(re, im);
    if (max <= 0) return;
    for (let k = 1; k <= KMAX; k++) {
      const r = M[k] / max;
      setPolar(re, im, k, r > 1e-6 ? max * Math.pow(r, gamma) : 0, P[k]);
    }
  });
}

/** Wrap an angle into (−π, π]. */
function wrapPi(v: number): number {
  const w = v - 2 * Math.PI * Math.round(v / (2 * Math.PI));
  return w <= -Math.PI ? w + 2 * Math.PI : w;
}

/** Move every harmonic's phase by a (shortest way) toward target(k, K); K = highest present harmonic. */
function phaseToward(x: Float32Array, a: number, target: (k: number, K: number) => number): Float32Array {
  return viaSpec(x, (re, im) => {
    const { M, P, max } = harmonics(re, im);
    let K = 1;
    for (let k = 1; k <= KMAX; k++) if (M[k] > max * 1e-6) K = k;
    for (let k = 1; k <= KMAX; k++) setPolar(re, im, k, M[k], P[k] + a * wrapPi(target(k, K) - P[k]));
  });
}

/** Table i of `x` repeated: its first 1/n played n times (n ≥ 1, may be fractional length). */
function repeatAt(x: Float32Array, n: number, i: number): number {
  return lerpAt(x, i % (N / n));
}

/** Slew-limited cycle: runs three cycles so the limiter's state wraps consistently. */
function slewLimit(x: Float32Array, maxStep: number): Float32Array {
  let y = x[N - 1];
  const out = new Float64Array(N);
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < N; i++) {
      const d = x[i] - y;
      y += d > maxStep ? maxStep : d < -maxStep ? -maxStep : d;
      out[i] = y;
    }
  }
  return shape(out);
}

export function mutate(
  op: MutationId,
  x: Float32Array,
  a: number,
  seed: number,
  ctx: MutationContext = {},
  rev: number = MUTATION_REV,
): Float32Array {
  const rand = new Prng(seed);
  const R = () => rand.bipolar();
  const q = Math.pow(1 - a, 2);
  switch (op) {
    case 'toSaw':
      return toward(x, targets().saw, a);
    case 'toSquare':
      return toward(x, targets().square, a);
    case 'toTri':
      return toward(x, targets().tri, a);
    case 'toNoise':
      return toward(x, shape(noiseCycle(noiseField(rand.int(2 ** 32)), 2, 0, 4, 0.5)), a);
    case 'toSine':
      return viaSpec(x, (re, im) => {
        for (let k = 2; k < N / 2; k++) {
          re[k] *= q;
          im[k] *= q;
        }
      });
    case 'fold':
      return fold(x, 1 + 3 * a);
    case 'foldSmooth':
      return smoothBy(fold(x, 1 + 3 * a), a * 0.5);
    case 'pm':
      return shapeFrom((i) => lerpAt(x, i + a * N * 0.3 * x[i]));
    case 'sync': {
      let r = 1 + a * 3;
      if (rev >= 2 && r > 1) {
        // Reading a source whose lowest harmonic is L at ratio r puts it at L·r: a chain at
        // a = 1 (r = 4 per step) left the band (silence) from the 4th step. Capped so L·r
        // stays at SYNC_CAP — not an integer, so the restart leaves a sync edge, which
        // brings the low harmonics back for the next step.
        const m = harmonicMagnitudes(x, KMAX);
        const floor = Math.max(...m) * SYNC_FLOOR;
        let L = 1;
        while (L < KMAX && !(m[L] >= floor)) L++;
        if (L * r > SYNC_CAP) r = Math.max(1, SYNC_CAP / L);
      }
      return shapeFrom((i) => lerpAt(x, (i * r) % N));
    }
    case 'ring': {
      const m = 2 + rand.int(6);
      return shapeFrom((i) => x[i] * (1 - a + a * Math.sin((2 * Math.PI * m * i) / N)));
    }
    case 'rect':
      return shapeFrom((i) => (1 - a) * x[i] + a * (2 * Math.abs(x[i]) - 1));
    case 'crush': {
      if (a <= 0.001) return shape(x);
      const L = Math.max(2, Math.round(2 + 62 * Math.pow(1 - a, 3)));
      return shapeFrom((i) => Math.round(x[i] * L) / L);
    }
    case 'warp':
      return shapeFrom((i) => lerpAt(x, i + a * N * 0.12 * Math.sin((2 * Math.PI * i) / N)));
    case 'nwarp': {
      const w = noiseCycle(noiseField(rand.int(2 ** 32)), 1.5, 0, 3, 0.5);
      return shapeFrom((i) => lerpAt(x, i + a * N * 0.25 * w[i]));
    }
    case 'palindrome':
      return shapeFrom((i) => (1 - a) * x[i] + a * (i < N / 2 ? x[2 * i] : x[2 * (N - 1 - i) + 1]));
    case 'reverse':
      // Rev 1: a time-domain blend with the reversed cycle. A sine-phase source reversed is
      // −x, so the blend was (1 − 2a)·x: unchanged below ½, silent at ½.
      if (rev < 2) return shapeFrom((i) => (1 - a) * x[i] + a * x[(N - i) % N]);
      // The reversed cycle, half a cycle on (x(½ − t)), has harmonic k at phase kπ − φ_k:
      // the fundamental of a shaped (sine-phase) table stays where it is, so nothing drifts
      // when shape() re-aligns. Each phase moves along the shorter arc to its target,
      // magnitudes kept, so the morph is smooth and never goes silent.
      if (a <= 0) return shape(x);
      return viaSpec(x, (re, im) => {
        for (let k = 1; k < N / 2; k++) {
          const m = Math.hypot(re[k], im[k]);
          const ph = Math.atan2(im[k], re[k]);
          const p = ph + a * wrapPi(k * Math.PI - 2 * ph);
          re[k] = m * Math.cos(p);
          im[k] = m * Math.sin(p);
        }
      });
    case 'halfSwap':
      return shapeFrom((i) => (1 - a) * x[i] - a * x[(i + N / 2) % N]);
    case 'repeat': {
      const nf = 1 + 7 * a;
      const n0 = Math.floor(nf);
      const f = nf - n0;
      return shapeFrom((i) => (1 - f) * repeatAt(x, n0, i) + (f > 0 ? f * repeatAt(x, n0 + 1, i) : 0));
    }
    case 'slew': {
      // Relative to the source's own steepest step, so it acts from the start on any wave.
      if (a <= 0) return shape(x);
      let steep = 0;
      for (let i = 0; i < N; i++) steep = Math.max(steep, Math.abs(x[i] - x[(i - 1 + N) % N]));
      return slewLimit(x, steep * Math.pow(0.03, a));
    }
    case 'decimate': {
      const hold = Math.pow(2, 7 * a);
      return shapeFrom((i) => x[Math.min(N - 1, Math.floor(Math.floor(i / hold) * hold))]);
    }
    case 'window': {
      const w = 1 - 0.9 * a;
      return shapeFrom((i) => {
        const t = i / N / w;
        return t >= 1 ? 0 : lerpAt(x, t * N) * (1 - a + a * (0.5 - 0.5 * Math.cos(2 * Math.PI * t)));
      });
    }
    case 'logisticShape': {
      if (a <= 0) return shape(x);
      const r = 3.5 + 0.5 * a;
      return shaper(x, (v) => {
        let u = Math.min(1, Math.max(0, (v + 1) / 2));
        for (let j = 0; j < 3; j++) u = r * u * (1 - u);
        // At most 75%: the source's fundamental stays, so a sweep doesn't jump in pitch.
        return (1 - 0.75 * a) * v + 0.75 * a * (2 * u - 1);
      });
    }
    case 'sineShape': {
      const g = 3 * Math.PI * Math.pow(a, 1.5);
      return g < 1e-6 ? shape(x) : shaper(x, (v) => Math.sin(g * v) / g);
    }
    case 'asym': {
      const g = 6 * a;
      const b = 0.5 * a;
      return g < 1e-6 ? shape(x) : shaper(x, (v) => (Math.tanh(g * (v + b)) - Math.tanh(g * b)) / g);
    }
    case 'cheby': {
      const n = 2 + rand.int(7);
      if (a <= 0) return shape(x);
      const w = 0.75 * a; // the source stays in (no octave jump at a = 1)
      return shaper(x, (v) => (1 - w) * v + w * Math.cos(n * Math.acos(Math.max(-1, Math.min(1, v)))));
    }
    case 'grains': {
      const S = 16;
      const g = N / S;
      const perm = Array.from({ length: S }, (_, j) => j);
      for (let j = S - 1; j > 0; j--) {
        const k = rand.int(j + 1);
        [perm[j], perm[k]] = [perm[k], perm[j]];
      }
      const swap = perm.map(() => rand.next() < a);
      return shapeFrom((i) => {
        const j = Math.floor(i / g);
        return swap[j] ? x[perm[j] * g + (i % g)] : x[i];
      });
    }
    case 'stutter': {
      const g = N / 16;
      const s0 = rand.int(N);
      const w = (a * N) / 2;
      return shapeFrom((i) => {
        const d = (i - s0 + N) % N;
        return d < w ? x[(s0 + (d % g)) % N] : x[i];
      });
    }
    case 'selfConv':
      return viaSpec(x, (re, im) => {
        const { M, P, max } = harmonics(re, im);
        if (max <= 0) return;
        for (let k = 1; k <= KMAX; k++) setPolar(re, im, k, (1 - a) * M[k] + (a * M[k] * M[k]) / max, P[k] + a * wrapPi(P[k]));
      });
    case 'reslp': {
      if (a <= 0) return shape(x);
      const kc = 1.5 * Math.pow(500, 1 - a);
      const Q = 4;
      return viaSpec(x, (re, im) => {
        for (let k = 1; k < N / 2; k++) {
          // H = 1 / (1 − r² + i·r/Q), r = k / kc.
          const r = k / kc;
          const dr = 1 - r * r;
          const di = r / Q;
          const d = dr * dr + di * di;
          const hr = dr / d;
          const hi = -di / d;
          const nr = re[k] * hr - im[k] * hi;
          im[k] = re[k] * hi + im[k] * hr;
          re[k] = nr;
        }
      });
    }
    case 'smooth':
      return smoothBy(x, a);
    case 'spread':
      return viaSpec(x, (re, im) => {
        for (let k = KMAX; k >= 2; k--) {
          const s = (a * (k - 1)) / k;
          re[k] += s * re[k - 1];
          im[k] += s * im[k - 1];
        }
      });
    case 'stretch':
      return viaSpec(x, (re, im) => {
        const nr = new Float64Array(KMAX + 1);
        const ni = new Float64Array(KMAX + 1);
        for (let k = 1; k <= KMAX; k++) {
          const t = k === 1 ? 1 : Math.round(k * (1 + a * 0.6));
          if (t <= KMAX) {
            nr[t] += re[k];
            ni[t] += im[k];
          }
        }
        for (let k = 1; k < N / 2; k++) {
          re[k] = k <= KMAX ? nr[k] : 0;
          im[k] = k <= KMAX ? ni[k] : 0;
        }
      });
    case 'comb':
      return viaSpec(x, (re, im) =>
        polar(re, im, (k, m, p) => [
          k === 1 ? m : m * (1 - a + a * (0.5 + 0.5 * Math.cos((2 * Math.PI * (k - 1)) / 6))),
          p,
        ]),
      );
    case 'formant': {
      const c = 4 + rand.next() * 20;
      return viaSpec(x, (re, im) =>
        polar(re, im, (k, m, p) => {
          const d = (k - c) / 3;
          return [k === 1 ? m : m * (1 - a + a * 3 * Math.exp(-d * d)), p];
        }),
      );
    }
    case 'blur':
      return viaSpec(x, (re, im) => {
        const M = new Float64Array(KMAX + 2);
        for (let k = 1; k <= KMAX; k++) M[k] = Math.hypot(re[k], im[k]);
        polar(re, im, (k, m, p) => [k === 1 ? m : (1 - a) * m + a * 0.5 * (M[k - 1] + M[k + 1]), p]);
      });
    case 'odd':
      return viaSpec(x, (re, im) => {
        for (let k = 2; k < N / 2; k += 2) {
          re[k] *= q;
          im[k] *= q;
        }
      });
    case 'hshift': {
      // Fractional shifts interpolate magnitudes between the two nearest whole shifts.
      const sh = 16 * Math.pow(a, 1.5);
      const k0 = Math.floor(sh);
      const f = sh - k0;
      return viaSpec(x, (re, im) => {
        const { M, P } = harmonics(re, im);
        for (let k = 2; k < N / 2; k++) {
          if (k > KMAX) {
            re[k] = im[k] = 0;
            continue;
          }
          const s0 = k - k0;
          const s1 = s0 - 1;
          const m = (1 - f) * (s0 >= 2 ? M[s0] : 0) + f * (s1 >= 2 ? M[s1] : 0);
          setPolar(re, im, k, m, s0 >= 2 ? P[s0] : s1 >= 2 ? P[s1] : 0);
        }
      });
    }
    case 'mirror':
      return viaSpec(x, (re, im) => {
        const { M, P, max } = harmonics(re, im);
        let top = 2;
        for (let k = 2; k <= KMAX; k++) if (M[k] > max * 1e-4) top = k;
        for (let k = 2; k <= top; k++) setPolar(re, im, k, (1 - a) * M[k] + a * M[top + 2 - k], P[k]);
      });
    case 'contrast':
      return contrast(x, 1 + 2 * a);
    case 'flatten':
      return contrast(x, 1 - 0.85 * a);
    case 'primes':
      return sieve(x, q, isPrime);
    case 'fibsieve':
      return sieve(x, q, (k) => FIBONACCI.has(k));
    case 'multiples': {
      const m = 2 + rand.int(4);
      return sieve(x, q, (k) => k % m === 0);
    }
    case 'zeroPhase':
      return phaseToward(x, a, () => 0);
    case 'schroeder':
      return phaseToward(x, a, (k, K) => (-Math.PI * k * (k - 1)) / Math.max(1, K));
    case 'phaseRandom': {
      const ph = Array.from({ length: KMAX + 1 }, () => Math.PI * R());
      return phaseToward(x, a, (k) => ph[k]);
    }
    case 'jitter':
      return viaSpec(x, (re, im) =>
        polar(re, im, (k, m, p) => {
          const r1 = R();
          const r2 = rand.next();
          const r3 = R();
          return k === 1 ? [m, p] : [m * (1 + a * r1) + (a * N * 0.06 * r2) / k, p + a * r3];
        }),
      );
    case 'scramble':
      return viaSpec(x, (re, im) =>
        polar(re, im, (k, m, p) => {
          const r1 = R();
          return [m, k === 1 ? p : p + a * Math.PI * r1];
        }),
      );
    case 'breed': {
      const pool = ctx.breedPool ?? [];
      if (!pool.length) return shape(x);
      const o = Float64Array.from(pool[rand.int(pool.length)]);
      const oi = new Float64Array(N);
      fft(o, oi, false);
      return viaSpec(x, (re, im) =>
        polar(re, im, (k, m, p) => [(1 - a) * m + a * Math.hypot(o[k], oi[k]), p]),
      );
    }
  }
}

export type SweepMode = 'lin' | 'log' | 'chain';
export const LOG_SWEEP_RANGE = 64;

/** Amounts for an N-table sweep ending at A (linear, or 64:1 geometric). */
export function sweepAmounts(n: number, A: number, mode: 'lin' | 'log'): number[] {
  const out: number[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(mode === 'log' ? (n > 1 ? A * Math.pow(LOG_SWEEP_RANGE, (i - n) / (n - 1)) : A) : (A * i) / n);
  }
  return out;
}
