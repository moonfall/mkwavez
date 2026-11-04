import { describe, expect, it } from 'vitest';
import { AppModel } from '../src/app/model';
import { RESAMPLE_MAX_SEC, resampleVoice } from '../src/app/resample';
import { generateBasic } from '../src/core/generators';
import { cycleAt, detectPitch } from '../src/core/sample';

const peak = (x: ArrayLike<number>) => {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  return m;
};
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

describe('resample (offline voice render)', () => {
  it('renders a Simple voice holding a note: audible, at the note’s pitch, its cycle the table it plays', () => {
    const m = new AppModel(8);
    const [saw] = m.addTables([generateBasic('saw', 0)]);
    const v = m.addVoice({ windowStart: 0, windowEnd: 0, position: 0, lfoDepth: 0 })!;
    const take = resampleVoice(m, { voiceId: v.id, note: 57, seconds: 1 }, 'V resample')!;
    expect(take.name).toBe('V resample');
    expect(take.sampleRate).toBe(48000);
    expect(take.data.length).toBe(48000);
    expect(peak(take.data)).toBeGreaterThan(0.01);
    const p = detectPitch(take.data, 48000, 24000)!;
    expect(Math.abs(p.freq / 220 - 1)).toBeLessThan(2e-3);
    // Sustained part, many cycles averaged: the saw it plays (its level and envelope normalised away).
    const c = cycleAt(take, { at: 0.6, freq: 220, cents: 0, cycles: 8, align: 0, seam: 0 })!;
    expect(maxDiff(c.data, saw.data)).toBeLessThan(0.05);
    // The voice's octave applies, as when played.
    m.updateVoice(v.id, { octave: 1 });
    const up = resampleVoice(m, { voiceId: v.id, note: 57, seconds: 0.5 })!;
    expect(Math.abs(detectPitch(up.data, 48000, 12000)!.freq / 440 - 1)).toBeLessThan(2e-3);
  });

  it('renders a Synth voice (its own filter and envelope), even when muted; length is capped; unknown voices give nothing', () => {
    const m = new AppModel(8);
    m.addTables([generateBasic('saw', 0)]);
    const v = m.addVoice({ type: 'synth', mute: true })!;
    const take = resampleVoice(m, { voiceId: v.id, note: 48, seconds: 0.5 })!;
    expect(peak(take.data)).toBeGreaterThan(0.01);
    expect(Math.abs(detectPitch(take.data, 48000, 12000)!.freq / 130.81 - 1)).toBeLessThan(3e-3);
    expect(resampleVoice(m, { voiceId: v.id, note: 48, seconds: 999 })!.data.length).toBe(RESAMPLE_MAX_SEC * 48000);
    expect(resampleVoice(m, { voiceId: 99, note: 48, seconds: 1 })).toBeNull();
    // Deterministic: the same render twice is identical.
    const again = resampleVoice(m, { voiceId: v.id, note: 48, seconds: 0.5 })!;
    expect(again.data).toEqual(take.data);
  });
});
