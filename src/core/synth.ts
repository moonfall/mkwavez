/**
 * Synth voice parameters: plain data (shared verbatim between UI, engine, sessions and
 * presets), defaults and validation. A voice's `type` picks its signal path:
 *
 *  - 'simple': the original voice (one wavetable oscillator with position LFOs and an
 *    amplitude ADSR). Every voice saved before Synth voices existed is Simple, and sounds
 *    exactly as it did.
 *  - 'synth': two wavetable oscillators (A: the voice's own wavetable / window / position;
 *    B: `synth.b`), sub oscillator, noise, ring modulation → multimode filter → amp, with
 *    filter / pitch envelopes, glide, and a stereo path (unison spread, per-oscillator pan,
    stereo phase / position, noise width, filter spread, stereo LFOs, width, pan; see
    engine/synthVoice.ts).
 *
 * Every voice carries a `synth` block (Simple voices keep it, unused), so switching a voice's
 * type keeps its synth settings.
 */

import {
  DEFAULT_LFO,
  EMPTY_SLOT,
  LFO_COUNT,
  LFO_DIVS,
  LFO_RATE_MAX_HZ,
  LFO_RATE_MIN_HZ,
  LFO_SHAPES,
  MOD_DESTS,
  MOD_SLOTS,
  MOD_SOURCES,
  type LfoParams,
  type ModEnvMode,
  type ModSlot,
} from './modulation';

export type VoiceType = 'simple' | 'synth';
export const VOICE_TYPES: readonly VoiceType[] = ['simple', 'synth'];

/** LP12 / HP / BP / notch: one zero-delay-feedback SVF; LP24: two cascaded. */
export type FilterMode = 'lp12' | 'lp24' | 'hp' | 'bp' | 'notch';
export const FILTER_MODES: readonly FilterMode[] = ['lp12', 'lp24', 'hp', 'bp', 'notch'];
export const FILTER_MODE_LABELS: Readonly<Record<FilterMode, string>> = { lp12: 'LP12', lp24: 'LP24', hp: 'HP', bp: 'BP', notch: 'Notch' };

export type SubWave = 'sine' | 'square';
export const SUB_WAVES: readonly SubWave[] = ['sine', 'square'];
export type NoiseType = 'white' | 'pink';
export const NOISE_TYPES: readonly NoiseType[] = ['white', 'pink'];
/**
 * Oscillator warp: how an oscillator reads its table (the table itself is unchanged).
 * Sync reads the cycle up to WARP_SYNC_MAX times per period; formant does the same under a
 * smooth window; bend is a smooth phase distortion; squeeze moves the cycle's midpoint
 * (pulse-width-like); quantize steps the phase (lo-fi); fold wavefolds the output.
 */
export type WarpMode = 'none' | 'sync' | 'formant' | 'bend' | 'squeeze' | 'quantize' | 'fold';
export const WARP_MODES: readonly WarpMode[] = ['none', 'sync', 'formant', 'bend', 'squeeze', 'quantize', 'fold'];
export const WARP_LABELS: Readonly<Record<WarpMode, string>> = {
  none: 'Off',
  sync: 'Sync',
  formant: 'Formant',
  bend: 'Bend',
  squeeze: 'Squeeze',
  quantize: 'Quantize',
  fold: 'Fold',
};
/** Sync / formant warp at amount ±1: the cycle is read this many times per period. */
export const WARP_SYNC_MAX = 8;

/** Which oscillator(s) the pitch envelope bends. */
export type PitchTarget = 'a' | 'b' | 'ab';
export const PITCH_TARGETS: readonly PitchTarget[] = ['a', 'b', 'ab'];

/** Where an oscillator reads: a wavetable, an inclusive X / Y window and a position (0..1) per axis. */
export interface OscSource {
  readonly wavetableId: number;
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly windowStartY: number;
  readonly windowEndY: number;
  readonly position: number;
  readonly positionY: number;
}

export const OSC_SOURCE_KEYS = ['wavetableId', 'windowStart', 'windowEnd', 'windowStartY', 'windowEndY', 'position', 'positionY'] as const;

