import { describe, expect, it } from 'vitest';
import { TABLE_SIZE } from '../src/core/constants';
import { additive, basicWave } from '../src/core/generators/basic';
import { mutate } from '../src/core/mutations';
import { Prng } from '../src/core/prng';
import {
  batchMetrics,
  cosDist,
  formantPeaks,
  harmonics,
  irregularity,
  K,
  lsd,
  spearmanWithIndex,
  spectrumMetrics,
  waveMetrics,
} from '../scripts/harmonics/metrics';
import { DEFAULT_WEIGHTS, scoreBatch, travelOf, waveComponents, weightsFrom } from '../scripts/harmonics/score';

/** Magnitudes 1..K (index = harmonic) from a function of k. */
const mags = (f: (k: number) => number) => Float64Array.from({ length: K + 1 }, (_, k) => (k ? f(k) : 0));

/** Rayleigh-distributed magnitudes (white noise's harmonic magnitudes). */
function noiseMags(seed: number): Float64Array {
  const r = new Prng(seed);
  return mags(() => Math.sqrt(-2 * Math.log(1 - r.next())));
}

describe('harmonic metrics: known spectra', () => {
  it('sine → one harmonic, no slope, crest √2', () => {
    const m = waveMetrics(basicWave('sine', 0));
    expect(m.silent).toBe(false);
    expect(m.sigCount).toBe(1);
    expect(m.highestSig).toBe(1);
    expect(m.centroid).toBeCloseTo(1, 4);
    expect(m.spread).toBeCloseTo(0, 3);
    expect(m.entropy).toBeCloseTo(0, 6);
    expect(m.flatness).toBeLessThan(1e-6);
    expect(m.slopeDbOct).toBeNull();
    expect(m.h1Frac).toBeCloseTo(1, 6);
    expect(m.h1Db).toBeCloseTo(0, 6);
    expect(m.crest).toBeCloseTo(Math.SQRT2, 3);
    expect(m.formantPeaks).toBe(0);
  });

  it('saw → every harmonic, 1/k slope ≈ −6.02 dB/octave', () => {
    const m = waveMetrics(basicWave('saw', 0));
    expect(m.sigCount).toBe(K);
    expect(m.highestSig).toBe(K);
    expect(m.slopeDbOct!).toBeCloseTo(-6.02, 1);
    // Amplitude-weighted centroid of 1/k over 1..72 = 72 / H(72).
    let h = 0;
    for (let k = 1; k <= K; k++) h += 1 / k;
    expect(m.centroid).toBeCloseTo(K / h, 2);
    expect(m.evenFrac).toBeGreaterThan(0.6);
    expect(m.evenFrac).toBeLessThan(0.66);
    expect(m.irregularityDb).toBeLessThan(0.1);
    expect(m.formantPeaks).toBe(0);
  });

  it('square → odd harmonics only, ≈ −6 dB/octave', () => {
    const m = waveMetrics(basicWave('square', 0));
    expect(m.sigCount).toBe(K / 2);
    expect(m.evenFrac).toBeLessThan(1e-6);
    expect(m.oddEvenDb).toBe(60);
    expect(m.slopeDbOct!).toBeCloseTo(-6.02, 1);
    expect(m.irregularityDb).toBeLessThan(0.1);
    expect(m.crest).toBeLessThan(1.2);
  });

  it('triangle → odd harmonics at 1/k², ≈ −12 dB/octave', () => {
    const m = waveMetrics(basicWave('tri', 0));
    expect(m.evenFrac).toBeLessThan(1e-6);
    expect(m.slopeDbOct!).toBeCloseTo(-12.04, 1);
  });

  it('white-ish noise → high flatness and entropy, jagged fine structure', () => {
    for (const seed of [1, 2, 3]) {
      const m = spectrumMetrics(noiseMags(seed));
      expect(m.flatness).toBeGreaterThan(0.4);
      expect(m.entropy).toBeGreaterThan(0.85);
      expect(m.irregularityDb).toBeGreaterThan(3);
      expect(m.sigCount).toBeGreaterThan(60);
      expect(Math.abs(m.slopeDbOct!)).toBeLessThan(2);
    }
    // The same through the time domain (random phases).
    const r = new Prng(9);
    const nm = noiseMags(4);
    const x = new Float64Array(TABLE_SIZE);
    for (let k = 1; k <= K; k++) {
      const ph = 2 * Math.PI * r.next();
      for (let i = 0; i < TABLE_SIZE; i++) x[i] += nm[k] * Math.sin((2 * Math.PI * k * i) / TABLE_SIZE + ph);
    }
    expect(waveMetrics(x).flatness).toBeGreaterThan(0.4);
    expect(waveMetrics(x).crest).toBeGreaterThan(2);
  });

  it('formant peaks: two bumps found; plain and low-passed saws have none', () => {
    const bumps = mags((k) => 0.02 / k + Math.exp(-(((k - 8) / 1.5) ** 2)) + 0.6 * Math.exp(-(((k - 24) / 2) ** 2)));
    expect(formantPeaks(bumps).count).toBe(2);
    expect(formantPeaks(bumps).prominenceDb).toBeGreaterThan(6);
    expect(formantPeaks(mags((k) => 1 / k)).count).toBe(0);
    expect(formantPeaks(mags((k) => Math.exp(-((k / 10) ** 2)) / k)).count).toBe(0);
    expect(formantPeaks(mags((k) => (k % 2 ? 1 / k : 0))).count).toBe(0);
  });

  it('pitch divisor: 1 for saw, 2 for even harmonics only, 3 for multiples of 3', () => {
    expect(waveMetrics(basicWave('saw', 0)).divisor).toBe(1);
    expect(waveMetrics(basicWave('square', 0)).divisor).toBe(1);
    const even = waveMetrics(additive((k) => (k % 2 ? 0 : 1 / k)));
    expect(even.divisor).toBe(2);
    expect(even.h1Db).toBeLessThan(-100);
    expect(waveMetrics(additive((k) => (k % 3 ? 0 : 1 / k))).divisor).toBe(3);
    // A faint fundamental (below −40 dB) doesn't restore the pitch.
    expect(waveMetrics(additive((k) => (k === 1 ? 0.002 : k % 2 ? 0 : 1 / k))).divisor).toBe(2);
  });

  it('silent cycle → silent, zeros', () => {
    const m = waveMetrics(new Float32Array(TABLE_SIZE));
    expect(m.silent).toBe(true);
    expect(m.sigCount).toBe(0);
  });

  it('irregularity is 0 for a smooth trend and ≈ σ for white residuals', () => {
    const t = Array.from({ length: 40 }, (_, i) => Math.log2(i + 1));
    expect(irregularity(t, t.map((x) => -6 * x + 0.5 * x * x))).toBeLessThan(1e-9);
    const r = new Prng(5);
    const g = () => Math.sqrt(-2 * Math.log(1 - r.next())) * Math.cos(2 * Math.PI * r.next());
    const big = Array.from({ length: 2000 }, (_, i) => Math.log2(i + 1));
    expect(irregularity(big, big.map(() => 5 * g()))).toBeCloseTo(5, 0);
  });
});

