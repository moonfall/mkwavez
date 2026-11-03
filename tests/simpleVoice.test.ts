/**
 * Simple voices must sound exactly as they did before Synth voices existed: the engine is
 * compared sample for sample with a frozen copy of main's engine (fixtures/mainEngine.ts)
 * over a busy scenario (1D / 2D / Step wavetables, LFOs, several sequences and step lengths,
 * MIDI notes, bends, CC patches, wavetable switches, a removed voice).
 */
import { describe, expect, it } from 'vitest';
import { SynthEngine } from '../src/core/engine/engine';
import { generateBasic } from '../src/core/generators';
import { buildMipSet } from '../src/core/mipmap';
import { emptySteps, type SequenceData, type StepLength } from '../src/core/sequence';
import { DEFAULT_VOICE, type VoiceParams } from '../src/core/voice';
import { make2D } from '../src/core/wavetable';
import { packIds, packWavetable } from '../src/core/wavetablePlayback';
import { MainSynthEngine } from './fixtures/mainEngine';

type Eng = Pick<SynthEngine, 'addTable' | 'setWavetable' | 'setVoice' | 'setSequence' | 'setTransport' | 'applyMidi' | 'patchVoice' | 'removeVoice'> & {
  process(out: Float32Array, frames: number): void;
};

function scenario(e: Eng) {
  const waves = ['sine', 'saw', 'square', 'tri', 'p25'] as const;
  waves.forEach((w, i) => e.addTable(i + 1, buildMipSet(generateBasic(w, 0).data)));
  e.setWavetable(0, packIds([1, 2, 3, 4, 5]));
  e.setWavetable(1, packIds([2, null, 4, 5], 'step'));
  const g = make2D(3, 'Grid', 3, 2);
  e.setWavetable(3, packWavetable({ ...g, rows: [[1, 2, 3], [4, null, 5]] }));
  const voices: VoiceParams[] = [
    { ...DEFAULT_VOICE, id: 1, name: 'V1', windowStart: 0, windowEnd: 4, lfoDepth: 0.8, lfoRate: 1.3 },
    { ...DEFAULT_VOICE, id: 2, name: 'V2', wavetableId: 3, windowStart: 0, windowEnd: 2, windowStartY: 0, windowEndY: 1, lfoDepth: 1, lfoRate: 2, lfoDepthY: 1, lfoRateY: 0.7, octave: 1 },
    { ...DEFAULT_VOICE, id: 3, name: 'V3', wavetableId: 1, windowStart: 0, windowEnd: 3, lfoDepth: 1, lfoRate: 3, octave: -1, attack: 0.02, sustain: 0.8 },
  ];
  for (const v of voices) e.setVoice(v);
  const seq = (id: number, voiceId: number, len: StepLength, rows: number[]): SequenceData => {
    const steps = emptySteps();
    rows.forEach((r, i) => (steps[i] = r));
    return { id, voiceId, length: rows.length, steps, gate: 0.6, stepLength: len };
  };
  e.setSequence(seq(1, 1, '1/8', [0, -1, 3, 4, -1, 2, 7, 1]));
  e.setSequence(seq(2, 2, '1/16', [5, 4, -1, 3, 2, -1, 1, 0, 6, -1, 7, 2]));
  e.setSequence(seq(3, 3, '1/8T', [0, 2, -1, 4, 1, -1]));
  e.setTransport(true, 141);
  return voices;
}

function run(e: Eng, voices: VoiceParams[], chunk: number): Float32Array {
  const SR = 48000;
  const N = SR * 3;
  const out = new Float32Array(N);
  let t = 0;
  const at = (s: number, fn: () => void) => {
    while (t < s * SR) {
      const n = Math.min(chunk, s * SR - t);
      e.process(out.subarray(t, t + n), n);
      t += n;
    }
    fn();
  };
  at(0.3, () => e.applyMidi({ type: 'noteOn', voiceId: 1, note: 64, velocity: 90 }));
  at(0.45, () => e.applyMidi({ type: 'bend', voiceId: 1, semitones: 1.5 }));
  at(0.5, () => e.applyMidi({ type: 'noteOn', voiceId: 1, note: 67, velocity: 30 }));
  at(0.7, () => e.applyMidi({ type: 'noteOff', voiceId: 1, note: 67 }));
  at(0.8, () => e.patchVoice(2, { position: 0.1, lfoDepth: 0.2 }));
  at(0.9, () => e.applyMidi({ type: 'noteOff', voiceId: 1, note: 64 }));
  at(1.1, () => e.setVoice({ ...voices[0], wavetableId: 3, windowStart: 1, windowEnd: 2, windowStartY: 0, windowEndY: 1 }));
  at(1.4, () => e.setWavetable(0, packIds([5, 4, 3])));
  at(1.6, () => e.setVoice({ ...voices[2], wavetableId: 0, windowEnd: 2, mute: true }));
  at(1.9, () => e.applyMidi({ type: 'bend', voiceId: 1, semitones: 0 }));
  at(2.0, () => e.removeVoice(2));
  at(2.2, () => e.setTransport(false, 141));
  at(2.4, () => e.setTransport(true, 99));
  at(3, () => {});
  return out;
}

describe('Simple voices are unchanged', () => {
  for (const chunk of [128, 64, 37]) {
    it(`renders sample-identically to main's engine (blocks of ${chunk})`, () => {
      const a = new SynthEngine(48000);
      const b = new MainSynthEngine(48000);
      const va = scenario(a);
      scenario(b);
      const now = run(a, va, chunk);
      const old = run(b, va, chunk);
      let rms = 0;
      for (let i = 0; i < old.length; i++) rms += old[i] * old[i];
      expect(Math.sqrt(rms / old.length)).toBeGreaterThan(0.01);
      let diff = -1;
      for (let i = 0; i < old.length; i++) {
        if (now[i] !== old[i]) {
          diff = i;
          break;
        }
      }
      expect(diff).toBe(-1);
    });
  }

  it('stereo output carries the same samples in both channels', () => {
    const a = new SynthEngine(48000);
    const b = new MainSynthEngine(48000);
    scenario(a);
    scenario(b);
    const L = new Float32Array(48000);
    const R = new Float32Array(48000);
    const M = new Float32Array(48000);
    for (let i = 0; i < 48000; i += 128) {
      a.process(L.subarray(i, i + 128), 128, R.subarray(i, i + 128));
      b.process(M.subarray(i, i + 128), 128);
    }
    expect(L).toEqual(M);
    expect(R).toEqual(M);
  });
});
