/**
 * Session persistence: schema, encode / decode of the model state, version migration and
 * the single-file container (.mkwz). Portable: plain data and typed arrays, no DOM, no
 * storage (IndexedDB / file I/O live in src/browser and src/ui).
 *
 * A session is stored in two parts:
 *  - **meta** (`SessionMeta`): small, JSON-safe, rewritten on every save: timeline order
 *    (ids), id allocators, selection, wavetables (stored verbatim, so new wavetable fields
 *    round-trip without schema changes), voices, sequences, tempo and UI prefs;
 *  - **waveform records** (`WaveformRecord`), one per waveform id, written once (waveforms
 *    are immutable): the recipe plus either the samples (Float32), "re-render the recipe"
 *    (cheap, exact generators only, verified bit-exact when encoded) or a reference to
 *    another record with the same samples (copies share data).
 *
 * Decoding never trusts its input: unknown or missing fields fall back to defaults,
 * missing / bad waveforms are dropped (with warnings), and anything unusable throws a
 * `SessionError` so the caller can fall back to a fresh session.
 */
import { MAX_STEPS, TABLE_SIZE, TIMELINE_CAP } from './constants';
import { renderRecipe } from './generators';
import { DEFAULT_STEP_LENGTH, normalizeSteps, type SequenceData, stepLengthOf } from './sequence';
import { normalizePresets, type VoicePreset } from './presets';
import { isVoiceType, normalizeSynth } from './synth';

import type { ParamValue, Recipe, TableId, WaveTable } from './table';
import { DEFAULT_VOICE, clampOscB, clampVoiceWindow, oscASource, rehomeVoice, type VoiceParams } from './voice';
import {
  builtinWavetables,
  DEFAULT_WRITE,
  duplicateWavetable,
  FIRST_USER_WAVETABLE_ID,
  MAX_GRID,
  MAX_USER_SLOTS,
  pinnedIds,
  removeTables,
  TIMELINE_WAVETABLE_ID,
  type Slot,
  type Wavetable,
  type WriteSettings,
} from './wavetable';

/**
 * Current meta schema version. Bump it and add a migration when the shape changes.
 * 1: first schema. 2: `nextWavetableId` (user wavetables, monotonic ids). 3: per-sequence
 * `stepLength` (earlier sessions played eighth notes: they migrate to '1/8'). 4: voice
 * `type` ('simple' | 'synth') and `synth` params (earlier voices migrate to 'simple', which
 * sounds exactly as before; missing synth params take the Init patch).
 */
export const SESSION_VERSION = 4;
export const SESSION_FORMAT = 'mkwavez-session';
/** Voices a session may hold (matches AppModel.MAX_VOICES). */
const MAX_VOICES = 8;

/** Everything the model persists (no undo history, no transport play state). */
export interface ModelState {
  readonly timeline: readonly WaveTable[];
  readonly nextTableId: number;
  readonly wavetables: readonly Wavetable[];
  /** Next user wavetable id (monotonic: ids of deleted wavetables are never reused). */
  readonly nextWavetableId: number;
  readonly voices: readonly VoiceParams[];
  readonly nextVoiceId: number;
  readonly sequences: readonly SequenceData[];
  readonly nextSeqId: number;
  readonly selectedId: TableId | null;
  readonly breedParents: readonly TableId[];
  readonly bpm: number;
  /** User voice presets (missing in older sessions: none). */
  readonly voicePresets?: readonly VoicePreset[];
}

/** UI prefs saved with the session (selected voice tab, open tabs, ...). JSON values only. */
export type UiPrefs = Readonly<Record<string, unknown>>;

export interface SessionState {
  readonly model: ModelState;
  readonly ui: UiPrefs;
}

/** The small, JSON-safe part of a saved session. */
export interface SessionMeta {
  readonly format: typeof SESSION_FORMAT;
  readonly version: number;
  /** ms since the epoch (informational). */
  readonly savedAt: number;
  readonly timeline: readonly TableId[];
  readonly nextTableId: number;
  readonly selectedId: TableId | null;
  readonly breedParents: readonly TableId[];
  /** Verbatim (plain data); unknown fields are kept. */
  readonly wavetables: readonly Wavetable[];
  readonly nextWavetableId: number;
  readonly voices: readonly VoiceParams[];
  readonly nextVoiceId: number;
  readonly sequences: readonly SequenceData[];
  readonly nextSeqId: number;
  readonly bpm: number;
  readonly ui: UiPrefs;
  /** User voice presets (optional: added without a schema bump; missing = none). */
  readonly voicePresets?: readonly VoicePreset[];
}

