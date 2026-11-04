/**
 * Turning a recording into waveforms (Generate → Sample). A take is mono samples at a
 * sample rate; positions are in seconds.
 *
 *  - Single cycle: `cycles` consecutive periods from a position (snapped to a rising zero
 *    crossing or used as is), each resampled to TABLE_SIZE and averaged (noise and small
 *    period errors average out), the seam where the cycle loops crossfaded.
 *  - Series: frames spread over a selection (evenly, at onsets, or where the timbre
 *    changes), each a cut cycle at its own (tracked) or a fixed pitch, optionally smoothed
 *    into its neighbours so a wavetable scans without jitter.
 *  - Harmonic snapshot (harmonic.ts): a cycle rebuilt from the partials measured around a
 *    position, for noisy, chorused or slightly inharmonic sounds.
 *
 * Every result goes through shape() (band-limit, DC, phase alignment unless "as cut",
 * peak normalisation), like every other waveform.
 */
import { TABLE_SIZE } from '../constants';
import { realFft } from '../fft';
import { shape } from '../shape';
import { detectPitch, type Pitch } from './pitch';

export interface Take {
  readonly name: string;
  readonly sampleRate: number;
  readonly data: Float32Array;
}

export const ALIGNS = ['Fundamental (smooth scanning)', 'As cut'] as const;
export const SEAMS = ['Crossfade ends', 'None'] as const;
export const SPACINGS = ['Even', 'At onsets', 'Where the timbre changes'] as const;

/** The crossfaded tail of a cut cycle (fraction of the cycle). */
const SEAM_FRACTION = 1 / 8;
const N = TABLE_SIZE;

/** x at a fractional sample position (Catmull-Rom; 0 outside the take). */
export function sampleAt(x: ArrayLike<number>, pos: number): number {
  const i = Math.floor(pos);
  const t = pos - i;
  const at = (k: number) => (k >= 0 && k < x.length ? x[k] : 0);
  const y0 = at(i - 1);
  const y1 = at(i);
  const y2 = at(i + 1);
  const y3 = at(i + 2);
  return y1 + 0.5 * t * (y2 - y0 + t * (2 * y0 - 5 * y1 + 4 * y2 - y3 + t * (3 * (y1 - y2) + y3 - y0)));
}

/** The rising zero crossing nearest `pos` within half a period either side (else pos). */
export function snapToZero(x: ArrayLike<number>, pos: number, period: number): number {
  const lo = Math.max(1, Math.floor(pos - period / 2));
  const hi = Math.min(x.length - 1, Math.ceil(pos + period / 2));
  let best = pos;
  let bestD = Infinity;
  for (let i = lo; i < hi; i++) {
    const a = x[i - 1];
    const b = x[i];
    if (a < 0 && b >= 0) {
      const z = i - 1 + a / (a - b);
      if (Math.abs(z - pos) < bestD) {
        bestD = Math.abs(z - pos);
        best = z;
      }
    }
  }
  return best;
}

/**
 * The raw cycle (before shape()): `cycles` periods from sample `start`, each resampled to
 * N and averaged; with `seam`, each period's last eighth crossfades into the samples
 * leading into its start, so the cycle loops without a step even if the period is a
 * little off.
 */
export function cutCycle(x: ArrayLike<number>, start: number, period: number, cycles: number, seam: boolean): Float64Array {
  const out = new Float64Array(N);
  const C = Math.max(1, Math.round(cycles));
  const fadeFrom = N * (1 - SEAM_FRACTION);
  for (let c = 0; c < C; c++) {
    const s = start + c * period;
    for (let i = 0; i < N; i++) {
      const p = s + (i * period) / N;
      let v = sampleAt(x, p);
      if (seam && i >= fadeFrom) {
        const w = (i - fadeFrom) / (N - fadeFrom);
        v = (1 - w) * v + w * sampleAt(x, p - period);
      }
      out[i] += v / C;
    }
  }
  return out;
}

export interface CycleOptions {
  /** Position (seconds). */
  at: number;
  /** Frequency to use (Hz), or null to detect it at the position. */
  freq: number | null;
  /** Fine tune in cents (shifts the period). */
  cents: number;
  cycles: number;
  /** ALIGNS index. */
  align: number;
  /** SEAMS index. */
  seam: number;
}

