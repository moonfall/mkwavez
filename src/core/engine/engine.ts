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
import { Mix, resolveMix, type PackedWavetable } from '../wavetablePlayback';
import { Adsr } from './adsr';
import { NoteStack } from './noteStack';

export const MASTER_GAIN = 0.22;

/** Release time used when a voice is removed while sounding (avoids a click). */
export const REMOVE_RELEASE_SEC = 0.012;

/** Pitch-bend smoothing time constant (one-pole per control block, ramped within it). */
export const BEND_SMOOTH_SEC = 0.004;

const IDLE = 0;
/** Tables a voice can be crossfading at once: this block's mix (<= 4) plus the previous one fading out. */
const MAX_LIVE = 8;

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
  /** LFO on the Y position. */
  lfoPhaseY: number;
  /** Modulated positions 0..1 and the coordinates they resolve to (for the UI). */
  pos = 0;
  posY = 0;
  index = 0;
  indexY = 0;
  mipLevel = 0;
  /** Interpolation of the voice's wavetable at the last resolve. */
  step = false;
  /**
   * Tables being mixed, tracked by table id (not wavetable index) so a wavetable re-index
   * (eviction) never changes what is playing. Each entry's weight ramps linearly from
   * w0 (block start) to w1 (block end): a table entering the mix ramps up from 0, one
   * leaving ramps down to 0, so any window / table / position change is click-free.
   */
  n = 0;
  ids = new Int32Array(MAX_LIVE);
  tabs: (MipSet | null)[] = new Array<MipSet | null>(MAX_LIVE).fill(null);
  w0 = new Float64Array(MAX_LIVE);
  w1 = new Float64Array(MAX_LIVE);
  /** Double buffers for building the next block's entries without allocating. */
  nIds = new Int32Array(MAX_LIVE);
  nTabs: (MipSet | null)[] = new Array<MipSet | null>(MAX_LIVE).fill(null);
  nW0 = new Float64Array(MAX_LIVE);
  nW1 = new Float64Array(MAX_LIVE);
  readonly mix = new Mix();
  readonly win = { x0: 0, x1: 0, y0: 0, y1: 0 };
  /** Step mode: the held table (kept until the oscillator wraps) and the pending target. */
  heldId: TableId = -1;
  heldTable: MipSet | null = null;
  targetId: TableId = -1;
  /** Fading out before removal. */
  removing = false;

  constructor(p: VoiceParams, sampleRate: number) {
    this.params = p;
    this.lfoPhase = p.lfoPhase;
    this.lfoPhaseY = p.lfoPhaseY;
    this.env.configure(p.attack, p.decay, p.sustain, p.release, sampleRate);
  }
}

export interface EngineStatus {
  /** Absolute sequencer step counter (-1 before the first step). */
  step: number;
  playing: boolean;
  /**
   * Per voice: modulated positions (pos, posY: 0..1), the coordinates they resolve to in
   * the wavetable (index = x along the row, y = row; the chosen cell in Step), envelope
   * level, and `note`: the MIDI note it plays (top of its held stack), or -1.
   */
  voices: { id: number; pos: number; posY: number; index: number; y: number; env: number; note: number }[];
}

