import { describe, expect, it } from 'vitest';
import { MASTER_GAIN, SynthEngine } from '../src/core/engine/engine';
import type { SynthVoice } from '../src/core/engine/synthVoice';
import { generateBasic } from '../src/core/generators';
import { buildMipSet } from '../src/core/mipmap';
import { DEFAULT_SYNTH, MAX_UNISON, normalizeSynth, type SynthParams } from '../src/core/synth';
import { DEFAULT_VOICE, type VoiceParams } from '../src/core/voice';
import { packIds } from '../src/core/wavetablePlayback';

const SR = 48000;
function engine(synth: Partial<SynthParams>): SynthEngine {
  const e = new SynthEngine(SR);
  (['sine', 'saw', 'square', 'tri'] as const).forEach((w, i) => e.addTable(i + 1, buildMipSet(generateBasic(w, 0).data)));
  e.setWavetable(0, packIds([1, 2, 3, 4]));
  const v: VoiceParams = {
    ...DEFAULT_VOICE,
    id: 1,
    name: 'V1',
    type: 'synth',
    windowStart: 1,
    windowEnd: 1,
    attack: 0.001,
    sustain: 1,
    release: 0.01,
    synth: normalizeSynth({ ...DEFAULT_SYNTH, poly: 1, mods: [], envAmount: 0, keyTrack: 0, velAmount: 0, cutoff: 20000, ...synth }),
  };
  e.setVoice(v);
  return e;
}
function render(e: SynthEngine, frames: number): [Float32Array, Float32Array] {
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let i = 0; i < frames; i += 128) e.process(L.subarray(i, i + 128), Math.min(128, frames - i), R.subarray(i, i + 128));
  return [L, R];
}
const syn = (e: SynthEngine) => (e as unknown as { voices: { syn: SynthVoice }[] }).voices[0].syn;
/** A note after `wait` samples of silence, then its first `n` samples. */
function noteAfter(e: SynthEngine, wait: number, note = 57, n = 512): Float32Array {
  render(e, wait);
  e.applyMidi({ type: 'noteOn', voiceId: 1, note, velocity: 127 });
  const [L] = render(e, n);
  e.applyMidi({ type: 'noteOff', voiceId: 1, note });
  render(e, SR / 10);
  return L;
}

describe('unison up to 8 copies', () => {
  it('renders 5–8 copies (fading in), bounded, wider than one copy', () => {
    expect(MAX_UNISON).toBe(8);
    for (const n of [5, 6, 7, 8]) {
      const e = engine({ aUnison: n, aDetune: 30, aSpread: 1 });
      e.applyMidi({ type: 'noteOn', voiceId: 1, note: 48, velocity: 127 });
      const [L, R] = render(e, SR / 4);
      expect(syn(e).uA).toBe(n);
      expect([...L, ...R].every((x) => Number.isFinite(x) && Math.abs(x) <= 2 * MASTER_GAIN)).toBe(true);
      let d = 0;
      for (let i = 0; i < L.length; i++) d += Math.abs(L[i] - R[i]);
      expect(d / L.length).toBeGreaterThan(0.003);
    }
  });

  it('copies sit symmetrically (detune places average to 0)', () => {
    const e = engine({ aUnison: 8, aDetune: 40 });
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 48, velocity: 127 });
    render(e, SR / 4);
    const pl = (syn(e) as unknown as { plA: Float64Array }).plA;
    // (Copy 0 glides out from the centre on the first note: within ~1e-3 after 250 ms.)
    expect(Math.abs([...pl].reduce((a, b) => a + b, 0))).toBeLessThan(1e-3);
  });
});

describe('oscillator phase at a note', () => {
  it('free: a note starts wherever the oscillators are; reset: always at the start', () => {
    const free = engine({ phaseMode: 'free' });
    expect(noteAfter(free, 1000)).not.toEqual(noteAfter(free, 1333));
    const reset = engine({ phaseMode: 'reset', aUnison: 3, subLevel: 0.4 });
    noteAfter(reset, 100); // warm-up (a new voice's level ramps in on its first note)
    const a = noteAfter(reset, 1000);
    const b = noteAfter(reset, 1777);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i], 5);
  });

  it('random: each note starts at another phase, deterministically per voice', () => {
    const r1 = engine({ phaseMode: 'random' });
    const x = noteAfter(r1, 1000);
    const y = noteAfter(r1, 1000);
    expect(x).not.toEqual(y);
    const r2 = engine({ phaseMode: 'random' });
    expect(noteAfter(r2, 1000)).toEqual(x);
  });

  it('a legato note keeps the phase (no reset mid-note)', () => {
    const e = engine({ phaseMode: 'reset', glideLegato: true });
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 57, velocity: 127 });
    render(e, 1000);
    const before = syn(e).phCA;
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 60, velocity: 127 });
    expect(syn(e).phCA).toBe(before);
  });

  it('phase mode is validated from saved data', () => {
    expect(normalizeSynth({ phaseMode: 'random' }).phaseMode).toBe('random');
    expect(normalizeSynth({ phaseMode: 'x' }).phaseMode).toBe('free');
    expect(normalizeSynth({ aUnison: 12 }).aUnison).toBe(8);
  });
});

describe('note priority (monophonic voices)', () => {
  const sounding = (e: SynthEngine) => syn(e).target;
  const on = (e: SynthEngine, note: number) => e.applyMidi({ type: 'noteOn', voiceId: 1, note, velocity: 100 });
  const off = (e: SynthEngine, note: number) => e.applyMidi({ type: 'noteOff', voiceId: 1, note });

  it('last: the newest key; releasing it returns to the previous one', () => {
    const e = engine({ priority: 'last' });
    on(e, 55);
    on(e, 60);
    on(e, 50);
    expect(sounding(e)).toBe(50);
    off(e, 50);
    expect(sounding(e)).toBe(60);
  });

  it('low: the lowest held key; a higher key only joins; release falls back to the lowest', () => {
    const e = engine({ priority: 'low' });
    on(e, 55);
    on(e, 60);
    expect(sounding(e)).toBe(55);
    on(e, 50);
    expect(sounding(e)).toBe(50);
    off(e, 50);
    expect(sounding(e)).toBe(55);
    off(e, 60); // not sounding
    expect(sounding(e)).toBe(55);
  });

  it('high: the highest held key', () => {
    const e = engine({ priority: 'high' });
    on(e, 60);
    on(e, 55);
    expect(sounding(e)).toBe(60);
    on(e, 67);
    expect(sounding(e)).toBe(67);
    off(e, 67);
    expect(sounding(e)).toBe(60);
  });

  it('is validated from saved data (missing → last)', () => {
    expect(normalizeSynth({}).priority).toBe('last');
    expect(normalizeSynth({ priority: 'high' }).priority).toBe('high');
  });
});

describe('bend down range', () => {
  it('bends down by its own range; saved data without it bends down as far as up', () => {
    const e = engine({ bendRange: 2, bendDown: 12 });
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 69, velocity: 100 });
    render(e, 256);
    const inc0 = syn(e).incA1;
    e.applyMidi({ type: 'bend', voiceId: 1, semitones: -2 }); // full wheel down
    render(e, SR / 10);
    expect(syn(e).incA1 / inc0).toBeCloseTo(0.5, 3);
    e.applyMidi({ type: 'bend', voiceId: 1, semitones: 2 }); // full wheel up
    render(e, SR / 10);
    expect(syn(e).incA1 / inc0).toBeCloseTo(Math.pow(2, 2 / 12), 3);
    expect(normalizeSynth({ bendRange: 7 }).bendDown).toBe(7);
  });
});
