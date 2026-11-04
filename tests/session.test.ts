import { describe, expect, it } from 'vitest';
import { Autosaver, type SaveScheduler } from '../src/app/autosave';
import { becomeOwner, restoreSession, type RestoreStore } from '../src/app/restore';
import { defaultSessionState } from '../src/app/defaultSession';
import { AppModel } from '../src/app/model';
import { compileFormula } from '../src/browser/formulaEval';
import { breedBatch } from '../src/core/breed';
import { generateBasic, generateCa, generateFormula, generatePerlin, DEFAULT_PERLIN, seedBatch, seedEntry } from '../src/core/generators';
import { mutateBatch } from '../src/core/mutateBatch';
import {
  decodeSession,
  encodeMeta,
  encodeWaveform,
  encodeWaveforms,
  migrateMeta,
  MIGRATIONS,
  packSessionFile,
  samplesHash,
  SESSION_FORMAT,
  SESSION_VERSION,
  SessionError,
  unpackSessionFile,
  type ModelState,
  type SessionMeta,
  type SessionState,
  type WaveformRecord,
} from '../src/core/session';
import { TIMELINE_CAP } from '../src/core/constants';
import type { TableId } from '../src/core/table';
import {
  BATCHES_WAVETABLE_ID,
  FIRST_USER_WAVETABLE_ID,
  isFull,
  MAX_GRID,
  MAX_USER_SLOTS,
  slotCount,
  GRID_WAVETABLE_ID,
  LAST_BATCH_WAVETABLE_ID,
  make1D,
  make2D,
  makeRows,
  TIMELINE_WAVETABLE_ID,
  type Wavetable,
} from '../src/core/wavetable';

/** A model exercising every waveform kind, wavetable shape, voice kind and sequences. */
function richModel(): AppModel {
  const m = new AppModel(64);
  m.addTables((['sine', 'saw', 'p25'] as const).map((w) => generateBasic(w, 0)), false);
  m.addTables([generateBasic('noise', 7)]);
  m.addTables(seedBatch({ entry: seedEntry('pulse')!, expr: '', params: { width: 0.2, widthEnd: 0.6 }, seed: 1, count: 3 }));
  m.addTables(generatePerlin(DEFAULT_PERLIN, 11, 3));
  m.addTables(generateCa({ rule: 30, cells: 64 }, 5, 2));
  const expr = 'sin(p) + 0.3*sin(3*p + n)';
  m.addTables(generateFormula(compileFormula(expr), expr, 'test', 3, 2));
  const src = m.timeline[1];
  m.addTables(mutateBatch({ mutation: 'fold', amount: 0.6, seed: 3, mode: 'chain', count: 2 }, src));
  m.addTables(breedBatch({ op: 'genetic', bias: 0.4, walk: 'path', rate: 0.1, seed: 77, mode: 'single', count: 1 }, [m.timeline[0], m.timeline[1], m.timeline[2]]));
  m.copyToEnd(m.timeline[1].id);
  m.copyToEnd(m.timeline.at(-1)!.id); // copy of a copy
  m.copyToEnd(m.timeline[12].id); // copy of a formula waveform

  const ids = m.timeline.map((t) => t.id);
  const state = m.exportState();
  const user: Wavetable[] = [
    { ...make1D(16, 'Fixed line', [ids[0], null, ids[2], ids[3]], { fixed: true, live: true, interp: 'step', write: { dir: '-x', mode: 'replace', edge: 'wrap' } }), color: 'teal' } as Wavetable,
    make1D(17, 'Free line', [ids[4], ids[5]], { live: false }),
    make2D(18, 'Pad', 3, 2, [ids[0], ids[1], null, ids[6], ids[7], ids[8]], { live: true, write: { dir: '+y', step: { x: 1, y: 2 }, edge: 'stop', onWrap: 'next', mode: 'replace' }, head: { x: 1, y: 1 } }),
    makeRows(19, 'Rows', [[ids[0], ids[1]], [ids[2]], []], { live: true, write: { dir: '-x', edge: 'grow', mode: 'insert', batch: 'newRow' } }),
  ];
  m.loadState({ ...state, wavetables: [...state.wavetables, ...user] });

  m.addVoice({ wavetableId: GRID_WAVETABLE_ID, windowStart: 1, windowEnd: 5, windowStartY: 2, windowEndY: 3, positionY: 0.2, lfoDepthY: 0.7, lfoRateY: 1.3 });
  m.addVoice({ wavetableId: 19, windowStartY: 0, windowEndY: 1, position: 0.9 });
  m.addVoice({ wavetableId: 16, windowStart: 1, windowEnd: 3, mute: true, octave: -2, attack: 0.1 });
  m.addVoice({ wavetableId: 18, windowStart: 0, windowEnd: 2, windowStartY: 1, windowEndY: 1 });
  m.addVoice({ wavetableId: LAST_BATCH_WAVETABLE_ID });
  m.addSequence(1, [0, 3, -1, 5], 12);
  m.addSequence(2, [7, -1, 2], 64);
  m.updateSequence(2, { gate: 0.8, stepLength: '1/16T' });
  m.removeVoice(5); // ids keep counting
  m.select(ids[6]);
  m.setBreedParents([ids[2], ids[0], ids[5]]);
  m.setTransport({ bpm: 97 });
  return m;
}

const UI = { voiceId: 2, generateTab: 'Mutate', extra: { nested: [1, 2] } };

function roundTrip(s: SessionState, records: WaveformRecord[]): SessionState {
  const meta = JSON.parse(JSON.stringify(encodeMeta(s, 123))) as SessionMeta;
  return decodeSession(meta, new Map(records.map((r) => [r.id, r]))).state;
}

/** Compare everything but the data arrays' identity. */
function expectSameState(a: ModelState, b: ModelState): void {
  expect(b.timeline.map((t) => t.id)).toEqual(a.timeline.map((t) => t.id));
  expect(b.timeline.map((t) => t.recipe)).toEqual(a.timeline.map((t) => t.recipe));
  a.timeline.forEach((t, i) => expect(samplesHash(b.timeline[i].data)).toBe(samplesHash(t.data)));
  const { timeline: _a, ...ra } = a;
  const { timeline: _b, ...rb } = b;
  expect(rb).toEqual(ra);
}

