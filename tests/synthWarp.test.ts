import { describe, expect, it } from 'vitest';
import { MASTER_GAIN, SynthEngine } from '../src/core/engine/engine';
import { fold, WARP_INDEX, warpOut, warpPhase, warpSpeed, type SynthVoice } from '../src/core/engine/synthVoice';
import { generateBasic } from '../src/core/generators';
import { buildMipSet } from '../src/core/mipmap';
import { DEFAULT_SYNTH, normalizeSynth, WARP_MODES, type SynthParams, type WarpMode } from '../src/core/synth';
import { DEFAULT_VOICE, type VoiceParams } from '../src/core/voice';
import { packIds } from '../src/core/wavetablePlayback';

const SR = 48000;

function engine(): SynthEngine {
  const e = new SynthEngine(SR);
  (['sine', 'saw', 'square', 'tri'] as const).forEach((w, i) => e.addTable(i + 1, buildMipSet(generateBasic(w, 0).data)));
  e.setWavetable(0, packIds([1, 2, 3, 4]));
  return e;
}

function voice(synth: Partial<SynthParams>, extra: Partial<VoiceParams> = {}): VoiceParams {
  return {
    ...DEFAULT_VOICE,
    id: 1,
    name: 'V1',
    type: 'synth',
    windowStart: 0,
    windowEnd: 0,
    sustain: 1,
    ...extra,
    synth: normalizeSynth({ ...DEFAULT_SYNTH, poly: 1, mods: [], cutoff: 20000, envAmount: 0, keyTrack: 0, velAmount: 0, resonance: 0, filterMode: 'lp12', ...synth }),
  };
}

function play(synth: Partial<SynthParams>, note = 57, frames = SR / 4, extra: Partial<VoiceParams> = {}): { L: Float32Array; e: SynthEngine } {
  const e = engine();
  e.setVoice(voice(synth, extra));
  e.applyMidi({ type: 'noteOn', voiceId: 1, note, velocity: 127 });
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let i = 0; i < frames; i += 128) e.process(L.subarray(i, i + 128), Math.min(128, frames - i), R.subarray(i, i + 128));
  return { L, e };
}

const syn = (e: SynthEngine) => (e as unknown as { voices: { syn: SynthVoice }[] }).voices[0].syn;
const tail = (x: Float32Array) => x.subarray(x.length >> 1);
/** Mean squared first difference over power: a brightness measure. */
function hf(x: Float32Array): number {
  let d = 0;
  let p = 0;
  for (let i = 1; i < x.length; i++) {
    d += (x[i] - x[i - 1]) ** 2;
    p += x[i] * x[i];
  }
  return d / p;
}
const MODES = WARP_MODES.filter((m) => m !== 'none') as Exclude<WarpMode, 'none'>[];

describe('warp functions', () => {
  it('amount 0 is the identity for every mode', () => {
    for (const m of MODES) {
      const k = WARP_INDEX[m];
      for (let i = 0; i < 200; i++) {
        const ph = i / 200;
        expect(warpPhase(k, ph, 0)).toBe(ph);
        expect(warpOut(k, 0.37, ph, 0)).toBe(0.37);
      }
      expect(warpSpeed(k, 0)).toBe(1);
    }
  });

  it('remapped phases stay in [0, 1); bend and squeeze are monotonic and fix the ends', () => {
    for (const m of MODES) {
      for (const a of [-1, -0.5, 0.3, 1]) {
        let prev = -1;
        for (let i = 0; i < 1000; i++) {
          const ph = i / 1000;
          const q = warpPhase(WARP_INDEX[m], ph, a);
          expect(q).toBeGreaterThanOrEqual(0);
          expect(q).toBeLessThan(1);
          if (m === 'bend' || m === 'squeeze') {
            expect(q).toBeGreaterThanOrEqual(prev);
            prev = q;
          }
        }
        if (m === 'bend' || m === 'squeeze') {
          expect(warpPhase(WARP_INDEX[m], 0, a)).toBe(0);
          expect(warpPhase(WARP_INDEX[m], 0.999999, a)).toBeCloseTo(1, 4);
        }
      }
    }
  });

  it('fold is the identity inside ±1 and folds back outside it', () => {
    for (const x of [-1, -0.4, 0, 0.7, 1]) expect(fold(x)).toBeCloseTo(x, 12);
    expect(fold(1.5)).toBeCloseTo(0.5, 12);
    expect(fold(-1.25)).toBeCloseTo(-0.75, 12);
    for (let x = -20; x < 20; x += 0.37) expect(Math.abs(fold(x))).toBeLessThanOrEqual(1);
  });

  it('the speed-up (for the mip level) is symmetric in the amount', () => {
    for (const m of MODES) for (const a of [0.2, 0.9]) expect(warpSpeed(WARP_INDEX[m], -a)).toBe(warpSpeed(WARP_INDEX[m], a));
  });
});

