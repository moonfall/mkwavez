import { describe, expect, it } from 'vitest';
import {
  applyMatrix,
  DEFAULT_LFO,
  DST_INDEX,
  LFO_DIV_BEATS,
  LFO_DIVS,
  LFO_SHAPES,
  lfoRateHz,
  lfoWave,
  MOD_DESTS,
  MOD_SOURCES,
  N_DESTS,
  N_SOURCES,
  reflect01,
  SRC_INDEX,
  type LfoParams,
  type ModSlot,
} from '../src/core/modulation';
import { SynthEngine } from '../src/core/engine/engine';
import { pitchFreq, SynthVoice, type SynthControl } from '../src/core/engine/synthVoice';
import { generateBasic } from '../src/core/generators';
import { assignCc, ccPatch, DEFAULT_CC_MAP, MidiRouter, parseMidi } from '../src/core/midi';
import { buildMipSet } from '../src/core/mipmap';
import { DEFAULT_SYNTH, normalizeSynth, type SynthParams } from '../src/core/synth';
import { DEFAULT_VOICE, type VoiceParams } from '../src/core/voice';
import { packIds } from '../src/core/wavetablePlayback';

describe('LFO shapes', () => {
  it('periodic shapes hit their landmarks and stay within ±1', () => {
    expect(lfoWave('sine', 0.25)).toBeCloseTo(1, 12);
    expect(lfoWave('tri', 0)).toBe(0);
    expect(lfoWave('tri', 0.25)).toBe(1);
    expect(lfoWave('tri', 0.75)).toBe(-1);
    expect(lfoWave('saw', 0)).toBe(-1);
    expect(lfoWave('saw', 0.999)).toBeCloseTo(0.998, 6);
    expect(lfoWave('square', 0.1)).toBe(1);
    expect(lfoWave('square', 0.6)).toBe(-1);
    for (const s of LFO_SHAPES) {
      for (let i = 0; i < 100; i++) {
        const v = lfoWave(s, i / 100, 0.8, -0.3);
        expect(Math.abs(v)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('S&H holds the cycle’s value; smooth random glides from the previous one to it', () => {
    expect(lfoWave('sh', 0.1, 0.4, -0.9)).toBe(0.4);
    expect(lfoWave('sh', 0.9, 0.4, -0.9)).toBe(0.4);
    expect(lfoWave('smooth', 0, 0.4, -0.9)).toBe(-0.9);
    expect(lfoWave('smooth', 1, 0.4, -0.9)).toBeCloseTo(0.4, 12);
    expect(lfoWave('smooth', 0.5, 0.4, -0.9)).toBeCloseTo(-0.25, 12);
  });

  it('tempo sync: one cycle per division at the BPM', () => {
    const l = { ...DEFAULT_LFO, sync: true, div: '1/4' as const };
    expect(lfoRateHz(l, 120)).toBe(2);
    expect(lfoRateHz({ ...l, div: '1/1' }, 120)).toBe(0.5);
    expect(lfoRateHz({ ...l, div: '1/8T' }, 120)).toBeCloseTo(6, 12);
    expect(lfoRateHz({ ...l, div: '1/4D' }, 90)).toBeCloseTo(1, 12);
    expect(lfoRateHz({ ...l, sync: false, rate: 3.3 }, 120)).toBe(3.3);
    for (const d of LFO_DIVS) expect(LFO_DIV_BEATS[d]).toBeGreaterThan(0);
  });
});

describe('mod matrix', () => {
  it('sums amount × source per destination; empty / zero slots do nothing', () => {
    const src = new Float64Array(N_SOURCES);
    src[SRC_INDEX.lfo1] = 0.5;
    src[SRC_INDEX.vel] = 1;
    src[SRC_INDEX.key] = -0.25;
    const slots: ModSlot[] = [
      { src: 'lfo1', dst: 'cutoff', amt: 0.4 },
      { src: 'vel', dst: 'cutoff', amt: -0.1 },
      { src: 'key', dst: 'pan', amt: 1 },
      { src: 'none', dst: 'pan', amt: 1 },
      { src: 'lfo1', dst: 'none', amt: 1 },
      { src: 'vel', dst: 'amp', amt: 0 },
    ];
    const dst = new Float64Array(N_DESTS).fill(9);
    applyMatrix(slots, src, dst);
    expect(dst[DST_INDEX.cutoff]).toBeCloseTo(0.2 - 0.1, 12);
    expect(dst[DST_INDEX.pan]).toBe(-0.25);
    expect(dst[DST_INDEX.amp]).toBe(0);
    expect([...dst].filter((x) => x !== 0).length).toBe(2);
  });

  it('every source and destination has an index', () => {
    MOD_SOURCES.forEach((s, i) => expect(SRC_INDEX[s]).toBe(i));
    MOD_DESTS.forEach((d, i) => expect(DST_INDEX[d]).toBe(i));
  });

  it('positions reflect back into [0, 1]', () => {
    expect(reflect01(0.3)).toBe(0.3);
    expect(reflect01(-0.2)).toBe(0.2);
    expect(reflect01(1.25)).toBe(0.75);
    expect(reflect01(9)).toBe(0);
  });
});

// ---- in the Synth voice ----

const SR = 48000;
const BLOCK = 64;
const tables = new Map();
const ctl = (o: Partial<SynthControl> = {}): SynthControl => ({
  bend: 0,
  blockLen: BLOCK,
  tables,
  wtA: undefined,
  wtB: undefined,
  slew: 0.1,
  glideCoef: () => 1,
  gainTarget: 1,
  bpm: 120,
  wheel: 0,
  pressure: 0,
  ...o,
});
const voice = (synth: Partial<SynthParams>, id = 1): VoiceParams => ({
  ...DEFAULT_VOICE,
  id,
  name: `V${id}`,
  type: 'synth',
  synth: normalizeSynth({ ...DEFAULT_SYNTH, mods: [], ...synth }),
});
const lfos = (l0: Partial<LfoParams>, l1: Partial<LfoParams> = {}, l2: Partial<LfoParams> = {}) => [
  { ...DEFAULT_LFO, ...l0 },
  { ...DEFAULT_LFO, ...l1 },
  { ...DEFAULT_LFO, ...l2 },
];

describe('LFOs and the matrix in the Synth voice', () => {
  it('an LFO routed to osc A pitch moves only A, by amount × 12 semitones', () => {
    const p = voice({ lfos: lfos({ shape: 'square', rate: 1 }), mods: [{ src: 'lfo1', dst: 'pitchA', amt: 0.5 }], bFine: 0 });
    const sv = new SynthVoice(SR, 1, BLOCK);
    sv.noteOn(p, 60, 1, false, true, false);
    sv.control(p, ctl());
    expect(sv.incA1 * SR).toBeCloseTo(pitchFreq(66), 6);
    expect(sv.incB1 * SR).toBeCloseTo(pitchFreq(60), 6);
    // Half a cycle later the square is low: −6 st.
    for (let t = 0; t < SR / 2; t += BLOCK) sv.control(p, ctl());
    expect(sv.incA1 * SR).toBeCloseTo(pitchFreq(54), 6);
  });

  it('tempo sync follows the BPM; free rate ignores it', () => {
    const p = voice({ lfos: lfos({ shape: 'saw', sync: true, div: '1/4' }, { shape: 'saw', rate: 1 }) });
    const sv = new SynthVoice(SR, 1, BLOCK);
    const n = Math.round((0.25 * SR) / BLOCK); // 0.25 s
    for (let i = 0; i < n; i++) sv.control(p, ctl({ bpm: 120 }));
    const t = (n * BLOCK) / SR;
    expect(sv.lfoPhase[0]).toBeCloseTo((2 * t) % 1, 9); // 2 Hz at 120 BPM
    expect(sv.lfoPhase[1]).toBeCloseTo(t % 1, 9);
  });

  it('retrigger restarts the LFO at its phase on a note; free-running ones continue', () => {
    const p = voice({ lfos: lfos({ retrig: true, phase: 0.25, rate: 1.3 }, { retrig: false, rate: 1.3 }) });
    const sv = new SynthVoice(SR, 1, BLOCK, [0.25, 0, 0]);
    for (let i = 0; i < 100; i++) sv.control(p, ctl());
    const free = sv.lfoPhase[1];
    sv.noteOn(p, 60, 1, false, true, true);
    expect(sv.lfoPhase[0]).toBe(0.25);
    expect(sv.lfoPhase[1]).toBe(free);
    // A legato note (no retrigger) doesn't restart it.
    sv.control(p, ctl());
    const ph = sv.lfoPhase[0];
    sv.noteOn(p, 62, 1, true, false, true);
    expect(sv.lfoPhase[0]).toBe(ph);
  });

  it('fade-in ramps the LFO from 0 to its depth after each note', () => {
    const p = voice({ lfos: lfos({ shape: 'square', rate: 0.1, fade: 0.5, depth: 0.8 }) });
    const sv = new SynthVoice(SR, 1, BLOCK);
    sv.noteOn(p, 60, 1, false, true, false);
    sv.control(p, ctl());
    expect(Math.abs(sv.lfoOut[0])).toBeLessThan(0.01);
    for (let t = 0; t < 0.25 * SR; t += BLOCK) sv.control(p, ctl());
    expect(sv.lfoOut[0]).toBeCloseTo(0.4, 1);
    for (let t = 0; t < 0.5 * SR; t += BLOCK) sv.control(p, ctl());
    expect(sv.lfoOut[0]).toBe(0.8);
  });

  it('S&H / smooth random are deterministic per voice (seeded) and hold within a cycle', () => {
    const run = (id: number) => {
      const p = voice({ lfos: lfos({ shape: 'sh', rate: 10 }, { shape: 'smooth', rate: 7 }) }, id);
      const sv = new SynthVoice(SR, id, BLOCK);
      const out: number[] = [];
      for (let i = 0; i < 2000; i++) {
        sv.control(p, ctl());
        out.push(sv.lfoOut[0], sv.lfoOut[1]);
      }
      return out;
    };
    const a = run(1);
    expect(run(1)).toEqual(a);
    expect(run(2)).not.toEqual(a);
    const sh = a.filter((_, i) => i % 2 === 0);
    expect(new Set(sh).size).toBeGreaterThan(20);
    expect(new Set(sh).size).toBeLessThan(100); // ~10 values / s for 2.7 s
    expect(sh.every((x) => x >= -1 && x <= 1)).toBe(true);
  });

  it('per-note random, velocity, key, wheel and aftertouch feed the matrix', () => {
    const p = voice({
      mods: [
        { src: 'wheel', dst: 'cutoff', amt: 1 },
        { src: 'at', dst: 'pan', amt: -0.5 },
        { src: 'vel', dst: 'amp', amt: -1 },
        { src: 'key', dst: 'res', amt: 0.5 },
        { src: 'rand', dst: 'drive', amt: 1 },
      ],
    });
    const sv = new SynthVoice(SR, 1, BLOCK);
    sv.noteOn(p, 84, 0.5, false, true, false);
    sv.control(p, ctl({ wheel: 0.5, pressure: 1 }));
    expect(sv.dst[DST_INDEX.cutoff]).toBe(0.5);
    expect(sv.dst[DST_INDEX.pan]).toBe(-0.5);
    expect(sv.dst[DST_INDEX.amp]).toBe(-0.5);
    expect(sv.dst[DST_INDEX.res]).toBeCloseTo(0.5, 12); // key (84 − 60) / 24 = 1
    expect(Math.abs(sv.dst[DST_INDEX.drive])).toBeLessThanOrEqual(1);
    const r1 = sv.noteRand;
    sv.noteOn(p, 84, 0.5, false, true, true);
    expect(sv.noteRand).not.toBe(r1);
  });

  it('mod envelope: AD ignores the gate, ADSR follows it', () => {
    const ad = voice({ mMode: 'ad', mAttack: 0, mDecay: 0.2 });
    const sv = new SynthVoice(SR, 1, BLOCK);
    sv.noteOn(ad, 60, 1, false, true, false);
    sv.control(ad, ctl());
    expect(sv.src[SRC_INDEX.menv]).toBeGreaterThan(0.9);
    sv.gateOff(ad);
    for (let t = 0; t < 0.05 * SR; t += BLOCK) sv.control(ad, ctl());
    const mid = sv.src[SRC_INDEX.menv];
    expect(mid).toBeGreaterThan(0.2);
    const adsr = voice({ mMode: 'adsr', mAttack: 0, mDecay: 0.2, mSustain: 0.6, mRelease: 0.05 });
    const s2 = new SynthVoice(SR, 1, BLOCK);
    s2.noteOn(adsr, 60, 1, false, true, false);
    for (let t = 0; t < 0.5 * SR; t += BLOCK) s2.control(adsr, ctl());
    expect(s2.src[SRC_INDEX.menv]).toBeCloseTo(0.6, 2);
    s2.gateOff(adsr);
    for (let t = 0; t < 0.1 * SR; t += BLOCK) s2.control(adsr, ctl());
    expect(s2.src[SRC_INDEX.menv]).toBeLessThan(0.05);
  });

  it('LFO rate destinations scale the rate (±4 octaves at amount 1)', () => {
    const p = voice({ lfos: lfos({ rate: 1 }, { shape: 'square', rate: 0.01 }), mods: [{ src: 'lfo2', dst: 'lfo1Rate', amt: 0.5 }] });
    const sv = new SynthVoice(SR, 1, BLOCK);
    sv.control(p, ctl());
    const p0 = sv.lfoPhase[0];
    sv.control(p, ctl());
    // lfo2 square = +1 → rate × 2^(0.5 × 4) = 4 Hz.
    expect(sv.lfoPhase[0] - p0).toBeCloseTo((4 * BLOCK) / SR, 9);
  });
});

describe('aftertouch and the mod wheel (MIDI)', () => {
  it('channel pressure is parsed and routed; CC 1 also feeds the matrix', () => {
    expect(parseMidi([0xd3, 64])).toEqual({ kind: 'pressure', channel: 4, value: 64 / 127 });
    const r = new MidiRouter();
    const routing = { omni: false, selectedVoice: null, voiceIds: [1, 2] };
    expect(r.route(parseMidi([0xd1, 127])!, routing)).toEqual([{ type: 'pressure', voiceId: 2, value: 1 }]);
    expect(r.route(parseMidi([0xd5, 127])!, routing)).toEqual([]);
    expect(r.route(parseMidi([0xb0, 1, 127])!, routing)).toEqual([
      { type: 'cc', voiceId: 1, cc: 1, value: 127 },
      { type: 'mod', voiceId: 1, value: 1 },
    ]);
  });

  it('the engine renders the wheel / pressure through the matrix', () => {
    const e = new SynthEngine(SR);
    e.addTable(1, buildMipSet(generateBasic('saw', 0).data));
    e.setWavetable(0, packIds([1]));
    e.setVoice({ ...voice({ cutoff: 150, envAmount: 0, keyTrack: 0, resonance: 0, mods: [{ src: 'wheel', dst: 'cutoff', amt: 1 }] }), sustain: 1 });
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 45, velocity: 127 });
    const hf = () => {
      const out = new Float32Array(SR / 4);
      for (let i = 0; i < out.length; i += 128) e.process(out.subarray(i, i + 128), 128);
      let s = 0;
      for (let i = out.length / 2; i < out.length; i++) s += (out[i] - out[i - 1]) ** 2;
      return s;
    };
    const dark = hf();
    e.applyMidi({ type: 'mod', voiceId: 1, value: 1 });
    expect(hf()).toBeGreaterThan(dark * 10);
  });

  it('LFO rate / depth controller targets change one LFO of the voice', () => {
    let map = assignCc(DEFAULT_CC_MAP, 'lfo2Rate', 20);
    map = assignCc(map, 'lfo2Depth', 21);
    const v = voice({ lfos: lfos({}, { sync: true, rate: 1, depth: 1 }) });
    expect(ccPatch(map, 20, 127)).toBeNull(); // needs the voice
    const p = ccPatch(map, 20, 127, v)!;
    expect(p.synth!.lfos![1]).toMatchObject({ rate: 20, sync: false, depth: 1 });
    expect(p.synth!.lfos![0]).toBe(v.synth.lfos[0]);
    expect(ccPatch(map, 21, 0, v)!.synth!.lfos![1].depth).toBe(0);
  });
});

describe('modulation params from untrusted data', () => {
  it('LFOs and matrix slots are validated: 3 LFOs, 8 slots, bad values → defaults / none', () => {
    const s = normalizeSynth({
      lfos: [{ shape: 'zigzag', rate: 1e6, sync: 'yes', div: '1/7', phase: -2, fade: 3, depth: 0.5 }, null],
      mods: [{ src: 'lfo2', dst: 'cutoff', amt: 4 }, { src: 'bogus', dst: 'pan', amt: 0.2 }, 7],
      mMode: 'xyz',
    });
    expect(s.lfos).toHaveLength(3);
    expect(s.lfos[0]).toEqual({ ...DEFAULT_SYNTH.lfos[0], rate: 40, phase: 0, fade: 3, depth: 0.5 });
    expect(s.lfos[1]).toEqual(DEFAULT_SYNTH.lfos[1]);
    expect(s.mods).toHaveLength(8);
    expect(s.mods[0]).toEqual({ src: 'lfo2', dst: 'cutoff', amt: 1 });
    expect(s.mods[1]).toEqual({ src: 'none', dst: 'pan', amt: 0.2 });
    expect(s.mods[2]).toEqual({ src: 'none', dst: 'none', amt: 0 });
    expect(s.mMode).toBe('ad');
    expect(normalizeSynth({}).mods).toEqual(DEFAULT_SYNTH.mods);
  });
});
