import { describe, expect, it } from 'vitest';
import { AppModel } from '../src/app/model';
import { generateBasic } from '../src/core/generators';
import { DEFAULT_VOICE, followEdit, type VoiceParams } from '../src/core/voice';
import {
  builtinWavetables,
  canTarget,
  clearSlot,
  droppedBy1DResize,
  droppedBy2DResize,
  duplicateWavetable,
  FIRST_USER_WAVETABLE_ID,
  GRID_WAVETABLE_ID,
  LAST_BATCH_WAVETABLE_ID,
  make1D,
  make2D,
  makeRows,
  MAX_SLOTS,
  moveSlot,
  newWavetable,
  pinnedIds,
  placeTable,
  previewWrites,
  removeSlot,
  resize1D,
  resize2D,
  setHead,
  setWrite,
  TIMELINE_WAVETABLE_ID,
  writeTables,
  type Wavetable,
} from '../src/core/wavetable';

const _ = null;
const slot = (x: number, y = 0) => ({ kind: 'slot', x, y }) as const;
const gap = (x: number, y = 0) => ({ kind: 'gap', x, y }) as const;
const row = (y: number) => ({ kind: 'row', y }) as const;
const voice = (wt: Wavetable, s: number, e: number): VoiceParams => ({ ...DEFAULT_VOICE, id: 1, name: 'V1', wavetableId: wt.id, windowStart: s, windowEnd: e });

describe('new / duplicate', () => {
  it('new wavetables: empty, frozen, pinning, sensible write heads', () => {
    const a = newWavetable(16, 'A', '1d');
    expect([a.rows, a.fixed, a.live, a.pins, a.builtin, a.write.edge, a.head]).toEqual([[[]], false, false, true, undefined, 'grow', { x: 0, y: 0 }]);
    const g = newWavetable(17, 'G', '2d');
    expect([g.rows.length, g.rows[0].length, g.fixed, g.write.mode, g.write.edge]).toEqual([8, 8, true, 'replace', 'wrap']);
    expect(newWavetable(17, 'G', '2d', 3, 99).rows.map((r) => r.length)).toEqual(new Array(64).fill(3));
    const r = newWavetable(18, 'R', 'rows');
    expect([r.rows, r.write.batch, r.head]).toEqual([[], 'newRow', { x: 0, y: 0 }]);
    for (const w of [a, g, r]) expect(JSON.parse(JSON.stringify(w))).toEqual(w);
  });

  it('a duplicate is an editable, frozen, pinning copy (built-ins too)', () => {
    const grid = { ...builtinWavetables()[GRID_WAVETABLE_ID], rows: make2D(0, '', 8, 8, [1, 2, 3]).rows, head: { x: 3, y: 0 } };
    const d = duplicateWavetable(grid, 20, 'Grid copy');
    expect([d.id, d.name, d.builtin, d.live, d.pins, d.shape, d.head]).toEqual([20, 'Grid copy', undefined, false, true, '2d', { x: 3, y: 0 }]);
    expect(d.rows).toEqual(grid.rows);
    expect(d.rows[0]).not.toBe(grid.rows[0]);
    // The Timeline mirror doesn't pin; its copy does.
    const tl = { ...builtinWavetables()[TIMELINE_WAVETABLE_ID], rows: [[1, 2, 3]] };
    expect([...pinnedIds([tl])]).toEqual([]);
    expect([...pinnedIds([duplicateWavetable(tl, 21, 'T')])]).toEqual([1, 2, 3]);
    // Over MAX_SLOTS: the newest slots are kept.
    const big = make1D(5, 'B', Array.from({ length: MAX_SLOTS + 3 }, (_, i) => i + 1));
    const bd = duplicateWavetable(big, 22, 'B2');
    expect([bd.rows[0].length, bd.rows[0][0]]).toEqual([MAX_SLOTS, 4]);
  });
});

