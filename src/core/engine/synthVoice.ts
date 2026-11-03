/**
 * The Synth voice's signal path (one monophonic voice; the engine owns note handling, the
 * amplitude envelope and the Simple ↔ Synth crossfade):
 *
 *   osc A (wavetable) ─┐
 *   osc B (wavetable) ─┤
 *   sub (sine / square, −1 / −2 oct from A) ─┤ mixer ─► drive ─► multimode ZDF filter ─► amp
 *   noise (white / pink, seeded) ─┤
 *   ring (A × B) ──────┘
 *
 * Pitch (glide, bend, oscillator tuning, pitch envelope) and the mixer / filter controls are
 * computed once per control block and ramped linearly across it; the filter envelope runs
 * per sample, so the cutoff is recomputed (and smooth) every sample. Fixed state, no
 * allocation; deterministic (the noise PRNG is seeded per voice).
 */
import { mipLevelFor, type MipSet } from '../mipmap';
import { deriveSeed, Prng } from '../prng';
import {
  applyMatrix,
  DST_INDEX,
  LFO_COUNT,
  lfoRateHz,
  lfoWave,
  MOD_CUTOFF_OCTAVES,
  MOD_LFO_RATE_OCTAVES,
  MOD_PITCH_SEMIS,
  N_DESTS,
  N_SOURCES,
  reflect01,
  SRC_INDEX,
} from '../modulation';
import { FILTER_ENV_OCTAVES, FILTER_VEL_OCTAVES, oscSemis, type SynthParams } from '../synth';
import type { TableId } from '../table';
import type { VoiceParams } from '../voice';
import type { PackedWavetable } from '../wavetablePlayback';
import { Adsr } from './adsr';
import { cutoffG, driveSample, FILTER_MODE_INDEX, MultiFilter, resonanceK, softLimit } from './svf';
import { WtOsc } from './wtOsc';

/** Smoothing time constant of the block-rate controls (cutoff, resonance, levels). */
export const CONTROL_SMOOTH_SEC = 0.005;
/** Seed of the per-voice noise generators (mixed with the voice id). */
export const NOISE_SEED = 0x5eed;
/** Seed of the per-voice modulation randomness (S&H, smooth random, per-note random). */
export const MOD_SEED = 0x10f0;

/** What the engine hands a Synth voice each control block (one reused object, no allocation). */
export interface SynthControl {
  /** The engine's smoothed pitch bend (±2 st scale; rescaled to the voice's bend range). */
  bend: number;
  blockLen: number;
  tables: ReadonlyMap<TableId, MipSet>;
  wtA: PackedWavetable | undefined;
  wtB: PackedWavetable | undefined;
  /** Largest table-weight change per block. */
  slew: number;
  /** One-pole glide coefficient per block for a glide time. */
  glideCoef: (sec: number) => number;
  /** Level × velocity gain (0 when muted). */
  gainTarget: number;
  bpm: number;
  /** Mod wheel and channel pressure 0..1. */
  wheel: number;
  pressure: number;
}

const D = DST_INDEX;
const S = SRC_INDEX;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Pink noise (Paul Kellet's economy filter) is scaled by this to match white noise's loudness. */
export const PINK_GAIN = 0.32;

const TWO_PI = 2 * Math.PI;

/** Equal-tempered frequency of a (fractional) MIDI pitch. */
export function pitchFreq(semis: number): number {
  return 440 * Math.pow(2, (semis - 69) / 12);
}

/** MIDI pitch (fractional) of a frequency. */
export function freqPitch(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440);
}

/** PolyBLEP residual for a naive step at phase 0 (t in [0, 1), dt = phase increment). */
function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** Balance pan: centre = unity on both sides, a side attenuates the other channel. */
export function panGains(pan: number): [number, number] {
  const p = Math.max(-1, Math.min(1, pan));
  return [p > 0 ? 1 - p : 1, p < 0 ? 1 + p : 1];
}

export class SynthVoice {
  readonly sampleRate: number;
  readonly a = new WtOsc();
  readonly b = new WtOsc();
  readonly fenv = new Adsr();
  /** Pitch envelope: attack → decay to 0 (sustain 0), stepped once per control block. */
  readonly penv = new Adsr();
  readonly filter = new MultiFilter();
  private readonly noise: Prng;
  private pink0 = 0;
  private pink1 = 0;
  private pink2 = 0;
  subPhase = 0;
  phaseB = 0;

