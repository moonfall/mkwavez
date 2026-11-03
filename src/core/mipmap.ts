import {
  MIP_HARMONICS,
  MIP_LENGTHS,
  MIP_NYQUIST_FRACTION,
  MIP_OFFSETS,
  MIP_TOTAL,
  TABLE_SIZE,
} from './constants';
import { fft } from './fft';

/**
 * A per-octave band-limited mip set packed into one Float32Array (one transferable
 * buffer, trivially portable). Level l occupies [MIP_OFFSETS[l], +MIP_LENGTHS[l]) and
 * contains only harmonics 1..MIP_HARMONICS[l].
 */
export type MipSet = Float32Array;

export const MIP_LEVELS = MIP_HARMONICS.length;

/** Build the mip set for a shaped table. Not for the audio thread (FFT + allocation). */
export function buildMipSet(table: ArrayLike<number>): MipSet {
  if (table.length !== TABLE_SIZE) throw new Error('buildMipSet: wrong table size');
  const re = Float64Array.from(table);
  const im = new Float64Array(TABLE_SIZE);
  fft(re, im, false);
  const out = new Float32Array(MIP_TOTAL);
  for (let l = 0; l < MIP_LEVELS; l++) {
    const len = MIP_LENGTHS[l];
    const K = Math.min(MIP_HARMONICS[l], len / 2 - 1);
    const lr = new Float64Array(len);
    const li = new Float64Array(len);
    const scale = len / TABLE_SIZE;
    for (let k = 1; k <= K; k++) {
      lr[k] = re[k] * scale;
      li[k] = im[k] * scale;
      lr[len - k] = lr[k];
      li[len - k] = -li[k];
    }
    fft(lr, li, true);
    const off = MIP_OFFSETS[l];
    for (let i = 0; i < len; i++) out[off + i] = lr[i];
  }
  return out;
}

/**
 * Lowest-numbered (richest) level whose top harmonic stays under
 * MIP_NYQUIST_FRACTION * sampleRate at this fundamental.
 */
export function mipLevelFor(freq: number, sampleRate: number): number {
  const limit = MIP_NYQUIST_FRACTION * sampleRate;
  for (let l = 0; l < MIP_LEVELS; l++) if (freq * MIP_HARMONICS[l] < limit) return l;
  return MIP_LEVELS - 1;
}

/** View of one level (no copy). */
export function mipLevel(m: MipSet, level: number): Float32Array {
  return m.subarray(MIP_OFFSETS[level], MIP_OFFSETS[level] + MIP_LENGTHS[level]);
}
