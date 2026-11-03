/**
 * Synth voice presets: a voice's sound as plain data (its synth block, amp envelope,
 * octave, level and osc A's wavetable / window / position), the factory set (which play the
 * built-in wavetables, so they work in any session) and the export file format. Portable.
 */
import { EMPTY_SLOT, MOD_SLOTS, type ModSlot } from './modulation';
import { DEFAULT_SOURCE, DEFAULT_SYNTH, normalizeSynth, type OscSource, type SynthParams } from './synth';
import type { VoiceParams } from './voice';
import { GRID_WAVETABLE_ID, LAST_BATCH_WAVETABLE_ID, TIMELINE_WAVETABLE_ID, type BuiltinKind, type Wavetable, type WavetableShape } from './wavetable';

/**
 * Which wavetable a preset's oscillator plays, robust across sessions: a built-in by its
 * kind, a user wavetable by name + shape (ids are per session). See resolvePresetWavetable.
 */
export interface WavetableRef {
  readonly builtin?: BuiltinKind;
  readonly name?: string;
  readonly shape?: WavetableShape;
}

/** What a preset sets on a voice (it always becomes a Synth voice). */
export interface PresetSound {
  readonly synth: SynthParams;
  readonly a: OscSource;
  /** Osc A / B wavetable references (the ids in `a` / `synth.b` are only a hint). */
  readonly aRef?: WavetableRef;
  readonly bRef?: WavetableRef;
  readonly attack: number;
  readonly decay: number;
  readonly sustain: number;
  readonly release: number;
  readonly octave: number;
  readonly level: number;
}

export interface VoicePreset {
  readonly id: string;
  readonly name: string;
  readonly sound: PresetSound;
}

/** Most user presets a session keeps. */
export const MAX_USER_PRESETS = 128;
export const PRESET_FILE_FORMAT = 'mkwavez-presets';

/** A window wider than any wavetable: clamped to "all of it" when applied. */
const ALL = { windowStart: 0, windowEnd: 1e6, windowStartY: 0, windowEndY: 1e6 };
const src = (wavetableId: number, position = 0.5, positionY = 0.5): OscSource => ({ ...DEFAULT_SOURCE, ...ALL, wavetableId, position, positionY });
const BUILTIN_KIND: Readonly<Record<number, BuiltinKind>> = { [TIMELINE_WAVETABLE_ID]: 'timeline', [LAST_BATCH_WAVETABLE_ID]: 'lastBatch', [GRID_WAVETABLE_ID]: 'grid' };
const mods = (...slots: ModSlot[]): ModSlot[] => [...slots, ...Array.from({ length: MOD_SLOTS - slots.length }, () => EMPTY_SLOT)];
const lfos = (...l: Partial<SynthParams['lfos'][number]>[]) => DEFAULT_SYNTH.lfos.map((d, i) => ({ ...d, ...(l[i] ?? {}) }));

function factory(id: string, name: string, synth: Partial<SynthParams>, rest: Partial<Omit<PresetSound, 'synth'>> = {}): VoicePreset {
  const s = normalizeSynth({ ...DEFAULT_SYNTH, b: src(LAST_BATCH_WAVETABLE_ID, 0.75), ...synth });
  const a = rest.a ?? src(LAST_BATCH_WAVETABLE_ID);
  return {
    id,
    name,
    sound: {
      synth: s,
      a,
      attack: 0.004,
      decay: 0.4,
      sustain: 0.7,
      release: 0.25,
      octave: 0,
      level: 0.8,
      ...rest,
      // Factory presets play built-ins: referenced by kind, never by id.
      aRef: { builtin: BUILTIN_KIND[a.wavetableId] },
      bRef: { builtin: BUILTIN_KIND[s.b.wavetableId] },
    },
  };
}

/** A reference to a wavetable (built-in by kind; yours by name + shape). */
export function wavetableRef(wt: Wavetable | undefined): WavetableRef | undefined {
  if (!wt) return undefined;
  return wt.builtin ? { builtin: wt.builtin } : { name: wt.name, shape: wt.shape };
}

/**
 * The wavetable a preset oscillator means in this session: a built-in by kind; a user
 * wavetable with the saved id if its name and shape still match, else the first one with
 * that name and shape; with no reference (older data), the id if it exists. Undefined if
 * none fits (the caller falls back to a built-in and says so).
 */
export function resolvePresetWavetable(wavetables: readonly Wavetable[], id: number, ref: WavetableRef | undefined): Wavetable | undefined {
  if (ref?.builtin) return wavetables.find((w) => w.builtin === ref.builtin);
  const byId = wavetables.find((w) => w.id === id);
  if (!ref?.name) return byId;
  if (byId && !byId.builtin && byId.name === ref.name && byId.shape === ref.shape) return byId;
  return wavetables.find((w) => !w.builtin && w.name === ref.name && w.shape === ref.shape);
}