  /** Glided pitch (MIDI semitones, voice octave included) and the note it glides to. */
  pitch = 57;
  target = 57;
  /** Raw velocity 0..1 of the sounding note (1 for sequencer notes). */
  vel = 1;

  // Block ramps (start → end of the control block).
  incA0 = 0;
  incA1 = 0;
  incB0 = 0;
  incB1 = 0;
  incS0 = 0;
  incS1 = 0;
  /** log2(cutoff Hz) of the block-rate part (knob, key tracking, velocity), smoothed. */
  private cut0 = 0;
  private cut1 = 0;
  private cutS = Number.NaN;
  private k0 = 2;
  private k1 = 2;
  private lv0 = new Float64Array(5);
  private lv1 = new Float64Array(5);
  /** Amp gain (level × velocity), smoothed per sample like the Simple voice's. */
  gain = 0;
  /** Pan gains at the block start / end. */
  panL0 = 1;
  panL1 = 1;
  panR0 = 1;
  panR1 = 1;
  /** Positions resolved this block (for the UI). */
  posA = 0;
  posYA = 0;
  posB = 0;
  posYB = 0;
  /** Mod envelope (a matrix source), stepped once per control block. */
  readonly menv = new Adsr();
  /** LFO state: phase 0..1, this / the previous cycle's random value, time since the note (fade-in), output. */
  readonly lfoPhase = new Float64Array(LFO_COUNT);
  private readonly lfoCur = new Float64Array(LFO_COUNT);
  private readonly lfoPrev = new Float64Array(LFO_COUNT);
  private readonly lfoAge = new Float64Array(LFO_COUNT);
  readonly lfoOut = new Float64Array(LFO_COUNT);
  private readonly modRng: Prng;
  /** Per-note random −1..1 (drawn at each retriggered note). */
  noteRand = 0;
  /** Matrix sources (MOD_SOURCES order) and summed destinations (MOD_DESTS order) of this block. */
  readonly src = new Float64Array(N_SOURCES);
  readonly dst = new Float64Array(N_DESTS);
  /** Drive after modulation (block rate). */
  private driveM = 0;
  /** Envelope settings last configured (filter ADSR, pitch AD, mod ADSR + mode). */
  private readonly envCfg = new Float64Array(11).fill(-1);
  private readonly smooth: number;

  constructor(sampleRate: number, voiceId: number, blockLen: number, lfoPhases?: readonly number[]) {
    this.sampleRate = sampleRate;
    this.noise = new Prng(deriveSeed(NOISE_SEED, voiceId));
    this.modRng = new Prng(deriveSeed(MOD_SEED, voiceId));
    this.smooth = 1 - Math.exp(-blockLen / (CONTROL_SMOOTH_SEC * sampleRate));
    for (let i = 0; i < LFO_COUNT; i++) {
      this.lfoPhase[i] = lfoPhases?.[i] ?? 0;
      this.lfoCur[i] = this.modRng.bipolar();
      this.lfoPrev[i] = this.lfoCur[i];
      this.lfoAge[i] = 1e9;
    }
  }

  /** (Re)configure the envelopes from the params (cheap check: only when they changed). */
  configure(s: SynthParams, blockLen: number): void {
    const c = this.envCfg;
    const ad = s.mMode === 'ad' ? 1 : 0;
    if (
      c[0] === s.fAttack &&
      c[1] === s.fDecay &&
      c[2] === s.fSustain &&
      c[3] === s.fRelease &&
      c[4] === s.pAttack &&
      c[5] === s.pDecay &&
      c[6] === s.mAttack &&
      c[7] === s.mDecay &&
      c[8] === s.mSustain &&
      c[9] === s.mRelease &&
      c[10] === ad
    )
      return;
    c[0] = s.fAttack;
    c[1] = s.fDecay;
    c[2] = s.fSustain;
    c[3] = s.fRelease;
    c[4] = s.pAttack;
    c[5] = s.pDecay;
    c[6] = s.mAttack;
    c[7] = s.mDecay;
    c[8] = s.mSustain;
    c[9] = s.mRelease;
    c[10] = ad;
    this.fenv.configure(s.fAttack, s.fDecay, s.fSustain, s.fRelease, this.sampleRate);
    this.penv.configure(s.pAttack, s.pDecay, 0, s.pDecay, this.sampleRate / blockLen);
    // AD: attack, then decay to 0 regardless of the gate (sustain 0, release = decay).
    if (ad) this.menv.configure(s.mAttack, s.mDecay, 0, s.mDecay, this.sampleRate / blockLen);
    else this.menv.configure(s.mAttack, s.mDecay, s.mSustain, s.mRelease, this.sampleRate / blockLen);
  }

