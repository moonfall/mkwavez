/**
 * Pitch detection for sampled audio: YIN (de Cheveigné & Kawahara, 2002) — the cumulative
 * mean normalised difference function, its first dip under a threshold, refined by
 * parabolic interpolation — with the difference function computed through an FFT
 * autocorrelation, so a 40 Hz floor costs a few FFTs rather than O(W²).
 */
import { fft } from '../fft';

export const PITCH_MIN_HZ = 40;
export const PITCH_MAX_HZ = 2000;
/** CMNDF threshold: the first dip below it is the period. */
const THRESHOLD = 0.15;

export interface Pitch {
  /** Period in samples (fractional). */
  period: number;
  freq: number;
  /** 1 − the CMNDF dip (1 = perfectly periodic). */
  confidence: number;
}

const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));

/**
 * The pitch around sample `center` of `x` (sample rate `sr`), or null when the window is
 * silent or nothing in [minHz, maxHz] is periodic.
 */
export function detectPitch(x: ArrayLike<number>, sr: number, center: number, minHz = PITCH_MIN_HZ, maxHz = PITCH_MAX_HZ): Pitch | null {
  const maxLag = Math.min(Math.ceil(sr / minHz), Math.floor(x.length / 2) - 1);
  const minLag = Math.max(2, Math.floor(sr / maxHz));
  if (maxLag <= minLag + 2) return null;
  const L = maxLag; // integration length
  const W = L + maxLag; // window
  const s0 = Math.round(center - W / 2);
  const start = Math.max(0, Math.min(x.length - W, s0));
  const s = new Float64Array(W);
  for (let j = 0; j < W; j++) s[j] = x[start + j] ?? 0;
  let energy = 0;
  for (let j = 0; j < W; j++) energy += s[j] * s[j];
  if (!(energy / W > 1e-10)) return null;

  // r(τ) = Σ_{j<L} s_j·s_{j+τ}: correlate the first L samples with the whole window.
  const n = nextPow2(W + L);
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  for (let j = 0; j < L; j++) ar[j] = s[j];
  for (let j = 0; j < W; j++) br[j] = s[j];
  fft(ar, ai, false);
  fft(br, bi, false);
  for (let k = 0; k < n; k++) {
    // conj(A)·B
    const re = ar[k] * br[k] + ai[k] * bi[k];
    const im = ar[k] * bi[k] - ai[k] * br[k];
    ar[k] = re;
    ai[k] = im;
  }
  fft(ar, ai, true);
  const r = (tau: number) => ar[tau]; // (the inverse FFT divides by n)

  // d(τ) = e1 + e2(τ) − 2 r(τ), e2 from prefix sums of s².
  const pre = new Float64Array(W + 1);
  for (let j = 0; j < W; j++) pre[j + 1] = pre[j] + s[j] * s[j];
  const e1 = pre[L];
  const d = new Float64Array(maxLag + 1);
  for (let tau = 1; tau <= maxLag; tau++) d[tau] = Math.max(0, e1 + (pre[tau + L] - pre[tau]) - 2 * r(tau));
  // Cumulative mean normalised difference.
  const c = new Float64Array(maxLag + 1);
  c[0] = 1;
  let sum = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    sum += d[tau];
    c[tau] = sum > 0 ? (d[tau] * tau) / sum : 1;
  }
  let tau = -1;
  for (let t = minLag; t < maxLag; t++) {
    if (c[t] < THRESHOLD) {
      while (t + 1 < maxLag && c[t + 1] < c[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) {
    // No dip under the threshold: the global minimum, if it is a dip at all.
    let best = minLag;
    for (let t = minLag; t < maxLag; t++) if (c[t] < c[best]) best = t;
    if (c[best] > 0.5) return null;
    tau = best;
  }
  // Parabolic interpolation around the dip.
  const a = c[tau - 1];
  const b = c[tau];
  const cc = c[tau + 1] ?? b;
  const den = a - 2 * b + cc;
  const off = den > 1e-12 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - cc)) / den)) : 0;
  const period = tau + off;
  return { period, freq: sr / period, confidence: Math.max(0, Math.min(1, 1 - b)) };
}

/** Pitches at `count` evenly spaced centres from sample a to b (null where unvoiced). */
export function trackPitch(x: ArrayLike<number>, sr: number, a: number, b: number, count: number, minHz = PITCH_MIN_HZ, maxHz = PITCH_MAX_HZ): (Pitch | null)[] {
  return Array.from({ length: count }, (_, i) => detectPitch(x, sr, count > 1 ? a + ((b - a) * i) / (count - 1) : (a + b) / 2, minHz, maxHz));
}

/** MIDI note name of a frequency, e.g. "A3", and its offset in cents. */
export function noteName(freq: number): { name: string; cents: number } {
  const m = 69 + 12 * Math.log2(freq / 440);
  const n = Math.round(m);
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  return { name: `${names[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`, cents: Math.round((m - n) * 100) };
}
