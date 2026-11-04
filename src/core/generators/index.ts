import { renderBreedRecipe } from '../breed';
import { renderMutateRecipe } from '../mutateBatch';
import { applyChain, recipeChain, renderShapeRecipe, SHAPE_OP } from '../shapeChain';
import type { Recipe, TableId } from '../table';
import { basicWave, pulse, type BasicWave } from './basic';
import { caGenerations } from './ca';
import { formulaTable, type FormulaCompiler } from './formula';
import { paramMode, renderParamMode } from './paramModes';
import { DEFAULT_PERLIN, perlinTable } from './perlin';
import { pulseWidth } from './seed';

export * from './additive';
export * from './basic';
export * from './ca';
export * from './dynamical';
export * from './karplus';
export * from './paramModes';
export * from './formula';
export * from './formulaPresets';
export * from './glyph';
export * from './life';
export * from './perlin';
export * from './fractal';
export * from './superformula';
export * from './resonance';
export * from './phaseDistortion';
export * from './fm';
export * from './polygon';
export * from './reactionDiffusion';
export * from './resample';
export * from './seed';
export * from './sequences';
export * from './shaper';
export * from './simCache';
export * from './spline';
export * from './supersaw';
export * from './waveFunctions';
export * from './asFormula';

export interface RenderEnv {
  /** Needed only for 'formula' recipes (browser: src/browser/formulaEval.ts). */
  compileFormula?: FormulaCompiler;
  /** Needed only for recipes with parents ('mutate', 'breed', 'shape'): parent table data by id. */
  resolveTable?: (id: TableId) => Float32Array | undefined;
}

/**
 * Re-render a single table from its recipe (seed generators, mutations, breeds, shape
 * chains), then its shape-on-add chain if it has one. Deterministic.
 */
export function renderRecipe(r: Recipe, env: RenderEnv = {}): Float32Array {
  const base = renderOp(r, env);
  if (r.shape === undefined || r.op === SHAPE_OP) return base;
  const c = recipeChain(r);
  return c ? applyChain(base, c, r.batch ?? { index: 0, count: 1 }) : base;
}

function renderOp(r: Recipe, env: RenderEnv): Float32Array {
  const index = r.batch?.index ?? 0;
  const count = r.batch?.count ?? 1;
  const p = r.params;
  switch (r.op) {
    case 'basic':
      return basicWave(p.wave as BasicWave, r.seed);
    case 'pulse':
      return pulse(pulseWidth(Number(p.width), Number(p.widthEnd), index, count));
    case 'perlin':
      return perlinTable(
        {
          freq: Number(p.freq ?? DEFAULT_PERLIN.freq),
          z: Number(p.z ?? DEFAULT_PERLIN.z),
          zDrift: Number(p.zDrift ?? DEFAULT_PERLIN.zDrift),
          octaves: Number(p.octaves ?? DEFAULT_PERLIN.octaves),
          persistence: Number(p.persistence ?? DEFAULT_PERLIN.persistence),
        },
        r.seed,
        index,
        count,
      );
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
    case SHAPE_OP: {
      if (!env.resolveTable) throw new Error('renderRecipe: shape needs resolveTable');
      return renderShapeRecipe(r, env.resolveTable);
    }
    default: {
      const pm = paramMode(r.op);
      if (!pm) throw new Error(`renderRecipe: unknown op ${r.op}`);
      return renderParamMode(pm, p, r.seed, index, count);
    }
  }
}
