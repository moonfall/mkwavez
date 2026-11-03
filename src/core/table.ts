/** Stable table identifier (monotonic per project; never reused). */
export type TableId = number;

export type ParamValue = number | string | boolean;

/**
 * How a table was made. Plain data: enough to re-render the table deterministically
 * (given the same code version), and to trace lineage via `parents`.
 */
export interface Recipe {
  /** Generator or mutation id, e.g. 'basic', 'formula', 'perlin', 'ca', later 'mutate', 'breed'. */
  readonly op: string;
  readonly params: Readonly<Record<string, ParamValue>>;
  /** uint32 seed for every random choice the op makes. */
  readonly seed: number;
  /** Source tables (empty for seed generators). */
  readonly parents: readonly TableId[];
  /** Position within the batch that produced this table, if any. */
  readonly batch?: { readonly index: number; readonly count: number };
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

/** Short human-readable recipe summary for UI labels. */
export function describeRecipe(r: Recipe): string {
  const b = r.batch && r.batch.count > 1 ? ` ${r.batch.index + 1}/${r.batch.count}` : '';
  const p = r.params;
  switch (r.op) {
    case 'basic':
      return `${String(p.wave)}${p.wave === 'noise' ? ` seed ${r.seed}` : ''}`;
    case 'formula':
      return `${p.name ? String(p.name) : 'formula'}${b}`;
    case 'perlin':
      return `perlin${b} seed ${r.seed}`;
    case 'ca':
      return `CA rule ${String(p.rule)} gen ${String(p.generation)}`;
    default:
      return `${r.op}${b}`;
  }
}
