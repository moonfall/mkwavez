import { describe, expect, it } from 'vitest';
import { DEFAULT_VOICE, followEdit, remapWindowByMap, type VoiceParams } from '../src/core/voice';
import {
  BATCHES_WAVETABLE_ID,
  builtinWavetables,
  cellAt,
  clampWindow,
  composeMaps,
  filledCount,
  GRID_WAVETABLE_ID,
  SELECTION_WAVETABLE_ID,
  PREVIEW_WAVETABLE_ID,
  PREVIEW_BATCH_WAVETABLE_ID,
  LAST_BATCH_WAVETABLE_ID,
  make1D,
  make2D,
  makeRows,
  normalizeWrite,
  previewWrites,
  regionOf,
  resize1D,
  resize2D,
  setHead,
  writeWindowOf,
  setWrite,
  pinnedIds,
  removeTables,
  shapeLabel,
  slotCount,
  TIMELINE_WAVETABLE_ID,
  wavetableDims,
  writeTables,
  type Wavetable,
  type WriteBatch,
  type WriteDir,
  type WriteEdge,
  type WriteMode,
  type WriteSettings,
  type WriteWrap,
} from '../src/core/wavetable';
import { Mix, packWavetable, resolveMix, windowIds } from '../src/core/wavetablePlayback';

const _ = null;
const builtin = (id: number) => builtinWavetables().find((w) => w.id === id)!;
/** Write several batches in turn. */
const writeAll = (wt: Wavetable, ...batches: number[][]) => batches.reduce((w, b) => writeTables(w, b).wt, wt);
const live = (wt: Wavetable, write: Partial<WriteSettings>, head?: { x: number; y: number }): Wavetable => {
  const s = normalizeWrite(wt.shape, wt.fixed, { ...wt.write, ...write });
  return { ...wt, live: true, write: s, head: head ?? wt.head };
};
const mk1 = (ids: (number | null)[], write: Partial<WriteSettings>, head?: { x: number; y: number }, fixed = false) =>
  live(make1D(9, 't', ids, { fixed, write }), {}, head);

describe('wavetable slots', () => {
  it('1D, 2D and Rows shapes', () => {
    const a = make1D(5, 'A', [1, _, 2]);
    expect(a.rows).toEqual([[1, _, 2]]);
    expect([slotCount(a), filledCount(a), shapeLabel(a)]).toEqual([3, 2, '1D · 3']);
    const g = make2D(6, 'G', 3, 2, [1, 2, 3, 4]);
    expect(g.rows).toEqual([
      [1, 2, 3],
      [4, _, _],
    ]);
    expect([cellAt(g, 0, 1), cellAt(g, 2, 1), cellAt(g, 9, 9)]).toEqual([4, _, _]);
    expect(wavetableDims(g)).toEqual({ w: 3, h: 2 });
    expect(shapeLabel(g)).toBe('2D · 3×2');
    const r = makeRows(7, 'R', [[1, 2, 3], [4]]);
    expect(wavetableDims(r)).toEqual({ w: 3, h: 2 });
    expect(shapeLabel(r)).toBe('Rows · 2');
    expect(JSON.parse(JSON.stringify(r))).toEqual(r); // serializable
  });

  it('built-ins: Timeline, Last batch, Batches, Grid, Selection, Preview, Preview batch', () => {
    const b = builtinWavetables();
    expect(b.map((w) => [w.id, w.name, w.shape, w.live, w.pins])).toEqual([
      [TIMELINE_WAVETABLE_ID, 'Timeline', '1d', true, false],
      [LAST_BATCH_WAVETABLE_ID, 'Last batch', '1d', true, true],
      [BATCHES_WAVETABLE_ID, 'Batches', 'rows', true, false],
      [GRID_WAVETABLE_ID, 'Grid', '2d', true, true],
      [SELECTION_WAVETABLE_ID, 'Selection', '1d', false, false],
      [PREVIEW_WAVETABLE_ID, 'Preview', '1d', false, false],
      [PREVIEW_BATCH_WAVETABLE_ID, 'Preview batch', '1d', false, false],
    ]);
    expect(writeTables(b[4], [7]).wt).toBe(b[4]); // adds never write it
    expect(wavetableDims(b[3])).toEqual({ w: 8, h: 8 });
    expect(b.every((w) => w.interp === 'blend' && w.builtin)).toBe(true);
  });

  it('pins only tables of pinning wavetables', () => {
    const [tl, last, batches, grid] = builtinWavetables();
    const w = [writeAll(tl, [1, 2]), writeAll(last, [1, 2]), writeAll(batches, [1, 2]), writeAll(grid, [3])];
    expect([...pinnedIds(w)].sort()).toEqual([1, 2, 3]);
    expect([...pinnedIds([w[0], w[2]])]).toEqual([]);
    expect([...pinnedIds([make1D(5, 'u', [5, 9, 5])])].sort()).toEqual([5, 9]);
  });

  it('clamps windows', () => {
    expect(clampWindow(5, 2, 10)).toEqual([2, 5]);
    expect(clampWindow(-3, 99, 10)).toEqual([0, 9]);
    expect(clampWindow(3, 4, 0)).toEqual([0, 0]);
  });
});

