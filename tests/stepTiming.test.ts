import { describe, expect, it } from 'vitest';
import { SynthEngine } from '../src/core/engine/engine';
import { generateBasic } from '../src/core/generators';
import { buildMipSet } from '../src/core/mipmap';
import {
  DEFAULT_STEP_LENGTH,
  emptySteps,
  lengthBarsBeats,
  noteFreq,
  sequenceSummary,
  STEP_LENGTHS,
  STEP_TICKS,
  stepAtTick,
  stepBarBeat,
  stepSamples,
  stepSeconds,
  stepsPerBar,
  stepsPerBeat,
  TICKS_PER_BAR,
  type SequenceData,
  type StepLength,
} from '../src/core/sequence';
import { DEFAULT_VOICE, type VoiceParams } from '../src/core/voice';
import { packIds } from '../src/core/wavetablePlayback';
import { LegacySynthEngine } from './fixtures/legacyEngine';

describe('step length', () => {
  it('step duration = (60 / BPM) × (4 × step fraction); BPM counts quarter notes', () => {
    const want: Record<StepLength, number> = { '1/4': 0.5, '1/8': 0.25, '1/16': 0.125, '1/8T': 1 / 6, '1/16T': 1 / 12 };
    for (const l of STEP_LENGTHS) {
      expect(stepSeconds(120, l)).toBeCloseTo(want[l], 12);
      expect(stepSeconds(90, l)).toBeCloseTo((want[l] * 120) / 90, 12);
      expect(stepSamples(120, 48000, l)).toBeCloseTo(want[l] * 48000, 6);
      // Ticks: every step length divides a beat's 12 ticks proportionally.
      expect(STEP_TICKS[l] / 12).toBeCloseTo(want[l] * 2, 12);
    }
    expect([stepsPerBeat('1/4'), stepsPerBeat('1/8'), stepsPerBeat('1/16'), stepsPerBeat('1/8T'), stepsPerBeat('1/16T')]).toEqual([1, 2, 4, 3, 6]);
    expect(STEP_LENGTHS.map(stepsPerBar)).toEqual([4, 8, 16, 12, 24]);
    for (const l of STEP_LENGTHS) expect(TICKS_PER_BAR % STEP_TICKS[l]).toBe(0);
  });

  it('the default is 1/8, bit-identical to the old eighth-note step', () => {
    expect(DEFAULT_STEP_LENGTH).toBe('1/8');
    for (const sr of [22050, 44100, 48000, 96000]) {
      for (let bpm = 20; bpm <= 400; bpm += 0.5) {
        expect(stepSamples(bpm, sr)).toBe((sr * 60) / bpm / 2);
        expect(stepSamples(bpm, sr, '1/8')).toBe((sr * 60) / bpm / 2);
      }
    }
  });

  it('lengths in bars / beats and the bar.beat readout', () => {
    expect(sequenceSummary(16, '1/8')).toBe('16 steps · 1/8 · 2 bars');
    expect(sequenceSummary(1, '1/4')).toBe('1 step · 1/4 · 1 beat');
    expect(lengthBarsBeats(16, '1/16')).toBe('1 bar');
    expect(lengthBarsBeats(12, '1/8')).toBe('1 bar 2 beats');
    expect(lengthBarsBeats(12, '1/8T')).toBe('1 bar');
    expect(lengthBarsBeats(5, '1/8')).toBe('2½ beats');
    expect(lengthBarsBeats(1, '1/16')).toBe('¼ beat');
    expect(lengthBarsBeats(7, '1/16T')).toBe('1⅙ beats');
    expect(lengthBarsBeats(64, '1/16T')).toBe('2 bars 2⅔ beats');
    expect(lengthBarsBeats(64, '1/4')).toBe('16 bars');
    expect([0, 1, 2, 3, 7, 8, 15].map((k) => stepBarBeat(k, '1/8'))).toEqual(['1.1', '1.1', '1.2', '1.2', '1.4', '2.1', '2.4']);
    expect([0, 3, 4, 16].map((k) => stepBarBeat(k, '1/16'))).toEqual(['1.1', '1.1', '1.2', '2.1']);
    expect([0, 2, 3, 12].map((k) => stepBarBeat(k, '1/8T'))).toEqual(['1.1', '1.1', '1.2', '2.1']);
    expect(stepAtTick(-1, '1/8', 16)).toBe(-1);
    expect([0, 5, 6, 95, 96].map((t) => stepAtTick(t, '1/8', 16))).toEqual([0, 0, 1, 15, 0]);
    expect([0, 47, 48].map((t) => stepAtTick(t, '1/16T', 7))).toEqual([0, 2, 3]);
  });
});

// ---- engine: onsets on the shared clock ----

/** Rows 0..7 cycling, so an onset's frequency gives the step index (mod 8). */
const allSteps = (length: number) => emptySteps().map((_, i) => (i < length ? i % 8 : -1));
const rowOfFreq = (f: number) => [0, 1, 2, 3, 4, 5, 6, 7].find((r) => Math.abs(noteFreq(r, 0) - f) < 1e-6)!;

