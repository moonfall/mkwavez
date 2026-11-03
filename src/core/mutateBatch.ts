/**
 * Mutation batches: turn one source table (plus an optional mate for 'breed') into
 * 1..N new tables with recipes, and re-render any of them from its recipe.
 *
 * Seeding: one seed per Apply. A single Apply and every table of a Linear/Log sweep use
 * that seed, so the preview matches the result and a random sweep is one direction
 * growing gradually. Chain step j (0-based) uses chainStepSeed(seed, j); step 0 is the
 * seed itself, so the first chain table equals the preview.
 *
 * Recipe (op 'mutate'):
 *   params  { mutation, amount (this table's), batchAmount (A), mode }
 *   seed    the Apply's seed
 *   parents [sourceId] or [sourceId, mateId] for 'breed'
 *   batch   { index, count }
 * A chain table at index i is i+1 compounding steps from the source, so it re-renders
 * from the source alone (no intermediate tables needed).
 */
import { mutate, sweepAmounts, type MutationId, type SweepMode } from './mutations';
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

function amountsFor(req: MutateRequest, count: number): number[] {
  if (req.mode === 'single' || req.mode === 'chain') return new Array<number>(count).fill(req.amount);
  return sweepAmounts(count, req.amount, req.mode);
}

/**
 * Generate the tables for one Apply. `mate` is required for 'breed' (without it breed
 * is the identity); it is recorded as the second parent.
 */
export function mutateBatch(req: MutateRequest, source: WaveTable, mate?: WaveTable): GeneratedTable[] {
  const count = req.mode === 'single' ? 1 : Math.max(1, Math.round(req.count));
  const seed = req.seed >>> 0;
  const ctx = req.mutation === 'breed' && mate ? { breedPool: [mate.data] } : {};
  const parents: TableId[] = req.mutation === 'breed' && mate ? [source.id, mate.id] : [source.id];
  const amounts = amountsFor(req, count);
  const out: GeneratedTable[] = [];
  let chain = source.data;
  for (let i = 0; i < count; i++) {
    let data: Float32Array;
    if (req.mode === 'chain') {
      chain = mutate(req.mutation, chain, req.amount, chainStepSeed(seed, i), ctx);
      data = chain;
    } else {
      data = mutate(req.mutation, source.data, amounts[i], seed, ctx);
    }
    const recipe: Recipe = {
      op: 'mutate',
      params: { mutation: req.mutation, amount: amounts[i], batchAmount: req.amount, mode: req.mode },
      seed,
      parents,
      batch: { index: i, count },
    };
    out.push({ data, recipe });
  }
  return out;
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
  if (r.params.mode === 'chain') {
    let x = src;
    const steps = (r.batch?.index ?? 0) + 1;
    for (let j = 0; j < steps; j++) x = mutate(mutation, x, amount, chainStepSeed(r.seed, j), ctx);
    return x;
  }
  return mutate(mutation, src, amount, r.seed, ctx);
}