describe('drag edits per shape', () => {
  it('1D variable: replace, insert, append, move, clear, remove', () => {
    const a = make1D(16, 'A', [1, 2, 3]);
    expect(placeTable(a, slot(1), 9).wt.rows[0]).toEqual([1, 9, 3]);
    const ins = placeTable(a, gap(1), 9);
    expect(ins.wt.rows[0]).toEqual([1, 9, 2, 3]);
    expect(ins.map).toEqual([0, 2, 3]);
    expect(placeTable(a, gap(3), 9).wt.rows[0]).toEqual([1, 2, 3, 9]);
    expect(placeTable(a, gap(3), 9).map).toBeNull(); // appended: indices unchanged
    expect(moveSlot(a, { x: 0, y: 0 }, gap(3)).wt.rows[0]).toEqual([2, 3, 1]);
    expect(moveSlot(a, { x: 2, y: 0 }, gap(0)).wt.rows[0]).toEqual([3, 1, 2]);
    expect(moveSlot(a, { x: 0, y: 0 }, slot(2)).wt.rows[0]).toEqual([3, 2, 1]); // swap
    expect(moveSlot(a, { x: 0, y: 0 }, gap(1)).wt).toBe(a); // no-op
    expect(moveSlot(a, { x: 0, y: 0 }, gap(3), true).wt.rows[0]).toEqual([1, 2, 3, 1]); // copy
    expect(clearSlot(a, 1, 0).wt.rows[0]).toEqual([1, _, 3]);
    const rm = removeSlot(a, 1, 0);
    expect([rm.wt.rows[0], rm.map]).toEqual([[1, 3], [0, -1, 1]]);
  });

  it('1D fixed: insert shifts into the next empty slot (else drops the last); remove keeps the size', () => {
    const f = make1D(16, 'F', [1, 2, _, 4], { fixed: true });
    expect(placeTable(f, gap(0), 9).wt.rows[0]).toEqual([9, 1, 2, 4]);
    expect(placeTable(f, gap(3), 9).wt.rows[0]).toEqual([1, 2, _, 9]); // no empty after: 4 drops out
    expect(canTarget(f, gap(4))).toBe(false); // no appending to a fixed line
    expect(removeSlot(f, 0, 0).wt.rows[0]).toEqual([2, _, 4, _]);
    expect(moveSlot(f, { x: 0, y: 0 }, gap(4)).wt.rows[0]).toEqual([1, 2, _, 4]); // gap 4 isn't a target
    expect(moveSlot(f, { x: 0, y: 0 }, gap(3)).wt.rows[0]).toEqual([2, _, 1, 4]);
  });

  it('2D: replace / swap only; remove empties the cell', () => {
    const g = make2D(16, 'G', 2, 2, [1, 2, 3]);
    expect(placeTable(g, slot(1, 1), 9).wt.rows).toEqual([
      [1, 2],
      [3, 9],
    ]);
    expect(placeTable(g, gap(1, 0), 9).wt).toBe(g);
    expect(canTarget(g, gap(0, 0))).toBe(false);
    expect(moveSlot(g, { x: 0, y: 0 }, slot(1, 1)).wt.rows).toEqual([
      [_, 2],
      [3, 1],
    ]);
    expect(removeSlot(g, 0, 1).wt.rows).toEqual([
      [1, 2],
      [_, _],
    ]);
  });

  it('Rows: insert into a row, new rows, moves between rows drop emptied rows', () => {
    const r = makeRows(16, 'R', [[1, 2], [3]]);
    expect(placeTable(r, gap(1, 0), 9).wt.rows).toEqual([[1, 9, 2], [3]]);
    expect(placeTable(r, gap(1, 1), 9).wt.rows).toEqual([[1, 2], [3, 9]]);
    const nr = placeTable(r, row(1), 9);
    expect([nr.wt.rows, nr.map]).toEqual([[[1, 2], [9], [3]], [0, 2]]);
    expect(placeTable(r, row(2), 9).wt.rows).toEqual([[1, 2], [3], [9]]);
    const mv = moveSlot(r, { x: 0, y: 1 }, gap(0, 0));
    expect([mv.wt.rows, mv.map]).toEqual([[[3, 1, 2]], [0, -1]]);
    expect(moveSlot(r, { x: 1, y: 0 }, row(0)).wt.rows).toEqual([[2], [1], [3]]);
    expect(moveSlot(r, { x: 0, y: 1 }, row(0)).wt.rows).toEqual([[3], [1, 2]]);
    expect(moveSlot(r, { x: 0, y: 1 }, row(2)).wt).toBe(r); // already its own row
    expect(removeSlot(r, 0, 1).wt.rows).toEqual([[1, 2]]);
    // An empty Rows wavetable takes a first row.
    expect(placeTable(newWavetable(17, 'E', 'rows'), row(0), 5).wt.rows).toEqual([[5]]);
  });

  it('built-ins are read-only', () => {
    const lb = { ...builtinWavetables()[LAST_BATCH_WAVETABLE_ID], rows: [[1, 2]] };
    expect(placeTable(lb, slot(0), 9).wt).toBe(lb);
    expect(clearSlot(lb, 0, 0).wt).toBe(lb);
    expect(removeSlot(lb, 0, 0).wt).toBe(lb);
    expect(moveSlot(lb, { x: 0, y: 0 }, slot(1)).wt).toBe(lb);
  });

  it('the write head stays on its slot through edits', () => {
    const a = { ...make1D(16, 'A', [1, 2, 3]), head: { x: 2, y: 0 } };
    expect(placeTable(a, gap(0), 9).wt.head).toEqual({ x: 3, y: 0 });
    expect(removeSlot(a, 0, 0).wt.head).toEqual({ x: 1, y: 0 });
    expect(placeTable(a, gap(3), 9).wt.head).toEqual({ x: 2, y: 0 });
    const r = { ...makeRows(16, 'R', [[1], [2]]), head: { x: 0, y: 1 } };
    expect(placeTable(r, row(0), 9).wt.head).toEqual({ x: 0, y: 2 });
    expect(removeSlot(r, 0, 0).wt.head).toEqual({ x: 0, y: 0 });
  });

  it('voice windows keep their waveforms through inserts / removals', () => {
    const a = make1D(16, 'A', [1, 2, 3, 4]);
    const v = voice(a, 1, 2);
    const e = placeTable(a, gap(0), 9);
    expect(followEdit([v], a, e).map((x) => [x.windowStart, x.windowEnd])).toEqual([[2, 3]]);
    const e2 = removeSlot(a, 0, 0);
    expect(followEdit([v], a, e2).map((x) => [x.windowStart, x.windowEnd])).toEqual([[0, 1]]);
  });

  it('growth stops at MAX_SLOTS', () => {
    const big = make1D(16, 'B', new Array(MAX_SLOTS).fill(1));
    expect(canTarget(big, gap(0))).toBe(false);
    expect(canTarget(big, slot(0))).toBe(true);
    expect(canTarget(big, gap(5), false)).toBe(true); // a move doesn't grow it
    const liveBig = { ...big, live: true };
    expect(writeTables(liveBig, [2]).wt).toBe(liveBig);
  });
});

