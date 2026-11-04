import { describe, expect, it } from 'vitest';
import { defaultSessionState } from '../src/app/defaultSession';
import { AppModel } from '../src/app/model';
import { basicWave, renderRecipe } from '../src/core/generators';
import { columnRef, gridDims, gridLimit, gridRowTable, gridXY, opRows, relDiff, row1Fits, rowOpVaries, type GridRowOp } from '../src/core/grid';
import { FACTORY_CHAINS } from '../src/core/shapeFactory';
import { EMPTY_CHAIN } from '../src/core/shapeChain';
import type { GeneratedTable, WaveTable } from '../src/core/table';
import { cellAt, PREVIEW_BATCH_WAVETABLE_ID, PREVIEW_WAVETABLE_ID, wavetableDims } from '../src/core/wavetable';

const model = () => {
  const m = new AppModel();
  m.loadState(defaultSessionState());
  return m;
};
const fold: GridRowOp = { kind: 'mutate', mutation: 'fold', amount: 0.6, mode: 'lin', seed: 7 };
const col = (k: number): GeneratedTable => ({ data: basicWave(k % 2 ? 'saw' : 'square', 0), recipe: { op: 'basic', params: { shape: k % 2 ? 'saw' : 'square' }, seed: 0, parents: [] } });
/** Columns as WaveTables with placeholder ids, and their row tables. */
const build = (cols: GeneratedTable[], op: GridRowOp, n: number) =>
  cols.map((c, k) => {
    const w: WaveTable = { id: columnRef(k), data: c.data, recipe: c.recipe };
    const out: GeneratedTable[] = [];
    for (let j = 0; j < n; j++) out.push(gridRowTable(op, w, j, n, out[j - 1]?.data));
    return out;
  });

describe('grid core', () => {
  it('layout, limits and row counts', () => {
    expect(gridXY(2, 1, false)).toEqual({ x: 2, y: 1 });
    expect(gridXY(2, 1, true)).toEqual({ x: 1, y: 2 });
    expect(gridDims(4, 3, true)).toEqual({ w: 3, h: 4 });
    expect(opRows(8, true)).toBe(7);
    expect(opRows(8, false)).toBe(8);
    expect(gridLimit(32, 32)).toBeNull();
    expect(gridLimit(33, 2)).toMatch(/32/);
    expect(gridLimit(0, 2)).toMatch(/empty/);
  });

  it('row ops vary or not; row 1 fits when the first row stays near the column', () => {
    expect(rowOpVaries(fold)).toBe(true);
    expect(rowOpVaries({ ...fold, amount: 0 })).toBe(false);
    expect(rowOpVaries({ kind: 'shape', chain: EMPTY_CHAIN })).toBe(false);
    const sweeping = FACTORY_CHAINS.find((f) => f.chain.steps.some((s) => s.on && s.amountEnd !== undefined && s.amountEnd !== s.amount))!;
    expect(rowOpVaries({ kind: 'shape', chain: sweeping.chain })).toBe(true);
    const w: WaveTable = { id: 1, data: basicWave('saw', 0), recipe: col(1).recipe };
    expect(row1Fits(fold, w, 8)).toBe(true);
    expect(relDiff(w.data, w.data)).toBe(0);
  });
});

