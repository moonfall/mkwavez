import { describe, expect, it } from 'vitest';
import { SynthEngine } from '../src/core/engine/engine';
import type { SynthVoice } from '../src/core/engine/synthVoice';
import { generateBasic } from '../src/core/generators';
import { buildMipSet } from '../src/core/mipmap';
import { DEFAULT_LFO, isOneShot, isPeriodicShape, lfoWave, type LfoParams, type ModSlot } from '../src/core/modulation';
import { DEFAULT_SYNTH, normalizeSynth, type SynthParams } from '../src/core/synth';
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
    sustain: 1,
    release: 0.05,
    synth: normalizeSynth({ ...DEFAULT_SYNTH, poly: 1, mods: [], envAmount: 0, keyTrack: 0, velAmount: 0, cutoff: 20000, b: { ...DEFAULT_SYNTH.b, windowStart: 0, windowEnd: 0 }, ...synth }),
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
function play(synth: Partial<SynthParams>, frames = SR / 4): [Float32Array, Float32Array] {
  const e = engine(synth);
  e.applyMidi({ type: 'noteOn', voiceId: 1, note: 52, velocity: 120 });
  return render(e, frames);
}
const syn = (e: SynthEngine) => (e as unknown as { voices: { syn: SynthVoice }[] }).voices[0].syn;
const lfo1 = (l: Partial<LfoParams>): LfoParams[] => [{ ...DEFAULT_LFO, ...l }, DEFAULT_LFO, DEFAULT_LFO];
const differs = (a: Float32Array, b: Float32Array) => a.some((x, i) => Math.abs(x - b[i]) > 1e-6);

describe('one-shot LFOs (rise / fall)', () => {
  it('rise goes 0 → 1, fall 1 → 0; neither is periodic', () => {
    expect([lfoWave('rise', 0), lfoWave('rise', 0.5), lfoWave('rise', 1)]).toEqual([0, 0.5, 1]);
    expect([lfoWave('fall', 0), lfoWave('fall', 1)]).toEqual([1, 0]);
    expect(isOneShot('rise') && isOneShot('fall') && !isOneShot('sine')).toBe(true);
    expect(isPeriodicShape('rise') || isPeriodicShape('fall')).toBe(false);
  });

  it('runs one cycle from each note, holds its end, and restarts on the next note (even without retrigger)', () => {
    const e = engine({ lfos: lfo1({ shape: 'rise', rate: 8, retrig: false }) });
    const out = () => syn(e).lfoOut[0];
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 52, velocity: 100 });
    render(e, 64 * 4);
    const early = out();
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(0.2);
    render(e, SR / 4); // 2 cycles' worth at 8 Hz: held at the end
    expect(out()).toBe(1);
    render(e, SR / 8);
    expect(out()).toBe(1);
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 55, velocity: 100 });
    render(e, 64 * 2);
    expect(out()).toBeLessThan(0.2);
  });
});

describe('new matrix destinations and the gate source', () => {
  const route = (src: ModSlot['src'], dst: ModSlot['dst'], amt = 1): ModSlot[] => [{ src, dst, amt }];
  it('FM, ring, saturation, detune and LFO depth change the sound only when routed', () => {
    const cases: [Partial<SynthParams>, ModSlot['dst']][] = [
      [{ bLevel: 0 }, 'fm'],
      [{ bLevel: 0.3 }, 'ring'],
      [{ cutoff: 4000 }, 'sat'],
      [{ aUnison: 3, aDetune: 0 }, 'detuneA'],
      [{ bLevel: 0.5, bUnison: 3, bDetune: 0 }, 'detuneB'],
    ];
    for (const [base, dst] of cases) {
      const [plain] = play(base);
      const [moved] = play({ ...base, mods: route('vel', dst) });
      expect(differs(plain, moved)).toBe(true);
    }
    // LFO depth: LFO 2 → A pitch at depth 0, opened by velocity → LFO 2 depth.
    const lfos: LfoParams[] = [DEFAULT_LFO, { ...DEFAULT_LFO, rate: 6, depth: 0 }, DEFAULT_LFO];
    const still = play({ lfos, mods: route('lfo2', 'pitchA', 0.2) })[0];
    const wobble = play({ lfos, mods: [...route('lfo2', 'pitchA', 0.2), ...route('vel', 'lfo2Depth')] })[0];
    expect(differs(still, wobble)).toBe(true);
  });

  it('width is a destination (folding a unison spread to mono)', () => {
    const base = { aUnison: 4, aDetune: 20, aSpread: 1 };
    const [L, R] = play({ ...base, mods: route('vel', 'width', -0.6) }); // width 1 − 2·0.6·vel < 0 → 0
    for (let i = L.length / 2; i < L.length; i += 31) expect(L[i]).toBeCloseTo(R[i], 6);
  });

  it('gate is 1 while the note is held and 0 after release', () => {
    const e = engine({});
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 52, velocity: 100 });
    render(e, 256);
    const gateIdx = 15; // MOD_SOURCES index of 'gate'
    expect(syn(e).src[gateIdx]).toBe(1);
    e.applyMidi({ type: 'noteOff', voiceId: 1, note: 52 });
    render(e, 256);
    expect(syn(e).src[gateIdx]).toBe(0);
  });
});
