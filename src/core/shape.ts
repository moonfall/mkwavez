import { KMAX, TABLE_SIZE } from './constants';
import { fft } from './fft';

export interface ShapeOptions {
  /** Gaussian low-pass cutoff in harmonics: weight exp(-(k/kc)^2). 0/undefined = none. */
  lowpassHarmonic?: number;
  /** Highest harmonic kept (default KMAX). */
  kmax?: number;
}

/** Relative magnitude below which a harmonic is considered absent for phase alignment. */
const ALIGN_EPS = 1e-6;

/**
 * The table pipeline every new table goes through:
 *  1. FFT the 2048-sample cycle.
 *  2. Remove DC, zero harmonics above kmax, optional Gaussian low-pass.
 *  3. Rotate (exact fractional circular shift, done in the frequency domain) so the
 *     fundamental has sine phase (-pi/2 in cosine terms). If the fundamental is absent,
 *     the lowest present harmonic is aligned instead.
 *  4. Inverse FFT and peak-normalise to +-1.
 *
 * Input may be any length-2048 numeric array; output is a new Float32Array.
 */
export function shape(x: ArrayLike<number>, opts: ShapeOptions = {}): Float32Array {
  const n = TABLE_SIZE;
  if (x.length !== n) throw new Error(`shape(): expected ${n} samples, got ${x.length}`);
  const kmax = Math.min(opts.kmax ?? KMAX, n / 2 - 1);
  const kc = opts.lowpassHarmonic ?? 0;

  const re = Float64Array.from(x);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) if (!Number.isFinite(re[i])) re[i] = 0;
  fft(re, im, false);

  // Band-limit + optional low-pass; work on positive bins only, mirror at the end.
  re[0] = 0;
  im[0] = 0;
  let maxMag = 0;
  for (let k = 1; k < n / 2; k++) {
    const w = k > kmax ? 0 : kc > 0 ? Math.exp(-(k / kc) * (k / kc)) : 1;
    re[k] *= w;
    im[k] *= w;
    maxMag = Math.max(maxMag, Math.hypot(re[k], im[k]));
  }

  // Phase alignment: choose the lowest harmonic with meaningful energy.
  if (maxMag > 0) {
    let k0 = 0;
    for (let k = 1; k <= kmax; k++) {
      if (Math.hypot(re[k], im[k]) > maxMag * ALIGN_EPS) {
        k0 = k;
        break;
      }
    }
    if (k0 > 0) {
      const phi = Math.atan2(im[k0], re[k0]);
      // Circular shift by delta (radians of the fundamental): bin k gains phase k*delta.
      const delta = (-Math.PI / 2 - phi) / k0;
      for (let k = 1; k <= kmax; k++) {
        const c = Math.cos(k * delta);
        const s = Math.sin(k * delta);
        const r = re[k] * c - im[k] * s;
        im[k] = re[k] * s + im[k] * c;
        re[k] = r;
      }
    }
  }

  for (let k = 1; k < n / 2; k++) {
    re[n - k] = re[k];
    im[n - k] = -im[k];
  }
  re[n / 2] = 0;
  im[n / 2] = 0;
  fft(re, im, true);

  const y = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(re[i]));
  if (peak > 1e-12) for (let i = 0; i < n; i++) y[i] = re[i] / peak;
  return y;
}

/** Linear interpolated read at fractional, wrapping index. */
export function lerpAt(x: ArrayLike<number>, f: number): number {
  const n = x.length;
  f = ((f % n) + n) % n;
  const j = Math.floor(f);
  const t = f - j;
  return x[j] * (1 - t) + x[(j + 1) % n] * t;
}

/** Build a raw cycle from fn(i) and pass it through shape(). */
export function shapeFrom(fn: (i: number) => number, opts?: ShapeOptions): Float32Array {
  const y = new Float64Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i++) y[i] = fn(i);
  return shape(y, opts);
}
