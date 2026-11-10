import { BREED_OPS } from './breed';
import { MUTATIONS } from './mutations';

/** Stable table identifier (monotonic per project; never reused). */
export type TableId = number;

export type ParamValue = number | string | boolean;

/**
 * How a table was made. Plain data: enough to re-render the table deterministically
 * (given the same code version), and to trace lineage via `parents`.
 */
export interface Recipe {
  /** Generator or mutation id, e.g. 'basic', 'formula', 'perlin', 'ca', 'mutate', 'breed'. */
  readonly op: string;
  readonly params: Readonly<Record<string, ParamValue>>;
  /** uint32 seed for every random choice the op makes. */
  readonly seed: number;
  /** Source tables (empty for seed generators). */
  readonly parents: readonly TableId[];
  /** Position within the batch that produced this table, if any. */
  readonly batch?: { readonly index: number; readonly count: number };
  /**
   * A Shape chain (canonical JSON, core/shapeChain.ts) applied after the op: set on tables
   * shaped on add (Seed / Mutate / Breed's Shape chip). Absent = unshaped.
   */
  readonly shape?: string;
}

/** An immutable, shaped, single-cycle table plus its recipe. Never mutate `data`. */
export interface WaveTable {
  readonly id: TableId;
  readonly data: Float32Array;
  readonly recipe: Recipe;
}

/** Output of a generator before an id is assigned. */
export interface GeneratedTable {
  readonly data: Float32Array;
  readonly recipe: Recipe;
}

export class IdAllocator {
  next: TableId;
  constructor(start: TableId = 1) {
    this.next = start;
  }
  take(): TableId {
    return this.next++;
  }
}

export function makeTable(id: TableId, g: GeneratedTable): WaveTable {
  return Object.freeze({ id, data: g.data, recipe: g.recipe });
}

/**
 * Recipe of a copy of table `parentId`: the parent's recipe (so the copy re-renders the
 * same way even after the parent is evicted) plus `params.copyOf` = the copied table's id.
 * A copy of a copy points at its immediate source.
 */
export function copyRecipe(parentId: TableId, r: Recipe): Recipe {
  return { ...r, params: { ...r.params, copyOf: parentId } };
}

/** Short human-readable recipe summary for UI labels. */
export function describeRecipe(r: Recipe): string {
  let desc = describeOp(r);
  if (r.shape !== undefined) desc += ` · shaped: ${shapeName(r.shape)}`;
  return r.params.copyOf === undefined ? desc : `${desc} · copy of id ${String(r.params.copyOf)}`;
}

/** A chain's name from its JSON, without depending on core/shapeChain.ts. */
function shapeName(json: string): string {
  try {
    const n = (JSON.parse(json) as { name?: unknown }).name;
    return typeof n === 'string' && n ? n : 'chain';
  } catch {
    return 'chain';
  }
}

function describeOp(r: Recipe): string {
  const b = r.batch && r.batch.count > 1 ? ` ${r.batch.index + 1}/${r.batch.count}` : '';
  const p = r.params;
  switch (r.op) {
    case 'basic':
      return `${String(p.wave)}${p.wave === 'noise' ? ` seed ${r.seed}` : ''}`;
    case 'formula':
      return `${p.name ? String(p.name) : 'formula'}${p.edited ? ' (edited)' : ''}${b}`;
    case 'rules':
      return `${p.name ? String(p.name) : 'Harmonic rules'} (rules${p.edited ? ', edited' : ''})${b}`;
    case 'pulse':
      return `pulse ${Math.round(Number(p.width) * 100)}→${Math.round(Number(p.widthEnd) * 100)}%${b}`;
    case 'perlin':
      return `perlin${b} seed ${r.seed}`;
    case 'sample':
      return `${String(p.mode ?? 'sample')}${b} of “${String(p.take ?? 'take')}” at ${String(p.at)} s · ${String(p.freq)} Hz`;
    case 'ca':
      return `CA rule ${String(p.rule)} gen ${String(p.generation)}`;
    case 'mutate': {
      const pct = Math.round(Number(p.amount) * 1000) / 10;
      const mode = p.mode === 'chain' ? ' chain' : p.mode === 'log' ? ' log' : '';
      const label = MUTATIONS.find((m) => m.id === p.mutation)?.label ?? String(p.mutation);
      return `${label} ${pct}%${mode}${b} of id ${r.parents.join('×')}`;
    }
    case 'breed': {
      const pct = Math.round(Number(p.bias) * 1000) / 10;
      const mode = p.mode === 'gen' ? ' gen' : '';
      const label = BREED_OPS.find((o) => o.id === p.breed)?.label ?? String(p.breed);
      return `${label} ${pct}%${mode}${b} of id ${r.parents.join('×')}`;
    }
    case 'shape': {
      const n = Number(p.steps);
      return `${p.name ? String(p.name) : 'Shape'} · ${n} step${n === 1 ? '' : 's'}${b} of id ${r.parents.join('×')}`;
    }
    default:
      // Parameter modes (core/generators/paramModes.ts) record their library name.
      return `${p.name ? String(p.name) : r.op}${p.glyph ? ` “${String(p.glyph)}”` : ''}${b}`;
  }
}
