import { describe, expect, it } from 'vitest';
import { SynthEngine } from '../src/core/engine/engine';
import type { SynthVoice } from '../src/core/engine/synthVoice';
import { generateBasic } from '../src/core/generators';
import { MidiRouter, MPE_BEND_RANGE, parseMidi, type MidiRouting } from '../src/core/midi';
import { buildMipSet } from '../src/core/mipmap';
import { DEFAULT_SYNTH, normalizeSynth, type SynthParams } from '../src/core/synth';
import { DEFAULT_VOICE, type VoiceParams } from '../src/core/voice';
import { packIds } from '../src/core/wavetablePlayback';

const MPE: MidiRouting = { omni: false, mpe: true, selectedVoice: 2, voiceIds: [1, 2, 3] };
const route = (r: MidiRouter, bytes: number[], routing: MidiRouting = MPE, source = 0) => r.route(parseMidi(bytes)!, routing, source);
const bend14 = (v: number) => {
  const x = Math.round(v * 8191) + 8192;
  return [x & 0x7f, x >> 7];
};

describe('MPE routing', () => {
  it('every channel plays the selected voice; channel 1 bends / presses the whole voice', () => {
    const r = new MidiRouter();
    expect(route(r, [0x93, 60, 100])).toEqual([{ type: 'noteOn', voiceId: 2, note: 60, velocity: 100 }]);
    expect(route(r, [0xe0, ...bend14(1)])).toEqual([{ type: 'bend', voiceId: 2, semitones: 2 }]);
    expect(route(r, [0xd0, 127])).toEqual([{ type: 'pressure', voiceId: 2, value: 1 }]);
  });

  it('a member channel bends, presses and slides only the notes it holds', () => {
    const r = new MidiRouter();
    route(r, [0x91, 60, 100]); // channel 2
    route(r, [0x92, 64, 100]); // channel 3
    const [lo, hi] = bend14(0.5);
    expect(route(r, [0xe1, lo, hi])).toEqual([{ type: 'noteBend', voiceId: 2, note: 60, semitones: (Math.round(0.5 * 8191) / 8191) * MPE_BEND_RANGE }]);
    expect(route(r, [0xd2, 127])).toEqual([{ type: 'notePressure', voiceId: 2, note: 64, value: 1 }]);
    // CC 74 on a member channel is the slide (not a mapped controller).
    expect(route(r, [0xb1, 74, 127])).toEqual([{ type: 'noteSlide', voiceId: 2, note: 60, value: 1 }]);
  });

  it('a note starts with the bend / pressure / slide its channel had before it', () => {
    const r = new MidiRouter();
    route(r, [0xe4, ...bend14(-0.25)]);
    route(r, [0xd4, 64]);
    const out = route(r, [0x94, 67, 90]);
    expect(out[0]).toEqual({ type: 'noteOn', voiceId: 2, note: 67, velocity: 90 });
    expect(out.map((e) => e.type)).toEqual(['noteOn', 'noteBend', 'notePressure']);
  });

  it('the bend range is a routing setting; CC 121 resets a member channel and its notes', () => {
    const r = new MidiRouter();
    route(r, [0x91, 60, 100]);
    expect(route(r, [0xe1, ...bend14(1)], { ...MPE, mpeBendRange: 24 })).toEqual([{ type: 'noteBend', voiceId: 2, note: 60, semitones: 24 }]);
    route(r, [0xd1, 100]);
    expect(route(r, [0xb1, 121, 0]).map((e) => e.type).sort()).toEqual(['noteBend', 'notePressure']);
    // Afterwards a new note on that channel starts plain.
    route(r, [0x81, 60, 0]);
    expect(route(r, [0x91, 62, 100]).map((e) => e.type)).toEqual(['noteOn']);
  });

  it('without MPE, channel N plays voice N and member messages are ordinary', () => {
    const r = new MidiRouter();
    const plain: MidiRouting = { omni: false, selectedVoice: 2, voiceIds: [1, 2, 3] };
    expect(route(r, [0x92, 60, 100], plain)).toEqual([{ type: 'noteOn', voiceId: 3, note: 60, velocity: 100 }]);
    expect(route(r, [0xe2, ...bend14(1)], plain)).toEqual([{ type: 'bend', voiceId: 3, semitones: 2 }]);
    expect(route(r, [0xb2, 74, 100], plain)).toEqual([{ type: 'cc', voiceId: 3, cc: 74, value: 100 }]);
  });

  it('polyphonic aftertouch reaches the voice its key went to (any mode, after a routing change too)', () => {
    const r = new MidiRouter();
    const omni: MidiRouting = { omni: true, selectedVoice: 1, voiceIds: [1, 2] };
    route(r, [0x90, 60, 100], omni);
    expect(route(r, [0xa0, 60, 127], { ...omni, selectedVoice: 2 })).toEqual([{ type: 'notePressure', voiceId: 1, note: 60, value: 1 }]);
    expect(route(r, [0xa0, 61, 127], omni)).toEqual([]); // not held
  });
});