  /**
   * A note starts (`legato`: it replaced a held note without retriggering, or arrived while
   * one was held). Glide: from the current pitch when the glide time is set and either
   * legato-only is off or the note is legato; otherwise the pitch jumps.
   */
  noteOn(p: VoiceParams, pitch: number, vel: number, legato: boolean, retrigger: boolean, sounding: boolean): void {
    const s = p.synth;
    this.target = pitch;
    this.vel = vel;
    const glide = s.glide > 0 && sounding && (!s.glideLegato || legato);
    if (!glide) this.pitch = pitch;
    if (retrigger) {
      this.configure(s, this.blockLen);
      this.fenv.gateOn();
      this.penv.gateOn();
      this.menv.gateOn();
      this.noteRand = this.modRng.bipolar();
      for (let i = 0; i < LFO_COUNT; i++) {
        const l = s.lfos[i];
        this.lfoAge[i] = 0;
        if (l.retrig) {
          this.lfoPhase[i] = l.phase;
          this.lfoPrev[i] = this.lfoCur[i];
          this.lfoCur[i] = this.modRng.bipolar();
        }
      }
    }
    if (!glide) this.retune(p);
  }

  gateOff(p: VoiceParams): void {
    this.fenv.gateOff();
    this.penv.gateOff();
    if (p.synth.mMode !== 'ad') this.menv.gateOff();
  }

  private blockLen = 64;

  /** Jump the block's pitch ramps to the current pitch (a new note without glide). */
  private retune(p: VoiceParams): void {
    this.pitches(p, this.lastBend);
    this.incA0 = this.incA1;
    this.incB0 = this.incB1;
    this.incS0 = this.incS1;
    this.a.mipLevel = mipLevelFor(this.incA1 * this.sampleRate, this.sampleRate);
    this.b.mipLevel = mipLevelFor(this.incB1 * this.sampleRate, this.sampleRate);
  }

  private lastBend = 0;

  /** Block-end phase increments of A, B and the sub from the current pitch state. */
  private pitches(p: VoiceParams, bendSemis: number): void {
    const s = p.synth;
    const sr = this.sampleRate;
    const pe = this.penv.value * s.pAmount;
    const base = this.pitch + bendSemis;
    const dst = this.dst;
    const pa = base + oscSemis(s.aOct, s.aCoarse, s.aFine) + (s.pTarget !== 'b' ? pe : 0) + dst[D.pitchA] * MOD_PITCH_SEMIS;
    const pb = base + oscSemis(s.bOct, s.bCoarse, s.bFine) + (s.pTarget !== 'a' ? pe : 0) + dst[D.pitchB] * MOD_PITCH_SEMIS;
    const fa = Math.min(pitchFreq(pa), sr * 0.45);
    this.incA1 = fa / sr;
    this.incB1 = Math.min(pitchFreq(pb), sr * 0.45) / sr;
    this.incS1 = fa / (s.subOct >= 2 ? 4 : 2) / sr;
  }

  /** Advance the LFOs by one block; their outputs (−1..1 × depth × fade-in) land in lfoOut. */
  private stepLfos(s: SynthParams, bpm: number, blockLen: number): void {
    const dt = blockLen / this.sampleRate;
    for (let i = 0; i < LFO_COUNT; i++) {
      const l = s.lfos[i];
      // Rate modulation uses the previous block's matrix (an LFO may modulate another's rate).
      const rate = lfoRateHz(l, bpm) * Math.pow(2, this.dst[D.lfo1Rate + i] * MOD_LFO_RATE_OCTAVES);
      let ph = this.lfoPhase[i] + rate * dt;
      if (ph >= 1) {
        ph -= Math.floor(ph);
        this.lfoPrev[i] = this.lfoCur[i];
        this.lfoCur[i] = this.modRng.bipolar();
      }
      this.lfoPhase[i] = ph;
      const age = this.lfoAge[i];
      const fade = l.fade > 0 ? Math.min(1, age / l.fade) : 1;
      this.lfoAge[i] = age + dt;
      this.lfoOut[i] = lfoWave(l.shape, ph, this.lfoCur[i], this.lfoPrev[i]) * l.depth * fade;
    }
  }

