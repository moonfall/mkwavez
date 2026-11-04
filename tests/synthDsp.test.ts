import { describe, expect, it } from 'vitest';
import { Adsr, AdsrStage } from '../src/core/engine/adsr';
import { MASTER_GAIN, SynthEngine } from '../src/core/engine/engine';
import { cutoffG, driveSample, FILTER_MODE_INDEX, filterResponse, MultiFilter, resonanceK, softLimit } from '../src/core/engine/svf';
import { freqPitch, pitchFreq, SynthVoice, type SynthControl } from '../src/core/engine/synthVoice';
import { generateBasic } from '../src/core/generators';
import { buildMipSet } from '../src/core/mipmap';
import { DEFAULT_SYNTH, FILTER_MODES, normalizeSynth, oscSemis, type FilterMode, type SynthParams } from '../src/core/synth';
import { DEFAULT_VOICE, type VoiceParams } from '../src/core/voice';
import { packIds } from '../src/core/wavetablePlayback';

const SR = 48000;

/** Steady-state gain of the filter for a sine at f (RMS out / RMS in over the last half). */
function gainAt(mode: FilterMode, fc: number, res: number, f: number, sr = SR): number {
  const flt = new MultiFilter();
  const g = cutoffG(fc, sr);
  const k = resonanceK(res);
  const n = Math.max(sr / 2, Math.round((40 * sr) / f));
  let si = 0;
  let so = 0;
  for (let i = 0; i < n; i++) {
    const x = Math.sin((2 * Math.PI * f * i) / sr);
    const y = flt.process(x, FILTER_MODE_INDEX[mode], g, k);
    if (i >= n / 2) {
      si += x * x;
      so += y * y;
    }
  }
  return Math.sqrt(so / si);
}

