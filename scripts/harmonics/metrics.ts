/**
 * Harmonic metrics for single-cycle waveforms and batches of them (the harmonic-interest
 * evaluation, scripts/harmonics/). Pure functions of the harmonic magnitudes 1..KMAX (and,
 * for a few, the time-domain cycle). Nothing here judges taste: each number is a plain
 * description of a spectrum or of how a batch moves; score.ts combines them.
 *
 * Conventions: `mags` is indexed by harmonic number (mags[0] unused, 0), as returned by
 * core/fft.harmonicMagnitudes(x, KMAX). dB values are relative to the strongest harmonic
 * of the same waveform.
 */
import { KMAX } from '../../src/core/constants';
import { harmonicMagnitudes } from '../../src/core/fft';

/** Harmonics evaluated (the app band-limits every waveform to KMAX = 72). */
export const K = KMAX;
/** A harmonic counts as significant above this level (dB re the strongest). */
export const SIG_DB = -60;
/**
 * Floor for log-spectral comparisons (dB re the strongest). −40 dB, not −60: with a deeper
 * floor a faint harmonic appearing from nothing counted as a step of up to 60 dB, which
 * made sparse, jumpy spectra (e.g. Gray code) look like the best movers.
 */
export const LSD_FLOOR_DB = -40;
/** Harmonics above this level (dB re the strongest) define the pitch divisor. */
export const PITCH_DB = -40;
/** Floor for flatness / envelope maths (dB re the strongest). */
const FLOOR_DB = -120;
/** Consecutive waveforms whose log-spectral distance is below this are near-duplicates (dB). */
export const DUP_LSD_DB = 0.5;
/** …and whose time-domain relative RMS difference is above this moved in phase only. */
export const PHASE_ONLY_REL = 0.05;
/** A formant peak must stand this far above its surroundings after detrending (dB). */
export const FORMANT_PROMINENCE_DB = 6;
/** Peak below this (or all-zero cycle) = silent. shape() peak-normalises, so this is rare. */
const SILENT_PEAK = 1e-9;

export interface WaveMetrics {
  /** All-zero (or numerically silent) cycle. */
  silent: boolean;
  /** Harmonics above SIG_DB re the strongest. */
  sigCount: number;
  /** Highest harmonic above SIG_DB (0 when silent). */
  highestSig: number;
  /** Amplitude-weighted mean harmonic number. */
  centroid: number;
  /** Amplitude-weighted standard deviation of the harmonic number. */
  spread: number;
  /** Spectral flatness (Wiener entropy) of the harmonic powers: geometric / arithmetic mean, 0..1. */
  flatness: number;
  /** Shannon entropy of the normalised harmonic powers / ln(K), 0..1. */
  entropy: number;
  /** Least-squares slope of the significant harmonics' dB against log2(k), dB per octave (null: < 3 significant). */
  slopeDbOct: number | null;
  /** Odd harmonics (k ≥ 3) vs even harmonics energy, dB, clamped to ±60. */
  oddEvenDb: number;
  /** Fraction of the energy above the fundamental that is in even harmonics, 0..1. */
  evenFrac: number;
  /** Peak / RMS of the cycle (sine √2, square 1). */
  crest: number;
  /**
   * Noise-like fine structure: RMS difference between neighbouring significant harmonics'
   * levels after removing a smooth trend (quadratic in log2 k), / √2, dB. ≈ 0 for saw /
   * square / smooth formants, ≈ 5–6 dB for random (Rayleigh) magnitudes.
   */
  irregularityDb: number;
  /** Formant-like peaks in the detrended spectral envelope (prominence ≥ FORMANT_PROMINENCE_DB). */
  formantPeaks: number;
  /** Largest such prominence, dB (0 if none). */
  formantProminenceDb: number;
  /** Fundamental level, dB re the strongest harmonic (−120 if absent). */
  h1Db: number;
  /** Fraction of the energy in the fundamental, 0..1. */
  h1Frac: number;
  /**
   * Greatest common divisor of the harmonics above PITCH_DB: 1 for a normal pitched
   * spectrum; g > 1 means every present harmonic is a multiple of g, so the waveform
   * sounds g times higher (2 = an octave up). 0 when silent.
   */
  divisor: number;
}

