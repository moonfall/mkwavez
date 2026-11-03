/**
 * Wavetables: named sets of slots that reference timeline tables by id (never copies;
 * one table may sit in many wavetables, or many times in one). Plain, serializable data.
 *
 * Shapes, all stored as `rows` (one array of slots per row; `null` = empty slot):
 *  - '1d'   exactly one row; `fixed` = fixed number of slots, else variable (grows);
 *  - '2d'   a fixed X × Y grid: `rows.length` = Y, every row has X slots;
 *  - 'rows' rows of differing lengths (e.g. one row per batch).
 *
 * A live wavetable has a write head that places every new table (or batch) added to the
 * timeline; see `writeTables()`. Frozen ones are only changed by hand (the editor; see `placeTable()` and friends).
 */
import type { TableId } from './table';

export type WavetableId = number;
export type WavetableShape = '1d' | '2d' | 'rows';
/** Blend crossfades neighbouring slots (bilinear on 2D); Step switches only on phase wrap. */
export type Interp = 'blend' | 'step';
export type Slot = TableId | null;

/** Write head settings (see `writeTables`). */
export type WriteDir = '+x' | '-x' | '+y' | '-y';
export type WriteEdge = 'wrap' | 'stop' | 'grow';
export type WriteWrap = 'next' | 'same';
export type WriteMode = 'replace' | 'insert';
export type WriteBatch = 'continue' | 'newRow';

export interface WriteSettings {
  readonly dir: WriteDir;
  /** What the head does when it runs off the end of its line. */
  readonly edge: WriteEdge;
  /** On wrap: advance to the next row / column, or stay on the same line. */
  readonly onWrap: WriteWrap;
  readonly mode: WriteMode;
  /** At the start of each new batch: continue where the head is, or start a new row. */
  readonly batch: WriteBatch;
}

/**
 * Next write position as cell coordinates (x = slot in the row, y = row). It may sit one
 * past the end of its line (a growing line appends there; a stopped head writes nothing),
 * and y may equal rows.length on a Rows wavetable (a new row is created on the next write).
 */
export interface WriteHead {
  readonly x: number;
  readonly y: number;
}

export type BuiltinKind = 'timeline' | 'lastBatch' | 'batches' | 'grid';

export interface Wavetable {
  readonly id: WavetableId;
  readonly name: string;
  readonly shape: WavetableShape;
  readonly rows: readonly (readonly Slot[])[];
  /** 1D: fixed slot count (else variable). 2D: always true. Rows: always false. */
  readonly fixed: boolean;
  readonly interp: Interp;
  readonly live: boolean;
  readonly write: WriteSettings;
  readonly head: WriteHead;
  /** Built-ins are read-only and always present. */
  readonly builtin?: BuiltinKind;
  /** Whether referenced tables are pinned against eviction (false for built-ins that mirror the timeline). */
  readonly pins: boolean;
}

// ---- built-ins ----

export const TIMELINE_WAVETABLE_ID: WavetableId = 0;
export const LAST_BATCH_WAVETABLE_ID: WavetableId = 1;
export const BATCHES_WAVETABLE_ID: WavetableId = 2;
export const GRID_WAVETABLE_ID: WavetableId = 3;
/** First id for user wavetables. */
export const FIRST_USER_WAVETABLE_ID: WavetableId = 16;
export const GRID_SIZE = 8;

export const DEFAULT_WRITE: WriteSettings = { dir: '+x', edge: 'grow', onWrap: 'next', mode: 'insert', batch: 'continue' };

/**
 * The four built-ins, empty:
 *  - Timeline: 1D, everything in timeline order (grows; evicted tables drop out);
 *  - Last batch: 1D, replaced by each new batch / single add;
 *  - Batches: Rows, one row per batch / single add;
 *  - Grid: 2D 8×8, filled in order, wrapping to the next row and overwriting.
 * Timeline and Batches mirror the timeline and don't pin; Last batch and Grid pin.
 */
export function builtinWavetables(): Wavetable[] {
  const base = { interp: 'blend', live: true, head: { x: 0, y: 0 } } as const;
  return [
    { ...base, id: TIMELINE_WAVETABLE_ID, name: 'Timeline', shape: '1d', builtin: 'timeline', rows: [[]], fixed: false, pins: false, write: DEFAULT_WRITE },
    {
      ...base,
      id: LAST_BATCH_WAVETABLE_ID,
      name: 'Last batch',
      shape: '1d',
      builtin: 'lastBatch',
      rows: [[]],
      fixed: false,
      pins: true,
      write: { ...DEFAULT_WRITE, batch: 'newRow' },
    },
    {
      ...base,
      id: BATCHES_WAVETABLE_ID,
      name: 'Batches',
      shape: 'rows',
      builtin: 'batches',
      rows: [],
      fixed: false,
      pins: false,
      write: { ...DEFAULT_WRITE, batch: 'newRow' },
    },
    {
      ...base,
      id: GRID_WAVETABLE_ID,
      name: 'Grid',
      shape: '2d',
      builtin: 'grid',
      rows: emptyGrid(GRID_SIZE, GRID_SIZE),
      fixed: true,
      pins: true,
      write: { dir: '+x', edge: 'wrap', onWrap: 'next', mode: 'replace', batch: 'continue' },
    },
  ];
}

