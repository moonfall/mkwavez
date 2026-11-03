/**
 * The synth engine: everything that runs on the audio thread. No DOM, no WebAudio,
 * no allocation in process() (apart from Map lookups). The AudioWorklet is a thin
 * message adapter around this class; a native port would mirror it 1:1.
 */
import { CONTROL_BLOCK, MIP_LENGTHS, MIP_OFFSETS } from '../constants';
import { midiNoteFreq, type MidiVoiceEvent, velocityGain } from '../midi';
import { mipLevelFor, type MipSet } from '../mipmap';
import { noteFreq, type SequenceData, stepSamples } from '../sequence';
import type { TableId } from '../table';
import { DEFAULT_VOICE, modulatedPosition, type VoiceParams } from '../voice';
import type { WavetableId } from '../wavetable';
import { Adsr } from './adsr';
import { NoteStack } from './noteStack';

export const MASTER_GAIN = 0.22;

/** Release time used when a voice is removed while sounding (avoids a click). */
export const REMOVE_RELEASE_SEC = 0.012;

/** Pitch-bend smoothing time constant (one-pole per control block, ramped within it). */
export const BEND_SMOOTH_SEC = 0.004;

const EMPTY_IDS = new Int32Array(0);
const IDLE = 0;

class VoiceRuntime {
  params: VoiceParams;
  readonly env = new Adsr();
  phase = 0;
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
  /** Modulated position 0..1 and float index into the wavetable (for the UI). */
  pos = 0;
  index = 0;
  // Resolved tables for this control block, tracked by table id (not wavetable index)
  // so a wavetable re-index (eviction) never changes what is playing.
  mipLevel = 0;
  idA: TableId = -1;
  idB: TableId = -1;
  tableA: MipSet | null = null;
  tableB: MipSet | null = null;
  frac = 0;
  fracPrev = 0;
  /** Step mode: the held table (kept until the oscillator wraps) and the pending target. */
  heldId: TableId = -1;
  heldTable: MipSet | null = null;
  targetId: TableId = -1;
  /** Fading out before removal. */
  removing = false;

  constructor(p: VoiceParams, sampleRate: number) {
    this.params = p;
    this.lfoPhase = p.lfoPhase;
    this.env.configure(p.attack, p.decay, p.sustain, p.release, sampleRate);
  }
}

export interface EngineStatus {
  /** Absolute sequencer step counter (-1 before the first step). */
  step: number;
  playing: boolean;
  /** `note`: the MIDI note a voice plays (top of its held stack), or -1. */
  voices: { id: number; pos: number; index: number; env: number; note: number }[];
}

export class SynthEngine {
  readonly sampleRate: number;
  private tables = new Map<TableId, MipSet>();
  private wavetables = new Map<WavetableId, Int32Array>();
  private voices: VoiceRuntime[] = [];
  private sequences: SequenceData[] = [];
  private playing = false;
  private bpm = 132;
  private step = -1;
  private toNext = 0;
  private ctrlCountdown = 0;
  private readonly bendCoef: number;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.bendCoef = 1 - Math.exp(-CONTROL_BLOCK / (BEND_SMOOTH_SEC * sampleRate));
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

  setWavetable(id: WavetableId, ids: Int32Array): void {
    this.wavetables.set(id, ids);
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
    v.params = p;
    v.env.configure(p.attack, p.decay, p.sustain, p.release, this.sampleRate);
    if (p.interp === 'blend') {
      v.heldId = -1;
      v.heldTable = null;
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
    v.env.gateOff();
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
      this.step = -1;
      this.toNext = 0;
    }
    // Stopping releases sequencer notes; held MIDI keys keep sounding.
    if (!playing && this.playing) for (const v of this.voices) if (!v.notes.size) v.env.gateOff();
    this.playing = playing;
  }