export interface Cycle {
  data: Float32Array;
  /** Frequency used (Hz) and the detected pitch there (null: unvoiced / overridden). */
  freq: number;
  pitch: Pitch | null;
  /** Where the cut starts (seconds). */
  start: number;
  /** Seconds the cut spans. */
  span: number;
}

/** Fallback frequency where nothing periodic is found (a 2048-sample cycle at 48 kHz). */
export const FALLBACK_HZ = 48000 / TABLE_SIZE;

/** One cycle of a take at a position (null if the position is outside the take). */
export function cycleAt(take: Take, o: CycleOptions): Cycle | null {
  const sr = take.sampleRate;
  const center = o.at * sr;
  if (!(center >= 0 && center < take.data.length)) return null;
  const pitch = o.freq === null ? detectPitch(take.data, sr, center) : null;
  const freq0 = o.freq ?? pitch?.freq ?? FALLBACK_HZ;
  const freq = freq0 * Math.pow(2, o.cents / 1200);
  const period = sr / freq;
  const start = Math.round(o.align) === 1 ? center : snapToZero(take.data, center, period);
  const raw = cutCycle(take.data, start, period, o.cycles, Math.round(o.seam) === 0);
  return { data: shape(raw, { align: Math.round(o.align) !== 1 }), freq, pitch, start: start / sr, span: (o.cycles * period) / sr };
}

/** N candidate cycles from a position: cycle groups one after another (pick the cleanest). */
export function cycleCandidates(take: Take, o: CycleOptions, count: number): Cycle[] {
  const first = cycleAt(take, o);
  if (!first) return [];
  const out = [first];
  for (let i = 1; i < count; i++) {
    const c = cycleAt(take, { ...o, at: first.start + i * first.span, freq: o.freq ?? first.freq * Math.pow(2, -o.cents / 1200) });
    if (!c) break;
    out.push(c);
  }
  return out;
}

// ---------------- series ----------------

/** Short-time magnitude frames (hop / size in samples), for onsets and timbre change. */
function stft(x: ArrayLike<number>, a: number, b: number, size = 2048, hop = 1024): { t: number[]; mags: Float64Array[] } {
  const t: number[] = [];
  const mags: Float64Array[] = [];
  const win = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  for (let s = Math.max(0, Math.floor(a)); s + size <= Math.min(x.length, Math.ceil(b) + size); s += hop) {
    const seg = new Float64Array(size);
    for (let i = 0; i < size; i++) seg[i] = (x[s + i] ?? 0) * win[i];
    const { re, im } = realFft(seg);
    const m = new Float64Array(size / 2);
    for (let k = 0; k < size / 2; k++) m[k] = Math.hypot(re[k], im[k]);
    t.push(s + size / 2);
    mags.push(m);
  }
  return { t, mags };
}

/** `n` positions (samples) from a to b, evenly (endpoints included). */
function even(a: number, b: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => (n > 1 ? a + ((b - a) * i) / (n - 1) : (a + b) / 2));
}

/**
 * Frame positions (seconds) for a series over [a, b] seconds: evenly; at the `n`
 * strongest onsets (spectral flux peaks, a little after each, filled evenly where there
 * are fewer); or at equal steps of accumulated timbre change (more frames where the
 * sound changes most).
 */
