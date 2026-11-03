import { renderBreedRecipe } from '../breed';
import { renderMutateRecipe } from '../mutateBatch';
import type { Recipe, TableId } from '../table';
import { basicWave, pulse, type BasicWave } from './basic';
import { caGenerations } from './ca';
import { formulaTable, type FormulaCompiler } from './formula';
import { paramMode } from './paramModes';
import { perlinTable, type PerlinParams } from './perlin';
import { pulseWidth } from './seed';

export * from './additive';
export * from './basic';
export * from './ca';
export * from './dynamical';
export * from './karplus';
export * from './paramModes';
export * from './formula';
export * from './formulaPresets';
export * from './perlin';
export * from './seed';
export * from './sequences';

export interface RenderEnv {
  /** Needed only for 'formula' recipes (browser: src/browser/formulaEval.ts). */
  compileFormula?: FormulaCompiler;
  /** Needed only for recipes with parents ('mutate', 'breed'): parent table data by id. */
  resolveTable?: (id: TableId) => Float32Array | undefined;
}

/** Re-render a single table from its recipe (seed generators, mutations, breeds). Deterministic. */
export function renderRecipe(r: Recipe, env: RenderEnv = {}): Float32Array {
  const index = r.batch?.index ?? 0;
  const count = r.batch?.count ?? 1;
  const p = r.params;
  switch (r.op) {
    case 'basic':
      return basicWave(p.wave as BasicWave, r.seed);
    case 'pulse':
      return pulse(pulseWidth(Number(p.width), Number(p.widthEnd), index, count));
    case 'perlin':
      return perlinTable(p as unknown as PerlinParams, r.seed, index, count);
    case 'ca':
      return caGenerations(
        { rule: Number(p.rule), cells: Number(p.cells) },
        r.seed,
        Number(p.generation),
        1,
      )[0];
    case 'formula': {
      if (!env.compileFormula) throw new Error('renderRecipe: formula needs a compiler');
      return formulaTable(env.compileFormula(String(p.expr)), r.seed, index, count);
    }
    case 'mutate': {
      if (!env.resolveTable) throw new Error('renderRecipe: mutate needs resolveTable');
      return renderMutateRecipe(r, env.resolveTable);
    }
    case 'breed': {
      if (!env.resolveTable) throw new Error('renderRecipe: breed needs resolveTable');
      return renderBreedRecipe(r, env.resolveTable);
    }
    default: {
      const pm = paramMode(r.op);
      if (!pm) throw new Error(`renderRecipe: unknown op ${r.op}`);
      return pm.render(p, r.seed, index, count);
    }
  }
}
