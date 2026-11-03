import { DEFAULT_SYNTH, type OscSource, type SynthParams, type VoiceType } from './synth';
import { axisLength, clampWindow, type Wavetable, type WavetableEdit, type WavetableId } from './wavetable';

/**
 * One monophonic voice. Plain data: shared verbatim between UI, engine and (later) presets.
 * The window / position / LFO address the voice's wavetable: X along a row (1D: the only
 * axis), Y across rows (2D and Rows). Interpolation is a property of the wavetable.
 */
export interface VoiceParams {
  readonly id: number;
  readonly name: string;
  /**
   * Signal path (see core/synth.ts): 'simple' = the original voice; 'synth' = two
   * oscillators (A = this voice's wavetable / window / position, B = `synth.b`), sub, noise,
   * filter, envelopes. The amp ADSR, level, mute and octave below apply to both.
   */
  readonly type: VoiceType;
  /** Synth voice settings (kept, unused, on Simple voices). */
  readonly synth: SynthParams;
  readonly wavetableId: WavetableId;
  /** Inclusive X window (slot indices). Unused on Rows (position spans each whole row). */
  readonly windowStart: number;
  readonly windowEnd: number;
  /** Inclusive Y window (row indices; 2D and Rows). */
  readonly windowStartY: number;
  readonly windowEndY: number;
  /** Position within the window, 0..1, per axis. */
  readonly position: number;
  readonly positionY: number;
  /** LFOs on position: depth 0..1 (1 = sweep the whole window from position 0.5), rate Hz. */
  readonly lfoDepth: number;
  readonly lfoRate: number;
  readonly lfoDepthY: number;
  readonly lfoRateY: number;
  /** Initial LFO phases (radians), applied when the voice is created. */
  readonly lfoPhase: number;
  readonly lfoPhaseY: number;
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
  type: 'simple',
  synth: DEFAULT_SYNTH,
  wavetableId: 0,
  windowStart: 0,
  windowEnd: 0,
  windowStartY: 0,
  windowEndY: 0,
  position: 0.5,
  positionY: 0.5,
  lfoDepth: 0.5,
  lfoRate: 0.25,
  lfoDepthY: 0.5,
  lfoRateY: 0.17,
  lfoPhase: 0,
  lfoPhaseY: 0,
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

/** The voice's window as the playback mapping wants it. */
export function voiceWindow(v: Pick<VoiceParams, 'windowStart' | 'windowEnd' | 'windowStartY' | 'windowEndY'>): { x0: number; x1: number; y0: number; y1: number } {
  return { x0: v.windowStart, x1: v.windowEnd, y0: v.windowStartY, y1: v.windowEndY };
}

/** Window covering the whole wavetable (used when a voice switches wavetable). */
export function fullWindow(wt: Wavetable): Pick<VoiceParams, 'windowStart' | 'windowEnd' | 'windowStartY' | 'windowEndY'> {
  const w = wt.shape === 'rows' ? 1 : Math.max(1, ...wt.rows.map((r) => r.length));
  const h = wt.shape === '1d' ? 1 : Math.max(1, wt.rows.length);
  return { windowStart: 0, windowEnd: w - 1, windowStartY: 0, windowEndY: h - 1 };
}

/** The window fields of a voice or an oscillator source. */
type WindowFields = Pick<OscSource, 'wavetableId' | 'windowStart' | 'windowEnd' | 'windowStartY' | 'windowEndY'>;

/** Clamp a voice's (osc A) windows to its wavetable (start <= end on each axis). */
export function clampVoiceWindow(v: VoiceParams, wt: Wavetable): VoiceParams {
  return clampSourceWindow(v, wt);
}

/** Osc B's source with its window clamped to `wt` (its wavetable); the same voice if unchanged. */
export function clampOscB(v: VoiceParams, wt: Wavetable): VoiceParams {
  const b = clampSourceWindow(v.synth.b, wt);
  return b === v.synth.b ? v : { ...v, synth: { ...v.synth, b } };
}

/** Osc A's source (the voice's own wavetable / window / position). */
export function oscASource(v: VoiceParams): OscSource {
  return {
    wavetableId: v.wavetableId,
    windowStart: v.windowStart,
    windowEnd: v.windowEnd,
    windowStartY: v.windowStartY,
    windowEndY: v.windowEndY,
    position: v.position,
    positionY: v.positionY,
  };
}

/**
 * A voice parameter change: top-level fields replace, `synth` fields merge into the voice's
 * synth block (so a MIDI controller or a slider can change one synth parameter).
 */
export type VoicePatch = Partial<Omit<VoiceParams, 'synth'>> & { readonly synth?: Partial<SynthParams> };

export function applyVoicePatch(v: VoiceParams, p: VoicePatch): VoiceParams {
  if (!p.synth) return { ...v, ...(p as Partial<VoiceParams>) };
  return { ...v, ...p, synth: { ...v.synth, ...p.synth } };
}

/** Merge two patches (the later wins; synth fields merge). */
export function mergeVoicePatch(a: VoicePatch | undefined, b: VoicePatch): VoicePatch {
  if (!a) return b;
  const synth = a.synth && b.synth ? { ...a.synth, ...b.synth } : (b.synth ?? a.synth);
  return synth ? { ...a, ...b, synth } : { ...a, ...b };
}

/** Clamp a window to a wavetable (start <= end on each axis); the same object if unchanged. */
export function clampSourceWindow<S extends WindowFields>(v: S, wt: Wavetable): S {
  let xLen = 1;
  let yLen = 1;
  if (wt.shape === '1d') xLen = wt.rows[0]?.length ?? 0;
  else if (wt.shape === '2d') {
    xLen = wt.rows[0]?.length ?? 0;
    yLen = wt.rows.length;
  } else yLen = wt.rows.length;
  const [s, e] = clampWindow(v.windowStart, v.windowEnd, xLen);
  const [sy, ey] = clampWindow(v.windowStartY, v.windowEndY, yLen);
  if (s === v.windowStart && e === v.windowEnd && sy === v.windowStartY && ey === v.windowEndY) return v;
  return { ...v, windowStart: s, windowEnd: e, windowStartY: sy, windowEndY: ey };
}

/**
 * Remap an inclusive window through an index map (old → new, -1 = removed): the start
 * moves to the first surviving slot at or after it, the end to the last surviving slot
 * at or before it (so windows keep pointing at the same tables; inserted slots inside
 * the window widen it).
 */
export function remapWindowByMap(s: number, e: number, map: readonly number[], oldLen: number, newLen: number): [number, number] {
  let s2 = -1;
  for (let i = Math.max(0, s); i < oldLen; i++) {
    if (map[i] >= 0) {
      s2 = map[i];
      break;
    }
  }
  if (s2 < 0) s2 = newLen - 1;
  let e2 = -1;
  for (let i = Math.min(e, oldLen - 1); i >= 0; i--) {
    if (map[i] >= 0) {
      e2 = map[i];
      break;
    }
  }
  if (e2 < s2) e2 = s2;
  const max = Math.max(0, newLen - 1);
  return [Math.max(0, Math.min(max, s2)), Math.max(0, Math.min(max, e2))];
}

/**
 * Window following after an edit of the voice's wavetable (an add, a batch, eviction):
 *  - removals / insertions remap the window so it keeps pointing at the same tables;
 *  - a window that ended at the end of a growing axis (1D slots, Rows rows) extends to
 *    the new end ("follows" new tables);
 *  - a fresh line (Last batch replaced) keeps the indices, clamped (then follows).
 * 2D grids are fixed: windows stay. Voices on other wavetables are returned unchanged.
 */
export function followEdit(voices: readonly VoiceParams[], before: Wavetable, edit: WavetableEdit): VoiceParams[] {
  if (edit.wt === before) return voices as VoiceParams[];
  const after = edit.wt;
  const oldLen = axisLength(before);
  const newLen = axisLength(after);
  const follow = <S extends WindowFields>(v: S): S => {
    if (v.wavetableId !== before.id) return v;
    if (before.shape === '2d') return clampSourceWindow(v, after);
    const y = before.shape === 'rows';
    let s = y ? v.windowStartY : v.windowStart;
    let e = y ? v.windowEndY : v.windowEnd;
    const following = oldLen === 0 || e >= oldLen - 1;
    if (edit.reset || !edit.map) [s, e] = clampWindow(s, e, newLen);
    else [s, e] = remapWindowByMap(s, e, edit.map, oldLen, newLen);
    if (following && newLen > 0) e = newLen - 1;
    const next = y ? { ...v, windowStartY: s, windowEndY: e } : { ...v, windowStart: s, windowEnd: e };
    const out = clampSourceWindow(next, after);
    return out.windowStart === v.windowStart && out.windowEnd === v.windowEnd && out.windowStartY === v.windowStartY && out.windowEndY === v.windowEndY
      ? v
      : out;
  };
  return voices.map((v) => {
    const a = follow(v);
    // Osc B (Synth voices; kept in step on Simple voices too) follows its own wavetable.
    const b = v.synth ? follow(v.synth.b) : undefined;
    if (!b || b === v.synth.b) return a;
    return { ...a, synth: { ...a.synth, b } };
  });
}

/** A voice whose osc A or B wavetable is missing moves that oscillator to `tl` (whole window). */
export function rehomeVoice(v: VoiceParams, has: (id: WavetableId) => boolean, tl: Wavetable): VoiceParams {
  let out = v;
  if (!has(v.wavetableId)) out = clampVoiceWindow({ ...out, wavetableId: tl.id, ...fullWindow(tl) }, tl);
  if (out.synth && !has(out.synth.b.wavetableId)) out = { ...out, synth: { ...out.synth, b: clampSourceWindow({ ...out.synth.b, wavetableId: tl.id, ...fullWindow(tl) }, tl) } };
  return out;
}
