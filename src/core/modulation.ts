/**
 * Synth voice modulation: three LFOs, a mod envelope and an 8-slot mod matrix. Plain data
 * (part of SynthParams), the source / destination lists, LFO shapes, tempo-sync divisions
 * and the matrix arithmetic. Portable, allocation-free per call (callers own the buffers).
 */

/**
 * Periodic shapes, two random ones (S&H, smooth random) and two one-shots: rise (0 → 1) and
 * fall (1 → 0) run one cycle from each note and then hold — envelopes with the LFO's rate,
 * fade and depth.
 */
export type LfoShape = 'sine' | 'tri' | 'saw' | 'square' | 'sh' | 'smooth' | 'rise' | 'fall' | 'fig8' | 'lissajous' | 'squarePath' | 'walk';
export const LFO_SHAPES: readonly LfoShape[] = ['sine', 'tri', 'saw', 'square', 'sh', 'smooth', 'rise', 'fall', 'fig8', 'lissajous', 'squarePath', 'walk'];
export const LFO_SHAPE_LABELS: Readonly<Record<LfoShape, string>> = {
  sine: 'Sine',
  tri: 'Triangle',
  saw: 'Saw',
  square: 'Square',
  sh: 'S&H',
  smooth: 'Smooth random',
  rise: 'Rise (once)',
  fall: 'Fall (once)',
  fig8: 'Figure 8 (2D)',
  lissajous: 'Lissajous 3:2 (2D)',
  squarePath: 'Square path (2D)',
  walk: 'Random walk (2D)',
};

/** Tempo-synced LFO cycle lengths (whole notes; T = triplet, D = dotted). */
export type LfoDiv = '8/1' | '4/1' | '2/1' | '1/1' | '1/2' | '1/2D' | '1/2T' | '1/4' | '1/4D' | '1/4T' | '1/8' | '1/8D' | '1/8T' | '1/16' | '1/16T' | '1/32';
export const LFO_DIVS: readonly LfoDiv[] = ['8/1', '4/1', '2/1', '1/1', '1/2', '1/2D', '1/2T', '1/4', '1/4D', '1/4T', '1/8', '1/8D', '1/8T', '1/16', '1/16T', '1/32'];
/** Beats (quarter notes) per LFO cycle. */
export const LFO_DIV_BEATS: Readonly<Record<LfoDiv, number>> = {
  '8/1': 32,
  '4/1': 16,
  '2/1': 8,
  '1/1': 4,
  '1/2': 2,
  '1/2D': 3,
  '1/2T': 4 / 3,
  '1/4': 1,
  '1/4D': 1.5,
  '1/4T': 2 / 3,
  '1/8': 0.5,
  '1/8D': 0.75,
  '1/8T': 1 / 3,
  '1/16': 0.25,
  '1/16T': 1 / 6,
  '1/32': 0.125,
};

export const LFO_RATE_MIN_HZ = 0.01;
export const LFO_RATE_MAX_HZ = 40;

export interface LfoParams {
  readonly shape: LfoShape;
  /** Free rate in Hz (used when not synced). */
  readonly rate: number;
  /** Tempo sync: one cycle per `div` at the transport's BPM. */
  readonly sync: boolean;
  readonly div: LfoDiv;
  /** Restart at `phase` on every (non-legato) note; otherwise free-running. */
  readonly retrig: boolean;
  /** Start phase 0..1. */
  readonly phase: number;
  /**
   * Stereo phase 0..0.5 cycles: the right channel's copy of the LFO runs this far ahead of
   * the left on the destinations that are per channel (STEREO_DESTS). Periodic shapes only:
   * S&H and smooth random are the same on both sides.
   */
  readonly stereo: number;
  /** Fade-in after each note (seconds, 0 = none). */
  readonly fade: number;
  /** Output depth 0..1. */
  readonly depth: number;
}

export const DEFAULT_LFO: LfoParams = { shape: 'sine', rate: 2, sync: false, div: '1/4', retrig: false, phase: 0, stereo: 0, fade: 0, depth: 1 };

/** Shapes a stereo phase applies to (the random ones draw one value per cycle for both sides). */
export function isPeriodicShape(shape: LfoShape): boolean {
  return shape !== 'sh' && shape !== 'smooth' && shape !== 'rise' && shape !== 'fall' && shape !== 'walk';
}

/** Random shapes (a new value per cycle; no fixed path). */
export function isRandomShape(shape: LfoShape): boolean {
  return shape === 'sh' || shape === 'smooth' || shape === 'walk';
}

/** One-shot shapes: one cycle from each note (always restarted), then hold their end value. */
export function isOneShot(shape: LfoShape): boolean {
  return shape === 'rise' || shape === 'fall';
}
export const LFO_COUNT = 3;