describe('harmonic metrics: distances and batches', () => {
  it('distances are 0 for equal spectra and positive otherwise', () => {
    const a = harmonics(basicWave('saw', 0));
    const b = harmonics(basicWave('square', 0));
    expect(lsd(a, a)).toBe(0);
    expect(cosDist(a, a)).toBeCloseTo(0, 12);
    expect(lsd(a, b)).toBeGreaterThan(5);
    expect(cosDist(a, b)).toBeGreaterThan(0.05);
  });

  it('a harmonic appearing below the −40 dB floor is not motion', () => {
    const a = harmonics(basicWave('sine', 0));
    const b = harmonics(additive((k) => (k === 1 ? 1 : k === 2 ? 0.005 : 0)));
    expect(lsd(a, b)).toBe(0);
    const c = harmonics(additive((k) => (k === 1 ? 1 : k === 2 ? 0.1 : 0)));
    expect(lsd(a, c)).toBeCloseTo(Math.sqrt((40 - 20) ** 2 / 2), 3);
  });

  it('spearman with index', () => {
    expect(spearmanWithIndex([1, 2, 3, 4])).toBeCloseTo(1, 12);
    expect(spearmanWithIndex([4, 3, 2, 1])).toBeCloseTo(-1, 12);
    expect(spearmanWithIndex([2, 2, 2])).toBe(0);
  });

  it('a static batch: all duplicates, no motion', () => {
    const saw = basicWave('saw', 0);
    const b = batchMetrics([saw, saw, saw, saw]);
    expect(b.static).toBe(true);
    expect(b.dupFrac).toBe(1);
    expect(b.phaseOnlyFrac).toBe(0);
    expect(b.pathLsd).toBe(0);
    expect(b.centroidRange).toBeCloseTo(0, 9);
  });

  it('a saw → sine sweep: monotonic, straight, no duplicates', () => {
    const saw = basicWave('saw', 0);
    const waves = Array.from({ length: 8 }, (_, i) => mutate('toSine', saw, (i + 1) / 10, 1));
    const b = batchMetrics(waves);
    expect(b.static).toBe(false);
    expect(b.dupFrac).toBe(0);
    expect(b.centroidMonotonic).toBeCloseTo(1, 9);
    expect(b.straightness).toBeGreaterThan(0.5);
    expect(b.centroids[0]).toBeGreaterThan(b.centroids[7]);
  });

  it('phase-only motion is counted separately', () => {
    const saw = basicWave('saw', 0);
    const waves = [0, 0.3, 0.6, 1].map((a) => mutate('zeroPhase', saw, a, 1));
    const b = batchMetrics(waves);
    expect(b.dupFrac).toBe(1);
    expect(b.phaseOnlyFrac).toBeGreaterThan(0.5);
  });

  it('silent waveforms are counted', () => {
    const b = batchMetrics([basicWave('saw', 0), new Float32Array(TABLE_SIZE)]);
    expect(b.silentFrac).toBe(0.5);
  });
});

