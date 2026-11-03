import { describe, expect, it } from 'vitest';
import { MidiController, MIDI_STORAGE_KEY, parseSettings, type SettingsStore } from '../src/app/midi';
import { AppModel } from '../src/app/model';
import { emptyStatus, SynthEngine } from '../src/core/engine/engine';
import { NoteStack } from '../src/core/engine/noteStack';
import { generateBasic } from '../src/core/generators';
import {
  assignCc,
  bendSemitones,
  ccPatch,
  ccValue,
  DEFAULT_CC_MAP,
  LFO_RATE_MAX,
  LFO_RATE_MIN,
  midiNoteFreq,
  MidiRouter,
  normalizeCcMap,
  parseMidi,
  velocityGain,
  type MidiRouting,
  type MidiVoiceEvent,
} from '../src/core/midi';
import { buildMipSet } from '../src/core/mipmap';
import { emptySteps } from '../src/core/sequence';
import { DEFAULT_VOICE, type VoicePatch, type VoiceParams } from '../src/core/voice';
import { packIds } from '../src/core/wavetablePlayback';

const SR = 48000;

describe('parseMidi', () => {
  it('parses notes, CCs and pitch bend with 1-based channels', () => {
    expect(parseMidi([0x90, 60, 100])).toEqual({ kind: 'noteOn', channel: 1, note: 60, velocity: 100 });
    expect(parseMidi([0x93, 61, 1])).toEqual({ kind: 'noteOn', channel: 4, note: 61, velocity: 1 });
    expect(parseMidi([0x80, 60, 64])).toEqual({ kind: 'noteOff', channel: 1, note: 60 });
    expect(parseMidi([0xbf, 1, 127])).toEqual({ kind: 'cc', channel: 16, cc: 1, value: 127 });
    expect(parseMidi([0xe0, 0, 64])).toEqual({ kind: 'bend', channel: 1, value: 0 });
    expect(parseMidi([0xe0, 127, 127])).toEqual({ kind: 'bend', channel: 1, value: 1 });
    expect(parseMidi([0xe0, 0, 0])).toEqual({ kind: 'bend', channel: 1, value: -1 });
  });

  it('note-on with velocity 0 is a note-off', () => {
    expect(parseMidi([0x91, 64, 0])).toEqual({ kind: 'noteOff', channel: 2, note: 64 });
  });

  it('ignores system, aftertouch, program change and malformed data', () => {
    expect(parseMidi([0xf8])).toBeNull();
    expect(parseMidi([0xf0, 1, 2, 0xf7])).toBeNull();
    expect(parseMidi([0xc0, 5])).toBeNull();
    expect(parseMidi([0xa0, 60, 10])).toBeNull();
    expect(parseMidi([0x90, 60])).toBeNull();
    expect(parseMidi([60, 100])).toBeNull();
    expect(parseMidi([])).toBeNull();
  });
});

describe('velocity, pitch', () => {
  it('velocity curve: 127 = 1, monotonic, 40 dB range, 0 = silent', () => {
    expect(velocityGain(127)).toBeCloseTo(1, 6);
    expect(velocityGain(0)).toBe(0);
    expect(velocityGain(1)).toBeCloseTo(0.01, 3);
    expect(20 * Math.log10(velocityGain(64))).toBeGreaterThan(-13);
    expect(20 * Math.log10(velocityGain(64))).toBeLessThan(-10);
    for (let v = 1; v < 127; v++) expect(velocityGain(v + 1)).toBeGreaterThan(velocityGain(v));
  });

  it('note frequency and bend range', () => {
    expect(midiNoteFreq(69)).toBeCloseTo(440, 9);
    expect(midiNoteFreq(57)).toBeCloseTo(220, 9);
    expect(midiNoteFreq(69, 1)).toBeCloseTo(880, 9);
    expect(bendSemitones(1)).toBe(2);
    expect(bendSemitones(-1)).toBe(-2);
    expect(bendSemitones(0)).toBe(0);
  });
});

