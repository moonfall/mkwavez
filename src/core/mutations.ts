/**
 * Mutations ported from the prototype (UI: ui/mutate.ts). Each maps amount a in [0,1]
 * onto a source table; a = 0 returns the source unchanged (up to shape() rounding).
 * All randomness comes from `seed`.
 */
import { KMAX, TABLE_SIZE } from './constants';
import { fft } from './fft';
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
  { group: 'Waveshape', id: 'sync', label: 'Hard sync', hint: 'Read x at i·(1 + 3a) mod N' },
  { group: 'Waveshape', id: 'ring', label: 'Ring mod', hint: '× (1−a) + a·sin(m·p), m = 2–7 seeded', seeded: true },
  { group: 'Waveshape', id: 'rect', label: 'Rectify', hint: 'Blend toward 2·|x| − 1' },
  { group: 'Waveshape', id: 'crush', label: 'Crush', hint: 'Quantise to 2 + 62·(1−a)³ levels' },
  { group: 'Waveshape', id: 'warp', label: 'Phase warp', hint: 'Read offset by 0.12·a·N·sin(p)' },
  { group: 'Waveshape', id: 'nwarp', label: 'Noise warp', hint: 'Read offset by 0.25·a·N·seeded noise', seeded: true },
  { group: 'Spectral', id: 'smooth', label: 'Smooth', hint: 'Gaussian low-pass at harmonic 2 / a^1.5' },
  { group: 'Spectral', id: 'spread', label: 'Spread up', hint: 'Harmonic k gains a·(k−1)/k of harmonic k−1' },
  { group: 'Spectral', id: 'stretch', label: 'Stretch', hint: 'Harmonic k moves to round(k·(1 + 0.6a))' },
  { group: 'Spectral', id: 'comb', label: 'Comb', hint: 'Harmonics weighted (1−a) + a·comb (period 6)' },
  { group: 'Spectral', id: 'formant', label: 'Formant', hint: 'Up to (1 + 2a)× around a seeded centre h4–h24', seeded: true },
  { group: 'Spectral', id: 'blur', label: 'Blur', hint: 'Magnitudes mixed by a toward their neighbours' },
  { group: 'Spectral', id: 'odd', label: 'Odd only', hint: 'Even harmonics scaled by (1−a)²' },
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
  { group: 'Random', id: 'jitter', label: 'Jitter', hint: 'Seeded magnitude + phase noise, scaled by a', seeded: true },
  { group: 'Random', id: 'scramble', label: 'Scramble', hint: 'Seeded phase offsets up to ±a·π', seeded: true },
  // Legacy (M2): superseded by the Breed tab (core/breed.ts); kept so older recipes
  // re-render. Not offered in the Mutate picker.
  { group: 'Random', id: 'breed', label: 'Breed', hint: 'Magnitudes pulled by a toward a mate', seeded: true, legacy: true },
] as const;

/** Mutations offered in the UI (legacy ones only re-render old recipes). */
export const MUTATION_CHOICES = MUTATIONS.filter((m) => !('legacy' in m));

export type MutationId = (typeof MUTATIONS)[number]['id'];
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

function smoothBy(x: Float32Array, a: number): Float32Array {
  return a <= 0.001 ? shape(x) : shape(x, { lowpassHarmonic: 2 / Math.pow(a, 1.5) });
}

/** Run fn on the positive-frequency bins, mirror, inverse, shape. */
function viaSpec(x: Float32Array, fn: (re: Float64Array, im: Float64Array) => void): Float32Array {
  const re = Float64Array.from(x);
  const im = new Float64Array(N);
  fft(re, im, false);
  fn(re, im);
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

export function mutate(
  op: MutationId,
  x: Float32Array,
  a: number,
  seed: number,
  ctx: MutationContext = {},
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
      const r = 1 + a * 3;
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