  /** A sequencer note (full velocity, gated). Ignored while MIDI keys are held on the voice. */
  noteOn(voiceId: number, freq: number, gateSamples: number): void {
    const v = this.findVoice(voiceId);
    if (!v || v.notes.size) return;
    v.freq = freq;
    v.vel = 1;
    v.gateRemaining = Math.max(1, Math.round(gateSamples));
    v.env.gateOn();
    this.resolve(v);
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
    v.notes.push(note, velocity);
    v.freq = midiNoteFreq(note, v.params.octave);
    v.vel = velocityGain(velocity);
    v.gateRemaining = 0;
    v.env.gateOn();
    this.resolve(v);
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
      v.env.gateOff();
    } else if (wasTop) {
      v.freq = midiNoteFreq(v.notes.top, v.params.octave);
      v.vel = velocityGain(v.notes.topVelocity);
      this.resolve(v);
    }
  }

  /** All notes off on a voice (-1: every voice): forget held keys and release. */
  midiAllNotesOff(voiceId: number): void {
    for (const v of this.voices) {
      if (v.removing || (voiceId >= 0 && v.params.id !== voiceId) || !v.notes.size) continue;
      v.notes.clear();
      v.env.gateOff();
    }
  }

  /**
   * MIDI-controller parameter change (position, LFO, level): merged into the voice's
   * params without a full voice/set (the main thread's model catches up at frame rate).
   */
  patchVoice(voiceId: number, patch: Partial<VoiceParams>): void {
    const v = this.findVoice(voiceId);
    if (v) v.params = { ...v.params, ...patch, id: v.params.id };
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
    }
  }

  status(out: EngineStatus): EngineStatus {
    out.step = this.step;
    out.playing = this.playing;
    out.voices.length = this.voices.length;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      const o = out.voices[i] ?? (out.voices[i] = { id: 0, pos: 0, index: 0, env: 0, note: -1 });
      o.id = v.params.id;
      o.pos = v.pos;
      o.index = v.params.interp === 'step' ? Math.round(v.index) : v.index;
      o.env = v.env.value;
      o.note = v.notes.top;
    }
    return out;
  }

  // ---- audio ----

  /** Render `frames` mono samples into out[0..frames). */
  process(out: Float32Array, frames: number): void {
    const sr = this.sampleRate;
    const stepLen = stepSamples(this.bpm, sr);
    for (let i = 0; i < frames; i++) {
      if (this.ctrlCountdown <= 0) {
        this.control(CONTROL_BLOCK);
        this.ctrlCountdown = CONTROL_BLOCK;
      }
      const blockT = 1 - this.ctrlCountdown / CONTROL_BLOCK;
      this.ctrlCountdown--;

      if (this.playing) {
        if (this.toNext <= 0) {
          this.step++;
          this.toNext += stepLen;
          this.triggerStep(stepLen);
        }
        this.toNext--;
      }

      let mix = 0;
      for (let k = 0; k < this.voices.length; k++) {
        mix += this.renderVoiceSample(this.voices[k], blockT, sr);
      }
      out[i] = mix * MASTER_GAIN;
    }
  }

  private triggerStep(stepLen: number): void {
    for (const s of this.sequences) {
      if (s.voiceId === null || s.length <= 0) continue;
      const row = s.steps[this.step % s.length];
      if (row === undefined || row < 0) continue;
      const v = this.findVoice(s.voiceId);
      if (!v || v.notes.size) continue;
      this.noteOn(s.voiceId, noteFreq(row, v.params.octave), stepLen * s.gate);
    }
  }

  private control(blockLen: number): void {
    if (this.voices.some((v) => v.removing && v.env.stage === IDLE)) {
      this.voices = this.voices.filter((v) => !(v.removing && v.env.stage === IDLE));
    }
    for (const v of this.voices) {
      v.lfoPhase += (2 * Math.PI * v.params.lfoRate * blockLen) / this.sampleRate;
      if (v.lfoPhase > 2 * Math.PI) v.lfoPhase -= 2 * Math.PI;
      // Pitch bend: one-pole per block, ramped linearly across it in renderVoiceSample.
      if (v.bendSemis !== v.bendTarget || v.bendFrom !== v.bendTo) {
        v.bendSemis += (v.bendTarget - v.bendSemis) * this.bendCoef;
        if (Math.abs(v.bendTarget - v.bendSemis) < 1e-4) v.bendSemis = v.bendTarget;
        v.bendFrom = v.bendTo;
        v.bendTo = Math.pow(2, v.bendSemis / 12);
      }
      this.resolve(v);
    }
  }

  /** Recompute position, mip level and table pointers for a voice. */
  private resolve(v: VoiceRuntime): void {
    const p = v.params;
    const ids = this.wavetables.get(p.wavetableId) ?? EMPTY_IDS;
    v.pos = modulatedPosition(p.position, p.lfoDepth, v.lfoPhase);
    v.mipLevel = mipLevelFor(v.freq * Math.max(v.bendFrom, v.bendTo), this.sampleRate);
    if (ids.length === 0) {
      // Nothing to address: keep whatever was playing (fades with the envelope).
      v.index = 0;
      return;
    }
    const max = ids.length - 1;
    let a = Math.max(0, Math.min(max, p.windowStart));
    let b = Math.max(0, Math.min(max, p.windowEnd));
    if (a > b) {
      const t = a;
      a = b;
      b = t;
    }
    const f = a + v.pos * (b - a);
    v.index = f;
    if (p.interp === 'step') {
      v.targetId = ids[Math.round(f)];
      if (v.heldId < 0) v.heldId = v.targetId;
      // Late-arriving table: pick it up; otherwise keep the previous pointer.
      if (!v.heldTable || v.heldId !== v.idA) {
        v.heldTable = this.tables.get(v.heldId) ?? v.heldTable;
        v.idA = v.idB = v.heldId;
      }
      v.tableA = v.tableB = v.heldTable;
      v.frac = v.fracPrev = 0;
      return;
    }
    const i = Math.floor(f);
    const j = Math.min(i + 1, b);
    const idA = ids[i];
    const idB = ids[j];
    const frac = f - i;
    // Ramp the crossfade only while the pair is unchanged (by table id).
    v.fracPrev = idA === v.idA && idB === v.idB ? v.frac : frac;
    v.frac = frac;
    // A table that has not arrived yet holds the previous pointer instead of going silent.
    const tA = this.tables.get(idA);
    const tB = this.tables.get(idB);
    if (tA) {
      v.tableA = tA;
      v.idA = idA;
    }
    if (tB) {
      v.tableB = tB;
      v.idB = idB;
    }
  }

  private renderVoiceSample(v: VoiceRuntime, blockT: number, sr: number): number {
    if (v.gateRemaining > 0 && --v.gateRemaining === 0) v.env.gateOff();
    const e = v.env.next();
    const target = v.params.mute ? 0 : v.params.level * v.vel;
    v.gain += (target - v.gain) * 0.002;

    let out = 0;
    const A = v.tableA ?? v.tableB;
    const B = v.tableB ?? v.tableA;
    if (e > 0 && A && B) {
      const off = MIP_OFFSETS[v.mipLevel];
      const len = MIP_LENGTHS[v.mipLevel];
      const x = v.phase * len;
      const k = x | 0;
      const fr = x - k;
      const k2 = k + 1 === len ? 0 : k + 1;
      const a0 = A[off + k];
      const va = a0 + (A[off + k2] - a0) * fr;
      if (A === B) {
        out = va;
      } else {
        const b0 = B[off + k];
        const vb = b0 + (B[off + k2] - b0) * fr;
        const t = v.fracPrev + (v.frac - v.fracPrev) * blockT;
        out = va + (vb - va) * t;
      }
      out *= e * v.gain;
    }

    v.phase += (v.freq * (v.bendFrom + (v.bendTo - v.bendFrom) * blockT)) / sr;
    if (v.phase >= 1) {
      v.phase -= Math.floor(v.phase);
      if (v.params.interp === 'step' && v.targetId >= 0 && v.heldId !== v.targetId) {
        const t = this.tables.get(v.targetId);
        if (t) {
          v.heldId = v.idA = v.idB = v.targetId;
          v.heldTable = v.tableA = v.tableB = t;
        }
      }
    }
    return out;
  }
}

export function emptyStatus(): EngineStatus {
  return { step: -1, playing: false, voices: [] };
}
