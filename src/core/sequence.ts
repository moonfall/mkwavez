import { MAX_STEPS, SCALE_ROOT_HZ, SCALE_ROWS, SCALE_SEMITONES } from './constants';
import { Prng } from './prng';

/**
 * A step sequence (test/dev construct) targeting one voice. Steps are `stepLength` notes
 * on the shared clock (see STEP_TICKS): every sequence counts from the transport start, so
 * sequences of any length / step length stay bar-aligned.
 */
export interface SequenceData {
  readonly id: number;
  /** Target voice id, or null (silent). */
  readonly voiceId: number | null;
  /** Active steps, 1..MAX_STEPS. */
  readonly length: number;
  /** MAX_STEPS entries; scale row 0..SCALE_ROWS-1, or -1 for a rest. */
  readonly steps: readonly number[];
  /** Gate length as a fraction of a step, 0.05..1. */
  readonly gate: number;
  /** Note value of one step (default 1/8; see STEP_TICKS). */
  readonly stepLength: StepLength;
}

/** Note value of one sequencer step: quarter, eighth, sixteenth, eighth / sixteenth triplet. */
export type StepLength = '1/4' | '1/8' | '1/16' | '1/8T' | '1/16T';
export const STEP_LENGTHS: readonly StepLength[] = ['1/4', '1/8', '1/16', '1/8T', '1/16T'];
/** Eighth notes: what every sequence played before step lengths existed (and still the default). */
export const DEFAULT_STEP_LENGTH: StepLength = '1/8';

/**
 * The shared clock's resolution: ticks per quarter note (one beat; BPM counts quarter
 * notes). 12 is the smallest grid every step length divides, so all of them line up.
 */
export const TICKS_PER_BEAT = 12;
/** 4/4. */
export const BEATS_PER_BAR = 4;
export const TICKS_PER_BAR = TICKS_PER_BEAT * BEATS_PER_BAR;

/** Clock ticks per step. Every value divides TICKS_PER_BAR, so bar lines are step boundaries. */
export const STEP_TICKS: Readonly<Record<StepLength, number>> = { '1/4': 12, '1/8': 6, '1/16': 3, '1/8T': 4, '1/16T': 2 };

/** Step length as a fraction of a whole note (1/8T: three in a quarter = 1/12). */
export const STEP_FRACTION: Readonly<Record<StepLength, number>> = { '1/4': 1 / 4, '1/8': 1 / 8, '1/16': 1 / 16, '1/8T': 1 / 12, '1/16T': 1 / 24 };

/**
 * Step length in quarter notes (4 × the fraction). The straight values are powers of two,
 * so `stepSamples(bpm, sr, '1/8')` is bit-identical to the old eighth-note `sr·60/bpm/2`.
 */
const STEP_BEATS: Readonly<Record<StepLength, number>> = { '1/4': 1, '1/8': 0.5, '1/16': 0.25, '1/8T': 1 / 3, '1/16T': 1 / 6 };

export function isStepLength(x: unknown): x is StepLength {
  return typeof x === 'string' && (STEP_LENGTHS as readonly string[]).includes(x);
}

/** A sequence's step length, falling back to the default for missing / unknown values. */
export function stepLengthOf(s: { readonly stepLength?: unknown }): StepLength {
  return isStepLength(s.stepLength) ? s.stepLength : DEFAULT_STEP_LENGTH;
}

/** Step duration in seconds: (60 / BPM) × (4 × step fraction). */
export function stepSeconds(bpm: number, len: StepLength = DEFAULT_STEP_LENGTH): number {
  return (60 / bpm) * (4 * STEP_FRACTION[len]);
}

/** Steps per beat (quarter note): 1, 2, 4, 3, 6. */
export function stepsPerBeat(len: StepLength): number {
  return TICKS_PER_BEAT / STEP_TICKS[len];
}