function emptyGrid(w: number, h: number): Slot[][] {
  return Array.from({ length: h }, () => new Array<Slot>(w).fill(null));
}

// ---- constructors (user wavetables; also used by tests) ----

interface MakeOpts {
  interp?: Interp;
  live?: boolean;
  write?: Partial<WriteSettings>;
  head?: WriteHead;
}

function finish(w: Omit<Wavetable, 'interp' | 'live' | 'write' | 'head' | 'pins'>, o: MakeOpts): Wavetable {
  const write = normalizeWrite(w.shape, w.fixed, { ...DEFAULT_WRITE, ...o.write });
  return { ...w, interp: o.interp ?? 'blend', live: o.live ?? false, pins: true, write, head: o.head ?? startHead(w.shape, w.rows, write) };
}

/** 1D wavetable; `fixed` keeps the slot count (empty slots stay as null). */
export function make1D(id: WavetableId, name: string, ids: readonly Slot[], o: MakeOpts & { fixed?: boolean } = {}): Wavetable {
  return finish({ id, name, shape: '1d', rows: [ids.slice()], fixed: !!o.fixed }, o);
}

/** width × height grid, row-major ids (missing = empty). */
export function make2D(id: WavetableId, name: string, width: number, height: number, ids: readonly Slot[] = [], o: MakeOpts = {}): Wavetable {
  const rows = emptyGrid(width, height);
  for (let i = 0; i < Math.min(ids.length, width * height); i++) rows[Math.floor(i / width)][i % width] = ids[i];
  return finish({ id, name, shape: '2d', rows, fixed: true }, o);
}

export function makeRows(id: WavetableId, name: string, rows: readonly (readonly Slot[])[], o: MakeOpts = {}): Wavetable {
  return finish({ id, name, shape: 'rows', rows: rows.map((r) => r.slice()), fixed: false }, o);
}

// ---- queries ----

export function cellAt(wt: Wavetable, x: number, y: number): Slot {
  return wt.rows[y]?.[x] ?? null;
}

/** Width (longest row) and height (row count). */
export function wavetableDims(wt: Wavetable): { w: number; h: number } {
  let w = 0;
  for (const r of wt.rows) w = Math.max(w, r.length);
  return { w, h: wt.rows.length };
}

/** Total number of slots (filled or not). */
export function slotCount(wt: Wavetable): number {
  let n = 0;
  for (const r of wt.rows) n += r.length;
  return n;
}

/** Number of filled slots. */
export function filledCount(wt: Wavetable): number {
  let n = 0;
  for (const r of wt.rows) for (const s of r) if (s !== null) n++;
  return n;
}

/** Length of the axis voice windows follow: 1D slots, Rows rows; 2D has none (fixed). */
export function axisLength(wt: Wavetable): number {
  return wt.shape === '1d' ? (wt.rows[0]?.length ?? 0) : wt.rows.length;
}

/** Short shape label, e.g. "1D · 212", "2D · 8×8", "Rows · 6". */
export function shapeLabel(wt: Wavetable): string {
  if (wt.shape === '1d') return `1D · ${wt.rows[0]?.length ?? 0}${wt.fixed ? ' fixed' : ''}`;
  if (wt.shape === '2d') return `2D · ${wt.rows[0]?.length ?? 0}×${wt.rows.length}`;
  return `Rows · ${wt.rows.length}`;
}

/** Ids that must never be evicted: anything referenced by a pinning wavetable. */
export function pinnedIds(wavetables: readonly Wavetable[]): Set<TableId> {
  const s = new Set<TableId>();
  for (const wt of wavetables) {
    if (!wt.pins) continue;
    for (const r of wt.rows) for (const id of r) if (id !== null) s.add(id);
  }
  return s;
}

/** Clamp a window to `length` positions; returns ordered [start, end]. */
export function clampWindow(start: number, end: number, length: number): [number, number] {
  const max = Math.max(0, length - 1);
  let a = Math.max(0, Math.min(max, Math.round(start)));
  let b = Math.max(0, Math.min(max, Math.round(end)));
  if (a > b) [a, b] = [b, a];
  return [a, b];
}

// ---- write head ----

/**
 * Valid settings per shape (the editor disables the rest; anything else is coerced):
 *  - 1D: direction ±x; edge wrap | stop when fixed, stop | grow when variable; on-wrap n/a.
 *    "New row" on a variable 1D starts the line afresh (its single row is replaced); on a
 *    fixed 1D it moves the head back to the line start (slots are overwritten as it goes).
 *  - 2D: all four directions; edge wrap | stop; write replace only (the grid is fixed).
 *    Stop with on-wrap "next" fills line after line and stops at the end of the grid;
 *    with "same line" it stops at the end of the line.
 *  - Rows: direction ±x; any edge; replace | insert. "New row" appends an empty row, which
 *    only growing can fill: replace + wrap / stop + new row is coerced to grow.
 */
