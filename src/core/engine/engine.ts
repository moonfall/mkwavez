/**
 * The synth engine: everything that runs on the audio thread. No DOM, no WebAudio,
 * no allocation in process() (apart from Map lookups). The AudioWorklet is a thin
 * message adapter around this class; a native port would mirror it 1:1.
 */
import { CONTROL_BLOCK, MIP_LENGTHS, MIP_OFFSETS } from '../constants';
import { mipLevelFor, type MipSet } from '../mipmap';
import { noteFreq, type SequenceData, stepSamples } from '../sequence';
import type { TableId } from '../table';
import { DEFAULT_VOICE, modulatedPosition, type VoiceParams } from '../voice';
import type { WavetableId } from '../wavetable';
import { Adsr } from './adsr';

export const MASTER_GAIN = 0.22;

const EMPTY_IDS = new Int32Array(0);

class VoiceRuntime {
  params: VoiceParams;
  readonly env = new Adsr();
  phase = 0;
  lfoPhase: number;
  freq = 110;
  gateRemaining = 0;
  gain = 0;
  /** Modulated position 0..1 and float index into the wavetable (for the UI). */
  pos = 0;
  index = 0;
  // Resolved tables for this control block.
  mipLevel = 0;
  tableA: MipSet | null = null;
  tableB: MipSet | null = null;
  frac = 0;
  fracPrev = 0;
  pairKey = -1;
  /** Step mode: wavetable index of the held table (-1 = none) and the pending target. */
  heldIndex = -1;
  targetIndex = 0;

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
  voices: { id: number; pos: number; index: number; env: number }[];
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

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
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

  setVoice(p: VoiceParams): void {
    const v = this.voices.find((x) => x.params.id === p.id);
    if (!v) {
      this.voices.push(new VoiceRuntime({ ...DEFAULT_VOICE, ...p }, this.sampleRate));
      return;
    }
    v.params = p;
    v.env.configure(p.attack, p.decay, p.sustain, p.release, this.sampleRate);
    if (p.interp === 'blend') v.heldIndex = -1;
  }

  removeVoice(id: number): void {
    this.voices = this.voices.filter((v) => v.params.id !== id);
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
    if (!playing && this.playing) for (const v of this.voices) v.env.gateOff();
    this.playing = playing;
  }

  noteOn(voiceId: number, freq: number, gateSamples: number): void {
    const v = this.voices.find((x) => x.params.id === voiceId);
    if (!v) return;
    v.freq = freq;
    v.gateRemaining = Math.max(1, Math.round(gateSamples));
    v.env.gateOn();
    this.resolve(v);
  }

  status(out: EngineStatus): EngineStatus {
    out.step = this.step;
    out.playing = this.playing;
    out.voices.length = this.voices.length;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      const o = out.voices[i] ?? (out.voices[i] = { id: 0, pos: 0, index: 0, env: 0 });
      o.id = v.params.id;
      o.pos = v.pos;
      o.index = v.params.interp === 'step' && v.heldIndex >= 0 ? v.heldIndex : v.index;
      o.env = v.env.value;
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
      const v = this.voices.find((x) => x.params.id === s.voiceId);
      if (!v) continue;
      this.noteOn(s.voiceId, noteFreq(row, v.params.octave), stepLen * s.gate);
    }
  }

  private control(blockLen: number): void {
    for (const v of this.voices) {
      v.lfoPhase += (2 * Math.PI * v.params.lfoRate * blockLen) / this.sampleRate;
      if (v.lfoPhase > 2 * Math.PI) v.lfoPhase -= 2 * Math.PI;
      this.resolve(v);
    }
  }

  /** Recompute position, mip level and table pointers for a voice. */
  private resolve(v: VoiceRuntime): void {
    const p = v.params;
    const ids = this.wavetables.get(p.wavetableId) ?? EMPTY_IDS;
    v.pos = modulatedPosition(p.position, p.lfoDepth, v.lfoPhase);
    v.mipLevel = mipLevelFor(v.freq, this.sampleRate);
    if (ids.length === 0) {
      v.tableA = v.tableB = null;
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
      v.targetIndex = Math.round(f);
      if (v.heldIndex < 0 || v.heldIndex > max) v.heldIndex = v.targetIndex;
      v.tableA = v.tableB = this.tables.get(ids[v.heldIndex]) ?? null;
      v.frac = v.fracPrev = 0;
      v.pairKey = -1;
      return;
    }
    const i = Math.floor(f);
    const j = Math.min(i + 1, b);
    const key = i * 65536 + j;
    v.fracPrev = key === v.pairKey ? v.frac : f - i;
    v.pairKey = key;
    v.frac = f - i;
    v.tableA = this.tables.get(ids[i]) ?? null;
    v.tableB = this.tables.get(ids[j]) ?? null;
  }

  private renderVoiceSample(v: VoiceRuntime, blockT: number, sr: number): number {
    if (v.gateRemaining > 0 && --v.gateRemaining === 0) v.env.gateOff();
    const e = v.env.next();
    const target = v.params.mute ? 0 : v.params.level;
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

    v.phase += v.freq / sr;
    if (v.phase >= 1) {
      v.phase -= Math.floor(v.phase);
      if (v.params.interp === 'step' && v.heldIndex !== v.targetIndex) {
        v.heldIndex = v.targetIndex;
        const ids = this.wavetables.get(v.params.wavetableId);
        v.tableA = v.tableB = ids ? (this.tables.get(ids[v.heldIndex]) ?? null) : null;
      }
    }
    return out;
  }
}

export function emptyStatus(): EngineStatus {
  return { step: -1, playing: false, voices: [] };
}
