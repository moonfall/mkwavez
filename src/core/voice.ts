import { remapWindow } from './timeline';
import type { WavetableId } from './wavetable';

export type Interp = 'blend' | 'step';

/** One monophonic voice. Plain data: shared verbatim between UI, engine and (later) presets. */
export interface VoiceParams {
  readonly id: number;
  readonly name: string;
  readonly wavetableId: WavetableId;
  /** Inclusive window over the wavetable (indices). */
  readonly windowStart: number;
  readonly windowEnd: number;
  /** Position within the window, 0..1. */
  readonly position: number;
  /** LFO on position: depth 0..1 (1 = sweep the whole window from position 0.5), rate Hz. */
  readonly lfoDepth: number;
  readonly lfoRate: number;
  /** Initial LFO phase (radians), applied when the voice is created. */
  readonly lfoPhase: number;
  /** Blend crossfades neighbours; Step holds one table and switches on phase wrap. */
  readonly interp: Interp;
  readonly octave: number;
  /** 0..1 */
  readonly level: number;
  readonly mute: boolean;
  /** ADSR: seconds, seconds, level 0..1, seconds. */
  readonly attack: number;
  readonly decay: number;
  readonly sustain: number;
  readonly release: number;
}

export const DEFAULT_VOICE: Omit<VoiceParams, 'id' | 'name'> = {
  wavetableId: 0,
  windowStart: 0,
  windowEnd: 0,
  position: 0.5,
  lfoDepth: 0.5,
  lfoRate: 0.25,
  lfoPhase: 0,
  interp: 'blend',
  octave: 0,
  level: 0.8,
  mute: false,
  attack: 0.004,
  decay: 0.35,
  sustain: 0.25,
  release: 0.2,
};

/**
 * Position actually played: position + depth/2 * sin(lfoPhase), reflected back into
 * [0, 1] (as the prototype did) so the LFO bounces off the window edges.
 */
export function modulatedPosition(position: number, depth: number, lfoPhase: number): number {
  let p = position + depth * 0.5 * Math.sin(lfoPhase);
  p = Math.abs(p);
  if (p > 1) p = 2 - p;
  return Math.max(0, Math.min(1, p));
}

export type AppendMode =
  | { readonly kind: 'single' }
  | { readonly kind: 'batch'; readonly count: number; readonly targets: ReadonlySet<number> };

/**
 * Window following after tables are appended to a wavetable (prototype behaviour):
 *  - eviction shifts windows so they keep pointing at the same tables;
 *  - single add: a window whose end was on the newest table extends to the new newest;
 *  - batch: targeted voices get a window spanning exactly the batch.
 * Voices on other wavetables are returned unchanged.
 */
export function followAppend(
  voices: readonly VoiceParams[],
  wavetableId: WavetableId,
  oldLength: number,
  newLength: number,
  evictedIndices: readonly number[],
  mode: AppendMode,
): VoiceParams[] {
  return voices.map((v) => {
    if (v.wavetableId !== wavetableId) return v;
    const following = v.windowEnd >= oldLength - 1;
    let [s, e] = remapWindow(v.windowStart, v.windowEnd, evictedIndices, newLength);
    if (mode.kind === 'single' && following) e = newLength - 1;
    if (mode.kind === 'batch' && mode.targets.has(v.id)) {
      s = Math.max(0, newLength - mode.count);
      e = newLength - 1;
    }
    if (s === v.windowStart && e === v.windowEnd) return v;
    return { ...v, windowStart: s, windowEnd: e };
  });
}
