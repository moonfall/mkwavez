/**
 * CPU benchmark: 8 Synth voices (both oscillators crossfading 2D-blended tables, sub,
 * noise, LP24 with drive and a moving filter envelope) at 48 kHz, rendered in 128-sample
 * render quanta. Prints the time per quantum against the real-time budget (128 / 48000 s =
 * 2.67 ms) and fails only if it takes more than half of it (CI machines vary).
 * `npm run bench` runs just this file.
 */
import { describe, expect, it } from 'vitest';
import { SynthEngine } from '../src/core/engine/engine';
import { generateBasic } from '../src/core/generators';
import { buildMipSet } from '../src/core/mipmap';
import { DEFAULT_SYNTH, normalizeSynth, type SynthParams } from '../src/core/synth';
import { DEFAULT_VOICE, type VoiceParams } from '../src/core/voice';
import { make2D } from '../src/core/wavetable';
import { packWavetable } from '../src/core/wavetablePlayback';

const SR = 48000;
const Q = 128;

export function benchEngine(synth: Partial<SynthParams> = {}, voices = 8): SynthEngine {
  const e = new SynthEngine(SR);
  const waves = ['sine', 'saw', 'square', 'tri', 'p25'] as const;
  for (let i = 0; i < 16; i++) e.addTable(i + 1, buildMipSet(generateBasic(waves[i % 5], 0).data));
  const g = make2D(3, 'Grid', 4, 4);
  e.setWavetable(3, packWavetable({ ...g, rows: [0, 1, 2, 3].map((r) => [1, 2, 3, 4].map((c) => r * 4 + c)) }));
  for (let id = 1; id <= voices; id++) {
    const v: VoiceParams = {
      ...DEFAULT_VOICE,
      id,
      name: `V${id}`,
      type: 'synth',
      wavetableId: 3,
      windowStart: 0,
      windowEnd: 3,
      windowStartY: 0,
      windowEndY: 3,
      position: 0.37,
      positionY: 0.61,
      sustain: 1,
      synth: normalizeSynth({
        ...DEFAULT_SYNTH,
        b: { wavetableId: 3, windowStart: 0, windowEnd: 3, windowStartY: 0, windowEndY: 3, position: 0.72, positionY: 0.15 },
        bLevel: 0.7,
        subLevel: 0.4,
        subWave: 'square',
        noiseLevel: 0.1,
        ringLevel: 0.2,
        drive: 0.4,
        resonance: 0.6,
        envAmount: 0.5,
        fSustain: 0.5,
        pan: (id - 4.5) / 4,
        ...synth,
      }),
    };
    e.setVoice(v);
    e.applyMidi({ type: 'noteOn', voiceId: id, note: 40 + id * 3, velocity: 100 });
  }
  return e;
}

/** Mean ms per render quantum over `seconds` of audio (after a warm-up). */
export function msPerQuantum(e: SynthEngine, seconds = 2): number {
  const L = new Float32Array(Q);
  const R = new Float32Array(Q);
  for (let i = 0; i < 200; i++) e.process(L, Q, R);
  const n = Math.round((seconds * SR) / Q);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) e.process(L, Q, R);
  return (performance.now() - t0) / n;
}

describe('CPU budget', () => {
  it('8 Synth voices at 48 kHz take well under a render quantum', () => {
    const budget = (Q / SR) * 1000;
    const ms = msPerQuantum(benchEngine());
    console.log(`[bench] 8 Synth voices @48 kHz: ${(ms * 1000).toFixed(1)} µs per 128-sample quantum = ${((ms / budget) * 100).toFixed(1)}% of real time`);
    expect(ms).toBeLessThan(budget * 0.5);
  });
});