describe('write settings per shape', () => {
  it('coerces invalid combinations', () => {
    const s: WriteSettings = { dir: '+y', edge: 'wrap', onWrap: 'next', mode: 'insert', batch: 'newRow' };
    expect(normalizeWrite('1d', false, s)).toEqual({ dir: '+x', step: { x: 1, y: 0 }, edge: 'grow', onWrap: 'same', mode: 'insert', batch: 'newRow' });
    expect(normalizeWrite('1d', true, { ...s, edge: 'grow' })).toMatchObject({ dir: '+x', edge: 'wrap' });
    expect(normalizeWrite('2d', true, { ...s, edge: 'grow' })).toEqual({ dir: '+y', step: { x: 0, y: 1 }, edge: 'wrap', onWrap: 'next', mode: 'replace', batch: 'newRow' });
    expect(normalizeWrite('rows', false, { ...s, dir: '-y' })).toMatchObject({ dir: '-x', edge: 'wrap', mode: 'insert' });
  });
});

describe('write head: 1D variable', () => {
  it('+x grow appends (Timeline)', () => {
    const t = writeAll(builtin(TIMELINE_WAVETABLE_ID), [1, 2], [3]);
    expect(t.rows).toEqual([[1, 2, 3]]);
    expect(t.head).toEqual({ x: 3, y: 0 });
    expect(writeAll(mk1([], { mode: 'replace', edge: 'grow' }), [1, 2], [3]).rows).toEqual([[1, 2, 3]]);
  });

  it('+x replace + stop overwrites, then drops', () => {
    const t = writeAll(mk1([1, 2, 3], { mode: 'replace', edge: 'stop' }, { x: 1, y: 0 }), [9, 8, 7]);
    expect(t.rows).toEqual([[1, 9, 8]]);
    expect(t.head.x).toBe(3);
    expect(writeTables(t, [5]).wt).toBe(t);
  });

  it('-x replace + grow prepends (and shifts the map)', () => {
    expect(writeAll(mk1([], { dir: '-x', mode: 'replace', edge: 'grow' }), [1, 2, 3]).rows).toEqual([[3, 2, 1]]);
    const e = writeTables(mk1([5], { dir: '-x', mode: 'replace', edge: 'grow' }, { x: -1, y: 0 }), [1]);
    expect(e.wt.rows).toEqual([[1, 5]]);
    expect(e.map).toEqual([1]);
  });

  it('insert in the middle shifts later slots (+x moves on, -x stays)', () => {
    const e = writeTables(mk1([1, 2, 3], { mode: 'insert' }, { x: 1, y: 0 }), [9]);
    expect(e.wt.rows).toEqual([[1, 9, 2, 3]]);
    expect(e.map).toEqual([0, 2, 3]);
    expect(e.wt.head.x).toBe(2);
    const m = writeAll(mk1([5, 6], { dir: '-x', mode: 'insert' }, { x: 0, y: 0 }), [1, 2]);
    expect(m.rows).toEqual([[2, 1, 5, 6]]);
    expect(m.head.x).toBe(0);
  });

  it('new row starts the line afresh (Last batch)', () => {
    const lb = builtin(LAST_BATCH_WAVETABLE_ID);
    const a = writeAll(lb, [1, 2, 3]);
    expect(a.rows).toEqual([[1, 2, 3]]);
    const e = writeTables(a, [4, 5]);
    expect(e.wt.rows).toEqual([[4, 5]]);
    expect(e.reset).toBe(true);
    expect(writeTables(e.wt, [6]).wt.rows).toEqual([[6]]);
  });

  it('a frozen wavetable ignores adds', () => {
    const f = make1D(5, 'f', [1]);
    expect(f.live).toBe(false);
    expect(writeTables(f, [2]).wt).toBe(f);
  });
});

describe('write head: 1D fixed', () => {
  it('+x replace + wrap cycles', () => {
    const t = writeAll(mk1([_, _, _], { mode: 'replace', edge: 'wrap' }, undefined, true), [1, 2, 3, 4]);
    expect(t.rows).toEqual([[4, 2, 3]]);
    expect(t.head.x).toBe(1);
  });

  it('+x replace + stop fills once', () => {
    const t = writeAll(mk1([_, _, _], { mode: 'replace', edge: 'stop' }, undefined, true), [1, 2, 3, 4]);
    expect(t.rows).toEqual([[1, 2, 3]]);
    expect(writeTables(t, [5]).wt).toBe(t);
  });

  it('insert keeps the size (the far end drops out)', () => {
    const e = writeTables(mk1([1, 2, 3], { mode: 'insert', edge: 'wrap' }, { x: 0, y: 0 }, true), [9]);
    expect(e.wt.rows).toEqual([[9, 1, 2]]);
    expect(e.map).toEqual([1, 2, -1]);
  });

  it('-x insert moves the head left (mirror of +x)', () => {
    const t = writeAll(mk1([1, 2, 3], { dir: '-x', mode: 'insert', edge: 'wrap' }, undefined, true), [10, 11, 12]);
    expect(t.rows).toEqual([[12, 11, 10]]);
    expect(t.head.x).toBe(2); // wrapped
    const e = writeTables(mk1([1, 2, 3], { dir: '-x', mode: 'insert', edge: 'stop' }, { x: 1, y: 0 }, true), [9]);
    expect(e.wt.rows).toEqual([[2, 9, 3]]);
    expect(e.map).toEqual([-1, 0, 2]);
    const s = writeAll(mk1([1, 2, 3], { dir: '-x', mode: 'insert', edge: 'stop' }, undefined, true), [10, 11, 12, 13]);
    expect(s.rows).toEqual([[12, 11, 10]]);
  });

  it('-x replace + wrap runs backwards', () => {
    const t = writeAll(mk1([_, _, _], { dir: '-x', mode: 'replace', edge: 'wrap' }, undefined, true), [1, 2, 3, 4]);
    expect(t.rows).toEqual([[3, 2, 4]]);
  });

  it('new row moves the head back to the start', () => {
    const t = writeAll(mk1([1, 2, 3], { mode: 'replace', edge: 'wrap', batch: 'newRow' }, { x: 2, y: 0 }, true), [9]);
    expect(t.rows).toEqual([[9, 2, 3]]);
  });
});