export function normalizeWrite(shape: WavetableShape, fixed: boolean, s: WriteSettings): WriteSettings {
  let { dir, edge, mode } = s;
  if (shape !== '2d' && (dir === '+y' || dir === '-y')) dir = dir === '+y' ? '+x' : '-x';
  if (shape === '2d' || (shape === '1d' && fixed)) {
    if (edge === 'grow') edge = 'wrap';
  } else if (shape === '1d' && edge === 'wrap') edge = 'grow';
  if (shape === '2d') mode = 'replace';
  if (shape === 'rows' && mode === 'replace' && s.batch === 'newRow') edge = 'grow';
  return { dir, edge, onWrap: shape === '1d' ? 'same' : s.onWrap, mode, batch: s.batch };
}

/** Where a head starts on a fresh line: the first slot in the direction of travel. */
function lineStart(dir: WriteDir, len: number, growReplace: boolean): number {
  if (dir === '+x' || dir === '+y') return 0;
  return len > 0 ? len - 1 : growReplace ? -1 : 0;
}

function startHead(shape: WavetableShape, rows: readonly (readonly Slot[])[], s: WriteSettings): WriteHead {
  const grow = s.edge === 'grow' && s.mode === 'replace';
  if (shape === 'rows') {
    // Replacing without growth starts on the first existing row; anything else on a new row.
    if (s.mode === 'replace' && s.edge !== 'grow' && rows.length) return { x: lineStart(s.dir, rows[0].length, false), y: 0 };
    return { x: lineStart(s.dir, 0, grow), y: rows.length };
  }
  if (s.dir === '+y' || s.dir === '-y') return { x: 0, y: lineStart(s.dir, rows.length, false) };
  return { x: lineStart(s.dir, rows[0]?.length ?? 0, grow), y: 0 };
}

/**
 * Result of an edit. `map` relates the follow axis (1D: slots, Rows: rows) before and
 * after: map[old] = new index, or -1 if removed; null = unchanged indices (possibly
 * grown at the end). `reset` = the line was started afresh (1D "new row"): windows keep
 * their indices, clamped.
 */
export interface WavetableEdit {
  readonly wt: Wavetable;
  readonly map: readonly number[] | null;
  readonly reset: boolean;
}

/**
 * Most slots a user wavetable may hold: growing writes / inserts stop there (a live,
 * growing wavetable pins everything it holds, so it must not grow without bound).
 */
export const MAX_SLOTS = 4096;

/** Mutable working copy for one edit. */
class Work {
  readonly rows: Slot[][];
  private readonly copied: boolean[];
  /** Slot count (user wavetables only; built-ins are unlimited). */
  total: number;
  readonly limit: number;
  /** Follow-axis origins: origin[k] = old index of what is now at k, or -1 if new. */
  origin: number[] | null = null;
  x: number;
  y: number;
  reset = false;
  readonly s: WriteSettings;

  constructor(readonly wt: Wavetable) {
    this.rows = wt.rows.slice() as Slot[][];
    this.copied = new Array(wt.rows.length).fill(false);
    this.x = wt.head.x;
    this.y = wt.head.y;
    this.s = wt.write;
    this.limit = wt.builtin ? Infinity : MAX_SLOTS;
    this.total = wt.builtin ? 0 : slotCount(wt);
  }

  /** Can a variable line take one more slot? */
  roomy(): boolean {
    return this.total < this.limit;
  }

  row(r: number): Slot[] {
    if (!this.copied[r]) {
      this.rows[r] = this.rows[r].slice();
      this.copied[r] = true;
    }
    return this.rows[r];
  }

  /** Origins along the follow axis (created lazily, identity). */
  axis(): number[] {
    if (!this.origin) {
      const n = this.wt.shape === '1d' ? this.wt.rows[0].length : this.wt.rows.length;
      this.origin = Array.from({ length: n }, (_, i) => i);
    }
    return this.origin;
  }

  newRow(): void {
    this.rows.push([]);
    this.copied.push(true);
    if (this.origin) this.origin.push(-1);
  }

  dropRow(r: number): void {
    this.rows.splice(r, 1);
    this.copied.splice(r, 1);
    this.axis().splice(r, 1);
  }

  // Hand edits (the editor): each keeps the write head on the slot / row it pointed at.

  /** Insert a slot before x in row y. */
  ins(y: number, x: number, id: Slot): void {
    this.row(y).splice(x, 0, id);
    if (this.wt.shape === '1d') this.axis().splice(x, 0, -1);
    if (this.y === y && this.x >= x) this.x++;
  }

