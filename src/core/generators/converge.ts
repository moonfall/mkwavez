/**
 * Converge: an ensemble of voices that starts as a cluster — each voice at a seeded pitch in
 * a band, wandering — and glides, each on its own schedule, onto the tones of a chord spread
 * over several octaves. Like Supersaw, each table is the ensemble at one moment and a batch
 * scans time, so playing through the wavetable (e.g. a slow one-shot LFO on the position)
 * plays the whole arc: cluster → swell → chord.
 *
 * Pitches are in harmonics of the played note (a single cycle holds only whole harmonics):
 * a voice between two harmonics puts its energy on both (equal-power split), so a glide is
 * energy moving up or down the harmonic series. Every voice is a saw-like stack of overtones
 * (k^−bright). The chords are harmonic: Root + fifth = harmonics 1, 2, 3, 4, 6, 8, 12, …;
 * Major adds 5, 10, 20, …; so played low (around D1–D2) the final chord spans the octaves.
 */
import { KMAX, TABLE_SIZE } from '../constants';
import { Prng } from '../prng';
import { shape } from '../shape';
import { batchU } from './perlin';

export const CONVERGE_CHORDS = ['Root + fifth', 'Major', 'Minor', 'Sus4', 'Octaves'] as const;
export const CONVERGE_MAX_VOICES = 48;

/** Chord tones as harmonics of the played note (the chord's lowest tone first), before the span limit. */
const CHORD_TONES: readonly (readonly number[])[] = [
  [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64],
  [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64],
  // Minor and sus4 need a higher root to be harmonic (10: 10 : 12 : 15; 6: 6 : 8 : 9).
  [5, 10, 12, 15, 20, 24, 30, 40, 48, 60],
  [3, 6, 8, 9, 12, 16, 18, 24, 32, 36, 48, 64, 72],
  [1, 2, 4, 8, 16, 32, 64],
];

export interface ConvergeParams {
  /** 1 … 48 voices. */
  voices: number;
  /** The start band, in harmonics of the played note (lowest, highest). */
  low: number;
  high: number;
  /** CONVERGE_CHORDS index. */
  chord: number;
  /** Octaves the chord spans above its lowest tone. */
  span: number;
  /** Batch fraction the cluster holds before voices start to glide. */
  hold: number;
  /** Batch fraction by which every voice has arrived. */
  arrive: number;
  /** 0 = every voice glides together; 1 = departures and arrivals spread over the whole glide. */
  spread: number;
  /** Pitch wander of the cluster, ± semitones (fading out as a voice arrives). */
  wobble: number;
  /** Overtone rolloff of each voice, k^−bright (1 = saw-like). */
  bright: number;
}