describe('NoteStack', () => {
  it('last-note priority; release returns to the most recent held note', () => {
    const s = new NoteStack();
    s.push(60, 100);
    s.push(64, 90);
    s.push(67, 80);
    expect(s.top).toBe(67);
    expect(s.remove(64)).toBe(true); // a non-top release changes nothing audible
    expect(s.top).toBe(67);
    s.remove(67);
    expect([s.top, s.topVelocity]).toEqual([60, 100]);
    expect(s.remove(99)).toBe(false);
    s.push(60, 50); // re-press moves to the top with the new velocity
    expect([s.size, s.topVelocity]).toEqual([1, 50]);
  });

  it('the same note held twice (two channels in Omni) stays held until both release', () => {
    const s = new NoteStack();
    s.push(60, 100);
    s.push(64, 100);
    s.push(60, 90);
    expect(s.top).toBe(60);
    expect(s.remove(60)).toBe(false);
    expect(s.top).toBe(60);
    expect(s.remove(60)).toBe(true);
    expect(s.top).toBe(64);
  });

  it('drops the oldest key when full', () => {
    const s = new NoteStack();
    for (let n = 0; n < NoteStack.CAPACITY + 2; n++) s.push(40 + n, 100);
    expect(s.size).toBe(NoteStack.CAPACITY);
    expect(s.has(40)).toBe(false);
    expect(s.has(41)).toBe(false);
    expect(s.has(42)).toBe(true);
    expect(s.top).toBe(40 + NoteStack.CAPACITY + 1);
  });
});