  /** Remove slot x of row y. */
  del(y: number, x: number): void {
    this.row(y).splice(x, 1);
    if (this.wt.shape === '1d') this.axis().splice(x, 1);
    if (this.y === y && this.x > x) this.x--;
  }

  /** Insert a row at y (Rows). */
  insRow(y: number, row: Slot[]): void {
    this.rows.splice(y, 0, row);
    this.copied.splice(y, 0, true);
    this.axis().splice(y, 0, -1);
    if (this.y >= y) this.y++;
  }

  /** Remove row y (Rows); a head on it moves to the start of the row that takes its place. */
  delRow(y: number): void {
    this.dropRow(y);
    if (this.y > y) this.y--;
    else if (this.y === y) this.x = lineStart(this.s.dir, this.rows[y]?.length ?? 0, this.s.edge === 'grow' && this.s.mode === 'replace');
  }

  done(): WavetableEdit {
    const w = this.wt;
    let map: number[] | null = null;
    if (this.origin) {
      const oldLen = w.shape === '1d' ? w.rows[0].length : w.rows.length;
      map = new Array(oldLen).fill(-1);
      this.origin.forEach((o, k) => {
        if (o >= 0) map![o] = k;
      });
      // Identity (growth at the end only): no remap needed.
      if (map.every((m, i) => m === i)) map = null;
    }
    const changed = this.copied.some(Boolean) || this.rows.length !== w.rows.length || this.x !== w.head.x || this.y !== w.head.y || this.reset;
    if (!changed) return { wt: w, map: null, reset: false };
    return { wt: { ...w, rows: this.rows, head: { x: this.x, y: this.y } }, map, reset: this.reset };
  }
}

const sign = (dir: WriteDir) => (dir === '+x' || dir === '+y' ? 1 : -1);
const vertical = (dir: WriteDir) => dir === '+y' || dir === '-y';

/** Apply "each new batch: new row" before a batch's first write. */
function startBatch(w: Work): void {
  const { s } = w;
  const shape = w.wt.shape;
  const d = sign(s.dir);
  const growReplace = s.edge === 'grow' && s.mode === 'replace';
  if (shape === '1d') {
    if (!w.wt.fixed) {
      const r = w.row(0);
      if (r.length) {
        r.length = 0;
        w.origin = [];
        w.reset = true;
      }
      w.x = lineStart(s.dir, 0, growReplace);
    } else w.x = lineStart(s.dir, w.rows[0].length, false);
    return;
  }
  if (shape === 'rows') {
    // Append a new (pending) row unless the head already sits on an empty one.
    if (!w.rows[w.y] || w.rows[w.y].length) w.y = w.rows.length;
    w.x = lineStart(s.dir, 0, growReplace);
    return;
  }
  // 2D: move to the start of the next line unless already at the start of one.
  const H = w.rows.length;
  const W = w.rows[0]?.length ?? 0;
  const v = vertical(s.dir);
  const lineLen = v ? H : W;
  const count = v ? W : H;
  let pos = v ? w.y : w.x;
  let line = v ? w.x : w.y;
  const start = lineStart(s.dir, lineLen, false);
  if (line < 0 || line >= count) return; // stopped past the last line
  if (pos !== start) {
    line += d;
    if (line < 0 || line >= count) {
      if (s.edge === 'wrap') line = (line + count) % count;
    }
    pos = start;
  }
  if (v) {
    w.x = line;
    w.y = pos;
  } else {
    w.x = pos;
    w.y = line;
  }
}