export const DEFAULT_CONVERGE: ConvergeParams = {
  voices: 24,
  low: 5,
  high: 11,
  chord: 0,
  span: 5,
  hold: 0.25,
  arrive: 1,
  spread: 0.6,
  wobble: 0.6,
  bright: 1,
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const voiceCount = (v: number) => clamp(Math.round(v), 1, CONVERGE_MAX_VOICES);
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** The chord's tones within its span (and the harmonic limit), lowest first. */
export function convergeTones(chord: number, span: number): number[] {
  const all = CHORD_TONES[clamp(Math.round(chord), 0, CHORD_TONES.length - 1)];
  const top = all[0] * Math.pow(2, clamp(span, 0, 7));
  return all.filter((h) => h <= top + 1e-9 && h <= KMAX);
}

interface Voice {
  /** Start and target harmonic. */
  from: number;
  to: number;
  /** Batch fractions where the glide starts and ends. */
  depart: number;
  land: number;
  /** Phase (cycles), wander rate (cycles over the batch) and wander phase. */
  phase: number;
  rate: number;
  wander: number;
}

/**
 * The voices: start pitches log-uniform in the band (seeded per voice, so voice j doesn't
 * depend on the count), targets dealt out in pitch order (the lowest voices take the lowest
 * tones; with more voices than tones they double), glide windows jittered by the spread.
 */
export function convergeVoices(p: ConvergeParams, seed: number): Voice[] {
  const V = voiceCount(p.voices);
  const r = new Prng(seed);
  const lo = clamp(Math.min(p.low, p.high), 1, KMAX);
  const hi = clamp(Math.max(p.low, p.high), 1, KMAX);
  const draws = Array.from({ length: CONVERGE_MAX_VOICES }, () => [r.next(), r.next(), r.next(), r.next(), r.next(), r.next()]);
  const hold = clamp(p.hold, 0, 0.95);
  const arrive = clamp(Math.max(p.arrive, hold + 0.05), 0.05, 1);
  const window = arrive - hold;
  const spread = clamp(p.spread, 0, 1);
  const voices: Voice[] = draws.slice(0, V).map((d) => ({
    from: lo * Math.pow(hi / lo, d[0]),
    to: 0,
    // Departure in the first half of the window, landing in the second (never overlapping).
    depart: hold + spread * d[1] * window * 0.5,
    land: arrive - spread * d[2] * window * 0.5,
    phase: d[3],
    rate: 1 + 2 * d[4],
    wander: d[5],
  }));
  const tones = convergeTones(p.chord, p.span);
  const order = voices.map((_, j) => j).sort((a, b) => voices[a].from - voices[b].from || a - b);
  order.forEach((j, rank) => (voices[j].to = tones[Math.min(tones.length - 1, Math.floor((rank * tones.length) / V))]));
  return voices;
}

/** Voice v's pitch (harmonics of the played note) at batch position u. */
export function convergePitch(v: Voice, u: number, wobble: number): number {
  const e = smooth((u - v.depart) / Math.max(1e-6, v.land - v.depart));
  // Exactly on its start / target outside the glide (a landed voice is a whole harmonic).
  const h = e <= 0 ? v.from : e >= 1 ? v.to : Math.exp(Math.log(v.from) + (Math.log(v.to) - Math.log(v.from)) * e);
  const w = clamp(wobble, 0, 12) * (1 - e) * Math.sin(2 * Math.PI * (v.rate * u + v.wander));
  return h * Math.pow(2, w / 12);
}

/** Sine table for sin(2π·i/N), shared. */
let SIN: Float64Array | null = null;

/**
 * The raw cycle (before shape()) at batch position u: every voice's overtones m·h (m^−bright)
 * placed on the two nearest harmonics (equal power), at the voice's phase.
 */
export function convergeRaw(p: ConvergeParams, u: number, seed: number): Float64Array {
  const voices = convergeVoices(p, seed);
  const bright = clamp(p.bright, 0, 4);
  const C = new Float64Array(KMAX + 2);
  const S = new Float64Array(KMAX + 2);
  for (const v of voices) {
    const h = convergePitch(v, u, p.wobble);
    for (let m = 1; m * h < KMAX + 1; m++) {
      const k = m * h;
      const k0 = Math.floor(k);
      const f = k - k0;
      const a = Math.pow(m, -bright);
      const th = 2 * Math.PI * m * v.phase;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const lo = a * Math.cos((f * Math.PI) / 2);
      const hi = a * Math.sin((f * Math.PI) / 2);
      if (k0 >= 1) {
        C[k0] += lo * c;
        S[k0] += lo * s;
      }
      C[k0 + 1] += hi * c;
      S[k0 + 1] += hi * s;
    }
  }
  const N = TABLE_SIZE;
  SIN ??= Float64Array.from({ length: N }, (_, i) => Math.sin((2 * Math.PI * i) / N));
  const sin = SIN;
  const x = new Float64Array(N);
  for (let k = 1; k <= KMAX; k++) {
    const c = C[k];
    const s = S[k];
    if (!c && !s) continue;
    for (let i = 0, ix = 0; i < N; i++, ix = (ix + k) % N) x[i] += c * sin[ix] + s * sin[(ix + N / 4) % N];
  }
  return x;
}

/** Table `index` of a batch: the ensemble at u = index / (count − 1). */
export function convergeTable(p: ConvergeParams, seed: number, index: number, count: number): Float32Array {
  return shape(convergeRaw(p, batchU(index, count), seed));
}