/** Harmonic magnitudes 1..K of a 2048-sample cycle (index = harmonic number). */
export function harmonics(x: ArrayLike<number>): Float64Array {
  return harmonicMagnitudes(x, K);
}

const db = (r: number) => (r > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(r)) : FLOOR_DB);

function maxOf(m: ArrayLike<number>): number {
  let mx = 0;
  for (let k = 1; k < m.length; k++) if (m[k] > mx) mx = m[k];
  return mx;
}

/** dB re the strongest harmonic, floored at `floor`, index = harmonic number. */
export function relDb(m: ArrayLike<number>, floor = LSD_FLOOR_DB): Float64Array {
  const mx = maxOf(m);
  const out = new Float64Array(m.length).fill(floor);
  out[0] = floor;
  if (mx <= 0) return out;
  for (let k = 1; k < m.length; k++) out[k] = Math.max(floor, db(m[k] / mx));
  return out;
}

/** Ordinary least squares slope of y on x. */
export function lsSlope(x: readonly number[], y: readonly number[]): number {
  const n = x.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
  }
  return sxx > 0 ? sxy / sxx : 0;
}

/**
 * Formant-like peaks: the dB spectrum (floored at SIG_DB) is turned into an envelope (a
 * ±1-harmonic max filter bridges odd-only or sparse spectra, then a 3-tap mean), and
 * interior local maxima (harmonic 2 … K−1) whose topographic prominence — height above
 * the higher of the two flanking minima, each flank running to the next higher point or
 * the edge — reaches FORMANT_PROMINENCE_DB are counted. Monotonic spectra (saw, square,
 * any low-pass) have none; a peak above a weak fundamental counts.
 */
export function formantPeaks(m: ArrayLike<number>): { count: number; prominenceDb: number } {
  const d = relDb(m, SIG_DB);
  const n = m.length - 1; // harmonics 1..n
  if (n < 5) return { count: 0, prominenceDb: 0 };
  const mx = new Float64Array(n + 1);
  for (let k = 1; k <= n; k++) mx[k] = Math.max(d[k], d[Math.max(1, k - 1)], d[Math.min(n, k + 1)]);
  const r = new Float64Array(n + 1);
  for (let k = 1; k <= n; k++) r[k] = (mx[Math.max(1, k - 1)] + mx[k] + mx[Math.min(n, k + 1)]) / 3;
  let count = 0;
  let best = 0;
  for (let k = 2; k < n; k++) {
    if (!(r[k] > r[k - 1] && r[k] >= r[k + 1])) continue;
    // Walk out until a higher point (or the edge), tracking the minimum.
    let lmin = r[k];
    for (let j = k - 1; j >= 1 && r[j] <= r[k]; j--) lmin = Math.min(lmin, r[j]);
    let rmin = r[k];
    for (let j = k + 1; j <= n && r[j] <= r[k]; j++) rmin = Math.min(rmin, r[j]);
    const prom = r[k] - Math.max(lmin, rmin);
    if (prom >= FORMANT_PROMINENCE_DB) {
      count++;
      best = Math.max(best, prom);
    }
  }
  return { count, prominenceDb: best };
}

/** Least squares y ≈ a + b·t + c·t². */
function quadFit(t: readonly number[], y: readonly number[]): [number, number, number] {
  // Normal equations, 3×3.
  const s = [0, 0, 0, 0, 0];
  const r = [0, 0, 0];
  for (let i = 0; i < t.length; i++) {
    let p = 1;
    for (let j = 0; j < 5; j++) {
      s[j] += p;
      if (j < 3) r[j] += p * y[i];
      p *= t[i];
    }
  }
  const A = [
    [s[0], s[1], s[2], r[0]],
    [s[1], s[2], s[3], r[1]],
    [s[2], s[3], s[4], r[2]],
  ];
  for (let i = 0; i < 3; i++) {
    let piv = i;
    for (let j = i + 1; j < 3; j++) if (Math.abs(A[j][i]) > Math.abs(A[piv][i])) piv = j;
    [A[i], A[piv]] = [A[piv], A[i]];
    if (Math.abs(A[i][i]) < 1e-12) return [0, 0, 0];
    for (let j = 0; j < 3; j++) {
      if (j === i) continue;
      const f = A[j][i] / A[i][i];
      for (let k = i; k < 4; k++) A[j][k] -= f * A[i][k];
    }
  }
  return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
}

