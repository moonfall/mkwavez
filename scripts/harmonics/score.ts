/**
 * The composite "harmonic interest" score of a batch, 0..100. It is a documented,
 * adjustable heuristic — a way to sort a few hundred batches so the outliers are easy to
 * find — not a measure of taste. Each component is a number in [0, 1] computed from the
 * metrics in metrics.ts; the score is their weighted geometric mean (each floored, so one
 * weak component pulls the score down hard but never to zero), times penalties:
 *
 *   score = 100 · exp( Σ wᵢ·ln max(cᵢ, floor) / Σ wᵢ ) · (1 − silentFrac) · (1 − dupPenalty·dupFrac)
 *
 * Components (per-waveform ones are averaged over the batch's non-silent waveforms):
 *   richness   ½·clamp(log2(sigCount) / log2(richCount)) + ½·clamp(entropy / richEntropy)
 *              — 0 for a pure sine, ≈ 0.8 for a saw, 1 for a dense spectrum with spread energy.
 *   balance    (1 − clamp((flatness − flatLo) / (flatHi − flatLo)))
 *              · (1 − irregPenalty·clamp((irregularityDb − irregLo) / (irregHi − irregLo)))
 *              — penalises white-noise-flat spectra (flatness ≥ flatHi → 0) and, more
 *              mildly, noise-like jagged fine structure (random harmonic levels).
 *   pitch      (h1Missing + (1 − h1Missing)·clamp((h1Db − h1Lo) / (h1Hi − h1Lo))) / divisor
 *              — a waveform should sound at the pitch it is played at: a weak or missing
 *              fundamental costs up to half, and harmonics sharing a common divisor g
 *              (every present one a multiple of g: the waveform sounds g× higher, e.g. an
 *              octave for g = 2) divide by g.
 *   motion     1 − exp(−travel / motionTau), travel = net + wander·(path − net)
 *              — how far the batch gets: the net displacement first → last (LSD, dB)
 *              counts fully, wandering beyond it (back and forth, random walks) only by
 *              the `wander` fraction, so a coherent sweep beats a random walk of the same
 *              path length.
 *   smoothness 1 − ½·clamp(stepCv / 2)   (0.5 when the batch barely moves)
 *              — evenly paced steps score 1, a batch of jumps 0.5. Small weight.
 *   structure  ½ + ½·min(formantPeaks, 2) / 2, times balance
 *              — a small bonus for formant-like peaks in the envelope (noise gets none).
 */
import type { BatchMetrics } from './metrics';

export interface ScoreWeights {
  richness: number;
  balance: number;
  pitch: number;
  motion: number;
  smoothness: number;
  structure: number;
  /** Floor for each component before the logarithm. */
  floor: number;
  /** Multiplier strength of the near-duplicate penalty: 1 − dupPenalty·dupFrac. */
  dupPenalty: number;
  /** sigCount at which richness' count term saturates. */
  richCount: number;
  /** Normalised power entropy at which richness' entropy term saturates. */
  richEntropy: number;
  /** Flatness where the balance penalty starts / reaches 0. */
  flatLo: number;
  flatHi: number;
  /** Strength of the irregularity penalty (0 = off) and where it starts / saturates (dB). */
  irregPenalty: number;
  irregLo: number;
  irregHi: number;
  /** Fundamental level (dB re the strongest) at which the pitch term bottoms out / is full, and its value when missing. */
  h1Lo: number;
  h1Hi: number;
  h1Missing: number;
  /** Travel (dB of LSD) giving motion 1 − 1/e. */
  motionTau: number;
  /** Fraction of the path beyond the net displacement that counts as travel. */
  wander: number;
}

export const DEFAULT_WEIGHTS: Readonly<ScoreWeights> = {
  richness: 1,
  balance: 0.75,
  pitch: 0.75,
  motion: 1,
  smoothness: 0.25,
  structure: 0.25,
  floor: 0.05,
  dupPenalty: 0.5,
  richCount: 48,
  richEntropy: 0.5,
  flatLo: 0.25,
  flatHi: 0.6,
  irregPenalty: 0.5,
  irregLo: 2,
  irregHi: 6,
  h1Lo: -40,
  h1Hi: -6,
  h1Missing: 0.5,
  motionTau: 20,
  wander: 0.25,
};