export interface SynthParams {
  /** Osc A (reads the voice's own wavetable / window / position): octave ±3, coarse ±24 st, fine ±100 cents, level 0..1. */
  readonly aOct: number;
  readonly aCoarse: number;
  readonly aFine: number;
  readonly aLevel: number;
  /** Osc B: its own wavetable / window / position, and tuning / level like A. */
  readonly b: OscSource;
  readonly bOct: number;
  readonly bCoarse: number;
  readonly bFine: number;
  readonly bLevel: number;
  /** Sub oscillator: 1 or 2 octaves below osc A. */
  readonly subWave: SubWave;
  readonly subOct: number;
  readonly subLevel: number;
  /** Seeded noise (deterministic per voice). */
  readonly noiseType: NoiseType;
  readonly noiseLevel: number;
  /** Ring modulation A × B. */
  readonly ringLevel: number;
  /** Filter: cutoff in Hz; resonance 0..1 (1 = near self-oscillation); drive 0..1. */
  readonly filterMode: FilterMode;
  readonly cutoff: number;
  readonly resonance: number;
  readonly drive: number;
  /** Key tracking 0..1 (1 = the cutoff follows the note 1:1, around middle C). */
  readonly keyTrack: number;
  /** Filter envelope amount −1..1 (± FILTER_ENV_OCTAVES octaves). */
  readonly envAmount: number;
  /** Velocity → cutoff 0..1: softer notes close the filter by up to FILTER_VEL_OCTAVES octaves. */
  readonly velAmount: number;
  /** Filter ADSR (seconds, seconds, 0..1, seconds). */
  readonly fAttack: number;
  readonly fDecay: number;
  readonly fSustain: number;
  readonly fRelease: number;
  /** Pitch envelope: attack / decay (seconds), amount −24..24 semitones at its peak, target osc(s). */
  readonly pAttack: number;
  readonly pDecay: number;
  readonly pAmount: number;
  readonly pTarget: PitchTarget;
  /** Velocity → amplitude 0..1 (0: every note at full level; 1: the Simple voice's velocity curve). */
  readonly velAmp: number;
  /** Portamento time (seconds, 0 = off); legato only: glide only between overlapping notes. */
  readonly glide: number;
  readonly glideLegato: boolean;
  /** Pitch-bend range in semitones (full wheel). */
  readonly bendRange: number;
  /** Stereo position −1 (left) .. 1 (right). */
  readonly pan: number;
  /** Three LFOs (see core/modulation.ts). */
  readonly lfos: readonly LfoParams[];
  /** Mod envelope (a matrix source): AD or ADSR. */
  readonly mAttack: number;
  readonly mDecay: number;
  readonly mSustain: number;
  readonly mRelease: number;
  readonly mMode: ModEnvMode;
  /** Mod matrix: MOD_SLOTS slots of source → destination × amount. */
  readonly mods: readonly ModSlot[];
  /** Hard sync: osc B's cycle restarts osc A. */
  readonly sync: boolean;
  /** FM: osc B modulates osc A's phase, 0..1 (1 = ±FM_DEPTH cycles). */
  readonly fm: number;
  /** Unison per oscillator: 1..MAX_UNISON copies, detune (± cents at the outer copies), stereo spread 0..1. */
  readonly aUnison: number;
  readonly aDetune: number;
  readonly aSpread: number;
  readonly bUnison: number;
  readonly bDetune: number;
  readonly bSpread: number;
  /** Saturation after the filter, 0..1. */
  readonly sat: number;
  /** Stereo width of the voice (0 = mono, 1 = as is, 2 = wider). */
  readonly width: number;
  /** Stereo position of each oscillator −1 (left) .. 1 (right): a balance pan on its own signal, before the filter. */
  readonly aPan: number;
  readonly bPan: number;
  /**
   * Stereo phase per oscillator, 0..0.5 cycles: the right channel reads the oscillator this
   * far ahead of the left (0.5 = opposite phase; cancels odd harmonics in a mono sum).
   */
  readonly aPhaseSpread: number;
  readonly bPhaseSpread: number;
  /**
   * Stereo position per oscillator, 0..1: the left channel reads the window at position −
   * spread / 2, the right at + spread / 2 (X axis; reflected at the window's edges).
   */
  readonly aPosSpread: number;
  readonly bPosSpread: number;
  /** Noise stereo width 0..1 (0 = the same noise on both sides, 1 = uncorrelated left / right). */
  readonly noiseWidth: number;
  /** Filter cutoff spread −1..1: the left cutoff moves down and the right up (1 = FILTER_SPREAD_OCTAVES apart). */
  readonly filterSpread: number;
  /**
   * Polyphony: notes the voice plays at once, 1..MAX_POLY. 1 = monophonic (last-note
   * priority, legato, glide between held notes). Saved data without it is monophonic.
   */
  readonly poly: number;
  /**
   * Warp per oscillator (WarpMode) and its amount −1..1. Sync, formant, quantize and fold
   * use the magnitude; bend and squeeze use the sign for direction.
   */
  readonly aWarp: WarpMode;
  readonly aWarpAmt: number;
  readonly bWarp: WarpMode;
  readonly bWarpAmt: number;
  /**
   * Macros 0..1: matrix sources (Macro 1–4) set by hand, MIDI CC or host automation — one
   * knob can drive several destinations.
   */
  readonly macro1: number;
  readonly macro2: number;
  readonly macro3: number;
  readonly macro4: number;
  /** Oscillator phase at each note (PhaseMode). */
  readonly phaseMode: PhaseMode;
}