/**
 * Fine-structure irregularity of a spectrum given as (log2 k, dB) points of its
 * significant harmonics in increasing k: residuals from a quadratic trend, RMS of their
 * first differences / √2 (≈ the residual's standard deviation when it is white). 0 with
 * fewer than 6 points.
 */
export function irregularity(t: readonly number[], d: readonly number[]): number {
  if (t.length < 6) return 0;
  const [a, b, c] = quadFit(t, d);
  const r = t.map((x, i) => d[i] - (a + b * x + c * x * x));
  let s = 0;
  for (let i = 1; i < r.length; i++) s += (r[i] - r[i - 1]) ** 2;
  return Math.sqrt(s / (r.length - 1) / 2);
}

/** Every per-waveform metric from the harmonic magnitudes (and the cycle, for the crest factor). */
export function spectrumMetrics(raw: ArrayLike<number>, x?: ArrayLike<number>): WaveMetrics {
  const mx = maxOf(raw);
  // Harmonics at or below FLOOR_DB (float rounding residue of the 32-bit waveforms) count as absent.
  const m = Float64Array.from(raw, (a, k) => (k > 0 && a > mx * 10 ** (FLOOR_DB / 20) ? a : 0));
  let peak = 0;
  let sumSq = 0;
  if (x) {
    for (let i = 0; i < x.length; i++) {
      peak = Math.max(peak, Math.abs(x[i]));
      sumSq += x[i] * x[i];
    }
  }
  const silent = mx <= SILENT_PEAK || (x !== undefined && peak <= SILENT_PEAK);
  const n = m.length - 1;
  if (silent) {
    return {
      silent: true,
      sigCount: 0,
      highestSig: 0,
      centroid: 0,
      spread: 0,
      flatness: 0,
      entropy: 0,
      slopeDbOct: null,
      oddEvenDb: 0,
      evenFrac: 0,
      crest: 0,
      irregularityDb: 0,
      formantPeaks: 0,
      formantProminenceDb: 0,
      h1Db: FLOOR_DB,
      h1Frac: 0,
      divisor: 0,
    };
  }
  let sigCount = 0;
  let highestSig = 0;
  let sa = 0;
  let ska = 0;
  let e = 0;
  let eOdd = 0;
  let eEven = 0;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let k = 1; k <= n; k++) {
    const a = m[k];
    const d = db(a / mx);
    if (d > SIG_DB) {
      sigCount++;
      highestSig = k;
      xs.push(Math.log2(k));
      ys.push(d);
    }
    sa += a;
    ska += k * a;
    e += a * a;
    if (k >= 3 && k % 2 === 1) eOdd += a * a;
    if (k % 2 === 0) eEven += a * a;
  }
  const centroid = ska / sa;
  let v = 0;
  for (let k = 1; k <= n; k++) v += m[k] * (k - centroid) ** 2;
  const spread = Math.sqrt(v / sa);
  // Flatness and entropy of the powers (each power floored at FLOOR_DB re the strongest).
  const pfloor = (mx * 10 ** (FLOOR_DB / 20)) ** 2;
  let lsum = 0;
  let psum = 0;
  let h = 0;
  for (let k = 1; k <= n; k++) {
    const p = Math.max(pfloor, m[k] * m[k]);
    lsum += Math.log(p);
    psum += p;
  }
  for (let k = 1; k <= n; k++) {
    const q = (m[k] * m[k]) / e;
    if (q > 0) h -= q * Math.log(q);
  }
  const flatness = Math.exp(lsum / n) / (psum / n);
  const tiny = e * 1e-12;
  const oddEvenDb = Math.max(-60, Math.min(60, 10 * Math.log10((eOdd + tiny) / (eEven + tiny))));
  const above = e - m[1] * m[1];
  const fp = formantPeaks(m);
  return {
    silent: false,
    sigCount,
    highestSig,
    centroid,
    spread,
    flatness,
    entropy: h / Math.log(n),
    slopeDbOct: xs.length >= 3 ? lsSlope(xs, ys) : null,
    oddEvenDb,
    evenFrac: above > tiny ? eEven / above : 0,
    crest: x && sumSq > 0 ? peak / Math.sqrt(sumSq / x.length) : 0,
    irregularityDb: irregularity(xs, ys),
    formantPeaks: fp.count,
    formantProminenceDb: fp.prominenceDb,
    h1Db: db(m[1] / mx),
    h1Frac: m[1] * m[1] / e,
    divisor: pitchDivisor(m),
  };
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** GCD of the harmonics above PITCH_DB re the strongest (0 if none). */
export function pitchDivisor(m: ArrayLike<number>): number {
  const mx = maxOf(m);
  if (mx <= 0) return 0;
  let g = 0;
  for (let k = 1; k < m.length && g !== 1; k++) if (db(m[k] / mx) > PITCH_DB) g = gcd(k, g);
  return g;
}