describe('write head: 2D', () => {
  const g = (write: Partial<WriteSettings>) => make2D(9, 'g', 3, 2, [], { write, live: true });
  it('+x wrap next row (Grid): fills in order, wraps and overwrites', () => {
    const t = writeAll(g({ dir: '+x', edge: 'wrap', onWrap: 'next' }), [1, 2, 3, 4, 5, 6, 7]);
    expect(t.rows).toEqual([
      [7, 2, 3],
      [4, 5, 6],
    ]);
    expect(t.head).toEqual({ x: 1, y: 0 });
    let grid = builtin(GRID_WAVETABLE_ID);
    for (let i = 1; i <= 70; i++) grid = writeTables(grid, [i]).wt;
    expect(cellAt(grid, 0, 0)).toBe(65);
    expect(cellAt(grid, 6, 0)).toBe(7);
    expect(grid.head).toEqual({ x: 6, y: 0 });
  });

  it('+x wrap on the same line', () => {
    const t = writeAll(g({ dir: '+x', edge: 'wrap', onWrap: 'same' }), [1, 2, 3, 4]);
    expect(t.rows).toEqual([
      [4, 2, 3],
      [_, _, _],
    ]);
  });

  it('+x stop + same line: one line, then nothing (until a new row)', () => {
    const c = writeAll(g({ dir: '+x', edge: 'stop', onWrap: 'same', batch: 'continue' }), [1, 2, 3, 4], [5]);
    expect(c.rows).toEqual([
      [1, 2, 3],
      [_, _, _],
    ]);
    // New row: each batch fills one line from its start; past the last line nothing is written.
    const n = writeAll(g({ dir: '+x', edge: 'stop', onWrap: 'same', batch: 'newRow' }), [1, 2, 3, 4], [5], [6], [7]);
    expect(n.rows).toEqual([
      [1, 2, 3],
      [5, _, _],
    ]);
  });

  it('stop + next fills the whole grid, then stops (rows and columns)', () => {
    const t = writeAll(g({ dir: '+x', edge: 'stop', onWrap: 'next' }), [1, 2, 3, 4], [5, 6, 7], [8]);
    expect(t.rows).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(writeTables(t, [9]).wt).toBe(t);
    const back = writeAll(g({ dir: '-x', edge: 'stop', onWrap: 'next' }), [1, 2, 3, 4, 5, 6, 7]);
    expect(back.rows).toEqual([
      [3, 2, 1],
      [_, _, _],
    ]); // −x: the previous row is above the first: stops there
    const v = writeAll(g({ dir: '+y', edge: 'stop', onWrap: 'next' }), [1, 2, 3, 4, 5, 6, 7]);
    expect(v.rows).toEqual([
      [1, 3, 5],
      [2, 4, 6],
    ]);
  });

  it('-x wraps to the previous row', () => {
    const t = writeAll(g({ dir: '-x', edge: 'wrap', onWrap: 'next' }), [1, 2, 3, 4]);
    expect(t.rows).toEqual([
      [3, 2, 1],
      [_, _, 4],
    ]);
  });

  it('+y / -y write column-wise', () => {
    const t = writeAll(g({ dir: '+y', edge: 'wrap', onWrap: 'next' }), [1, 2, 3, 4, 5]);
    expect(t.rows).toEqual([
      [1, 3, 5],
      [2, 4, _],
    ]);
    const s = writeAll(g({ dir: '+y', edge: 'wrap', onWrap: 'same' }), [1, 2, 3]);
    expect(s.rows).toEqual([
      [3, _, _],
      [2, _, _],
    ]);
    const u = writeAll(g({ dir: '-y', edge: 'stop' }), [1, 2, 3]);
    expect(u.rows).toEqual([
      [2, _, _],
      [1, _, _],
    ]);
  });

  it('new row moves to the next line start unless already there', () => {
    const t = writeAll(g({ dir: '+x', edge: 'wrap', batch: 'newRow' }), [1], [2, 3], [4]);
    expect(t.rows).toEqual([
      [4, _, _],
      [2, 3, _],
    ]);
    const v = writeAll(g({ dir: '+y', edge: 'wrap', batch: 'newRow' }), [1], [2]);
    expect(v.rows).toEqual([
      [1, 2, _],
      [_, _, _],
    ]);
  });
});