describe('session encode / decode', () => {
  it('round-trips the whole model (samples + refs)', () => {
    const m = richModel();
    const s: SessionState = { model: m.exportState(), ui: UI };
    const out = roundTrip(s, encodeWaveforms(s.model.timeline));
    expectSameState(s.model, out.model);
    expect(out.ui).toEqual(UI);
    // Unknown wavetable fields survive.
    expect((out.model.wavetables.find((w) => w.id === 16) as unknown as { color: string }).color).toBe('teal');
    // Allocators continue where they were.
    expect(out.model.nextVoiceId).toBe(6);
    expect(out.model.nextTableId).toBe(m.exportState().nextTableId);
  });

  it('a restored model behaves like the original (adds, write heads, windows)', () => {
    const m = richModel();
    const s: SessionState = { model: m.exportState(), ui: {} };
    const r = new AppModel(64);
    r.loadState(roundTrip(s, encodeWaveforms(s.model.timeline)).model);
    const g = generatePerlin(DEFAULT_PERLIN, 99, 4);
    m.addTables(g);
    r.addTables(g);
    expectSameState(m.exportState(), r.exportState());
  });

  it('every wavetable shape and write head survives', () => {
    const s: SessionState = { model: richModel().exportState(), ui: {} };
    const out = roundTrip(s, encodeWaveforms(s.model.timeline)).model;
    for (const id of [TIMELINE_WAVETABLE_ID, LAST_BATCH_WAVETABLE_ID, BATCHES_WAVETABLE_ID, GRID_WAVETABLE_ID, 16, 17, 18, 19]) {
      const a = s.model.wavetables.find((w) => w.id === id)!;
      const b = out.wavetables.find((w) => w.id === id)!;
      expect(b, `wavetable ${id}`).toEqual(a);
    }
    expect(out.wavetables.map((w) => w.id)).toEqual(s.model.wavetables.map((w) => w.id));
  });

  it('voices (1D, 2D, Rows) and sequences survive', () => {
    const s: SessionState = { model: richModel().exportState(), ui: {} };
    const out = roundTrip(s, encodeWaveforms(s.model.timeline)).model;
    expect(out.voices).toEqual(s.model.voices);
    const v1 = out.voices.find((v) => v.id === 1)!;
    expect([v1.windowStartY, v1.windowEndY, v1.positionY, v1.lfoDepthY]).toEqual([2, 3, 0.2, 0.7]);
    expect(out.sequences).toEqual(s.model.sequences);
    expect([out.bpm, out.selectedId, out.breedParents]).toEqual([s.model.bpm, s.model.selectedId, s.model.breedParents]);
  });

  it('copies are stored as references and share data after decode', () => {
    const s: SessionState = { model: richModel().exportState(), ui: {} };
    const recs = encodeWaveforms(s.model.timeline);
    const copies = s.model.timeline.filter((t) => t.recipe.params.copyOf !== undefined);
    expect(copies).toHaveLength(3);
    for (const c of copies) expect(recs.find((r) => r.id === c.id)!.enc).toBe('ref');
    const out = roundTrip(s, recs).model;
    const byId = new Map(out.timeline.map((t) => [t.id, t]));
    const [c1, c2] = copies;
    expect(byId.get(c1.id)!.data).toBe(byId.get(s.model.timeline[1].id)!.data);
    expect(byId.get(c2.id)!.data).toBe(byId.get(c1.id)!.data);
  });

  it('stores cheap exact recipes (basic, pulse) as recipes, everything else as samples', () => {
    const s: SessionState = { model: richModel().exportState(), ui: {} };
    const recs = encodeWaveforms(s.model.timeline, { allowRecipe: true });
    const enc = (op: string) => [...new Set(recs.filter((r, i) => s.model.timeline[i].recipe.op === op && r.enc !== 'ref').map((r) => r.enc))];
    expect(enc('basic')).toEqual(['recipe']);
    expect(enc('pulse')).toEqual(['recipe']);
    for (const op of ['perlin', 'ca', 'formula', 'mutate', 'breed']) expect(enc(op), op).toEqual(['samples']);
    const out = roundTrip(s, recs);
    expectSameState(s.model, out.model);
  });

  it('a recipe that does not re-render exactly is stored as samples', () => {
    const t = { id: 1, data: generateBasic('saw', 0).data.map((x) => x * 0.5), recipe: generateBasic('saw', 0).recipe };
    expect(encodeWaveform(t, { allowRecipe: true }).enc).toBe('samples');
    expect(encodeWaveform({ ...t, data: generateBasic('saw', 0).data }, { allowRecipe: true }).enc).toBe('recipe');
  });

  it('a re-render that differs from the saved hash is used with a warning', () => {
    const s = defaultSessionState();
    const recs = encodeWaveforms(s.timeline, { allowRecipe: true }).map((r) => (r.enc === 'recipe' ? { ...r, hash: (r.hash! + 1) >>> 0 } : r));
    const { state, warnings } = decodeSession(encodeMeta({ model: s, ui: {} }), new Map(recs.map((r) => [r.id, r])));
    expect(state.model.timeline).toHaveLength(5);
    expect(warnings.some((w) => w.includes('re-rendered differently'))).toBe(true);
  });

  it('the .mkwz file round-trips (JSON + binary samples)', () => {
    const s: SessionState = { model: richModel().exportState(), ui: UI };
    const bytes = packSessionFile(encodeMeta(s, 5), encodeWaveforms(s.model.timeline));
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('MKWZ');
    const { meta, records } = unpackSessionFile(bytes);
    const out = decodeSession(meta, records).state;
    expectSameState(s.model, out.model);
    expect(out.ui).toEqual(UI);
  });
});

