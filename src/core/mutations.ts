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

export const MUTATIONS = [
  { group: 'Morph', id: 'toSaw', label: 'Toward saw' },
  { group: 'Morph', id: 'toSine', label: 'Toward sine' },
  { group: 'Morph', id: 'toSquare', label: 'Toward square' },
  { group: 'Morph', id: 'toTri', label: 'Toward triangle' },
  { group: 'Morph', id: 'toNoise', label: 'Toward noise' },
  { group: 'Waveshape', id: 'foldSmooth', label: 'Fold + smooth' },
  { group: 'Waveshape', id: 'fold', label: 'Fold' },
  { group: 'Waveshape', id: 'pm', label: 'Self phase mod' },
  { group: 'Waveshape', id: 'sync', label: 'Hard sync' },
  { group: 'Waveshape', id: 'ring', label: 'Ring mod' },
  { group: 'Waveshape', id: 'rect', label: 'Rectify' },
  { group: 'Waveshape', id: 'crush', label: 'Crush' },
  { group: 'Waveshape', id: 'warp', label: 'Phase warp' },
  { group: 'Waveshape', id: 'nwarp', label: 'Noise warp' },
  { group: 'Spectral', id: 'smooth', label: 'Smooth' },
  { group: 'Spectral', id: 'spread', label: 'Spread up' },
  { group: 'Spectral', id: 'stretch', label: 'Stretch' },
  { group: 'Spectral', id: 'comb', label: 'Comb' },
  { group: 'Spectral', id: 'formant', label: 'Formant' },
  { group: 'Spectral', id: 'blur', label: 'Blur' },
  { group: 'Spectral', id: 'odd', label: 'Odd only' },
  { group: 'Random', id: 'jitter', label: 'Jitter' },
  { group: 'Random', id: 'scramble', label: 'Scramble' },
  { group: 'Random', id: 'breed', label: 'Breed' },
] as const;

export type MutationId = (typeof MUTATIONS)[number]['id'];

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
