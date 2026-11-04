/** Generate → Sample: pitch detection and turning takes into waveforms. */
import type { Recipe } from '../table';

export * from './pitch';
export * from './extract';
export * from './harmonic';

/** What a sampled waveform was made with (its recipe can't re-render it: the take isn't stored). */
export const SAMPLE_MODES = ['Single cycle', 'Series', 'Harmonic snapshot'] as const;

/**
 * The recipe of a sampled waveform: op 'sample', recording the take's name, the mode, the
 * position and the frequency used. The waveform's samples are what the session keeps.
 */
export function sampleRecipe(take: string, mode: number, at: number, freq: number, index: number, count: number, extra: Record<string, number | string> = {}): Recipe {
  return {
    op: 'sample',
    params: { take, mode: SAMPLE_MODES[mode] ?? 'Single cycle', at: Math.round(at * 1000) / 1000, freq: Math.round(freq * 100) / 100, ...extra },
    seed: 0,
    parents: [],
    batch: { index, count },
  };
}
