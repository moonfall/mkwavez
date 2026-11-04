import { KMAX, TABLE_SIZE } from '../constants';
import { noiseCycle, noiseField } from '../perlin';
import { shape } from '../shape';
import type { GeneratedTable } from '../table';

export const BASIC_WAVES = ['sine', 'tri', 'saw', 'square', 'p25', 'p10', 'noise'] as const;
export type BasicWave = (typeof BASIC_WAVES)[number];

/** The raw additive cycle (before shape()) from per-harmonic sine amplitudes amp(k), k = 1..KMAX. */
export function additiveRaw(amp: (k: number) => number): Float64Array {
  const x = new Float64Array(TABLE_SIZE);
  for (let k = 1; k <= KMAX; k++) {
    const a = amp(k);
    if (!a) continue;
    const w = (2 * Math.PI * k) / TABLE_SIZE;
    for (let i = 0; i < TABLE_SIZE; i++) x[i] += a * Math.sin(w * i);
  }
  return x;
}

/** Additive cycle from per-harmonic sine amplitudes amp(k), k = 1..KMAX. */
export function additive(amp: (k: number) => number): Float32Array {
  return shape(additiveRaw(amp));
}

export const sawAmp = (k: number): number => 1 / k;
export const squareAmp = (k: number): number => (k % 2 ? 1 / k : 0);
export const triAmp = (k: number): number => (k % 2 ? (((k - 1) / 2) % 2 ? -1 : 1) / (k * k) : 0);

/** The naive pulse of the given duty (before shape()): +1 for i < duty·N, else −1. */
export function pulseRaw(duty: number): Float64Array {
  const x = new Float64Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i++) x[i] = i < duty * TABLE_SIZE ? 1 : -1;
  return x;
}

/** Naive pulse of the given duty, then band-limited by shape(). */
export function pulse(duty: number): Float32Array {
  return shape(pulseRaw(duty));
}

/** Basic waveform; `seed` only matters for 'noise'. */
export function basicWave(wave: BasicWave, seed: number): Float32Array {
  switch (wave) {
    case 'sine':
      return additive((k) => (k === 1 ? 1 : 0));
    case 'tri':
      return additive(triAmp);
    case 'saw':
      return additive(sawAmp);
    case 'square':
      return additive(squareAmp);
    case 'p25':
      return pulse(0.25);
    case 'p10':
      return pulse(0.1);
    case 'noise':
      return shape(noiseCycle(noiseField(seed), 2, 0, 4, 0.5));
  }
}

export function generateBasic(wave: BasicWave, seed: number): GeneratedTable {
  return {
    data: basicWave(wave, seed),
    recipe: { op: 'basic', params: { wave }, seed: seed >>> 0, parents: [] },
  };
}