/** LFO rate in Hz at `bpm` (synced: one cycle per division). */
export function lfoRateHz(l: LfoParams, bpm: number): number {
  return l.sync ? bpm / 60 / LFO_DIV_BEATS[l.div] : l.rate;
}

/** Mod envelope: AD (attack, then decay to 0; ignores the gate) or ADSR (follows the gate). */
export type ModEnvMode = 'ad' | 'adsr';

export const MOD_SOURCES = ['lfo1', 'lfo2', 'lfo3', 'fenv', 'penv', 'menv', 'vel', 'wheel', 'at', 'key', 'rand', 'macro1', 'macro2', 'macro3', 'macro4', 'gate', 'slide', 'lfo1Y', 'lfo2Y', 'lfo3Y'] as const;
export type ModSource = (typeof MOD_SOURCES)[number];
export const MOD_SOURCE_LABELS: Readonly<Record<ModSource, string>> = {
  lfo1: 'LFO 1',
  lfo2: 'LFO 2',
  lfo3: 'LFO 3',
  fenv: 'Filter env',
  penv: 'Pitch env',
  menv: 'Mod env',
  vel: 'Velocity',
  wheel: 'Mod wheel',
  at: 'Aftertouch',
  key: 'Key',
  rand: 'Random',
  macro1: 'Macro 1',
  macro2: 'Macro 2',
  macro3: 'Macro 3',
  macro4: 'Macro 4',
  gate: 'Gate',
  slide: 'Slide (MPE)',
  lfo1Y: 'LFO 1 Y',
  lfo2Y: 'LFO 2 Y',
  lfo3Y: 'LFO 3 Y',
};

export const MOD_DESTS = [
  'pitchA',
  'pitchB',
  'posA',
  'posYA',
  'posB',
  'posYB',
  'levelA',
  'levelB',
  'sub',
  'noise',
  'cutoff',
  'res',
  'drive',
  'amp',
  'pan',
  'lfo1Rate',
  'lfo2Rate',
  'lfo3Rate',
  'panA',
  'panB',
  'fSpread',
  'warpA',
  'warpB',
  'fm',
  'ring',
  'sat',
  'width',
  'detuneA',
  'detuneB',
  'lfo1Depth',
  'lfo2Depth',
  'lfo3Depth',
] as const;
export type ModDest = (typeof MOD_DESTS)[number];
export const MOD_DEST_LABELS: Readonly<Record<ModDest, string>> = {
  pitchA: 'A pitch',
  pitchB: 'B pitch',
  posA: 'A pos X',
  posYA: 'A pos Y',
  posB: 'B pos X',
  posYB: 'B pos Y',
  levelA: 'A level',
  levelB: 'B level',
  sub: 'Sub level',
  noise: 'Noise level',
  cutoff: 'Cutoff',
  res: 'Resonance',
  drive: 'Drive',
  amp: 'Amp',
  pan: 'Pan',
  lfo1Rate: 'LFO 1 rate',
  lfo2Rate: 'LFO 2 rate',
  lfo3Rate: 'LFO 3 rate',
  panA: 'A pan',
  panB: 'B pan',
  fSpread: 'Filter spread',
  warpA: 'A warp',
  warpB: 'B warp',
  fm: 'FM amount',
  ring: 'Ring level',
  sat: 'Saturation',
  width: 'Width',
  detuneA: 'A detune',
  detuneB: 'B detune',
  lfo1Depth: 'LFO 1 depth',
  lfo2Depth: 'LFO 2 depth',
  lfo3Depth: 'LFO 3 depth',
};

/**
 * Destinations with a value per channel: a stereo LFO (LfoParams.stereo) drives the right
 * channel's copy from its own phase. The rest take the left (the LFO's own phase).
 */
export const STEREO_DESTS: readonly ModDest[] = ['posA', 'posYA', 'posB', 'posYB', 'levelA', 'levelB', 'cutoff', 'amp'];

export const SRC_INDEX: Readonly<Record<ModSource, number>> = Object.fromEntries(MOD_SOURCES.map((s, i) => [s, i])) as Record<ModSource, number>;
export const DST_INDEX: Readonly<Record<ModDest, number>> = Object.fromEntries(MOD_DESTS.map((d, i) => [d, i])) as Record<ModDest, number>;
export const N_SOURCES = MOD_SOURCES.length;
export const N_DESTS = MOD_DESTS.length;

/** Destination scaling at amount 1 (a source at full scale). */
export const MOD_PITCH_SEMIS = 12;
export const MOD_CUTOFF_OCTAVES = 6;
export const MOD_LFO_RATE_OCTAVES = 4;
/** Unison detune at amount 1 (cents, added to the knob's). */
export const MOD_DETUNE_CENTS = 50;

