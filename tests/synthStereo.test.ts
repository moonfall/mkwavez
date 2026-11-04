import { describe, expect, it } from 'vitest';
import { MASTER_GAIN, SynthEngine } from '../src/core/engine/engine';
import type { SynthVoice } from '../src/core/engine/synthVoice';
import { generateBasic } from '../src/core/generators';
import { buildMipSet } from '../src/core/mipmap';
import { DEFAULT_LFO, type LfoParams, type ModSlot } from '../src/core/modulation';
import { DEFAULT_SYNTH, normalizeSynth, type SynthParams } from '../src/core/synth';
import { DEFAULT_VOICE, type VoiceParams } from '../src/core/voice';
import { packIds } from '../src/core/wavetablePlayback';

const SR = 48000;

/** Wavetable 0: sine, saw, square, tri (1D, blend); wavetable 1: the same, Step. */
function engine(): SynthEngine {
  const e = new SynthEngine(SR);
  (['sine', 'saw', 'square', 'tri'] as const).forEach((w, i) => e.addTable(i + 1, buildMipSet(generateBasic(w, 0).data)));
  e.setWavetable(0, packIds([1, 2, 3, 4]));
  e.setWavetable(1, { ...packIds([1, 2, 3, 4]), interp: 'step' });
  return e;
}

/** A dry Synth voice (no matrix, filter open, no envelopes) on osc A (sine) with overrides. */
function voice(synth: Partial<SynthParams>, extra: Partial<VoiceParams> = {}): VoiceParams {
  return {
    ...DEFAULT_VOICE,
    id: 1,
    name: 'V1',
    type: 'synth',
    windowStart: 0,
    windowEnd: 0,
    position: 0,
    sustain: 1,
    ...extra,
    synth: normalizeSynth({
      ...DEFAULT_SYNTH,
      mods: [],
      cutoff: 20000,
      envAmount: 0,
      keyTrack: 0,
      velAmount: 0,
      resonance: 0,
      filterMode: 'lp12',
      b: { ...DEFAULT_SYNTH.b, windowStart: 1, windowEnd: 1, position: 0 },
      ...synth,
    }),
  };
}

function render(e: SynthEngine, frames: number): [Float32Array, Float32Array] {
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let i = 0; i < frames; i += 128) {
    const n = Math.min(128, frames - i);
    e.process(L.subarray(i, i + n), n, R.subarray(i, i + n));
  }
  return [L, R];
}

const syn = (e: SynthEngine) => (e as unknown as { voices: { syn: SynthVoice }[] }).voices[0].syn;

function play(synth: Partial<SynthParams>, frames = SR / 4, extra: Partial<VoiceParams> = {}): [Float32Array, Float32Array] {
  const e = engine();
  e.setVoice(voice(synth, extra));
  e.applyMidi({ type: 'noteOn', voiceId: 1, note: 57, velocity: 127 });
  return render(e, frames);
}

const tail = (x: Float32Array) => x.subarray(x.length >> 1);
const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
const meanAbsDiff = (a: Float32Array, b: Float32Array) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
};
/** Normalised correlation of two signals. */
function corr(a: Float32Array, b: Float32Array): number {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return ab / Math.sqrt(aa * bb);
}
/** Energy above the first-difference: a rough brightness measure. */
function hf(x: Float32Array): number {
  let s = 0;
  for (let i = 1; i < x.length; i++) s += (x[i] - x[i - 1]) ** 2;
  return s / rms(x) ** 2 / x.length;
}
const lfo = (l: Partial<LfoParams>): LfoParams[] => [{ ...DEFAULT_LFO, ...l }, DEFAULT_LFO, DEFAULT_LFO];

