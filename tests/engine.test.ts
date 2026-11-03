import { describe, expect, it } from 'vitest';
import { Adsr } from '../src/core/engine/adsr';
import { CROSSFADE_SEC, emptyStatus, SynthEngine } from '../src/core/engine/engine';
import { generateBasic } from '../src/core/generators';
import { buildMipSet } from '../src/core/mipmap';
import { emptySteps, type SequenceData } from '../src/core/sequence';
import { DEFAULT_VOICE, type VoiceParams } from '../src/core/voice';
import { make2D, makeRows, type Interp } from '../src/core/wavetable';
import { packIds, packWavetable } from '../src/core/wavetablePlayback';

const SR = 48000;

function setup(interp: Interp = 'blend') {
  const e = new SynthEngine(SR);
  const waves = ['sine', 'saw', 'square'] as const;
  waves.forEach((w, i) => e.addTable(i + 1, buildMipSet(generateBasic(w, 0).data)));
  e.setWavetable(0, packIds([1, 2, 3], interp));
  const voice: VoiceParams = { ...DEFAULT_VOICE, id: 1, name: 'V1', windowStart: 0, windowEnd: 2 };
  e.setVoice(voice);
  const steps = emptySteps();
  steps[0] = 0;
  steps[4] = 3;
  const seq: SequenceData = { id: 1, voiceId: 1, length: 8, steps, gate: 0.5, stepLength: '1/8' };
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
    expect(st.tick).toBeGreaterThanOrEqual(6);
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
  function pair(interp: Interp) {
    const mk = () => {
      const e = new SynthEngine(SR);
      (['sine', 'saw', 'square', 'tri'] as const).forEach((w, i) => e.addTable(i + 1, buildMipSet(generateBasic(w, 0).data)));
      e.setWavetable(0, packIds([1, 2, 3, 4], interp));
      e.setVoice({ ...DEFAULT_VOICE, id: 1, name: 'V1', windowStart: 1, windowEnd: 3, lfoRate: 3, lfoDepth: 1, sustain: 1 });
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
      b.setWavetable(0, packIds([2, 3, 4], interp));
      b.setVoice({ ...DEFAULT_VOICE, id: 1, name: 'V1', windowStart: 0, windowEnd: 2, lfoRate: 3, lfoDepth: 1, sustain: 1 });
      expect(render(b, 8192)).toEqual(render(a, 8192));
    });
  }

  it('step mode keeps the held table until the phase wraps, even if the window moves', () => {
    const [a, b] = pair('step');
    render(a, 1000);
    render(b, 1000);
    // Point b at a different table mid-cycle: the rest of the current cycle must match a.
    b.setVoice({ ...DEFAULT_VOICE, id: 1, name: 'V1', windowStart: 0, windowEnd: 0, lfoRate: 3, lfoDepth: 1, sustain: 1 });
    const oa = render(a, 40);
    const ob = render(b, 40); // 220 Hz cycle = ~218 samples; 40 samples stay within it only if not at a wrap
    expect(ob).toEqual(oa);
  });

  it('a missing table holds the previous one instead of going silent', () => {
    const e = setup();
    e.setTransport(true, 132);
    render(e, 2048);
    e.setWavetable(0, packIds([99, 98, 97]));
    const out = render(e, 2048);
    expect(rms(out)).toBeGreaterThan(0.01);
  });

  it('removeVoice fades out (no click) and then frees the voice', () => {
    const e = new SynthEngine(SR);
    e.addTable(1, buildMipSet(generateBasic('sine', 0).data));
    e.setWavetable(0, packIds([1]));
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

describe('SynthEngine on 2D / Rows wavetables', () => {
  const WAVES = ['sine', 'saw', 'square', 'tri'] as const;
  const still = { lfoDepth: 0, lfoDepthY: 0, sustain: 1, attack: 0.001, level: 1 };
  /** An engine with tables 1..4 and a voice on wavetable 0 holding one note. */
  function eng(wt: Parameters<SynthEngine['setWavetable']>[1], patch: Partial<VoiceParams>) {
    const e = new SynthEngine(SR);
    WAVES.forEach((w, i) => e.addTable(i + 1, buildMipSet(generateBasic(w, 0).data)));
    e.setWavetable(0, wt);
    e.setVoice({ ...DEFAULT_VOICE, id: 1, name: 'V1', ...still, ...patch });
    e.noteOn(1, 220, SR * 10);
    return e;
  }

  it('2D Blend output is the bilinear mix of the four cells', () => {
    const grid = packWavetable(make2D(0, 'g', 2, 2, [1, 2, 3, 4]));
    const [px, py] = [0.3, 0.8];
    const out = render(eng(grid, { windowEnd: 1, windowEndY: 1, position: px, positionY: py }), 4096);
    const weights = [(1 - px) * (1 - py), px * (1 - py), (1 - px) * py, px * py];
    const ref = new Float64Array(4096);
    weights.forEach((w, k) => {
      const one = render(eng(packIds([k + 1]), {}), 4096);
      for (let i = 0; i < ref.length; i++) ref[i] += w * one[i];
    });
    let err = 0;
    for (let i = 0; i < ref.length; i++) err = Math.max(err, Math.abs(out[i] - ref[i]));
    expect(rms(out)).toBeGreaterThan(0.01);
    expect(err).toBeLessThan(1e-6);
    const st = eng(grid, { windowEnd: 1, windowEndY: 1, position: px, positionY: py }).status(emptyStatus());
    expect(st.voices[0].index).toBeCloseTo(px);
    expect(st.voices[0].y).toBeCloseTo(py);
  });

  it('Rows Blend aligns positions proportionally between rows', () => {
    // Row 0: sine, saw, square; row 1: tri. u = 0.5 → saw (row 0), tri (row 1).
    const rows = packWavetable(makeRows(0, 'r', [[1, 2, 3], [4]]));
    const out = render(eng(rows, { windowStartY: 0, windowEndY: 1, position: 0.5, positionY: 0.25 }), 2048);
    const saw = render(eng(packIds([2]), {}), 2048);
    const tri = render(eng(packIds([4]), {}), 2048);
    let err = 0;
    for (let i = 0; i < out.length; i++) err = Math.max(err, Math.abs(out[i] - (0.75 * saw[i] + 0.25 * tri[i])));
    expect(err).toBeLessThan(1e-6);
  });

  it('2D Step plays one cell and switches only on the phase wrap', () => {
    const grid = packWavetable(make2D(0, 'g', 2, 2, [1, 2, 3, 4], { interp: 'step' }));
    const p = { windowEnd: 1, windowEndY: 1, position: 0, positionY: 0 };
    const a = eng(grid, p);
    const b = eng(grid, p);
    const sine = eng(packIds([1]), {});
    expect(render(a, 1000)).toEqual(render(sine, 1000));
    render(b, 1000);
    // Move b's position to the far cell (tri) mid-cycle: unchanged until the wrap.
    b.setVoice({ ...DEFAULT_VOICE, id: 1, name: 'V1', ...still, ...p, position: 1, positionY: 1 });
    const cycle = SR / 220;
    const phase0 = (1000 * 220) / SR - Math.floor((1000 * 220) / SR);
    const toWrap = Math.floor((1 - phase0) * cycle);
    const oa = render(a, toWrap - 1);
    const ob = render(b, toWrap - 1);
    expect(ob).toEqual(oa);
    // After a wrap (the target is picked up at the next control block) b plays the tri cell.
    render(a, 400);
    const after = render(b, 400);
    const sq = eng(packIds([4]), {});
    render(sq, 1000 + toWrap - 1);
    const sqOut = render(sq, 400);
    let err = 0;
    for (let i = 300; i < 400; i++) err = Math.max(err, Math.abs(after[i] - sqOut[i]));
    expect(err).toBeLessThan(1e-6);
  });

  /** Largest sample-to-sample step. */
  const maxStep = (x: Float32Array) => {
    let m = 0;
    for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
    return m;
  };

  for (const change of ['window', 'table', 'wavetable'] as const) {
    it(`a ${change} change crossfades (no discontinuity)`, () => {
      // Two tables in antiphase: a hard switch would jump by up to twice the amplitude.
      const sin = new Float32Array(2048).map((_, i) => Math.sin((2 * Math.PI * i) / 2048));
      const neg = sin.map((v) => -v);
      const e = new SynthEngine(SR);
      e.addTable(1, buildMipSet(sin));
      e.addTable(2, buildMipSet(neg));
      e.setWavetable(0, packWavetable(make2D(0, 'g', 2, 2, [1, 2, 1, 2])));
      e.setWavetable(5, packIds([2]));
      e.setVoice({ ...DEFAULT_VOICE, id: 1, name: 'V1', ...still, windowEnd: 1, windowEndY: 1, position: 0, positionY: 0 });
      e.noteOn(1, 110, SR * 10);
      const before = render(e, 4096 + 100); // ~ a sine peak region
      if (change === 'window') e.setVoice({ ...DEFAULT_VOICE, id: 1, name: 'V1', ...still, windowStart: 1, windowEnd: 1, windowEndY: 1, position: 0, positionY: 0 });
      else if (change === 'table') e.setWavetable(0, packWavetable(make2D(0, 'g', 2, 2, [2, 2, 2, 2])));
      else e.setVoice({ ...DEFAULT_VOICE, id: 1, name: 'V1', ...still, wavetableId: 5 });
      const after = render(e, 2048);
      const amp = Math.max(...before.map(Math.abs));
      const joined = new Float32Array(before.length + after.length);
      joined.set(before);
      joined.set(after, before.length);
      expect(maxStep(joined)).toBeLessThan(maxStep(before) * 2 + (2 * amp) / 50);
      // It did switch: the output is now inverted relative to the continued sine.
      const ref = new SynthEngine(SR);
      ref.addTable(1, buildMipSet(sin));
      ref.setWavetable(0, packIds([1]));
      ref.setVoice({ ...DEFAULT_VOICE, id: 1, name: 'V1', ...still });
      ref.noteOn(1, 110, SR * 10);
      render(ref, before.length);
      const r = render(ref, 2048);
      // The crossfade lasts ~CROSSFADE_SEC: after = (1 − 2c)·r, c ramping 0 → 1.
      const c = (i: number) => {
        let j = i;
        while (Math.abs(r[j]) < 0.05) j++;
        return (1 - after[j] / r[j]) / 2;
      };
      const ms = (t: number) => Math.round((t * SR) / 1000);
      expect(c(ms(1))).toBeGreaterThan(0.05);
      expect(c(ms(1))).toBeLessThan(0.4);
      expect(c(ms(3.5))).toBeLessThan(0.8);
      expect(c(ms(CROSSFADE_SEC * 1000 + 1.5))).toBeCloseTo(1, 5);
      for (let i = ms(8); i < 2048; i += 97) expect(after[i]).toBeCloseTo(-r[i], 5);
    });
  }

  it('Blend → Step on a sounding voice waits for the phase wrap', () => {
    const p = { windowEnd: 1, windowEndY: 1, position: 0.3, positionY: 0.6 };
    const blend = packWavetable(make2D(0, 'g', 2, 2, [1, 2, 3, 4]));
    const step = packWavetable(make2D(0, 'g', 2, 2, [1, 2, 3, 4], { interp: 'step' }));
    const a = eng(blend, p);
    const b = eng(blend, p);
    render(a, 1000);
    render(b, 1000);
    b.setWavetable(0, step);
    const phase0 = (1000 * 220) / SR - Math.floor((1000 * 220) / SR);
    const toWrap = Math.floor((1 - phase0) * (SR / 220));
    expect(render(b, toWrap - 1)).toEqual(render(a, toWrap - 1));
    // After the wrap: one cell (the nearest: x 0, y 1 → id 3 = square).
    render(b, 300);
    const out = render(b, 200);
    const sq = eng(packIds([3]), {});
    render(sq, 1000 + toWrap - 1 + 300);
    const ref = render(sq, 200);
    let err = 0;
    for (let i = 0; i < 200; i++) err = Math.max(err, Math.abs(out[i] - ref[i]));
    expect(err).toBeLessThan(1e-6);
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
