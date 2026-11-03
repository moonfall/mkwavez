import { describe, expect, it } from 'vitest';
import { Adsr } from '../src/core/engine/adsr';
import { emptyStatus, SynthEngine } from '../src/core/engine/engine';
import { generateBasic } from '../src/core/generators';
import { buildMipSet } from '../src/core/mipmap';
import { emptySteps, type SequenceData } from '../src/core/sequence';
import { DEFAULT_VOICE, type VoiceParams } from '../src/core/voice';

const SR = 48000;

function setup(interp: 'blend' | 'step' = 'blend') {
  const e = new SynthEngine(SR);
  const waves = ['sine', 'saw', 'square'] as const;
  waves.forEach((w, i) => e.addTable(i + 1, buildMipSet(generateBasic(w, 0).data)));
  e.setWavetable(0, Int32Array.from([1, 2, 3]));
  const voice: VoiceParams = { ...DEFAULT_VOICE, id: 1, name: 'V1', windowStart: 0, windowEnd: 2, interp };
  e.setVoice(voice);
  const steps = emptySteps();
  steps[0] = 0;
  steps[4] = 3;
  const seq: SequenceData = { id: 1, voiceId: 1, length: 8, steps, gate: 0.5 };
  e.setSequence(seq);
  return e;
}

function render(e: SynthEngine, frames: number) {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 128) e.process(out.subarray(i, i + 128), Math.min(128, frames - i));
  return out;
}

const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

describe('SynthEngine', () => {
  it('is silent when stopped and plays when the transport runs', () => {
    const e = setup();
    expect(rms(render(e, 4096))).toBe(0);
    e.setTransport(true, 132);
    const out = render(e, SR / 2);
    expect(rms(out)).toBeGreaterThan(0.01);
    expect(out.every((v) => Number.isFinite(v) && Math.abs(v) <= 1)).toBe(true);
    const st = e.status(emptyStatus());
    expect(st.step).toBeGreaterThanOrEqual(1);
    expect(st.voices[0].index).toBeGreaterThanOrEqual(0);
    expect(st.voices[0].index).toBeLessThanOrEqual(2);
  });

  it('step mode renders and missing tables are tolerated', () => {
    const e = setup('step');
    e.removeTables([3]); // held index ~1 (position 0.5) still resolves
    e.setTransport(true, 140);
    const out = render(e, SR / 2);
    expect(out.every(Number.isFinite)).toBe(true);
    expect(rms(out)).toBeGreaterThan(0.001);
  });

  it('mute silences and stop releases', () => {
    const e = setup();
    e.setVoice({ ...DEFAULT_VOICE, id: 1, name: 'V1', windowEnd: 2, mute: true });
    e.setTransport(true, 132);
    render(e, SR); // let the gain smoother settle
    expect(rms(render(e, 4096))).toBeLessThan(1e-4);
    e.setVoice({ ...DEFAULT_VOICE, id: 1, name: 'V1', windowEnd: 2, sustain: 1, release: 0.01 });
    render(e, SR / 4);
    e.setTransport(false, 132);
    render(e, SR / 4);
    expect(rms(render(e, 4096))).toBeLessThan(1e-4);
  });
});

describe('Adsr', () => {
  it('attacks, decays to sustain, releases to zero', () => {
    const a = new Adsr();
    a.configure(0.01, 0.05, 0.5, 0.05, 1000);
    a.gateOn();
    let v = 0;
    for (let i = 0; i < 10; i++) v = a.next();
    expect(v).toBeCloseTo(1, 5);
    for (let i = 0; i < 200; i++) v = a.next();
    expect(v).toBeCloseTo(0.5, 3);
    a.gateOff();
    for (let i = 0; i < 1000; i++) v = a.next();
    expect(v).toBe(0);
  });
});