/** Write one id at the head and advance it. Returns false if nothing was written (stopped). */
function writeOne(w: Work, id: TableId): boolean {
  const { s } = w;
  const shape = w.wt.shape;
  const d = sign(s.dir);
  const v = shape === '2d' && vertical(s.dir);
  const insert = s.mode === 'insert' && shape !== '2d';
  const growable = !w.wt.fixed;
  if (v) {
    // 2D column-wise: line = x, pos = y.
    const H = w.rows.length;
    const W = w.rows[0]?.length ?? 0;
    if (w.x < 0 || w.x >= W || w.y < 0 || w.y >= H) return false;
    w.row(w.y)[w.x] = id;
    let y = w.y + d;
    let x = w.x;
    if (y < 0 || y >= H) {
      if (s.edge === 'wrap') {
        y = d > 0 ? 0 : H - 1;
        if (s.onWrap === 'next') x = (x + d + W) % W;
      } else if (s.onWrap === 'next' && x + d >= 0 && x + d < W) {
        // Stop + next: on to the next column; stops past the last one.
        y = d > 0 ? 0 : H - 1;
        x += d;
      }
    }
    w.x = x;
    w.y = y;
    return true;
  }
  // Row-wise: line = y, pos = x.
  if (w.y < 0 || w.y > w.rows.length || (w.y === w.rows.length && shape !== 'rows')) return false;
  const pending = w.y === w.rows.length;
  const L = pending ? 0 : w.rows[w.y].length;
  let pos = w.x;
  const full = growable && !w.roomy();
  if (insert) {
    if (pos < 0 || pos > L || (!growable && pos === L) || full) return false;
  } else {
    const inside = pos >= 0 && pos < L;
    const grows = growable && !full && s.edge === 'grow' && (d > 0 ? pos === L : pos === -1);
    if (!inside && !grows) return false;
  }
  if (growable && (insert || !(pos >= 0 && pos < L))) w.total++;
  if (pending) w.newRow();
  const row = w.row(w.y);
  const on1d = shape === '1d';
  if (insert && !growable && d < 0) {
    // Fixed line, −x: the mirror of +x — the new slot lands at the head, older slots
    // shift towards the start (the first one drops out), the head moves left.
    row.splice(pos + 1, 0, id);
    row.shift();
    if (on1d) {
      w.axis().splice(pos + 1, 0, -1);
      w.axis().shift();
    }
    pos--;
  } else if (insert) {
    row.splice(pos, 0, id);
    if (on1d) w.axis().splice(pos, 0, -1);
    if (!growable) {
      row.pop();
      if (on1d) w.axis().pop();
    }
    if (d > 0) pos++;
  } else if (pos >= 0 && pos < L) {
    row[pos] = id;
    pos += d;
  } else if (d > 0) {
    row.push(id);
    if (on1d) w.axis().push(-1);
    pos++;
  } else {
    row.unshift(id);
    if (on1d) w.axis().unshift(-1);
    pos = -1;
  }
  // Edges.
  const L2 = row.length;
  let line = w.y;
  const inRange = pos >= 0 && pos < L2;
  const growOk = growable && (insert ? pos >= 0 && pos <= L2 : s.edge === 'grow' && (d > 0 ? pos === L2 : pos === -1));
  if (!inRange && !growOk && s.edge === 'wrap') {
    // Next row / column, cycling through the existing rows (wrap never creates a row).
    if (shape !== '1d' && s.onWrap === 'next') line = (line + d + w.rows.length) % w.rows.length;
    const nl = line < w.rows.length ? w.rows[line].length : 0;
    pos = d > 0 ? 0 : nl > 0 ? nl - 1 : 0;
  } else if (!inRange && !growOk && s.edge === 'stop' && shape !== '1d' && s.onWrap === 'next' && line + d >= 0 && line + d < w.rows.length) {
    // Stop + next: on to the next existing row; stops after the last one.
    line += d;
    const nl = w.rows[line].length;
    pos = d > 0 ? 0 : nl > 0 ? nl - 1 : 0;
  }
  w.x = pos;
  w.y = line;
  return true;
}

/**
 * Add tables at the write head of a live wavetable, as one batch (a single add is a
 * batch of one). Frozen wavetables are returned unchanged. Writes past a stopped head
 * are dropped.
 */
export function writeTables(wt: Wavetable, ids: readonly TableId[]): WavetableEdit {
  if (!wt.live || !ids.length) return { wt, map: null, reset: false };
  const w = new Work(wt);
  if (wt.write.batch === 'newRow') startBatch(w);
  for (const id of ids) if (!writeOne(w, id)) break;
  return w.done();
}

/**
 * Drop tables that left the timeline (eviction). Variable lines close up (1D slots,
 * Rows entries; empty rows are removed); fixed shapes keep the slot, emptied.
 */
export function removeTables(wt: Wavetable, gone: ReadonlySet<TableId>): WavetableEdit {
  let hit = false;
  for (const r of wt.rows) for (const id of r) if (id !== null && gone.has(id)) hit = true;
  if (!hit) return { wt, map: null, reset: false };
  const w = new Work(wt);
  if (wt.fixed) {
    wt.rows.forEach((r, y) => {
      if (r.some((id) => id !== null && gone.has(id))) {
        const row = w.row(y);
        for (let x = 0; x < row.length; x++) if (row[x] !== null && gone.has(row[x]!)) row[x] = null;
      }
    });
    return w.done();
  }
  if (wt.shape === '1d') {
    const row = w.row(0);
    const origin = w.axis();
    let before = 0;
    for (let x = row.length - 1; x >= 0; x--) {
      if (row[x] !== null && gone.has(row[x]!)) {
        row.splice(x, 1);
        origin.splice(x, 1);
        if (x < w.x) before++;
      }
    }
    w.x -= before;
    return w.done();
  }
  // Rows.
  for (let y = wt.rows.length - 1; y >= 0; y--) {
    if (!wt.rows[y].some((id) => id !== null && gone.has(id))) continue;
    const row = w.row(y);
    let before = 0;
    for (let x = row.length - 1; x >= 0; x--) {
      if (row[x] !== null && gone.has(row[x]!)) {
        row.splice(x, 1);
        if (x < w.x) before++;
      }
    }
    if (y === w.y) w.x = Math.max(w.x - before, w.x < 0 ? -1 : 0);
    if (!row.length) {
      w.dropRow(y);
      if (y < w.y) w.y--;
      else if (y === w.y) w.x = lineStart(wt.write.dir, w.rows[w.y]?.length ?? 0, wt.write.edge === 'grow' && wt.write.mode === 'replace');
    }
  }
  return w.done();
}

