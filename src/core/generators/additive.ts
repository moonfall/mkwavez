/**
 * Additive designer: harmonic amplitudes from a spectral slope, an odd / even balance
 * and up to three formant peaks, with sine, Schroeder (low crest factor) or seeded
 * random phases. A batch sweeps the slope (slope → slopeEnd) and moves the formants
 * (centres × 2^(shift·u)).
 */
import { KMAX, TABLE_SIZE } from '../constants';
import { Prng } from '../prng';
import { shape } from '../shape';
import { batchU } from './perlin';

export interface AdditiveParams {
  /** Amplitude ∝ k^−slope (0 = flat, 1 = saw, 2 = triangle-like). */
  slope: number;
  slopeEnd: number;
  /** −1 = even harmonics only (h1 kept) … 0 = all … +1 = odd only. */
  balance: number;
  /** Formants i = 1..3: centre (harmonic), width (harmonics), gain (0 = off). */
  f1: number;
  w1: number;
  g1: number;
  f2: number;
  w2: number;
  g2: number;
  f3: number;
  w3: number;
  g3: number;
  /** Formant centres move by 2^(shift·u) octaves across the batch. */
  shift: number;
  /** 0 = sine, 1 = Schroeder, 2 = seeded random. */
  phase: number;
}

export const DEFAULT_ADDITIVE: AdditiveParams = {
  slope: 1,
  slopeEnd: 1.6,
  balance: 0,
  f1: 6,
  w1: 2,
  g1: 3,
  f2: 15,
  w2: 3,
  g2: 2,
  f3: 32,
  w3: 5,
  g3: 0,
  shift: 1,
  phase: 0,
};

/** Harmonic amplitudes 1..KMAX (index = harmonic) of table `index`. */
export function additiveAmps(p: AdditiveParams, index: number, count: number): Float64Array {
  const u = batchU(index, count);
  const formants = [
    [p.f1, p.w1, p.g1],
    [p.f2, p.w2, p.g2],
    [p.f3, p.w3, p.g3],
  ];
  return additiveAmpsAt(p.slope + (p.slopeEnd - p.slope) * u, p.balance, Math.pow(2, p.shift * u), formants);
}

/**
 * Harmonic amplitudes 1..KMAX for one slope, balance and formant move (centres × move);
 * formants are [centre, width, gain] (gain ≤ 0 = off).
 */
export function additiveAmpsAt(slope: number, balance: number, move: number, formants: readonly (readonly number[])[]): Float64Array {
  const odd = 1 + Math.min(0, balance);
  const even = 1 - Math.max(0, balance);
  const A = new Float64Array(KMAX + 1);
  for (let k = 1; k <= KMAX; k++) {
    let a = Math.pow(k, -slope) * (k === 1 ? 1 : k % 2 ? odd : even);
    let boost = 1;
    for (const [c, w, g] of formants) {
      if (g <= 0) continue;
      const d = (k - c * move) / Math.max(0.25, w);
      boost += g * Math.exp(-d * d);
    }
    a *= boost;
    A[k] = a;
  }
  return A;
}

export function additiveTable(p: AdditiveParams, seed: number, index: number, count: number): Float32Array {
  return shape(designerRaw(additiveAmps(p, index, count), p.phase, seed));
}

/** The raw cycle (before shape()) of amplitudes A (index = harmonic), phases 0 sine / 1 Schroeder / 2 seeded. */
export function designerRaw(A: Float64Array, phase: number, seed: number): Float64Array {
  const mode = Math.round(phase);
  const r = new Prng(seed);
  const x = new Float64Array(TABLE_SIZE);
  for (let k = 1; k <= KMAX; k++) {
    // Draw for every harmonic so phases don't depend on which amplitudes are zero.
    const rnd = mode === 2 ? 2 * Math.PI * r.next() : 0;
    if (!A[k]) continue;
    const ph = mode === 1 ? (-Math.PI * k * (k - 1)) / KMAX : mode === 2 && k > 1 ? rnd : 0;
    const w = (2 * Math.PI * k) / TABLE_SIZE;
    for (let i = 0; i < TABLE_SIZE; i++) x[i] += A[k] * Math.sin(w * i + ph);
  }
  return x;
}