describe('write head: Rows', () => {
  it('new row per batch (Batches)', () => {
    const b = writeAll(builtin(BATCHES_WAVETABLE_ID), [1, 2], [3], [4, 5, 6]);
    expect(b.rows).toEqual([[1, 2], [3], [4, 5, 6]]);
    expect(b.head).toEqual({ x: 3, y: 2 });
  });

  it('continue + grow extends the current row', () => {
    const r = live(makeRows(9, 'r', [[1, 2]]), { edge: 'grow', mode: 'replace', batch: 'continue' }, { x: 2, y: 0 });
    expect(writeAll(r, [3], [4]).rows).toEqual([[1, 2, 3, 4]]);
  });

  it('replace + wrap cycles through the existing rows', () => {
    const r = live(makeRows(9, 'r', [[1, 2], [3]]), { edge: 'wrap', onWrap: 'next', mode: 'replace', batch: 'continue' }, { x: 0, y: 0 });
    expect(writeAll(r, [7, 8, 9, 10]).rows).toEqual([[10, 8], [9]]);
    const same = live(makeRows(9, 'r', [[1, 2], [3]]), { edge: 'wrap', onWrap: 'same', mode: 'replace', batch: 'continue' }, { x: 0, y: 0 });
    expect(writeAll(same, [7, 8, 9]).rows).toEqual([[9, 8], [3]]);
  });

  it('replace + wrap / stop + new row grows the new row (coerced; never writes nothing)', () => {
    for (const edge of ['wrap', 'stop'] as const) {
      const r = makeRows(9, 'r', [[1, 2]], { write: { edge, mode: 'replace', batch: 'newRow' }, live: true });
      expect(r.write.edge).toBe('grow');
      expect(writeAll(r, [3, 4], [5]).rows).toEqual([[1, 2], [3, 4], [5]]);
    }
    // Replace without growth (continue) starts on the first existing row.
    const c = makeRows(9, 'r', [[1, 2], [3]], { write: { edge: 'wrap', mode: 'replace', batch: 'continue' }, live: true });
    expect(writeAll(c, [7, 8, 9]).rows).toEqual([[7, 8], [9]]);
  });

  it('stop + next moves on to the next existing row', () => {
    const r = makeRows(9, 'r', [[1, 2], [3]], { write: { edge: 'stop', onWrap: 'next', mode: 'replace', batch: 'continue' }, live: true });
    const t = writeAll(r, [7, 8, 9, 10]);
    expect(t.rows).toEqual([[7, 8], [9]]);
    expect(writeTables(t, [11]).wt).toBe(t);
  });

  it('stop ends the row; a new row resumes', () => {
    const r = live(makeRows(9, 'r', [[1, 2]]), { edge: 'stop', mode: 'replace', batch: 'continue' }, { x: 0, y: 0 });
    expect(writeAll(r, [7, 8, 9]).rows).toEqual([[7, 8]]);
    const n = live(makeRows(9, 'r', []), { edge: 'stop', mode: 'insert', batch: 'newRow' });
    expect(writeAll(n, [1, 2], [3]).rows).toEqual([[1, 2], [3]]);
  });

  it('-x grows rows to the left; insert splices', () => {
    const r = live(makeRows(9, 'r', []), { dir: '-x', edge: 'grow', mode: 'replace', batch: 'newRow' });
    expect(writeAll(r, [1, 2], [3]).rows).toEqual([[2, 1], [3]]);
    const i = live(makeRows(9, 'r', [[1, 2]]), { mode: 'insert', batch: 'continue' }, { x: 1, y: 0 });
    expect(writeAll(i, [9]).rows).toEqual([[1, 9, 2]]);
  });
});

describe('write head: every setting combination', () => {
  const dirs: WriteDir[] = ['+x', '-x', '+y', '-y'];
  const edges: WriteEdge[] = ['wrap', 'stop', 'grow'];
  const wraps: WriteWrap[] = ['next', 'same'];
  const modes: WriteMode[] = ['replace', 'insert'];
  const batches: WriteBatch[] = ['continue', 'newRow'];
  type Make = (write: WriteSettings) => Wavetable;
  const shapes: [string, Make][] = [
    ['1d variable', (write) => make1D(9, 'a', [1, 2, 3], { write, live: true })],
    ['1d fixed', (write) => make1D(9, 'a', [1, _, 3], { fixed: true, write, live: true })],
    ['2d', (write) => make2D(9, 'g', 3, 2, [1, 2], { write, live: true })],
    ['rows', (write) => makeRows(9, 'r', [[1, 2], [3]], { write, live: true })],
  ];
  for (const [name, base] of shapes) {
    it(`${name}: invariants hold for all ${dirs.length * edges.length * wraps.length * modes.length * batches.length} combinations`, () => {
      for (const dir of dirs)
        for (const edge of edges)
          for (const onWrap of wraps)
            for (const mode of modes)
              for (const batch of batches) {
                const w0 = base({ dir, edge, onWrap, mode, batch });
                const s = w0.write;
                let wt = w0;
                const label = `${name} ${JSON.stringify(s)}`;
                let next = 100;
                for (let b = 0; b < 6; b++) {
                  const ids = Array.from({ length: 1 + (b % 3) }, () => next++);
                  const before = wt;
                  const e = writeTables(wt, ids);
                  wt = e.wt;
                  // Fixed shapes keep their size; the 2D grid stays rectangular.
                  if (w0.fixed) expect(wt.rows.map((r) => r.length), label).toEqual(w0.rows.map((r) => r.length));
                  // Every slot holds a known id or null.
                  for (const r of wt.rows) for (const id of r) expect(id === null || id < next, label).toBe(true);
                  // Writes that land are visible; wrap never drops a write.
                  const present = ids.filter((id) => wt.rows.some((r) => r.includes(id)));
                  if (s.edge === 'wrap' && (w0.shape !== 'rows' || s.mode === 'insert') && w0.shape !== '1d')
                    expect(present.length, label).toBeGreaterThan(0);
                  if (s.edge === 'grow' || (s.mode === 'insert' && !w0.fixed)) expect(present.length, label).toBe(ids.length);
                  // The map relates old indices to the same ids.
                  if (e.map && !e.reset && before.shape === '1d') {
                    e.map.forEach((k, i) => {
                      if (k >= 0) expect(wt.rows[0][k], label).toBe(before.rows[0][i]);
                    });
                  }
                }
              }
    });
  }
});