describe('multimode filter', () => {
  it('frequency response: LP passes lows, HP highs, BP the cutoff, notch rejects it', () => {
    const fc = 1000;
    expect(gainAt('lp12', fc, 0, 100)).toBeGreaterThan(0.95);
    expect(gainAt('lp12', fc, 0, 10000)).toBeLessThan(0.02);
    expect(gainAt('lp24', fc, 0, 100)).toBeGreaterThan(0.95);
    expect(gainAt('lp24', fc, 0, 10000)).toBeLessThan(0.002);
    // LP24 is steeper than LP12 an octave above the cutoff.
    expect(gainAt('lp24', fc, 0, 2000)).toBeLessThan(gainAt('lp12', fc, 0, 2000) * 0.6);
    expect(gainAt('hp', fc, 0, 10000)).toBeGreaterThan(0.95);
    expect(gainAt('hp', fc, 0, 100)).toBeLessThan(0.02);
    expect(gainAt('bp', fc, 0, 1000)).toBeCloseTo(1, 1);
    expect(gainAt('bp', fc, 0.5, 100)).toBeLessThan(0.15);
    expect(gainAt('bp', fc, 0.5, 10000)).toBeLessThan(0.15);
    expect(gainAt('notch', fc, 0, 1000)).toBeLessThan(0.02);
    expect(gainAt('notch', fc, 0, 100)).toBeGreaterThan(0.95);
    expect(gainAt('notch', fc, 0, 10000)).toBeGreaterThan(0.95);
  });

  it('the drawn response curve (filterResponse) matches the measured response', () => {
    for (const mode of FILTER_MODES) {
      for (const res of [0, 0.6]) {
        for (const f of [150, 700, 1300, 5000]) {
          const want = gainAt(mode, 1000, res, f);
          const got = filterResponse(mode, 1000, res, f, SR);
          expect(Math.abs(got - want)).toBeLessThan(0.02 + want * 0.03);
        }
      }
    }
  });

  it('cutoff moves the corner; resonance adds a peak at the cutoff', () => {
    expect(gainAt('lp12', 500, 0, 2000)).toBeLessThan(gainAt('lp12', 4000, 0, 2000) * 0.2);
    for (const mode of ['lp12', 'lp24'] as const) {
      const flat = gainAt(mode, 1000, 0, 1000);
      const peak = gainAt(mode, 1000, 0.9, 1000);
      expect(peak).toBeGreaterThan(flat * 3);
    }
    expect(gainAt('lp12', 1000, 1, 1000)).toBeGreaterThan(30);
  });

  it('stays finite and stable at extreme cutoff / resonance / drive and sample rates', () => {
    for (const sr of [8000, 22050, 44100, 48000, 96000, 192000]) {
      for (const mode of FILTER_MODES) {
        for (const fc of [1, 8, 20, 1000, sr * 0.45, sr * 0.5, sr, 1e9]) {
          for (const res of [0, 0.5, 0.99, 1]) {
            for (const drive of [0, 1]) {
              const flt = new MultiFilter();
              const g = cutoffG(fc, sr);
              const k = resonanceK(res);
              expect(Number.isFinite(g) && g > 0).toBe(true);
              let peak = 0;
              // Full-scale square, then silence: must ring down, never grow.
              let bad = 0;
              for (let i = 0; i < 4000; i++) {
                const x = driveSample(i < 2000 ? (i % 40 < 20 ? 1 : -1) : 0, drive);
                const y = flt.process(x, FILTER_MODE_INDEX[mode], g, k);
                if (!Number.isFinite(y)) bad++;
                peak = Math.max(peak, Math.abs(y));
              }
              expect(bad).toBe(0);
              expect(peak).toBeLessThan(500);
              // It rings down: the last window of silence holds no more energy than the first.
              const win = Math.max(2048, Math.ceil((2 * sr) / Math.max(8, Math.min(fc, 0.49 * sr))));
              let first = -1;
              let en = 0;
              for (let w = 0; w < 6; w++) {
                en = 0;
                for (let i = 0; i < win; i++) {
                  const y = flt.process(0, FILTER_MODE_INDEX[mode], g, k);
                  en += y * y;
                }
                if (first < 0) first = en;
              }
              expect(Number.isFinite(en) && en <= first * 1.0001 + 1e-30).toBe(true);
            }
          }
        }
      }
    }
    // An exhaustive sweep (~50M filter steps, mostly the long low-cutoff ring-downs): ~3.5 s on a
    // fast machine, so the 5 s default is too tight for a loaded CI runner.
  }, 30_000);

  it('per-sample cutoff sweeps (audio-rate modulation) stay finite', () => {
    const flt = new MultiFilter();
    for (let i = 0; i < SR; i++) {
      const fc = 20 * Math.pow(2, 10 * (0.5 + 0.5 * Math.sin(i * 0.05)));
      const y = flt.process(Math.sin(i * 0.1), FILTER_MODE_INDEX.lp24, cutoffG(fc, SR), resonanceK(1));
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it('denormal-range state is flushed to zero', () => {
    const flt = new MultiFilter();
    flt.process(1, 0, cutoffG(100, SR), 2);
    for (let i = 0; i < SR * 20; i++) flt.process(0, 0, cutoffG(100, SR), 2);
    flt.flush();
    expect(flt.process(0, 0, cutoffG(100, SR), 2)).toBe(0);
  });

  it('drive is clean at 0 and bounded; the soft limiter is linear up to 1 and stays under 2', () => {
    expect(driveSample(0.3, 0)).toBe(0.3);
    expect(Math.abs(driveSample(5, 1))).toBeLessThanOrEqual(1.0001);
    expect(softLimit(0.7)).toBe(0.7);
    expect(softLimit(-1)).toBe(-1);
    expect(softLimit(1e6)).toBeLessThanOrEqual(2);
    expect(softLimit(-1e6)).toBeGreaterThanOrEqual(-2);
  });
});

describe('envelopes', () => {
  it('ADSR timing: linear attack in its time, decay ~98% after its time, release likewise', () => {
    const e = new Adsr();
    e.configure(0.01, 0.1, 0.5, 0.2, SR);
    e.gateOn();
    let n = 0;
    while (e.stage === AdsrStage.Attack) {
      e.next();
      n++;
    }
    expect(Math.abs(n - 0.01 * SR)).toBeLessThanOrEqual(2);
    for (let i = 0; i < 0.1 * SR; i++) e.next();
    expect(e.value - 0.5).toBeLessThan(0.5 * 0.03);
    e.gateOff();
    for (let i = 0; i < 0.2 * SR; i++) e.next();
    expect(e.value).toBeLessThan(0.5 * 0.03);
  });
});

describe('pitch math', () => {
  it('note ↔ frequency, oscillator tuning', () => {
    expect(pitchFreq(69)).toBe(440);
    expect(pitchFreq(57)).toBeCloseTo(220, 9);
    expect(freqPitch(pitchFreq(61.37))).toBeCloseTo(61.37, 9);
    expect(oscSemis(1, -5, 50)).toBe(7.5);
    expect(oscSemis(-3, 0, 0)).toBe(-36);
  });

  const voice = (synth: Partial<SynthParams>): VoiceParams => ({ ...DEFAULT_VOICE, id: 1, name: 'V1', type: 'synth', synth: { ...DEFAULT_SYNTH, ...synth } });
  const tables = new Map();
  const ctl = (bend: number, blockLen: number, glideCoef: (s: number) => number): SynthControl => ({ bend, blockLen, tables, wtA: undefined, wtB: undefined, slew: 0.1, glideCoef, gainTarget: 1, bpm: 120, wheel: 0, pressure: 0, slide: 0, noteBend: 0, unisonScale: 1, beat: -1 });

  it('oscillator increments follow octave / coarse / fine, sub is 1 or 2 octaves below A', () => {
    const sv = new SynthVoice(SR, 1, 64);
    const p = voice({ aOct: 1, aCoarse: 7, aFine: 0, bOct: -1, bCoarse: 0, bFine: -50, subOct: 2 });
    sv.noteOn(p, 57, 1, false, true, false);
    sv.control(p, ctl(0, 64, () => 1));
    expect(sv.incA1 * SR).toBeCloseTo(pitchFreq(57 + 19), 6);
    expect(sv.incB1 * SR).toBeCloseTo(pitchFreq(57 - 12.5), 6);
    expect(sv.incS1 * SR).toBeCloseTo(pitchFreq(57 + 19) / 4, 6);
  });

  it('bend range scales the (±2 st) bend; pitch envelope bends its target', () => {
    const sv = new SynthVoice(SR, 1, 64);
    const p = voice({ bendRange: 12, bFine: 0 });
    sv.noteOn(p, 60, 1, false, true, false);
    sv.control(p, ctl(2, 64, () => 1));
    expect(sv.incA1 * SR).toBeCloseTo(pitchFreq(72), 6);
    const q = voice({ pAmount: 12, pAttack: 0, pDecay: 1, pTarget: 'b', bFine: 0 });
    const sq = new SynthVoice(SR, 1, 64);
    sq.noteOn(q, 60, 1, false, true, false);
    sq.control(q, ctl(0, 64, () => 1));
    expect(sq.incA1 * SR).toBeCloseTo(pitchFreq(60), 6);
    expect(sq.incB1 * SR).toBeGreaterThan(pitchFreq(71.5));
  });

  it('glide: reaches ~98% of the interval after the glide time; legato-only glides only legato notes', () => {
    const block = 64;
    const coef = (sec: number) => 1 - Math.exp(-block / ((sec / 4) * SR));
    const sv = new SynthVoice(SR, 1, block);
    const p = voice({ glide: 0.2, glideLegato: false });
    sv.noteOn(p, 48, 1, false, true, false);
    sv.control(p, ctl(0, block, coef));
    sv.noteOn(p, 60, 1, false, true, true);
    expect(sv.pitch).toBe(48);
    for (let t = 0; t < 0.2 * SR; t += block) sv.control(p, ctl(0, block, coef));
    expect(sv.pitch).toBeGreaterThan(48 + 12 * 0.97);
    expect(sv.pitch).toBeLessThan(60);
    const q = voice({ glide: 0.2, glideLegato: true });
    sv.noteOn(q, 36, 1, false, true, true);
    expect(sv.pitch).toBe(36);
    sv.noteOn(q, 48, 1, true, false, true);
    expect(sv.pitch).toBe(36);
    // Not sounding: no glide even when legato-only is off.
    sv.noteOn(p, 70, 1, false, true, false);
    expect(sv.pitch).toBe(70);
  });
});

// ---- engine-level Synth voice ----

function engine(): SynthEngine {
  const e = new SynthEngine(SR);
  (['sine', 'saw', 'square', 'tri'] as const).forEach((w, i) => e.addTable(i + 1, buildMipSet(generateBasic(w, 0).data)));
  e.setWavetable(0, packIds([1, 2, 3, 4]));
  return e;
}

function synthVoice(id: number, synth: Partial<SynthParams>, extra: Partial<VoiceParams> = {}): VoiceParams {
  return {
    ...DEFAULT_VOICE,
    id,
    name: `V${id}`,
    type: 'synth',
    windowStart: 0,
    windowEnd: 3,
    sustain: 1,
    ...extra,
    synth: normalizeSynth({ ...DEFAULT_SYNTH, b: { ...DEFAULT_SYNTH.b, windowEnd: 3, position: 0.7 }, ...synth }),
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

const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

describe('Synth voice in the engine', () => {
  it('renders: finite and bounded across extreme settings', () => {
    const extremes: Partial<SynthParams>[] = [
      {},
      { bLevel: 1, subLevel: 1, noiseLevel: 1, ringLevel: 1, aLevel: 1, resonance: 1, drive: 1, cutoff: 20000, envAmount: 1 },
      { resonance: 1, cutoff: 20, filterMode: 'lp24', envAmount: -1, keyTrack: 1 },
      { filterMode: 'bp', resonance: 1, cutoff: 3000, noiseLevel: 1, noiseType: 'pink' },
      { filterMode: 'hp', resonance: 1, cutoff: 20000, aOct: 3, aCoarse: 24, pAmount: 24, bOct: 3, bCoarse: 24 },
      { filterMode: 'notch', aOct: -3, aCoarse: -24, subWave: 'square', subLevel: 1, subOct: 2, glide: 0.5, glideLegato: false },
    ];
    for (const s of extremes) {
      const e = engine();
      // One note's path (polyphony would sum overlapping release tails).
      e.setVoice(synthVoice(1, { poly: 1, ...s }, { level: 1 }));
      for (const note of [0, 36, 69, 127]) {
        e.applyMidi({ type: 'noteOn', voiceId: 1, note, velocity: 127 });
        e.applyMidi({ type: 'bend', voiceId: 1, semitones: 2 });
        const [L, R] = render(e, SR / 4);
        for (let i = 0; i < L.length; i++) {
          expect(Number.isFinite(L[i]) && Number.isFinite(R[i])).toBe(true);
          expect(Math.abs(L[i])).toBeLessThanOrEqual(2 * MASTER_GAIN + 1e-6);
        }
        e.applyMidi({ type: 'noteOff', voiceId: 1, note });
      }
    }
    // 6 extremes × 4 notes × SR / 4 samples, two expects per sample: ~4 s on a fast machine.
  }, 30_000);

  it('plays sequencer and MIDI notes; pan moves it between channels', () => {
    const e = engine();
    e.setVoice(synthVoice(1, { pan: -1 }));
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 57, velocity: 100 });
    const [L, R] = render(e, SR / 2);
    expect(rms(L)).toBeGreaterThan(0.01);
    expect(rms(R)).toBeLessThan(1e-3);
    e.setVoice(synthVoice(1, { pan: 0 }));
    const [L2, R2] = render(e, SR / 4);
    expect(rms(R2.subarray(SR / 8))).toBeCloseTo(rms(L2.subarray(SR / 8)), 4);
  });

  it('noise is deterministic per voice (seeded): same voice id → same samples', () => {
    const mk = (id: number) => {
      const e = engine();
      e.setVoice(synthVoice(id, { aLevel: 0, noiseLevel: 1, filterMode: 'lp12', cutoff: 20000, envAmount: 0 }));
      e.applyMidi({ type: 'noteOn', voiceId: id, note: 60, velocity: 127 });
      return render(e, 4096)[0];
    };
    const a = mk(1);
    expect(rms(a)).toBeGreaterThan(0.01);
    expect(mk(1)).toEqual(a);
    expect(mk(2)).not.toEqual(a);
  });

  it('pink noise is about as loud as white', () => {
    const mk = (noiseType: 'white' | 'pink') => {
      const e = engine();
      e.setVoice(synthVoice(1, { aLevel: 0, noiseLevel: 1, noiseType, filterMode: 'lp12', cutoff: 20000, envAmount: 0, keyTrack: 0, velAmount: 0 }));
      e.applyMidi({ type: 'noteOn', voiceId: 1, note: 60, velocity: 127 });
      return rms(render(e, SR)[0].subarray(SR / 2));
    };
    const ratio = mk('pink') / mk('white');
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(1.5);
  });

  it('velocity → amp: 0 = every note full level, 1 = the velocity curve', () => {
    const level = (velAmp: number, velocity: number) => {
      const e = engine();
      e.setVoice(synthVoice(1, { velAmp, velAmount: 0 }));
      e.applyMidi({ type: 'noteOn', voiceId: 1, note: 60, velocity });
      return rms(render(e, SR / 2)[0].subarray(SR / 4));
    };
    expect(level(0, 20)).toBeCloseTo(level(0, 127), 3);
    expect(level(1, 20)).toBeLessThan(level(1, 127) * 0.1);
  });

  it('the filter envelope opens the filter (brighter at the attack than in the sustain)', () => {
    const e = engine();
    e.setVoice(synthVoice(1, { cutoff: 200, envAmount: 1, fAttack: 0.001, fDecay: 0.6, fSustain: 0, resonance: 0, keyTrack: 0 }, { windowStart: 1, windowEnd: 1 }));
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 45, velocity: 127 });
    const [L] = render(e, SR);
    const hf = (x: Float32Array) => rms(x.map((v, i) => (i ? v - x[i - 1] : 0)));
    expect(hf(L.subarray(500, 2500))).toBeGreaterThan(hf(L.subarray(SR / 2, SR / 2 + 2000)) * 3);
  });

  it('switching a sounding voice Simple ↔ Synth is click-free', () => {
    const e = engine();
    const simple: VoiceParams = { ...synthVoice(1, { cutoff: 20000, envAmount: 0, resonance: 0 }), type: 'simple', lfoDepth: 0 };
    e.setVoice(simple);
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 45, velocity: 127 });
    const before = render(e, SR / 4)[0];
    let maxStep = 0;
    for (let i = 1; i < before.length; i++) maxStep = Math.max(maxStep, Math.abs(before[i] - before[i - 1]));
    e.setVoice({ ...simple, type: 'synth' });
    const sw = render(e, SR / 8)[0];
    e.setVoice(simple);
    const back = render(e, SR / 8)[0];
    const joined = new Float32Array([before[before.length - 1], ...sw, ...back]);
    let jump = 0;
    for (let i = 1; i < joined.length; i++) jump = Math.max(jump, Math.abs(joined[i] - joined[i - 1]));
    expect(jump).toBeLessThan(maxStep * 2);
    expect(rms(sw)).toBeGreaterThan(0.01);
  });

  it('osc B reads its own wavetable / window; status reports both oscillators', () => {
    const e = engine();
    e.setWavetable(5, packIds([3]));
    e.setVoice(synthVoice(1, { bLevel: 1, aLevel: 0, b: { wavetableId: 5, windowStart: 0, windowEnd: 0, windowStartY: 0, windowEndY: 0, position: 0.5, positionY: 0.5 } }));
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 57, velocity: 127 });
    const [L] = render(e, SR / 4);
    expect(rms(L)).toBeGreaterThan(0.01);
    const st = e.status({ tick: -1, playing: false, voices: [] });
    expect(st.voices[0].indexB).toBe(0);
    expect(st.voices[0].pos).toBeGreaterThanOrEqual(0);
  });
});