describe('MidiRouter', () => {
  const r3 = (p: Partial<MidiRouting> = {}): MidiRouting => ({ omni: false, selectedVoice: 1, voiceIds: [1, 2, 3], ...p });
  const on = (ch: number, note: number, vel = 100) => parseMidi([0x90 + ch - 1, note, vel])!;
  const off = (ch: number, note: number) => parseMidi([0x80 + ch - 1, note, 0])!;

  it('channel N → voice N; channels without a voice are ignored', () => {
    const r = new MidiRouter();
    expect(r.route(on(2, 60), r3())).toEqual([{ type: 'noteOn', voiceId: 2, note: 60, velocity: 100 }]);
    expect(r.route(on(5, 60), r3())).toEqual([]);
    expect(r.route(off(5, 60), r3())).toEqual([]);
    expect(r.route(off(2, 60), r3())).toEqual([{ type: 'noteOff', voiceId: 2, note: 60 }]);
  });

  it('Omni sends every channel to the selected voice', () => {
    const r = new MidiRouter();
    expect(r.route(on(7, 60), r3({ omni: true, selectedVoice: 3 }))[0]).toMatchObject({ voiceId: 3 });
    expect(r.route(on(1, 62), r3({ omni: true, selectedVoice: 2 }))[0]).toMatchObject({ voiceId: 2 });
    expect(r.route(on(1, 64), r3({ omni: true, selectedVoice: null }))).toEqual([]);
  });

  it('a note-off reaches the voice its note-on went to, even after the routing changed', () => {
    const r = new MidiRouter();
    r.route(on(1, 60), r3({ omni: true, selectedVoice: 2 }));
    // Tab switched to voice 3, then Omni turned off: the release still goes to voice 2.
    expect(r.route(off(1, 60), r3({ omni: false, selectedVoice: 3 }))).toEqual([{ type: 'noteOff', voiceId: 2, note: 60 }]);
  });

  it('a repeated note-on releases the first one where it went', () => {
    const r = new MidiRouter();
    r.route(on(1, 60), r3({ omni: true, selectedVoice: 2 }));
    expect(r.route(on(1, 60), r3({ omni: true, selectedVoice: 3 }))).toEqual([
      { type: 'noteOff', voiceId: 2, note: 60 },
      { type: 'noteOn', voiceId: 3, note: 60, velocity: 100 },
    ]);
  });

  it('pitch bend is routed and scaled', () => {
    const r = new MidiRouter();
    expect(r.route(parseMidi([0xe1, 127, 127])!, r3())).toEqual([{ type: 'bend', voiceId: 2, semitones: 2 }]);
  });

  it('a bend moved after the routing changed recentres the voice it bent before', () => {
    const r = new MidiRouter();
    r.route(parseMidi([0xe0, 127, 127])!, r3({ omni: true, selectedVoice: 2 }));
    expect(r.route(parseMidi([0xe0, 127, 127])!, r3({ omni: true, selectedVoice: 3 }))).toEqual([
      { type: 'bend', voiceId: 2, semitones: 0 },
      { type: 'bend', voiceId: 3, semitones: 2 },
    ]);
  });

  it('retarget moves a held bend; reset-all-controllers (121) recentres it', () => {
    const r = new MidiRouter();
    r.route(parseMidi([0xe0, 0, 0])!, r3({ omni: true, selectedVoice: 2 }));
    expect(r.retarget(r3({ omni: true, selectedVoice: 2 }))).toEqual([]);
    expect(r.retarget(r3({ omni: true, selectedVoice: 3 }))).toEqual([
      { type: 'bend', voiceId: 2, semitones: 0 },
      { type: 'bend', voiceId: 3, semitones: -2 },
    ]);
    expect(r.route(parseMidi([0xb0, 121, 0])!, r3({ omni: true, selectedVoice: 3 }))).toEqual([{ type: 'bend', voiceId: 3, semitones: 0 }]);
    expect(r.retarget(r3({ omni: true, selectedVoice: 1 }))).toEqual([]);
  });

  it('all-notes-off (123) and all-sound-off (120) release the channel', () => {
    const r = new MidiRouter();
    r.route(on(1, 60), r3());
    r.route(on(1, 64), r3());
    r.route(on(2, 60), r3());
    expect(r.route(parseMidi([0xb0, 123, 0])!, r3())).toEqual([{ type: 'allNotesOff', voiceId: 1 }]);
    expect(r.heldCount).toBe(1);
    expect(r.route(off(1, 60), r3())).toEqual([]); // already released
    expect(r.route(parseMidi([0xb1, 120, 0])!, r3())).toEqual([{ type: 'allNotesOff', voiceId: 2 }]);
    expect(r.heldCount).toBe(0);
  });

  it('losing a device releases its notes and recentres its bend; other devices keep theirs', () => {
    const r = new MidiRouter();
    r.route(on(1, 60), r3(), 1);
    r.route(parseMidi([0xe0, 0, 0])!, r3(), 1);
    r.route(on(2, 62), r3(), 2);
    expect(r.releaseSource(1)).toEqual([
      { type: 'noteOff', voiceId: 1, note: 60 },
      { type: 'bend', voiceId: 1, semitones: 0 },
    ]);
    expect(r.heldCount).toBe(1);
    expect(r.releaseAll()).toEqual([{ type: 'allNotesOff', voiceId: 2 }]);
    expect(r.heldCount).toBe(0);
  });

  it('CCs go to the channel’s voice', () => {
    const r = new MidiRouter();
    expect(r.route(parseMidi([0xb2, 1, 64])!, r3())).toEqual([{ type: 'cc', voiceId: 3, cc: 1, value: 64 }]);
    expect(r.route(parseMidi([0xb8, 1, 64])!, r3())).toEqual([]);
  });
});