describe('stereo Synth voice', () => {
  it('every stereo control at its default leaves the voice mono (left = right, one filter)', () => {
    const e = engine();
    e.setVoice(voice({ bLevel: 0.5, noiseLevel: 0.3, subLevel: 0.2 }));
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 57, velocity: 127 });
    const [L, R] = render(e, SR / 8);
    expect(L).toEqual(R);
    expect(syn(e).stereo).toBe(false);
  });

  it('oscillator pan: osc A hard left leaves the right channel with osc B only', () => {
    const [L, R] = play({ aPan: -1 });
    expect(rms(tail(L))).toBeGreaterThan(0.05);
    expect(rms(tail(R))).toBeLessThan(1e-4);
    // Osc B on the right, A on the left: both channels sound, and differ.
    const [L2, R2] = play({ aPan: -1, bPan: 1, bLevel: 0.8 });
    expect(rms(tail(L2))).toBeGreaterThan(0.05);
    expect(rms(tail(R2))).toBeGreaterThan(0.05);
    expect(meanAbsDiff(tail(L2), tail(R2))).toBeGreaterThan(0.01);
    // A centred pan is exactly the mono voice.
    const [Lc, Rc] = play({ aPan: 0 });
    expect(Lc).toEqual(Rc);
  });

  it('oscillator pan is a matrix destination (an LFO sweeps osc A across)', () => {
    const [L, R] = play({ lfos: lfo({ rate: 4 }), mods: [{ src: 'lfo1', dst: 'panA', amt: 1 }] }, SR / 2);
    expect(meanAbsDiff(L, R)).toBeGreaterThan(0.01);
    expect(L.every(Number.isFinite) && R.every(Number.isFinite)).toBe(true);
  });

  it('stereo phase: the right channel reads ahead; at ½ cycle a sine is inverted on the right', () => {
    const [L, R] = play({ aPhaseSpread: 0.5 }, SR / 2);
    const l = tail(L);
    const r = tail(R);
    expect(corr(l, r)).toBeLessThan(-0.99);
    expect(rms(r)).toBeCloseTo(rms(l), 2);
    const [L4, R4] = play({ aPhaseSpread: 0.25 }, SR / 2);
    expect(Math.abs(corr(tail(L4), tail(R4)))).toBeLessThan(0.05);
  });

  it('stereo position: left and right read different tables of the window', () => {
    // Window sine … tri at position 0.5, spread 1: left reads the sine end, right the tri end.
    const [L, R] = play({ aPosSpread: 1 }, SR / 2, { windowEnd: 3, position: 0.5 });
    const [Ls] = play({}, SR / 2, { windowEnd: 3, position: 0 });
    const [Lt] = play({}, SR / 2, { windowEnd: 3, position: 1 });
    expect(corr(tail(L), tail(Ls))).toBeGreaterThan(0.999);
    expect(corr(tail(R), tail(Lt))).toBeGreaterThan(0.999);
    expect(meanAbsDiff(tail(L), tail(R))).toBeGreaterThan(0.01);
  });

  it('stereo position on a Step wavetable switches the right channel on its own (click-free) wraps', () => {
    const [L, R] = play({ aPosSpread: 1 }, SR / 2, { wavetableId: 1, windowEnd: 3, position: 0.5 });
    const [Ls] = play({}, SR / 2, { wavetableId: 1, windowEnd: 3, position: 0 });
    const [Lt] = play({}, SR / 2, { wavetableId: 1, windowEnd: 3, position: 1 });
    expect(corr(tail(L), tail(Ls))).toBeGreaterThan(0.999);
    expect(corr(tail(R), tail(Lt))).toBeGreaterThan(0.999);
  });

  it('stereo position: the right channel goes back onto the left mix (and mono) once the spread is gone', () => {
    const e = engine();
    const v = voice({ aPosSpread: 0.6 }, { windowEnd: 3, position: 0.5 });
    e.setVoice(v);
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 57, velocity: 127 });
    const [, R0] = render(e, SR / 8);
    expect(syn(e).rA).toBe(true);
    expect(syn(e).stereo).toBe(true);
    e.setVoice({ ...v, synth: { ...v.synth, aPosSpread: 0 } });
    const [L, R] = render(e, SR / 2);
    expect(syn(e).rA).toBe(false);
    expect(syn(e).stereo).toBe(false);
    expect(tail(L)).toEqual(tail(R));
    // No step (the right channel's mix crossfades back): no sample-to-sample move larger
    // than the steady waveforms' own (before, and after on the left).
    const jump = (x: Float32Array) => {
      let j = 0;
      for (let i = 1; i < x.length; i++) j = Math.max(j, Math.abs(x[i] - x[i - 1]));
      return j;
    };
    expect(jump(R)).toBeLessThan(Math.max(jump(tail(R0)), jump(tail(L))) * 1.05);
  });

  it('noise width: 0 = the same noise on both sides, 1 = uncorrelated at the same loudness', () => {
    const base = { aLevel: 0, noiseLevel: 1 };
    const [L0, R0] = play({ ...base, noiseWidth: 0 });
    expect(L0).toEqual(R0);
    for (const noiseType of ['white', 'pink'] as const) {
      const [L1, R1] = play({ ...base, noiseType, noiseWidth: 1 }, SR / 2);
      expect(Math.abs(corr(tail(L1), tail(R1)))).toBeLessThan(0.1);
      expect(rms(tail(R1)) / rms(tail(L1))).toBeGreaterThan(0.85);
      expect(rms(tail(R1)) / rms(tail(L1))).toBeLessThan(1.15);
      const [Lh, Rh] = play({ ...base, noiseType, noiseWidth: 0.5 }, SR / 2);
      const c = corr(tail(Lh), tail(Rh));
      expect(c).toBeGreaterThan(0.5);
      expect(c).toBeLessThan(0.9);
    }
  });

  it('filter spread: the left closes and the right opens (negative swaps them)', () => {
    const base = { aLevel: 0.8, cutoff: 1200, filterMode: 'lp24' as const };
    const sawWin = { windowStart: 1, windowEnd: 1 };
    const [L, R] = play({ ...base, filterSpread: 1 }, SR / 2, sawWin);
    expect(hf(tail(R))).toBeGreaterThan(hf(tail(L)) * 2);
    const [Ln, Rn] = play({ ...base, filterSpread: -1 }, SR / 2, sawWin);
    expect(hf(tail(Ln))).toBeGreaterThan(hf(tail(Rn)) * 2);
    // Matrix destination.
    const [Lm, Rm] = play({ ...base, mods: [{ src: 'vel', dst: 'fSpread', amt: 1 }] }, SR / 2, sawWin);
    expect(hf(tail(Rm))).toBeGreaterThan(hf(tail(Lm)) * 2);
  });

  it('stereo LFO: per-channel destinations differ; others (pitch) stay shared', () => {
    const cut: ModSlot[] = [{ src: 'lfo1', dst: 'cutoff', amt: 0.5 }];
    const sawWin = { windowStart: 1, windowEnd: 1 };
    const [L, R] = play({ cutoff: 1500, filterMode: 'lp24', lfos: lfo({ rate: 3, stereo: 0.5 }), mods: cut }, SR / 2, sawWin);
    expect(meanAbsDiff(L, R)).toBeGreaterThan(0.005);
    // Stereo phase 0: mono.
    const [L0, R0] = play({ cutoff: 1500, filterMode: 'lp24', lfos: lfo({ rate: 3 }), mods: cut }, SR / 2, sawWin);
    expect(L0).toEqual(R0);
    // A stereo LFO on pitch only: still mono (pitch is shared).
    const [Lp, Rp] = play({ lfos: lfo({ rate: 3, stereo: 0.5 }), mods: [{ src: 'lfo1', dst: 'pitchA', amt: 0.1 }] }, SR / 4);
    expect(Lp).toEqual(Rp);
    // Random shapes ignore the stereo phase.
    const [Ls, Rs] = play({ cutoff: 1500, lfos: lfo({ shape: 'sh', rate: 8, stereo: 0.5 }), mods: cut }, SR / 4, sawWin);
    expect(Ls).toEqual(Rs);
  });

  it('stereo LFO on amp, levels and position', () => {
    const l = lfo({ rate: 2, stereo: 0.5 });
    for (const mods of [
      [{ src: 'lfo1', dst: 'amp', amt: -0.8 }],
      [{ src: 'lfo1', dst: 'levelA', amt: -0.7 }],
      [{ src: 'lfo1', dst: 'posA', amt: 0.5 }],
    ] as ModSlot[][]) {
      const [L, R] = play({ lfos: l, mods }, SR / 2, { windowEnd: 3, position: 0.5 });
      expect(meanAbsDiff(L, R)).toBeGreaterThan(0.005);
      expect(L.every((x) => Number.isFinite(x) && Math.abs(x) <= 2 * MASTER_GAIN)).toBe(true);
    }
  });

  it('width now applies to every stereo source (0 folds oscillator pan back to mono)', () => {
    const [L, R] = play({ aPan: -0.8, bPan: 0.8, bLevel: 0.6, width: 0 });
    for (let i = 0; i < L.length; i += 37) expect(L[i]).toBeCloseTo(R[i], 6);
  });

  it('goes back to mono once the stereo controls return to centre', () => {
    const e = engine();
    const v = voice({ aPan: -0.5, aPhaseSpread: 0.3, filterSpread: 0.5, noiseLevel: 0.2, noiseWidth: 1 });
    e.setVoice(v);
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 57, velocity: 127 });
    render(e, SR / 8);
    expect(syn(e).stereo).toBe(true);
    e.setVoice({ ...v, synth: { ...v.synth, aPan: 0, aPhaseSpread: 0, filterSpread: 0, noiseWidth: 0 } });
    render(e, SR / 2);
    expect(syn(e).stereo).toBe(false);
    const [L, R] = render(e, SR / 16);
    expect(L).toEqual(R);
  });

  it('is deterministic and bounded with everything on', () => {
    const all: Partial<SynthParams> = {
      aUnison: 3,
      aSpread: 0.7,
      bUnison: 2,
      bLevel: 0.6,
      aPan: -0.3,
      bPan: 0.4,
      aPhaseSpread: 0.2,
      bPhaseSpread: 0.4,
      aPosSpread: 0.5,
      bPosSpread: 0.8,
      noiseLevel: 0.2,
      noiseType: 'pink',
      noiseWidth: 0.7,
      filterSpread: 0.6,
      cutoff: 2000,
      resonance: 0.6,
      fm: 0.3,
      sync: true,
      ringLevel: 0.3,
      width: 1.8,
      lfos: [{ ...DEFAULT_LFO, rate: 3, stereo: 0.25 }, { ...DEFAULT_LFO, shape: 'tri', rate: 1, stereo: 0.5 }, DEFAULT_LFO],
      mods: [
        { src: 'lfo1', dst: 'posA', amt: 0.4 },
        { src: 'lfo2', dst: 'cutoff', amt: 0.3 },
        { src: 'lfo1', dst: 'panB', amt: 0.5 },
        { src: 'lfo2', dst: 'fSpread', amt: 0.4 },
      ],
    };
    const extra = { windowEnd: 3, position: 0.4 };
    const [L, R] = play(all, SR / 2, extra);
    const [L2, R2] = play(all, SR / 2, extra);
    expect(L).toEqual(L2);
    expect(R).toEqual(R2);
    expect([...L, ...R].every((x) => Number.isFinite(x) && Math.abs(x) <= 2 * MASTER_GAIN)).toBe(true);
    expect(meanAbsDiff(L, R)).toBeGreaterThan(0.005);
  });

  it('CPU guard: copies of an oscillator with a stereo phase / position count double', () => {
    const e = engine();
    for (let id = 1; id <= 3; id++) {
      e.setVoice({ ...voice({ aUnison: 4, aPhaseSpread: 0.25, bLevel: 0.5, bUnison: 4, bPosSpread: 0.5 }), id, name: `V${id}` });
      e.applyMidi({ type: 'noteOn', voiceId: id, note: 50 + id, velocity: 100 });
    }
    render(e, 512);
    // 3 × (4·2 + 4·2) = 48 > 32 (without the doubling: 24, under it).
    expect(e.status({ tick: 0, playing: false, unisonLimited: false, voices: [] } as never).unisonLimited).toBe(true);
  });
});