describe('sync, FM, unison, saturation, width', () => {
  const hfOf = (x: Float32Array) => {
    let s = 0;
    for (let i = 1; i < x.length; i++) s += (x[i] - x[i - 1]) ** 2;
    return Math.sqrt(s / x.length);
  };
  const play = (synth: Partial<SynthParams>, frames = SR / 4) => {
    const e = engine();
    e.setVoice(synthVoice(1, { mods: [], cutoff: 20000, envAmount: 0, keyTrack: 0, resonance: 0, filterMode: 'lp12', ...synth }, { windowStart: 0, windowEnd: 0 }));
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 48, velocity: 127 });
    return render(e, frames);
  };

  it('hard sync: osc A restarts on osc B’s cycle (a sine A 17 st up gets harmonics)', () => {
    const base = { aCoarse: 17, b: { ...DEFAULT_SYNTH.b, windowEnd: 0 } };
    const free = play({ ...base, sync: false })[0];
    const synced = play({ ...base, sync: true })[0];
    expect(synced.every(Number.isFinite)).toBe(true);
    expect(hfOf(synced)).toBeGreaterThan(hfOf(free) * 1.3);
  });

  it('FM: osc B modulating A’s phase brightens a sine', () => {
    const b = { ...DEFAULT_SYNTH.b, windowStart: 0, windowEnd: 0 };
    const dry = play({ b, fm: 0 })[0];
    const fm = play({ b, fm: 0.8 })[0];
    expect(fm.every(Number.isFinite)).toBe(true);
    expect(hfOf(fm)).toBeGreaterThan(hfOf(dry) * 1.5);
  });

  it('unison: copies detune (beating) and spread across the stereo field; width 0 folds it to mono', () => {
    const [L1, R1] = play({ aUnison: 1 });
    expect(L1).toEqual(R1);
    const [L, R] = play({ aUnison: 4, aDetune: 30, aSpread: 1 });
    let diff = 0;
    for (let i = 0; i < L.length; i++) diff += Math.abs(L[i] - R[i]);
    expect(diff / L.length).toBeGreaterThan(0.005);
    expect(L.every((x) => Math.abs(x) <= 2 * MASTER_GAIN)).toBe(true);
    const [Lm, Rm] = play({ aUnison: 4, aDetune: 30, aSpread: 1, width: 0 });
    for (let i = 0; i < Lm.length; i += 97) expect(Lm[i]).toBeCloseTo(Rm[i], 6);
    // 1/√n: four copies are about as loud as one, not four times.
    const rms1 = rms(L1);
    expect(rms(L)).toBeLessThan(rms1 * 2);
  });

  it('saturation after the filter stays bounded', () => {
    const [L] = play({ sat: 1, drive: 1, resonance: 1, cutoff: 800, aLevel: 1, bLevel: 1, subLevel: 1 });
    expect(L.every((x) => Number.isFinite(x) && Math.abs(x) <= 2 * MASTER_GAIN + 1e-6)).toBe(true);
  });

  it('CPU guard: over UNISON_BUDGET copies, unison is scaled down and status says so', () => {
    const e = engine();
    for (let id = 1; id <= 8; id++) {
      e.setVoice(synthVoice(id, { aUnison: 4, bUnison: 4, bLevel: 0.5 }));
      e.applyMidi({ type: 'noteOn', voiceId: id, note: 40 + id, velocity: 100 });
    }
    render(e, 1024);
    expect(e.status({ tick: -1, playing: false, voices: [] }).unisonLimited).toBe(true);
    const one = engine();
    one.setVoice(synthVoice(1, { aUnison: 4, bUnison: 4, bLevel: 0.5 }));
    one.applyMidi({ type: 'noteOn', voiceId: 1, note: 40, velocity: 100 });
    render(one, 1024);
    expect(one.status({ tick: -1, playing: false, voices: [] }).unisonLimited).toBe(false);
  });
});