/** Compose two follow-axis maps (a then b); null = identity. */
export function composeMaps(a: readonly number[] | null, b: readonly number[] | null): readonly number[] | null {
  if (!a) return b;
  if (!b) return a;
  return a.map((i) => (i < 0 ? -1 : (b[i] ?? -1)));
}

// ---- hand edits (the editor) ----

/**
 * Where a dragged waveform lands: on a slot (replace), in the gap before slot x of row y
 * (insert; x = the row length appends), or as a new row at index y (Rows only).
 */
export type SlotTarget =
  | { readonly kind: 'slot'; readonly x: number; readonly y: number }
  | { readonly kind: 'gap'; readonly x: number; readonly y: number }
  | { readonly kind: 'row'; readonly y: number };

export interface Cell {
  readonly x: number;
  readonly y: number;
}

/** Largest 2D grid side. */
export const MAX_GRID = 64;

const unchanged = (wt: Wavetable): WavetableEdit => ({ wt, map: null, reset: false });

/**
 * Whether a target is valid on this wavetable. Built-ins are read-only. 2D grids are
 * replace-only; a fixed 1D line inserts only before an existing slot; `grows` = the edit
 * adds a slot (refused at MAX_SLOTS; a move within the wavetable doesn't grow it).
 */
export function canTarget(wt: Wavetable, t: SlotTarget, grows = true): boolean {
  if (wt.builtin) return false;
  const room = !grows || slotCount(wt) < MAX_SLOTS;
  if (t.kind === 'slot') return t.y >= 0 && t.y < wt.rows.length && t.x >= 0 && t.x < wt.rows[t.y].length;
  if (t.kind === 'row') return wt.shape === 'rows' && t.y >= 0 && t.y <= wt.rows.length && room;
  if (wt.shape === '2d' || (wt.shape === '1d' && t.y !== 0)) return false;
  const row = wt.rows[t.y];
  if (!row) return false;
  if (wt.fixed) return t.x >= 0 && t.x < row.length;
  return t.x >= 0 && t.x <= row.length && room;
}

/** Insert into a line: a fixed line shifts towards its end into the first empty slot at or after x (else the last slot drops out). */
function insertAt(w: Work, y: number, x: number, id: Slot): void {
  if (w.wt.fixed) {
    let e = w.rows[y].indexOf(null, x);
    if (e < 0) e = w.rows[y].length - 1;
    w.del(y, e);
  }
  w.ins(y, x, id);
}

/** Put table `id` at a target: replace a slot, insert into a line, or add a row. */
export function placeTable(wt: Wavetable, t: SlotTarget, id: TableId): WavetableEdit {
  if (!canTarget(wt, t)) return unchanged(wt);
  const w = new Work(wt);
  if (t.kind === 'slot') {
    if (wt.rows[t.y][t.x] === id) return unchanged(wt);
    w.row(t.y)[t.x] = id;
  } else if (t.kind === 'row') w.insRow(t.y, [id]);
  else insertAt(w, t.y, t.x, id);
  return w.done();
}

/** Empty a slot (it stays, as an empty slot). */
export function clearSlot(wt: Wavetable, x: number, y: number): WavetableEdit {
  if (wt.builtin || cellAt(wt, x, y) === null) return unchanged(wt);
  const w = new Work(wt);
  w.row(y)[x] = null;
  return w.done();
}

/**
 * Remove a slot: a variable 1D line closes up; a fixed one closes up and gains an empty
 * slot at its end; a Rows row closes up (an emptied row is removed); a 2D cell is emptied.
 */
export function removeSlot(wt: Wavetable, x: number, y: number): WavetableEdit {
  if (wt.builtin || x < 0 || x >= (wt.rows[y]?.length ?? 0)) return unchanged(wt);
  if (wt.shape === '2d') return clearSlot(wt, x, y);
  const w = new Work(wt);
  w.del(y, x);
  if (wt.fixed) w.ins(y, w.rows[y].length, null);
  else if (wt.shape === 'rows' && !w.rows[y].length) w.delRow(y);
  return w.done();
}

/**
 * Move the slot at `from` within the wavetable: onto a slot = swap the two; into a gap =
 * take it out and insert it there (a pure reorder: a fixed line keeps its slots); as a
 * new row (Rows). A Rows row emptied by the move is removed. `copy` leaves the source.
 */