export type WaveformEncoding = 'samples' | 'recipe' | 'ref';

/** One waveform as stored. Immutable: written once per id. */
export interface WaveformRecord {
  readonly id: TableId;
  readonly recipe: Recipe;
  readonly enc: WaveformEncoding;
  /** 'samples': TABLE_SIZE floats. */
  readonly samples?: Float32Array;
  /** 'ref': id of the record holding the same samples (never itself a ref). */
  readonly ref?: TableId;
  /** 'recipe': hash of the samples when encoded (checked after re-rendering). */
  readonly hash?: number;
}

export class SessionError extends Error {
  constructor(
    message: string,
    /** 'incompatible' = a newer / unknown version; 'corrupt' = unreadable data. */
    readonly kind: 'corrupt' | 'incompatible' = 'corrupt',
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

// ---- encode ----

export function encodeMeta(s: SessionState, savedAt = 0): SessionMeta {
  const m = s.model;
  return {
    format: SESSION_FORMAT,
    version: SESSION_VERSION,
    savedAt,
    timeline: m.timeline.map((t) => t.id),
    nextTableId: m.nextTableId,
    selectedId: m.selectedId,
    breedParents: m.breedParents.slice(),
    wavetables: m.wavetables,
    nextWavetableId: m.nextWavetableId,
    voices: m.voices,
    sequences: m.sequences,
    nextVoiceId: m.nextVoiceId,
    nextSeqId: m.nextSeqId,
    bpm: m.bpm,
    ui: s.ui,
    voicePresets: m.voicePresets ?? [],
  };
}

/**
 * Generators whose output is cheap to re-render and needs nothing but the recipe. A
 * waveform is stored as its recipe only if re-rendering reproduces it bit for bit when it
 * is encoded (so edited / derived data is never lost); the hash catches a later code
 * change at load (the re-rendered data is used, with a warning).
 */
const RECIPE_OPS = new Set(['basic', 'pulse']);

export function recipeOnly(r: Recipe): boolean {
  return RECIPE_OPS.has(r.op) && r.parents.length === 0;
}

/** Small memo for re-rendered recipes (many waveforms share one: copies, default waves). */
export class RenderCache {
  private map = new Map<string, Float32Array>();
  constructor(private readonly size = 64) {}

  render(r: Recipe): Float32Array {
    const { copyOf: _copyOf, ...params } = r.params;
    const key = JSON.stringify([r.op, params, r.seed, r.batch ?? null, r.shape ?? null]);
    let d = this.map.get(key);
    if (!d) {
      d = renderRecipe(r);
      if (this.map.size >= this.size) this.map.delete(this.map.keys().next().value!);
      this.map.set(key, d);
    }
    return d;
  }
}

/** FNV-1a over the float bits. */
export function samplesHash(d: Float32Array): number {
  const u = new Uint32Array(d.buffer, d.byteOffset, d.length);
  let h = 0x811c9dc5;
  for (let i = 0; i < u.length; i++) {
    h ^= u[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function sameBits(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  const ua = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const ub = new Uint32Array(b.buffer, b.byteOffset, b.length);
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  return true;
}

/**
 * Encode one waveform: a reference when `ref` names a record with the same samples, the
 * recipe alone when `allowRecipe` and it re-renders bit-exactly, else its samples (the
 * waveform's own array: never mutated, copied by the storage layer).
 */
export function encodeWaveform(
  t: WaveTable,
  o: { ref?: TableId | null; allowRecipe?: boolean; cache?: RenderCache } = {},
): WaveformRecord {
  if (o.ref !== undefined && o.ref !== null && o.ref !== t.id) return { id: t.id, recipe: t.recipe, enc: 'ref', ref: o.ref };
  if (o.allowRecipe && recipeOnly(t.recipe)) {
    try {
      const d = (o.cache ?? new RenderCache(1)).render(t.recipe);
      if (sameBits(d, t.data)) return { id: t.id, recipe: t.recipe, enc: 'recipe', hash: samplesHash(t.data) };
    } catch {
      // Not re-renderable: store samples.
    }
  }
  return { id: t.id, recipe: t.recipe, enc: 'samples', samples: t.data };
}

/** Encode a list of waveforms, sharing data by reference where arrays are shared (copies). */
export function encodeWaveforms(tables: readonly WaveTable[], o: { allowRecipe?: boolean; cache?: RenderCache } = {}): WaveformRecord[] {
  const owners = new Map<Float32Array, TableId>();
  const cache = o.cache ?? new RenderCache();
  return tables.map((t) => {
    const ref = owners.get(t.data) ?? null;
    if (ref === null) owners.set(t.data, t.id);
    return encodeWaveform(t, { ref, allowRecipe: o.allowRecipe, cache });
  });
}

// ---- migration ----

/** Upgrades raw meta from version `key` to `key + 1`. */
export type Migration = (meta: Record<string, unknown>) => Record<string, unknown>;

/**
 * Registered migrations, keyed by the version they upgrade from (`v: (m) => ({ ...m,
 * version: v + 1, ... })`).
 */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {
  // 1 → 2: the user wavetable id counter. Version 1 had no user wavetables to delete, so
  // the next id after the highest one is exact.
  1: (m) => ({
    ...m,
    version: 2,
    nextWavetableId: Math.max(
      FIRST_USER_WAVETABLE_ID,
      ...(Array.isArray(m.wavetables) ? m.wavetables : []).map((w: unknown) => (isObj(w) && isInt(w.id) ? w.id + 1 : 0)),
    ),
  }),
  // 2 → 3: per-sequence step length. Every earlier sequence stepped in eighth notes.
  2: (m) => ({
    ...m,
    version: 3,
    sequences: Array.isArray(m.sequences) ? m.sequences.map((s: unknown) => (isObj(s) ? { ...s, stepLength: DEFAULT_STEP_LENGTH } : s)) : m.sequences,
  }),
  // 3 → 4: voice types. Every earlier voice is a Simple voice (its synth block is filled
  // with the Init patch when decoded; osc B starts on osc A's wavetable and window).
  3: (m) => ({
    ...m,
    version: 4,
    voices: Array.isArray(m.voices) ? m.voices.map((v: unknown) => (isObj(v) ? { ...v, type: 'simple' } : v)) : m.voices,
  }),
};

export function migrateMeta(
  raw: unknown,
  migrations: Readonly<Record<number, Migration>> = MIGRATIONS,
  target = SESSION_VERSION,
): Record<string, unknown> {
  if (!isObj(raw)) throw new SessionError('session data is not an object');
  if (raw.format !== SESSION_FORMAT) throw new SessionError('not an mkwavez session');
  let m = raw;
  if (!isInt(m.version) || m.version < 0) throw new SessionError('session has no valid version');
  let v: number = m.version;
  if (v > target) throw new SessionError(`session version ${v} is newer than this app (${target})`, 'incompatible');
  while (v < target) {
    const step = migrations[v];
    if (!step) throw new SessionError(`no migration from session version ${v}`, 'incompatible');
    let next: unknown;
    try {
      next = step(m);
    } catch (e) {
      throw new SessionError(`migration from version ${v} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!isObj(next) || !isInt(next.version) || next.version <= v) throw new SessionError(`migration from version ${v} failed`);
    m = next;
    v = next.version;
  }
  return m;
}

// ---- decode ----

export interface DecodeOptions {
  migrations?: Readonly<Record<number, Migration>>;
  /** Target schema version (tests). */
  version?: number;
  /** Timeline cap (default TIMELINE_CAP); the oldest unpinned waveforms beyond it are dropped. */
  cap?: number;
  cache?: RenderCache;
}

export interface DecodeResult {
  readonly state: SessionState;
  /** Non-fatal problems (dropped waveforms, re-render mismatches, ...). */
  readonly warnings: string[];
}

type Records = ReadonlyMap<TableId, WaveformRecord> | ((id: TableId) => WaveformRecord | undefined);

/**
 * Decode a saved session. `records` gives the waveform records by id. Throws SessionError
 * when the session can't be used at all (wrong format, newer version, no waveform left).
 */
export function decodeSession(raw: unknown, records: Records, o: DecodeOptions = {}): DecodeResult {
  const m = migrateMeta(raw, o.migrations, o.version);
  const warnings: string[] = [];
  const getRec = typeof records === 'function' ? records : (id: TableId) => records.get(id);
  const cache = o.cache ?? new RenderCache();

  // Waveforms.
  if (!Array.isArray(m.timeline)) throw new SessionError('session has no timeline');
  const data = new Map<TableId, Float32Array | null>();
  const resolve = (id: TableId, depth: number): Float32Array | null => {
    if (data.has(id)) return data.get(id)!;
    let d: Float32Array | null = null;
    try {
      d = decodeSamples(getRec(id), id, depth, resolve, cache, warnings);
    } catch (e) {
      warnings.push(`waveform ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    data.set(id, d);
    return d;
  };
  const timeline: WaveTable[] = [];
  const seen = new Set<TableId>();
  let dropped = 0;
  for (const id of m.timeline) {
    if (!isInt(id) || seen.has(id)) continue;
    seen.add(id);
    const rec = getRec(id);
    const d = resolve(id, 0);
    if (!d || !rec || !isRecipe(rec.recipe)) {
      dropped++;
      continue;
    }
    timeline.push(Object.freeze({ id, data: d, recipe: rec.recipe }));
  }
  if (dropped) warnings.unshift(`${dropped} waveform${dropped === 1 ? '' : 's'} couldn't be restored`);
  if (!timeline.length) throw new SessionError('no waveform could be restored');
  const live = new Set(timeline.map((t) => t.id));
  const maxId = Math.max(...live);

  // Wavetables (built-ins first, in their usual order; then the rest as saved).
  const fresh = builtinWavetables();
  const decoded = new Map<number, Wavetable>();
  if (Array.isArray(m.wavetables)) {
    for (const w of m.wavetables) {
      const wt = decodeWavetable(w, live, fresh);
      if (wt && !decoded.has(wt.id)) decoded.set(wt.id, wt);
    }
  }
  const wavetables: Wavetable[] = [];
  for (const b of fresh) {
    const wt = decoded.get(b.id);
    decoded.delete(b.id);
    if (wt && wt.builtin === b.builtin) wavetables.push(wt);
    else if (b.id === TIMELINE_WAVETABLE_ID) wavetables.push({ ...b, rows: [timeline.map((t) => t.id)], head: { x: timeline.length, y: 0 } });
    else wavetables.push(b);
  }
  wavetables.push(...decoded.values());

  // Over the cap (e.g. an imported file): drop the oldest unpinned waveforms first.
  const cap = o.cap ?? TIMELINE_CAP;
  if (timeline.length > cap) {
    const pinned = pinnedIds(wavetables);
    let excess = timeline.length - cap;
    const gone = new Set<TableId>();
    for (const t of timeline) {
      if (excess <= 0) break;
      if (!pinned.has(t.id)) {
        gone.add(t.id);
        excess--;
      }
    }
    // The Timeline never exceeds its cap: if wavetables pin too much, their oldest go too.
    for (const t of timeline) {
      if (excess <= 0) break;
      if (!gone.has(t.id)) {
        gone.add(t.id);
        excess--;
      }
    }
    const kept = timeline.filter((t) => !gone.has(t.id));
    timeline.length = 0;
    for (const t of kept) timeline.push(t);
    for (const id of gone) live.delete(id);
    for (let i = 0; i < wavetables.length; i++) wavetables[i] = removeTables(wavetables[i], gone).wt;
    warnings.push(`${gone.size} oldest waveform${gone.size === 1 ? '' : 's'} dropped (over the ${cap} limit)`);
  }
  const wtById = new Map(wavetables.map((w) => [w.id, w]));

  // Voices.
  const voices: VoiceParams[] = [];
  if (Array.isArray(m.voices)) {
    for (const rv of m.voices) {
      if (voices.length >= MAX_VOICES) break;
      const v = decodeVoice(rv, wtById);
      if (v && !voices.some((x) => x.id === v.id)) voices.push(v);
    }
  }
  const voiceIds = new Set(voices.map((v) => v.id));

  // Sequences.
  const sequences: SequenceData[] = [];
  if (Array.isArray(m.sequences)) {
    for (const rs of m.sequences) {
      const s = decodeSequence(rs, voiceIds);
      if (s && !sequences.some((x) => x.id === s.id)) sequences.push(s);
    }
  }

  const maxOf = (xs: readonly { id: number }[]) => xs.reduce((a, x) => Math.max(a, x.id), 0);
  const selectedId = isInt(m.selectedId) && live.has(m.selectedId) ? m.selectedId : timeline[timeline.length - 1].id;
  const breedParents = Array.isArray(m.breedParents) ? [...new Set(m.breedParents.filter((id): id is number => isInt(id) && live.has(id)))].slice(0, 8) : [];
  const bpm = isNum(m.bpm) ? Math.max(40, Math.min(300, m.bpm)) : 132;
  return {
    state: {
      model: {
        timeline,
        nextTableId: Math.max(isInt(m.nextTableId) ? m.nextTableId : 0, maxId + 1),
        wavetables,
        nextWavetableId: Math.max(
          FIRST_USER_WAVETABLE_ID,
          isInt(m.nextWavetableId) ? m.nextWavetableId : 0,
          ...wavetables.map((w) => w.id + 1),
        ),
        voices,
        nextVoiceId: Math.max(isInt(m.nextVoiceId) ? m.nextVoiceId : 0, maxOf(voices) + 1),
        sequences,
        nextSeqId: Math.max(isInt(m.nextSeqId) ? m.nextSeqId : 0, maxOf(sequences) + 1),
        selectedId,
        breedParents,
        bpm,
        voicePresets: normalizePresets(m.voicePresets),
      },
      ui: isObj(m.ui) ? m.ui : {},
    },
    warnings,
  };
}

function decodeSamples(
  rec: WaveformRecord | undefined,
  id: TableId,
  depth: number,
  resolve: (id: TableId, depth: number) => Float32Array | null,
  cache: RenderCache,
  warnings: string[],
): Float32Array | null {
  if (!isObj(rec)) throw new Error('missing');
  if (rec.id !== id) throw new Error('id mismatch');
  if (!isRecipe(rec.recipe)) throw new Error('bad recipe');
  switch (rec.enc) {
    case 'samples': {
      const s = rec.samples;
      if (!(s instanceof Float32Array) || s.length !== TABLE_SIZE) throw new Error('bad sample data');
      for (let i = 0; i < s.length; i++) if (!Number.isFinite(s[i])) throw new Error('non-finite samples');
      return s;
    }
    case 'recipe': {
      const d = cache.render(rec.recipe);
      if (isInt(rec.hash) && samplesHash(d) !== rec.hash >>> 0) warnings.push(`waveform ${id} re-rendered differently (code changed since it was saved)`);
      return d;
    }
    case 'ref':
      if (depth > 0 || !isInt(rec.ref) || rec.ref === id) throw new Error('bad reference');
      return resolve(rec.ref, depth + 1);
    default:
      throw new Error(`unknown encoding ${String(rec.enc)}`);
  }
}

const SHAPES = new Set(['1d', '2d', 'rows']);
const WRITE_VALUES: Record<keyof WriteSettings, readonly string[]> = {
  dir: ['+x', '-x', '+y', '-y'],
  edge: ['wrap', 'stop', 'grow'],
  onWrap: ['next', 'same'],
  mode: ['replace', 'insert'],
  batch: ['continue', 'newRow'],
};

/**
 * One wavetable: the saved object with every known field validated (falling back to the
 * built-in's / defaults); unknown fields are kept as saved. Slots referencing waveforms
 * that weren't restored are removed the way eviction removes them.
 */
function decodeWavetable(raw: unknown, live: ReadonlySet<TableId>, fresh: readonly Wavetable[]): Wavetable | null {
  if (!isObj(raw) || !isInt(raw.id)) return null;
  const base = typeof raw.builtin === 'string' ? fresh.find((b) => b.builtin === raw.builtin && b.id === raw.id) : undefined;
  if (raw.builtin !== undefined && !base) return null;
  const shape = (SHAPES.has(raw.shape as string) ? raw.shape : base?.shape) as Wavetable['shape'] | undefined;
  if (!shape) return null;
  let rows: Slot[][] = Array.isArray(raw.rows)
    ? raw.rows.filter(Array.isArray).map((r: unknown[]) => r.map((s) => (isInt(s) ? s : null)))
    : (base?.rows.map((r) => r.slice()) ?? []);
  if (shape === '1d') rows = [rows[0] ?? []];
  if (shape === '2d') {
    const w = Math.max(1, ...rows.map((r) => r.length));
    if (!rows.length) rows = [[]];
    rows = rows.map((r) => [...r, ...new Array<Slot>(w - r.length).fill(null)]);
  }
  const defWrite = base?.write ?? DEFAULT_WRITE;
  const rw = isObj(raw.write) ? raw.write : {};
  const write = Object.fromEntries(
    (Object.keys(WRITE_VALUES) as (keyof WriteSettings)[]).map((k) => [k, WRITE_VALUES[k].includes(rw[k] as string) ? rw[k] : defWrite[k]]),
  ) as unknown as WriteSettings;
  const rh = isObj(raw.head) ? raw.head : {};
  const head = { x: isInt(rh.x) ? rh.x : 0, y: isInt(rh.y) ? rh.y : 0 };
  let wt: Wavetable = {
    ...(raw as object),
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : (base?.name ?? `Wavetable ${raw.id}`),
    shape,
    rows,
    fixed: shape === '2d' ? true : shape === 'rows' ? false : typeof raw.fixed === 'boolean' ? raw.fixed : (base?.fixed ?? false),
    interp: raw.interp === 'step' ? 'step' : 'blend',
    live: typeof raw.live === 'boolean' ? raw.live : (base?.live ?? false),
    write,
    head,
    pins: typeof raw.pins === 'boolean' ? raw.pins : (base?.pins ?? true),
    ...(base ? { builtin: base.builtin } : {}),
  };
  const missing = new Set<TableId>();
  for (const r of rows) for (const s of r) if (s !== null && !live.has(s)) missing.add(s);
  if (missing.size) wt = removeTables(wt, missing).wt;
  if (!base) wt = capUserWavetable(wt);
  return wt;
}

/** User wavetables stay within the editor's limits (MAX_USER_SLOTS; 2D sides ≤ MAX_GRID). */
function capUserWavetable(wt: Wavetable): Wavetable {
  if (wt.shape === '2d') {
    const w = wt.rows[0]?.length ?? 0;
    if (w <= MAX_GRID && wt.rows.length <= MAX_GRID) return wt;
    const rows = wt.rows.slice(0, MAX_GRID).map((r) => r.slice(0, MAX_GRID));
    const head = { x: Math.min(wt.head.x, MAX_GRID - 1), y: Math.min(wt.head.y, MAX_GRID - 1) };
    return { ...wt, rows, head };
  }
  let n = 0;
  for (const r of wt.rows) n += r.length;
  if (n <= MAX_USER_SLOTS) return wt;
  // Keep the newest slots / rows, as a duplicate does.
  const d = duplicateWavetable(wt, wt.id, wt.name);
  return { ...wt, rows: d.rows, head: d.head };
}

function decodeVoice(raw: unknown, wavetables: ReadonlyMap<number, Wavetable>): VoiceParams | null {
  if (!isObj(raw) || !isInt(raw.id) || raw.id < 1) return null;
  const out: Record<string, unknown> = { ...raw };
  for (const [k, def] of Object.entries(DEFAULT_VOICE)) {
    const v = raw[k];
    out[k] = typeof v === typeof def && (typeof v !== 'number' || Number.isFinite(v)) ? v : def;
  }
  out.name = typeof raw.name === 'string' ? raw.name : `V${raw.id}`;
  out.type = isVoiceType(raw.type) ? raw.type : 'simple';
  let v = out as unknown as VoiceParams;
  const round = { windowStart: Math.round(v.windowStart), windowEnd: Math.round(v.windowEnd), windowStartY: Math.round(v.windowStartY), windowEndY: Math.round(v.windowEndY) };
  v = { ...v, ...round };
  // Osc B defaults to osc A's wavetable / window / position (a voice saved before Synth voices).
  v = { ...v, synth: normalizeSynth(raw.synth, oscASource(v)) };
  const tl = wavetables.get(TIMELINE_WAVETABLE_ID)!;
  v = rehomeVoice(v, (id) => wavetables.has(id), tl);
  v = clampVoiceWindow(v, wavetables.get(v.wavetableId)!);
  return clampOscB(v, wavetables.get(v.synth.b.wavetableId)!);
}


function decodeSequence(raw: unknown, voices: ReadonlySet<number>): SequenceData | null {
  if (!isObj(raw) || !isInt(raw.id)) return null;
  const steps = Array.isArray(raw.steps) ? normalizeSteps(raw.steps.map((s) => (isNum(s) ? s : -1))) : normalizeSteps([]);
  return {
    ...(raw as object),
    id: raw.id,
    voiceId: isInt(raw.voiceId) && voices.has(raw.voiceId) ? raw.voiceId : null,
    length: isNum(raw.length) ? Math.max(1, Math.min(MAX_STEPS, Math.round(raw.length))) : 16,
    steps,
    gate: isNum(raw.gate) ? Math.max(0.05, Math.min(1, raw.gate)) : 0.5,
    stepLength: stepLengthOf(raw),
  } as SequenceData;
}

// ---- file container (.mkwz) ----

/**
 * One file holding a whole session:
 *   'MKWZ' · u32 container version · u32 JSON byte length · JSON · zero padding to 4 bytes ·
 *   Float32 sample block (little-endian).
 * The JSON is `{ meta, waveforms }`; a waveform with samples has `offset` (in floats) into
 * the sample block instead of `samples`.
 */
export const FILE_MAGIC = 'MKWZ';
export const FILE_VERSION = 1;
export const FILE_EXTENSION = '.mkwz';
/** Limits on what an imported file may hold (a full session is ~33 MB). */
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_FILE_WAVEFORMS = 4 * TIMELINE_CAP;

export function packSessionFile(meta: SessionMeta, records: readonly WaveformRecord[]): Uint8Array {
  let floats = 0;
  const waveforms = records.map((r) => {
    const { samples, ...rest } = r;
    if (!samples) return rest;
    const offset = floats;
    floats += samples.length;
    return { ...rest, offset, length: samples.length };
  });
  const json = new TextEncoder().encode(JSON.stringify({ meta, waveforms }));
  const head = 12 + json.length;
  const start = (head + 3) & ~3;
  const out = new Uint8Array(start + floats * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = FILE_MAGIC.charCodeAt(i);
  dv.setUint32(4, FILE_VERSION, true);
  dv.setUint32(8, json.length, true);
  out.set(json, 12);
  let p = start;
  for (const r of records) {
    if (!r.samples) continue;
    for (let i = 0; i < r.samples.length; i++, p += 4) dv.setFloat32(p, r.samples[i], true);
  }
  return out;
}

export function unpackSessionFile(bytes: Uint8Array): { meta: unknown; records: Map<TableId, WaveformRecord> } {
  if (bytes.length < 12) throw new SessionError('file is too short');
  if (bytes.length > MAX_FILE_BYTES) throw new SessionError('file is too large');
  for (let i = 0; i < 4; i++) if (bytes[i] !== FILE_MAGIC.charCodeAt(i)) throw new SessionError('not an mkwavez session file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint32(4, true);
  if (version > FILE_VERSION) throw new SessionError(`session file version ${version} is newer than this app`, 'incompatible');
  const len = dv.getUint32(8, true);
  if (12 + len > bytes.length) throw new SessionError('file is truncated');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + len)));
  } catch {
    throw new SessionError('file header is not valid JSON');
  }
  if (!isObj(parsed) || !Array.isArray(parsed.waveforms)) throw new SessionError('file has no waveforms');
  if (parsed.waveforms.length > MAX_FILE_WAVEFORMS) throw new SessionError('file holds too many waveforms');
  const start = (12 + len + 3) & ~3;
  const totalFloats = Math.max(0, Math.floor((bytes.length - start) / 4));
  const records = new Map<TableId, WaveformRecord>();
  for (const w of parsed.waveforms) {
    if (!isObj(w) || !isInt(w.id)) continue;
    const { offset, length, ...rest } = w;
    let rec = rest as unknown as WaveformRecord;
    if (isInt(offset) && isInt(length)) {
      // Every waveform is exactly TABLE_SIZE samples; anything else is dropped unread.
      if (length !== TABLE_SIZE || offset < 0 || offset + length > totalFloats) continue;
      const s = new Float32Array(length);
      for (let i = 0; i < length; i++) s[i] = dv.getFloat32(start + (offset + i) * 4, true);
      rec = { ...rec, samples: s };
    }
    records.set(w.id, rec);
  }
  return { meta: parsed.meta, records };
}

// ---- helpers ----

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isInt(x: unknown): x is number {
  return Number.isInteger(x);
}

function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function isRecipe(r: unknown): r is Recipe {
  if (!isObj(r) || typeof r.op !== 'string' || !isObj(r.params) || !Array.isArray(r.parents)) return false;
  if (r.shape !== undefined && typeof r.shape !== 'string') return false;
  return Object.values(r.params).every((v: unknown): v is ParamValue => ['number', 'string', 'boolean'].includes(typeof v));
}
