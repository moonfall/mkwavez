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
 * Stereo: the path runs on two channels whenever something makes them differ — unison
 * spread, oscillator pan, stereo phase (the right channel reads ahead), stereo position (a
 * second table mix per oscillator, aR / bR, at its own position), noise width, filter
 * spread, or a stereo LFO on a per-channel destination (STEREO_DESTS) — and back on one
 * (one filter) once nothing does and both filters agree again.
 *
 * Pitch (glide, bend, oscillator tuning, pitch envelope) and the mixer / filter controls are
 * computed once per control block and ramped linearly across it; the filter envelope runs
 * per sample, so the cutoff is recomputed (and smooth) every sample. Fixed state, no
 * allocation; deterministic (the noise PRNG is seeded per voice).
 */
import { BEND_RANGE_SEMITONES } from '../midi';
import { MIP_HARMONICS, MIP_NYQUIST_FRACTION } from '../constants';
import { MIP_LEVELS, mipLevelFor, type MipSet } from '../mipmap';

import { deriveSeed, Prng } from '../prng';
import {
  applyMatrix,
  DST_INDEX,
  LFO_COUNT,
  LFO_DIV_BEATS,
  LFO_RATE_MAX_HZ,

  lfoRateHz,
  isPeriodicShape,
  lfoWave,
  MOD_CUTOFF_OCTAVES,
  MOD_LFO_RATE_OCTAVES,
  MOD_PITCH_SEMIS,
  N_DESTS,
  N_SOURCES,
  reflect01,
  SRC_INDEX,
} from '../modulation';
import { FILTER_ENV_OCTAVES, FILTER_SPREAD_OCTAVES, FILTER_VEL_OCTAVES, FM_DEPTH, MAX_UNISON, oscSemis, type SynthParams } from '../synth';
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
/** Seed of the right channel's second noise stream (noise width). */
export const NOISE_R_SEED = 0x5eee;
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
  /** CPU guard: unison copies are scaled by this (≤ 1) when the engine is over budget. */
  unisonScale: number;
  /** Transport position in beats (quarter notes since Play), or −1 when stopped. */
  beat: number;
}

/** Golden-ratio phase offsets for unison copies (deterministic, evenly spread). */
const UNISON_PHASE = 0.381966;
/**
 * Fixed places of unison copies 0..3, as a fraction of the detune (± cents) and of the
 * stereo spread: copy 0 stays at the centre pitch and pan, the others take the outer
 * places, so a copy never moves when the count changes.
 */
/**
 * Unison places for n copies, as a fraction of the detune (± cents) and of the stereo
 * spread: symmetric around the centre for every count. When the count changes, copies glide
 * to their new places (UNISON_GLIDE_SEC) rather than jump. Pitch references (Step-mode
 * switches, hard sync, the FM source) use a virtual centre copy (ratio 1), so they don't
 * depend on the count either.
 */
const UNISON_PLACES: readonly (readonly number[])[] = [[0], [0], [-0.5, 0.5], [0, -1, 1], [-1, -1 / 3, 1 / 3, 1]];
const UNISON_PANS: readonly (readonly number[])[] = [[0], [0], [-1, 1], [0, -1, 1], [-1, -1 / 3, 1 / 3, 1]];
/** Copies move to new unison places (a count change) over about this long. */
export const UNISON_GLIDE_SEC = 0.03;
/** Unison copies fade in / out over this long (count changes, CPU guard). */
export const UNISON_FADE_SEC = 0.01;

