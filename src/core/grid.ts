/**
 * Grid builder (Generate → Grid): a 2D block of waveforms from two batch operations. The
 * columns are a batch (another Generate tab's, or waveforms already in the Timeline); the
 * rows apply a row operation (a Mutate sweep, or a Shape chain) to each column at batch
 * positions 0…n−1. Cell (column c, row r): with `row1`, row 0 is the column itself and
 * rows 1…H−1 are the row operation at positions 0…H−2 (count H−1); without it, row r is
 * the operation at position r (count H).
 *
 * Recipes: a row table's parent is its column. New columns (not yet in the Timeline) are
 * referred to by a batch-local placeholder id (columnRef), which AppModel.addTables
 * resolves to the column's id once ids are assigned (columns are added first, in the same
 * batch). Pure and deterministic.
 */
import { mutateBatchTable, type MutateRequest } from './mutateBatch';
import type { MutationId, SweepMode } from './mutations';
import { applyChain, chainSweeps, shapeRecipe, type ChainEnv, type ShapeChain } from './shapeChain';
import type { GeneratedTable, TableId, WaveTable } from './table';

/** Largest side of a grid. */
export const GRID_MAX = 32;
/** Most cells in a grid (the largest wavetable holds 1,024 slots). */
export const GRID_MAX_CELLS = 1024;

export type GridRowOp =
  | { readonly kind: 'mutate'; readonly mutation: MutationId; readonly amount: number; readonly mode: SweepMode; readonly seed: number }
  | { readonly kind: 'shape'; readonly chain: ShapeChain };

/**
 * Batch-local placeholder for new column k in an add (parents < 0 are resolved by
 * AppModel.addTables to the id of the k-th table of the same add).
 */
export const columnRef = (k: number): TableId => -1 - k;
/** The add index a placeholder refers to, or −1 for a real id. */
export const refIndex = (id: TableId): number => (id < 0 ? -1 - id : -1);

/** Rows the row operation makes for a grid of H rows. */
export const opRows = (H: number, row1: boolean) => Math.max(0, row1 ? H - 1 : H);

/** Where column c, row r goes (x, y) in the grid: columns along X, or along Y when swapped. */
export const gridXY = (c: number, r: number, swap: boolean) => (swap ? { x: r, y: c } : { x: c, y: r });

/** Grid size (W × H in the wavetable) for `cols` columns and `rows` rows. */
export const gridDims = (cols: number, rows: number, swap: boolean) => (swap ? { w: rows, h: cols } : { w: cols, h: rows });

/** Why a grid of cols × rows can't be built, or null. */
export function gridLimit(cols: number, rows: number): string | null {
  if (cols < 1 || rows < 1) return 'The grid is empty';
  if (cols > GRID_MAX || rows > GRID_MAX) return `At most ${GRID_MAX} × ${GRID_MAX}`;
  if (cols * rows > GRID_MAX_CELLS) return `At most ${GRID_MAX_CELLS} waveforms`;
  return null;
}

/** True if the row operation gives different rows (else every row would be the same). */
export function rowOpVaries(op: GridRowOp): boolean {
  if (op.kind === 'mutate') return op.amount > 0;
  return chainSweeps(op.chain) || (op.chain.varySeed && op.chain.steps.some((s) => s.on));
}

/**
 * Row table j (of `count`) of column `col` (its id may be a columnRef). A Mutate chain
 * needs `prev` = row j−1's data (ignored for j = 0); a chain with a Rules step needs
 * env.compileRule (and throws a ShapeStepError if a rule fails).
 */
export function gridRowTable(op: GridRowOp, col: WaveTable, j: number, count: number, prev?: Float32Array, env: ChainEnv = {}): GeneratedTable {
  if (op.kind === 'mutate') {
    const req: MutateRequest = { mutation: op.mutation, amount: op.amount, seed: op.seed, mode: op.mode, count };
    return mutateBatchTable(req, col, j, prev);
  }
  const b = { index: j, count };
  return { data: applyChain(col.data, op.chain, b, env), recipe: shapeRecipe(col.id, op.chain, b) };
}

/** Relative RMS difference of b from a (0 = equal; 1 = as different as a is loud). */
export function relDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let d = 0;
  let e = 0;
  for (let i = 0; i < a.length; i++) {
    d += (a[i] - b[i]) ** 2;
    e += a[i] ** 2;
  }
  return e > 0 ? Math.sqrt(d / e) : d > 0 ? 1 : 0;
}

/**
 * Whether row 1 should be the columns themselves: true when the row operation's first row
 * stays close to the column (so the originals join smoothly); false when it starts away
 * from it (e.g. a chain whose first card is a filter that is already closed).
 */
export function row1Fits(op: GridRowOp, col: WaveTable, rows: number, env: ChainEnv = {}): boolean {
  if (op.kind === 'mutate') return true;
  let first: GeneratedTable;
  try {
    first = gridRowTable(op, col, 0, Math.max(1, rows - 1), undefined, env);
  } catch {
    return true; // a failing chain: the rows report the error
  }
  return relDiff(col.data, first.data) < 0.35;
}