/** Per-waveform metrics of a cycle. */
export function waveMetrics(x: ArrayLike<number>): WaveMetrics {
  return spectrumMetrics(harmonics(x), x);
}

/**
 * Log-spectral distance (dB): RMS difference of the two dB spectra (each re its own
 * strongest harmonic, floored at LSD_FLOOR_DB) over the harmonics that are above the floor
 * in either waveform — so a sparse spectrum's changes are not diluted by harmonics absent
 * from both. 0 when both are silent.
 */
export function lsd(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const da = relDb(a);
  const dbb = relDb(b);
  let s = 0;
  let used = 0;
  const n = Math.min(a.length, b.length) - 1;
  for (let k = 1; k <= n; k++) {
    if (da[k] <= LSD_FLOOR_DB && dbb[k] <= LSD_FLOOR_DB) continue;
    s += (da[k] - dbb[k]) ** 2;
    used++;
  }
  return used ? Math.sqrt(s / used) : 0;
}

/** Cosine distance 1 − cos∠(a, b) of two magnitude vectors (1 if either is zero). */
export function cosDist(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let k = 1; k < Math.min(a.length, b.length); k++) {
    ab += a[k] * b[k];
    aa += a[k] * a[k];
    bb += b[k] * b[k];
  }
  return aa > 0 && bb > 0 ? Math.max(0, 1 - ab / Math.sqrt(aa * bb)) : 1;
}

/** Relative RMS difference of two cycles (0 = equal; 1 = as different as a is loud). */
export function relRms(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let d = 0;
  let e = 0;
  for (let i = 0; i < a.length; i++) {
    d += (a[i] - b[i]) ** 2;
    e += a[i] ** 2;
  }
  return e > 0 ? Math.sqrt(d / e) : d > 0 ? 1 : 0;
}

/** Spearman rank correlation of y with its index (0 when y is constant). */
export function spearmanWithIndex(y: readonly number[]): number {
  const n = y.length;
  if (n < 2) return 0;
  const order = y.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
  const rank = new Array<number>(n);
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && Math.abs(order[j + 1][0] - order[i][0]) < 1e-9) j++;
    for (let t = i; t <= j; t++) rank[order[t][1]] = (i + j) / 2;
    i = j + 1;
  }
  const idx = y.map((_, i) => i);
  const mr = (n - 1) / 2;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (idx[i] - mr) * (rank[i] - mr);
    sxx += (idx[i] - mr) ** 2;
    syy += (rank[i] - mr) ** 2;
  }
  return syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

