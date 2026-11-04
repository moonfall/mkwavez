import { describe, expect, it } from 'vitest';
import { TABLE_SIZE } from '../src/core/constants';
import { harmonicMagnitudes } from '../src/core/fft';
import { Prng } from '../src/core/prng';
import {
  cutCycle,
  cycleAt,
  cycleCandidates,
  detectPitch,
  framePositions,
  measurePartials,
  noteName,
  resynth,
  sampleRecipe,
  seriesFrames,
  snapshotAt,
  snapshotSeries,
  type Take,
} from '../src/core/sample';
import { shape } from '../src/core/shape';
import { describeRecipe } from '../src/core/table';

const SR = 48000;
const TAU = 2 * Math.PI;
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
/** A take from a function of time (seconds). */
const takeOf = (seconds: number, f: (t: number, i: number) => number, name = 'test'): Take => ({
  name,
  sampleRate: SR,
  data: Float32Array.from({ length: Math.round(seconds * SR) }, (_, i) => f(i / SR, i)),
});
/** Harmonics k = 1..amps.length at f0 with phases. */
const tone = (f0: number, amps: number[], phases: number[] = []) => (t: number) => amps.reduce((s, a, k) => s + a * Math.sin(TAU * (k + 1) * f0 * t + (phases[k] ?? 0)), 0);
/** The same harmonics as one ideal cycle, shaped. */
const idealCycle = (amps: number[], phases: number[] = []) =>
  shape(Float64Array.from({ length: TABLE_SIZE }, (_, i) => amps.reduce((s, a, k) => s + a * Math.sin((TAU * (k + 1) * i) / TABLE_SIZE + (phases[k] ?? 0)), 0)));
const AMPS = [1, 0.5, 0.33, 0.25, 0.2, 0.17, 0.14, 0.12];

describe('pitch detection', () => {
  it('finds the fundamental of harmonic tones across the range, within 0.1 %', () => {
    for (const f0 of [55, 110, 220.4, 440, 987.77, 1600]) {
      const p = detectPitch(takeOf(0.5, tone(f0, AMPS)).data, SR, 0.25 * SR)!;
      expect(p, `${f0} Hz`).not.toBeNull();
      expect(Math.abs(p.freq / f0 - 1), `${f0} Hz → ${p.freq}`).toBeLessThan(1e-3);
      expect(p.confidence).toBeGreaterThan(0.9);
    }
  });

  it('a missing fundamental still gives the period; silence gives nothing', () => {
    const p = detectPitch(takeOf(0.3, tone(200, [0, 1, 0.8, 0.6])).data, SR, 0.15 * SR)!;
    expect(Math.abs(p.freq / 200 - 1)).toBeLessThan(2e-3);
    expect(detectPitch(new Float32Array(SR), SR, SR / 2)).toBeNull();
    const r = new Prng(1);
    const noise = detectPitch(Float32Array.from({ length: SR }, () => r.bipolar()), SR, SR / 2);
    expect(noise === null || noise.confidence < 0.6).toBe(true);
  });

  it('names notes', () => {
    expect(noteName(440)).toEqual({ name: 'A4', cents: 0 });
    expect(noteName(220.4).name).toBe('A3');
    expect(noteName(261.63).name).toBe('C4');
  });
});

