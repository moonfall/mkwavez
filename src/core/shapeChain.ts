/**
 * Shape chains: an ordered list of steps (core/shapeSteps.ts) applied to a source table,
 * saved, replayed on any table, applied to whole batches. A chain is plain JSON; the
 * engine is pure and deterministic, shared by the preview, Add and renderRecipe().
 *
 * Pipeline: the source (a finished table) → each enabled step at its amount (swept across
 * a batch if it has amountEnd), band-limited to KMAX after every step, level and DC carried
 * (no normalising between steps, so Gain drives and an offset makes a clip asymmetric) →
 * shape() (DC off, band-limit, optional phase realign, peak normalise). Seeds: each step's seed derives from the chain seed and the step's id, so
 * adding, removing or reordering other steps doesn't change it; `varySeed` further derives
 * one per batch index.
 */
import { TABLE_SIZE } from './constants';
import { deriveSeed } from './prng';
import { shape } from './shape';
import { rulesUseBatch, type RuleCompiler } from './generators/harmonicRules';
import { applyStep, bandLimit, normalizeStep, stepUsesSeed, type ShapeStep } from './shapeSteps';
import type { Recipe, TableId } from './table';

export interface ShapeChain {
  readonly v: 1;
  readonly name: string;
  readonly seed: number;
  /** Seeded steps use a different seed for each waveform of a batch. */
  readonly varySeed: boolean;
  /** Rotate the result so its fundamental has sine phase, like every other table. */
  readonly realign: boolean;
  readonly steps: readonly ShapeStep[];
}

export interface BatchPos {
  readonly index: number;
  readonly count: number;
}

/** What a chain needs from its host: a rule compiler for Rules steps, an optional abort hook. */
export interface ChainEnv {
  readonly compileRule?: RuleCompiler;
  readonly abort?: () => boolean;
}

/**
 * A step failed (a Rules step whose rule doesn't compile, throws or gives a non-finite value):
 * which step, why, and the working cycles of the steps before it.
 */