describe('CC map', () => {
  it('defaults to mod wheel → position', () => {
    expect(ccPatch(DEFAULT_CC_MAP, 1, 127)).toEqual({ position: 1 });
    expect(ccPatch(DEFAULT_CC_MAP, 1, 0)).toEqual({ position: 0 });
    expect(ccPatch(DEFAULT_CC_MAP, 74, 64)).toBeNull();
  });

  it('assigning a controller moves it from any other parameter', () => {
    let m = assignCc(DEFAULT_CC_MAP, 'lfoDepth', 74);
    m = assignCc(m, 'level', 74);
    expect(m).toMatchObject({ position: 1, positionY: -1, lfoDepth: -1, lfoRate: -1, level: 74 });
    m = assignCc(m, 'position', -1);
    expect(m.position).toBe(-1);
    expect(assignCc(m, 'lfoRate', 120).lfoRate).toBe(-1); // channel-mode CCs can't be assigned
  });

  it('maps values onto each parameter (LFO rate exponential)', () => {
    expect(ccValue('level', 127)).toBe(1);
    expect(ccValue('lfoDepth', 0)).toBe(0);
    expect(ccValue('lfoRate', 0)).toBeCloseTo(LFO_RATE_MIN, 9);
    expect(ccValue('lfoRate', 127)).toBeCloseTo(LFO_RATE_MAX, 9);
    expect(ccValue('lfoRate', 64)).toBeCloseTo(Math.sqrt(LFO_RATE_MIN * LFO_RATE_MAX), 1);
  });

  it('normalizes untrusted stored maps', () => {
    expect(normalizeCcMap(null)).toEqual(DEFAULT_CC_MAP);
    expect(normalizeCcMap({ position: 7, level: 7, lfoRate: "x", bogus: 3 })).toMatchObject({ position: -1, positionY: -1, lfoDepth: -1, lfoRate: -1, level: 7 });
  });
});

// ---- engine ----

function engine(patch: Partial<VoiceParams> = {}) {
  const e = new SynthEngine(SR);
  e.addTable(1, buildMipSet(generateBasic('sine', 0).data));
  e.setWavetable(0, packIds([1]));
  e.setVoice({ ...DEFAULT_VOICE, id: 1, name: 'V1', level: 1, sustain: 1, attack: 0.001, release: 0.01, lfoDepth: 0, ...patch });
  return e;
}

function render(e: SynthEngine, frames: number) {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 128) e.process(out.subarray(i, i + 128), Math.min(128, frames - i));
  return out;
}

const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

/** Frequency from rising zero crossings (sine table). */
function pitch(x: Float32Array): number {
  let first = -1;
  let last = -1;
  let n = 0;
  for (let i = 1; i < x.length; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      const t = i - 1 + -x[i - 1] / (x[i] - x[i - 1]);
      if (first < 0) first = t;
      else n++;
      last = t;
    }
  }
  return (n * SR) / (last - first);
}

const st = (e: SynthEngine) => e.status(emptyStatus()).voices[0];