/** An engine that records every sequencer note (voice, sample index, row, gate) without rendering tables. */
class Recorder extends SynthEngine {
  t = 0;
  readonly onsets = new Map<number, { t: number; row: number; gate: number }[]>();
  override noteOn(voiceId: number, freq: number, gateSamples: number): void {
    super.noteOn(voiceId, freq, gateSamples);
    let l = this.onsets.get(voiceId);
    if (!l) this.onsets.set(voiceId, (l = []));
    l.push({ t: this.t, row: rowOfFreq(freq), gate: gateSamples });
  }
  /** One sample per process() call, so `t` is the exact sample index of each onset. */
  run(samples: number): void {
    const out = new Float32Array(1);
    for (let i = 0; i < samples; i++, this.t++) this.process(out, 1);
  }
}

function recorder(sr: number, seqs: { len: StepLength; length: number }[]): Recorder {
  const e = new Recorder(sr);
  seqs.forEach((s, i) => {
    e.setVoice({ ...DEFAULT_VOICE, id: i + 1, name: `V${i + 1}` });
    e.setSequence({ id: i + 1, voiceId: i + 1, length: s.length, steps: allSteps(s.length), gate: 0.5, stepLength: s.len });
  });
  return e;
}

describe('shared clock', () => {
  it('sequences of different step lengths and lengths stay bar-aligned over many bars', () => {
    const SR = 44100;
    const BPM = 133; // non-integer samples per step: exercises the fractional accumulator
    const seqs: { len: StepLength; length: number }[] = [
      { len: '1/8', length: 16 },
      { len: '1/4', length: 4 },
      { len: '1/16', length: 16 },
      { len: '1/8T', length: 12 },
      { len: '1/16T', length: 7 }, // polymetric: loops every 7 steps, still on the grid
      { len: '1/16', length: 13 },
    ];
    const BARS = 40;
    const e = recorder(SR, seqs);
    e.setTransport(true, BPM);
    const barLen = stepSamples(BPM, SR, '1/4') * 4;
    e.run(Math.floor(barLen * BARS) - 1); // just before bar BARS + 1 starts
    const on = seqs.map((_, i) => e.onsets.get(i + 1)!);
    const at = on.map((l) => new Set(l.map((x) => x.t)));

    seqs.forEach((s, i) => {
      const l = on[i];
      // One onset per step, none lost or doubled.
      expect(l.length, s.len).toBe(BARS * stepsPerBar(s.len));
      const step = stepSamples(BPM, SR, s.len);
      l.forEach((x, n) => {
        // No drift: step n starts within a sample of n step lengths after the start.
        expect(Math.abs(x.t - n * step)).toBeLessThanOrEqual(1);
        // Step index on the shared clock (rows cycle 0..7 within the pattern).
        expect(x.row).toBe((n % s.length) % 8);
        expect(x.gate).toBe(step * 0.5);
      });
      for (let n = 1; n < l.length; n++) expect(l[n].t).toBeGreaterThan(l[n - 1].t);
    });
    // Bar lines: every sequence fires on exactly the same sample.
    for (let b = 0; b < BARS; b++) {
      const t = on[0][b * 8].t;
      expect(Math.abs(t - b * barLen)).toBeLessThanOrEqual(1);
      seqs.forEach((s, i) => expect(on[i][b * stepsPerBar(s.len)].t, `bar ${b} ${s.len}`).toBe(t));
    }
    // Shared boundaries are the same samples: quarters in every grid, eighths in 1/16,
    // triplet eighths in triplet sixteenths.
    for (const x of on[1]) for (const i of [0, 2, 3, 4, 5]) expect(at[i].has(x.t)).toBe(true);
    for (const x of on[0]) expect(at[2].has(x.t) && at[5].has(x.t)).toBe(true);
    for (const x of on[3]) expect(at[4].has(x.t)).toBe(true);
  });

  it('a step-length change while playing lands on the next boundary of the new grid', () => {
    const SR = 48000;
    const BPM = 132;
    // Reference grids from an engine that plays 1/16 and 1/4 throughout.
    const ref = recorder(SR, [
      { len: '1/16', length: 16 },
      { len: '1/4', length: 16 },
    ]);
    ref.setTransport(true, BPM);
    const total = Math.round(stepSamples(BPM, SR, '1/4') * 4 * 6);
    ref.run(total);
    const g16 = ref.onsets.get(1)!;
    const g4 = ref.onsets.get(2)!;

    const e = recorder(SR, [{ len: '1/4', length: 16 }]);
    e.setTransport(true, BPM);
    const sw1 = Math.round(stepSamples(BPM, SR, '1/4') * 5.37); // mid-step of the 6th quarter
    e.run(sw1);
    const before = e.onsets.get(1)!.length;
    e.setSequence({ id: 1, voiceId: 1, length: 16, steps: allSteps(16), gate: 0.5, stepLength: '1/16' });
    const sw2 = Math.round(stepSamples(BPM, SR, '1/4') * 13.9);
    e.run(sw2 - sw1);
    const mid = e.onsets.get(1)!.length;
    e.setSequence({ id: 1, voiceId: 1, length: 16, steps: allSteps(16), gate: 0.5, stepLength: '1/4' });
    e.run(total - sw2);
    const l = e.onsets.get(1)!;

    // Before: the 1/4 grid. After the first change: exactly the 1/16 reference onsets
    // (same samples, same step index) from the first one after the change; after the
    // second, the 1/4 grid again. No onset in between and none doubled.
    expect(l.slice(0, before)).toEqual(g4.slice(0, before));
    const i16 = g16.findIndex((x) => x.t >= sw1);
    const j16 = g16.findIndex((x) => x.t >= sw2);
    expect(l.slice(before, mid)).toEqual(g16.slice(i16, j16));
    const i4 = g4.findIndex((x) => x.t >= sw2);
    expect(l.slice(mid)).toEqual(g4.slice(i4));
    expect(l[before].t - l[before - 1].t).toBeGreaterThan(0);
  });
});