/** Init plus six starting points; all on the built-in wavetables (Timeline, Last batch, Grid). */
export const FACTORY_PRESETS: readonly VoicePreset[] = [
  factory('init', 'Init', {}),
  factory(
    'bass',
    'Sub bass',
    { aOct: -1, aLevel: 0.75, subLevel: 0.7, subOct: 1, filterMode: 'lp24', cutoff: 320, resonance: 0.2, envAmount: 0.35, fDecay: 0.25, fSustain: 0.1, keyTrack: 0.3, glide: 0.05, glideLegato: true, sat: 0.2, mods: mods() },
    { a: src(LAST_BATCH_WAVETABLE_ID, 0.25), attack: 0.003, decay: 0.3, sustain: 0.85, release: 0.12 },
  ),
  factory(
    'pluck',
    'Pluck',
    { b: src(TIMELINE_WAVETABLE_ID, 0.8), bLevel: 0.45, bFine: 7, filterMode: 'lp12', cutoff: 380, resonance: 0.35, envAmount: 0.75, fAttack: 0.001, fDecay: 0.22, fSustain: 0, velAmount: 0.6, mods: mods() },
    { a: src(TIMELINE_WAVETABLE_ID, 0.4), attack: 0.002, decay: 0.45, sustain: 0, release: 0.3 },
  ),
  factory(
    'pad',
    'Evolving pad',
    {
      b: src(GRID_WAVETABLE_ID, 0.7, 0.6),
      bLevel: 0.7,
      aUnison: 3,
      bUnison: 3,
      aDetune: 16,
      bDetune: 20,
      aSpread: 0.8,
      bSpread: 0.9,
      filterMode: 'lp24',
      cutoff: 1800,
      resonance: 0.1,
      envAmount: 0.15,
      fAttack: 1.2,
      fDecay: 2,
      fSustain: 0.6,
      width: 1.4,
      lfos: lfos({ rate: 0.07 }, { rate: 0.11, fade: 0 }, { shape: 'smooth', sync: false, rate: 0.2 }),
      mods: mods({ src: 'lfo1', dst: 'posA', amt: 0.4 }, { src: 'lfo2', dst: 'posYB', amt: 0.35 }, { src: 'lfo3', dst: 'cutoff', amt: 0.08 }),
    },
    { a: src(GRID_WAVETABLE_ID, 0.3, 0.3), attack: 0.8, decay: 1.5, sustain: 0.8, release: 1.8 },
  ),
  factory(
    'lead',
    'Sync lead',
    {
      aCoarse: 12,
      bLevel: 0,
      sync: true,
      filterMode: 'lp12',
      cutoff: 4200,
      resonance: 0.25,
      envAmount: 0.2,
      glide: 0.08,
      glideLegato: true,
      sat: 0.3,
      lfos: lfos({ rate: 0.3 }, { rate: 5.5, fade: 0.5 }),
      mods: mods({ src: 'menv', dst: 'pitchA', amt: 0.6 }, { src: 'lfo2', dst: 'pitchA', amt: 0.015 }, { src: 'lfo2', dst: 'pitchB', amt: 0.015 }, { src: 'wheel', dst: 'pitchA', amt: 0.5 }),
      mMode: 'ad',
      mAttack: 0,
      mDecay: 0.35,
    },
    { attack: 0.004, decay: 0.3, sustain: 0.85, release: 0.2 },
  ),
  factory(
    'brass',
    'Brass',
    {
      b: src(TIMELINE_WAVETABLE_ID, 0.6),
      bLevel: 0.7,
      bFine: -8,
      filterMode: 'lp24',
      cutoff: 600,
      resonance: 0.15,
      envAmount: 0.55,
      fAttack: 0.06,
      fDecay: 0.5,
      fSustain: 0.45,
      velAmount: 0.5,
      pAmount: 1.5,
      pAttack: 0,
      pDecay: 0.06,
      sat: 0.25,
      mods: mods({ src: 'at', dst: 'cutoff', amt: 0.3 }),
    },
    { a: src(TIMELINE_WAVETABLE_ID, 0.6), attack: 0.05, decay: 0.3, sustain: 0.85, release: 0.25 },
  ),
  factory(
    'sweep',
    'Noise sweep',
    {
      aLevel: 0.12,
      noiseLevel: 0.9,
      noiseType: 'white',
      filterMode: 'bp',
      cutoff: 500,
      resonance: 0.7,
      envAmount: 0,
      keyTrack: 0,
      velAmount: 0,
      lfos: lfos({ shape: 'tri', sync: true, div: '2/1', retrig: true, phase: 0.75 }),
      mods: mods({ src: 'lfo1', dst: 'cutoff', amt: 0.55 }, { src: 'lfo1', dst: 'pan', amt: 0.5 }),
    },
    { attack: 0.3, decay: 0.5, sustain: 1, release: 1.2 },
  ),
];