describe('AppModel.addGrid', () => {
  it('adds columns and rows as one batch and one undo step; new 2D wavetable; the voice plays it', () => {
    const m = model();
    const n0 = m.timeline.length;
    const wts0 = m.wavetables.length;
    const d0 = m.undoDepth;
    const cols = [col(0), col(1), col(2)];
    const rows = build(cols, fold, 3); // row1 on: 4 rows
    const wt = m.addGrid({ columns: { kind: 'new', tables: cols }, rows, row1: true, swap: false, into: { kind: 'new', voiceId: 1 } })!;
    expect(wt).toBeTruthy();
    expect(m.timeline.length).toBe(n0 + 3 + 9);
    expect(m.undoDepth).toBe(d0 + 1);
    expect(wavetableDims(wt)).toEqual({ w: 3, h: 4 });
    expect(wt.name).toMatch(/^Grid \d+$/);
    const added = m.timeline.slice(n0);
    // Row 0 = the columns; each row table's parent is its column, and replays from it.
    for (let c = 0; c < 3; c++) {
      expect(cellAt(wt, c, 0)).toBe(added[c].id);
      for (let r = 1; r < 4; r++) {
        const t = m.table(cellAt(wt, c, r))!;
        expect(t.recipe.parents).toEqual([added[c].id]);
        const again = renderRecipe(t.recipe, { resolveTable: (id) => m.table(id)?.data });
        expect(Array.from(again)).toEqual(Array.from(t.data));
      }
    }
    expect(m.voice(1)!.wavetableId).toBe(wt.id);
    expect([m.voice(1)!.windowStart, m.voice(1)!.windowEnd, m.voice(1)!.windowStartY, m.voice(1)!.windowEndY]).toEqual([0, 2, 0, 3]);
    m.undo();
    expect(m.timeline.length).toBe(n0);
    expect(m.wavetables.length).toBe(wts0);
    expect(m.voice(1)!.wavetableId).not.toBe(wt.id);
  });

  it('into the cells of a wavetable (swapped, without row 1); its write head skips the add; existing columns', () => {
    const m = model();
    const g = m.createWavetable('2d', 5, 5);
    m.setWavetableLive(g.id, true);
    const cols = m.timeline.slice(0, 2);
    const rows = cols.map((c) => {
      const out: GeneratedTable[] = [];
      for (let j = 0; j < 3; j++) out.push(gridRowTable(fold, c, j, 3, out[j - 1]?.data));
      return out;
    });
    const n0 = m.timeline.length;
    const wt = m.addGrid({ columns: { kind: 'existing', ids: cols.map((c) => c.id) }, rows, row1: false, swap: true, into: { kind: 'cells', wtId: g.id, x0: 1, y0: 2 } })!;
    expect(m.timeline.length).toBe(n0 + 6);
    const added = m.timeline.slice(n0);
    // Swapped: column c runs along row y0 + c, rows across from x0.
    for (let c = 0; c < 2; c++) for (let r = 0; r < 3; r++) expect(cellAt(wt, 1 + r, 2 + c)).toBe(added[c * 3 + r].id);
    expect(m.table(cellAt(wt, 1, 2))!.recipe.parents).toEqual([cols[0].id]);
    // Nothing else was written (the head skipped this add).
    expect(wt.rows.flat().filter((x) => x !== null)).toHaveLength(6);
    // Out of bounds: refused, nothing added.
    expect(m.addGrid({ columns: { kind: 'existing', ids: cols.map((c) => c.id) }, rows, row1: false, swap: true, into: { kind: 'cells', wtId: g.id, x0: 3, y0: 4 } })).toBeNull();
    expect(m.timeline.length).toBe(n0 + 6);
  });
});

describe('Preview batch as a grid', () => {
  it('setPreview with a grid makes Preview batch 2D (row-major); voices over the whole batch keep the whole grid', () => {
    const m = model();
    const data = (k: number) => Float32Array.from({ length: 2048 }, (_, i) => Math.sin((2 * Math.PI * (k + 1) * i) / 2048));
    m.setPreview([data(0), data(1), data(2)], 0);
    m.updateVoice(1, { wavetableId: PREVIEW_BATCH_WAVETABLE_ID });
    expect(m.voice(1)!.windowEnd).toBe(2);
    const six = [0, 1, 2, 3, 4, 5].map(data);
    m.setPreview(six, 4, { w: 3, h: 2 });
    const wt = m.wavetable(PREVIEW_BATCH_WAVETABLE_ID)!;
    expect(wt.shape).toBe('2d');
    expect(wavetableDims(wt)).toEqual({ w: 3, h: 2 });
    expect(wt.rows[1][1]).toBe(m.previewTables[4].id);
    expect(m.wavetable(PREVIEW_WAVETABLE_ID)!.rows[0][0]).toBe(m.previewTables[4].id);
    const v = m.voice(1)!;
    expect([v.windowStart, v.windowEnd, v.windowStartY, v.windowEndY]).toEqual([0, 2, 0, 1]);
    // Back to a 1D batch: the whole of it.
    m.setPreview([data(7), data(8)], 1);
    const w1 = m.wavetable(PREVIEW_BATCH_WAVETABLE_ID)!;
    expect(w1.shape).toBe('1d');
    expect(w1.rows).toEqual([m.previewTables.map((t) => t.id)]);
    expect([m.voice(1)!.windowStart, m.voice(1)!.windowEnd]).toEqual([0, 1]);
    // A size that doesn't match the batch is ignored (1D).
    m.setPreview(six, 0, { w: 4, h: 2 });
    expect(m.wavetable(PREVIEW_BATCH_WAVETABLE_ID)!.shape).toBe('1d');
  });
});