  /**
   * Control block: glide, envelopes, LFOs and the mod matrix, block ramps, both
   * oscillators' table mixes and the filter / mixer controls.
   */
  control(p: VoiceParams, c: SynthControl): void {
    const s = p.synth;
    const sr = this.sampleRate;
    const { bend: bendSemis, blockLen, tables, wtA, wtB, slew, glideCoef, gainTarget } = c;
    this.blockLen = blockLen;
    this.configure(s, blockLen);
    // Glide (one-pole on the pitch, ~98% there after the glide time).
    if (this.pitch !== this.target) {
      if (s.glide > 0) {
        this.pitch += (this.target - this.pitch) * glideCoef(s.glide);
        if (Math.abs(this.target - this.pitch) < 1e-4) this.pitch = this.target;
      } else this.pitch = this.target;
    }
    this.penv.next();
    this.menv.next();
    this.stepLfos(s, c.bpm, blockLen);
    // Mod matrix: sources → destinations (block rate; the ramps below smooth them).
    const src = this.src;
    src[S.lfo1] = this.lfoOut[0];
    src[S.lfo2] = this.lfoOut[1];
    src[S.lfo3] = this.lfoOut[2];
    src[S.fenv] = this.fenv.value;
    src[S.penv] = this.penv.value;
    src[S.menv] = this.menv.value;
    src[S.vel] = this.vel;
    src[S.wheel] = c.wheel;
    src[S.at] = c.pressure;
    src[S.key] = (this.pitch - 60) / 24;
    src[S.rand] = this.noteRand;
    applyMatrix(s.mods, src, this.dst);
    const dst = this.dst;
    const bend = (bendSemis * s.bendRange) / 2;
    this.lastBend = bend;
    this.incA0 = this.incA1;
    this.incB0 = this.incB1;
    this.incS0 = this.incS1;
    this.pitches(p, bend);
    this.a.mipLevel = mipLevelFor(Math.max(this.incA0, this.incA1) * sr, sr);
    this.b.mipLevel = mipLevelFor(Math.max(this.incB0, this.incB1) * sr, sr);

    // Table mixes.
    this.posA = dst[D.posA] ? reflect01(p.position + dst[D.posA]) : p.position;
    this.posYA = dst[D.posYA] ? reflect01(p.positionY + dst[D.posYA]) : p.positionY;
    this.posB = dst[D.posB] ? reflect01(s.b.position + dst[D.posB]) : s.b.position;
    this.posYB = dst[D.posYB] ? reflect01(s.b.positionY + dst[D.posYB]) : s.b.positionY;
    this.a.hold();
    if (wtA) this.a.resolve(tables, wtA, p.windowStart, p.windowEnd, p.windowStartY, p.windowEndY, this.posA, this.posYA, slew);
    this.b.hold();
    if (wtB) this.b.resolve(tables, wtB, s.b.windowStart, s.b.windowEnd, s.b.windowStartY, s.b.windowEndY, this.posB, this.posYB, slew);

    // Filter: block-rate part of the log cutoff (smoothed), resonance.
    const cut =
      Math.log2(s.cutoff) + (s.keyTrack * (this.pitch - 60)) / 12 + s.velAmount * (this.vel - 1) * FILTER_VEL_OCTAVES + dst[D.cutoff] * MOD_CUTOFF_OCTAVES;
    if (Number.isNaN(this.cutS)) this.cutS = this.cut1 = cut;
    else this.cutS += (cut - this.cutS) * this.smooth;
    this.cut0 = this.cut1;
    this.cut1 = this.cutS;
    this.k0 = this.k1;
    this.k1 += (resonanceK(clamp01(s.resonance + dst[D.res])) - this.k1) * this.smooth;
    this.driveM = clamp01(s.drive + dst[D.drive]);
    // Mixer levels.
    const lv = this.lv1;
    this.lv0.set(lv);
    lv[0] += (clamp01(s.aLevel + dst[D.levelA]) - lv[0]) * this.smooth;
    lv[1] += (clamp01(s.bLevel + dst[D.levelB]) - lv[1]) * this.smooth;
    lv[2] += (clamp01(s.subLevel + dst[D.sub]) - lv[2]) * this.smooth;
    lv[3] += (clamp01(s.noiseLevel + dst[D.noise]) - lv[3]) * this.smooth;
    lv[4] += (s.ringLevel - lv[4]) * this.smooth;
    // Pan.
    const pan = Math.max(-1, Math.min(1, s.pan + dst[D.pan]));
    const gl = pan > 0 ? 1 - pan : 1;
    const gr = pan < 0 ? 1 + pan : 1;
    this.panL0 = this.panL1;
    this.panR0 = this.panR1;
    this.panL1 += (gl - this.panL1) * this.smooth;
    this.panR1 += (gr - this.panR1) * this.smooth;
    this.gainTarget = gainTarget * Math.max(0, 1 + dst[D.amp]);
    this.filter.flush();
    if (Math.abs(this.pink0) < 1e-20) this.pink0 = 0;
    if (Math.abs(this.pink1) < 1e-20) this.pink1 = 0;
    if (Math.abs(this.pink2) < 1e-20) this.pink2 = 0;
  }