describe('SynthEngine MIDI', () => {
  it('plays a note at its pitch and releases on note-off', () => {
    const e = engine();
    e.midiNoteOn(1, 69, 127);
    render(e, 2048);
    expect(pitch(render(e, 9600))).toBeCloseTo(440, 0);
    expect(st(e).note).toBe(69);
    e.midiNoteOff(1, 69);
    render(e, SR / 10);
    expect(st(e).note).toBe(-1);
    expect(rms(render(e, 2048))).toBeLessThan(1e-4);
  });

  it('note-on with velocity 0 releases', () => {
    const e = engine();
    e.midiNoteOn(1, 60, 100);
    e.midiNoteOn(1, 60, 0);
    expect(st(e).note).toBe(-1);
  });

  it('applies the voice octave', () => {
    const e = engine({ octave: -1 });
    e.midiNoteOn(1, 69, 127);
    render(e, 2048);
    expect(pitch(render(e, 9600))).toBeCloseTo(220, 0);
  });

  it('last-note priority: a new key retriggers; releasing it returns legato to a held key', () => {
    const e = engine({ sustain: 0.5, decay: 0.05 });
    e.midiNoteOn(1, 57, 127); // 220 Hz
    render(e, SR / 10);
    expect(st(e).env).toBeCloseTo(0.5, 2);
    e.midiNoteOn(1, 69, 127); // 440 Hz: retrigger (envelope rises again)
    let peak = 0;
    for (let i = 0; i < 20; i++) {
      render(e, 128);
      peak = Math.max(peak, st(e).env);
    }
    expect(peak).toBeGreaterThan(0.9);
    render(e, SR / 10);
    expect(pitch(render(e, 9600))).toBeCloseTo(440, 0);
    e.midiNoteOff(1, 69); // back to 57, no retrigger
    peak = 0;
    for (let i = 0; i < 40; i++) {
      render(e, 128);
      peak = Math.max(peak, st(e).env);
    }
    expect(peak).toBeLessThan(0.51);
    expect(st(e).note).toBe(57);
    expect(pitch(render(e, 9600))).toBeCloseTo(220, 0);
  });

  it('CC param patches apply without a full voice/set', () => {
    const e = engine({ level: 1 });
    e.midiNoteOn(1, 60, 127);
    render(e, SR / 4);
    e.patchVoice(1, { level: 0 });
    render(e, SR / 4);
    expect(rms(render(e, 2048))).toBeLessThan(1e-4);
  });

  it('releasing a key that is not sounding changes nothing', () => {
    const e = engine();
    e.midiNoteOn(1, 57, 127);
    e.midiNoteOn(1, 69, 127);
    e.midiNoteOff(1, 57);
    render(e, 2048);
    expect(st(e).note).toBe(69);
    expect(pitch(render(e, 9600))).toBeCloseTo(440, 0);
  });

  it('velocity scales the level', () => {
    const loud = engine();
    const soft = engine();
    loud.midiNoteOn(1, 60, 127);
    soft.midiNoteOn(1, 60, 64);
    render(loud, SR / 4);
    render(soft, SR / 4);
    expect(rms(render(soft, 4800)) / rms(render(loud, 4800))).toBeCloseTo(velocityGain(64), 2);
  });

  it('pitch bend: ±2 semitones, smoothed (no step in the per-sample phase increment)', () => {
    const e = engine();
    e.midiNoteOn(1, 69, 127);
    render(e, 4096);
    e.setPitchBend(1, 2);
    // Instantaneous frequency from the sine's phase: track sample-to-sample angle changes.
    const out = render(e, SR / 20);
    expect(pitch(render(e, 9600))).toBeCloseTo(440 * Math.pow(2, 2 / 12), 0);
    // Smoothness: the waveform's second difference never jumps (no zipper / discontinuity).
    let maxD2 = 0;
    for (let i = 2; i < out.length; i++) maxD2 = Math.max(maxD2, Math.abs(out[i] - 2 * out[i - 1] + out[i - 2]));
    const amp = Math.max(...out.map(Math.abs));
    const w = (2 * Math.PI * 494) / SR;
    expect(maxD2).toBeLessThan(amp * w * w * 1.2);
    e.applyMidi({ type: 'bend', voiceId: 1, semitones: -2 });
    render(e, SR / 20);
    expect(pitch(render(e, 9600))).toBeCloseTo(440 * Math.pow(2, -2 / 12), 0);
  });

  it('all notes off releases every held key', () => {
    const e = engine();
    e.midiNoteOn(1, 60, 100);
    e.midiNoteOn(1, 64, 100);
    e.applyMidi({ type: 'allNotesOff', voiceId: -1 });
    expect(st(e).note).toBe(-1);
    render(e, SR / 10);
    expect(rms(render(e, 2048))).toBeLessThan(1e-4);
  });

  it('held MIDI keys take over from the sequence, which resumes after release', () => {
    const e = engine({ sustain: 1 });
    const steps = emptySteps();
    for (let i = 0; i < 8; i++) steps[i] = 0; // a note on every step (110 Hz root)
    e.setSequence({ id: 1, voiceId: 1, length: 8, steps, gate: 0.5, stepLength: '1/8' });
    e.setTransport(true, 240); // step = 6000 samples
    render(e, 3000);
    e.midiNoteOn(1, 69, 127);
    // Across several steps (sequence gates would end / retrigger) the key holds at 440 Hz.
    render(e, 2048);
    expect(pitch(render(e, 24000))).toBeCloseTo(440, 0);
    expect(st(e).env).toBeCloseTo(1, 3);
    e.midiNoteOff(1, 69);
    render(e, 12000);
    expect(st(e).note).toBe(-1);
    // The sequence is back (its gate is half a step, so look across a full step).
    const seq = render(e, 6000);
    expect(rms(seq)).toBeGreaterThan(0.01);
    expect(pitch(seq.subarray(0, 2500))).not.toBeCloseTo(440, -1);
    // Stopping the transport keeps a held key sounding.
    e.midiNoteOn(1, 69, 127);
    e.setTransport(false, 240);
    render(e, SR / 10);
    expect(st(e).env).toBeCloseTo(1, 3);
  });
});