export function moveSlot(wt: Wavetable, from: Cell, t: SlotTarget, copy = false): WavetableEdit {
  const id = cellAt(wt, from.x, from.y);
  if (wt.builtin || from.x < 0 || from.x >= (wt.rows[from.y]?.length ?? 0)) return unchanged(wt);
  if (copy) return id === null ? unchanged(wt) : placeTable(wt, t, id);
  if (!canTarget(wt, t, false)) return unchanged(wt);
  const w = new Work(wt);
  if (t.kind === 'slot') {
    if (t.x === from.x && t.y === from.y) return unchanged(wt);
    const other = wt.rows[t.y][t.x];
    w.row(from.y)[from.x] = other;
    w.row(t.y)[t.x] = id;
    return w.done();
  }
  if (t.kind === 'gap') {
    if (t.y === from.y && (t.x === from.x || t.x === from.x + 1)) return unchanged(wt);
    w.del(from.y, from.x);
    const tx = t.y === from.y && t.x > from.x ? t.x - 1 : t.x;
    w.ins(t.y, tx, id);
    if (wt.shape === 'rows' && t.y !== from.y && !w.rows[from.y].length) w.delRow(from.y);
    return w.done();
  }
  if (wt.rows[from.y].length === 1 && (t.y === from.y || t.y === from.y + 1)) return unchanged(wt);
  w.del(from.y, from.x);
  w.insRow(t.y, [id]);
  const src = t.y <= from.y ? from.y + 1 : from.y;
  if (!w.rows[src].length) w.delRow(src);
  return w.done();
}

/** Filled slots a 2D resize to W × H would drop. */
export function droppedBy2DResize(wt: Wavetable, W: number, H: number): number {
  let n = 0;
  wt.rows.forEach((r, y) => r.forEach((id, x) => (n += id !== null && (x >= W || y >= H) ? 1 : 0)));
  return n;
}

/**
 * Resize a 2D grid to W × H (1..MAX_GRID each): cells keep their (x, y); growing adds
 * empty cells on the right / bottom, shrinking drops the cells outside. The head is
 * clamped into the grid.
 */
export function resize2D(wt: Wavetable, W: number, H: number): WavetableEdit {
  W = Math.max(1, Math.min(MAX_GRID, Math.round(W)));
  H = Math.max(1, Math.min(MAX_GRID, Math.round(H)));
  if (wt.shape !== '2d' || wt.builtin) return unchanged(wt);
  const { w: W0, h: H0 } = wavetableDims(wt);
  if (W === W0 && H === H0) return unchanged(wt);
  const rows = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => wt.rows[y]?.[x] ?? null));
  const head = { x: Math.max(0, Math.min(W - 1, wt.head.x)), y: Math.max(0, Math.min(H - 1, wt.head.y)) };
  return { wt: { ...wt, rows, head }, map: null, reset: false };
}

/** Filled slots a fixed 1D length of `len` would drop. */
export function droppedBy1DResize(wt: Wavetable, len: number): number {
  return (wt.rows[0] ?? []).slice(Math.max(0, len)).filter((id) => id !== null).length;
}

/**
 * 1D size: variable (grows; its slots are kept) or fixed at `len` slots (1..MAX_SLOTS;
 * default: the current count, at least 1): shrinking drops slots from the end, growing
 * appends empty ones. Write settings are re-normalized (fixed: wrap / stop; variable:
 * stop / grow); a head that can no longer write restarts at the line start.
 */
export function resize1D(wt: Wavetable, fixed: boolean, len?: number): WavetableEdit {
  if (wt.shape !== '1d' || wt.builtin) return unchanged(wt);
  const L = wt.rows[0].length;
  const n = fixed ? Math.max(1, Math.min(MAX_SLOTS, Math.round(len ?? L))) : L;
  if (fixed === wt.fixed && n === L) return unchanged(wt);
  const w = new Work(wt);
  if (n < L) {
    w.row(0).length = n;
    w.axis().length = n;
    w.x = Math.min(w.x, n);
  } else for (let i = L; i < n; i++) w.ins(0, i, null);
  const e = w.done();
  const write = normalizeWrite('1d', fixed, wt.write);
  return { wt: withValidHead({ ...e.wt, fixed, write }), map: e.map, reset: false };
}

/** Keep the head if it can still write, else restart it where a fresh head would start. */
function withValidHead(wt: Wavetable): Wavetable {
  if (previewWrites(wt, 1).writes.length) return wt;
  const head = startHead(wt.shape, wt.rows, wt.write);
  return head.x === wt.head.x && head.y === wt.head.y ? wt : { ...wt, head };
}

/** Change write head settings (coerced per shape; see normalizeWrite). */
export function setWrite(wt: Wavetable, patch: Partial<WriteSettings>): Wavetable {
  const write = normalizeWrite(wt.shape, wt.fixed, { ...wt.write, ...patch });
  if ((Object.keys(write) as (keyof WriteSettings)[]).every((k) => wt.write[k] === write[k])) return wt;
  return withValidHead({ ...wt, write });
}

/**
 * Move the write head (clamped: 1D x in −1..length, i.e. one past either end of the line;
 * 2D inside the grid; Rows y up to the row count (= a new row), x within that row ±1).
 */