const D = DST_INDEX;
const S = SRC_INDEX;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp11 = (x: number) => (x < -1 ? -1 : x > 1 ? 1 : x);
/** Smoothed stereo controls snap onto their target this close (so they settle exactly, e.g. on 0). */
const SNAP = 1e-6;
/** One-pole step of `x` towards `t` by `c`, snapping onto `t` once within SNAP. */
function approach(x: number, t: number, c: number): number {
  const y = x + (t - x) * c;
  return Math.abs(t - y) < SNAP ? t : y;
}
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
  /**
   * Right-channel table mixes: used while the right channel reads an oscillator at another
   * position than the left (stereo position, or a stereo LFO on a position); otherwise the
   * right channel reads `a` / `b` too.
   */
  readonly aR = new WtOsc();
  readonly bR = new WtOsc();
  rA = false;
  rB = false;
  readonly fenv = new Adsr();
  /** Pitch envelope: attack → decay to 0 (sustain 0), stepped once per control block. */
  readonly penv = new Adsr();
  readonly filter = new MultiFilter();
  /** Right channel's filter (used while the voice is stereo: unison spread). */
  readonly filterR = new MultiFilter();
  /** Unison: phases of each copy (copy 0 = the oscillator's own), detune ratios, stereo gains. */
  readonly phA = new Float64Array(MAX_UNISON);
  readonly phB = new Float64Array(MAX_UNISON);
  private readonly ratA = new Float64Array(MAX_UNISON).fill(1);
  private readonly ratB = new Float64Array(MAX_UNISON).fill(1);
  private readonly gAL = new Float64Array(MAX_UNISON).fill(1);
  private readonly gAR = new Float64Array(MAX_UNISON).fill(1);
  private readonly gBL = new Float64Array(MAX_UNISON).fill(1);
  private readonly gBR = new Float64Array(MAX_UNISON).fill(1);
  /**
   * Copy weights (1/√n for the copies wanted, 0 for the rest) at the block start / end:
   * copies fade in and out over ~10 ms (UNISON_FADE_SEC), never cut.
   */
  private readonly wA0 = new Float64Array(MAX_UNISON);
  private readonly wA1 = new Float64Array(MAX_UNISON);
  private readonly wB0 = new Float64Array(MAX_UNISON);
  private readonly wB1 = new Float64Array(MAX_UNISON);
  /** Copies rendered this block (wanted or still fading out). */
  uA = 1;
  uB = 1;
  /** Highest detune ratio among the rendered copies (for the mip level). */
  private maxRatA = 1;
  private maxRatB = 1;
  /** Stereo: the channels differ (two filters run; kept until the two filters agree again). */
  stereo = false;
  /** Unison copies are spread this block. */
  private spread = false;
  /** Copy weights' largest change per block. */
  private readonly uniStep: number;
  /** One-pole coefficient per block for copies gliding to new places. */
  private readonly uniGlide: number;
  /** Current unison places (detune fraction, pan) per copy, gliding towards the targets. */
  private readonly plA = new Float64Array(MAX_UNISON);
  private readonly plB = new Float64Array(MAX_UNISON);
  private readonly pnA = new Float64Array(MAX_UNISON);
  private readonly pnB = new Float64Array(MAX_UNISON);
  /** Virtual centre copies' phases (ratio 1): the pitch reference for Step mode, sync and FM. */
  phCA = 0;
  phCB = 0;
  /** Stereo output of the last render() (before pan). */
  outL = 0;
  outR = 0;
  private readonly noise: Prng;
  private pink0 = 0;
  private pink1 = 0;
  private pink2 = 0;
  /** The right channel's second noise stream (noise width) and its pink filter. */
  private readonly noiseR: Prng;
  private pinkR0 = 0;
  private pinkR1 = 0;
  private pinkR2 = 0;
  /** Noise width this block as a rotation: L = c·n1 + s·n2, R = c·n1 − s·n2. */
  private nwC = 1;
  private nwS = 0;
  subPhase = 0;

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
  /** The right channel's amp gain (differs from `gain` with a stereo LFO on amp). */
  gainR = 0;
  /** Oscillator pans (−1..1) at the block start / end. */
  private opA0 = 0;
  private opA1 = 0;
  private opB0 = 0;
  private opB1 = 0;
  /** Stereo phase (cycles the right channel reads ahead) per oscillator at the block start / end. */
  private psA0 = 0;
  private psA1 = 0;
  private psB0 = 0;
  private psB1 = 0;
  /** Filter spread (octaves between the channels, smoothed) and a stereo LFO's cutoff difference. */
  private fsS = 0;
  private dCutS = 0;
  /** log2-cutoff offsets of the left / right channel at the block start / end. */
  private offL0 = 0;
  private offL1 = 0;
  private offR0 = 0;
  private offR1 = 0;
  /** Right minus left level of osc A / B (stereo LFO on a level) at the block start / end. */
  private readonly dLv0 = new Float64Array(2);
  private readonly dLv1 = new Float64Array(2);
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
  /** The right channel's LFO outputs (an LFO's stereo phase; equal to lfoOut otherwise). */
  readonly lfoOutR = new Float64Array(LFO_COUNT);
  /** Some LFO has a stereo phase this block (the matrix is summed for the right channel too). */
  private lfoStereo = false;
  private readonly modRng: Prng;
  /** Per-note random −1..1 (drawn at each retriggered note). */
  noteRand = 0;
  /** Matrix sources (MOD_SOURCES order) and summed destinations (MOD_DESTS order) of this block. */
  readonly src = new Float64Array(N_SOURCES);
  readonly dst = new Float64Array(N_DESTS);
  /** The right channel's sources / destinations (with a stereo LFO). */
  private readonly srcR = new Float64Array(N_SOURCES);
  private readonly dstR = new Float64Array(N_DESTS);
  /** Drive after modulation (block rate). */
  private driveM = 0;
  /** Envelope settings last configured (filter ADSR, pitch AD, mod ADSR + mode). */
  private readonly envCfg = new Float64Array(11).fill(-1);
  private readonly smooth: number;

  constructor(sampleRate: number, voiceId: number, blockLen: number, lfoPhases?: readonly number[]) {
    this.sampleRate = sampleRate;
    this.noise = new Prng(deriveSeed(NOISE_SEED, voiceId));
    this.noiseR = new Prng(deriveSeed(NOISE_R_SEED, voiceId));
    this.modRng = new Prng(deriveSeed(MOD_SEED, voiceId));
    this.smooth = 1 - Math.exp(-blockLen / (CONTROL_SMOOTH_SEC * sampleRate));
    this.uniStep = blockLen / (UNISON_FADE_SEC * sampleRate);
    this.uniGlide = 1 - Math.exp(-blockLen / (UNISON_GLIDE_SEC * sampleRate));
    this.wA0[0] = this.wA1[0] = this.wB0[0] = this.wB1[0] = 1;
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
    this.mips(p.synth, this.incA1, this.incB1);
  }

  /**
   * Mip levels for the oscillators' highest increments this block. Ring modulation (A × B
   * holds sum frequencies: twice the bandwidth) takes one level fewer harmonics on both; FM
   * likewise on A. (Hard sync and drive / saturation still alias somewhat at high notes:
   * no oversampling, see ROADMAP.)
   */
  private mips(s: SynthParams, incA: number, incB: number): void {
    const sr = this.sampleRate;
    const ring = s.ringLevel > 0 || this.lv1[4] > 1e-4 ? 1 : 0;
    const fa = incA * this.maxRatA * sr;
    const fb = incB * this.maxRatB * sr;
    // FM (Carson's rule): sidebands reach (β + 1)·f_B past each harmonic of A, β = 2π·FM_DEPTH·fm.
    const side = s.fm > 0 ? (TWO_PI * FM_DEPTH * s.fm + 1) * fb : 0;
    const limit = MIP_NYQUIST_FRACTION * sr;
    let la = MIP_LEVELS - 1;
    for (let l = 0; l < MIP_LEVELS; l++) {
      if (fa * MIP_HARMONICS[l] + side < limit) {
        la = l;
        break;
      }
    }
    this.a.mipLevel = Math.min(MIP_LEVELS - 1, la + ring);
    this.b.mipLevel = Math.min(MIP_LEVELS - 1, mipLevelFor(fb, sr) + ring);
  }

  /**
   * The voice became a Synth voice (again): snap its pitch to the current note (no glide
   * from a stale one) and bring the envelopes in line with the gate: restarted while a note
   * is held, silent otherwise (the filter state is cleared when nothing sounds).
   */
  resync(p: VoiceParams, pitch: number, gated: boolean, sounding: boolean): void {
    this.target = this.pitch = pitch;
    this.configure(p.synth, this.blockLen);
    if (gated) {
      this.fenv.gateOn();
      this.penv.gateOn();
      this.menv.gateOn();
    } else {
      for (const env of [this.fenv, this.penv, this.menv]) {
        env.value = 0;
        env.stage = 0;
      }
    }
    if (!sounding) {
      this.filter.reset();
      this.filterR.reset();
    }
    this.retune(p);
  }

  private lastBend = 0;

  /**
   * A pooled note taken over by another voice (polyphony): forget the previous voice's
   * table mixes (Step holds included; the next resolve starts at the new voice's), its
   * right-channel readers and the cutoff smoothing.
   */
  reclaim(): void {
    for (const o of [this.a, this.b, this.aR, this.bR]) {
      o.clear();
      o.heldId = o.targetId = -1;
    }
    this.rA = this.rB = false;
    this.cutS = Number.NaN;
  }

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
  private stepLfos(s: SynthParams, bpm: number, blockLen: number, beat: number): void {
    const dt = blockLen / this.sampleRate;
    let stereo = false;
    for (let i = 0; i < LFO_COUNT; i++) {
      const l = s.lfos[i];
      // Rate modulation uses the previous block's matrix (an LFO may modulate another's
      // rate), clamped to ±MOD_LFO_RATE_OCTAVES and the LFO rate range.
      const m = Math.max(-1, Math.min(1, this.dst[D.lfo1Rate + i]));
      const mult = m === 0 ? 1 : Math.pow(2, m * MOD_LFO_RATE_OCTAVES);
      const inc = Math.min(LFO_RATE_MAX_HZ * 2, Math.max(0, lfoRateHz(l, bpm) * mult)) * dt;
      let ph = this.lfoPhase[i] + inc;
      if (l.sync && !l.retrig && beat >= 0 && m === 0) {
        // Tempo-synced, free-running, transport playing, no rate modulation: steer towards
        // the bar clock's phase (cycles from the transport's beat 0, offset by the start
        // phase) at up to ±½ of its own speed, so it locks without a jump (at Play, or when
        // rate modulation stops). Rate modulation runs it at the modulated speed meanwhile.
        const t = beat / LFO_DIV_BEATS[l.div] + l.phase;
        let d = t - Math.floor(t) - ph;
        d -= Math.round(d);
        ph += Math.max(-0.5 * inc, Math.min(0.5 * inc, d));
      }
      if (ph >= 1) {
        // Only a forward wrap is a new cycle (S&H / smooth random draw their next value).
        ph -= Math.floor(ph);
        this.lfoPrev[i] = this.lfoCur[i];
        this.lfoCur[i] = this.modRng.bipolar();
      } else if (ph < 0) ph -= Math.floor(ph); // steered back across 0: same cycle

      this.lfoPhase[i] = ph;
      const age = this.lfoAge[i];
      const fade = l.fade > 0 ? Math.min(1, age / l.fade) : 1;
      this.lfoAge[i] = age + dt;
      this.lfoOut[i] = lfoWave(l.shape, ph, this.lfoCur[i], this.lfoPrev[i]) * l.depth * fade;
      if (l.stereo > 0 && l.depth > 0 && isPeriodicShape(l.shape)) {
        // The right channel's copy runs `stereo` cycles ahead.
        let phR = ph + l.stereo;
        if (phR >= 1) phR -= 1;
        this.lfoOutR[i] = lfoWave(l.shape, phR, this.lfoCur[i], this.lfoPrev[i]) * l.depth * fade;
        stereo = true;
      } else this.lfoOutR[i] = this.lfoOut[i];
    }
    this.lfoStereo = stereo;
  }

  /**
   * Control block: glide, envelopes, LFOs and the mod matrix, block ramps, both
   * oscillators' table mixes and the filter / mixer controls.
   */
  control(p: VoiceParams, c: SynthControl): void {
    const s = p.synth;
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
    this.stepLfos(s, c.bpm, blockLen, c.beat);
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
    // The right channel's destinations: the matrix again with the LFOs' right-channel
    // outputs (only the STEREO_DESTS entries are used); without a stereo LFO, the left's.
    let dR = dst;
    if (this.lfoStereo) {
      const sr = this.srcR;
      sr.set(src);
      sr[S.lfo1] = this.lfoOutR[0];
      sr[S.lfo2] = this.lfoOutR[1];
      sr[S.lfo3] = this.lfoOutR[2];
      applyMatrix(s.mods, sr, this.dstR);
      dR = this.dstR;
    }
    const bend = (bendSemis * s.bendRange) / BEND_RANGE_SEMITONES;
    this.lastBend = bend;
    this.incA0 = this.incA1;
    this.incB0 = this.incB1;
    this.incS0 = this.incS1;
    this.pitches(p, bend);
    this.unison(s, c.unisonScale);
    this.mips(s, Math.max(this.incA0, this.incA1), Math.max(this.incB0, this.incB1));
    this.aR.mipLevel = this.a.mipLevel;
    this.bR.mipLevel = this.b.mipLevel;

    // Table mixes.
    this.posA = dst[D.posA] ? reflect01(p.position + dst[D.posA]) : p.position;
    this.posYA = dst[D.posYA] ? reflect01(p.positionY + dst[D.posYA]) : p.positionY;
    this.posB = dst[D.posB] ? reflect01(s.b.position + dst[D.posB]) : s.b.position;
    this.posYB = dst[D.posYB] ? reflect01(s.b.positionY + dst[D.posYB]) : s.b.positionY;
    // Right channel: its own positions (stereo LFO), then the stereo position spread
    // (left at − spread / 2, right at + spread / 2 on X).
    const pAR = dR[D.posA] ? reflect01(p.position + dR[D.posA]) : p.position;
    const pYAR = dR[D.posYA] ? reflect01(p.positionY + dR[D.posYA]) : p.positionY;
    const pBR = dR[D.posB] ? reflect01(s.b.position + dR[D.posB]) : s.b.position;
    const pYBR = dR[D.posYB] ? reflect01(s.b.positionY + dR[D.posYB]) : s.b.positionY;
    const xAL = s.aPosSpread > 0 ? reflect01(this.posA - s.aPosSpread / 2) : this.posA;
    const xAR = s.aPosSpread > 0 ? reflect01(pAR + s.aPosSpread / 2) : pAR;
    const xBL = s.bPosSpread > 0 ? reflect01(this.posB - s.bPosSpread / 2) : this.posB;
    const xBR = s.bPosSpread > 0 ? reflect01(pBR + s.bPosSpread / 2) : pBR;
    this.a.hold();
    if (xAR !== xAL || pYAR !== this.posYA) {
      if (!this.rA) {
        // The right channel starts from exactly what the left plays, then moves on.
        this.aR.copyFrom(this.a);
        this.rA = true;
      }
    }
    if (wtA) this.a.resolve(tables, wtA, p.windowStart, p.windowEnd, p.windowStartY, p.windowEndY, xAL, this.posYA, slew);
    if (this.rA) {
      this.aR.hold();
      if (wtA) this.aR.resolve(tables, wtA, p.windowStart, p.windowEnd, p.windowStartY, p.windowEndY, xAR, pYAR, slew);
      // Back on one mix once the right reads where the left does and has caught up with it.
      if (xAR === xAL && pYAR === this.posYA && this.aR.sameMix(this.a)) {
        this.rA = false;
        this.aR.clear();
      }
    }
    this.b.hold();
    if (xBR !== xBL || pYBR !== this.posYB) {
      if (!this.rB) {
        this.bR.copyFrom(this.b);
        this.rB = true;
      }
    }
    if (wtB) this.b.resolve(tables, wtB, s.b.windowStart, s.b.windowEnd, s.b.windowStartY, s.b.windowEndY, xBL, this.posYB, slew);
    if (this.rB) {
      this.bR.hold();
      if (wtB) this.bR.resolve(tables, wtB, s.b.windowStart, s.b.windowEnd, s.b.windowStartY, s.b.windowEndY, xBR, pYBR, slew);
      if (xBR === xBL && pYBR === this.posYB && this.bR.sameMix(this.b)) {
        this.rB = false;
        this.bR.clear();
      }
    }

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
    // Stereo controls: filter spread (± half on each side) plus a stereo LFO's cutoff
    // difference on the right; right − left levels; oscillator pans; stereo phases; noise width.
    const sm = this.smooth;
    this.fsS = approach(this.fsS, clamp11(s.filterSpread + dst[D.fSpread]) * FILTER_SPREAD_OCTAVES, sm);
    this.dCutS = approach(this.dCutS, (dR[D.cutoff] - dst[D.cutoff]) * MOD_CUTOFF_OCTAVES, sm);
    this.offL0 = this.offL1;
    this.offR0 = this.offR1;
    this.offL1 = this.fsS === 0 ? 0 : -this.fsS / 2;
    this.offR1 = this.fsS / 2 + this.dCutS;
    const dl = this.dLv1;
    this.dLv0.set(dl);
    dl[0] = approach(dl[0], dR === dst ? 0 : clamp01(s.aLevel + dR[D.levelA]) - clamp01(s.aLevel + dst[D.levelA]), sm);
    dl[1] = approach(dl[1], dR === dst ? 0 : clamp01(s.bLevel + dR[D.levelB]) - clamp01(s.bLevel + dst[D.levelB]), sm);
    this.opA0 = this.opA1;
    this.opB0 = this.opB1;
    this.opA1 = approach(this.opA1, clamp11(s.aPan + dst[D.panA]), sm);
    this.opB1 = approach(this.opB1, clamp11(s.bPan + dst[D.panB]), sm);
    // A phase moves more slowly (a fast change is a pitch blip on the right).
    this.psA0 = this.psA1;
    this.psB0 = this.psB1;
    this.psA1 = approach(this.psA1, s.aPhaseSpread, this.uniGlide);
    this.psB1 = approach(this.psB1, s.bPhaseSpread, this.uniGlide);
    const th = (s.noiseWidth * Math.PI) / 4;
    this.nwC = s.noiseWidth > 0 ? Math.cos(th) : 1;
    this.nwS = s.noiseWidth > 0 ? Math.sin(th) : 0;
    // Pan.
    const pan = Math.max(-1, Math.min(1, s.pan + dst[D.pan]));
    const gl = pan > 0 ? 1 - pan : 1;
    const gr = pan < 0 ? 1 + pan : 1;
    this.panL0 = this.panL1;
    this.panR0 = this.panR1;
    this.panL1 += (gl - this.panL1) * this.smooth;
    this.panR1 += (gr - this.panR1) * this.smooth;
    this.gainTarget = gainTarget * Math.max(0, 1 + dst[D.amp]);
    this.gainTargetR = gainTarget * Math.max(0, 1 + dR[D.amp]);

    // Stereo while anything makes the channels differ; back to mono once nothing does and
    // both filters agree (they then have the same input and state).
    const wide =
      this.spread ||
      this.rA ||
      this.rB ||
      this.opA0 !== 0 ||
      this.opA1 !== 0 ||
      this.opB0 !== 0 ||
      this.opB1 !== 0 ||
      this.psA0 !== 0 ||
      this.psA1 !== 0 ||
      this.psB0 !== 0 ||
      this.psB1 !== 0 ||
      this.offL0 !== 0 ||
      this.offL1 !== 0 ||
      this.offR0 !== 0 ||
      this.offR1 !== 0 ||
      this.dLv0[0] !== 0 ||
      this.dLv1[0] !== 0 ||
      this.dLv0[1] !== 0 ||
      this.dLv1[1] !== 0 ||
      this.gainTargetR !== this.gainTarget ||
      this.gainR !== this.gain ||
      (this.nwS !== 0 && (this.lv0[3] > 0 || this.lv1[3] > 0));
    if (wide && !this.stereo) {
      // The right channel takes over the left filter's state: no transient.
      this.filterR.copyFrom(this.filter);
      this.stereo = true;
    } else if (!wide && this.stereo && this.filter.closeTo(this.filterR)) {
      this.stereo = false;
    }
    this.filter.flush();
    this.filterR.flush();

    if (Math.abs(this.pink0) < 1e-20) this.pink0 = 0;
    if (Math.abs(this.pink1) < 1e-20) this.pink1 = 0;
    if (Math.abs(this.pink2) < 1e-20) this.pink2 = 0;
    if (Math.abs(this.pinkR0) < 1e-20) this.pinkR0 = 0;
    if (Math.abs(this.pinkR1) < 1e-20) this.pinkR1 = 0;
    if (Math.abs(this.pinkR2) < 1e-20) this.pinkR2 = 0;
  }

  private gainTarget = 0;
  private gainTargetR = 0;

  /**
   * Unison per oscillator: the copies wanted (after the CPU guard), their weights (fading
   * towards 1/√n or 0, never jumping), places (symmetric for the count; gliding there),
   * detune ratios and stereo gains.
   */
  private unison(s: SynthParams, scale: number): void {
    const want = (n: number) => (scale >= 1 ? n : Math.max(1, Math.floor(n * scale)));
    const nA = want(s.aUnison);
    const nB = want(s.bUnison);
    this.uA = this.copies(nA, this.wA0, this.wA1, this.phA, this.phCA, this.plA, this.pnA);
    this.uB = this.copies(nB, this.wB0, this.wB1, this.phB, this.phCB, this.plB, this.pnB);
    // One copy audible (the others faded out): the centre follows it exactly, so Step-mode
    // switches and hard sync land on the audible copy's cycle start.
    if (this.uA === 1) this.phCA = this.phA[0];
    if (this.uB === 1) this.phCB = this.phB[0];

    this.maxRatA = this.place(this.uA, nA, s.aDetune, s.aSpread, this.plA, this.pnA, this.ratA, this.gAL, this.gAR);
    this.maxRatB = this.place(this.uB, nB, s.bDetune, s.bSpread, this.plB, this.pnB, this.ratB, this.gBL, this.gBR);
    this.spread = (this.uA > 1 && s.aSpread > 0) || (this.uB > 1 && s.bSpread > 0);
  }

  /**
   * Fade copy weights towards 1/√n (the first n) or 0; returns how many copies to render.
   * A copy starting from silence takes its place at once, at a deterministic phase offset
   * from the centre.
   */
  private copies(n: number, w0: Float64Array, w1: Float64Array, ph: Float64Array, centre: number, pl: Float64Array, pn: Float64Array): number {
    const target = 1 / Math.sqrt(n);
    const places = UNISON_PLACES[n];
    const pans = UNISON_PANS[n];
    let count = 1;
    for (let i = 0; i < MAX_UNISON; i++) {
      const was = w1[i];
      w0[i] = was;
      const t = i < n ? target : 0;
      if (was === 0 && t > 0) {
        ph[i] = (centre + (n > 1 ? i * UNISON_PHASE : 0)) % 1;
        pl[i] = places[i];
        pn[i] = pans[i];
      }
      w1[i] = was + Math.max(-this.uniStep, Math.min(this.uniStep, t - was));
      if (w0[i] > 0 || w1[i] > 0) count = i + 1;
    }
    return count;
  }

  /**
   * Places glide towards the count's symmetric layout (copies fading out keep theirs);
   * detune ratios and pan gains from them. Returns the highest ratio.
   */
  private place(count: number, n: number, cents: number, spread: number, pl: Float64Array, pn: Float64Array, rat: Float64Array, gl: Float64Array, gr: Float64Array): number {
    const places = UNISON_PLACES[n];
    const pans = UNISON_PANS[n];
    let max = 1;
    for (let i = 0; i < count; i++) {
      if (i < n) {
        pl[i] += (places[i] - pl[i]) * this.uniGlide;
        pn[i] += (pans[i] - pn[i]) * this.uniGlide;
      }
      rat[i] = Math.pow(2, (pl[i] * cents) / 1200);
      if (rat[i] > max) max = rat[i];
      const p = pn[i] * spread;
      gl[i] = p > 0 ? 1 - p : 1;
      gr[i] = p < 0 ? 1 + p : 1;
    }
    return max;
  }

  /**
   * One sample at `blockT` (0..1) through the block, given the amp envelope value `e`, into
   * outL / outR (equal unless the voice is stereo). Returns the mid ((L + R) / 2).
   * Advances the oscillators and envelopes.
   */
  render(p: VoiceParams, e: number, blockT: number, tables: ReadonlyMap<TableId, MipSet>): number {
    const s = p.synth;
    this.gain += (this.gainTarget - this.gain) * 0.002;
    const stereo = this.stereo;
    if (stereo) this.gainR += (this.gainTargetR - this.gainR) * 0.002;
    else this.gainR = this.gain;
    const fe = this.fenv.next();
    const t = blockT;
    const incA = this.incA0 + (this.incA1 - this.incA0) * t;
    const incB = this.incB0 + (this.incB1 - this.incB0) * t;
    const incS = this.incS0 + (this.incS1 - this.incS0) * t;
    let yL = 0;
    let yR = 0;
    if (e > 0) {
      const l0 = this.lv0;
      const l1 = this.lv1;
      const la = l0[0] + (l1[0] - l0[0]) * t;
      const lb = l0[1] + (l1[1] - l0[1]) * t;
      const ls = l0[2] + (l1[2] - l0[2]) * t;
      const ln = l0[3] + (l1[3] - l0[3]) * t;
      const lr = l0[4] + (l1[4] - l0[4]) * t;
      // The right channel reads separately with a stereo phase (ahead by psX cycles) or a
      // stereo position (its own table mix, aR / bR).
      const psB = stereo ? this.psB0 + (this.psB1 - this.psB0) * t : 0;
      const psA = stereo ? this.psA0 + (this.psA1 - this.psA0) * t : 0;
      const splitB = stereo && (psB !== 0 || this.rB);
      const splitA = stereo && (psA !== 0 || this.rA);
      const oscBR = this.rB ? this.bR : this.b;
      const oscAR = this.rA ? this.aR : this.a;
      // Osc B first (it may modulate A's phase).
      let sbL = 0;
      let sbR = 0;
      let b0 = 0;
      if (this.b.n > 0 && (lb > 0 || lr > 0 || s.fm > 0)) {
        // FM source: B at its centre pitch (with one copy, that copy).
        if (s.fm > 0) b0 = this.b.read(this.uB === 1 ? this.phB[0] : this.phCB, t);
        for (let i = 0; i < this.uB; i++) {
          const w = this.wB0[i] + (this.wB1[i] - this.wB0[i]) * t;
          const v = this.b.read(this.phB[i], t) * w;
          sbL += v * this.gBL[i];
          if (splitB) {
            let ph = this.phB[i] + psB;
            if (ph >= 1) ph -= 1;
            sbR += oscBR.read(ph, t) * w * this.gBR[i];
          } else sbR += v * this.gBR[i];
        }
      }
      let saL = 0;
      let saR = 0;
      if (this.a.n > 0) {
        const fmOff = s.fm > 0 ? s.fm * FM_DEPTH * b0 : 0;
        for (let i = 0; i < this.uA; i++) {
          let ph = this.phA[i] + fmOff;
          ph -= Math.floor(ph);
          const w = this.wA0[i] + (this.wA1[i] - this.wA0[i]) * t;
          const v = this.a.read(ph, t) * w;
          saL += v * this.gAL[i];
          if (splitA) {
            let phR = ph + psA;
            if (phR >= 1) phR -= 1;
            saR += oscAR.read(phR, t) * w * this.gAR[i];
          } else saR += v * this.gAR[i];
        }
      }
      let x: number;
      let xr: number;
      if (stereo) {
        // Oscillator pans (balance, like the voice's) on each oscillator's own signal; ring
        // modulation takes the unpanned signals. Right-channel levels differ with a stereo LFO.
        const pa = this.opA0 + (this.opA1 - this.opA0) * t;
        const pb = this.opB0 + (this.opB1 - this.opB0) * t;
        const laR = la + (this.dLv0[0] + (this.dLv1[0] - this.dLv0[0]) * t);
        const lbR = lb + (this.dLv0[1] + (this.dLv1[1] - this.dLv0[1]) * t);
        x = la * saL * (pa > 0 ? 1 - pa : 1) + lb * sbL * (pb > 0 ? 1 - pb : 1) + lr * saL * sbL;
        xr = laR * saR * (pa < 0 ? 1 + pa : 1) + lbR * sbR * (pb < 0 ? 1 + pb : 1) + lr * saR * sbR;
      } else {
        x = la * saL + lb * sbL + lr * saL * sbL;
        xr = x;
      }
      if (ls > 0) {
        if (s.subWave === 'square') {
          let q = this.subPhase < 0.5 ? 1 : -1;
          q += polyBlep(this.subPhase, incS);
          const h = this.subPhase + 0.5;
          q -= polyBlep(h >= 1 ? h - 1 : h, incS);
          x += ls * q * 0.7;
          xr += ls * q * 0.7;
        } else {
          const q = ls * Math.sin(TWO_PI * this.subPhase);
          x += q;
          xr += q;
        }
      }
      if (ln > 0) {
        const w = this.noise.bipolar();
        let q: number;
        if (s.noiseType === 'pink') {
          this.pink0 = 0.99765 * this.pink0 + w * 0.099046;
          this.pink1 = 0.963 * this.pink1 + w * 0.2965164;
          this.pink2 = 0.57 * this.pink2 + w * 1.0526913;
          q = ln * (this.pink0 + this.pink1 + this.pink2 + w * 0.1848) * PINK_GAIN;
        } else q = ln * w;
        if (stereo && this.nwS !== 0) {
          // Noise width: a second, independent stream mixed in with opposite signs (the
          // channels decorrelate; each keeps the same loudness).
          const w2 = this.noiseR.bipolar();
          let q2: number;
          if (s.noiseType === 'pink') {
            this.pinkR0 = 0.99765 * this.pinkR0 + w2 * 0.099046;
            this.pinkR1 = 0.963 * this.pinkR1 + w2 * 0.2965164;
            this.pinkR2 = 0.57 * this.pinkR2 + w2 * 1.0526913;
            q2 = ln * (this.pinkR0 + this.pinkR1 + this.pinkR2 + w2 * 0.1848) * PINK_GAIN;
          } else q2 = ln * w2;
          x += this.nwC * q + this.nwS * q2;
          xr += this.nwC * q - this.nwS * q2;
        } else {
          x += q;
          xr += q;
        }
      }
      const cut = this.cut0 + (this.cut1 - this.cut0) * t + fe * s.envAmount * FILTER_ENV_OCTAVES;
      let cutL = cut;
      let cutR = cut;
      if (stereo) {
        // Filter spread / a stereo LFO on the cutoff.
        const oL = this.offL0 + (this.offL1 - this.offL0) * t;
        const oR = this.offR0 + (this.offR1 - this.offR0) * t;
        if (oL !== 0) cutL += oL;
        if (oR !== 0) cutR += oR;
      }
      const g = cutoffG(Math.pow(2, cutL), this.sampleRate);
      const k = this.k0 + (this.k1 - this.k0) * t;
      const mode = FILTER_MODE_INDEX[s.filterMode];
      const amp = e * this.gain;
      yL = driveSample(this.filter.process(driveSample(x, this.driveM), mode, g, k), s.sat) * amp;
      if (stereo) {
        const gR = cutR === cutL ? g : cutoffG(Math.pow(2, cutR), this.sampleRate);
        yR = driveSample(this.filterR.process(driveSample(xr, this.driveM), mode, gR, k), s.sat) * (e * this.gainR);
        if (s.width !== 1) {
          const m = (yL + yR) * 0.5;
          const d = (yL - yR) * 0.5 * s.width;
          yL = m + d;
          yR = m - d;
        }
        yR = softLimit(yR);
      }
      yL = softLimit(yL);
      if (!stereo) yR = yL;
    }
    // Advance. The virtual centre copies (ratio 1) are the masters: their wraps drive
    // Step-mode table switches and hard sync, whatever the unison count.
    let synced = false;
    this.phCB += incB;
    if (this.phCB >= 1) {
      this.phCB -= Math.floor(this.phCB);
      this.b.wrapped(tables);
      if (this.rB) this.bR.wrapped(tables);
      if (s.sync) {
        // Restart A where it would be had it started at B's wrap (less aliasing than 0):
        // the fraction of this sample after the wrap, at A's own increments.
        const frac = incB > 0 ? this.phCB / incB : 0;
        this.phCA = (frac * incA) % 1;
        for (let j = 0; j < this.uA; j++) this.phA[j] = (frac * incA * this.ratA[j]) % 1;
        this.a.wrapped(tables);
        if (this.rA) this.aR.wrapped(tables);
        synced = true;
      }
    }
    for (let i = 0; i < this.uB; i++) {
      const ph = this.phB[i] + incB * this.ratB[i];
      this.phB[i] = ph >= 1 ? ph - Math.floor(ph) : ph;
    }
    // After a sync reset A's phases already hold this sample's advance.
    if (!synced) {
      this.phCA += incA;
      if (this.phCA >= 1) {
        this.phCA -= Math.floor(this.phCA);
        this.a.wrapped(tables);
        if (this.rA) this.aR.wrapped(tables);
      }
      for (let i = 0; i < this.uA; i++) {
        const ph = this.phA[i] + incA * this.ratA[i];
        this.phA[i] = ph >= 1 ? ph - Math.floor(ph) : ph;
      }
    }

    this.subPhase += incS;
    if (this.subPhase >= 1) this.subPhase -= Math.floor(this.subPhase);
    this.outL = yL;
    this.outR = yR;
    return (yL + yR) * 0.5;
  }
}