export function framePositions(take: Take, a: number, b: number, n: number, spacing: number): number[] {
  const sr = take.sampleRate;
  const lo = Math.max(0, Math.min(a, b)) * sr;
  const hi = Math.min(take.data.length - 1, Math.max(a, b) * sr);
  const sp = Math.round(spacing);
  if (sp === 0 || n < 2 || hi - lo < 4096) return even(lo, hi, n).map((s) => s / sr);
  const { t, mags } = stft(take.data, lo, hi);
  if (mags.length < 3) return even(lo, hi, n).map((s) => s / sr);
  if (sp === 1) {
    // Spectral flux (positive log-magnitude increase); peaks above the mean.
    const flux = mags.map((m, i) => {
      if (!i) return 0;
      let f = 0;
      for (let k = 1; k < m.length; k++) f += Math.max(0, Math.log1p(m[k]) - Math.log1p(mags[i - 1][k]));
      return f;
    });
    const mean = flux.reduce((s, v) => s + v, 0) / flux.length;
    const peaks: { s: number; f: number }[] = [];
    for (let i = 1; i < flux.length - 1; i++)
      if (flux[i] > mean && flux[i] >= flux[i - 1] && flux[i] > flux[i + 1]) peaks.push({ s: Math.min(hi, t[i] + 0.02 * sr), f: flux[i] });
    const chosen = peaks
      .sort((p, q) => q.f - p.f)
      .slice(0, n)
      .map((p) => p.s);
    // Fewer onsets than frames: fill the largest gaps evenly.
    const all = [lo, ...chosen.sort((p, q) => p - q), hi];
    while (chosen.length < n) {
      let gi = 0;
      for (let i = 1; i < all.length - 1; i++) if (all[i + 1] - all[i] > all[gi + 1] - all[gi]) gi = i;
      const mid = (all[gi] + all[gi + 1]) / 2;
      all.splice(gi + 1, 0, mid);
      chosen.push(mid);
    }
    return chosen.sort((p, q) => p - q).map((s) => s / sr);
  }
  // Timbre change: normalised spectra; cumulative L1 distance between neighbours.
  const norm = mags.map((m) => {
    const s = m.reduce((acc, v) => acc + v, 0) || 1;
    return m.map((v) => v / s);
  });
  const cum = [0];
  for (let i = 1; i < norm.length; i++) {
    let d = 0;
    for (let k = 0; k < norm[i].length; k++) d += Math.abs(norm[i][k] - norm[i - 1][k]);
    cum.push(cum[i - 1] + d);
  }
  const total = cum[cum.length - 1];
  if (!(total > 1e-9)) return even(lo, hi, n).map((s) => s / sr);
  return Array.from({ length: n }, (_, i) => {
    const target = (total * i) / (n - 1);
    let j = 1;
    while (j < cum.length - 1 && cum[j] < target) j++;
    const f = cum[j] > cum[j - 1] ? (target - cum[j - 1]) / (cum[j] - cum[j - 1]) : 0;
    const s = t[j - 1] + (t[j] - t[j - 1]) * f;
    return Math.max(lo, Math.min(hi, s)) / sr;
  });
}

export interface SeriesOptions {
  a: number;
  b: number;
  frames: number;
  /** SPACINGS index. */
  spacing: number;
  cyclesPerFrame: number;
  /** Track the pitch per frame (true) or use `freq` for all (null: detect once at the selection's centre). */
  track: boolean;
  freq: number | null;
  align: number;
  seam: number;
  /** 0 … 1: blend each frame toward its neighbours. */
  smooth: number;
}

export interface Frame extends Cycle {
  /** The frame's position (seconds). */
  at: number;
}

/** The frames of a series (shaped; smoothed into their neighbours when asked). */
export function seriesFrames(take: Take, o: SeriesOptions): Frame[] {
  const at = framePositions(take, o.a, o.b, Math.max(1, Math.round(o.frames)), o.spacing);
  const fixed = o.track ? null : (o.freq ?? detectPitch(take.data, take.sampleRate, ((o.a + o.b) / 2) * take.sampleRate)?.freq ?? FALLBACK_HZ);
  let prev = fixed ?? FALLBACK_HZ;
  const frames: Frame[] = [];
  for (const t of at) {
    // Unvoiced frames keep the previous frame's pitch (so a breath doesn't jump the period).
    const freq = fixed ?? detectPitch(take.data, take.sampleRate, t * take.sampleRate)?.freq ?? prev;
    prev = freq;
    const c = cycleAt(take, { at: t, freq, cents: 0, cycles: o.cyclesPerFrame, align: o.align, seam: o.seam });
    if (c) frames.push({ ...c, at: t });
  }
  const s = Math.max(0, Math.min(1, o.smooth));
  if (s > 0 && frames.length > 2) {
    const src = frames.map((f) => f.data);
    frames.forEach((f, i) => {
      const a = src[Math.max(0, i - 1)];
      const b = src[Math.min(src.length - 1, i + 1)];
      const mixed = Float64Array.from(src[i], (v, k) => (1 - s) * v + (s / 2) * (a[k] + b[k]));
      f.data = shape(mixed, { align: Math.round(o.align) !== 1 });
    });
  }
  return frames;
}