describe('single cycle', () => {
  it('cuts the ideal cycle of a steady tone (detected pitch, aligned)', () => {
    const take = takeOf(0.5, tone(220.4, AMPS, [0, 1, 2, 0.5, 1.5, 2.5, 3, 0.2]));
    const c = cycleAt(take, { at: 0.2, freq: null, cents: 0, cycles: 4, align: 0, seam: 0 })!;
    expect(Math.abs(c.freq / 220.4 - 1)).toBeLessThan(1e-3);
    expect(maxDiff(c.data, idealCycle(AMPS, [0, 1, 2, 0.5, 1.5, 2.5, 3, 0.2]))).toBeLessThan(0.02);
  });

  it('averaging cycles cuts noise; the seam hides a period error; fine tune shifts the period', () => {
    const r = new Prng(7);
    const noisy = takeOf(0.5, (t) => tone(220, AMPS)(t) + 0.3 * r.bipolar());
    const ideal = idealCycle(AMPS);
    const at = (cycles: number) => maxDiff(cycleAt(noisy, { at: 0.2, freq: 220, cents: 0, cycles, align: 0, seam: 0 })!.data, ideal);
    expect(at(16)).toBeLessThan(at(1) * 0.6);
    // A period 2 % long: without the seam the cycle steps where it loops, with it it doesn't.
    const clean = takeOf(0.5, tone(220, AMPS));
    const step = (seam: boolean) => {
      const raw = cutCycle(clean.data, 0.2 * SR, (SR / 220) * 1.02, 1, seam);
      return Math.abs(raw[TABLE_SIZE - 1] - raw[0]);
    };
    expect(step(true)).toBeLessThan(step(false) * 0.2);
    const c = cycleAt(clean, { at: 0.2, freq: 220, cents: 100, cycles: 1, align: 0, seam: 0 })!;
    expect(c.freq).toBeCloseTo(220 * Math.pow(2, 1 / 12), 9);
  });

  it('candidates are consecutive cycle groups; outside the take there is none', () => {
    const take = takeOf(0.5, tone(220, AMPS));
    const cs = cycleCandidates(take, { at: 0.1, freq: null, cents: 0, cycles: 4, align: 0, seam: 0 }, 5);
    expect(cs.length).toBe(5);
    for (let i = 1; i < cs.length; i++) expect(cs[i].start - cs[i - 1].start).toBeCloseTo(4 / 220, 3);
    expect(cycleAt(take, { at: 2, freq: null, cents: 0, cycles: 1, align: 0, seam: 0 })).toBeNull();
  });
});

describe('series', () => {
  it('even frames span the selection; frames follow a brightening sound and a gliding pitch', () => {
    // Brightness grows over 2 s while the pitch glides 200 → 240 Hz (phase-continuous).
    let ph = 0;
    const take = takeOf(2, (t) => {
      const f = 200 + 20 * t;
      ph += (TAU * f) / SR;
      const b = t / 2;
      let s = 0;
      for (let k = 1; k <= 12; k++) s += Math.pow(k, -(2.5 - 2 * b)) * Math.sin(k * ph);
      return s;
    });
    expect(framePositions(take, 0.1, 1.9, 5, 0)).toEqual([0.1, 0.55, 1, 1.45, 1.9].map((v) => expect.closeTo(v, 6)));
    const frames = seriesFrames(take, { a: 0.1, b: 1.9, frames: 6, spacing: 0, cyclesPerFrame: 2, track: true, freq: null, align: 0, seam: 0, smooth: 0 });
    expect(frames.length).toBe(6);
    expect(Math.abs(frames[0].freq / (200 + 20 * 0.1) - 1)).toBeLessThan(5e-3);
    expect(Math.abs(frames[5].freq / (200 + 20 * 1.9) - 1)).toBeLessThan(5e-3);
    const centroid = (d: Float32Array) => {
      const m = harmonicMagnitudes(d, 24);
      let a = 0;
      let w = 0;
      for (let k = 1; k <= 24; k++) {
        a += k * m[k];
        w += m[k];
      }
      return a / w;
    };
    const cs = frames.map((f) => centroid(f.data));
    for (let i = 1; i < cs.length; i++) expect(cs[i]).toBeGreaterThan(cs[i - 1]);
    // Smoothing pulls neighbours together.
    const smooth = seriesFrames(take, { a: 0.1, b: 1.9, frames: 6, spacing: 0, cyclesPerFrame: 2, track: true, freq: null, align: 0, seam: 0, smooth: 1 });
    expect(maxDiff(smooth[2].data, smooth[3].data)).toBeLessThan(maxDiff(frames[2].data, frames[3].data));
  });

  it('onsets: frames land just after note starts; timbre change: frames gather where the sound changes', () => {
    const starts = [0.3, 0.9, 1.6];
    const take = takeOf(2.2, (t) => {
      let s = 0;
      for (const t0 of starts) if (t >= t0) s += Math.exp(-(t - t0) * 6) * tone(330, AMPS)(t);
      return s;
    });
    const at = framePositions(take, 0, 2.2, 3, 1);
    at.forEach((t, i) => expect(Math.abs(t - starts[i])).toBeLessThan(0.06));
    // Static for 1 s, then morphing for 1 s: most frames in the second half.
    const morph = takeOf(2, (t) => tone(220, t < 1 ? AMPS : AMPS.map((a, k) => a * (1 + 3 * (t - 1) * Math.sin(k))))(t));
    const tb = framePositions(morph, 0, 2, 9, 2);
    expect(tb.filter((t) => t > 1).length).toBeGreaterThanOrEqual(6);
  });
});