export interface BatchMetrics {
  n: number;
  /** Fraction of silent waveforms. */
  silentFrac: number;
  /** Fraction of consecutive pairs that are near-duplicates in magnitude (LSD < DUP_LSD_DB). */
  dupFrac: number;
  /** Fraction of consecutive pairs that are magnitude near-duplicates yet differ in the time domain (phase-only motion). */
  phaseOnlyFrac: number;
  /** Every waveform's magnitudes are near-identical to the first's. */
  static: boolean;
  /** Mean / max / total log-spectral distance between consecutive waveforms (dB). */
  meanStepLsd: number;
  maxStepLsd: number;
  pathLsd: number;
  /** Mean cosine distance between consecutive magnitude vectors. */
  meanStepCos: number;
  /** LSD between the first and the last waveform (dB). */
  endToEndLsd: number;
  /** Net displacement: min(endToEnd, path) (dB). */
  netLsd: number;
  /** min(1, endToEnd / path) (LSD over the union of present harmonics is not strictly a metric): 1 = moves in one direction, → 0 = back-and-forth / erratic. */
  straightness: number;
  /** Coefficient of variation of the step sizes (0 = evenly paced; > 1 = jumps). */
  stepCv: number;
  /** Centroid trajectory and its range (harmonic number). */
  centroids: number[];
  centroidRange: number;
  /** |Spearman| of centroid vs index: 1 = monotonic brightening / darkening. */
  centroidMonotonic: number;
  /** Mean of each per-waveform metric over the batch's non-silent waveforms. */
  mean: Omit<WaveMetrics, 'silent' | 'slopeDbOct'> & { slopeDbOct: number | null };
}

const PER_WAVE_KEYS = [
  'sigCount',
  'highestSig',
  'centroid',
  'spread',
  'flatness',
  'entropy',
  'oddEvenDb',
  'evenFrac',
  'crest',
  'irregularityDb',
  'formantPeaks',
  'formantProminenceDb',
  'h1Db',
  'h1Frac',
  'divisor',
] as const;

/** Batch metrics from the waveforms (each 2048 samples), in batch order. */
export function batchMetrics(waves: readonly ArrayLike<number>[]): BatchMetrics & { waves: WaveMetrics[] } {
  const mags = waves.map(harmonics);
  const wm = waves.map((x, i) => spectrumMetrics(mags[i], x));
  const n = waves.length;
  const steps: number[] = [];
  let cosSum = 0;
  let dups = 0;
  let phaseOnly = 0;
  for (let i = 1; i < n; i++) {
    const d = lsd(mags[i - 1], mags[i]);
    steps.push(d);
    cosSum += cosDist(mags[i - 1], mags[i]);
    if (d < DUP_LSD_DB) {
      dups++;
      if (relRms(waves[i - 1], waves[i]) > PHASE_ONLY_REL) phaseOnly++;
    }
  }
  const path = steps.reduce((a, b) => a + b, 0);
  const meanStep = steps.length ? path / steps.length : 0;
  const sd = steps.length ? Math.sqrt(steps.reduce((a, s) => a + (s - meanStep) ** 2, 0) / steps.length) : 0;
  const end = n > 1 ? lsd(mags[0], mags[n - 1]) : 0;
  const isStatic = mags.every((m) => lsd(mags[0], m) < DUP_LSD_DB);
  const live = wm.filter((w) => !w.silent);
  const mean = {} as BatchMetrics['mean'];
  for (const k of PER_WAVE_KEYS) mean[k] = live.length ? live.reduce((a, w) => a + w[k], 0) / live.length : 0;
  const slopes = live.map((w) => w.slopeDbOct).filter((s): s is number => s !== null);
  mean.slopeDbOct = slopes.length ? slopes.reduce((a, b) => a + b, 0) / slopes.length : null;
  const centroids = wm.map((w) => w.centroid);
  return {
    n,
    silentFrac: n ? wm.filter((w) => w.silent).length / n : 0,
    dupFrac: n > 1 ? dups / (n - 1) : 0,
    phaseOnlyFrac: n > 1 ? phaseOnly / (n - 1) : 0,
    static: isStatic,
    meanStepLsd: meanStep,
    maxStepLsd: steps.length ? Math.max(...steps) : 0,
    pathLsd: path,
    meanStepCos: steps.length ? cosSum / steps.length : 0,
    endToEndLsd: end,
    netLsd: Math.min(end, path),
    straightness: path > 1e-9 ? Math.min(1, end / path) : 0,
    stepCv: meanStep > 1e-9 ? sd / meanStep : 0,
    centroids,
    centroidRange: centroids.length ? Math.max(...centroids) - Math.min(...centroids) : 0,
    centroidMonotonic: Math.abs(spearmanWithIndex(centroids)),
    mean,
    waves: wm,
  };
}