/** A voice's sound as a preset (`wavetable` looks up the wavetables it plays, for their references). */
export function soundOf(v: VoiceParams, wavetable: (id: number) => Wavetable | undefined = () => undefined): PresetSound {
  return {
    aRef: wavetableRef(wavetable(v.wavetableId)),
    bRef: wavetableRef(wavetable(v.synth.b.wavetableId)),
    synth: v.synth,
    a: { wavetableId: v.wavetableId, windowStart: v.windowStart, windowEnd: v.windowEnd, windowStartY: v.windowStartY, windowEndY: v.windowEndY, position: v.position, positionY: v.positionY },
    attack: v.attack,
    decay: v.decay,
    sustain: v.sustain,
    release: v.release,
    octave: v.octave,
    level: v.level,
  };
}

/** The voice patch a preset makes (windows are clamped to the wavetables by the model). */
export function presetPatch(p: PresetSound): Partial<VoiceParams> {
  return { type: 'synth', synth: p.synth, ...p.a, attack: p.attack, decay: p.decay, sustain: p.sustain, release: p.release, octave: p.octave, level: p.level };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const num = (x: unknown, def: number, lo: number, hi: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : def);
const int = (x: unknown, def: number) => (Number.isInteger(x) ? (x as number) : def);

/** A preset sound from untrusted data. */
export function normalizeSound(raw: unknown): PresetSound {
  const o = isObj(raw) ? raw : {};
  const a = isObj(o.a) ? o.a : {};
  const src: OscSource = {
    wavetableId: int(a.wavetableId, LAST_BATCH_WAVETABLE_ID),
    windowStart: int(a.windowStart, 0),
    windowEnd: int(a.windowEnd, ALL.windowEnd),
    windowStartY: int(a.windowStartY, 0),
    windowEndY: int(a.windowEndY, ALL.windowEndY),
    position: num(a.position, 0.5, 0, 1),
    positionY: num(a.positionY, 0.5, 0, 1),
  };
  return {
    synth: normalizeSynth(o.synth, src),
    a: src,
    ...(normalizeRef(o.aRef) ? { aRef: normalizeRef(o.aRef) } : {}),
    ...(normalizeRef(o.bRef) ? { bRef: normalizeRef(o.bRef) } : {}),
    attack: num(o.attack, 0.004, 0.001, 10),
    decay: num(o.decay, 0.4, 0.001, 10),
    sustain: num(o.sustain, 0.7, 0, 1),
    release: num(o.release, 0.25, 0.001, 10),
    octave: Math.round(num(o.octave, 0, -2, 2)),
    level: num(o.level, 0.8, 0, 1),
  };
}

const BUILTIN_KINDS: readonly string[] = ['timeline', 'lastBatch', 'batches', 'grid'];
const SHAPES: readonly string[] = ['1d', '2d', 'rows'];

function normalizeRef(raw: unknown): WavetableRef | undefined {
  if (!isObj(raw)) return undefined;
  if (typeof raw.builtin === 'string' && BUILTIN_KINDS.includes(raw.builtin)) return { builtin: raw.builtin as BuiltinKind };
  if (typeof raw.name === 'string' && typeof raw.shape === 'string' && SHAPES.includes(raw.shape)) return { name: raw.name.slice(0, 40), shape: raw.shape as WavetableShape };
  return undefined;
}

/** User presets from untrusted data
 (sessions, imported files): valid entries only, capped. */
export function normalizePresets(raw: unknown): VoicePreset[] {
  if (!Array.isArray(raw)) return [];
  const out: VoicePreset[] = [];
  const ids = new Set<string>();
  for (const p of raw) {
    if (out.length >= MAX_USER_PRESETS) break;
    if (!isObj(p) || typeof p.id !== 'string' || !p.id || ids.has(p.id) || typeof p.name !== 'string') continue;
    ids.add(p.id);
    out.push({ id: p.id, name: p.name.slice(0, 40) || 'Preset', sound: normalizeSound(p.sound) });
  }
  return out;
}

/** The presets export file (JSON). */
export function presetsFile(presets: readonly VoicePreset[]): string {
  return JSON.stringify({ format: PRESET_FILE_FORMAT, version: 1, presets }, null, 1);
}

/** Presets from an export file; throws if it isn't one. */
export function parsePresetsFile(text: string): VoicePreset[] {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    throw new Error('not a presets file (invalid JSON)');
  }
  if (!isObj(o) || o.format !== PRESET_FILE_FORMAT) throw new Error('not an mkwavez presets file');
  return normalizePresets(o.presets);
}
