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

describe('SynthEngine robustness', () => {
  function pair(interp: 'blend' | 'step') {
    const mk = () => {
      const e = new SynthEngine(SR);
      (['sine', 'saw', 'square', 'tri'] as const).forEach((w, i) => e.addTable(i + 1, buildMipSet(generateBasic(w, 0).data)));
      e.setWavetable(0, Int32Array.from([1, 2, 3, 4]));
      e.setVoice({ ...DEFAULT_VOICE, id: 1, name: 'V1', windowStart: 1, windowEnd: 3, interp, lfoRate: 3, lfoDepth: 1, sustain: 1 });
      e.noteOn(1, 220, SR * 10);
      return e;
    };
    return [mk(), mk()] as const;
  }

  for (const interp of ['blend', 'step'] as const) {
    it(`${interp}: front eviction with remapped window does not change the output`, () => {
      const [a, b] = pair(interp);
      const oa = render(a, 4096);
      const ob = render(b, 4096);
      expect(ob).toEqual(oa);
      // Evict table 1 (index 0): wavetable re-indexes, window shifts by one (atomically).
      b.removeTables([1]);
      b.setWavetable(0, Int32Array.from([2, 3, 4]));
      b.setVoice({ ...DEFAULT_VOICE, id: 1, name: 'V1', windowStart: 0, windowEnd: 2, interp, lfoRate: 3, lfoDepth: 1, sustain: 1 });
      expect(render(b, 8192)).toEqual(render(a, 8192));
    });
  }

  it('step mode keeps the held table until the phase wraps, even if the window moves', () => {
    const [a, b] = pair('step');
    render(a, 1000);
    render(b, 1000);
    // Point b at a different table mid-cycle: the rest of the current cycle must match a.
    b.setVoice({ ...DEFAULT_VOICE, id: 1, name: 'V1', windowStart: 0, windowEnd: 0, interp: 'step', lfoRate: 3, lfoDepth: 1, sustain: 1 });
    const oa = render(a, 40);
    const ob = render(b, 40); // 220 Hz cycle = ~218 samples; 40 samples stay within it only if not at a wrap
    expect(ob).toEqual(oa);
  });

  it('a missing table holds the previous one instead of going silent', () => {
    const e = setup();
    e.setTransport(true, 132);
    render(e, 2048);
    e.setWavetable(0, Int32Array.from([99, 98, 97]));
    const out = render(e, 2048);
    expect(rms(out)).toBeGreaterThan(0.01);
  });

  it('removeVoice fades out (no click) and then frees the voice', () => {
    const e = new SynthEngine(SR);
    e.addTable(1, buildMipSet(generateBasic('sine', 0).data));
    e.setWavetable(0, Int32Array.from([1]));
    e.setVoice({ ...DEFAULT_VOICE, id: 1, name: 'V1', sustain: 1, level: 1 });
    e.noteOn(1, 110, SR);
    const before = render(e, SR / 4);
    e.removeVoice(1);
    const after = render(e, SR / 10);
    expect(Math.abs(after[0] - before[before.length - 1])).toBeLessThan(0.01); // sine step ~0.003
    expect(Math.abs(after[after.length - 1])).toBeLessThan(1e-4);
    expect(e.voiceCount).toBe(0);
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