describe('warp in the Synth voice', () => {
  it('a warp at amount 0 sounds exactly like no warp', () => {
    const base = play({}).L;
    for (const aWarp of MODES) expect(play({ aWarp, aWarpAmt: 0 }).L).toEqual(base);
  });

  it('every mode changes the sound, stays finite and bounded', () => {
    const base = play({}, 57, SR / 4, { windowStart: 0, windowEnd: 0 }).L;
    for (const aWarp of MODES) {
      for (const aWarpAmt of [-0.8, 0.8]) {
        const { L } = play({ aWarp, aWarpAmt });
        let d = 0;
        for (let i = 0; i < L.length; i++) d += Math.abs(L[i] - base[i]);
        expect(d / L.length).toBeGreaterThan(1e-3);
        expect(L.every((x) => Number.isFinite(x) && Math.abs(x) <= 2 * MASTER_GAIN)).toBe(true);
      }
    }
  });

  it('sync / formant / fold brighten a sine; the mip level follows the speed-up', () => {
    const dry = hf(tail(play({}).L));
    for (const aWarp of ['sync', 'formant', 'fold'] as const) expect(hf(tail(play({ aWarp, aWarpAmt: 0.8 }).L))).toBeGreaterThan(dry * 3);
    // A high note: sync at full amount reads the table 8× faster, so it uses a poorer mip level.
    const plain = syn(play({}, 96, 2048).e).a.mipLevel;
    const synced = syn(play({ aWarp: 'sync', aWarpAmt: 1 }, 96, 2048).e).a.mipLevel;
    expect(synced).toBeGreaterThan(plain);
  });

  it('the warp amount is a matrix destination (per oscillator)', () => {
    const still = play({ aWarp: 'bend', aWarpAmt: 0.2 }).L;
    const moved = play({ aWarp: 'bend', aWarpAmt: 0.2, mods: [{ src: 'vel', dst: 'warpA', amt: 0.6 }] }).L;
    expect(moved).not.toEqual(still);
    const bOnly = play({ aWarp: 'bend', aWarpAmt: 0.2, mods: [{ src: 'vel', dst: 'warpB', amt: 0.6 }] }).L;
    expect(bOnly).toEqual(still); // osc B is silent here
  });

  it('osc B’s warp shapes it as A’s FM source too', () => {
    const b = { ...DEFAULT_SYNTH.b, windowStart: 0, windowEnd: 0 };
    const plain = play({ b, fm: 0.4 }).L;
    const warped = play({ b, fm: 0.4, bWarp: 'squeeze', bWarpAmt: 0.8 }).L;
    expect(warped).not.toEqual(plain);
  });

  it('warp names are validated from saved data', () => {
    const s = normalizeSynth({ aWarp: 'fold', aWarpAmt: 3, bWarp: 'nope' });
    expect([s.aWarp, s.aWarpAmt, s.bWarp, s.bWarpAmt]).toEqual(['fold', 1, 'none', 0]);
  });
});