export interface ScoreParts {
  richness: number;
  balance: number;
  pitch: number;
  motion: number;
  smoothness: number;
  structure: number;
  /** The travel motion is computed from (dB). */
  travel: number;
  score: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export interface WaveScoreInput {
  sigCount: number;
  entropy: number;
  flatness: number;
  irregularityDb: number;
  formantPeaks: number;
  h1Db: number;
  divisor: number;
}

/** Per-waveform richness / balance / pitch / structure from its metrics. */
export function waveComponents(
  w: WaveScoreInput,
  W: Readonly<ScoreWeights> = DEFAULT_WEIGHTS,
): { richness: number; balance: number; pitch: number; structure: number } {
  const richness =
    0.5 * clamp01(w.sigCount > 1 ? Math.log2(w.sigCount) / Math.log2(W.richCount) : 0) + 0.5 * clamp01(w.entropy / W.richEntropy);
  const balance =
    (1 - clamp01((w.flatness - W.flatLo) / (W.flatHi - W.flatLo))) *
    (1 - W.irregPenalty * clamp01((w.irregularityDb - W.irregLo) / (W.irregHi - W.irregLo)));
  const pitch = (W.h1Missing + (1 - W.h1Missing) * clamp01((w.h1Db - W.h1Lo) / (W.h1Hi - W.h1Lo))) / Math.max(1, w.divisor);
  const structure = (0.5 + (0.5 * Math.min(w.formantPeaks, 2)) / 2) * balance;
  return { richness, balance, pitch, structure };
}

/** Motion travel: net displacement plus `wander` × the rest of the path (dB). */
export function travelOf(b: Pick<BatchMetrics, 'pathLsd' | 'netLsd'>, W: Readonly<ScoreWeights> = DEFAULT_WEIGHTS): number {
  return b.netLsd + W.wander * Math.max(0, b.pathLsd - b.netLsd);
}

/** The composite score of a batch. */
export function scoreBatch(b: BatchMetrics & { waves: readonly (WaveScoreInput & { silent: boolean })[] }, W: Readonly<ScoreWeights> = DEFAULT_WEIGHTS): ScoreParts {
  const live = b.waves.filter((w) => !w.silent);
  const comps = live.map((w) => waveComponents(w, W));
  const avg = (f: (c: (typeof comps)[number]) => number) => (comps.length ? comps.reduce((a, c) => a + f(c), 0) / comps.length : 0);
  const richness = avg((c) => c.richness);
  const balance = avg((c) => c.balance);
  const pitch = avg((c) => c.pitch);
  const structure = avg((c) => c.structure);
  const travel = travelOf(b, W);
  const motion = 1 - Math.exp(-travel / W.motionTau);
  const smoothness = b.pathLsd < 1 ? 0.5 : 1 - 0.5 * clamp01(b.stepCv / 2);
  const parts: [number, number][] = [
    [richness, W.richness],
    [balance, W.balance],
    [pitch, W.pitch],
    [motion, W.motion],
    [smoothness, W.smoothness],
    [structure, W.structure],
  ];
  const wsum = parts.reduce((a, [, w]) => a + w, 0);
  const g = wsum > 0 ? Math.exp(parts.reduce((a, [c, w]) => a + w * Math.log(Math.max(W.floor, c)), 0) / wsum) : 0;
  const score = 100 * g * (1 - b.silentFrac) * (1 - W.dupPenalty * b.dupFrac);
  return { richness, balance, pitch, motion, smoothness, structure, travel, score };
}

/** Weights from defaults overridden by `over` (unknown keys rejected). */
export function weightsFrom(over: Record<string, unknown>): ScoreWeights {
  const out: ScoreWeights = { ...DEFAULT_WEIGHTS };
  for (const [k, v] of Object.entries(over)) {
    if (!(k in out)) throw new Error(`unknown weight '${k}' (known: ${Object.keys(out).join(', ')})`);
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`weight '${k}' must be a number`);
    (out as unknown as Record<string, number>)[k] = n;
  }
  return out;
}