export function setHead(wt: Wavetable, x: number, y: number): Wavetable {
  let hx = Math.round(x);
  let hy = Math.round(y);
  if (wt.shape === '2d') {
    const { w, h } = wavetableDims(wt);
    hx = Math.max(0, Math.min(w - 1, hx));
    hy = Math.max(0, Math.min(h - 1, hy));
  } else {
    hy = wt.shape === '1d' ? 0 : Math.max(0, Math.min(wt.rows.length, hy));
    hx = Math.max(-1, Math.min(wt.rows[hy]?.length ?? 0, hx));
  }
  return hx === wt.head.x && hy === wt.head.y ? wt : { ...wt, head: { x: hx, y: hy } };
}

/**
 * A new, empty user wavetable (frozen until made live): 1D variable (writes append);
 * 2D W × H (default 8×8; fills row by row, wrapping); Rows (each batch a new row).
 */
export function newWavetable(id: WavetableId, name: string, shape: WavetableShape, W = GRID_SIZE, H = GRID_SIZE): Wavetable {
  if (shape === '2d') {
    W = Math.max(1, Math.min(MAX_GRID, Math.round(W)));
    H = Math.max(1, Math.min(MAX_GRID, Math.round(H)));
    return make2D(id, name, W, H, [], { write: { dir: '+x', edge: 'wrap', onWrap: 'next', mode: 'replace', batch: 'continue' } });
  }
  if (shape === 'rows') return makeRows(id, name, [], { write: { batch: 'newRow' } });
  return make1D(id, name, []);
}

/**
 * An editable copy (frozen: a snapshot until made live): same shape, slots, settings and
 * head; it pins its waveforms. Copies over MAX_SLOTS keep the newest slots / rows.
 */
export function duplicateWavetable(wt: Wavetable, id: WavetableId, name: string): Wavetable {
  let rows = wt.rows.map((r) => r.slice());
  let head = wt.head;
  if (wt.shape === '1d' && rows[0].length > MAX_SLOTS) {
    const cut = rows[0].length - MAX_SLOTS;
    rows = [rows[0].slice(cut)];
    head = { x: Math.max(-1, head.x - cut), y: 0 };
  } else if (wt.shape === 'rows') {
    let n = slotCount(wt);
    let cut = 0;
    while (n > MAX_SLOTS) n -= rows[cut++].length;
    if (cut) {
      rows = rows.slice(cut);
      head = { x: head.x, y: Math.max(0, head.y - cut) };
    }
  }
  return {
    id,
    name,
    shape: wt.shape,
    rows,
    fixed: wt.fixed,
    interp: wt.interp,
    live: false,
    write: normalizeWrite(wt.shape, wt.fixed, wt.write),
    head,
    pins: true,
  };
}

// ---- write preview ----

/**
 * One of the next writes, in the wavetable's current coordinates: `replace` overwrites
 * cell (x, y); `insert` goes into the gap before slot x of row y; `append` grows row y
 * (y may be a row that doesn't exist yet: a new row).
 */
export interface PendingWrite {
  readonly n: number;
  readonly kind: 'replace' | 'insert' | 'append';
  readonly x: number;
  readonly y: number;
}

/**
 * Where the next `n` waveforms (one batch) would land if the wavetable were live, by
 * running the real write head on a copy. `fresh` = the batch starts the line afresh
 * (1D "new row": the current slots are replaced). Empty when the head is stopped.
 */
export function previewWrites(wt: Wavetable, n: number): { writes: PendingWrite[]; fresh: boolean } {
  const SPAN = 1 << 16;
  const GHOST = 2 ** 40;
  const rows = wt.rows.map((r, y) => r.map((_, x) => -2 - (y * SPAN + x)));
  const w = new Work({ ...wt, live: true, rows });
  if (wt.write.batch === 'newRow') startBatch(w);
  const writes: PendingWrite[] = [];
  const ghosts = new Map<number, PendingWrite>();
  const insert = wt.write.mode === 'insert' && wt.shape !== '2d';
  // A fixed line inserting towards −x puts the new slot after the head's slot.
  const after = insert && wt.fixed && wt.write.dir === '-x' ? 1 : 0;
  for (let k = 0; k < n; k++) {
    const cur = w.rows[w.y]?.[w.x];
    let pw: PendingWrite;
    if (cur !== undefined && cur !== null && cur >= GHOST) pw = { ...ghosts.get(cur)!, n: k + 1 };
    else if (cur !== undefined && cur !== null) {
      const c = -2 - cur;
      pw = { n: k + 1, kind: insert ? 'insert' : 'replace', x: (c % SPAN) + after, y: Math.floor(c / SPAN) };
    } else pw = { n: k + 1, kind: 'append', x: -1, y: w.y };
    if (!writeOne(w, GHOST + k)) break;
    writes.push(pw);
    ghosts.set(GHOST + k, pw);
  }
  return { writes, fresh: w.reset };
}
