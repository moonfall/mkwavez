/**
 * Fractal sum: Σ decay^k · f(ratio^k · x) for k = 0 … terms − 1 — a Weierstrass function
 * with cosines, the Takagi (blancmange) curve with triangles. The batch sweeps the decay
 * (how much the fine detail weighs).
 */
import { TABLE_SIZE } from '../constants';
import { shape } from '../shape';
import { batchU } from './perlin';

export const FRACTAL_BASES = ['Cosine (Weierstrass)', 'Triangle (Takagi)', 'Sine', 'Square'] as const;

export interface FractalParams {
  /** FRACTAL_BASES index. */
  base: number;
  /** Frequency ratio between terms (integer: periodic). */
  ratio: number;
  terms: number;
  /** Amplitude ratio between terms at the batch start / end. */
  decay: number;
  decayEnd: number;
}

export const DEFAULT_FRACTAL: FractalParams = { base: 0, ratio: 2, terms: 7, decay: 0.4, decayEnd: 0.8 };

/** Term k's base function of the cycle position t ∈ 0 … 1, at frequency f. */
export function fractalBase(base: number): (f: number, t: number) => number {
  switch (Math.round(base)) {
    case 1:
      return (f, t) => Math.abs(((f * t + 0.5) % 1) - 0.5);
    case 2:
      return (f, t) => Math.sin(f * 2 * Math.PI * t);
    case 3:
      return (f, t) => (((f * t) % 1) < 0.5 ? 1 : -1);
    default:
      return (f, t) => Math.cos(f * 2 * Math.PI * t);
  }
}

export function fractalRaw(base: number, ratio: number, terms: number, decay: number): Float64Array {
  const f = fractalBase(base);
  const K = Math.max(1, Math.round(terms));
  return Float64Array.from({ length: TABLE_SIZE }, (_, i) => {
    const t = i / TABLE_SIZE;
    let s = 0;
    for (let k = 0; k < K; k++) s += Math.pow(decay, k) * f(Math.pow(ratio, k), t);
    return s;
  });
}

export function fractalDecay(p: FractalParams, index: number, count: number): number {
  return p.decay + (p.decayEnd - p.decay) * batchU(index, count);
}

export function fractalTable(p: FractalParams, index: number, count: number): Float32Array {
  return shape(fractalRaw(p.base, p.ratio, p.terms, fractalDecay(p, index, count)));
}
