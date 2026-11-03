/**
 * The synth engine: everything that runs on the audio thread. No DOM, no WebAudio,
 * no allocation in process() (apart from Map lookups). The AudioWorklet is a thin
 * message adapter around this class; a native port would mirror it 1:1.
 *
 * Voices are Simple (one wavetable oscillator, position LFOs, amp ADSR: the original voice,
 * rendered exactly as before) or Synth (engine/synthVoice.ts). Note handling, the amp
 * envelope, pitch bend and the sequencer are shared; a type switch crossfades the two
 * paths. The output is stereo: Simple voices are centred (identical left and right).
 */
import { CONTROL_BLOCK } from '../constants';
import { midiNoteFreq, type MidiVoiceEvent, velocityGain } from '../midi';
import { mipLevelFor, type MipSet } from '../mipmap';
import { noteFreq, type SequenceData, STEP_TICKS, stepLengthOf, stepSamples, TICKS_PER_BEAT } from '../sequence';
import type { TableId } from '../table';
import { applyVoicePatch, DEFAULT_VOICE, modulatedPosition, type VoicePatch, type VoiceParams } from '../voice';
import type { WavetableId } from '../wavetable';
import type { PackedWavetable } from '../wavetablePlayback';
import { Adsr } from './adsr';
import { NoteStack } from './noteStack';
import { freqPitch, SynthVoice, type SynthControl } from './synthVoice';
import { WtOsc } from './wtOsc';

export const MASTER_GAIN = 0.22;

/** Release time used when a voice is removed while sounding (avoids a click). */
export const REMOVE_RELEASE_SEC = 0.012;

/** Pitch-bend smoothing time constant (one-pole per control block, ramped within it). */
export const BEND_SMOOTH_SEC = 0.004;

/** Simple ↔ Synth switch of a sounding voice: the two paths crossfade over this long. */
export const TYPE_FADE_SEC = 0.01;

const IDLE = 0;

/**
 * Longest a mix change takes: weights move towards their targets at most 1 / this many
 * seconds per second, so a jump (window / table / wavetable switch, a table replaced
 * under the voice) crossfades over ~6 ms, while slow position moves track exactly.
 */
export const CROSSFADE_SEC = 0.006;

class VoiceRuntime {
  params: VoiceParams;
  readonly env = new Adsr();
  /** The Simple voice's oscillator: its table mix, phase and mip level. */
  readonly osc = new WtOsc();
  lfoPhase: number;
  freq = 110;
  gateRemaining = 0;
  gain = 0;
  /** Velocity gain of the sounding note (1 for sequencer notes). */
  vel = 1;
  /** MIDI keys held on this voice; while non-empty, MIDI owns the voice (sequence steps skip). */
  readonly notes = new NoteStack();
  /** Pitch bend: target and smoothed semitones; frequency ratio at the block start / end. */
  bendTarget = 0;
  bendSemis = 0;
  bendFrom = 1;
  bendTo = 1;
  /** LFO on the Y position. */
  lfoPhaseY: number;
  /** Modulated positions 0..1 (for the UI). */
  pos = 0;
  posY = 0;
  /** Fading out before removal. */
  removing = false;
  /** The Synth path (allocated when the voice first becomes a Synth voice, then kept). */
  syn: SynthVoice | null = null;
  /** Simple (0) ↔ Synth (1) crossfade position. */
  typeMix = 0;
  /** Mod wheel (CC 1) and channel pressure, 0..1 (Synth voice mod matrix sources). */
  wheel = 0;
  pressure = 0;

  constructor(p: VoiceParams, sampleRate: number) {
    this.params = p;
    this.lfoPhase = p.lfoPhase;
    this.lfoPhaseY = p.lfoPhaseY;
    this.env.configure(p.attack, p.decay, p.sustain, p.release, sampleRate);
    if (p.type === 'synth') {
      this.syn = new SynthVoice(sampleRate, p.id, CONTROL_BLOCK, p.synth.lfos.map((l) => l.phase));
      this.typeMix = 1;
    }
  }
}