// ---- app controller ----

function controller(store?: SettingsStore) {
  const m = new AppModel();
  m.addTables([generateBasic('sine', 0), generateBasic('saw', 0)]);
  m.addVoice();
  m.addVoice();
  const sent: MidiVoiceEvent[] = [];
  const patches: [number, VoicePatch][] = [];
  let selected = 1;
  const ticks: (() => void)[] = [];
  const c = new MidiController(
    m,
    { notes: (evs) => void sent.push(...evs), params: (id, p) => void patches.push([id, p]) },
    () => selected,
    store,
    (fn) => void ticks.push(fn),
  );
  const tick = () => ticks.splice(0).forEach((fn) => fn());
  return { m, c, sent, patches, tick, select: (id: number) => (selected = id) };
}

function memStore(): SettingsStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) };
}

describe('MidiController', () => {
  it('sends routed notes to the engine sink and CC1 to the voice position', () => {
    const { m, c, sent, patches, tick } = controller();
    c.handle([0x91, 60, 100]);
    expect(sent).toEqual([{ type: 'noteOn', voiceId: 2, note: 60, velocity: 100 }]);
    c.handle([0xb0, 1, 127]);
    expect(patches).toEqual([[1, { position: 1 }]]); // engine hears it at once
    tick();
    expect(m.voice(1)!.position).toBe(1);
    expect(m.voice(2)!.position).toBe(DEFAULT_VOICE.position);
    expect(sent.length).toBe(1); // CCs don't go to the engine
  });

  it('coalesces a knob sweep into one model update per tick', () => {
    const { m, c, patches, tick } = controller();
    c.setCc('level', 7);
    let events = 0;
    m.on('voices', () => events++);
    for (let v = 0; v <= 127; v++) c.handle([0xb0, 1, v]);
    c.handle([0xb0, 7, 0]);
    expect(patches.length).toBe(129);
    expect(events).toBe(0);
    tick();
    expect(events).toBe(1);
    expect(m.voice(1)!).toMatchObject({ position: 1, level: 0 });
  });

  it('another voice change folds in pending CC values first', () => {
    const { m, c } = controller();
    c.handle([0xb0, 1, 127]);
    m.updateVoice(2, { mute: true });
    expect(m.voice(1)!.position).toBe(1);
  });

  it('a held bend follows Omni to the newly selected voice', () => {
    const { c, sent, select } = controller();
    c.setOmni(true);
    c.handle([0xe0, 127, 127]);
    expect(sent.at(-1)).toEqual({ type: 'bend', voiceId: 1, semitones: 2 });
    select(2);
    c.retarget();
    expect(sent.slice(-2)).toEqual([
      { type: 'bend', voiceId: 1, semitones: 0 },
      { type: 'bend', voiceId: 2, semitones: 2 },
    ]);
    c.setOmni(false); // channel 1 → voice 1 again
    expect(sent.slice(-2)).toEqual([
      { type: 'bend', voiceId: 2, semitones: 0 },
      { type: 'bend', voiceId: 1, semitones: 2 },
    ]);
  });

  it('Omni follows the selected voice', () => {
    const { c, sent, select } = controller();
    c.setOmni(true);
    select(2);
    c.handle([0x9f, 60, 100]);
    expect(sent.at(-1)).toMatchObject({ type: 'noteOn', voiceId: 2 });
  });

  it('learn assigns the next controller move and applies it', () => {
    const { m, c, tick } = controller();
    let learnEvents = 0;
    c.on('learn', () => learnEvents++);
    c.setLearn('lfoDepth');
    c.handle([0xb0, 123, 0]); // channel-mode CC: not learnable
    for (const cc of [0, 32, 6, 38, 98, 99, 100, 101]) c.handle([0xb0, cc, 1]); // bank / data entry / (N)RPN
    expect(c.learn).toBe('lfoDepth');
    c.handle([0xb0, 74, 127]);
    tick();
    expect(c.learn).toBeNull();
    expect(c.settings.cc.lfoDepth).toBe(74);
    expect(m.voice(1)!.lfoDepth).toBe(1);
    expect(learnEvents).toBe(2);
    c.setLearn('position');
    c.handle([0xb0, 74, 0]); // moves CC74 from depth to position
    tick();
    expect(c.settings.cc).toMatchObject({ position: 74, lfoDepth: -1 });
  });

  it('persists settings and tolerates broken / throwing storage', () => {
    const s = memStore();
    const a = controller(s);
    a.c.setCc('level', 7);
    a.c.setOmni(true);
    a.c.setInput('abc', 'Keys');
    const b = controller(s);
    expect(b.c.settings).toMatchObject({ input: 'abc', inputName: 'Keys', omni: true, cc: { position: 1, level: 7 } });
    s.data.set(MIDI_STORAGE_KEY, '{not json');
    expect(controller(s).c.settings.input).toBe('off');
    expect(parseSettings(null).cc).toEqual(DEFAULT_CC_MAP);
    const throwing: SettingsStore = {
      get: () => {
        throw new Error('blocked');
      },
      set: () => {
        throw new Error('blocked');
      },
    };
    const t = controller(throwing);
    expect(() => t.c.setOmni(true)).not.toThrow();
    expect(t.c.settings.omni).toBe(true);
  });

  it('device loss releases held notes', () => {
    const { c, sent } = controller();
    c.handle([0x90, 60, 100], 3);
    sent.length = 0;
    c.sourceLost(3);
    expect(sent).toEqual([{ type: 'noteOff', voiceId: 1, note: 60 }]);
  });
});