/** Unipolar (0..1) sources; the others are bipolar (−1..1). */
export const UNIPOLAR_SOURCES: ReadonlySet<ModSource> = new Set(['fenv', 'penv', 'menv', 'vel', 'wheel', 'at', 'macro1', 'macro2', 'macro3', 'macro4', 'gate', 'slide']);

export interface ModSlot {
  readonly src: ModSource | 'none';
  readonly dst: ModDest | 'none';
  /** −1..1 */
  readonly amt: number;
}

export const MOD_SLOTS = 8;
export const EMPTY_SLOT: ModSlot = { src: 'none', dst: 'none', amt: 0 };

/**
 * Sum the matrix into `dst` (N_DESTS entries, cleared first): each slot adds amt × source.
 * `src` holds the current source values (N_SOURCES entries, in MOD_SOURCES order).
 */
export function applyMatrix(slots: readonly ModSlot[], src: ArrayLike<number>, dst: Float64Array): void {
  dst.fill(0);
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (s.src === 'none' || s.dst === 'none' || s.amt === 0) continue;
    dst[DST_INDEX[s.dst]] += s.amt * src[SRC_INDEX[s.src]];
  }
}

/** Reflect a position back into [0, 1] (as the Simple voice's LFO does at the window edges). */
export function reflect01(p: number): number {
  if (!Number.isFinite(p)) return 0;
  // Triangle fold: any distance past an edge folds back (…, 2.3 → 0.3, −1.2 → 0.8).
  let x = Math.abs(p) % 2;
  if (x > 1) x = 2 - x;
  return x;
}

/**
 * Deterministic LFO waveform value at phase (0..1): sine, triangle (starts at 0, rising),
 * saw (rising −1..1), square (+1 first half). S&H and smooth random use `cur` / `prev`
 * (the random values of this cycle and the one before; see SynthVoice).
 */
export function lfoWave(shape: LfoShape, phase: number, cur = 0, prev = 0): number {
  switch (shape) {
    case 'sine':
      return Math.sin(2 * Math.PI * phase);
    case 'tri':
      return phase < 0.25 ? 4 * phase : phase < 0.75 ? 2 - 4 * phase : 4 * phase - 4;
    case 'saw':
      return 2 * phase - 1;
    case 'square':
      return phase < 0.5 ? 1 : -1;
    case 'sh':
      return cur;
    case 'smooth': {
      const t = 0.5 - 0.5 * Math.cos(Math.PI * phase);
      return prev + (cur - prev) * t;
    }
    case 'rise':
      return phase;
    case 'fall':
      return 1 - phase;
    // 2D paths (X here, Y in lfoWaveY).
    case 'fig8':
      return Math.sin(2 * Math.PI * phase);
    case 'lissajous':
      return Math.sin(2 * Math.PI * 3 * phase);
    case 'squarePath':
      return squarePath(phase, 0);
    case 'walk': {
      const t = 0.5 - 0.5 * Math.cos(Math.PI * phase);
      return prev + (cur - prev) * t;
    }
  }
}

/** The square path's X (axis 0) or Y (axis 1): the rectangle's edges, clockwise from (−1, −1). */
function squarePath(phase: number, axis: 0 | 1): number {
  const q = phase * 4;
  const k = Math.floor(q) % 4;
  const t = q - Math.floor(q);
  // Corners (−1,−1) → (1,−1) → (1,1) → (−1,1).
  const x = k === 0 ? -1 + 2 * t : k === 1 ? 1 : k === 2 ? 1 - 2 * t : -1;
  const y = k === 0 ? -1 : k === 1 ? -1 + 2 * t : k === 2 ? 1 : 1 - 2 * t;
  return axis === 0 ? x : y;
}

/**
 * An LFO's second output (Y; matrix sources LFO 1–3 Y). The 2D paths have their own Y
 * (figure 8: sin 2φ; Lissajous 3:2: sin 2·2πφ; square path; random walk: a second smooth
 * random, `curY` / `prevY`); periodic shapes give the same wave a quarter cycle on (sine →
 * a circle); S&H, smooth random and the one-shots give X again.
 */
export function lfoWaveY(shape: LfoShape, phase: number, cur = 0, prev = 0, curY = 0, prevY = 0): number {
  switch (shape) {
    case 'fig8':
      return Math.sin(4 * Math.PI * phase);
    case 'lissajous':
      return Math.sin(2 * Math.PI * 2 * phase);
    case 'squarePath':
      return squarePath(phase, 1);
    case 'walk': {
      const t = 0.5 - 0.5 * Math.cos(Math.PI * phase);
      return prevY + (curY - prevY) * t;
    }
    case 'sine':
    case 'tri':
    case 'saw':
    case 'square': {
      const q = phase + 0.25;
      return lfoWave(shape, q >= 1 ? q - 1 : q);
    }
    default:
      return lfoWave(shape, phase, cur, prev);
  }
}