describe('session migration', () => {
  const v1 = () => JSON.parse(JSON.stringify(encodeMeta({ model: defaultSessionState(), ui: {} }))) as Record<string, unknown>;

  /** A version-1 meta (before user wavetable ids were saved) holding two user wavetables. */
  const version1 = () => {
    const m = new AppModel(64);
    m.loadState(defaultSessionState());
    m.createWavetable('2d');
    m.createWavetable('1d');
    const st = m.exportState();
    const meta: Record<string, unknown> = { ...JSON.parse(JSON.stringify(encodeMeta({ model: st, ui: {} }))), version: 1 };
    delete meta.nextWavetableId;
    return { meta, st };
  };

  it('migrates version 1 (no wavetable id counter) to the current version', () => {
    const { meta, st } = version1();
    const ids = st.wavetables.map((w) => w.id);
    const m = migrateMeta(meta);
    expect(m.version).toBe(SESSION_VERSION);
    expect(m.nextWavetableId).toBe(Math.max(...ids) + 1);
    const recs = new Map(encodeWaveforms(st.timeline).map((r) => [r.id, r]));
    const out = decodeSession(meta, recs).state.model;
    expect(out.wavetables).toEqual(st.wavetables);
    expect(out.nextWavetableId).toBe(Math.max(...ids) + 1);
    // A version-1 session without user wavetables starts at the first user id.
    const plain: Record<string, unknown> = { ...v1(), version: 1 };
    delete plain.nextWavetableId;
    expect(migrateMeta(plain).nextWavetableId).toBe(FIRST_USER_WAVETABLE_ID);
  });

  it('runs registered migrations in order up to the current version', () => {
    const old: Record<string, unknown> = { ...v1(), version: 0, tempo: 101 };
    delete old.bpm;
    const migrations = { ...MIGRATIONS, 0: ({ tempo, ...m }: Record<string, unknown>) => ({ ...m, bpm: tempo, version: 1 }) };
    const m = migrateMeta(old, migrations);
    expect(m.version).toBe(SESSION_VERSION);
    expect(m.bpm).toBe(101);
    const recs = encodeWaveforms(defaultSessionState().timeline);
    expect(decodeSession(old, new Map(recs.map((r) => [r.id, r])), { migrations }).state.model.bpm).toBe(101);
  });

  it('chains migrations across several versions', () => {
    const migrations = {
      ...MIGRATIONS,
      2: (m: Record<string, unknown>) => ({ ...m, version: 3, a: 1 }),
      3: (m: Record<string, unknown>) => ({ ...m, version: 4, b: (m.a as number) + 1 }),
    };
    const m = migrateMeta({ ...version1().meta }, migrations, 4);
    expect([m.version, m.a, m.b, typeof m.nextWavetableId]).toEqual([4, 1, 2, 'number']);
  });

  it('migrates version 2 (eighth-note sequences) to step length 1/8', () => {
    const m = richModel();
    const st = m.exportState();
    expect(st.sequences.map((s) => s.stepLength)).toEqual(['1/8', '1/16T']);
    // A version-2 meta: sequences had no step length.
    const meta: Record<string, unknown> = { ...JSON.parse(JSON.stringify(encodeMeta({ model: st, ui: {} }))), version: 2 };
    meta.sequences = (meta.sequences as Record<string, unknown>[]).map(({ stepLength: _, ...s }) => s);
    const up = migrateMeta(meta, MIGRATIONS, 3);
    expect(up.version).toBe(3);
    expect((up.sequences as Record<string, unknown>[]).map((s) => s.stepLength)).toEqual(['1/8', '1/8']);
    // Everything else about the sequences is untouched.
    expect((up.sequences as Record<string, unknown>[]).map(({ stepLength: _, ...s }) => s)).toEqual(meta.sequences);
    expect(MIGRATIONS[2](meta).sequences).toEqual(up.sequences);
    const recs = new Map(encodeWaveforms(st.timeline).map((r) => [r.id, r]));
    const out = decodeSession(meta, recs).state.model;
    expect(out.sequences).toEqual(st.sequences.map((s) => ({ ...s, stepLength: '1/8' })));
    // Re-saved, it is a current-version session that round-trips as is.
    const again = JSON.parse(JSON.stringify(encodeMeta({ model: out, ui: {} }))) as SessionMeta;
    expect(again.version).toBe(SESSION_VERSION);
    expect(decodeSession(again, recs).state.model.sequences).toEqual(out.sequences);
    // A version-1 session goes through both migrations.
    const v1meta: Record<string, unknown> = { ...meta, version: 1 };
    expect((migrateMeta(v1meta).sequences as Record<string, unknown>[]).every((s) => s.stepLength === '1/8')).toBe(true);
    // Odd sequence arrays don't break the migration.
    expect(MIGRATIONS[2]({ ...meta, sequences: [null, 3] }).sequences).toEqual([null, 3]);
    expect(MIGRATIONS[2]({ ...meta, sequences: undefined }).sequences).toBeUndefined();
  });

  it('round-trips every step length; unknown ones decode to 1/8', () => {
    const m = richModel();
    const recs = encodeWaveforms(m.exportState().timeline);
    for (const l of ['1/4', '1/8', '1/16', '1/8T', '1/16T'] as const) {
      m.updateSequence(1, { stepLength: l });
      const s: SessionState = { model: m.exportState(), ui: {} };
      expect(roundTrip(s, recs).model.sequences.find((x) => x.id === 1)!.stepLength).toBe(l);
    }
    const meta = JSON.parse(JSON.stringify(encodeMeta({ model: m.exportState(), ui: {} }))) as Record<string, unknown>;
    const seqs = meta.sequences as Record<string, unknown>[];
    seqs[0].stepLength = '1/32';
    seqs[1].stepLength = 8;
    seqs.push({ ...seqs[1], id: 9 });
    delete seqs[2].stepLength;
    const out = decodeSession(meta, new Map(recs.map((r) => [r.id, r]))).state.model.sequences;
    expect(out.map((s) => s.stepLength)).toEqual(['1/8', '1/8', '1/8']);
    // The model ignores invalid values too.
    m.updateSequence(1, { stepLength: 'x' as never });
    expect(m.sequences[0].stepLength).toBe('1/16T');
  });

  it('rejects newer versions and missing / failing migrations', () => {
    expect(() => migrateMeta({ ...v1(), version: SESSION_VERSION + 1 })).toThrow(/newer/);
    try {
      migrateMeta({ ...v1(), version: SESSION_VERSION + 1 });
    } catch (e) {
      expect((e as SessionError).kind).toBe('incompatible');
    }
    expect(() => migrateMeta({ ...v1(), version: 0 }, {})).toThrow(/no migration/);
    expect(() => migrateMeta({ ...v1(), version: 0 }, { 0: () => { throw new Error('boom'); } })).toThrow(SessionError);
    expect(() => migrateMeta({ ...v1(), version: 0 }, { 0: (m) => ({ ...m, version: 0 }) })).toThrow(/failed/);
  });
});

