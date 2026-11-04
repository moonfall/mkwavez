/**
 * Waveshaper: an input wave (sine, triangle or saw) at a level, plus a bias, through a
 * transfer curve. One amount sets each curve's character — tanh drive, Chebyshev order,
 * power exponent, hard-clip gain, wavefold depth — and the batch sweeps the amount and the
 * bias from their start values to their ends.
 */
import { TABLE_SIZE } from '../constants';
import { shape } from '../shape';
import { batchU } from './perlin';

export const SHAPERS = ['Soft clip (tanh)', 'Chebyshev Tₖ', 'Power (superellipse)', 'Hard clip', 'Wavefold'] as const;
export const SHAPER_INPUTS = ['Sine', 'Triangle', 'Saw'] as const;

export interface ShaperParams {
  /** SHAPERS index. */
  shaper: number;
  /** SHAPER_INPUTS index. */
  input: number;
  /** Input level (the input's peak). */
  level: number;
  /** The curve's amount at the batch start / end (drive, order, exponent, gain, depth). */
  amount: number;
  amountEnd: number;
  /** Added to the input before the curve, at the batch start / end. */
  bias: number;
  biasEnd: number;
}

export const DEFAULT_SHAPER: ShaperParams = { shaper: 0, input: 0, level: 1, amount: 1, amountEnd: 6, bias: 0, biasEnd: 0 };

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** The transfer curve of shaper `s` at `amount`. */
export function shaperCurve(s: number, amount: number): (v: number) => number {
  switch (clamp(Math.round(s), 0, SHAPERS.length - 1)) {
    case 1:
      return (v) => Math.cos(amount * Math.acos(clamp(v, -1, 1)));
    case 2:
      return (v) => Math.sign(v) * Math.pow(Math.abs(v), amount);
    case 3:
      return (v) => clamp(amount * v, -1, 1);
    case 4:
      return (v) => Math.sin(amount * (Math.PI / 2) * v);
    default:
      return (v) => Math.tanh(amount * v);
  }
}

/** Input sample i of N (peak 1): sine, triangle (in phase with the sine) or saw (rising, centred). */
export function shaperInput(input: number, i: number): number {
  const p = (2 * Math.PI * i) / TABLE_SIZE;
  switch (clamp(Math.round(input), 0, SHAPER_INPUTS.length - 1)) {
    case 1:
      return (2 / Math.PI) * Math.asin(Math.sin(p));
    case 2:
      return ((i / TABLE_SIZE + 0.5) % 1) * 2 - 1;
    default:
      return Math.sin(p);
  }
}

/**
 * The raw cycle (before shape()): curve(level·input + bias). A curve that flattens the
 * whole cycle (e.g. hard clip with a bias past the input) would be silence, so the input
 * itself is used instead.
 */
export function shaperRaw(s: number, input: number, level: number, amount: number, bias: number): Float64Array {
  const f = shaperCurve(s, amount);
  const x = Float64Array.from({ length: TABLE_SIZE }, (_, i) => f(level * shaperInput(input, i) + bias));
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of x) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return hi - lo > 1e-9 ? x : Float64Array.from({ length: TABLE_SIZE }, (_, i) => shaperInput(input, i));
}

/** Amount and bias of table `index` (start → end across the batch). */
export function shaperAt(p: ShaperParams, index: number, count: number): { amount: number; bias: number } {
  const u = batchU(index, count);
  return { amount: p.amount + (p.amountEnd - p.amount) * u, bias: p.bias + (p.biasEnd - p.bias) * u };
}

export function shaperTable(p: ShaperParams, index: number, count: number): Float32Array {
  const a = shaperAt(p, index, count);
  return shape(shaperRaw(p.shaper, p.input, p.level, a.amount, a.bias));
}
