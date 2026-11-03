import { KMAX, TABLE_SIZE } from '../constants';

/** Harmonics below this fraction of the strongest one are float residue: dropped. */
const RESIDUE = 1e-9;

/**
 * Band-limited resample of one period of L samples to TABLE_SIZE: the exact DFT
 * harmonics k ≤ min(KMAX, (L−1)/2) resynthesised (no interpolation images). DC is
 * dropped, and so are harmonics below 1e-9 of the strongest or below `floor` (absolute,
 * per-sample amplitude): a buffer with nothing above the floor resamples to silence
 * instead of normalised float residue.
 */
export function resamplePeriodic(buf: ArrayLike<number>, floor = 0): Float64Array {
  const L = buf.length;
  const K = Math.min(KMAX, Math.floor((L - 1) / 2));
  const re = new Float64Array(K + 1);
  const im = new Float64Array(K + 1);
  let max = 0;
  for (let k = 1; k <= K; k++) {
    for (let i = 0; i < L; i++) {
      const a = (2 * Math.PI * k * i) / L;
      re[k] += buf[i] * Math.cos(a);
      im[k] -= buf[i] * Math.sin(a);
    }
    max = Math.max(max, Math.hypot(re[k], im[k]));
  }
  // Amplitude of harmonic k per sample is 2·|X_k| / L.
  const gate = Math.max(max * RESIDUE, (floor * L) / 2);
  const out = new Float64Array(TABLE_SIZE);
  for (let k = 1; k <= K; k++) {
    if (Math.hypot(re[k], im[k]) <= gate) continue;
    for (let i = 0; i < TABLE_SIZE; i++) {
      const a = (2 * Math.PI * k * i) / TABLE_SIZE;
      out[i] += re[k] * Math.cos(a) - im[k] * Math.sin(a);
    }
  }
  return out;
}
