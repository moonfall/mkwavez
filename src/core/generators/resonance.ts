/**
 * Resonance (Casio CZ style): a sine at `ratio` times the cycle's frequency under a window
 * that restarts every cycle — the resonant peak of a filter as a single cycle. The batch
 * sweeps the ratio (a non-integer ratio leaves a step where the cycle restarts, as on the CZ).
 */
import { TABLE_SIZE } from '../constants';
import { shape } from '../shape';
import { batchU } from './perlin';

export const RESONANCE_WINDOWS = ['Raised cosine', 'Saw (falling)', 'Triangle', 'Trapezoid'] as const;

export interface ResonanceParams {
  /** RESONANCE_WINDOWS index. */
  window: number;
  /** Resonance ratio at the batch start / end. */
  ratio: number;
  ratioEnd: number;
}

export const DEFAULT_RESONANCE: ResonanceParams = { window: 0, ratio: 2, ratioEnd: 12 };

/** The window over the cycle, t ∈ 0 … 1 (peak 1). */
export function resonanceWindow(w: number): (t: number) => number {
  switch (Math.round(w)) {
    case 1:
      return (t) => 1 - t;
    case 2:
      return (t) => 1 - Math.abs(2 * t - 1);
    case 3:
      return (t) => Math.min(1, 4 * t, 4 * (1 - t));
    default:
      return (t) => 0.5 - 0.5 * Math.cos(2 * Math.PI * t);
  }
}

/** The raw cycle (before shape()): sin(ratio·p)·window(t). */
export function resonanceRaw(w: number, ratio: number): Float64Array {
  const win = resonanceWindow(w);
  return Float64Array.from({ length: TABLE_SIZE }, (_, i) => {
    const t = i / TABLE_SIZE;
    return Math.sin(ratio * 2 * Math.PI * t) * win(t);
  });
}

export function resonanceRatio(p: ResonanceParams, index: number, count: number): number {
  return p.ratio + (p.ratioEnd - p.ratio) * batchU(index, count);
}

export function resonanceTable(p: ResonanceParams, index: number, count: number): Float32Array {
  return shape(resonanceRaw(p.window, resonanceRatio(p, index, count)));
}
