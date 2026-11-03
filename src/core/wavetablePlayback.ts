/**
 * Playback addressing shared by the engine (audio thread) and the UI: a compact packed
 * wavetable (what the worklet receives) and the position → (tables, weights) mapping.
 * Allocation-free per call (the caller owns the `Mix`).
 */
import type { TableId } from './table';
import type { Interp, Wavetable, WavetableShape } from './wavetable';

/** A wavetable as the engine sees it: row offsets + slot ids (-1 = empty). */
export interface PackedWavetable {
  readonly shape: WavetableShape;
  readonly interp: Interp;
  /** rowStart[r]..rowStart[r+1] are row r's slots in `ids`; length = rows + 1. */
  readonly rowStart: Int32Array;
  readonly ids: Int32Array;
}

export function packWavetable(wt: Wavetable): PackedWavetable {
  const rowStart = new Int32Array(wt.rows.length + 1);
  let n = 0;
  wt.rows.forEach((r, i) => {
    rowStart[i] = n;
    n += r.length;
  });
  rowStart[wt.rows.length] = n;
  const ids = new Int32Array(n);
  let k = 0;
  for (const r of wt.rows) for (const id of r) ids[k++] = id === null ? -1 : id;
  return { shape: wt.shape, interp: wt.interp, rowStart, ids };
}

/** A 1D packed wavetable from ids (tests, simple callers). */
export function packIds(ids: readonly (TableId | null)[], interp: Interp = 'blend'): PackedWavetable {
  return {
    shape: '1d',
    interp,
    rowStart: Int32Array.from([0, ids.length]),
    ids: Int32Array.from(ids.map((x) => (x === null ? -1 : x))),
  };
}

export const MAX_MIX = 4;

/**
 * Up to four (table id, weight) pairs, weights summing to 1, plus the coordinates the
 * position resolved to (x = slot within the row, y = row; fractional for Blend, the
 * chosen cell for Step).
 */
export class Mix {
  n = 0;
  readonly ids = new Int32Array(MAX_MIX);
  readonly w = new Float64Array(MAX_MIX);
  x = 0;
  y = 0;

  /** Add weight for a table (merged with an existing entry of the same id). */
  put(id: number, w: number): void {
    if (w <= 0 && this.n > 0) return;
    for (let k = 0; k < this.n; k++) {
      if (this.ids[k] === id) {
        this.w[k] += w;
        return;
      }
    }
    if (this.n < MAX_MIX) {
      this.ids[this.n] = id;
      this.w[this.n] = w;
      this.n++;
    }
  }
}