describe('resize', () => {
  it('2D: keeps cells by (x, y); shrinking drops (counted first); head clamps', () => {
    const g = { ...make2D(16, 'G', 3, 2, [1, 2, 3, 4, 5, 6]), head: { x: 2, y: 1 } };
    expect([droppedBy2DResize(g, 2, 2), droppedBy2DResize(g, 3, 1), droppedBy2DResize(g, 4, 4)]).toEqual([2, 3, 0]);
    const s = resize2D(g, 2, 1).wt;
    expect([s.rows, s.head]).toEqual([[[1, 2]], { x: 1, y: 0 }]);
    expect(resize2D(g, 4, 3).wt.rows).toEqual([
      [1, 2, 3, _],
      [4, 5, 6, _],
      [_, _, _, _],
    ]);
    expect(resize2D(g, 3, 2).wt).toBe(g);
  });

  it('1D: fixed length pads / truncates; variable ↔ fixed re-normalizes the write settings', () => {
    const a = { ...make1D(16, 'A', [1, 2, 3]), live: true };
    expect(a.write.edge).toBe('grow');
    const f = resize1D(a, true).wt;
    expect([f.fixed, f.rows[0], f.write.edge]).toEqual([true, [1, 2, 3], 'wrap']);
    expect(resize1D(a, true, 5).wt.rows[0]).toEqual([1, 2, 3, _, _]);
    expect(droppedBy1DResize(a, 1)).toBe(2);
    const t = resize1D(a, true, 1);
    expect([t.wt.rows[0], t.map]).toEqual([[1], [0, -1, -1]]);
    expect(t.wt.head.x).toBe(0); // was at 3 (append): restarts on the line
    const v = resize1D(f, false).wt;
    expect([v.fixed, v.write.edge]).toEqual([false, 'grow']);
    expect(resize1D(builtinWavetables()[0], true, 4).wt.fixed).toBe(false);
  });
});