describe('session corrupt-data handling', () => {
  const s = () => defaultSessionState();
  const recsOf = (st: ModelState) => new Map(encodeWaveforms(st.timeline).map((r) => [r.id, r]));

  it('throws SessionError for unusable meta', () => {
    const recs = recsOf(s());
    for (const bad of [null, 'x', 42, [], {}, { format: 'other', version: 1 }, { format: SESSION_FORMAT }, { format: SESSION_FORMAT, version: 1 }]) {
      expect(() => decodeSession(bad, recs), JSON.stringify(bad)).toThrow(SessionError);
    }
  });

  it('throws when no waveform can be restored', () => {
    const st = s();
    expect(() => decodeSession(encodeMeta({ model: st, ui: {} }), new Map())).toThrow(/no waveform/);
  });

  it('drops missing / bad waveforms with a warning and repairs references to them', () => {
    const st = richModel().exportState();
    const recs = recsOf(st);
    const [a, b, c, d] = st.timeline.map((t) => t.id);
    recs.delete(a);
    recs.set(b, { ...recs.get(b)!, samples: new Float32Array(10) });
    const nan = new Float32Array(2048);
    nan[5] = NaN;
    recs.set(c, { ...recs.get(c)!, samples: nan });
    recs.set(d, { ...recs.get(d)!, recipe: { op: 3 } as never });
    // Copies referencing a bad record go too (their samples are that record's).
    const refs = [...recs.values()].filter((r) => r.enc === 'ref' && [a, b, c, d].includes(r.ref!)).map((r) => r.id);
    expect(refs.length).toBe(2);
    const { state, warnings } = decodeSession(encodeMeta({ model: st, ui: {} }), recs);
    const ids = new Set(state.model.timeline.map((t) => t.id));
    expect(state.model.timeline).toHaveLength(st.timeline.length - 6);
    for (const id of [a, b, c, d, ...refs]) expect(ids.has(id)).toBe(false);
    expect(warnings[0]).toMatch(/6 waveforms couldn't be restored/);
    // No wavetable references a dropped waveform; voices are clamped into their wavetables.
    for (const w of state.model.wavetables) for (const r of w.rows) for (const id of r) if (id !== null) expect(ids.has(id)).toBe(true);
    expect(state.model.wavetables.find((w) => w.id === TIMELINE_WAVETABLE_ID)!.rows[0]).toEqual(state.model.timeline.map((t) => t.id));
    expect(state.model.wavetables.find((w) => w.id === 18)!.rows[0][0]).toBeNull(); // fixed 2D: slot emptied
    expect(state.model.wavetables.find((w) => w.id === 17)!.rows[0]).toEqual([st.timeline[4].id, st.timeline[5].id]);
    expect(state.model.breedParents).not.toContain(a);
    for (const v of state.model.voices) {
      const w = state.model.wavetables.find((x) => x.id === v.wavetableId)!;
      if (w.shape !== 'rows') expect(v.windowEnd).toBeLessThan(Math.max(1, w.rows[0].length));
    }
  });

  it('falls back to defaults for bad fields and keeps going', () => {
    const st = s();
    const meta = JSON.parse(JSON.stringify(encodeMeta({ model: st, ui: {} })));
    meta.voices[0].level = 'loud';
    meta.voices[0].wavetableId = 999;
    meta.voices[1] = 'nope';
    meta.sequences[0].steps = 'x';
    meta.sequences[1].voiceId = 77;
    meta.wavetables[2] = { id: 2, builtin: 'batches', shape: 'blob' };
    meta.wavetables.push({ id: 40, shape: '2d', rows: [[1, 'x'], [2]], write: { dir: 'up' } });
    meta.wavetables.push({ id: 41, shape: '2d', rows: [[1, 2], [3, 4]], write: { dir: '-x', step: { x: 'a', y: 99 } } });
    meta.wavetables.push({ id: 42, shape: '1d', fixed: false, rows: [[1, 2]], write: { dir: '+x', mode: 'insert', edge: 'grow', step: { x: 3, y: 0 } } });
    meta.bpm = 'fast';
    meta.selectedId = 999;
    meta.ui = 'bad';
    const { state } = decodeSession(meta, recsOf(st));
    const v = state.model.voices;
    expect(v).toHaveLength(2);
    expect(v[0].level).toBe(0.8);
    expect(v[0].wavetableId).toBe(TIMELINE_WAVETABLE_ID);
    expect(state.model.sequences[0].steps.every((x) => x === -1)).toBe(true);
    expect(state.model.sequences[1].voiceId).toBeNull();
    expect(state.model.wavetables.find((w) => w.id === BATCHES_WAVETABLE_ID)!.shape).toBe('rows');
    const w40 = state.model.wavetables.find((w) => w.id === 40)!;
    expect(w40.rows).toEqual([[1, null], [2, null]]);
    expect(w40.write.dir).toBe('+x');
    // Bad step values: a non-number axis is 0, the rest clamped; variable lines keep ±1.
    expect(state.model.wavetables.find((w) => w.id === 41)!.write).toMatchObject({ dir: '+y', step: { x: 0, y: 8 } });
    expect(state.model.wavetables.find((w) => w.id === 42)!.write.step).toEqual({ x: 1, y: 0 });
    expect(state.model.bpm).toBe(132);
    expect(state.model.selectedId).toBe(st.timeline.at(-1)!.id);
    expect(state.ui).toEqual({});
  });

  it('rejects bad / truncated files', () => {
    const st = s();
    const bytes = packSessionFile(encodeMeta({ model: st, ui: {} }), encodeWaveforms(st.timeline));
    expect(() => unpackSessionFile(new Uint8Array([1, 2, 3]))).toThrow(SessionError);
    expect(() => unpackSessionFile(new TextEncoder().encode('JUNKJUNKJUNKJUNK'))).toThrow(/not an mkwavez/);
    expect(() => unpackSessionFile(bytes.subarray(0, 40))).toThrow(/truncated/);
    // Sample block cut short: those waveforms are dropped, the session still decodes.
    const cut = unpackSessionFile(bytes.subarray(0, bytes.length - 4));
    const { state, warnings } = decodeSession(cut.meta, cut.records);
    expect(state.model.timeline).toHaveLength(4);
    expect(warnings[0]).toMatch(/1 waveform couldn't/);
  });
});

// ---- autosave ----

class QuotaError extends Error {
  override name = 'QuotaExceededError';
}

/** In-memory store: the autosave backend plus what restoreSession reads. */
class MemoryBackend implements RestoreStore {
  meta: SessionMeta | null = null;
  waveforms = new Map<TableId, WaveformRecord>();
  keptSessions: { meta: unknown; records: WaveformRecord[]; error: string }[] = [];
  get kept() {
    return this.keptSessions.at(-1);
  }
  puts = 0;
  written: TableId[] = [];
  fail = false;
  failKeep = false;
  /** Max waveform records (quota). */
  capacity = Infinity;
  private room(records: readonly WaveformRecord[], removing: readonly TableId[] = []) {
    const ids = new Set(this.waveforms.keys());
    for (const id of removing) ids.delete(id);
    for (const r of records) ids.add(r.id);
    if (ids.size > this.capacity) throw new QuotaError('The quota has been exceeded.');
  }
  async putWaveforms(records: readonly WaveformRecord[]) {
    if (this.fail) throw new Error('disk error');
    this.room(records);
    this.puts++;
    for (const r of records) {
      this.waveforms.set(r.id, r);
      this.written.push(r.id);
    }
  }
  async commit(meta: SessionMeta, remove: readonly TableId[], records: readonly WaveformRecord[] = []) {
    if (this.fail) throw new Error('disk error');
    this.room(records, remove);
    for (const r of records) {
      this.waveforms.set(r.id, r);
      this.written.push(r.id);
    }
    this.meta = JSON.parse(JSON.stringify(meta));
    for (const id of remove) this.waveforms.delete(id);
  }
  async remove(ids: readonly TableId[]) {
    for (const id of ids) this.waveforms.delete(id);
  }
  async clear() {
    this.meta = null;
    this.waveforms.clear();
  }
  async load() {
    return { meta: this.meta ?? undefined, records: new Map(this.waveforms) };
  }
  async loadMeta() {
    return this.meta ?? undefined;
  }
  async keys() {
    return [...this.waveforms.keys()];
  }
  async keptList() {
    return this.keptSessions.map((k) => ({ maxId: Math.max(0, ...k.records.map((r) => r.id)) }));
  }
  async keep(meta: unknown, records: readonly WaveformRecord[], error: string) {
    if (this.failKeep) throw new Error('disk error');
    this.keptSessions.push({ meta, records: [...records], error });
    this.meta = null;
    this.waveforms.clear();
  }
}

function fakeScheduler(): SaveScheduler & { timers: Map<number, () => void>; t: number; fire(): void } {
  let n = 0;
  const s = {
    t: 0,
    timers: new Map<number, () => void>(),
    now: () => s.t,
    setTimer: (fn: () => void) => {
      s.timers.set(++n, fn);
      return n;
    },
    clearTimer: (h: unknown) => void s.timers.delete(h as number),
    idle: (fn: () => void) => void Promise.resolve().then(fn),
    fire() {
      const fns = [...s.timers.values()];
      s.timers.clear();
      for (const f of fns) f();
    },
  };
  return s;
}

function saverFor(m: AppModel, be: MemoryBackend | null = new MemoryBackend()) {
  const sched = fakeScheduler();
  const saver = new Autosaver(m, () => ({ tab: 'Seed' }), be, sched, { chunk: 4 });
  return { saver, be: be!, sched };
}

const restore = (be: MemoryBackend) => decodeSession(be.meta, be.waveforms).state;

describe('Autosaver', () => {
  it('debounces changes and writes the session', async () => {
    const m = new AppModel(64);
    m.loadState(defaultSessionState());
    const { saver, be, sched } = saverFor(m);
    expect(saver.status).toBe('saved');
    m.setTransport({ bpm: 150 });
    m.setTransport({ bpm: 151 });
    expect(saver.status).toBe('pending');
    expect(sched.timers.size).toBe(1);
    sched.fire();
    await saver.flush();
    expect(saver.status).toBe('saved');
    const r = restore(be);
    expectSameState(m.exportState(), r.model);
    expect(r.ui).toEqual({ tab: 'Seed' });
  });

  it('saves Shape chain edits and saved chains', async () => {
    const m = new AppModel(64);
    m.loadState(defaultSessionState());
    const { saver, be } = saverFor(m);
    m.saveShapeChain('Mine');
    expect(saver.status).toBe('pending');
    await saver.flush();
    m.setShapeChain({ ...m.shapeChain, varySeed: true });
    expect(saver.status).toBe('pending');
    await saver.flush();
    const r = restore(be);
    expect(r.model.shapeChains?.map((c) => c.chain.name)).toEqual(['Mine']);
    expect(r.model.shapeChain?.varySeed).toBe(true);
  });

  it('writes each waveform once (incremental) and deletes evicted ones', async () => {
    const m = new AppModel(70);
    m.loadState(defaultSessionState());
    const { saver, be } = saverFor(m);
    saver.markDirty();
    await saver.flush();
    expect(be.written).toEqual([1, 2, 3, 4, 5]);
    m.addTables([generateBasic('saw', 0)]);
    m.select(2);
    await saver.flush();
    expect(be.written).toEqual([1, 2, 3, 4, 5, 6]);
    // Fill past the cap: the oldest unpinned waveforms are evicted and their records deleted.
    m.addTables(generatePerlin(DEFAULT_PERLIN, 1, 64), false);
    m.addTables(generatePerlin(DEFAULT_PERLIN, 2, 8), false);
    await saver.flush();
    const live = new Set(m.timeline.map((t) => t.id));
    expect([...be.waveforms.keys()].every((id) => live.has(id))).toBe(true);
    expect(be.waveforms.size).toBe(m.timeline.length);
    expectSameState(m.exportState(), restore(be).model);
  });

  it('copies reference their source, which is kept while referenced', async () => {
    const m = new AppModel(70);
    m.loadState(defaultSessionState());
    const { saver, be } = saverFor(m);
    const c = m.copyToEnd(2)!;
    await saver.flush();
    expect(be.waveforms.get(c.id)!.enc).toBe('ref');
    expect(be.waveforms.get(c.id)!.ref).toBe(2);
    // Evict waveform 2 (not the copy): its record stays because the copy references it.
    m.addTables(generatePerlin(DEFAULT_PERLIN, 1, 64), false);
    m.addTables(generatePerlin(DEFAULT_PERLIN, 2, 4), false);
    expect(m.table(2)).toBeUndefined();
    expect(m.table(c.id)).toBeDefined();
    await saver.flush();
    expect(be.waveforms.has(2)).toBe(true);
    const r = restore(be).model;
    expect(samplesHash(r.timeline.find((t) => t.id === c.id)!.data)).toBe(samplesHash(c.data));
  });

  it('resumes after a restore without rewriting stored waveforms', async () => {
    const m = new AppModel(64);
    m.loadState(richModel().exportState());
    const first = saverFor(m);
    first.saver.markDirty();
    await first.saver.flush();
    const be = first.be;
    const m2 = new AppModel(64);
    m2.loadState(restore(be).model);
    const { saver, sched } = { ...saverFor(m2, be) };
    saver.init(be.waveforms.values());
    be.written = [];
    m2.addTables([generateBasic('tri', 0)]);
    sched.fire();
    await saver.flush();
    expect(be.written).toEqual([m2.timeline.at(-1)!.id]);
    expectSameState(m2.exportState(), restore(be).model);
  });

  it('replace() clears the store and saves the new session', async () => {
    const m = new AppModel(64);
    m.loadState(richModel().exportState());
    const { saver, be } = saverFor(m);
    saver.markDirty();
    await saver.flush();
    let applied: unknown = null;
    await saver.replace({ model: defaultSessionState(), ui: { voiceId: 1 } }, (u) => (applied = u));
    expect(applied).toEqual({ voiceId: 1 });
    expect(m.timeline).toHaveLength(5);
    expect([...be.waveforms.keys()]).toEqual([1, 2, 3, 4, 5]);
    expect(m.undoDepth).toBe(0);
    expectSameState(m.exportState(), restore(be).model);
  });

  it('reports errors and retries on the next change', async () => {
    const m = new AppModel(64);
    m.loadState(defaultSessionState());
    const { saver, be, sched } = saverFor(m);
    be.fail = true;
    saver.markDirty();
    await saver.flush();
    expect(saver.status).toBe('error');
    expect(saver.lastError).toBe('disk error');
    expect(saver.quotaFull).toBe(false);
    expect(sched.timers.size).toBe(0); // no retry loop
    be.fail = false;
    m.setTransport({ bpm: 99 });
    sched.fire();
    await saver.flush();
    expect(saver.status).toBe('saved');
    expect(restore(be).model.bpm).toBe(99);
  });

  it('without storage it stays off and the app still works', async () => {
    const m = new AppModel(64);
    m.loadState(defaultSessionState());
    const sched = fakeScheduler();
    const saver = new Autosaver(m, () => ({}), null, sched);
    m.addTables([generateBasic('saw', 0)]);
    await saver.flush();
    expect(saver.status).toBe('off');
    expect(sched.timers.size).toBe(0);
    await saver.replace({ model: defaultSessionState(), ui: {} }, () => {});
    expect(m.timeline).toHaveLength(5);
  });
});

describe('autosave robustness', () => {
  /** A saved default session in a fresh backend, plus a model that mirrors it. */
  async function savedDefault(be = new MemoryBackend()) {
    const m = new AppModel(70);
    m.loadState(defaultSessionState());
    const { saver, sched } = saverFor(m, be);
    saver.markDirty();
    await saver.flush();
    return { m, saver, sched, be };
  }

  /** "Reload": decode what the backend holds into a new model + autosaver. */
  function reload(be: MemoryBackend) {
    const m = new AppModel(70);
    m.loadState(restore(be).model);
    const { saver, sched } = saverFor(m, be);
    saver.init(be.waveforms.values());
    return { m, saver, sched };
  }

  it('1: an orphan record (waveform written, meta never committed) is never mistaken for a new waveform', async () => {
    const { m, be } = await savedDefault();
    m.addTables([generateBasic('saw', 0)], false);
    const orphan = m.timeline.at(-1)!;
    await be.putWaveforms([encodeWaveform(orphan)]); // crash before the meta commit
    const r = reload(be);
    await Promise.resolve();
    expect(be.waveforms.has(orphan.id)).toBe(false); // unreachable from the meta: deleted
    r.m.addTables([generateBasic('square', 0)], false);
    const added = r.m.timeline.at(-1)!;
    expect(added.id).toBeGreaterThan(orphan.id); // ids above every stored record
    await r.saver.flush();
    const back = restore(be).model.timeline.find((t) => t.id === added.id)!;
    expect(samplesHash(back.data)).toBe(samplesHash(added.data));
    expectSameState(r.m.exportState(), restore(be).model);
  });

  it('1: even if the orphan can not be deleted, a reused id is rewritten', async () => {
    const { m, be } = await savedDefault();
    m.addTables([generateBasic('saw', 0)], false);
    const orphan = m.timeline.at(-1)!;
    await be.putWaveforms([encodeWaveform(orphan)]);
    const remove = be.remove.bind(be);
    be.remove = async () => {
      throw new Error('blocked');
    };
    const r = reload(be);
    be.remove = remove;
    // Force a colliding allocator: exactly at the orphan's id.
    r.m.loadState({ ...r.m.exportState(), nextTableId: orphan.id });
    r.m.addTables([generateBasic('square', 0)], false);
    const added = r.m.timeline.at(-1)!;
    expect(added.id).toBe(orphan.id);
    await r.saver.flush();
    expect(samplesHash(restore(be).model.timeline.find((t) => t.id === added.id)!.data)).toBe(samplesHash(added.data));
  });

  it('2: an unrestorable save is set aside intact and the new session never collides with it', async () => {
    const { be } = await savedDefault();
    const oldMeta = { ...be.meta!, version: SESSION_VERSION + 1 }; // from a newer version
    be.meta = oldMeta as SessionMeta;
    const oldRecords = new Map(be.waveforms);
    const boot = await restoreSession(async () => be, async () => true);
    expect(boot.restored).toBe(false);
    expect(boot.store).toBe(be);
    expect(boot.keptCount).toBe(1);
    expect(boot.notices[0].kind).toBe('kept');
    expect(boot.notices[0].text).toMatch(/newer version/);
    expect(be.kept!.meta).toEqual(oldMeta);
    expect(new Map(be.kept!.records.map((r) => [r.id, r]))).toEqual(oldRecords);
    // The fresh session saves alongside it, with ids above the kept ones.
    const m = new AppModel(70);
    m.loadState(boot.state.model);
    const { saver } = saverFor(m, be);
    saver.init(boot.stored);
    m.reserveTableIds(boot.reserve);
    m.addTables([generateBasic('saw', 0)]);
    saver.markDirty();
    await saver.flush();
    expect(m.timeline.at(-1)!.id).toBeGreaterThan(Math.max(...oldRecords.keys()));
    expect(be.kept!.records).toHaveLength(oldRecords.size);
    // A later restart still finds the kept one and keeps ids clear of it.
    const again = await restoreSession(async () => be, async () => true);
    expect(again.restored).toBe(true);
    expect(again.keptCount).toBe(1);
    expect(again.reserve).toBe(Math.max(...oldRecords.keys()) + 1);
  });

  it('2: if it can not be set aside (or another tab owns the store) nothing is overwritten', async () => {
    const { be } = await savedDefault();
    be.meta = { ...be.meta!, timeline: 'garbage' } as unknown as SessionMeta;
    const before = { meta: be.meta, records: new Map(be.waveforms) };
    const notOwner = await restoreSession(async () => be, async () => false);
    expect(notOwner.owner).toBe(false);
    expect(be.kept).toBeUndefined();
    expect(be.meta).toBe(before.meta);
    be.failKeep = true;
    const boot = await restoreSession(async () => be, async () => true);
    expect(boot.store).toBeNull(); // autosave off in this tab
    expect(boot.notices[0].kind).toBe('off');
    expect(be.meta).toBe(before.meta);
    expect(be.waveforms).toEqual(before.records);
  });

  it('no storage: fresh session, autosave off', async () => {
    const boot = await restoreSession(
      async () => {
        throw new Error('blocked');
      },
      async () => true,
    );
    expect(boot.store).toBeNull();
    expect(boot.state.model.timeline).toHaveLength(5);
    expect(boot.notices[0].text).toMatch(/Autosave is off/);
  });

  it('3: only the owning tab writes; taking over rewrites everything, the old owner stops', async () => {
    const { m: a, saver: sa, be } = await savedDefault();
    // Tab B restores the same save but doesn't own autosave.
    const b = reload(be);
    b.saver.setActive(false);
    expect(b.saver.status).toBe('paused');
    // Both add a waveform; they get the same id with different data.
    a.addTables([generateBasic('saw', 0)]);
    b.m.addTables([generateBasic('square', 0)]);
    expect(a.timeline.at(-1)!.id).toBe(b.m.timeline.at(-1)!.id);
    b.m.setTransport({ bpm: 77 });
    await sa.flush();
    await b.saver.flush();
    expect(b.saver.flushNow()).toBeNull();
    expect(b.sched.timers.size).toBe(0);
    expectSameState(a.exportState(), restore(be).model); // B wrote nothing
    // B takes over.
    sa.setActive(false);
    b.saver.adopt(be.waveforms.keys());
    b.saver.setActive(true);
    await b.saver.flush();
    expectSameState(b.m.exportState(), restore(be).model);
    expect([...be.waveforms.keys()].sort((x, y) => x - y)).toEqual(b.m.timeline.map((t) => t.id).sort((x, y) => x - y));
    // A's later changes go nowhere.
    a.setTransport({ bpm: 200 });
    await sa.flush();
    expect(sa.flushNow()).toBeNull();
    expect(restore(be).model.bpm).toBe(77);
  });

  it('flushNow writes meta and unwritten waveforms in one commit, issued synchronously', async () => {
    const { m, saver, be } = await savedDefault();
    m.addTables(generatePerlin(DEFAULT_PERLIN, 4, 12), false);
    const commits: number[] = [];
    const commit = be.commit.bind(be);
    be.commit = (meta, remove, records = []) => {
      commits.push(records.length);
      return commit(meta, remove, records);
    };
    const p = saver.flushNow();
    expect(p).not.toBeNull();
    expect(commits).toEqual([12]);
    await p;
    expectSameState(m.exportState(), restore(be).model);
  });

  it('5: at the storage quota, unreferenced records are deleted first so saving continues', async () => {
    const be = new MemoryBackend();
    be.capacity = 70;
    const { m, saver } = await savedDefault(be);
    m.addTables(generatePerlin(DEFAULT_PERLIN, 1, 64), false); // 69 waveforms
    await saver.flush();
    expect(saver.status).toBe('saved');
    // Evicts some; storing the new records before deleting the evicted ones would exceed 70.
    m.addTables(generatePerlin(DEFAULT_PERLIN, 2, 9), false);
    expect(m.timeline).toHaveLength(70);
    await saver.flush();
    expect(saver.status).toBe('saved');
    expectSameState(m.exportState(), restore(be).model);
  });

  it('5: a full store reports a quota error and recovers once there is room', async () => {
    const be = new MemoryBackend();
    const { m, saver, sched } = await savedDefault(be);
    be.capacity = 5;
    m.addTables([generateBasic('saw', 0)]);
    await saver.flush();
    expect(saver.status).toBe('error');
    expect(saver.quotaFull).toBe(true);
    be.capacity = Infinity;
    m.setTransport({ bpm: 90 });
    sched.fire();
    await saver.flush();
    expect(saver.status).toBe('saved');
    expectSameState(m.exportState(), restore(be).model);
  });
});

describe('import limits', () => {
  it('drops sample blocks of the wrong length', () => {
    const st = defaultSessionState();
    const meta = encodeMeta({ model: st, ui: {} });
    const recs = encodeWaveforms(st.timeline);
    const short = { ...recs[1], samples: recs[1].samples!.subarray(0, 100) };
    const { meta: m2, records } = unpackSessionFile(packSessionFile(meta, [recs[0], short, ...recs.slice(2)]));
    expect(records.get(recs[1].id)?.samples).toBeUndefined();
    const { state, warnings } = decodeSession(m2, records);
    expect(state.model.timeline).toHaveLength(4);
    expect(warnings[0]).toMatch(/1 waveform/);
  });

  it('caps the timeline, dropping the oldest unpinned waveforms', () => {
    const m = new AppModel(200);
    m.loadState(defaultSessionState());
    m.addTables(generatePerlin(DEFAULT_PERLIN, 1, 64), false);
    m.addTables(generatePerlin(DEFAULT_PERLIN, 2, 20), false);
    const st = m.exportState();
    const recs = new Map(encodeWaveforms(st.timeline).map((r) => [r.id, r]));
    const { state, warnings } = decodeSession(encodeMeta({ model: st, ui: {} }), recs, { cap: 70 });
    expect(state.model.timeline).toHaveLength(70);
    expect(warnings.at(-1)).toMatch(/19 oldest waveforms dropped/);
    // Pinned waveforms (Grid, Last batch) survive; the oldest unpinned went first.
    const ids = new Set(state.model.timeline.map((t) => t.id));
    for (const w of state.model.wavetables) if (w.pins) for (const r of w.rows) for (const id of r) if (id !== null) expect(ids.has(id)).toBe(true);
    expect(ids.has(st.timeline[0].id)).toBe(false);
    expect(state.model.wavetables[0].rows[0]).toEqual(state.model.timeline.map((t) => t.id));
  });
});

describe('tab ownership', () => {
  /** A scheduler whose idle callbacks run only when released (a chunked save can be paused mid-way). */
  function heldScheduler() {
    const s = fakeScheduler();
    const held: (() => void)[] = [];
    return {
      ...s,
      idle: (fn: () => void) => void held.push(fn),
      async release() {
        while (held.length) {
          held.shift()!();
          await new Promise((r) => setTimeout(r, 0));
        }
      },
      held,
    };
  }

  async function ownerWithSave() {
    const be = new MemoryBackend();
    const m = new AppModel(70);
    m.loadState(defaultSessionState());
    const sched = heldScheduler();
    const saver = new Autosaver(m, () => ({}), be, sched, { chunk: 4, budgetMs: 0 });
    saver.markDirty();
    await saver.flush();
    return { be, m, saver, sched };
  }

  it('a second tab opening while the owner is mid-save deletes nothing (no "waveform missing" on reload)', async () => {
    const a = await ownerWithSave();
    a.m.addTables(generatePerlin(DEFAULT_PERLIN, 3, 12), false);
    a.sched.fire(); // the debounced save starts ...
    await new Promise((r) => setTimeout(r, 0));
    expect(a.sched.held.length).toBe(1); // ... and yields after its first chunk, meta not committed yet
    const written = a.m.timeline.slice(5, 9).map((t) => t.id);
    for (const id of written) expect(a.be.waveforms.has(id)).toBe(true);

    // Tab B starts now: restores the old meta, doesn't own autosave.
    const boot = await restoreSession(async () => a.be, async () => false);
    expect(boot.owner).toBe(false);
    const b = new AppModel(70);
    b.loadState(boot.state.model);
    const sb = new Autosaver(b, () => ({}), a.be, fakeScheduler());
    sb.setActive(false);
    sb.init(boot.stored);
    await new Promise((r) => setTimeout(r, 0));
    for (const id of written) expect(a.be.waveforms.has(id), `record ${id} kept`).toBe(true);
    expect(b.exportState().nextTableId).toBeGreaterThan(Math.max(...written)); // still no id reuse

    // A finishes; a reload restores everything without warnings.
    await a.sched.release();
    await a.saver.flush();
    const { state, warnings } = decodeSession(a.be.meta, a.be.waveforms);
    expect(warnings).toEqual([]);
    expectSameState(a.m.exportState(), state.model);
  });

  it('late lock (reload): the same save carries on incrementally', async () => {
    const a = await ownerWithSave();
    const boot = await restoreSession(async () => a.be, async () => false);
    const b = new AppModel(70);
    b.loadState(boot.state.model);
    const sb = new Autosaver(b, () => ({}), a.be, fakeScheduler());
    sb.setActive(false);
    sb.init(boot.stored);
    a.be.written = [];
    await becomeOwner(sb, a.be, boot, false);
    b.addTables([generateBasic('saw', 0)]);
    await sb.flush();
    expect(a.be.written).toEqual([b.timeline.at(-1)!.id]);
    expectSameState(b.exportState(), restore(a.be).model);
  });

  it('late lock after another tab saved, or a takeover: everything rewritten in one transaction', async () => {
    const a = await ownerWithSave();
    const boot = await restoreSession(async () => a.be, async () => false);
    const b = new AppModel(70);
    b.loadState(boot.state.model);
    const sb = new Autosaver(b, () => ({}), a.be, fakeScheduler());
    sb.setActive(false);
    sb.init(boot.stored);
    // A saves a change B doesn't have (same next id as B's next add, different data).
    a.m.addTables([generateBasic('saw', 0)]);
    await a.saver.flush();
    b.addTables([generateBasic('square', 0)]);
    a.saver.setActive(false);
    const commits: number[] = [];
    const commit = a.be.commit.bind(a.be);
    a.be.commit = (meta, remove, records = []) => {
      commits.push(records.length);
      return commit(meta, remove, records);
    };
    const puts = a.be.puts;
    await becomeOwner(sb, a.be, boot, false);
    await sb.flush();
    expect(a.be.puts).toBe(puts); // no chunked puts ...
    expect(commits).toEqual([b.timeline.length]); // ... one commit with every waveform
    expectSameState(b.exportState(), restore(a.be).model);
  });

  it('a save this tab could not restore is set aside when it becomes the owner; kept sessions accumulate', async () => {
    const a = await ownerWithSave();
    a.be.keptSessions.push({ meta: { old: true }, records: [], error: 'older' });
    a.be.meta = { ...a.be.meta!, version: SESSION_VERSION + 1 } as SessionMeta;
    const ids = [...a.be.waveforms.keys()];
    const boot = await restoreSession(async () => a.be, async () => false);
    expect(boot.unrestorable).toBeDefined();
    expect(a.be.keptSessions).toHaveLength(1); // not the owner: untouched
    const b = new AppModel(70);
    b.loadState(boot.state.model);
    b.reserveTableIds(boot.reserve);
    const sb = new Autosaver(b, () => ({}), a.be, fakeScheduler());
    sb.setActive(false);
    sb.init(boot.stored);
    a.saver.setActive(false);
    await becomeOwner(sb, a.be, boot, false);
    await sb.flush();
    expect(a.be.keptSessions).toHaveLength(2);
    expect(a.be.kept!.records.map((r) => r.id).sort()).toEqual(ids.sort());
    expect(boot.keptCount).toBe(2);
    expectSameState(b.exportState(), restore(a.be).model);
  });
});

describe('user wavetables (editor) round-trip', () => {
  /** Built through the model's editor API: create / edit / duplicate / rename / delete, live heads. */
  function editedModel() {
    const m = new AppModel(200);
    m.loadState(defaultSessionState());
    m.addTables(generatePerlin(DEFAULT_PERLIN, 5, 6), false);
    const ids = m.timeline.map((t) => t.id);
    const g = m.createWavetable('2d', 3, 2);
    m.placeInWavetable(g.id, { kind: 'slot', x: 0, y: 0 }, ids[1]);
    m.placeInWavetable(g.id, { kind: 'slot', x: 2, y: 1 }, ids[4]);
    m.setWavetableLive(g.id, true);
    m.setWavetableWrite(g.id, { dir: '+y', edge: 'stop', onWrap: 'next' });
    m.setWavetableHead(g.id, 1, 0);
    m.renameWavetable(g.id, 'Pad');
    m.setWavetableInterp(g.id, 'step');
    const line = m.createWavetable('1d');
    m.placeInWavetable(line.id, { kind: 'gap', x: 0, y: 0 }, ids[2]);
    m.placeInWavetable(line.id, { kind: 'gap', x: 1, y: 0 }, ids[3]);
    m.resizeWavetable1D(line.id, true, 4);
    const rows = m.createWavetable('rows');
    m.placeInWavetable(rows.id, { kind: 'row', y: 0 }, ids[0]);
    m.placeInWavetable(rows.id, { kind: 'row', y: 1 }, ids[5]);
    m.setWavetableLive(rows.id, true);
    const dup = m.duplicateWavetable(GRID_WAVETABLE_ID)!;
    const gone = m.createWavetable('1d');
    m.deleteWavetable(gone.id); // its id must never come back
    m.addVoice({ wavetableId: g.id, windowStart: 0, windowEnd: 2, windowStartY: 1, windowEndY: 1, positionY: 0.3 });
    m.addVoice({ wavetableId: rows.id, windowStartY: 0, windowEndY: 1 });
    // A live add writes at the heads.
    m.addTables(generatePerlin(DEFAULT_PERLIN, 6, 2), false);
    m.clearUndo();
    return { m, g, line, rows, dup, gone };
  }

  it('saves every user wavetable field, write heads and the id counter', () => {
    const { m, g, gone } = editedModel();
    const s: SessionState = { model: m.exportState(), ui: {} };
    expect(s.model.nextWavetableId).toBe(gone.id + 1);
    const bytes = packSessionFile(encodeMeta(s), encodeWaveforms(s.model.timeline));
    const { meta, records } = unpackSessionFile(bytes);
    const out = decodeSession(meta, records).state.model;
    expectSameState(s.model, out);
    expect(out.wavetables.find((w) => w.id === g.id)!.head).toEqual(s.model.wavetables.find((w) => w.id === g.id)!.head);
    // Restored into a model: new wavetables never reuse the deleted id.
    const r = new AppModel(200);
    r.loadState(out);
    const probe = new AppModel(200);
    probe.loadState(out);
    expect(probe.createWavetable('1d').id).toBe(gone.id + 1);
    // ... and live heads keep writing exactly as in the original.
    const add = generatePerlin(DEFAULT_PERLIN, 7, 3);
    m.addTables(add, false);
    r.addTables(add, false);
    expect(r.exportState().wavetables).toEqual(m.exportState().wavetables);
  });

  it('a full user wavetable (MAX_USER_SLOTS) stays full; oversized ones are cut to the limits', () => {
    const m = new AppModel(TIMELINE_CAP);
    m.loadState(defaultSessionState());
    m.addTables(Array.from({ length: 60 }, () => generateBasic('saw', 0)), false);
    const ids = m.timeline.map((t) => t.id);
    const st = m.exportState();
    const full = make1D(40, 'Full', Array.from({ length: MAX_USER_SLOTS }, (_, i) => ids[i % ids.length]), { live: true });
    const huge = make1D(41, 'Huge', Array.from({ length: MAX_USER_SLOTS + 10 }, (_, i) => ids[i % ids.length]));
    const grid = make2D(42, 'Big', 70, 2, []);
    const state = { ...st, wavetables: [...st.wavetables, full, huge, grid], nextWavetableId: 50 };
    const out = decodeSession(encodeMeta({ model: state, ui: {} }), new Map(encodeWaveforms(st.timeline).map((r) => [r.id, r]))).state.model;
    const by = (id: number) => out.wavetables.find((w) => w.id === id)!;
    expect(isFull(by(40))).toBe(true);
    expect(by(40)).toEqual(full);
    expect(slotCount(by(41))).toBe(MAX_USER_SLOTS);
    expect(by(41).rows[0]).toEqual(huge.rows[0].slice(10)); // the newest slots kept
    expect(by(42).rows[0].length).toBe(MAX_GRID);
    expect(out.nextWavetableId).toBe(50);
  });

  it('voices on a wavetable that is gone fall back to the Timeline', () => {
    const { m, g } = editedModel();
    const st = m.exportState();
    const meta = JSON.parse(JSON.stringify(encodeMeta({ model: st, ui: {} })));
    meta.wavetables = meta.wavetables.filter((w: { id: number }) => w.id !== g.id);
    const out = decodeSession(meta, new Map(encodeWaveforms(st.timeline).map((r) => [r.id, r]))).state.model;
    const v = out.voices.find((x) => x.id === st.voices.find((y) => y.wavetableId === g.id)!.id)!;
    expect(v.wavetableId).toBe(TIMELINE_WAVETABLE_ID);
    expect([v.windowStart, v.windowEnd]).toEqual([0, st.timeline.length - 1]);
    expect(out.nextWavetableId).toBe(st.nextWavetableId); // the counter doesn't go back
  });
});