describe('eviction from wavetables', () => {
  it('1D closes up and moves the head', () => {
    const t = writeAll(builtin(TIMELINE_WAVETABLE_ID), [1, 2, 3, 4]);
    const e = removeTables(t, new Set([1, 3]));
    expect(e.wt.rows).toEqual([[2, 4]]);
    expect(e.map).toEqual([-1, 0, -1, 1]);
    expect(e.wt.head.x).toBe(2);
    expect(removeTables(t, new Set([99])).wt).toBe(t);
  });

  it('Rows drop entries and empty rows', () => {
    const b = writeAll(builtin(BATCHES_WAVETABLE_ID), [1, 2], [3, 4], [5]);
    const e = removeTables(b, new Set([1, 2, 3]));
    expect(e.wt.rows).toEqual([[4], [5]]);
    expect(e.map).toEqual([-1, 0, 1]);
    expect(e.wt.head.y).toBe(1);
    expect(writeTables(e.wt, [6]).wt.rows).toEqual([[4], [5], [6]]);
  });

  it('fixed shapes keep the slot, emptied', () => {
    const g = writeAll(builtin(GRID_WAVETABLE_ID), [1, 2, 3]);
    expect(removeTables(g, new Set([2])).wt.rows[0].slice(0, 3)).toEqual([1, _, 3]);
  });

  it('maps compose', () => {
    expect(composeMaps([1, -1, 2], [-1, 0, 1])).toEqual([0, -1, 1]);
    expect(composeMaps(null, [1])).toEqual([1]);
    expect(composeMaps([0], null)).toEqual([0]);
  });
});

describe('window following', () => {
  const v = (id: number, wavetableId: number, s: number, e: number, sy = 0, ey = 0): VoiceParams => ({
    ...DEFAULT_VOICE,
    id,
    name: `V${id}`,
    wavetableId,
    windowStart: s,
    windowEnd: e,
    windowStartY: sy,
    windowEndY: ey,
  });
  const win = (x: VoiceParams) => [x.windowStart, x.windowEnd, x.windowStartY, x.windowEndY];

  it('a window ending at the end of a growing 1D extends; others stay', () => {
    const t = writeAll(builtin(TIMELINE_WAVETABLE_ID), [1, 2, 3, 4, 5]);
    const out = followEdit([v(1, 0, 0, 4), v(2, 0, 0, 2), v(3, 7, 0, 0)], t, writeTables(t, [6, 7]));
    expect(win(out[0])).toEqual([0, 6, 0, 0]);
    expect(win(out[1])).toEqual([0, 2, 0, 0]);
    expect(out[2]).toBe(out[2]);
  });

  it('eviction shifts windows to keep pointing at the same tables', () => {
    const t = writeAll(builtin(TIMELINE_WAVETABLE_ID), [1, 2, 3, 4]);
    const out = followEdit([v(1, 0, 1, 2), v(2, 0, 0, 3)], t, removeTables(t, new Set([1])));
    expect(win(out[0])).toEqual([0, 1, 0, 0]);
    expect(win(out[1])).toEqual([0, 2, 0, 0]);
  });

  it('Last batch: indices kept (clamped) and the end follows', () => {
    const lb = writeAll(builtin(LAST_BATCH_WAVETABLE_ID), [1, 2, 3, 4, 5, 6, 7, 8]);
    const one = writeTables(lb, [9]);
    const [full, part] = followEdit([v(1, 1, 0, 7), v(2, 1, 2, 5)], lb, one);
    expect(win(full)).toEqual([0, 0, 0, 0]);
    expect(win(part)).toEqual([0, 0, 0, 0]);
    const eight = writeTables(one.wt, [10, 11, 12, 13, 14, 15, 16, 17]);
    expect(win(followEdit([full], one.wt, eight)[0])).toEqual([0, 7, 0, 0]);
    const lb2 = writeTables(eight.wt, [20, 21, 22, 23, 24, 25, 26, 27]);
    expect(win(followEdit([v(2, 1, 2, 5)], eight.wt, lb2)[0])).toEqual([2, 5, 0, 0]);
  });

  it('Rows follow on the row axis; 2D windows stay', () => {
    const b = writeAll(builtin(BATCHES_WAVETABLE_ID), [1, 2], [3]);
    const out = followEdit([v(1, 2, 0, 0, 0, 1), v(2, 2, 0, 0, 0, 0)], b, writeTables(b, [4]));
    expect(win(out[0])).toEqual([0, 0, 0, 2]);
    expect(win(out[1])).toEqual([0, 0, 0, 0]);
    const ev = removeTables(writeTables(b, [4]).wt, new Set([1, 2]));
    expect(win(followEdit([v(1, 2, 0, 0, 1, 2)], writeTables(b, [4]).wt, ev)[0])).toEqual([0, 0, 0, 1]);
    const g = builtin(GRID_WAVETABLE_ID);
    const gv = v(3, 3, 2, 4, 1, 3);
    expect(followEdit([gv], g, writeTables(g, [1]))[0]).toBe(gv);
  });

  it('remapWindowByMap widens over insertions', () => {
    expect(remapWindowByMap(1, 3, [0, 1, 3, 4], 4, 5)).toEqual([1, 4]);
    expect(remapWindowByMap(1, 2, [0, -1, -1, 1], 4, 2)).toEqual([1, 1]);
  });
});

