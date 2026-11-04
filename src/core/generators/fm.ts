/**
 * FM / PM: a sine carrier phase-modulated by a sine modulator, sin(c·p + I·M(p)), with a
 * second modulator that goes into the modulator (nested FM), multiplies it (ring) or goes
 * straight into the carrier (parallel). Integer ratios keep the cycle periodic; the batch
 * sweeps the index I.
 */
import { TABLE_SIZE } from '../constants';
import { shape } from '../shape';
import { batchU } from './perlin';

export const FM_ROUTINGS = ['Into the modulator (nested)', 'Times the modulator (ring)', 'Into the carrier (parallel)'] as const;

export interface FmParams {
  /** Carrier ratio (harmonic of the cycle). */
  carrier: number;
  /** Modulator ratio. */
  ratio: number;
  /** Modulation index at the batch start / end (radians of phase). */
  index: number;
  indexEnd: number;
  /** Second modulator: ratio, amount and FM_ROUTINGS index. */
  ratio2: number;
  amount2: number;
  routing: number;
}

export const DEFAULT_FM: FmParams = { carrier: 1, ratio: 2, index: 0, indexEnd: 4, ratio2: 3, amount2: 0, routing: 0 };

/** The modulator M(p) (peak about 1; the index scales it). */
export function fmModulator(ratio: number, ratio2: number, amount2: number, routing: number): (p: number) => number {
  switch (Math.round(routing)) {
    case 1:
      return (p) => Math.sin(ratio * p) * (1 - amount2 + amount2 * Math.sin(ratio2 * p));
    case 2:
      return (p) => Math.sin(ratio * p) + amount2 * Math.sin(ratio2 * p);
    default:
      return (p) => Math.sin(ratio * p + amount2 * Math.sin(ratio2 * p));
  }
}

/** The raw cycle (before shape()): sin(carrier·p + index·M(p)). */
export function fmRaw(carrier: number, ratio: number, index: number, ratio2: number, amount2: number, routing: number): Float64Array {
  const m = fmModulator(ratio, ratio2, amount2, routing);
  return Float64Array.from({ length: TABLE_SIZE }, (_, i) => {
    const p = (2 * Math.PI * i) / TABLE_SIZE;
    return Math.sin(carrier * p + index * m(p));
  });
}

/** The index of table `index` of a batch (start → end). */
export function fmIndex(p: FmParams, index: number, count: number): number {
  return p.index + (p.indexEnd - p.index) * batchU(index, count);
}

export function fmTable(p: FmParams, index: number, count: number): Float32Array {
  return shape(fmRaw(p.carrier, p.ratio, fmIndex(p, index, count), p.ratio2, p.amount2, p.routing));
}
