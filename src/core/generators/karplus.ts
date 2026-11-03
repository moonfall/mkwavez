/**
 * Karplus-Strong snapshots: excite a circular "string" buffer (seeded noise burst or a
 * triangle pluck), run it through the KS averaging loop, and take the buffer after
 * start + i·passes round trips as table i. A batch scans one decaying string: bright
 * attack → mellow tail. The buffer (length L) is resampled to the table band-limited
 * (exact DFT of its harmonics), so short strings stay clean.
 */
import { Prng } from '../prng';
import { shape } from '../shape';
import { resamplePeriodic } from './resample';

export interface KsParams {
  /** 0 = seeded noise burst, 1 = triangle pluck. */
  excite: number;
  /** String (buffer) length in samples, 16..512. */
  length: number;
  /** Averaging-filter amount per pass, 0 (none) .. 1 (classic KS ½(x[i]+x[i−1])). */
  damping: number;
  /** Round trips between snapshots, 1..64. */
  passes: number;
  /** Round trips before the first snapshot. */
  start: number;
  /** Pluck position along the string, 0.02..0.5 (comb on noise; apex of the pluck). */
  position: number;
}

export const DEFAULT_KS: KsParams = { excite: 0, length: 96, damping: 0.6, passes: 6, start: 0, position: 0.2 };

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Remove the mean (DC never decays in the loop and would swamp the renormalised AC). */
function centre(buf: Float64Array): Float64Array {
  let m = 0;
  for (const v of buf) m += v;
  m /= buf.length;
  for (let i = 0; i < buf.length; i++) buf[i] -= m;
  return buf;
}

/** The excited buffer before any pass (zero mean). */
function excite(p: KsParams, L: number, seed: number): Float64Array {
  const buf = new Float64Array(L);
  const pos = clamp(p.position, 0.02, 0.5);
  if (Math.round(p.excite) === 1) {
    const apex = pos * L;
    for (let i = 0; i < L; i++) buf[i] = i < apex ? i / apex : (L - i) / (L - apex);
    return centre(buf);
  }
  const r = new Prng(seed);
  const noise = new Float64Array(L);
  for (let i = 0; i < L; i++) noise[i] = r.bipolar();
  // Pick-position comb: x[i] − x[i − pos·L] (circular), notching harmonics at multiples of 1/pos.
  const d = Math.max(1, Math.round(pos * L));
  for (let i = 0; i < L; i++) buf[i] = noise[i] - noise[(i - d + L) % L];
  return centre(buf);
}

/**
 * Advance the buffer by `n` round trips of the KS loop (circular, in place). The loop is
 * linear, so the buffer is renormalised to peak 1 after every pass: only the timbre
 * decays (bright → toward a sine), never the level, so late snapshots stay audible.
 */
function run(buf: Float64Array, b: number, n: number): void {
  const L = buf.length;
  const tmp = new Float64Array(L);
  for (let j = 0; j < n; j++) {
    let peak = 0;
    for (let i = 0; i < L; i++) {
      tmp[i] = (1 - 0.5 * b) * buf[i] + 0.5 * b * buf[(i - 1 + L) % L];
      peak = Math.max(peak, Math.abs(tmp[i]));
    }
    if (peak > 0) for (let i = 0; i < L; i++) buf[i] = tmp[i] / peak;
  }
}

/** Table `index` of a batch: the buffer after start + index·passes round trips. */
export function karplusTable(p: KsParams, seed: number, index: number): Float32Array {
  const L = clamp(Math.round(p.length), 16, 512);
  const buf = excite(p, L, seed >>> 0);
  const passes = clamp(Math.round(p.passes), 1, 64);
  run(buf, clamp(p.damping, 0, 1), Math.max(0, Math.round(p.start)) + index * passes);
  return shape(resamplePeriodic(buf));
}