/** Voice window over a wavetable (inclusive cell indices) plus positions 0..1. */
export interface MixWindow {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

// One row's resolution, written by lineMix (module scratch: single-threaded per realm).
let lA = -1;
let lB = -1;
let lW = 0;
let lX = 0;

/**
 * Resolve row r at position px (0..1 across the row's window; Rows: across the whole
 * row, so neighbouring rows of different lengths align proportionally). Empty slots are
 * skipped: Blend crossfades the nearest filled slots on either side, Step takes the
 * nearest filled slot; if the window holds nothing, the nearest filled slot in the row.
 * Returns false if the row has no filled slot at all.
 */
function lineMix(p: PackedWavetable, r: number, x0: number, x1: number, px: number, step: boolean): boolean {
  const off = p.rowStart[r];
  const L = p.rowStart[r + 1] - off;
  if (L <= 0) return false;
  let a = 0;
  let b = L - 1;
  if (p.shape !== 'rows') {
    a = Math.max(0, Math.min(b, x0));
    const e = Math.max(0, Math.min(b, x1));
    if (a > e) {
      b = a;
      a = e;
    } else b = e;
  }
  const ids = p.ids;
  const rel = px * (b - a);
  if (step) {
    const k = a + Math.round(rel);
    let best = -1;
    for (let d = 0; d <= L; d++) {
      const lo = k - d;
      const hi = k + d;
      const inLo = lo >= a && lo <= b;
      const inHi = hi >= a && hi <= b;
      if (!inLo && !inHi) break;
      if (inLo && ids[off + lo] >= 0) {
        best = lo;
        break;
      }
      if (inHi && ids[off + hi] >= 0) {
        best = hi;
        break;
      }
    }
    if (best < 0) best = nearestFilled(ids, off, L, k);
    if (best < 0) return false;
    lA = lB = ids[off + best];
    lW = 0;
    lX = best;
    return true;
  }
  const fl = Math.floor(rel);
  const i = a + fl;
  let left = -1;
  for (let x = i; x >= a; x--) {
    if (ids[off + x] >= 0) {
      left = x;
      break;
    }
  }
  let right = -1;
  for (let x = i + 1; x <= b; x++) {
    if (ids[off + x] >= 0) {
      right = x;
      break;
    }
  }
  lX = a + rel;
  if (left >= 0 && right >= 0) {
    lA = ids[off + left];
    lB = ids[off + right];
    // Relative to the window start, so a re-indexed wavetable yields identical weights.
    lW = right - left === 1 && left === i ? rel - fl : (rel - (left - a)) / (right - left);
    return true;
  }
  let k = left >= 0 ? left : right;
  if (k < 0) k = nearestFilled(ids, off, L, Math.round(lX));
  if (k < 0) return false;
  lA = lB = ids[off + k];
  lW = 0;
  return true;
}

function nearestFilled(ids: Int32Array, off: number, L: number, k: number): number {
  for (let d = 0; d < 2 * L; d++) {
    const lo = k - d;
    const hi = k + d;
    if (lo >= 0 && lo < L && ids[off + lo] >= 0) return lo;
    if (hi >= 0 && hi < L && ids[off + hi] >= 0) return hi;
    if (lo < 0 && hi >= L) break;
  }
  return -1;
}

function rowHasFilled(p: PackedWavetable, r: number): boolean {
  for (let k = p.rowStart[r]; k < p.rowStart[r + 1]; k++) if (p.ids[k] >= 0) return true;
  return false;
}

/**
 * Position → tables and weights.
 *  - 1D: x window + position px (y ignored).
 *  - 2D: rectangular window; Blend is bilinear over the 4 surrounding cells.
 *  - Rows: row window y0..y1 + position py; px runs along each row proportionally;
 *    Blend crossfades within each row and between the two neighbouring rows.
 * Step picks one cell (the nearest filled one). Empty slots / rows are skipped (never
 * silence while anything is filled); out.n = 0 only for an empty wavetable.
 */
export function resolveMix(
  p: PackedWavetable,
  win: MixWindow,
  px: number,
  py: number,
  step: boolean,
  out: Mix,
): Mix {
  out.n = 0;
  const nRows = p.rowStart.length - 1;
  if (nRows <= 0 || p.ids.length === 0) return out;
  let y0 = 0;
  let y1 = 0;
  if (p.shape !== '1d') {
    const max = nRows - 1;
    y0 = Math.max(0, Math.min(max, win.y0));
    y1 = Math.max(0, Math.min(max, win.y1));
    if (y0 > y1) {
      const t = y0;
      y0 = y1;
      y1 = t;
    }
  }
  const relY = py * (y1 - y0);
  if (step) {
    const k = y0 + Math.round(relY);
    let row = -1;
    for (let d = 0; d <= nRows; d++) {
      const lo = k - d;
      const hi = k + d;
      if (lo < y0 && hi > y1) break;
      if (lo >= y0 && lo <= y1 && rowHasFilled(p, lo)) {
        row = lo;
        break;
      }
      if (hi >= y0 && hi <= y1 && rowHasFilled(p, hi)) {
        row = hi;
        break;
      }
    }
    if (row < 0) row = nearestRow(p, nRows, k);
    if (row < 0 || !lineMix(p, row, win.x0, win.x1, px, true)) return out;
    out.put(lA, 1);
    out.x = lX;
    out.y = row;
    return out;
  }
  const fl = Math.floor(relY);
  const i = y0 + fl;
  let top = -1;
  for (let r = i; r >= y0; r--) {
    if (rowHasFilled(p, r)) {
      top = r;
      break;
    }
  }
  let bot = -1;
  for (let r = i + 1; r <= y1; r++) {
    if (rowHasFilled(p, r)) {
      bot = r;
      break;
    }
  }
  let wy = 0;
  if (top >= 0 && bot >= 0) wy = bot - top === 1 && top === i ? relY - fl : (relY - (top - y0)) / (bot - top);
  else if (top < 0 && bot < 0) {
    top = nearestRow(p, nRows, Math.round(y0 + relY));
    if (top < 0) return out;
  } else if (top < 0) top = bot;
  if (bot < 0 || wy === 0) bot = top;
  out.y = y0 + relY;
  lineMix(p, top, win.x0, win.x1, px, false);
  out.x = lX;
  const a0 = lA;
  const b0 = lB;
  const w0 = lW;
  out.put(a0, (1 - wy) * (1 - w0));
  out.put(b0, (1 - wy) * w0);
  if (bot !== top) {
    lineMix(p, bot, win.x0, win.x1, px, false);
    out.put(lA, wy * (1 - lW));
    out.put(lB, wy * lW);
  }
  return out;
}

function nearestRow(p: PackedWavetable, nRows: number, k: number): number {
  for (let d = 0; d < 2 * nRows; d++) {
    const lo = k - d;
    const hi = k + d;
    if (lo >= 0 && lo < nRows && rowHasFilled(p, lo)) return lo;
    if (hi >= 0 && hi < nRows && rowHasFilled(p, hi)) return hi;
    if (lo < 0 && hi >= nRows) break;
  }
  return -1;
}

/**
 * Table ids inside a voice window, in slot order (duplicates kept once): 1D the slots
 * x0..x1, 2D the rectangle, Rows every slot of rows y0..y1.
 */
export function windowIds(wt: Wavetable, win: MixWindow): TableId[] {
  const out: TableId[] = [];
  const seen = new Set<TableId>();
  const push = (id: TableId | null) => {
    if (id === null || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  const nRows = wt.rows.length;
  if (!nRows) return out;
  const [ya, yb] = wt.shape === '1d' ? [0, 0] : ordered(win.y0, win.y1, nRows);
  for (let y = ya; y <= yb; y++) {
    const r = wt.rows[y];
    if (!r.length) continue;
    const [xa, xb] = wt.shape === 'rows' ? [0, r.length - 1] : ordered(win.x0, win.x1, r.length);
    for (let x = xa; x <= xb; x++) push(r[x]);
  }
  return out;
}

function ordered(a: number, b: number, len: number): [number, number] {
  const max = Math.max(0, len - 1);
  let s = Math.max(0, Math.min(max, Math.round(a)));
  let e = Math.max(0, Math.min(max, Math.round(b)));
  if (s > e) [s, e] = [e, s];
  return [s, e];
}