describe('harmonic snapshot', () => {
  it('measures the partials of a tone (amplitudes, relative phases) and rebuilds its cycle', () => {
    const phases = [0, 1, 2, 0.5, 1.5, 2.5, 3, 0.2];
    const take = takeOf(0.5, tone(220, AMPS, phases));
    const o = { windowCycles: 6, harmonics: 16, phases: 0, off: 1, floorDb: -60 };
    const p = measurePartials(take.data, SR, 0.25 * SR, 220, o);
    for (let k = 1; k <= 8; k++) expect(p.amp[k] / p.amp[1]).toBeCloseTo(AMPS[k - 1], 2);
    for (let k = 9; k <= 16; k++) expect(p.amp[k]).toBe(0); // under the floor
    const s = snapshotAt(take, { ...o, at: 0.25, freq: null })!;
    expect(maxDiff(s.data, idealCycle(AMPS, phases))).toBeLessThan(0.02);
    // Zero / Schroeder phases: same spectrum, different waveform.
    const z = shape(resynth(p, 1));
    const sch = shape(resynth(p, 2));
    // (peak normalisation scales them differently: compare relative to the fundamental)
    const rel = (d: Float32Array) => {
      const m = harmonicMagnitudes(d, 8);
      return Array.from(m, (v) => v / m[1]);
    };
    expect(maxDiff(rel(z), rel(sch))).toBeLessThan(1e-6);
    expect(maxDiff(z, sch)).toBeGreaterThan(0.1);
  });

  it('fold catches partials a little off the harmonics that drop misses; snapshots over a selection', () => {
    // Partial 5 sits 0.3·f0 off its harmonic.
    const take = takeOf(0.5, (t) => Math.sin(TAU * 200 * t) + 0.5 * Math.sin(TAU * 200 * 5.3 * t));
    const base = { windowCycles: 8, harmonics: 8, phases: 0, floorDb: -80 };
    const fold = measurePartials(take.data, SR, 0.25 * SR, 200, { ...base, off: 0 });
    const drop = measurePartials(take.data, SR, 0.25 * SR, 200, { ...base, off: 1 });
    expect(fold.amp[5] / fold.amp[1]).toBeGreaterThan(5 * (drop.amp[5] / drop.amp[1]));
    const series = snapshotSeries(take, { ...base, off: 0, a: 0.1, b: 0.4, frames: 4, spacing: 0, track: true, freq: null });
    expect(series.map((f) => f.at)).toEqual([0.1, 0.2, 0.3, 0.4].map((v) => expect.closeTo(v, 6)));
  });

  it('sampled waveforms carry a describing recipe', () => {
    const r = sampleRecipe('Take 3', 1, 1.23456, 220.444, 2, 8, { spacing: 'Even' });
    expect(r).toMatchObject({ op: 'sample', params: { take: 'Take 3', mode: 'Series', at: 1.235, freq: 220.44 }, batch: { index: 2, count: 8 } });
    expect(describeRecipe(r)).toBe('Series 3/8 of “Take 3” at 1.235 s · 220.44 Hz');
  });
});
