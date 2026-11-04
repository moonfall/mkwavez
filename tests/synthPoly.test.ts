import { describe, expect, it } from 'vitest';
import { emptyStatus, NOTE_POOL, SynthEngine } from '../src/core/engine/engine';
import { generateBasic } from '../src/core/generators';
import { buildMipSet } from '../src/core/mipmap';
import { DEFAULT_SYNTH, normalizeSynth, type SynthParams } from '../src/core/synth';
import { DEFAULT_VOICE, type VoiceParams } from '../src/core/voice';
import { packIds } from '../src/core/wavetablePlayback';

const SR = 48000;

function engine(): SynthEngine {
  const e = new SynthEngine(SR);
  (['sine', 'saw', 'square', 'tri'] as const).forEach((w, i) => e.addTable(i + 1, buildMipSet(generateBasic(w, 0).data)));
  e.setWavetable(0, packIds([1, 2, 3, 4]));
  return e;
}

/** A dry Synth voice (no matrix or envelopes on the filter) with overrides. */
function voice(id: number, synth: Partial<SynthParams>, extra: Partial<VoiceParams> = {}): VoiceParams {
  return {
    ...DEFAULT_VOICE,
    id,
    name: `V${id}`,
    type: 'synth',
    windowStart: 1,
    windowEnd: 1,
    attack: 0.002,
    sustain: 1,
    release: 0.05,
    ...extra,
    synth: normalizeSynth({ ...DEFAULT_SYNTH, mods: [], cutoff: 20000, envAmount: 0, keyTrack: 0, velAmount: 0, resonance: 0, filterMode: 'lp12', velAmp: 0, ...synth }),
  };
}

function render(e: SynthEngine, frames: number): [Float32Array, Float32Array] {
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let i = 0; i < frames; i += 128) {
    const n = Math.min(128, frames - i);
    e.process(L.subarray(i, i + n), n, R.subarray(i, i + n));
  }
  return [L, R];
}

type Pool = { owner: unknown; key: number; env: { stage: number } }[];
const pool = (e: SynthEngine) => (e as unknown as { pool: Pool }).pool;
/** Pool notes sounding (not idle). */
const poolActive = (e: SynthEngine) => pool(e).filter((n) => n.owner !== null && n.env.stage !== 0).length;
const on = (e: SynthEngine, id: number, note: number, velocity = 100) => e.applyMidi({ type: 'noteOn', voiceId: id, note, velocity });
const off = (e: SynthEngine, id: number, note: number) => e.applyMidi({ type: 'noteOff', voiceId: id, note });
const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