export const MACRO_KEYS = ['macro1', 'macro2', 'macro3', 'macro4'] as const;

export const MAX_UNISON = 8;
/**
 * Oscillator phase at a note (both oscillators and the sub): free-running (the default),
 * reset to the start (unison copies at their fixed offsets), or random per note and copy.
 * Legato notes keep the phase.
 */
export type PhaseMode = 'free' | 'reset' | 'random';
export const PHASE_MODES: readonly PhaseMode[] = ['free', 'reset', 'random'];
export const PHASE_MODE_LABELS: Readonly<Record<PhaseMode, string>> = { free: 'Free', reset: 'Reset', random: 'Random' };
/** Most notes one Synth voice plays at once. */
export const MAX_POLY = 8;
/** Phase modulation depth at FM 1, in cycles of osc A. */
export const FM_DEPTH = 1.5;

/** Filter envelope amount 1 = this many octaves. */
export const FILTER_ENV_OCTAVES = 6;
/** Velocity amount 1: velocity 0 closes the cutoff by this many octaves (velocity 127: none). */
export const FILTER_VEL_OCTAVES = 4;
/** Filter spread ±1 = the two channels' cutoffs this many octaves apart. */
export const FILTER_SPREAD_OCTAVES = 2;
export const CUTOFF_MIN = 20;
export const CUTOFF_MAX = 20000;

export const DEFAULT_SOURCE: OscSource = {
  wavetableId: 0,
  windowStart: 0,
  windowEnd: 0,
  windowStartY: 0,
  windowEndY: 0,
  position: 0.5,
  positionY: 0.5,
};

/** The Init patch. */
export const DEFAULT_SYNTH: SynthParams = {
  aOct: 0,
  aCoarse: 0,
  aFine: 0,
  aLevel: 0.8,
  b: DEFAULT_SOURCE,
  bOct: 0,
  bCoarse: 0,
  bFine: 7,
  bLevel: 0,
  subWave: 'sine',
  subOct: 1,
  subLevel: 0,
  noiseType: 'white',
  noiseLevel: 0,
  ringLevel: 0,
  filterMode: 'lp24',
  cutoff: 2400,
  resonance: 0.15,
  drive: 0,
  keyTrack: 0.5,
  envAmount: 0.3,
  velAmount: 0.3,
  fAttack: 0.004,
  fDecay: 0.45,
  fSustain: 0.35,
  fRelease: 0.3,
  pAttack: 0.001,
  pDecay: 0.08,
  pAmount: 0,
  pTarget: 'ab',
  velAmp: 0.7,
  glide: 0,
  glideLegato: true,
  bendRange: 2,
  pan: 0,
  lfos: [
    { ...DEFAULT_LFO, rate: 0.25 },
    { ...DEFAULT_LFO, rate: 5, fade: 0.4 },
    { ...DEFAULT_LFO, shape: 'sh', sync: true, div: '1/8' },
  ],
  mAttack: 0.01,
  mDecay: 0.6,
  mSustain: 0,
  mRelease: 0.3,
  mMode: 'ad',
  // An evolving wavetable by default: LFO 1 sweeps osc A's position.
  mods: [{ src: 'lfo1', dst: 'posA', amt: 0.3 }, ...Array.from({ length: MOD_SLOTS - 1 }, () => EMPTY_SLOT)],
  sync: false,
  fm: 0,
  aUnison: 1,
  aDetune: 12,
  aSpread: 0.6,
  bUnison: 1,
  bDetune: 12,
  bSpread: 0.6,
  sat: 0,
  width: 1,
  aPan: 0,
  bPan: 0,
  aPhaseSpread: 0,
  bPhaseSpread: 0,
  aPosSpread: 0,
  bPosSpread: 0,
  noiseWidth: 0,
  filterSpread: 0,
  poly: 8,
  aWarp: 'none',
  aWarpAmt: 0,
  bWarp: 'none',
  bWarpAmt: 0,
  macro1: 0,
  macro2: 0,
  macro3: 0,
  macro4: 0,
  phaseMode: 'free',
};