export class SynthEngine {
  readonly sampleRate: number;
  private tables = new Map<TableId, MipSet>();
  private wavetables = new Map<WavetableId, PackedWavetable>();
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
    v.params = p;
    v.env.configure(p.attack, p.decay, p.sustain, p.release, this.sampleRate);
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
    v.notes.push(note, velocity);
    v.freq = midiNoteFreq(note, v.params.octave);
    v.vel = velocityGain(velocity);
    v.gateRemaining = 0;
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
      v.env.gateOff();
    } else if (wasTop) {
      v.freq = midiNoteFreq(v.notes.top, v.params.octave);
      v.vel = velocityGain(v.notes.topVelocity);
      this.resolvePitch(v);
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
      const o = out.voices[i] ?? (out.voices[i] = { id: 0, pos: 0, posY: 0, index: 0, y: 0, env: 0, note: -1 });
      o.id = v.params.id;
      o.pos = v.pos;
      o.posY = v.posY;
      o.index = v.index;
      o.y = v.indexY;
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
      v.lfoPhaseY += (2 * Math.PI * v.params.lfoRateY * blockLen) / this.sampleRate;
      if (v.lfoPhaseY > 2 * Math.PI) v.lfoPhaseY -= 2 * Math.PI;
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

  /** Mip level for the voice's current pitch (a new note mid-block keeps the block's mix). */
  private resolvePitch(v: VoiceRuntime): void {
    v.mipLevel = mipLevelFor(v.freq * Math.max(v.bendFrom, v.bendTo), this.sampleRate);
    if (v.n === 0) this.resolve(v);
  }

  /** Recompute positions, mip level and this block's table mix for a voice. */
  private resolve(v: VoiceRuntime): void {
    const p = v.params;
    const wt = this.wavetables.get(p.wavetableId);
    v.pos = modulatedPosition(p.position, p.lfoDepth, v.lfoPhase);
    v.posY = modulatedPosition(p.positionY, p.lfoDepthY, v.lfoPhaseY);
    v.mipLevel = mipLevelFor(v.freq * Math.max(v.bendFrom, v.bendTo), this.sampleRate);
    // The previous block's end weights are this block's start weights.
    this.hold(v);
    if (!wt) return;
    const win = v.win;
    win.x0 = p.windowStart;
    win.x1 = p.windowEnd;
    win.y0 = p.windowStartY;
    win.y1 = p.windowEndY;
    v.step = wt.interp === 'step';
    const mix = resolveMix(wt, win, v.pos, v.posY, v.step, v.mix);
    if (mix.n === 0) return; // nothing to address: keep whatever was playing
    v.index = mix.x;
    v.indexY = mix.y;
    if (v.step) {
      v.targetId = mix.ids[0];
      if (v.heldId < 0) v.heldId = v.targetId;
      // Late-arriving table: pick it up; otherwise keep the previous pointer.
      const t = this.tables.get(v.heldId);
      if (t) v.heldTable = t;
      if (!v.heldTable) return;
      for (let k = 1; k < v.n; k++) v.tabs[k] = null;
      v.n = 1;
      v.ids[0] = v.heldId;
      v.tabs[0] = v.heldTable;
      v.w0[0] = v.w1[0] = 1;
      return;
    }
    v.heldId = v.targetId = -1;
    v.heldTable = null;
    // Tables that haven't arrived yet drop out (the rest renormalised); none: hold.
    let total = 0;
    let missing = false;
    for (let k = 0; k < mix.n; k++) {
      if (this.tables.has(mix.ids[k])) total += mix.w[k];
      else missing = true;
    }
    if (total <= 0) return;
    const norm = missing ? 1 / total : 1;
    const first = v.n === 0;
    let m = 0;
    // Entries already playing ramp from their weight to the new one (0 if leaving).
    for (let k = 0; k < v.n; k++) {
      const id = v.ids[k];
      let w = 0;
      for (let j = 0; j < mix.n; j++) if (mix.ids[j] === id) w = mix.w[j] * norm;
      if (w === 0 && v.w0[k] === 0) continue;
      v.nIds[m] = id;
      v.nTabs[m] = v.tabs[k];
      v.nW0[m] = v.w0[k];
      v.nW1[m] = w;
      m++;
    }
    // New entries ramp up from 0 (start at their weight on the voice's first resolve).
    for (let j = 0; j < mix.n && m < MAX_LIVE; j++) {
      const id = mix.ids[j];
      const t = this.tables.get(id);
      if (!t) continue;
      let known = false;
      for (let k = 0; k < m; k++) if (v.nIds[k] === id) known = true;
      if (known) continue;
      const w = mix.w[j] * norm;
      v.nIds[m] = id;
      v.nTabs[m] = t;
      v.nW0[m] = first ? w : 0;
      v.nW1[m] = w;
      m++;
    }
    this.swap(v, m);
  }

  /** Keep the current mix without ramping (block start = previous block end). */
  private hold(v: VoiceRuntime): void {
    for (let k = 0; k < v.n; k++) v.w0[k] = v.w1[k];
  }

  private swap(v: VoiceRuntime, m: number): void {
    const ids = v.ids;
    const tabs = v.tabs;
    const w0 = v.w0;
    const w1 = v.w1;
    v.ids = v.nIds;
    v.tabs = v.nTabs;
    v.w0 = v.nW0;
    v.w1 = v.nW1;
    v.nIds = ids;
    v.nTabs = tabs;
    v.nW0 = w0;
    v.nW1 = w1;
    for (let k = 0; k < MAX_LIVE; k++) v.nTabs[k] = null;
    for (let k = m; k < MAX_LIVE; k++) v.tabs[k] = null;
    v.n = m;
  }

  private renderVoiceSample(v: VoiceRuntime, blockT: number, sr: number): number {
    if (v.gateRemaining > 0 && --v.gateRemaining === 0) v.env.gateOff();
    const e = v.env.next();
    const target = v.params.mute ? 0 : v.params.level * v.vel;
    v.gain += (target - v.gain) * 0.002;

    let out = 0;
    if (e > 0 && v.n > 0) {
      const off = MIP_OFFSETS[v.mipLevel];
      const len = MIP_LENGTHS[v.mipLevel];
      const x = v.phase * len;
      const k = x | 0;
      const fr = x - k;
      const k1 = off + k;
      const k2 = k + 1 === len ? off : k1 + 1;
      for (let j = 0; j < v.n; j++) {
        const T = v.tabs[j]!;
        const a0 = T[k1];
        const w = v.w0[j] + (v.w1[j] - v.w0[j]) * blockT;
        out += (a0 + (T[k2] - a0) * fr) * w;
      }
      out *= e * v.gain;
    }

    v.phase += (v.freq * (v.bendFrom + (v.bendTo - v.bendFrom) * blockT)) / sr;
    if (v.phase >= 1) {
      v.phase -= Math.floor(v.phase);
      if (v.step && v.targetId >= 0 && v.heldId !== v.targetId) {
        const t = this.tables.get(v.targetId);
        if (t) {
          v.heldId = v.targetId;
          v.heldTable = t;
          for (let j = 1; j < v.n; j++) v.tabs[j] = null;
          v.n = 1;
          v.ids[0] = v.heldId;
          v.tabs[0] = t;
          v.w0[0] = v.w1[0] = 1;
        }
      }
    }
    return out;
  }
}

export function emptyStatus(): EngineStatus {
  return { step: -1, playing: false, voices: [] };
}
