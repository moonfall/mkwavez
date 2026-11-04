/**
 * Karplus-Strong snapshots: excite a circular "string" buffer (seeded noise burst or a
 * triangle pluck), run it through the KS averaging loop, and take the string after n round
 * trips as a table. A batch sweeps n from Start pass to "Batch → pass" on a log scale: the
 * string's timbre decays exponentially, and its low harmonics (where a pluck's energy is)
 * take hundreds of passes to change while a noise burst's highs go in a few, so evenly
 * spaced snapshots would show either no change or only the tail.
 *
 * The loop is linear and circulant, so each harmonic k of the buffer (length L) is just
 * multiplied by H(ω_k)^n, H(ω) = (1 − b/2) + (b/2)·e^(−iω), ω_k = 2πk/L: computed in closed
 * form (log magnitude, so any n costs the same and nothing underflows) and resynthesised
 * band-limited at the table size (harmonics k ≤ min(KMAX, (L−1)/2)), so short strings stay clean.
 */
import { KMAX, TABLE_SIZE } from '../constants';
import { Prng } from '../prng';
import { shape } from '../shape';
import { batchU } from './perlin';

export interface KsParams {
  /** 0 = seeded noise burst, 1 = triangle pluck. */
  excite: number;
  /** String (buffer) length in samples, 16..512. */
  length: number;
  /** Averaging-filter amount per pass, 0 (none) .. 1 (classic KS ½(x[i]+x[i−1])). */
  damping: number;
  /** Round trips before the first snapshot of a batch. */
  start: number;
  /** Round trips at the last snapshot (log-spaced from start; below start sweeps back). */
  end: number;
  /** Pluck position along the string, 0.02..0.5 (comb on noise; apex of the pluck). */
  position: number;
}

export const DEFAULT_KS: KsParams = { excite: 0, length: 96, damping: 0.6, start: 0, end: 1000, position: 0.2 };
/** Highest Start / Batch → pass. */
export const KS_MAX_PASS = 4096;

/** Harmonics below this fraction of the strongest one are float residue: dropped. */
const LN_RESIDUE = Math.log(1e-9);

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** The excited buffer before any pass (its mean is irrelevant: DC is dropped). Exported for display (Seed's basis plot). */
export function ksExcite(p: Pick<KsParams, 'excite' | 'position'>, L: number, seed: number): Float64Array {
  const buf = new Float64Array(L);
  const pos = clamp(p.position, 0.02, 0.5);
  if (Math.round(p.excite) === 1) {
    const apex = pos * L;
    for (let i = 0; i < L; i++) buf[i] = i < apex ? i / apex : (L - i) / (L - apex);
    return buf;
  }
  const r = new Prng(seed);
  const noise = new Float64Array(L);
  for (let i = 0; i < L; i++) noise[i] = r.bipolar();
  // Pick-position comb: x[i] − x[i − pos·L] (circular), notching harmonics at multiples of 1/pos.
  const d = Math.max(1, Math.round(pos * L));
  for (let i = 0; i < L; i++) buf[i] = noise[i] - noise[(i - d + L) % L];
  return buf;
}

/** Round trips for snapshot u ∈ [0, 1]: log-spaced from start to end (start + (|end − start| + 1)^u − 1). */
export function ksPasses(start: number, end: number, u: number): number {
  const a = clamp(start, 0, KS_MAX_PASS);
  const b = clamp(end, 0, KS_MAX_PASS);
  const d = Math.pow(Math.abs(b - a) + 1, u) - 1;
  return b >= a ? a + d : a - d;
}

/**
 * The string after n round trips (n ≥ 0, not necessarily whole), band-limited at the table
 * size and normalised by shape(): only the timbre decays (bright → toward a sine), never
 * the level, so late snapshots stay audible.
 */
export function ksString(buf: ArrayLike<number>, damping: number, n: number): Float32Array {
  return shape(ksRaw(buf, damping, n));
}

/** ksString() before shape(). */
export function ksRaw(buf: ArrayLike<number>, damping: number, n: number): Float64Array {
  const L = buf.length;
  const K = Math.min(KMAX, Math.floor((L - 1) / 2));
  const b = clamp(damping, 0, 1);
  const logMag = new Float64Array(K + 1).fill(-Infinity);
  const phase = new Float64Array(K + 1);
  let top = -Infinity;
  for (let k = 1; k <= K; k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < L; i++) {
      const a = (2 * Math.PI * k * i) / L;
      re += buf[i] * Math.cos(a);
      im -= buf[i] * Math.sin(a);
    }
    const mag = Math.hypot(re, im);
    if (mag === 0) continue;
    let lm = Math.log(mag);
    let ph = Math.atan2(im, re);
    if (n > 0) {
      const w = (2 * Math.PI * k) / L;
      const hr = 1 - 0.5 * b + 0.5 * b * Math.cos(w);
      const hi = -0.5 * b * Math.sin(w);
      const hm = Math.hypot(hr, hi);
      if (hm === 0) continue; // classic KS (b = 1) zeroes the Nyquist harmonic in one pass
      lm += n * Math.log(hm);
      ph += n * Math.atan2(hi, hr);
    }
    logMag[k] = lm;
    phase[k] = ph;
    top = Math.max(top, lm);
  }
  const out = new Float64Array(TABLE_SIZE);
  for (let k = 1; k <= K; k++) {
    const rel = logMag[k] - top;
    if (!(rel > LN_RESIDUE)) continue;
    const amp = Math.exp(rel);
    for (let i = 0; i < TABLE_SIZE; i++) out[i] += amp * Math.cos((2 * Math.PI * k * i) / TABLE_SIZE + phase[k]);
  }
  return out;
}

/** Table `index` of a batch of `count`: the string after ksPasses(start, end, u) round trips. */
export function karplusTable(p: KsParams, seed: number, index: number, count: number): Float32Array {
  const L = clamp(Math.round(p.length), 16, 512);
  return ksString(ksExcite(p, L, seed >>> 0), p.damping, ksPasses(p.start, p.end, batchU(index, count)));
}

/** The raw cycle (before shape()) of the string after `passes` round trips. */
export function karplusRaw(
  p: Pick<KsParams, 'excite' | 'length' | 'damping' | 'position'>,
  passes: number,
  seed: number,
): Float64Array {
  const L = clamp(Math.round(p.length), 16, 512);
  return ksRaw(ksExcite(p, L, seed >>> 0), p.damping, passes);
}
