/**
 * Zero-delay-feedback state-variable filter (trapezoidal integration, after Andrew Simper /
 * Cytomic "SvfLinearTrapOptimised2"): stable for any cutoff below Nyquist and any damping
 * k > 0, cheap enough to recompute the coefficients every sample, so cutoff modulation is
 * smooth. LP12 / HP / BP / notch come from one SVF; LP24 is two in series (the first at
 * the 4-pole Butterworth's low Q, the second carries the resonance). Portable: plain
 * numbers, no allocation.
 */
import type { FilterMode } from '../synth';

/** Highest cutoff as a fraction of the sample rate (tan() stays finite well below Nyquist). */
export const MAX_CUTOFF_FRACTION = 0.49;
export const MIN_CUTOFF_HZ = 8;

/** Damping of the first LP24 stage: 1 / 0.541 (4-pole Butterworth). */
const LP24_K1 = 1.848;
/** Damping of the second LP24 stage at zero resonance: 1 / 1.307. */
const LP24_K2 = 0.765;
/** Smallest damping (resonance 1): Q = 100, rings for a long time but never grows. */
const K_MIN = 0.01;

/** Damping k = 1/Q for resonance 0..1 (k 2 → 0.01: Q 0.5 → 100, steep near the top). */
export function resonanceK(res: number): number {
  const r = Math.max(0, Math.min(1, res));
  return Math.max(K_MIN, 2 * (1 - 0.995 * r));
}

/** g = tan(π·fc / sr) with fc clamped to [MIN_CUTOFF_HZ, MAX_CUTOFF_FRACTION·sr]. */
export function cutoffG(fc: number, sampleRate: number): number {
  const f = Math.max(MIN_CUTOFF_HZ, Math.min(MAX_CUTOFF_FRACTION * sampleRate, fc));
  return Math.tan((Math.PI * f) / sampleRate);
}

export const FILTER_MODE_INDEX: Readonly<Record<FilterMode, number>> = { lp12: 0, lp24: 1, hp: 2, bp: 3, notch: 4 };

/** One channel of the multimode filter (two SVF cores' state). */
export class MultiFilter {
  private s1 = 0;
  private s2 = 0;
  private t1 = 0;
  private t2 = 0;

  reset(): void {
    this.s1 = this.s2 = this.t1 = this.t2 = 0;
  }

  /** Flush denormal-range state (call once per control block). */
  flush(): void {
    if (Math.abs(this.s1) < 1e-20) this.s1 = 0;
    if (Math.abs(this.s2) < 1e-20) this.s2 = 0;
    if (Math.abs(this.t1) < 1e-20) this.t1 = 0;
    if (Math.abs(this.t2) < 1e-20) this.t2 = 0;
  }

  /**
   * Filter one sample. `mode` = FILTER_MODE_INDEX, `g` from cutoffG, `res` 0..1 (pass
   * resonanceK(res) as `k`). BP is normalised to unity gain at the cutoff.
   */
  process(x: number, mode: number, g: number, k: number): number {
    if (mode === 1) {
      // LP24: Butterworth-ish first stage, resonant second stage.
      const kk = Math.min(LP24_K2, k * (LP24_K2 / 2) + K_MIN * 0.5);
      let a1 = 1 / (1 + g * (g + LP24_K1));
      let a2 = g * a1;
      let a3 = g * a2;
      let v3 = x - this.s2;
      let v1 = a1 * this.s1 + a2 * v3;
      let v2 = this.s2 + a2 * this.s1 + a3 * v3;
      this.s1 = 2 * v1 - this.s1;
      this.s2 = 2 * v2 - this.s2;
      a1 = 1 / (1 + g * (g + kk));
      a2 = g * a1;
      a3 = g * a2;
      v3 = v2 - this.t2;
      v1 = a1 * this.t1 + a2 * v3;
      v2 = this.t2 + a2 * this.t1 + a3 * v3;
      this.t1 = 2 * v1 - this.t1;
      this.t2 = 2 * v2 - this.t2;
      return v2;
    }
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = x - this.s2;
    const v1 = a1 * this.s1 + a2 * v3;
    const v2 = this.s2 + a2 * this.s1 + a3 * v3;
    this.s1 = 2 * v1 - this.s1;
    this.s2 = 2 * v2 - this.s2;
    switch (mode) {
      case 0:
        return v2;
      case 2:
        return x - k * v1 - v2;
      case 3:
        return k * v1;
      default:
        return x - k * v1;
    }
  }
}

/**
 * Magnitude response of the filter at frequency f (exact for the trapezoidal SVF: the
 * analog prototype at s = j·tan(πf/sr)/g). For drawing the response curve.
 */
export function filterResponse(mode: FilterMode, fc: number, res: number, f: number, sampleRate: number): number {
  const g = cutoffG(fc, sampleRate);
  const k = resonanceK(res);
  const w = Math.tan((Math.PI * Math.min(f, 0.4999 * sampleRate)) / sampleRate) / g;
  const w2 = w * w;
  // |1 / (1 − w² + j·k·w)|
  const den = (kk: number) => Math.sqrt((1 - w2) * (1 - w2) + kk * kk * w2);
  switch (mode) {
    case 'lp12':
      return 1 / den(k);
    case 'lp24': {
      const kk = Math.min(LP24_K2, k * (LP24_K2 / 2) + K_MIN * 0.5);
      return 1 / (den(LP24_K1) * den(kk));
    }
    case 'hp':
      return w2 / den(k);
    case 'bp':
      return (k * w) / den(k);
    case 'notch':
      return Math.abs(1 - w2) / den(k);
  }
}

/**
 * Pre-filter drive: a crossfade from clean (drive 0) to tanh saturation with up to 9×
 * gain, normalised so a full-scale input stays near full scale.
 */
export function driveSample(x: number, drive: number): number {
  if (drive <= 0) return x;
  const gain = 1 + 8 * drive;
  return x * (1 - drive) + (drive * Math.tanh(gain * x)) / Math.tanh(gain);
}

/** Soft limiter for the voice output: linear up to ±1, then bends smoothly towards ±2. */
export function softLimit(x: number): number {
  if (x > 1) return 1 + Math.tanh(x - 1);
  if (x < -1) return -1 - Math.tanh(-x - 1);
  return x;
}