describe('write head on user wavetables', () => {
  it('settings are coerced per shape; an invalid head restarts', () => {
    const g = { ...newWavetable(16, 'G', '2d', 2, 2), live: true };
    expect(setWrite(g, { mode: 'insert' }).write.mode).toBe('replace');
    expect(setWrite(g, { dir: '+y' }).write.dir).toBe('+y');
    const a = { ...make1D(16, 'A', [1, 2]), live: true, head: { x: 2, y: 0 } };
    // −x insert at the end is still valid; −x replace past the end is not: restart at the last slot.
    expect(setWrite(a, { dir: '-x', mode: 'replace' }).head).toEqual({ x: 1, y: 0 });
    expect(setWrite(a, { dir: '+y' })).toBe(a);
  });

  it('setHead clamps per shape', () => {
    const a = make1D(16, 'A', [1, 2]);
    expect(setHead(a, 9, 3).head).toEqual({ x: 2, y: 0 });
    expect(setHead(a, -5, 0).head).toEqual({ x: -1, y: 0 });
    const g = newWavetable(17, 'G', '2d', 3, 3);
    expect(setHead(g, 9, -1).head).toEqual({ x: 2, y: 0 });
    const r = makeRows(18, 'R', [[1, 2]]);
    expect(setHead(r, 5, 4).head).toEqual({ x: 0, y: 1 });
  });

  it('previewWrites matches what writeTables does', () => {
    const cases: Wavetable[] = [
      { ...make1D(16, 'A', [1, 2, 3]), live: true, head: { x: 1, y: 0 } },
      { ...make1D(16, 'A', [1, 2, 3], { write: { mode: 'replace' } }), live: true, head: { x: 1, y: 0 } },
      { ...make1D(16, 'F', [1, 2, 3], { fixed: true, write: { edge: 'wrap', mode: 'replace' } }), live: true, head: { x: 2, y: 0 } },
      { ...newWavetable(16, 'G', '2d', 2, 2), live: true, head: { x: 1, y: 1 } },
      { ...makeRows(16, 'R', [[1, 2]], { write: { batch: 'newRow' } }), live: true },
    ];
    const ids = [100, 101, 102, 103, 104];
    for (const wt of cases) {
      const p = previewWrites(wt, ids.length);
      const after = writeTables(wt, ids).wt;
      for (const w of p.writes) {
        const id = ids[w.n - 1];
        if (w.kind === 'replace') {
          // Not overwritten later in the same batch → it is in that cell afterwards.
          if (!p.writes.some((o) => o.n > w.n && o.kind === 'replace' && o.x === w.x && o.y === w.y)) expect(after.rows[w.y][w.x]).toBe(id);
        } else expect(after.rows.flat()).toContain(id);
      }
    }
    const a = previewWrites(cases[0], 2);
    expect(a.writes).toEqual([
      { n: 1, kind: 'insert', x: 1, y: 0 },
      { n: 2, kind: 'insert', x: 1, y: 0 },
    ]);
    expect(previewWrites(cases[3], 3).writes.map((w) => [w.kind, w.x, w.y])).toEqual([
      ['replace', 1, 1],
      ['replace', 0, 0],
      ['replace', 1, 0],
    ]);
    expect(previewWrites(cases[4], 2).writes.map((w) => [w.kind, w.y])).toEqual([
      ['append', 1],
      ['append', 1],
    ]);
    const lb = { ...builtinWavetables()[LAST_BATCH_WAVETABLE_ID], rows: [[1, 2]], head: { x: 2, y: 0 } };
    expect(previewWrites(lb, 1).fresh).toBe(true);
    // A stopped head writes nothing.
    const st = { ...make1D(16, 'S', [1, 2], { fixed: true, write: { edge: 'stop', mode: 'replace' } }), live: true, head: { x: 2, y: 0 } };
    expect(previewWrites(st, 3).writes).toEqual([]);
  });
});