/** Amp ADSR of a new Synth voice (Simple voices keep their own defaults). */
export const SYNTH_AMP_DEFAULTS = { attack: 0.004, decay: 0.4, sustain: 0.7, release: 0.25 } as const;

/** Numeric ranges: [min, max, integer?]. Values outside are clamped; non-finite → default. */
export const SYNTH_RANGES: Readonly<Partial<Record<keyof SynthParams, readonly [number, number, boolean?]>>> = {
  aOct: [-3, 3, true],
  aCoarse: [-24, 24, true],
  aFine: [-100, 100],
  aLevel: [0, 1],
  bOct: [-3, 3, true],
  bCoarse: [-24, 24, true],
  bFine: [-100, 100],
  bLevel: [0, 1],
  subOct: [1, 2, true],
  subLevel: [0, 1],
  noiseLevel: [0, 1],
  ringLevel: [0, 1],
  cutoff: [CUTOFF_MIN, CUTOFF_MAX],
  resonance: [0, 1],
  drive: [0, 1],
  keyTrack: [0, 1],
  envAmount: [-1, 1],
  velAmount: [0, 1],
  fAttack: [0, 10],
  fDecay: [0, 10],
  fSustain: [0, 1],
  fRelease: [0, 10],
  pAttack: [0, 10],
  pDecay: [0, 10],
  pAmount: [-24, 24],
  velAmp: [0, 1],
  glide: [0, 5],
  bendRange: [0, 24, true],
  pan: [-1, 1],
  mAttack: [0, 10],
  mDecay: [0, 10],
  mSustain: [0, 1],
  mRelease: [0, 10],
  fm: [0, 1],
  aUnison: [1, MAX_UNISON, true],
  aDetune: [0, 100],
  aSpread: [0, 1],
  bUnison: [1, MAX_UNISON, true],
  bDetune: [0, 100],
  bSpread: [0, 1],
  sat: [0, 1],
  width: [0, 2],
  aPan: [-1, 1],
  bPan: [-1, 1],
  aPhaseSpread: [0, 0.5],
  bPhaseSpread: [0, 0.5],
  aPosSpread: [0, 1],
  bPosSpread: [0, 1],
  noiseWidth: [0, 1],
  filterSpread: [-1, 1],
  poly: [1, MAX_POLY, true],
  aWarpAmt: [-1, 1],
  bWarpAmt: [-1, 1],
  macro1: [0, 1],
  macro2: [0, 1],
  macro3: [0, 1],
  macro4: [0, 1],
};


/**
 * Matrix of saved data without one (a session from before the matrix): all slots empty, so
 * an existing voice keeps sounding as it did. (The default route LFO 1 → A position is only
 * for new voices and the Init preset: DEFAULT_SYNTH.)
 */
export const EMPTY_MODS: readonly ModSlot[] = Array.from({ length: MOD_SLOTS }, () => EMPTY_SLOT);

const ENUMS: Readonly<Partial<Record<keyof SynthParams, readonly string[]>>> = {

  subWave: SUB_WAVES,
  noiseType: NOISE_TYPES,
  filterMode: FILTER_MODES,
  pTarget: PITCH_TARGETS,
  mMode: ['ad', 'adsr'],
  aWarp: WARP_MODES,
  bWarp: WARP_MODES,
  phaseMode: PHASE_MODES,
};

