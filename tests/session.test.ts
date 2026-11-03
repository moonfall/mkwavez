import { describe, expect, it } from 'vitest';
import { Autosaver, type SaveScheduler, type SessionBackend } from '../src/app/autosave';
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
import type { TableId } from '../src/core/table';
import {
  BATCHES_WAVETABLE_ID,
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
    make2D(18, 'Pad', 3, 2, [ids[0], ids[1], null, ids[6], ids[7], ids[8]], { live: true, write: { dir: '+y', edge: 'stop', onWrap: 'next', mode: 'replace' }, head: { x: 1, y: 1 } }),
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
  m.updateSequence(2, { gate: 0.8 });
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

  it('runs registered migrations in order up to the current version', () => {
    const old: Record<string, unknown> = { ...v1(), version: 0, tempo: 101 };
    delete old.bpm;
    const migrations = { 0: ({ tempo, ...m }: Record<string, unknown>) => ({ ...m, bpm: tempo, version: 1 }) };
    const m = migrateMeta(old, migrations);
    expect(m.version).toBe(SESSION_VERSION);
    expect(m.bpm).toBe(101);
    const recs = encodeWaveforms(defaultSessionState().timeline);
    expect(decodeSession(old, new Map(recs.map((r) => [r.id, r])), { migrations }).state.model.bpm).toBe(101);
  });

  it('chains migrations across several versions', () => {
    const migrations = {
      1: (m: Record<string, unknown>) => ({ ...m, version: 2, a: 1 }),
      2: (m: Record<string, unknown>) => ({ ...m, version: 3, b: (m.a as number) + 1 }),
    };
    const m = migrateMeta(v1(), migrations, 3);
    expect([m.version, m.a, m.b]).toEqual([3, 1, 2]);
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

class MemoryBackend implements SessionBackend {
  meta: SessionMeta | null = null;
  waveforms = new Map<TableId, WaveformRecord>();
  puts = 0;
  written: TableId[] = [];
  fail = false;
  async putWaveforms(records: readonly WaveformRecord[]) {
    if (this.fail) throw new Error('quota');
    this.puts++;
    for (const r of records) {
      this.waveforms.set(r.id, r);
      this.written.push(r.id);
    }
  }
  async commit(meta: SessionMeta, remove: readonly TableId[]) {
    if (this.fail) throw new Error('quota');
    this.meta = JSON.parse(JSON.stringify(meta));
    for (const id of remove) this.waveforms.delete(id);
  }
  async clear() {
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
    expect(saver.lastError).toBe('quota');
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
