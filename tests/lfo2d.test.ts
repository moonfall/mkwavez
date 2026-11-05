import { describe, expect, it } from 'vitest';
import { SynthEngine } from '../src/core/engine/engine';
import type { SynthVoice } from '../src/core/engine/synthVoice';
import { generateBasic } from '../src/core/generators';
import { buildMipSet } from '../src/core/mipmap';
import { DEFAULT_LFO, isPeriodicShape, isRandomShape, LFO_SHAPES, lfoWave, lfoWaveY, type LfoParams, type ModSlot } from '../src/core/modulation';
import { DEFAULT_SYNTH, lfoPath, normalizeSynth, type SynthParams } from '../src/core/synth';
import { DEFAULT_VOICE, type VoiceParams } from '../src/core/voice';
import { packIds } from '../src/core/wavetablePlayback';

const phases = Array.from({ length: 40 }, (_, i) => i / 40);

describe('LFO Y outputs and 2D path shapes', () => {
  it('periodic shapes: Y is the wave a quarter cycle on (sine → a circle)', () => {
    for (const ph of phases) {
      const x = lfoWave('sine', ph);
      const y = lfoWaveY('sine', ph);
      expect(x * x + y * y).toBeCloseTo(1, 12);
      expect(lfoWaveY('saw', ph)).toBeCloseTo(lfoWave('saw', (ph + 0.25) % 1), 12);
    }
  });

  it('figure 8, Lissajous 3:2, square path', () => {
    for (const ph of phases) {
      expect(lfoWaveY('fig8', ph)).toBeCloseTo(Math.sin(4 * Math.PI * ph), 12);
      expect(lfoWave('lissajous', ph)).toBeCloseTo(Math.sin(6 * Math.PI * ph), 12);
      expect(lfoWaveY('lissajous', ph)).toBeCloseTo(Math.sin(4 * Math.PI * ph), 12);
      // The square path stays on the rectangle's edges.
      const x = lfoWave('squarePath', ph);
      const y = lfoWaveY('squarePath', ph);
      expect(Math.max(Math.abs(x), Math.abs(y))).toBeCloseTo(1, 12);
    }
    expect([lfoWave('squarePath', 0), lfoWaveY('squarePath', 0)]).toEqual([-1, -1]);
    expect([lfoWave('squarePath', 0.5), lfoWaveY('squarePath', 0.5)]).toEqual([1, 1]);
  });

  it('random walk: X and Y are separate smooth randoms; S&H / smooth random give X again', () => {
    expect(lfoWave('walk', 1, 0.7, -0.3)).toBeCloseTo(0.7, 12);
    expect(lfoWaveY('walk', 1, 0.7, -0.3, 0.4, -0.6)).toBeCloseTo(0.4, 12);
    expect(lfoWaveY('sh', 0.3, 0.7, -0.3)).toBe(0.7);
    expect(isRandomShape('walk') && !isPeriodicShape('walk')).toBe(true);
    expect(LFO_SHAPES.filter(isRandomShape)).toEqual(['sh', 'smooth', 'walk']);
  });
});

// ---- engine ----

const SR = 48000;
function engine(synth: Partial<SynthParams>): SynthEngine {
  const e = new SynthEngine(SR);
  (['sine', 'saw', 'square', 'tri'] as const).forEach((w, i) => e.addTable(i + 1, buildMipSet(generateBasic(w, 0).data)));
  e.setWavetable(0, { ...packIds([1, 2, 3, 4]), shape: '2d', rowStart: new Int32Array([0, 2, 4]) } as never);
  const v: VoiceParams = { ...DEFAULT_VOICE, id: 1, name: 'V1', type: 'synth', windowEnd: 1, windowEndY: 1, position: 0.5, positionY: 0.5, sustain: 1, synth: normalizeSynth({ ...DEFAULT_SYNTH, poly: 1, ...synth }) };
  e.setVoice(v);
  return e;
}
const syn = (e: SynthEngine) => (e as unknown as { voices: { syn: SynthVoice }[] }).voices[0].syn;
const lfo1 = (l: Partial<LfoParams>): LfoParams[] => [{ ...DEFAULT_LFO, ...l }, DEFAULT_LFO, DEFAULT_LFO];

describe('2D LFOs in the Synth voice', () => {
  it('LFO Y is a matrix source: figure 8 moves osc A over X and Y', () => {
    const mods: ModSlot[] = [
      { src: 'lfo1', dst: 'posA', amt: 0.4 },
      { src: 'lfo1Y', dst: 'posYA', amt: 0.4 },
    ];
    const e = engine({ lfos: lfo1({ shape: 'fig8', rate: 4 }), mods });
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 57, velocity: 100 });
    const pts: [number, number][] = [];
    const L = new Float32Array(64);
    for (let b = 0; b < 300; b++) {
      e.process(L, 64, new Float32Array(64));
      const s = syn(e);
      pts.push([s.posA, s.posYA]);
    }
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.7);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.7);
    // Each output follows its own wave: X at the LFO's phase, Y at twice it.
    const s = syn(e);
    expect(s.lfoOutY[0]).toBeCloseTo(lfoWaveY('fig8', s.lfoPhase[0]), 9);
  });
});

describe('the pad path (lfoPath)', () => {
  const routes: ModSlot[] = [
    { src: 'lfo1', dst: 'posA', amt: 0.5 },
    { src: 'lfo1Y', dst: 'posYA', amt: 0.5 },
  ];
  it('traces the routed LFOs over one period of the slowest', () => {
    const p = lfoPath({ ...DEFAULT_SYNTH, lfos: lfo1({ shape: 'sine', rate: 2 }), mods: routes }, 'a', 120)!;
    expect(p.span).toBeCloseTo(0.5, 12);
    for (const t of [0, 0.1, 0.3]) {
      const [x, y] = p.at(t);
      expect(x * x + y * y).toBeCloseTo(0.25, 9); // a circle of radius 0.5
    }
  });

  it('is null without an LFO route to that oscillator, and leaves random shapes out', () => {
    expect(lfoPath({ ...DEFAULT_SYNTH, mods: routes }, 'b', 120)).toBeNull();
    expect(lfoPath({ ...DEFAULT_SYNTH, lfos: lfo1({ shape: 'walk' }), mods: routes }, 'a', 120)).toBeNull();
    expect(lfoPath({ ...DEFAULT_SYNTH, mods: [{ src: 'vel', dst: 'posA', amt: 1 }] }, 'a', 120)).toBeNull();
  });
});