describe('Synth voice controller targets', () => {
  it('map cutoff exponentially, filter env bipolar, osc mix as a crossfade, glide quadratic', () => {
    expect(ccValue('cutoff', 0)).toBeCloseTo(20, 6);
    expect(ccValue('cutoff', 127)).toBeCloseTo(20000, 6);
    expect(ccValue('filterEnv', 0)).toBe(-1);
    expect(ccValue('filterEnv', 127)).toBe(1);
    expect(ccValue('glide', 127)).toBe(2);
    let map = assignCc(DEFAULT_CC_MAP, 'cutoff', 74);
    map = assignCc(map, 'oscMix', 75);
    expect(ccPatch(map, 74, 127)).toEqual({ synth: { cutoff: 20000 } });
    expect(ccPatch(map, 75, 127)).toEqual({ synth: { aLevel: 0, bLevel: 1 } });
    expect(ccPatch(map, 1, 0)).toEqual({ position: 0 });
    expect(normalizeCcMap({ resonance: 71, cutoff: 'x' })).toMatchObject({ resonance: 71, cutoff: -1, position: -1 });
  });

  it('controller moves reach the engine and the model (merged per voice), without undo steps', () => {
    const { m, c, patches, tick } = controller();
    m.updateVoice(1, { type: 'synth' });
    m.endGesture();
    const depth = m.undoDepth;
    c.setCc('cutoff', 74);
    c.setCc('resonance', 71);
    c.handle([0xb0, 74, 0]);
    c.handle([0xb0, 71, 127]);
    expect(patches.map(([, p]) => p)).toEqual([{ synth: { cutoff: 20 } }, { synth: { resonance: 1 } }]);
    tick();
    expect(m.voice(1)!.synth.cutoff).toBeCloseTo(20, 6);
    expect(m.voice(1)!.synth.resonance).toBe(1);
    expect(m.undoDepth).toBe(depth);
    // The engine merges synth patches into the voice's synth block.
    const e = engine({ type: 'synth' });
    e.patchVoice(1, { synth: { cutoff: 300 } });
    e.patchVoice(1, { synth: { resonance: 0.5 } });
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 60, velocity: 100 });
    const out = render(e, 4800);
    expect(out.every(Number.isFinite)).toBe(true);
    expect(rms(out)).toBeGreaterThan(0.001);
  });
});