describe('playback mapping', () => {
  const mix = new Mix();
  const res = (wt: Wavetable, w: [number, number, number, number], px: number, py: number, step = false) => {
    resolveMix(packWavetable(wt), { x0: w[0], x1: w[1], y0: w[2], y1: w[3] }, px, py, step, mix);
    const out: Record<number, number> = {};
    for (let k = 0; k < mix.n; k++) out[mix.ids[k]] = Math.round(mix.w[k] * 1e9) / 1e9;
    return out;
  };

  it('1D Blend crossfades neighbours; Step picks the nearest', () => {
    const t = make1D(1, 't', [10, 11, 12, 13]);
    expect(res(t, [0, 3, 0, 0], 0.5, 0)).toEqual({ 11: 0.5, 12: 0.5 });
    expect(res(t, [1, 3, 0, 0], 0.25, 0)).toEqual({ 11: 0.5, 12: 0.5 });
    expect(res(t, [0, 3, 0, 0], 1, 0)).toEqual({ 13: 1 });
    expect(res(t, [0, 3, 0, 0], 0.4, 0, true)).toEqual({ 11: 1 });
    expect(mix.x).toBe(1);
  });

  it('empty slots are skipped (never silence)', () => {
    const t = make1D(1, 't', [10, _, _, 13]);
    expect(res(t, [0, 3, 0, 0], 0.5, 0)).toEqual({ 10: 0.5, 13: 0.5 });
    expect(res(t, [0, 3, 0, 0], 0.2, 0)).toEqual({ 10: 0.8, 13: 0.2 });
    expect(res(t, [0, 3, 0, 0], 0.3, 0, true)).toEqual({ 10: 1 });
    expect(res(t, [0, 3, 0, 0], 0.6, 0, true)).toEqual({ 13: 1 });
    // A window of only empty slots plays the nearest filled one outside it.
    expect(res(t, [1, 2, 0, 0], 0, 0)).toEqual({ 10: 1 });
    expect(res(t, [1, 2, 0, 0], 1, 0, true)).toEqual({ 13: 1 });
    expect(res(make1D(1, 'e', [_, _]), [0, 1, 0, 0], 0.5, 0)).toEqual({});
  });

  it('2D Blend is bilinear over 4 cells', () => {
    const g = make2D(1, 'g', 3, 3, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(res(g, [0, 2, 0, 2], 0.1, 0.6)).toEqual({ 4: 0.64, 5: 0.16, 7: 0.16, 8: 0.04 });
    expect(mix.x).toBeCloseTo(0.2);
    expect(mix.y).toBeCloseTo(1.2);
    expect(res(g, [1, 2, 1, 2], 0, 0)).toEqual({ 5: 1 });
    expect(res(g, [0, 2, 0, 2], 0.6, 0.4, true)).toEqual({ 5: 1 });
    expect([mix.x, mix.y]).toEqual([1, 1]);
  });

  it('2D skips empty cells and rows', () => {
    const g = make2D(1, 'g', 2, 3, [1, 2, _, _, 5, 6]);
    expect(res(g, [0, 1, 0, 2], 0, 0.5)).toEqual({ 1: 0.5, 5: 0.5 });
    expect(res(g, [0, 1, 1, 1], 1, 0)).toEqual({ 2: 1 });
  });

  it('Rows align positions proportionally across rows', () => {
    const r = makeRows(1, 'r', [
      [1, 2, 3, 4, 5],
      [6, 7, 8],
    ]);
    // u = 0.5: slot 2 of row 0, slot 1 of row 1; 30% of the way to row 1.
    expect(res(r, [0, 0, 0, 1], 0.5, 0.3)).toEqual({ 3: 0.7, 7: 0.3 });
    expect(res(r, [0, 0, 1, 1], 1, 0)).toEqual({ 8: 1 });
    expect(res(r, [0, 0, 0, 1], 0.75, 0, false)).toEqual({ 4: 1 });
    expect(res(r, [0, 0, 0, 1], 0.4, 0.8, true)).toEqual({ 7: 1 });
  });

  it('weights are identical after a re-index (eviction + remapped window)', () => {
    const a = make1D(1, 't', [10, 11, 12, 13, 14]);
    const b = make1D(1, 't', [11, 12, 13, 14]);
    for (const p of [0.1, 0.37, 0.5, 0.93]) {
      const ra = res(a, [1, 4, 0, 0], p, 0);
      const wa = Array.from(mix.w.slice(0, mix.n));
      const rb = res(b, [0, 3, 0, 0], p, 0);
      expect(rb).toEqual(ra);
      expect(Array.from(mix.w.slice(0, mix.n))).toEqual(wa);
    }
  });

  it('windowIds lists the tables a voice window covers', () => {
    const g = make2D(1, 'g', 3, 2, [1, 2, 3, 4, 5, 6]);
    expect(windowIds(g, { x0: 1, x1: 2, y0: 0, y1: 1 })).toEqual([2, 3, 5, 6]);
    expect(windowIds(make1D(1, 't', [1, 2, 2, 3]), { x0: 1, x1: 3, y0: 5, y1: 5 })).toEqual([2, 3]);
    expect(windowIds(makeRows(1, 'r', [[1], [2, 3], [4]]), { x0: 9, x1: 9, y0: 1, y1: 2 })).toEqual([2, 3, 4]);
  });
});

describe('write head: free steps (fixed shapes, Replace)', () => {
  const grid = (w: number, h: number, write: Partial<WriteSettings>, head = { x: 0, y: 0 }) =>
    ({ ...make2D(50, 'g', w, h, [], { write: { edge: 'wrap', onWrap: 'next', mode: 'replace', batch: 'continue', ...write } }), live: true, head }) as Wavetable;
  const cells = (wt: Wavetable) => wt.rows.map((r) => r.map((v) => (v === null ? '.' : String(v))).join('')).join('/');

  it('normalizes steps: clamped, 1D x only, not both 0; variable lines and inserts keep the unit step', () => {
    const base: WriteSettings = { dir: '+x', edge: 'wrap', onWrap: 'next', mode: 'replace', batch: 'continue' };
    expect(normalizeWrite('2d', true, { ...base, step: { x: 20, y: -3 } }).step).toEqual({ x: 8, y: -3 });
    expect(normalizeWrite('2d', true, { ...base, step: { x: 1, y: -3 } }).dir).toBe('-y');
    expect(normalizeWrite('1d', true, { ...base, step: { x: -3, y: 2 } }).step).toEqual({ x: -3, y: 0 });
    expect(normalizeWrite('2d', true, { ...base, step: { x: 0, y: 0 } }).step).toEqual({ x: 1, y: 0 });
    expect(normalizeWrite('1d', false, { ...base, edge: 'grow', step: { x: 3, y: 0 } }).step).toEqual({ x: 1, y: 0 });
    expect(normalizeWrite('1d', true, { ...base, mode: 'insert', step: { x: 3, y: 0 } }).step).toEqual({ x: 1, y: 0 });
    expect(normalizeWrite('rows', false, { ...base, step: { x: 2, y: 0 } }).step).toEqual({ x: 1, y: 0 });
    // A new direction without a step resets the step to the unit one.
    const g = setWrite(grid(4, 2, { step: { x: 2, y: 0 } }), { dir: '-x' });
    expect(g.write.step).toEqual({ x: -1, y: 0 });
  });

  it('a step of 2 fills every other slot, wrapping by its rhythm onto the next row', () => {
    const t = writeAll(grid(4, 2, { step: { x: 2, y: 0 } }), [1, 2, 3, 4]);
    expect(cells(t)).toBe('1.2./3.4.');
    expect(t.head).toEqual({ x: 0, y: 0 }); // wrapped round to the start
    // Odd step in an odd width visits every slot once before repeating.
    const odd = writeAll({ ...make1D(51, 'l', [null, null, null, null, null], { fixed: true, write: { mode: 'replace', edge: 'wrap' } }), live: true, write: normalizeWrite('1d', true, { dir: '+x', step: { x: 3, y: 0 }, edge: 'wrap', onWrap: 'same', mode: 'replace', batch: 'continue' }) } as Wavetable, [1, 2, 3, 4, 5]);
    expect(odd.rows[0]).toEqual([1, 3, 5, 2, 4]);
  });

  it('a diagonal wraps each axis on its own; Stop stops when it leaves; New row restarts at the corner', () => {
    const t = writeAll(grid(3, 3, { step: { x: 1, y: 1 } }), [1, 2, 3, 4]);
    expect(cells(t)).toBe('4../.2./..3'); // back at the start on a 3×3 torus
    const knight = writeAll(grid(4, 4, { step: { x: 1, y: 2 } }), [1, 2, 3, 4]);
    expect(cells(knight)).toBe('1.3./..../.2.4/....');
    const st = writeAll(grid(3, 3, { step: { x: 1, y: 1 }, edge: 'stop' }), [1, 2, 3, 4]);
    expect(cells(st)).toBe('1../.2./..3');
    expect(writeTables(st, [9]).wt).toBe(st);
    const nr = writeAll(grid(3, 3, { step: { x: 1, y: 1 }, batch: 'newRow' }, { x: 2, y: 0 }), [1], [2]);
    expect(cells(nr)).toBe('2../.../...');
    expect(nr.head).toEqual({ x: 1, y: 1 });
    // A step towards −x −y starts at the far corner.
    const back = { ...make2D(52, 'b', 3, 2, [], { write: { step: { x: -1, y: -1 } } }), live: true } as Wavetable;
    expect(back.head).toEqual({ x: 2, y: 1 });
    expect(writeAll(back, [1, 2]).rows).toEqual([[_, 2, _], [_, _, 1]]);
    const back1 = make1D(53, 'b', [_, _, _], { fixed: true, write: { mode: 'replace', step: { x: -2, y: 0 } } });
    expect(back1.head).toEqual({ x: 2, y: 0 });
    // Changing the step keeps a head that is still valid.
    expect(setWrite(grid(3, 2, {}, { x: 1, y: 1 }), { step: { x: -1, y: -1 } }).head).toEqual({ x: 1, y: 1 });
  });

  it('previews match what is written, and the step survives a session round trip', () => {
    const g = grid(5, 3, { step: { x: 2, y: 1 } });
    const p = previewWrites(g, 6).writes.map((w) => [w.x, w.y]);
    const done = writeAll(g, [1, 2, 3, 4, 5, 6]);
    const where = [1, 2, 3, 4, 5, 6].map((id) => {
      const y = done.rows.findIndex((r) => r.includes(id));
      return [done.rows[y].indexOf(id), y];
    });
    expect(p).toEqual(where);
  });
});

describe('write head: write window (fixed shapes, Replace)', () => {
  const grid = (w: number, h: number, write: Partial<WriteSettings>) =>
    ({ ...make2D(60, 'g', w, h, [], { write: { edge: 'wrap', onWrap: 'next', mode: 'replace', batch: 'continue', ...write } }), live: true }) as Wavetable;
  const cells = (wt: Wavetable) => wt.rows.map((r) => r.map((v) => (v === null ? '.' : String(v))).join('')).join('/');
  const win = { x0: 1, y0: 1, x1: 2, y1: 2 };

  it('is normalized: ordered whole cells, 1D y 0, only on free-stepping shapes', () => {
    const base: WriteSettings = { dir: '+x', edge: 'wrap', onWrap: 'next', mode: 'replace', batch: 'continue' };
    expect(normalizeWrite('2d', true, { ...base, window: { x0: 3.2, y0: 2, x1: 1, y1: -4 } }).window).toEqual({ x0: 1, y0: 0, x1: 3, y1: 2 });
    expect(normalizeWrite('1d', true, { ...base, window: { x0: 2, y0: 3, x1: 4, y1: 5 } }).window).toEqual({ x0: 2, y0: 0, x1: 4, y1: 0 });
    expect(normalizeWrite('1d', true, { ...base, mode: 'insert', window: win }).window).toBeUndefined();
    expect(normalizeWrite('1d', false, { ...base, edge: 'grow', window: win }).window).toBeUndefined();
    expect(normalizeWrite('rows', false, { ...base, window: win }).window).toBeUndefined();
    expect(normalizeWrite('2d', true, { ...base, window: null }).window).toBeUndefined();
  });

  it('confines writes: wrap and carry inside the window, the head starting at its corner', () => {
    const g = setWrite(grid(4, 4, {}), { window: win });
    expect(g.head).toEqual({ x: 1, y: 1 }); // the old head (0, 0) can't write: restarted at the corner
    expect(writeWindowOf(g)).toEqual(win);
    const t = writeAll(g, [1, 2, 3, 4, 5]);
    expect(cells(t)).toBe('..../.52./.34./....');
    // A −x step starts at the window's right edge; a step of 2 in a 3-wide window keeps its rhythm.
    const back = setWrite(grid(5, 3, {}), { window: { x0: 1, y0: 0, x1: 3, y1: 1 }, step: { x: -2, y: 0 }, onWrap: 'same' });
    expect(back.head).toEqual({ x: 3, y: 0 });
    expect(writeAll(back, [1, 2, 3]).rows[0]).toEqual([_, 2, 3, 1, _]);
  });

  it('Stop and New row work on the window', () => {
    const st = setWrite(grid(4, 3, { edge: 'stop', onWrap: 'same' }), { window: { x0: 1, y0: 0, x1: 2, y1: 2 } });
    const t = writeAll(st, [1, 2, 3]);
    expect(cells(t)).toBe('.12./..../....');
    const nr = setWrite(grid(4, 3, { batch: 'newRow' }), { window: { x0: 1, y0: 1, x1: 3, y1: 2 } });
    const t2 = writeAll(nr, [1], [2], [3]);
    expect(cells(t2)).toBe('..../.3../.2..'); // the third new row wraps to the window's first line
  });

  it('the head is clamped into the window; resizing clamps the window', () => {
    const g = setWrite(grid(5, 5, {}), { window: { x0: 1, y0: 1, x1: 3, y1: 2 } });
    expect(setHead(g, 0, 4).head).toEqual({ x: 1, y: 2 });
    const small = resize2D(g, 3, 2).wt;
    expect(small.write.window).toEqual({ x0: 1, y0: 1, x1: 2, y1: 1 });
    expect(writeAll(small, [1, 2, 3]).rows).toEqual([[_, _, _], [_, 3, 2]]);
    // A 1D line shrunk past the window: it moves in to the last slot.
    const line = { ...make1D(61, 'l', [_, _, _, _, _, _], { fixed: true, write: { mode: 'replace', edge: 'wrap', window: { x0: 4, y0: 0, x1: 5, y1: 0 } } }), live: true } as Wavetable;
    expect(line.head).toEqual({ x: 4, y: 0 });
    const cut = resize1D(line, true, 3).wt;
    expect(cut.write.window).toEqual({ x0: 2, y0: 0, x1: 2, y1: 0 });
    expect(writeAll(cut, [7, 8]).rows[0]).toEqual([_, _, 8]);
    // Back to the whole wavetable.
    expect(setWrite(g, { window: null }).write.window).toBeUndefined();
    expect(regionOf(g.rows, { ...g.write, window: null })).toEqual({ x0: 0, y0: 0, x1: 4, y1: 4 });
  });

  it('previews match what is written inside a window', () => {
    const g = setWrite(grid(6, 4, { step: { x: 1, y: 1 } }), { window: { x0: 1, y0: 1, x1: 4, y1: 2 } });
    const p = previewWrites(g, 6).writes.map((w) => [w.x, w.y]);
    expect(p).toEqual([[1, 1], [2, 2], [3, 1], [4, 2], [1, 1], [2, 2]]);
  });
});