// ---- the default renders exactly as before step lengths ----

function legacyPair(sr: number) {
  const voices: VoiceParams[] = [
    { ...DEFAULT_VOICE, id: 1, name: 'V1', windowStart: 0, windowEnd: 2, lfoDepth: 0.4, lfoRate: 0.7 },
    { ...DEFAULT_VOICE, id: 2, name: 'V2', windowStart: 1, windowEnd: 3, octave: 1, attack: 0.004, release: 0.05 },
    { ...DEFAULT_VOICE, id: 3, name: 'V3', windowStart: 0, windowEnd: 3, octave: -1, sustain: 0.9, release: 0.3 },
  ];
  // The default session's patterns, plus a 12-step one and a short-gated one.
  const pat = (xs: number[]) => xs.concat(emptySteps()).slice(0, 64);
  const seqs: SequenceData[] = [
    { id: 1, voiceId: 1, length: 16, steps: pat([0, -1, 3, -1, 4, 4, -1, 2, 0, -1, 5, 4, -1, 3, 2, -1]), gate: 0.5, stepLength: '1/8' },
    { id: 2, voiceId: 2, length: 16, steps: pat([-1, -1, 7, -1, -1, 5, -1, -1, -1, -1, 6, -1, 4, -1, -1, -1]), gate: 0.5, stepLength: '1/8' },
    { id: 3, voiceId: 3, length: 16, steps: pat([0, -1, -1, -1, 0, -1, -1, -1, 3, -1, -1, -1, 2, -1, -1, -1]), gate: 0.5, stepLength: '1/8' },
    { id: 4, voiceId: 1, length: 12, steps: pat([5, -1, -1, 1, -1, 6, -1, -1, 2, -1, 7, -1]), gate: 0.13, stepLength: '1/8' },
  ];
  const mk = <E extends SynthEngine | LegacySynthEngine>(e: E) => {
    (['sine', 'saw', 'square', 'tri'] as const).forEach((w, i) => e.addTable(i + 1, buildMipSet(generateBasic(w, 0).data)));
    e.setWavetable(0, packIds([1, 2, 3, 4], 'blend'));
    for (const v of voices) e.setVoice(v);
    for (const s of seqs) e.setSequence(s);
    return e;
  };
  return { now: mk(new SynthEngine(sr)), old: mk(new LegacySynthEngine(sr)), seqs };
}

describe('default (1/8) timing is unchanged', () => {
  it('renders sample-identically to the pre-step-length engine', () => {
    for (const sr of [44100, 48000]) {
      const { now, old, seqs } = legacyPair(sr);
      let at = 0;
      const block = (frames: number) => {
        const a = new Float32Array(frames);
        const b = new Float32Array(frames);
        for (let i = 0; i < frames; i += 128) {
          const n = Math.min(128, frames - i);
          now.process(a.subarray(i, i + n), n);
          old.process(b.subarray(i, i + n), n);
        }
        // First difference (if any) reported with its position.
        const d = a.findIndex((x, i) => !Object.is(x, b[i]));
        expect(d, `sr ${sr}: first mismatch at sample ${at + d}`).toBe(-1);
        at += frames;
        return a;
      };
      const both = (fn: (e: SynthEngine | LegacySynthEngine) => void) => {
        fn(now);
        fn(old);
      };
      block(1000); // stopped: silence
      both((e) => e.setTransport(true, 132)); // 132 @ 48 kHz: every 11th eighth is a whole sample
      const out = block(sr * 8);
      expect(Math.sqrt(out.reduce((s, v) => s + v * v, 0) / out.length)).toBeGreaterThan(0.005);
      both((e) => e.setTransport(true, 97.5)); // tempo change mid-step
      block(sr * 5 + 77);
      both((e) => e.setSequence({ ...seqs[0], gate: 0.9 }));
      block(sr * 3);
      both((e) => e.setTransport(false, 97.5));
      block(sr);
      both((e) => e.setTransport(true, 240));
      block(sr * 6);
      both((e) => e.setTransport(true, 61));
      block(sr * 6);
    }
  });
});