describe('harmonic interest score', () => {
  const swept = () => {
    const saw = basicWave('saw', 0);
    return batchMetrics(Array.from({ length: 8 }, (_, i) => mutate('formant', saw, (i + 1) / 8, 7)));
  };

  it('orders static sine < static saw < a moving rich batch', () => {
    const sine = scoreBatch(batchMetrics(Array(8).fill(basicWave('sine', 0)))).score;
    const saw = scoreBatch(batchMetrics(Array(8).fill(basicWave('saw', 0)))).score;
    const moving = scoreBatch(swept()).score;
    expect(sine).toBeLessThan(saw);
    expect(saw).toBeLessThan(moving);
    expect(moving).toBeLessThanOrEqual(100);
    expect(sine).toBeGreaterThan(0);
  });

  it('richness 0 for a sine; balance low for a flat (white) spectrum', () => {
    expect(waveComponents(waveMetrics(basicWave('sine', 0))).richness).toBeCloseTo(0, 9);
    const flat = spectrumMetrics(mags(() => 1));
    expect(flat.flatness).toBeCloseTo(1, 6);
    expect(waveComponents(flat).balance).toBe(0);
    expect(waveComponents(spectrumMetrics(noiseMags(1))).balance).toBeLessThan(0.5);
    expect(waveComponents(waveMetrics(additive((k) => 1 / k))).balance).toBe(1);
  });

  it('pitch: a missing fundamental and a common divisor are penalised', () => {
    const saw = waveComponents(waveMetrics(basicWave('saw', 0))).pitch;
    const noH1 = waveComponents(waveMetrics(additive((k) => (k === 1 ? 0 : 1 / k)))).pitch;
    const octave = waveComponents(waveMetrics(additive((k) => (k % 2 ? 0 : 1 / k)))).pitch;
    expect(saw).toBe(1);
    expect(noH1).toBeCloseTo(DEFAULT_WEIGHTS.h1Missing, 6);
    expect(octave).toBeCloseTo(DEFAULT_WEIGHTS.h1Missing / 2, 6);
  });

  it('motion credits a coherent sweep over a random walk of the same path length', () => {
    const W = DEFAULT_WEIGHTS;
    expect(travelOf({ pathLsd: 40, netLsd: 40 }, W)).toBe(40);
    expect(travelOf({ pathLsd: 40, netLsd: 5 }, W)).toBeCloseTo(5 + W.wander * 35, 9);
    // Real batches: a toward-saw sweep vs a seeded jitter walk.
    const sine = basicWave('sine', 0);
    const sweep = batchMetrics(Array.from({ length: 8 }, (_, i) => mutate('toSaw', sine, (i + 1) / 8, 1)));
    expect(sweep.straightness).toBeGreaterThan(0.6);
    expect(scoreBatch(sweep).travel).toBeGreaterThan(0.6 * sweep.pathLsd);
  });

  it('silence and duplicates are penalised', () => {
    const saw = basicWave('saw', 0);
    const a = scoreBatch(swept()).score;
    const withSilence = batchMetrics([...Array.from({ length: 7 }, (_, i) => mutate('formant', saw, (i + 1) / 8, 7)), new Float32Array(TABLE_SIZE)]);
    expect(scoreBatch(withSilence).score).toBeLessThan(a);
  });

  it('weights are adjustable and validated', () => {
    expect(weightsFrom({ motion: '2' }).motion).toBe(2);
    expect(weightsFrom({}).richness).toBe(DEFAULT_WEIGHTS.richness);
    expect(() => weightsFrom({ nope: 1 })).toThrow();
    const b = swept();
    expect(scoreBatch(b, weightsFrom({ motion: 0, smoothness: 0, structure: 0, balance: 0, pitch: 0 })).score).toBeCloseTo(
      100 * Math.max(DEFAULT_WEIGHTS.floor, scoreBatch(b).richness) * (1 - DEFAULT_WEIGHTS.dupPenalty * b.dupFrac),
      6,
    );
  });
});
