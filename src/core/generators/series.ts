/**
 * Harmonic series: a set of harmonics (all, odd, primes, Fibonacci or squares, up to a
 * highest one) at amplitudes k^−rolloff, optionally weighted by a pluck position
 * (sin(π·k·x): the spectrum of a string plucked at x) and with Schroeder phases (π·k²/H,
 * for a low crest factor). The batch sweeps the rolloff and the pluck position.
 */
import { TABLE_SIZE } from '../constants';
import { shape } from '../shape';
import { batchU } from './perlin';

export const SERIES_SETS = ['All', 'Odd', 'Primes (and the fundamental)', 'Fibonacci', 'Squares'] as const;
export const SERIES_PHASES = ['Sine', 'Schroeder'] as const;

export interface SeriesParams {
  /** SERIES_SETS index. */
  set: number;
  /** Highest harmonic (1 … 72). */
  highest: number;
  /** Amplitude k^−rolloff at the batch start / end. */
  rolloff: number;
  rolloffEnd: number;
  /** SERIES_PHASES index. */
  phases: number;
  /** Pluck position (0 = off … 0.5) at the batch start / end. */
  pluck: number;
  pluckEnd: number;
}

export const DEFAULT_SERIES: SeriesParams = { set: 2, highest: 29, rolloff: 1.5, rolloffEnd: 0.5, phases: 0, pluck: 0, pluckEnd: 0 };

const isPrime = (k: number) => {
  if (k < 2) return false;
  for (let d = 2; d * d <= k; d++) if (k % d === 0) return false;
  return true;
};
const FIB = new Set([1, 2, 3, 5, 8, 13, 21, 34, 55, 89]);

/** The harmonics of a set up to `highest`. */
export function seriesHarmonics(set: number, highest: number): number[] {
  const H = Math.max(1, Math.round(highest));
  const keep: ((k: number) => boolean)[] = [
    () => true,
    (k) => k % 2 === 1,
    (k) => k === 1 || isPrime(k),
    (k) => FIB.has(k),
    (k) => Number.isInteger(Math.sqrt(k)),
  ];
  const f = keep[Math.round(set)] ?? keep[0];
  return Array.from({ length: H }, (_, i) => i + 1).filter(f);
}

/** Harmonic k's signed amplitude: k^−rolloff, times sin(π·k·pluck) when plucked. */
export function seriesAmp(k: number, rolloff: number, pluck: number): number {
  return (pluck > 0 ? Math.sin(Math.PI * k * pluck) : 1) / Math.pow(k, rolloff);
}

/** The raw cycle (before shape()): Σ amp_k · sin(k·p + φ_k). */
export function seriesRaw(set: number, highest: number, rolloff: number, phases: number, pluck: number): Float64Array {
  const ks = seriesHarmonics(set, highest);
  const H = Math.max(1, Math.round(highest));
  const schroeder = Math.round(phases) === 1;
  const x = new Float64Array(TABLE_SIZE);
  for (const k of ks) {
    const a = seriesAmp(k, rolloff, pluck);
    if (!a) continue;
    const ph = schroeder ? (Math.PI * k * k) / H : 0;
    for (let i = 0; i < TABLE_SIZE; i++) x[i] += a * Math.sin(k * ((2 * Math.PI * i) / TABLE_SIZE) + ph);
  }
  return x;
}

/** Rolloff and pluck position of table `index` of a batch. */
export function seriesAt(p: SeriesParams, index: number, count: number): { rolloff: number; pluck: number } {
  const u = batchU(index, count);
  return { rolloff: p.rolloff + (p.rolloffEnd - p.rolloff) * u, pluck: p.pluck + (p.pluckEnd - p.pluck) * u };
}

export function seriesTable(p: SeriesParams, index: number, count: number): Float32Array {
  const a = seriesAt(p, index, count);
  return shape(seriesRaw(p.set, p.highest, a.rolloff, p.phases, a.pluck));
}