/** Steps per 4/4 bar: 4, 8, 16, 12, 24. */
export function stepsPerBar(len: StepLength): number {
  return TICKS_PER_BAR / STEP_TICKS[len];
}

/** The step a sequence plays at clock tick `tick` (-1 before the first tick). */
export function stepAtTick(tick: number, len: StepLength, length: number): number {
  if (tick < 0 || length <= 0) return -1;
  return Math.floor(tick / STEP_TICKS[len]) % length;
}

/** Where step `step` (0-based) sits in its pattern, as bar.beat (both 1-based): "1.3". */
export function stepBarBeat(step: number, len: StepLength): string {
  const t = step * STEP_TICKS[len];
  return `${Math.floor(t / TICKS_PER_BAR) + 1}.${Math.floor((t % TICKS_PER_BAR) / TICKS_PER_BEAT) + 1}`;
}

/** Fractions of a beat (in ticks) a pattern can end on. */
const BEAT_FRACTIONS: Readonly<Record<number, string>> = { 2: '⅙', 3: '¼', 4: '⅓', 6: '½', 8: '⅔', 9: '¾', 10: '⅚' };

/** A pattern's length in bars and beats: "2 bars", "3 beats", "1 bar 2½ beats". */
export function lengthBarsBeats(length: number, len: StepLength): string {
  const ticks = Math.max(0, length) * STEP_TICKS[len];
  const bars = Math.floor(ticks / TICKS_PER_BAR);
  const rest = ticks % TICKS_PER_BAR;
  const parts: string[] = [];
  if (bars) parts.push(`${bars} bar${bars === 1 ? '' : 's'}`);
  if (rest || !bars) {
    const beats = Math.floor(rest / TICKS_PER_BEAT);
    const frac = BEAT_FRACTIONS[rest % TICKS_PER_BEAT] ?? '';
    const many = beats > 1 || (beats === 1 && frac !== '') || (beats === 0 && frac === '');
    parts.push(`${beats || !frac ? beats : ''}${frac} beat${many ? 's' : ''}`);
  }
  return parts.join(' ');
}

/** "16 steps · 1/8 · 2 bars". */
export function sequenceSummary(length: number, len: StepLength): string {
  return `${length} step${length === 1 ? '' : 's'} · ${len} · ${lengthBarsBeats(length, len)}`;
}

export const REST = -1;

export function emptySteps(): number[] {
  return new Array(MAX_STEPS).fill(REST);
}

/** Steps array padded/truncated to MAX_STEPS. */
export function normalizeSteps(steps: readonly number[]): number[] {
  const out = emptySteps();
  for (let i = 0; i < Math.min(MAX_STEPS, steps.length); i++) {
    const r = Math.round(steps[i]);
    out[i] = r >= 0 && r < SCALE_ROWS ? r : REST;
  }
  return out;
}

export function noteFreq(row: number, octave: number): number {
  return SCALE_ROOT_HZ * Math.pow(2, SCALE_SEMITONES[row] / 12 + octave);
}

/** Toggle a cell: same row clears, otherwise sets. Returns a new steps array. */
export function toggleStep(steps: readonly number[], step: number, row: number): number[] {
  const out = steps.slice();
  out[step] = out[step] === row ? REST : row;
  return out;
}

/** Random pattern (step 0 always on), like the prototype's shuffle button. */
export function randomSteps(length: number, seed: number, density = 0.65): number[] {
  const r = new Prng(seed);
  const out = emptySteps();
  for (let i = 0; i < length; i++) out[i] = i === 0 || r.next() < density ? r.int(SCALE_ROWS) : REST;
  return out;
}

/** Samples per sequencer step at `bpm` (quarter-note beats); see stepSeconds. */
export function stepSamples(bpm: number, sampleRate: number, len: StepLength = DEFAULT_STEP_LENGTH): number {
  return ((sampleRate * 60) / bpm) * STEP_BEATS[len];
}