describe('review fixes', () => {
  it('switching back into Synth re-syncs the path: pitch snaps to the current note, filter env follows the gate', () => {
    const e = engine();
    const v = synthVoice(1, { glide: 0.5, glideLegato: false });
    e.setVoice(v);
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 40, velocity: 127 });
    render(e, 4096);
    e.setVoice({ ...v, type: 'simple' });
    render(e, 4096);
    e.applyMidi({ type: 'noteOff', voiceId: 1, note: 40 });
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 70, velocity: 127 });
    render(e, 4096);
    e.setVoice(v);
    const syn = (e as unknown as { voices: { syn: { pitch: number; target: number; fenv: { stage: number } } }[] }).voices[0].syn;
    expect(syn.pitch).toBeCloseTo(70, 6);
    expect(syn.target).toBeCloseTo(70, 6);
    expect(syn.fenv.stage).toBe(1); // attack: retriggered for the held note
    render(e, 2048);
    expect(syn.pitch).toBeCloseTo(70, 6); // no glide from the stale note 40
    // Released while Simple, then back to Synth: envelopes silent.
    e.setVoice({ ...v, type: 'simple' });
    e.applyMidi({ type: 'noteOff', voiceId: 1, note: 70 });
    render(e, SR);
    e.setVoice(v);
    expect(syn.fenv.stage).toBe(0);
  });

  it('ring modulation takes one mip level fewer harmonics; FM drops them by the sideband width', () => {
    const tables = new Map();
    const c: SynthControl = { bend: 0, blockLen: 64, tables, wtA: undefined, wtB: undefined, slew: 0.1, glideCoef: () => 1, gainTarget: 1, bpm: 120, wheel: 0, pressure: 0, slide: 0, noteBend: 0, unisonScale: 1, beat: -1 };
    const lv = (synth: Partial<SynthParams>) => {
      const p: VoiceParams = { ...DEFAULT_VOICE, id: 1, name: 'V1', type: 'synth', synth: { ...DEFAULT_SYNTH, mods: [], ...synth } };
      const sv = new SynthVoice(SR, 1, 64);
      sv.noteOn(p, 81, 1, false, true, false);
      sv.control(p, c);
      return [sv.a.mipLevel, sv.b.mipLevel];
    };
    const [a0, b0] = lv({});
    expect(lv({ ringLevel: 0.5 })).toEqual([a0 + 1, b0 + 1]);
    const [aFm] = lv({ fm: 1 });
    expect(aFm).toBeGreaterThan(a0);
    expect(lv({ fm: 1 })[1]).toBe(b0);
    // Carson's rule: a bigger index takes more harmonics away.
    expect(lv({ fm: 0.05 })[0]).toBeLessThanOrEqual(aFm);
    expect(lv({ fm: 0.05 })[0]).toBe(a0);
  });
});
