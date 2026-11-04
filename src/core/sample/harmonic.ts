/**
 * Harmonic snapshot: a cycle rebuilt from the partials measured around a position,
 * instead of cut from the waveform — robust for noisy, chorused or slightly inharmonic
 * sounds, where a cut cycle never loops cleanly. A Hann window of `windowCycles` periods
 * is analysed at each harmonic k·f0 (k ≤ harmonics, below Nyquist): its amplitude is the
 * response exactly there ("drop" off-harmonic energy) or the energy summed over ±f0/2
 * ("fold" it into the nearest harmonic); partials under the floor (dB below the strongest)
 * are dropped; phases are the measured ones, all zero (smoothest) or Schroeder's (low
 * crest factor). The cycle is the additive resynthesis at TABLE_SIZE.
 */
import { KMAX, TABLE_SIZE } from '../constants';
import { shape } from '../shape';
import { cycleAt, FALLBACK_HZ, framePositions, type Frame, type Take } from './extract';
import { detectPitch } from './pitch';

export const PHASE_MODES = ['Keep measured', 'Zero (smoothest)', 'Schroeder (low crest)'] as const;
export const OFF_HARMONIC = ['Fold into nearest harmonic', 'Drop'] as const;
/** Points per harmonic band when folding (±f0/2). */
const FOLD_POINTS = 9;

export interface HarmonicOptions {
  windowCycles: number;
  harmonics: number;
  /** PHASE_MODES index. */
  phases: number;
  /** OFF_HARMONIC index. */
  off: number;
  /** Floor, dB below the strongest partial (e.g. −60). */
  floorDb: number;
}

export interface Partials {
  /** amp[k], phase[k] for harmonic k (index 0 unused). */
  amp: Float64Array;
  phase: Float64Array;
}

/** The partials of `x` around sample `center` at fundamental `freq`. */
export function measurePartials(x: ArrayLike<number>, sr: number, center: number, freq: number, o: HarmonicOptions): Partials {
  const H = Math.max(1, Math.min(KMAX, Math.round(o.harmonics), Math.floor((sr / 2 - 1) / freq)));
  const L = Math.max(16, Math.round((Math.max(1, o.windowCycles) * sr) / freq));
  const start = Math.round(center - L / 2);
  const seg = new Float64Array(L);
  for (let j = 0; j < L; j++) {
    const v = x[start + j] ?? 0;
    seg[j] = v * (0.5 - 0.5 * Math.cos((2 * Math.PI * (j + 0.5)) / L));
  }
  /** DFT of the windowed segment at frequency f (Hz), its phase referred to the segment centre. */
  const dft = (f: number): [number, number] => {
    const w = (2 * Math.PI * f) / sr;
    let re = 0;
    let im = 0;
    // Rotation recurrence: one cos / sin per call.
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    let c = 1;
    let s = 0;
    for (let j = 0; j < L; j++) {
      re += seg[j] * c;
      im -= seg[j] * s;
      const nc = c * cw - s * sw;
      s = s * cw + c * sw;
      c = nc;
    }
    // Refer the phase to the segment centre (so it doesn't depend on where the window starts).
    const ph = (w * L) / 2;
    return [re * Math.cos(ph) - im * Math.sin(ph), re * Math.sin(ph) + im * Math.cos(ph)];
  };
  const amp = new Float64Array(H + 1);
  const phase = new Float64Array(H + 1);
  const fold = Math.round(o.off) === 0;
  for (let k = 1; k <= H; k++) {
    const [re, im] = dft(k * freq);
    phase[k] = Math.atan2(im, re);
    if (!fold) amp[k] = Math.hypot(re, im);
    else {
      let e = 0;
      for (let q = 0; q < FOLD_POINTS; q++) {
        const f = (k + (q / (FOLD_POINTS - 1) - 0.5)) * freq;
        if (f <= 0 || f >= sr / 2) continue;
        const [r2, i2] = q === (FOLD_POINTS - 1) / 2 ? [re, im] : dft(f);
        e += r2 * r2 + i2 * i2;
      }
      amp[k] = Math.sqrt(e / FOLD_POINTS);
    }
  }
  const top = Math.max(1e-30, ...amp);
  const floor = top * Math.pow(10, Math.min(0, o.floorDb) / 20);
  for (let k = 1; k <= H; k++) if (amp[k] < floor) amp[k] = 0;
  return { amp, phase };
}

/** Additive resynthesis (before shape()) of partials with the chosen phases. */
export function resynth(p: Partials, phases: number): Float64Array {
  const H = p.amp.length - 1;
  const mode = Math.round(phases);
  const out = new Float64Array(TABLE_SIZE);
  for (let k = 1; k <= H; k++) {
    const a = p.amp[k];
    if (!a) continue;
    // Measured phase is of cos(ωt + φ); zero and Schroeder phases are of sines.
    const ph = mode === 0 ? p.phase[k] : mode === 2 ? (Math.PI * k * k) / H - Math.PI / 2 : -Math.PI / 2;
    const w = (2 * Math.PI * k) / TABLE_SIZE;
    for (let i = 0; i < TABLE_SIZE; i++) out[i] += a * Math.cos(w * i + ph);
  }
  return out;
}

export interface SnapshotOptions extends HarmonicOptions {
  at: number;
  /** Frequency to use, or null to detect it. */
  freq: number | null;
}

/** A harmonic snapshot at a position (null outside the take or when nothing is measured). */
export function snapshotAt(take: Take, o: SnapshotOptions): Frame | null {
  const sr = take.sampleRate;
  const center = o.at * sr;
  if (!(center >= 0 && center < take.data.length)) return null;
  const pitch = o.freq === null ? detectPitch(take.data, sr, center) : null;
  const freq = o.freq ?? pitch?.freq ?? FALLBACK_HZ;
  const p = measurePartials(take.data, sr, center, freq, o);
  if (!p.amp.some((a) => a > 0)) return null;
  const raw = resynth(p, o.phases);
  const span = (o.windowCycles / freq) as number;
  return { data: shape(raw), freq, pitch, start: o.at - span / 2, span, at: o.at };
}

/** Snapshots over a selection (positions as a series), at tracked or fixed pitch. */
export function snapshotSeries(take: Take, o: HarmonicOptions & { a: number; b: number; frames: number; spacing: number; track: boolean; freq: number | null }): Frame[] {
  const at = framePositions(take, o.a, o.b, Math.max(1, Math.round(o.frames)), o.spacing);
  const fixed = o.track ? null : (o.freq ?? cycleAt(take, { at: (o.a + o.b) / 2, freq: null, cents: 0, cycles: 1, align: 0, seam: 0 })?.freq ?? FALLBACK_HZ);
  let prev = fixed ?? FALLBACK_HZ;
  const out: Frame[] = [];
  for (const t of at) {
    const freq = fixed ?? detectPitch(take.data, take.sampleRate, t * take.sampleRate)?.freq ?? prev;
    prev = freq;
    const s = snapshotAt(take, { ...o, at: t, freq });
    if (s) out.push(s);
  }
  return out;
}
