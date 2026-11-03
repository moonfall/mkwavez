import { KMAX, TABLE_SIZE } from '../constants';

/**
 * Band-limited resample of one period of L samples to TABLE_SIZE: the exact DFT
 * harmonics k ≤ min(KMAX, (L−1)/2) resynthesised (no interpolation images). DC is dropped.
 */
export function resamplePeriodic(buf: ArrayLike<number>): Float64Array {
  const L = buf.length;
  const K = Math.min(KMAX, Math.floor((L - 1) / 2));
  const out = new Float64Array(TABLE_SIZE);
  for (let k = 1; k <= K; k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < L; i++) {
      const a = (2 * Math.PI * k * i) / L;
      re += buf[i] * Math.cos(a);
      im -= buf[i] * Math.sin(a);
    }
    if (Math.hypot(re, im) < 1e-12) continue;
    for (let i = 0; i < TABLE_SIZE; i++) {
      const a = (2 * Math.PI * k * i) / TABLE_SIZE;
      out[i] += re * Math.cos(a) - im * Math.sin(a);
    }
  }
  return out;
}
