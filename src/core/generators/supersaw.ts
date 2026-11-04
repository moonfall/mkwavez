/**
 * Supersaw: several copies of one band-limited wave (saw, square or triangle), detuned
 * around the centre and mixed. A single cycle can't hold different frequencies, so each
 * table is the voices at one moment — identical waves at their own phases (the comb of
 * phase differences is the supersaw's timbre) — and a batch scans time: across it the
 * outermost voices drift by `detune` cycles against the centre (the others in proportion),
 * so playing through the wavetable recreates the beating of the detuned stack.
 */
import { KMAX, TABLE_SIZE } from '../constants';
import { Prng } from '../prng';
import { shape } from '../shape';
import { sawAmp, squareAmp, triAmp } from './basic';
import { batchU } from './perlin';

export const SUPERSAW_WAVES = ['Saw', 'Square', 'Triangle'] as const;
export const SUPERSAW_PHASES = ['Random (seeded)', 'Spread evenly', 'Aligned'] as const;
export const SUPERSAW_MAX_VOICES = 15;

export interface SupersawParams {
  /** 1 … 15 voices. */
  voices: number;
  /** Cycles the outermost voices drift against the centre across the batch. */
  detune: number;
  /** Level of the outermost voices (the centre is 1; linear in between). */
  outer: number;
  /** SUPERSAW_WAVES index. */
  wave: number;
  /** SUPERSAW_PHASES index: the voices' start phases. */
  phases: number;
}

export const DEFAULT_SUPERSAW: SupersawParams = { voices: 7, detune: 2, outer: 0.6, wave: 0, phases: 0 };

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const voiceCount = (v: number) => clamp(Math.round(v), 1, SUPERSAW_MAX_VOICES);

/** Voice j's detune offset, −1 … 1 evenly spaced (0 for a single voice). */
export function supersawOffset(j: number, voices: number): number {
  const V = voiceCount(voices);
  return V === 1 ? 0 : -1 + (2 * j) / (V - 1);
}

/** Voice j's level: 1 at the centre, `outer` at the outermost voices, linear in between. */
export function supersawLevel(j: number, voices: number, outer: number): number {
  return 1 - (1 - clamp(outer, 0, 1)) * Math.abs(supersawOffset(j, voices));
}

/**
 * The voices' start phases in cycles (0 … 1). Random phases are drawn for every possible
 * voice, so voice j's phase doesn't depend on how many voices there are.
 */
export function supersawStarts(voices: number, mode: number, seed: number): number[] {
  const V = voiceCount(voices);
  const m = Math.round(mode);
  if (m === 2) return new Array(V).fill(0);
  if (m === 1) return Array.from({ length: V }, (_, j) => j / V);
  const r = new Prng(seed);
  const all = Array.from({ length: SUPERSAW_MAX_VOICES }, () => r.next());
  return all.slice(0, V);
}

/** Voice phases (cycles) after the outermost voices drifted `drift` cycles. */
export function supersawPhases(voices: number, drift: number, mode: number, seed: number): number[] {
  return supersawStarts(voices, mode, seed).map((s, j) => s + drift * supersawOffset(j, voices));
}

const AMP = [sawAmp, squareAmp, triAmp];

/** Sine table for sin(2π·i/N), shared. */
let SIN: Float64Array | null = null;

/**
 * The raw cycle (before shape()): Σ_j level_j · wave(x + 2π·φ_j), summed per harmonic
 * (a_k·Σ_j level_j·sin(k(x + 2πφ_j)) = a_k·(C_k·sin kx + S_k·cos kx)).
 */
export function supersawRaw(voices: number, drift: number, outer: number, wave: number, phases: number, seed: number): Float64Array {
  const V = voiceCount(voices);
  const amp = AMP[clamp(Math.round(wave), 0, AMP.length - 1)];
  const ph = supersawPhases(V, drift, phases, seed);
  const lv = Array.from({ length: V }, (_, j) => supersawLevel(j, V, outer));
  const N = TABLE_SIZE;
  SIN ??= Float64Array.from({ length: N }, (_, i) => Math.sin((2 * Math.PI * i) / N));
  const sin = SIN;
  const x = new Float64Array(N);
  for (let k = 1; k <= KMAX; k++) {
    const a = amp(k);
    if (!a) continue;
    let C = 0;
    let S = 0;
    for (let j = 0; j < V; j++) {
      const t = 2 * Math.PI * k * ph[j];
      C += lv[j] * Math.cos(t);
      S += lv[j] * Math.sin(t);
    }
    const c = a * C;
    const s = a * S;
    for (let i = 0, ix = 0; i < N; i++, ix = (ix + k) % N) x[i] += c * sin[ix] + s * sin[(ix + N / 4) % N];
  }
  // Voices can cancel exactly (e.g. two evenly spread squares at equal level: every odd
  // harmonic): silence would be no waveform at all, so fall back to a single voice.
  if (!x.some((v) => Math.abs(v) > 1e-9)) return V > 1 ? supersawRaw(1, 0, 1, wave, 2, seed) : x;
  return x;
}

/** Table `index` of a batch: the outermost voices have drifted detune·u cycles. */
export function supersawTable(p: SupersawParams, seed: number, index: number, count: number): Float32Array {
  return shape(supersawRaw(p.voices, p.detune * batchU(index, count), p.outer, p.wave, p.phases, seed));
}