  private gainTarget = 0;

  /**
   * One mono sample at `blockT` (0..1) through the block, given the amp envelope value `e`.
   * Advances the oscillators and envelopes.
   */
  render(p: VoiceParams, e: number, blockT: number, tables: ReadonlyMap<TableId, MipSet>): number {
    const s = p.synth;
    this.gain += (this.gainTarget - this.gain) * 0.002;
    const fe = this.fenv.next();
    const t = blockT;
    const incA = this.incA0 + (this.incA1 - this.incA0) * t;
    const incB = this.incB0 + (this.incB1 - this.incB0) * t;
    const incS = this.incS0 + (this.incS1 - this.incS0) * t;
    let y = 0;
    if (e > 0) {
      const l0 = this.lv0;
      const l1 = this.lv1;
      const la = l0[0] + (l1[0] - l0[0]) * t;
      const lb = l0[1] + (l1[1] - l0[1]) * t;
      const ls = l0[2] + (l1[2] - l0[2]) * t;
      const ln = l0[3] + (l1[3] - l0[3]) * t;
      const lr = l0[4] + (l1[4] - l0[4]) * t;
      const sa = this.a.n > 0 ? this.a.read(this.a.phase, t) : 0;
      const sb = this.b.n > 0 && (lb > 0 || lr > 0) ? this.b.read(this.phaseB, t) : 0;
      let x = la * sa + lb * sb + lr * sa * sb;
      if (ls > 0) {
        if (s.subWave === 'square') {
          let q = this.subPhase < 0.5 ? 1 : -1;
          q += polyBlep(this.subPhase, incS);
          const h = this.subPhase + 0.5;
          q -= polyBlep(h >= 1 ? h - 1 : h, incS);
          x += ls * q * 0.7;
        } else x += ls * Math.sin(TWO_PI * this.subPhase);
      }
      if (ln > 0) {
        const w = this.noise.bipolar();
        if (s.noiseType === 'pink') {
          this.pink0 = 0.99765 * this.pink0 + w * 0.099046;
          this.pink1 = 0.963 * this.pink1 + w * 0.2965164;
          this.pink2 = 0.57 * this.pink2 + w * 1.0526913;
          x += ln * (this.pink0 + this.pink1 + this.pink2 + w * 0.1848) * PINK_GAIN;
        } else x += ln * w;
      }
      x = driveSample(x, this.driveM);

      const cut = this.cut0 + (this.cut1 - this.cut0) * t + fe * s.envAmount * FILTER_ENV_OCTAVES;
      const g = cutoffG(Math.pow(2, cut), this.sampleRate);
      const k = this.k0 + (this.k1 - this.k0) * t;
      y = this.filter.process(x, FILTER_MODE_INDEX[s.filterMode], g, k);
      y = softLimit(y * e * this.gain);
    }
    this.a.phase += incA;
    if (this.a.phase >= 1) {
      this.a.phase -= Math.floor(this.a.phase);
      this.a.wrapped(tables);
    }
    this.phaseB += incB;
    if (this.phaseB >= 1) {
      this.phaseB -= Math.floor(this.phaseB);
      this.b.wrapped(tables);
    }
    this.subPhase += incS;
    if (this.subPhase >= 1) this.subPhase -= Math.floor(this.subPhase);
    return y;
  }
}