/** One LFO from untrusted data. */
export function normalizeLfo(raw: unknown, def: LfoParams = DEFAULT_LFO): LfoParams {
  const o = isObj(raw) ? raw : {};
  return {
    shape: (LFO_SHAPES as readonly unknown[]).includes(o.shape) ? (o.shape as LfoParams['shape']) : def.shape,
    rate: clampNum(o.rate, def.rate, [LFO_RATE_MIN_HZ, LFO_RATE_MAX_HZ]),
    sync: typeof o.sync === 'boolean' ? o.sync : def.sync,
    div: (LFO_DIVS as readonly unknown[]).includes(o.div) ? (o.div as LfoParams['div']) : def.div,
    retrig: typeof o.retrig === 'boolean' ? o.retrig : def.retrig,
    phase: clampNum(o.phase, def.phase, [0, 1]),
    stereo: clampNum(o.stereo, def.stereo, [0, 0.5]),
    fade: clampNum(o.fade, def.fade, [0, 10]),
    depth: clampNum(o.depth, def.depth, [0, 1]),
  };
}

/** One matrix slot from untrusted data (unknown source / destination → none). */
export function normalizeSlot(raw: unknown): ModSlot {
  const o = isObj(raw) ? raw : {};
  return {
    src: (MOD_SOURCES as readonly unknown[]).includes(o.src) ? (o.src as ModSlot['src']) : 'none',
    dst: (MOD_DESTS as readonly unknown[]).includes(o.dst) ? (o.dst as ModSlot['dst']) : 'none',
    amt: clampNum(o.amt, 0, [-1, 1]),
  };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export function isVoiceType(x: unknown): x is VoiceType {
  return x === 'simple' || x === 'synth';
}

function clampNum(x: unknown, def: number, r?: readonly [number, number, boolean?]): number {
  if (!fin(x)) return def;
  if (!r) return x;
  const v = Math.max(r[0], Math.min(r[1], x));
  return r[2] ? Math.round(v) : v;
}

/** An oscillator source from untrusted data (window rounding / clamping to a wavetable is the caller's). */
export function normalizeSource(raw: unknown, fallback: OscSource = DEFAULT_SOURCE): OscSource {
  const o = isObj(raw) ? raw : {};
  return {
    wavetableId: Number.isInteger(o.wavetableId) ? (o.wavetableId as number) : fallback.wavetableId,
    windowStart: fin(o.windowStart) ? Math.round(o.windowStart) : fallback.windowStart,
    windowEnd: fin(o.windowEnd) ? Math.round(o.windowEnd) : fallback.windowEnd,
    windowStartY: fin(o.windowStartY) ? Math.round(o.windowStartY) : fallback.windowStartY,
    windowEndY: fin(o.windowEndY) ? Math.round(o.windowEndY) : fallback.windowEndY,
    position: clampNum(o.position, fallback.position, [0, 1]),
    positionY: clampNum(o.positionY, fallback.positionY, [0, 1]),
  };
}

/**
 * Synth params from untrusted data (sessions, presets, imports): every known field is
 * validated (wrong type / non-finite → default, numbers clamped to SYNTH_RANGES, enums
 * checked); unknown fields are kept (forward compatibility).
 */
export function normalizeSynth(raw: unknown, fallbackSource: OscSource = DEFAULT_SOURCE): SynthParams {
  const o = isObj(raw) ? raw : {};
  const out: Record<string, unknown> = { ...o };
  for (const [k, def] of Object.entries(DEFAULT_SYNTH) as [keyof SynthParams, unknown][]) {
    const v = o[k];
    if (k === 'b') out.b = normalizeSource(v, fallbackSource);
    else if (k === 'lfos') out.lfos = Array.from({ length: LFO_COUNT }, (_, i) => normalizeLfo(Array.isArray(v) ? v[i] : undefined, DEFAULT_SYNTH.lfos[i]));
    else if (k === 'mods') out.mods = Array.isArray(v) ? Array.from({ length: MOD_SLOTS }, (_, i) => normalizeSlot(v[i])) : EMPTY_MODS;
    // Saved before polyphony: monophonic, as it was (new voices get the Init patch's).
    else if (k === 'poly') out.poly = v === undefined ? 1 : clampNum(v, 1, SYNTH_RANGES.poly);

    else if (typeof def === 'number') out[k] = clampNum(v, def, SYNTH_RANGES[k]);
    else if (typeof def === 'boolean') out[k] = typeof v === 'boolean' ? v : def;
    else if (typeof def === 'string') out[k] = typeof v === 'string' && (ENUMS[k] ?? []).includes(v) ? v : def;
  }
  return out as unknown as SynthParams;
}

/** Semitone offset of an oscillator's tuning (octave, coarse, fine). */
export function oscSemis(oct: number, coarse: number, fine: number): number {
  return oct * 12 + coarse + fine / 100;
}