describe('stereo params from saved data', () => {
  it('older data (no stereo fields) gets the neutral defaults; values are clamped', () => {
    const old = normalizeSynth({ cutoff: 1000, lfos: [{ shape: 'sine', rate: 1 }] });
    expect([old.aPan, old.bPan, old.aPhaseSpread, old.bPhaseSpread, old.aPosSpread, old.bPosSpread, old.noiseWidth, old.filterSpread]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(old.lfos.map((l) => l.stereo)).toEqual([0, 0, 0]);
    const wild = normalizeSynth({ aPan: -3, bPan: 2, aPhaseSpread: 0.9, bPosSpread: -1, noiseWidth: 5, filterSpread: -7, lfos: [{ stereo: 2 }, { stereo: -1 }, { stereo: 'x' }] });
    expect([wild.aPan, wild.bPan, wild.aPhaseSpread, wild.bPosSpread, wild.noiseWidth, wild.filterSpread]).toEqual([-1, 1, 0.5, 0, 1, -1]);
    expect(wild.lfos.map((l) => l.stereo)).toEqual([0.5, 0, 0]);
  });

  it('the new matrix destinations survive normalisation', () => {
    const s = normalizeSynth({ mods: [{ src: 'lfo1', dst: 'panA', amt: 0.5 }, { src: 'lfo2', dst: 'panB', amt: -0.5 }, { src: 'vel', dst: 'fSpread', amt: 1 }] });
    expect(s.mods.slice(0, 3).map((m) => m.dst)).toEqual(['panA', 'panB', 'fSpread']);
  });
});
