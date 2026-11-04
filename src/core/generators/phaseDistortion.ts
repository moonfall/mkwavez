/**
 * Phase distortion (Casio CZ style): a sine read through a bent phase. Amount 0 is the
 * plain sine; as it rises the phase map bends — Saw: a knee that rushes the first half;
 * Square: rush to the peak, hold, rush to the trough, hold; Half square: hold the peak
 * only. The batch sweeps the amount.
 */
import { TABLE_SIZE } from '../constants';
import { shape } from '../shape';
import { batchU } from './perlin';

export const PD_SHAPES = ['Saw', 'Square', 'Half square'] as const;

export interface PdParams {
  /** PD_SHAPES index. */
  shape: number;
  /** 0 (sine) … 1 at the batch start / end. */
  amount: number;
  amountEnd: number;
}

export const DEFAULT_PD: PdParams = { shape: 0, amount: 0, amountEnd: 1 };

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** The knee / rise time for an amount: 0.5 (no distortion) down to 0.05. */
export const pdKnee = (amount: number) => 0.5 - 0.45 * clamp(amount, 0, 1);

/** Hold-shaped map on [0, 1]: rise to ½ in w, hold until 1 − w, rise to 1. */
const holdMap = (s: number, w: number) => (s < w ? (0.5 * s) / w : s < 1 - w ? 0.5 : 0.5 + (0.5 * (s - (1 - w))) / w);

/** The phase map t → φ (both 0 … 1) of shape `s` at `amount`. */
export function pdMap(s: number, amount: number): (t: number) => number {
  const d = pdKnee(amount);
  switch (Math.round(s)) {
    case 1:
      return (t) => (t < 0.5 ? 0.5 * holdMap(2 * t, d) : 0.5 + 0.5 * holdMap(2 * t - 1, d));
    case 2:
      return (t) => (t < 0.5 ? 0.5 * holdMap(2 * t, d) : t);
    default:
      return (t) => (t < d ? t / (2 * d) : 0.5 + (t - d) / (2 * (1 - d)));
  }
}

/** The raw cycle (before shape()): sin(2π·φ(t)). */
export function pdRaw(s: number, amount: number): Float64Array {
  const f = pdMap(s, amount);
  return Float64Array.from({ length: TABLE_SIZE }, (_, i) => Math.sin(2 * Math.PI * f(i / TABLE_SIZE)));
}

export function pdAmount(p: PdParams, index: number, count: number): number {
  return p.amount + (p.amountEnd - p.amount) * batchU(index, count);
}

export function pdTable(p: PdParams, index: number, count: number): Float32Array {
  return shape(pdRaw(p.shape, pdAmount(p, index, count)));
}