// ---- engine ----

const SR = 48000;
function engine(synth: Partial<SynthParams>): SynthEngine {
  const e = new SynthEngine(SR);
  (['sine', 'saw', 'square', 'tri'] as const).forEach((w, i) => e.addTable(i + 1, buildMipSet(generateBasic(w, 0).data)));
  e.setWavetable(0, packIds([1, 2, 3, 4]));
  const v: VoiceParams = {
    ...DEFAULT_VOICE,
    id: 1,
    name: 'V1',
    type: 'synth',
    windowStart: 1,
    windowEnd: 1,
    sustain: 1,
    synth: normalizeSynth({ ...DEFAULT_SYNTH, mods: [], envAmount: 0, keyTrack: 0, velAmount: 0, cutoff: 400, ...synth }),
  };
  e.setVoice(v);
  return e;
}
function render(e: SynthEngine, frames: number): Float32Array {
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let i = 0; i < frames; i += 128) e.process(L.subarray(i, i + 128), Math.min(128, frames - i), R.subarray(i, i + 128));
  return L;
}
type Slot = { key: number; syn: SynthVoice };
const slots = (e: SynthEngine): Slot[] => {
  const x = e as unknown as { voices: Slot[]; pool: (Slot & { owner: unknown })[] };
  return [x.voices[0], ...x.pool.filter((n) => n.owner)];
};

describe('per-note expression in the engine', () => {
  it('note pressure is the aftertouch source of that note only (and takes over from lower channel pressure)', () => {
    const e = engine({ poly: 4, mods: [{ src: 'at', dst: 'cutoff', amt: 0.8 }] });
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 48, velocity: 100 });
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 55, velocity: 100 });
    render(e, 256);
    e.applyMidi({ type: 'notePressure', voiceId: 1, note: 55, value: 1 });
    e.applyMidi({ type: 'pressure', voiceId: 1, value: 0.25 });
    render(e, 256);
    const at = (k: number) => slots(e).find((s) => s.key === k)!.syn.src[8];
    expect(at(55)).toBe(1);
    expect(at(48)).toBe(0.25);
  });

  it('per-note bend moves that note’s pitch (smoothly), slide is a source', () => {
    const e = engine({ poly: 4 });
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 48, velocity: 100 });
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 60, velocity: 100 });
    render(e, 256);
    const syn = (k: number) => slots(e).find((s) => s.key === k)!.syn;
    const inc0 = syn(60).incA1;
    e.applyMidi({ type: 'noteBend', voiceId: 1, note: 60, semitones: 12 });
    e.applyMidi({ type: 'noteSlide', voiceId: 1, note: 48, value: 0.5 });
    render(e, SR / 10);
    expect(syn(60).incA1 / inc0).toBeCloseTo(2, 3);
    expect(syn(48).src[16]).toBe(0.5);
  });

  it('a note starts with the expression sent right after its note-on (no slide from the old value)', () => {
    const e = engine({ poly: 2 });
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 60, velocity: 100 });
    e.applyMidi({ type: 'noteBend', voiceId: 1, note: 60, semitones: 7 });
    render(e, 64);
    const s = slots(e).find((x) => x.key === 60)!.syn;
    expect(s.incA1).toBeCloseTo((440 * Math.pow(2, (67 - 69) / 12)) / SR, 9);
  });

  it('expression for a note that is not sounding is ignored; unmodulated output is unchanged', () => {
    const plain = engine({ poly: 2 });
    plain.applyMidi({ type: 'noteOn', voiceId: 1, note: 60, velocity: 100 });
    const a = render(plain, 4096);
    const other = engine({ poly: 2 });
    other.applyMidi({ type: 'noteOn', voiceId: 1, note: 60, velocity: 100 });
    other.applyMidi({ type: 'noteBend', voiceId: 1, note: 61, semitones: 5 });
    other.applyMidi({ type: 'notePressure', voiceId: 9, note: 60, value: 1 });
    expect(render(other, 4096)).toEqual(a);
  });
});