/** Clock ticks per eighth note: the clock's accumulator advances per eighth (see SynthEngine.process). */
const TICKS_PER_EIGHTH = TICKS_PER_BEAT / 2;

export interface VoiceStatus {
  id: number;
  pos: number;
  posY: number;
  index: number;
  y: number;
  env: number;
  note: number;
  /** Synth voices: osc B's position and resolved coordinates (else equal to A's). */
  posB: number;
  posYB: number;
  indexB: number;
  yB: number;
}

export interface EngineStatus {
  /** Shared clock: ticks since the transport started (TICKS_PER_BEAT per beat; -1 before the first). */
  tick: number;
  playing: boolean;
  /**
   * Per voice: modulated positions (pos, posY: 0..1), the coordinates they resolve to in
   * the wavetable (index = x along the row, y = row; the chosen cell in Step), envelope
   * level, and `note`: the MIDI note it plays (top of its held stack), or -1. Synth voices
   * report osc A there and osc B in posB / posYB / indexB / yB.
   */
  voices: VoiceStatus[];
}

export class SynthEngine {
  readonly sampleRate: number;
  private tables = new Map<TableId, MipSet>();
  private wavetables = new Map<WavetableId, PackedWavetable>();
  private voices: VoiceRuntime[] = [];
  private sequences: SequenceData[] = [];
  private playing = false;
  private bpm = 132;
  /** Clock tick (see process()); -1 before the first. */
  private tick = -1;
  /** Samples until the next eighth note (fractional accumulator). */
  private toNext = 0;
  /** Length in samples of the eighth in progress (fixed when it starts, so a tempo change takes effect on the next one). */
  private eighthLen = 0;
  /** Ticks into the eighth in progress (0..TICKS_PER_EIGHTH-1). */
  private sub = 0;
  private ctrlCountdown = 0;
  private readonly bendCoef: number;
  /** Largest weight change per control block (see CROSSFADE_SEC). */
  private readonly slew: number;
  /** Simple ↔ Synth crossfade step per sample. */
  private readonly typeStep: number;
  private readonly glideCoef = (sec: number): number => 1 - Math.exp(-CONTROL_BLOCK / (Math.max(1e-4, sec / 4) * this.sampleRate));
  /** Per-voice stereo output of the sample being rendered (renderMixed). */
  private outL = 0;
  private outR = 0;
  /** Reused per control block for each Synth voice. */
  private readonly ctl: SynthControl = {
    bend: 0,
    blockLen: CONTROL_BLOCK,
    tables: this.tables,
    wtA: undefined,
    wtB: undefined,
    slew: 0,
    glideCoef: this.glideCoef,
    gainTarget: 0,
    bpm: 132,
    wheel: 0,
    pressure: 0,
  };

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.bendCoef = 1 - Math.exp(-CONTROL_BLOCK / (BEND_SMOOTH_SEC * sampleRate));
    this.slew = CONTROL_BLOCK / (CROSSFADE_SEC * sampleRate);
    this.typeStep = 1 / (TYPE_FADE_SEC * sampleRate);
  }

  // ---- state commands (called between process() calls) ----

  addTable(id: TableId, mips: MipSet): void {
    this.tables.set(id, mips);
  }

  removeTables(ids: readonly TableId[]): void {
    for (const id of ids) this.tables.delete(id);
  }

  hasTable(id: TableId): boolean {
    return this.tables.has(id);
  }

  get tableCount(): number {
    return this.tables.size;
  }

  setWavetable(id: WavetableId, wt: PackedWavetable): void {
    this.wavetables.set(id, wt);
  }

  removeWavetable(id: WavetableId): void {
    this.wavetables.delete(id);
  }

  private findVoice(id: number): VoiceRuntime | undefined {
    return this.voices.find((x) => x.params.id === id && !x.removing);
  }

  setVoice(p: VoiceParams): void {
    const v = this.findVoice(p.id);
    if (!v) {
      if (!this.voices.some((x) => x.params.id === p.id)) {
        this.voices.push(new VoiceRuntime({ ...DEFAULT_VOICE, ...p }, this.sampleRate));
      }
      return;
    }
    this.applyParams(v, p);
  }

  private applyParams(v: VoiceRuntime, p: VoiceParams): void {
    v.params = p;
    v.env.configure(p.attack, p.decay, p.sustain, p.release, this.sampleRate);
    if (p.type === 'synth' && !v.syn) {
      // Becoming a Synth voice: start its path at the current note (then crossfade in).
      const syn = new SynthVoice(this.sampleRate, p.id, CONTROL_BLOCK, p.synth.lfos.map((l) => l.phase));
      syn.noteOn(p, freqPitch(v.freq), 1, false, v.env.stage !== IDLE, false);
      v.syn = syn;
    }
  }

  /** Fade the voice out with a short release, then drop it (see control()). */
  removeVoice(id: number): void {
    const v = this.findVoice(id);
    if (!v) return;
    v.removing = true;
    v.gateRemaining = 0;
    const p = v.params;
    v.env.configure(p.attack, p.decay, p.sustain, REMOVE_RELEASE_SEC, this.sampleRate);
    this.gateOff(v);
  }

  /** Voices still allocated (including ones fading out). */
  get voiceCount(): number {
    return this.voices.length;
  }

  setSequence(s: SequenceData): void {
    const i = this.sequences.findIndex((x) => x.id === s.id);
    if (i >= 0) this.sequences[i] = s;
    else this.sequences.push(s);
  }

  removeSequence(id: number): void {
    this.sequences = this.sequences.filter((s) => s.id !== id);
  }

  setTransport(playing: boolean, bpm: number): void {
    this.bpm = Math.max(20, Math.min(400, bpm));
    if (playing && !this.playing) {
      this.tick = -1;
      this.toNext = 0;
      this.sub = 0;
    }
    // Stopping releases sequencer notes; held MIDI keys keep sounding.
    if (!playing && this.playing) for (const v of this.voices) if (!v.notes.size) this.gateOff(v);
    this.playing = playing;
  }

  /** Release the amp envelope (and the Synth path's envelopes). */
  private gateOff(v: VoiceRuntime): void {
    v.env.gateOff();
    v.syn?.gateOff(v.params);
  }

  /**
   * Start a note on the Synth path (if any): pitch, velocity, glide, envelope retrigger.
   * Call before the amp envelope's gateOn (glide needs to know whether it was sounding).
   */
  private synthNote(v: VoiceRuntime, vel: number, legato: boolean, retrigger: boolean): void {
    if (v.syn) v.syn.noteOn(v.params, freqPitch(v.freq), vel, legato, retrigger, v.env.stage !== IDLE);
  }

  /** A sequencer note (full velocity, gated). Ignored while MIDI keys are held on the voice. */
  noteOn(voiceId: number, freq: number, gateSamples: number): void {
    const v = this.findVoice(voiceId);
    if (!v || v.notes.size) return;
    v.freq = freq;
    v.vel = 1;
    v.gateRemaining = Math.max(1, Math.round(gateSamples));
    this.synthNote(v, 1, false, true);
    v.env.gateOn();
    this.resolvePitch(v);
  }

  // ---- MIDI (events already routed to a voice; see core/midi.ts) ----

  /**
   * Key pressed: it becomes the voice's note (last-note priority) and retriggers the
   * envelope (from its current level, no click). Takes the voice over from the sequencer
   * until every key is released. Velocity 0 = release.
   */
  midiNoteOn(voiceId: number, note: number, velocity: number): void {
    if (velocity <= 0) return this.midiNoteOff(voiceId, note);
    const v = this.findVoice(voiceId);
    if (!v) return;
    const legato = v.notes.size > 0;
    v.notes.push(note, velocity);
    v.freq = midiNoteFreq(note, v.params.octave);
    v.vel = velocityGain(velocity);
    v.gateRemaining = 0;
    this.synthNote(v, Math.min(127, velocity) / 127, legato, true);
    v.env.gateOn();
    this.resolvePitch(v);
  }

  /**
   * Key released. If it was sounding and other keys are still held, the voice glides
   * (legato: no retrigger) back to the most recent of them, at its velocity; when the
   * last key goes, the envelope releases and the sequence takes over again on its next step.
   */
  midiNoteOff(voiceId: number, note: number): void {
    const v = this.findVoice(voiceId);
    if (!v) return;
    const wasTop = v.notes.top === note;
    // Still held by another channel / input (Omni): nothing changes.
    if (!v.notes.remove(note)) return;
    if (!v.notes.size) {
      this.gateOff(v);
    } else if (wasTop) {
      v.freq = midiNoteFreq(v.notes.top, v.params.octave);
      v.vel = velocityGain(v.notes.topVelocity);
      this.synthNote(v, v.notes.topVelocity / 127, true, false);
      this.resolvePitch(v);
    }
  }

  /** All notes off on a voice (-1: every voice): forget held keys and release. */
  midiAllNotesOff(voiceId: number): void {
    for (const v of this.voices) {
      if (v.removing || (voiceId >= 0 && v.params.id !== voiceId) || !v.notes.size) continue;
      v.notes.clear();
      this.gateOff(v);
    }
  }

  /**
   * MIDI-controller parameter change (position, LFO, level, synth params): merged into the
   * voice's params without a full voice/set (the main thread's model catches up at frame rate).
   */
  patchVoice(voiceId: number, patch: VoicePatch): void {
    const v = this.findVoice(voiceId);
    if (v) this.applyParams(v, { ...applyVoicePatch(v.params, patch), id: v.params.id });
  }

  /** Pitch bend in semitones (smoothed: no zipper noise). Applies to sequencer notes too. */
  setPitchBend(voiceId: number, semitones: number): void {
    const v = this.findVoice(voiceId);
    if (v) v.bendTarget = semitones;
  }

  applyMidi(ev: MidiVoiceEvent): void {
    switch (ev.type) {
      case 'noteOn':
        return this.midiNoteOn(ev.voiceId, ev.note, ev.velocity);
      case 'noteOff':
        return this.midiNoteOff(ev.voiceId, ev.note);
      case 'allNotesOff':
        return this.midiAllNotesOff(ev.voiceId);
      case 'bend':
        return this.setPitchBend(ev.voiceId, ev.semitones);
      case 'mod':
      case 'pressure': {
        const v = this.findVoice(ev.voiceId);
        if (v) v[ev.type === 'mod' ? 'wheel' : 'pressure'] = Math.max(0, Math.min(1, ev.value));
        return;
      }
    }
  }

  status(out: EngineStatus): EngineStatus {
    out.tick = this.tick;
    out.playing = this.playing;
    out.voices.length = this.voices.length;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      const o =
        out.voices[i] ?? (out.voices[i] = { id: 0, pos: 0, posY: 0, index: 0, y: 0, env: 0, note: -1, posB: 0, posYB: 0, indexB: 0, yB: 0 });
      o.id = v.params.id;
      const syn = v.params.type === 'synth' ? v.syn : null;
      if (syn) {
        o.pos = syn.posA;
        o.posY = syn.posYA;
        o.index = syn.a.index;
        o.y = syn.a.indexY;
        o.posB = syn.posB;
        o.posYB = syn.posYB;
        o.indexB = syn.b.index;
        o.yB = syn.b.indexY;
      } else {
        o.pos = o.posB = v.pos;
        o.posY = o.posYB = v.posY;
        o.index = o.indexB = v.osc.index;
        o.y = o.yB = v.osc.indexY;
      }
      o.env = v.env.value;
      o.note = v.notes.top;
    }
    return out;
  }

  // ---- audio ----

  /**
   * Render `frames` samples: stereo into out (left) and outR (right), or, without outR,
   * the mono sum ((L + R) / 2) into out. Simple voices are identical in both channels.
   *
   * The sequencer clock: one fractional sample accumulator per eighth note (exactly the
   * arithmetic the eighth-note-only sequencer used, so 1/8 sequences fire on the same
   * samples as before), split into TICKS_PER_EIGHTH ticks by thresholds within the
   * eighth. Every sequence steps on the ticks that are multiples of its STEP_TICKS, all
   * counted from the transport start, so different step lengths stay bar-aligned and a
   * step length change takes effect on the next boundary of the new grid.
   */
  process(out: Float32Array, frames: number, outR?: Float32Array): void {
    const sr = this.sampleRate;
    const eighthLen = stepSamples(this.bpm, sr, '1/8');
    for (let i = 0; i < frames; i++) {
      if (this.ctrlCountdown <= 0) {
        this.control(CONTROL_BLOCK);
        this.ctrlCountdown = CONTROL_BLOCK;
      }
      const blockT = 1 - this.ctrlCountdown / CONTROL_BLOCK;
      this.ctrlCountdown--;

      if (this.playing) {
        if (this.toNext <= 0) {
          this.toNext += eighthLen;
          this.eighthLen = eighthLen;
          this.sub = 0;
          this.tick++;
          this.triggerTick();
        } else if (this.sub < TICKS_PER_EIGHTH - 1 && this.toNext <= (this.eighthLen * (TICKS_PER_EIGHTH - 1 - this.sub)) / TICKS_PER_EIGHTH) {
          // Tick `sub + 1` of this eighth is due (sub/6 of the way through it).
          this.sub++;
          this.tick++;
          this.triggerTick();
        }
        this.toNext--;
      }

      let left = 0;
      let right = 0;
      for (let k = 0; k < this.voices.length; k++) {
        const v = this.voices[k];
        if (v.syn === null || (v.typeMix === 0 && v.params.type !== 'synth')) {
          const s = this.renderVoiceSample(v, blockT, sr);
          left += s;
          right += s;
        } else {
          this.renderMixed(v, blockT, sr);
          left += this.outL;
          right += this.outR;
        }
      }
      if (outR) {
        out[i] = left * MASTER_GAIN;
        outR[i] = right * MASTER_GAIN;
      } else out[i] = (left + right) * 0.5 * MASTER_GAIN;
    }
  }

  /** Fire the steps of every sequence whose grid has a boundary on this tick. */
  private triggerTick(): void {
    for (const s of this.sequences) {
      if (s.voiceId === null || s.length <= 0) continue;
      const len = stepLengthOf(s);
      const ticks = STEP_TICKS[len];
      if (this.tick % ticks !== 0) continue;
      const row = s.steps[(this.tick / ticks) % s.length];
      if (row === undefined || row < 0) continue;
      const v = this.findVoice(s.voiceId);
      if (!v || v.notes.size) continue;
      this.noteOn(s.voiceId, noteFreq(row, v.params.octave), stepSamples(this.bpm, this.sampleRate, len) * s.gate);
    }
  }

  private control(blockLen: number): void {
    if (this.voices.some((v) => v.removing && v.env.stage === IDLE)) {
      this.voices = this.voices.filter((v) => !(v.removing && v.env.stage === IDLE));
    }
    for (const v of this.voices) {
      v.lfoPhase += (2 * Math.PI * v.params.lfoRate * blockLen) / this.sampleRate;
      if (v.lfoPhase > 2 * Math.PI) v.lfoPhase -= 2 * Math.PI;
      v.lfoPhaseY += (2 * Math.PI * v.params.lfoRateY * blockLen) / this.sampleRate;
      if (v.lfoPhaseY > 2 * Math.PI) v.lfoPhaseY -= 2 * Math.PI;
      // Pitch bend: one-pole per block, ramped linearly across it in renderVoiceSample.
      if (v.bendSemis !== v.bendTarget || v.bendFrom !== v.bendTo) {
        v.bendSemis += (v.bendTarget - v.bendSemis) * this.bendCoef;
        if (Math.abs(v.bendTarget - v.bendSemis) < 1e-4) v.bendSemis = v.bendTarget;
        v.bendFrom = v.bendTo;
        v.bendTo = Math.pow(2, v.bendSemis / 12);
      }
      const synthOnly = v.params.type === 'synth' && v.typeMix === 1;
      if (!synthOnly) this.resolve(v);
      if (v.syn && (v.params.type === 'synth' || v.typeMix > 0)) this.controlSynth(v, blockLen);
    }
  }

  private controlSynth(v: VoiceRuntime, blockLen: number): void {
    const p = v.params;
    const s = p.synth;
    const c = this.ctl;
    c.bend = v.bendSemis;
    c.blockLen = blockLen;
    c.wtA = this.wavetables.get(p.wavetableId);
    c.wtB = this.wavetables.get(s.b.wavetableId);
    c.slew = this.slew;
    c.gainTarget = p.mute ? 0 : p.level * (1 - s.velAmp + s.velAmp * v.vel);
    c.bpm = this.bpm;
    c.wheel = v.wheel;
    c.pressure = v.pressure;
    v.syn!.control(p, c);

  }

  /** Mip level for the voice's current pitch (a new note mid-block keeps the block's mix). */
  private resolvePitch(v: VoiceRuntime): void {
    v.osc.mipLevel = mipLevelFor(v.freq * Math.max(v.bendFrom, v.bendTo), this.sampleRate);
    if (v.osc.n === 0) this.resolve(v);
  }

  /** Recompute positions, mip level and this block's table mix for a (Simple) voice. */
  private resolve(v: VoiceRuntime): void {
    const p = v.params;
    const wt = this.wavetables.get(p.wavetableId);
    v.pos = modulatedPosition(p.position, p.lfoDepth, v.lfoPhase);
    v.posY = modulatedPosition(p.positionY, p.lfoDepthY, v.lfoPhaseY);
    v.osc.mipLevel = mipLevelFor(v.freq * Math.max(v.bendFrom, v.bendTo), this.sampleRate);
    // The previous block's end weights are this block's start weights.
    v.osc.hold();
    if (!wt) return;
    v.osc.resolve(this.tables, wt, p.windowStart, p.windowEnd, p.windowStartY, p.windowEndY, v.pos, v.posY, this.slew);
  }

  /** The Simple voice: gate countdown, amp envelope, then its oscillator. */
  private renderVoiceSample(v: VoiceRuntime, blockT: number, sr: number): number {
    if (v.gateRemaining > 0 && --v.gateRemaining === 0) this.gateOff(v);
    const e = v.env.next();
    return this.simpleSample(v, e, blockT, sr);
  }

  private simpleSample(v: VoiceRuntime, e: number, blockT: number, sr: number): number {
    const target = v.params.mute ? 0 : v.params.level * v.vel;
    v.gain += (target - v.gain) * 0.002;
    const o = v.osc;
    let out = 0;
    if (e > 0 && o.n > 0) {
      out = o.read(o.phase, blockT);
      out *= e * v.gain;
    }
    o.phase += (v.freq * (v.bendFrom + (v.bendTo - v.bendFrom) * blockT)) / sr;
    if (o.phase >= 1) {
      o.phase -= Math.floor(o.phase);
      o.wrapped(this.tables);
    }
    return out;
  }

  /**
   * A Synth voice (or one crossfading between Simple and Synth): stereo into outL / outR.
   * The amp envelope and gate are shared by both paths.
   */
  private renderMixed(v: VoiceRuntime, blockT: number, sr: number): void {
    if (v.gateRemaining > 0 && --v.gateRemaining === 0) this.gateOff(v);
    const e = v.env.next();
    const target = v.params.type === 'synth' ? 1 : 0;
    if (v.typeMix < target) v.typeMix = Math.min(1, v.typeMix + this.typeStep);
    else if (v.typeMix > target) v.typeMix = Math.max(0, v.typeMix - this.typeStep);
    const m = v.typeMix;
    const syn = v.syn!;
    let simple = 0;
    if (m < 1) simple = this.simpleSample(v, e, blockT, sr) * (1 - m);
    let l = simple;
    let r = simple;
    if (m > 0) {
      const y = syn.render(v.params, e, blockT, this.tables) * m;
      l += y * (syn.panL0 + (syn.panL1 - syn.panL0) * blockT);
      r += y * (syn.panR0 + (syn.panR1 - syn.panR0) * blockT);
    }
    this.outL = l;
    this.outR = r;
  }
}

export function emptyStatus(): EngineStatus {
  return { tick: -1, playing: false, voices: [] };
}
