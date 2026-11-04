/**
 * Mutation batches: turn one source table (plus an optional mate for 'breed') into
 * 1..N new tables with recipes, and re-render any of them from its recipe.
 *
 * Seeding: one seed per Apply. A single Apply and every table of a Linear/Log sweep use
 * that seed, so the preview matches the result and a random sweep is one direction
 * growing gradually. Chain step j (0-based) uses chainStepSeed(seed, j); step 0 is the
 * seed itself, so the first chain table equals a single Apply. The Mutate tab previews a
 * whole batch via mutateBatchTable() and adds it (or one table of it) unchanged.
 *
 * Recipe (op 'mutate'):
 *   params  { mutation, amount (this table's), batchAmount (A), mode, rev (MUTATION_REV;
 *             absent in recipes made before revisions: 1) }
 *   seed    the Apply's seed
 *   parents [sourceId] or [sourceId, mateId] for 'breed'
 *   batch   { index, count }
 * A chain table at index i is i+1 compounding steps from the source, so it re-renders
 * from the source alone (no intermediate tables needed).
 */
import { mutate, MUTATION_REV, sweepAmounts, type MutationId, type SweepMode } from './mutations';
import { deriveSeed, Prng } from './prng';
import type { GeneratedTable, Recipe, TableId, WaveTable } from './table';

export type MutateMode = 'single' | SweepMode;

export interface MutateRequest {
  mutation: MutationId;
  /** A: the amount for a single Apply, the end point of a sweep, the per-step amount of a chain. */
  amount: number;
  seed: number;
  mode: MutateMode;
  /** Number of tables (forced to 1 for 'single'). */
  count: number;
}

/** Seed for chain step j (0-based). */
export function chainStepSeed(seed: number, step: number): number {
  return step === 0 ? seed >>> 0 : deriveSeed(seed, step);
}

/** Which pool entry 'breed' uses as its mate for this seed (one mate per Apply). */
export function pickMateIndex(seed: number, poolLength: number): number {
  return poolLength > 0 ? new Prng(seed).int(poolLength) : -1;
}

/** Number of tables an Apply makes (1 for 'single'). */
export function batchCount(req: MutateRequest): number {
  return req.mode === 'single' ? 1 : Math.max(1, Math.round(req.count));
}

/** Amount of table i: A for single / chain, the sweep amount for lin / log. */
export function batchAmountAt(req: MutateRequest, i: number): number {
  if (req.mode === 'single' || req.mode === 'chain') return req.amount;
  return sweepAmounts(batchCount(req), req.amount, req.mode)[i];
}

/**
 * Table i of an Apply, exactly as mutateBatch() returns it. Lets a preview compute the
 * batch incrementally (shown table first). A chain needs `prev` = table i−1's data
 * (ignored for i = 0 and for the other modes); `mate` as for mutateBatch().
 */
export function mutateBatchTable(
  req: MutateRequest,
  source: WaveTable,
  i: number,
  prev?: Float32Array,
  mate?: WaveTable,
): GeneratedTable {
  const count = batchCount(req);
  const seed = req.seed >>> 0;
  const ctx = req.mutation === 'breed' && mate ? { breedPool: [mate.data] } : {};
  const parents: TableId[] = req.mutation === 'breed' && mate ? [source.id, mate.id] : [source.id];
  const amount = batchAmountAt(req, i);
  let data: Float32Array;
  if (req.mode === 'chain') {
    if (i > 0 && !prev) throw new Error('mutateBatchTable: chain step needs the previous table');
    data = mutate(req.mutation, i > 0 ? prev! : source.data, req.amount, chainStepSeed(seed, i), ctx);
  } else {
    data = mutate(req.mutation, source.data, amount, seed, ctx);
  }
  const recipe: Recipe = {
    op: 'mutate',
    params: { mutation: req.mutation, amount, batchAmount: req.amount, mode: req.mode, rev: MUTATION_REV },
    seed,
    parents,
    batch: { index: i, count },
  };
  return { data, recipe };
}

/**
 * Generate the tables for one Apply. `mate` is required for 'breed' (without it breed
 * is the identity); it is recorded as the second parent.
 */
export function mutateBatch(req: MutateRequest, source: WaveTable, mate?: WaveTable): GeneratedTable[] {
  const out: GeneratedTable[] = [];
  for (let i = 0; i < batchCount(req); i++) out.push(mutateBatchTable(req, source, i, out[i - 1]?.data, mate));
  return out;
}

/**
 * The mutation revision a recipe was made at: an integer from 1 to MUTATION_REV; anything
 * else (absent — recipes from before revisions — or not a valid revision) is 1.
 */
export function recipeRev(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MUTATION_REV ? v : 1;
}

/** Re-render a 'mutate' recipe; `resolve` supplies parent table data by id. */
export function renderMutateRecipe(r: Recipe, resolve: (id: TableId) => Float32Array | undefined): Float32Array {
  const src = resolve(r.parents[0]);
  if (!src) throw new Error(`renderMutateRecipe: parent ${r.parents[0]} unavailable`);
  const mutation = r.params.mutation as MutationId;
  let ctx = {};
  if (mutation === 'breed' && r.parents.length > 1) {
    const mate = resolve(r.parents[1]);
    if (!mate) throw new Error(`renderMutateRecipe: mate ${r.parents[1]} unavailable`);
    ctx = { breedPool: [mate] };
  }
  const amount = Number(r.params.amount);
  const rev = recipeRev(r.params.rev);
  if (r.params.mode === 'chain') {
    let x = src;
    const steps = (r.batch?.index ?? 0) + 1;
    for (let j = 0; j < steps; j++) x = mutate(mutation, x, amount, chainStepSeed(r.seed, j), ctx, rev);
    return x;
  }
  return mutate(mutation, src, amount, r.seed, ctx, rev);
}
