/**
 * Apparent pitch of a waveform from its harmonic magnitudes: whether it plays the note it
 * is played at. A waveform whose present harmonics are all multiples of d > 1 (an n-gon's
 * radius, a function of sin²) repeats d times per cycle, so it sounds d× higher (2 = an
 * octave); one with a very weak fundamental sounds thin and may be heard higher. Cheap:
 * one pass over the magnitudes (UI: the "sounds +1 oct" badge; the same thresholds as the
 * harmonic-interest evaluation, scripts/harmonics/metrics.ts).
 */

/** Harmonics above this level (dB re the strongest) count as present. */
export const PITCH_PRESENT_DB = -40;
/** A fundamental below this level (dB re the strongest) is weak. */
export const PITCH_WEAK_H1_DB = -40;

export interface ApparentPitch {
  /** Greatest common divisor of the present harmonics (1 = pitched at the note). */
  readonly divisor: number;
  /** Fundamental level, dB re the strongest harmonic (−120 floor). */
  readonly h1Db: number;
  /** Semitones above the played note the waveform sounds (12·log2 divisor). */
  readonly semitones: number;
  /** Fundamental below PITCH_WEAK_H1_DB (always true when divisor > 1). */
  readonly weak: boolean;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/**
 * Apparent pitch from harmonic magnitudes (index k = harmonic k; index 0 ignored), or null
 * for a silent waveform.
 */
export function apparentPitch(mags: ArrayLike<number>): ApparentPitch | null {
  let mx = 0;
  for (let k = 1; k < mags.length; k++) mx = Math.max(mx, Math.abs(mags[k]));
  if (!(mx > 0)) return null;
  const present = mx * Math.pow(10, PITCH_PRESENT_DB / 20);
  let d = 0;
  for (let k = 1; k < mags.length && d !== 1; k++) if (Math.abs(mags[k]) >= present) d = gcd(k, d);
  const h1 = mags.length > 1 ? Math.abs(mags[1]) / mx : 0;
  const h1Db = Math.max(-120, 20 * Math.log10(h1 + 1e-12));
  return { divisor: d, h1Db, semitones: 12 * Math.log2(d), weak: h1Db < PITCH_WEAK_H1_DB };
}

/** Short label ("sounds +1 oct", "sounds +19 st", "weak fundamental"), or '' when the waveform plays its note. */
export function pitchLabel(p: ApparentPitch | null): string {
  if (!p) return '';
  if (p.divisor > 1) {
    const oct = Math.log2(p.divisor);
    return Number.isInteger(oct) ? `sounds +${oct} oct` : `sounds +${Math.round(p.semitones)} st`;
  }
  return p.weak ? 'weak fundamental' : '';
}

/** The explanation behind pitchLabel() (a tooltip), or ''. */
export function pitchExplain(p: ApparentPitch | null): string {
  if (!p || (p.divisor <= 1 && !p.weak)) return '';
  const h1 = p.h1Db <= -119.5 ? 'absent' : `${Math.round(p.h1Db)} dB`;
  if (p.divisor > 1) {
    const st = Math.round(p.semitones);
    return (
      `Every harmonic above ${PITCH_PRESENT_DB} dB is a multiple of ${p.divisor} (fundamental ${h1}): the waveform repeats ` +
      `${p.divisor} times per cycle, so it sounds ${st} semitones above the played note. In a wavetable, moving onto or off ` +
      'it jumps in pitch.'
    );
  }
  return (
    `The fundamental is ${h1} below the strongest harmonic: the waveform sounds thin and may be heard above the played ` +
    'note (at its strongest harmonics).'
  );
}