// ---- AppModel ----

const sines = (n: number) => Array.from({ length: n }, () => generateBasic('sine', 0));

function model(cap = 8) {
  const m = new AppModel(cap);
  m.addTables(sines(4));
  m.clearUndo();
  return m;
}

describe('AppModel wavetable editing', () => {
  it('create / rename / duplicate / delete, each undoable', () => {
    const m = model();
    const a = m.createWavetable('1d');
    const g = m.createWavetable('2d', 4, 3);
    const r = m.createWavetable('rows');
    expect([a.id, g.id, r.id]).toEqual([FIRST_USER_WAVETABLE_ID, FIRST_USER_WAVETABLE_ID + 1, FIRST_USER_WAVETABLE_ID + 2]);
    expect([a.name, g.name, r.name]).toEqual(['Wavetable 1', 'Wavetable 2', 'Wavetable 3']);
    expect(m.wavetable(g.id)!.rows.map((x) => x.length)).toEqual([4, 4, 4]);
    m.renameWavetable(a.id, '  Bells ');
    expect(m.wavetable(a.id)!.name).toBe('Bells');
    m.renameWavetable(a.id, '   ');
    m.renameWavetable(TIMELINE_WAVETABLE_ID, 'X');
    expect([m.wavetable(a.id)!.name, m.wavetable(0)!.name]).toEqual(['Bells', 'Timeline']);
    const d = m.duplicateWavetable(LAST_BATCH_WAVETABLE_ID)!;
    expect([d.name, d.builtin, d.rows[0], d.live]).toEqual(['Last batch copy', undefined, [1, 2, 3, 4], false]);
    expect(m.duplicateWavetable(LAST_BATCH_WAVETABLE_ID)!.name).toBe('Last batch copy 2');
    m.undo();
    m.undo();
    expect(m.wavetable(d.id)).toBeUndefined();
    m.undo();
    expect(m.wavetable(a.id)!.name).toBe('Wavetable 1');
    m.deleteWavetable(GRID_WAVETABLE_ID);
    expect(m.wavetable(GRID_WAVETABLE_ID)).toBeDefined(); // built-ins can't be deleted
    m.deleteWavetable(r.id);
    expect(m.wavetable(r.id)).toBeUndefined();
    m.undo();
    expect(m.wavetable(r.id)).toBeDefined();
  });

  it('deleting a wavetable moves its voices to the Timeline; undo moves them back', () => {
    const m = model();
    const a = m.createWavetable('1d');
    m.placeInWavetable(a.id, { kind: 'gap', x: 0, y: 0 }, 2);
    m.placeInWavetable(a.id, { kind: 'gap', x: 1, y: 0 }, 3);
    const v = m.addVoice({ wavetableId: a.id })!;
    const other = m.addVoice({ windowStart: 1, windowEnd: 2 })!;
    expect([m.voice(v.id)!.windowStart, m.voice(v.id)!.windowEnd]).toEqual([0, 1]);
    m.deleteWavetable(a.id);
    expect([m.voice(v.id)!.wavetableId, m.voice(v.id)!.windowEnd]).toEqual([TIMELINE_WAVETABLE_ID, 3]);
    expect(m.voice(other.id)!.windowEnd).toBe(2);
    m.undo();
    expect([m.voice(v.id)!.wavetableId, m.voice(v.id)!.windowStart, m.voice(v.id)!.windowEnd]).toEqual([a.id, 0, 1]);
  });

  it('drag edits are undoable and ignore unknown waveforms / built-ins', () => {
    const m = model();
    const a = m.createWavetable('1d');
    expect(m.placeInWavetable(a.id, { kind: 'gap', x: 0, y: 0 }, 999)).toBe(false);
    expect(m.placeInWavetable(LAST_BATCH_WAVETABLE_ID, { kind: 'slot', x: 0, y: 0 }, 1)).toBe(false);
    const depth = m.undoDepth;
    m.placeInWavetable(a.id, { kind: 'gap', x: 0, y: 0 }, 1);
    m.placeInWavetable(a.id, { kind: 'gap', x: 1, y: 0 }, 2);
    m.placeInWavetable(a.id, { kind: 'gap', x: 0, y: 0 }, 3);
    expect(m.wavetable(a.id)!.rows[0]).toEqual([3, 1, 2]);
    m.moveInWavetable(a.id, { x: 0, y: 0 }, { kind: 'gap', x: 3, y: 0 });
    expect(m.wavetable(a.id)!.rows[0]).toEqual([1, 2, 3]);
    m.clearWavetableSlot(a.id, 1, 0);
    expect(m.wavetable(a.id)!.rows[0]).toEqual([1, null, 3]);
    m.removeWavetableSlot(a.id, 1, 0);
    expect(m.wavetable(a.id)!.rows[0]).toEqual([1, 3]);
    expect(m.undoDepth).toBe(depth + 6);
    for (let i = 0; i < 6; i++) m.undo();
    expect(m.wavetable(a.id)!.rows[0]).toEqual([]);
  });

  it('resize and settings: resizes are undoable; settings stay across undo', () => {
    const m = model();
    const g = m.createWavetable('2d', 2, 2);
    m.placeInWavetable(g.id, { kind: 'slot', x: 1, y: 1 }, 4);
    m.resizeWavetable2D(g.id, 1, 1);
    expect(m.wavetable(g.id)!.rows).toEqual([[null]]);
    m.setWavetableLive(g.id, true);
    m.setWavetableWrite(g.id, { dir: '+y' });
    m.undo();
    const back = m.wavetable(g.id)!;
    expect([back.rows[1][1], back.live, back.write.dir]).toEqual([4, true, '+y']);
    const a = m.createWavetable('1d');
    m.resizeWavetable1D(a.id, true, 3);
    expect([m.wavetable(a.id)!.fixed, m.wavetable(a.id)!.rows[0]]).toEqual([true, [null, null, null]]);
    m.setWavetableHead(a.id, 2, 0);
    expect(m.wavetable(a.id)!.head).toEqual({ x: 2, y: 0 });
    m.setWavetableLive(LAST_BATCH_WAVETABLE_ID, false);
    expect(m.wavetable(LAST_BATCH_WAVETABLE_ID)!.live).toBe(true);
  });

  it('live user wavetables receive every add at their write head; undo reverts it', () => {
    const m = model(100);
    const a = m.createWavetable('1d');
    const g = m.createWavetable('2d', 2, 2);
    m.addTables(sines(1));
    expect(m.wavetable(a.id)!.rows[0]).toEqual([]); // frozen
    m.setWavetableLive(a.id, true);
    m.setWavetableLive(g.id, true);
    m.addTables(sines(3));
    expect(m.wavetable(a.id)!.rows[0]).toEqual([6, 7, 8]);
    expect(m.wavetable(g.id)!.rows).toEqual([
      [6, 7],
      [8, null],
    ]);
    m.addTables(sines(2));
    expect(m.wavetable(g.id)!.rows).toEqual([
      [10, 7],
      [8, 9],
    ]);
    m.undo();
    expect(m.wavetable(g.id)!.rows[0]).toEqual([6, 7]);
    expect(m.wavetable(a.id)!.rows[0]).toEqual([6, 7, 8]);
  });

  it('pinning: referenced waveforms are never evicted; unreferenced become evictable again', () => {
    const m = model(4); // ids 1..4, at the cap
    // Only the Timeline mirror (Last batch / Grid would pin everything here).
    (m as unknown as { wavetables: Wavetable[] }).wavetables = m.wavetables.filter((w) => w.id === TIMELINE_WAVETABLE_ID);
    const a = m.createWavetable('1d');
    m.placeInWavetable(a.id, { kind: 'gap', x: 0, y: 0 }, 1);
    m.addTables(sines(2));
    expect(m.timeline.map((t) => t.id)).toEqual([1, 4, 5, 6]);
    // Moved / swapped / copied within the wavetable: still pinned.
    m.placeInWavetable(a.id, { kind: 'gap', x: 1, y: 0 }, 4);
    m.moveInWavetable(a.id, { x: 0, y: 0 }, { kind: 'slot', x: 1, y: 0 });
    m.addTables(sines(1));
    expect(m.timeline.map((t) => t.id)).toEqual([1, 4, 6, 7]);
    // Cleared: 4 is evictable again (1 stays).
    m.clearWavetableSlot(a.id, 0, 0);
    expect(m.wavetable(a.id)!.rows[0]).toEqual([null, 1]);
    m.addTables(sines(1));
    expect(m.timeline.map((t) => t.id)).toEqual([1, 6, 7, 8]);
    // Deleted: 1 goes too.
    m.deleteWavetable(a.id);
    m.addTables(sines(1));
    expect(m.timeline.map((t) => t.id)).toEqual([6, 7, 8, 9]);
    // A duplicate of a mirror built-in pins what it copied.
    const d = m.duplicateWavetable(TIMELINE_WAVETABLE_ID)!;
    m.addTables(sines(2)); // everything older is pinned: the new ones go first
    expect(m.timeline.map((t) => t.id)).toEqual([6, 7, 8, 9]);
    m.deleteWavetable(d.id);
    m.addTables(sines(1));
    expect(m.timeline.map((t) => t.id)).toEqual([7, 8, 9, 12]);
    // The Timeline mirror never holds an evicted id.
    expect(m.wavetable(TIMELINE_WAVETABLE_ID)!.rows[0]).toEqual([7, 8, 9, 12]);
  });

  it('voices on a user wavetable follow its edits', () => {
    const m = model();
    const a = m.createWavetable('1d');
    for (const id of [1, 2, 3]) m.placeInWavetable(a.id, { kind: 'gap', x: m.wavetable(a.id)!.rows[0].length, y: 0 }, id);
    const v = m.addVoice({ wavetableId: a.id, windowStart: 1, windowEnd: 2 })!;
    m.placeInWavetable(a.id, { kind: 'gap', x: 0, y: 0 }, 4);
    expect([m.voice(v.id)!.windowStart, m.voice(v.id)!.windowEnd]).toEqual([2, 3]);
    m.undo();
    expect([m.voice(v.id)!.windowStart, m.voice(v.id)!.windowEnd]).toEqual([1, 2]);
  });
});