describe('polyphonic Synth voices', () => {
  it('a chord is the sum of its notes played alone', () => {
    const keys = [48, 55, 64];
    const chord = engine();
    chord.setVoice(voice(1, { poly: 4 }));
    for (const k of keys) on(chord, 1, k);
    const [L] = render(chord, SR / 8);
    const sum = new Float32Array(L.length);
    for (const k of keys) {
      const single = engine();
      single.setVoice(voice(1, { poly: 4 }));
      on(single, 1, k);
      const [S] = render(single, SR / 8);
      for (let n = 0; n < S.length; n++) sum[n] += S[n];
    }
    let err = 0;
    for (let n = 0; n < L.length; n++) err = Math.max(err, Math.abs(L[n] - sum[n]));
    expect(err).toBeLessThan(1e-5);
    expect(poolActive(chord)).toBe(2);
  });

  it('plays at most `poly` notes: the oldest held note is stolen', () => {
    const e = engine();
    e.setVoice(voice(1, { poly: 3 }));
    for (const k of [48, 52, 55]) on(e, 1, k);
    render(e, 256);
    expect(poolActive(e)).toBe(2);
    on(e, 1, 59);
    render(e, 256);
    expect(poolActive(e)).toBe(2);
    // 48 (the voice's own note, the oldest) now plays 59; releasing 48 changes nothing.
    off(e, 1, 48);
    render(e, SR / 4);
    expect(poolActive(e)).toBe(2);
    expect(e.status(emptyStatus()).voices[0].env).toBeGreaterThan(0.5);
  });

  it('a released note is stolen before a held one (the quietest first)', () => {
    const e = engine();
    e.setVoice(voice(1, { poly: 2 }, { release: 2 }));
    on(e, 1, 48);
    on(e, 1, 55);
    render(e, 512);
    off(e, 1, 55); // releasing (long release)
    render(e, 512);
    on(e, 1, 60); // takes 55's slot, 48 keeps sounding
    render(e, 512);
    const keys = pool(e).filter((n) => n.owner !== null).map((n) => n.key);
    expect(keys).toEqual([60]);
  });

  it('the same key again reuses its note (no stacking); release frees the pool', () => {
    const e = engine();
    e.setVoice(voice(1, { poly: 8 }));
    on(e, 1, 48);
    on(e, 1, 55);
    off(e, 1, 55);
    on(e, 1, 55);
    render(e, 256);
    expect(poolActive(e)).toBe(1);
    off(e, 1, 48);
    off(e, 1, 55);
    render(e, SR / 2);
    expect(pool(e).every((n) => n.owner === null)).toBe(true);
    const [L] = render(e, 512);
    expect(rms(L)).toBe(0);
  });

  it('note off releases only its own note', () => {
    const e = engine();
    e.setVoice(voice(1, { poly: 4 }));
    on(e, 1, 48);
    on(e, 1, 67);
    render(e, SR / 8);
    off(e, 1, 67);
    render(e, SR / 4);
    expect(poolActive(e)).toBe(0);
    expect(e.status(emptyStatus()).voices[0].env).toBeGreaterThan(0.9);
  });

  it('poly 1 stays monophonic (legato: no pool notes)', () => {
    const e = engine();
    e.setVoice(voice(1, { poly: 1 }));
    for (const k of [48, 52, 55]) on(e, 1, k);
    render(e, 512);
    expect(poolActive(e)).toBe(0);
  });

  it('the pool is shared and capped: NOTE_POOL extra notes across all voices', () => {
    const e = engine();
    for (let id = 1; id <= 8; id++) e.setVoice(voice(id, { poly: 8 }));
    for (let id = 1; id <= 8; id++) for (let k = 0; k < 8; k++) on(e, id, 40 + k * 3 + id);
    const [L] = render(e, 1024);
    expect(poolActive(e)).toBe(NOTE_POOL);
    expect(L.every(Number.isFinite)).toBe(true);
  });

  it('sequencer steps on a polyphonic voice overlap their release tails', () => {
    const e = engine();
    e.setVoice(voice(1, { poly: 4 }, { release: 1 }));
    e.setSequence({ id: 1, voiceId: 1, length: 4, steps: [0, 2, 4, 5, ...Array(60).fill(-1)], gate: 0.3, stepLength: '1/16' });
    e.setTransport(true, 240);
    render(e, SR / 2);
    expect(poolActive(e)).toBeGreaterThanOrEqual(2);
  });

  it('fewer notes (poly → 1), a switch to Simple and removal release the pool notes', () => {
    const e = engine();
    const v = voice(1, { poly: 4 });
    e.setVoice(v);
    for (const k of [48, 52, 55]) on(e, 1, k);
    render(e, 512);
    e.setVoice({ ...v, synth: { ...v.synth, poly: 1 } });
    render(e, SR / 2);
    expect(poolActive(e)).toBe(0);
    e.setVoice(v);
    for (const k of [60, 64]) on(e, 1, k);
    render(e, 512);
    e.setVoice({ ...v, type: 'simple' });
    render(e, SR / 2);
    expect(poolActive(e)).toBe(0);
    e.setVoice(v);
    for (const k of [67, 71]) on(e, 1, k);
    render(e, 512);
    e.removeVoice(1);
    render(e, SR / 4);
    expect(e.voiceCount).toBe(0);
    expect(pool(e).every((n) => n.owner === null)).toBe(true);
  });

  it('a key held while the voice becomes polyphonic still releases', () => {
    const e = engine();
    const v = voice(1, { poly: 1 });
    e.setVoice(v);
    on(e, 1, 48);
    render(e, 512);
    e.setVoice({ ...v, synth: { ...v.synth, poly: 4 } });
    on(e, 1, 55);
    off(e, 1, 48);
    off(e, 1, 55);
    render(e, SR / 2);
    expect(e.status(emptyStatus()).voices[0].env).toBe(0);
  });

  it('poly glide runs from the last note’s pitch', () => {
    const e = engine();
    e.setVoice(voice(1, { poly: 4, glide: 0.2, glideLegato: false }));
    on(e, 1, 48);
    render(e, 256);
    on(e, 1, 60);
    render(e, 64 * 4);
    const n = pool(e).find((x) => x.key === 60) as unknown as { syn: { pitch: number; target: number } };
    expect(n.syn.target).toBe(60);
    expect(n.syn.pitch).toBeGreaterThan(48);
    expect(n.syn.pitch).toBeLessThan(59);
  });

  it('the CPU guard counts every held note', () => {
    const e = engine();
    e.setVoice(voice(1, { poly: 8, aUnison: 4, bUnison: 4, bLevel: 0.5 }));
    for (let k = 0; k < 5; k++) on(e, 1, 48 + k * 4);
    render(e, 256);
    expect(e.status(emptyStatus()).unisonLimited).toBe(true);
  });
});