export class ShapeStepError extends Error {
  constructor(
    readonly index: number,
    readonly stepId: string,
    override readonly cause: unknown,
    readonly stages: readonly Float64Array<ArrayBufferLike>[],
  ) {
    super(`Step ${index + 1}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export const MAX_STEPS = 32;
export const MAX_CHAIN_NAME = 60;
export const SHAPE_OP = 'shape';

export const EMPTY_CHAIN: ShapeChain = { v: 1, name: 'Untitled chain', seed: 1, varySeed: false, realign: true, steps: [] };

/** Batch position → u ∈ [0, 1] (0 for a single waveform). */
export const batchUOf = (b: BatchPos) => (b.count > 1 ? b.index / (b.count - 1) : 0);

/** A step's amount for batch position u: swept from amount to amountEnd when it has one. */
export function stepAmount(s: ShapeStep, u: number): number {
  return s.amountEnd === undefined ? s.amount : s.amount + (s.amountEnd - s.amount) * u;
}

/** True if a step sweeps across a batch: its amount, its drawing (to an end drawing), or Rules that read n / u. */
export function stepSweeps(s: ShapeStep): boolean {
  if (s.amountEnd !== undefined && s.amountEnd !== s.amount) return true;
  if (s.op === 'rules' && rulesUseBatch(s.rules)) return true;
  return 'draw' in s && !!s.drawEnd && JSON.stringify(s.drawEnd) !== JSON.stringify(s.draw);
}

/** True if any enabled step sweeps across a batch (one source then gives N different results). */
export function chainSweeps(c: ShapeChain): boolean {
  return c.steps.some((s) => s.on && stepSweeps(s));
}

/** True if any enabled step uses its seed (the UI shows the seed / Reroll only then). */
export function chainUsesSeed(c: ShapeChain): boolean {
  return c.steps.some((s) => s.on && stepUsesSeed(s));
}

/** 32-bit FNV-1a of a string (step id → seed stream). */
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The seed step `s` uses for batch position `b`. */
export function stepSeed(c: ShapeChain, s: ShapeStep, b: BatchPos): number {
  const own = deriveSeed(c.seed, hashStr(s.id));
  return c.varySeed ? deriveSeed(own, b.index) : own;
}

/**
 * A valid chain from untrusted data (imports, recipes, old sessions): numbers clamped,
 * unknown steps dropped, missing / duplicate step ids replaced, at most MAX_STEPS steps,
 * fields in a fixed order (so JSON.stringify is canonical). Idempotent.
 */
export function normalizeChain(raw: unknown): ShapeChain {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const seen = new Set<string>();
  const steps: ShapeStep[] = [];
  let n = 0;
  for (const r of Array.isArray(o.steps) ? o.steps : []) {
    if (steps.length >= MAX_STEPS) break;
    let id = r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string' ? String((r as { id: string }).id).slice(0, 24) : '';
    while (!id || seen.has(id)) id = `s${++n}`;
    const s = normalizeStep(r, id);
    if (!s) continue;
    seen.add(id);
    steps.push(s);
  }
  const seed = Number(o.seed);
  return {
    v: 1,
    name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, MAX_CHAIN_NAME) : EMPTY_CHAIN.name,
    seed: Number.isFinite(seed) ? seed >>> 0 : 1,
    varySeed: !!o.varySeed,
    realign: o.realign === undefined ? true : !!o.realign,
    steps,
  };
}

/** A step id not used in the chain. */
export function freshStepId(c: ShapeChain): string {
  const used = new Set(c.steps.map((s) => s.id));
  let n = c.steps.length + 1;
  while (used.has(`s${n}`)) n++;
  return `s${n}`;
}

/**
 * The working cycle after each step (index i = after step i; a disabled step or one at
 * amount 0 passes its input on unchanged). Not normalised. `reuse` = stages already
 * computed for the same source, batch position and first `reuse.length` steps (the
 * editor keeps them while a later step changes); computing resumes after them. A failing
 * step throws a ShapeStepError (with the stages before it).
 */
export function chainStages(
  src: ArrayLike<number>,
  c: ShapeChain,
  b: BatchPos,
  reuse: readonly Float64Array<ArrayBufferLike>[] = [],
  env: ChainEnv = {},
): Float64Array<ArrayBufferLike>[] {
  if (src.length !== TABLE_SIZE) throw new Error(`chainStages: expected ${TABLE_SIZE} samples, got ${src.length}`);
  const u = batchUOf(b);
  const from = Math.min(reuse.length, c.steps.length);
  const out = reuse.slice(0, from);
  let x: Float64Array<ArrayBufferLike> = from ? out[from - 1] : Float64Array.from(src);
  for (let i = from; i < c.steps.length; i++) {
    const s = c.steps[i];
    const a = stepAmount(s, u);
    if (s.on && a > 0) {
      try {
        x = bandLimit(applyStep(s, x, a, stepSeed(c, s, b), u, { compileRule: env.compileRule, abort: env.abort, index: b.index, count: b.count }));
      } catch (e) {
        throw new ShapeStepError(i, s.id, e, out.slice());
      }
    }
    out.push(x);
  }
  return out;
}

/** The finished table from the last working cycle (or the source, for an empty chain). */
export function finishChain(x: ArrayLike<number>, c: ShapeChain): Float32Array {
  return shape(x, { align: c.realign });
}

/** Apply the chain to a source table at batch position b (a Rules step needs env.compileRule). */
export function applyChain(src: ArrayLike<number>, c: ShapeChain, b: BatchPos = { index: 0, count: 1 }, env: ChainEnv = {}): Float32Array {
  const stages = chainStages(src, c, b, [], env);
  return finishChain(stages.length ? stages[stages.length - 1] : src, c);
}

/** Canonical JSON of a normalised chain (what recipes store). */
export const chainJson = (c: ShapeChain) => JSON.stringify(normalizeChain(c));

/** Recipe of the table made by applying chain c to table `parent`. */
export function shapeRecipe(parent: TableId, c: ShapeChain, b: BatchPos): Recipe {
  const n = normalizeChain(c);
  return {
    op: SHAPE_OP,
    params: { name: n.name, steps: n.steps.filter((s) => s.on).length, chain: JSON.stringify(n) },
    seed: n.seed,
    parents: [parent],
    batch: { index: b.index, count: b.count },
  };
}

/** The chain recorded in a recipe ('shape' recipes, or any recipe shaped on add), or null. */
export function recipeChain(r: Recipe): ShapeChain | null {
  const raw = r.op === SHAPE_OP ? r.params.chain : r.shape;
  if (typeof raw !== 'string') return null;
  try {
    return normalizeChain(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Re-render a 'shape' recipe from its parent's data. */
export function renderShapeRecipe(r: Recipe, resolveTable: (id: TableId) => Float32Array | undefined, env: ChainEnv = {}): Float32Array {
  const c = recipeChain(r);
  if (!c) throw new Error('renderShapeRecipe: no chain in the recipe');
  const src = resolveTable(r.parents[0]);
  if (!src) throw new Error(`renderShapeRecipe: parent ${r.parents[0]} not available`);
  return applyChain(src, c, r.batch ?? { index: 0, count: 1 }, env);
}
