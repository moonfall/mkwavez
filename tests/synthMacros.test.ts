import { describe, expect, it } from 'vitest';
import { SynthEngine } from '../src/core/engine/engine';
import { generateBasic } from '../src/core/generators';
import { ccPatch, CC_PARAMS, DEFAULT_CC_MAP } from '../src/core/midi';
import { buildMipSet } from '../src/core/mipmap';
import { MOD_SOURCES, UNIPOLAR_SOURCES } from '../src/core/modulation';
import { DEFAULT_SYNTH, MACRO_KEYS, normalizeSynth, type SynthParams } from '../src/core/synth';
import { DEFAULT_VOICE, type VoiceParams } from '../src/core/voice';
import { packIds } from '../src/core/wavetablePlayback';

const SR = 48000;

function play(synth: Partial<SynthParams>): Float32Array {
  const e = new SynthEngine(SR);
  (['sine', 'saw', 'square', 'tri'] as const).forEach((w, i) => e.addTable(i + 1, buildMipSet(generateBasic(w, 0).data)));
  e.setWavetable(0, packIds([1, 2, 3, 4]));
  const v: VoiceParams = { ...DEFAULT_VOICE, id: 1, name: 'V1', type: 'synth', windowStart: 1, windowEnd: 1, sustain: 1, synth: normalizeSynth({ ...DEFAULT_SYNTH, poly: 1, mods: [], envAmount: 0, keyTrack: 0, velAmount: 0, ...synth }) };
  e.setVoice(v);
  e.applyMidi({ type: 'noteOn', voiceId: 1, note: 48, velocity: 127 });
  const L = new Float32Array(SR / 4);
  const R = new Float32Array(SR / 4);
  for (let i = 0; i < L.length; i += 128) e.process(L.subarray(i, i + 128), 128, R.subarray(i, i + 128));
  return L.subarray(L.length >> 1);
}
const hf = (x: Float32Array) => {
  let d = 0;
  let p = 0;
  for (let i = 1; i < x.length; i++) {
    d += (x[i] - x[i - 1]) ** 2;
    p += x[i] * x[i];
  }
  return d / p;
};

describe('macros', () => {
  it('are unipolar matrix sources: a macro opens the filter as far as it is turned', () => {
    expect(MACRO_KEYS.every((k) => (MOD_SOURCES as readonly string[]).includes(k) && UNIPOLAR_SOURCES.has(k))).toBe(true);
    const route = { cutoff: 300, mods: [{ src: 'macro3' as const, dst: 'cutoff' as const, amt: 0.6 }] };
    const closed = hf(play({ ...route, macro3: 0 }));
    const half = hf(play({ ...route, macro3: 0.5 }));
    const open = hf(play({ ...route, macro3: 1 }));
    expect(half).toBeGreaterThan(closed * 1.5);
    expect(open).toBeGreaterThan(half * 1.5);
    // Not routed: no effect.
    expect(play({ cutoff: 300, macro3: 1 })).toEqual(play({ cutoff: 300, macro3: 0 }));
  });

  it('one macro can drive several destinations', () => {
    const one = play({ cutoff: 500, aWarp: 'bend', mods: [{ src: 'macro1', dst: 'cutoff', amt: 0.5 }], macro1: 1 });
    const two = play({ cutoff: 500, aWarp: 'bend', mods: [{ src: 'macro1', dst: 'cutoff', amt: 0.5 }, { src: 'macro1', dst: 'warpA', amt: 0.9 }], macro1: 1 });
    expect(two).not.toEqual(one);
  });

  it('are MIDI CC targets', () => {
    expect(MACRO_KEYS.every((k) => (CC_PARAMS as readonly string[]).includes(k))).toBe(true);
    const map = { ...DEFAULT_CC_MAP, macro2: 21 };
    expect(ccPatch(map, 21, 127)).toEqual({ synth: { macro2: 1 } });
    expect(ccPatch(map, 21, 0)).toEqual({ synth: { macro2: 0 } });
  });

  it('are validated from saved data (missing → 0, clamped)', () => {
    const s = normalizeSynth({ macro1: 2, macro2: -1, macro3: 'x' });
    expect([s.macro1, s.macro2, s.macro3, s.macro4]).toEqual([1, 0, 0, 0]);
  });
});
