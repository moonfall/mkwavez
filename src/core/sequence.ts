import { MAX_STEPS, SCALE_ROOT_HZ, SCALE_ROWS, SCALE_SEMITONES } from './constants';
import { Prng } from './prng';

/** A step sequence (test/dev construct) targeting one voice. */
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

/** Samples per sequencer step (eighth notes at `bpm`). */
export function stepSamples(bpm: number, sampleRate: number): number {
  return (sampleRate * 60) / bpm / 2;
}
