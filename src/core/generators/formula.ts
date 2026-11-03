import { TABLE_SIZE } from '../constants';
import { noise3, noiseField, pnoiseAt } from '../perlin';
import { shape } from '../shape';
import type { GeneratedTable } from '../table';
import { batchU } from './perlin';

/** Loop-seamless noise available to formulas: pnoise(freq, z, octaves, persistence). */
export type PNoise = (freq?: number, z?: number, octaves?: number, persistence?: number) => number;

/**
 * A compiled formula. p = phase 0..2pi, t = 0..1, n = batch index, u = 0..1 across the batch.
 * The core never parses expressions itself: the browser build compiles JS
 * (src/browser/formulaEval.ts); a native port would plug in its own expression parser.
 */
export type FormulaFn = (
  p: number,
  t: number,
  n: number,
  u: number,
  pnoise: PNoise,
  noise: (x: number, y: number, z: number) => number,
) => number;

export type FormulaCompiler = (expr: string) => FormulaFn;

export class FormulaError extends Error {}

/** Thrown when `abort()` asked a formula evaluation to stop (runaway expression). */
export class FormulaAborted extends FormulaError {}

/** Samples between `abort()` checks. */
const ABORT_STRIDE = 16;

/**
 * Evaluate one table of a formula batch. Throws FormulaError on non-finite output, and
 * FormulaAborted when the optional `abort()` (polled every few samples) returns true.
 */
export function formulaTable(
  fn: FormulaFn,
  seed: number,
  index: number,
  count: number,
  abort?: () => boolean,
): Float32Array {
  const field = noiseField(seed);
  let phase = 0;
  const pnoise: PNoise = (freq = 2, z = 0, octaves = 4, persistence = 0.5) =>
    pnoiseAt(field, phase, freq, z || 0, octaves, persistence);
  const u = batchU(index, count);
  const x = new Float64Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i++) {
    if (abort && i % ABORT_STRIDE === 0 && abort()) throw new FormulaAborted(`stopped at sample ${i}`);
    phase = (2 * Math.PI * i) / TABLE_SIZE;
    const v = +fn(phase, i / TABLE_SIZE, index, u, pnoise, noise3);
    if (!Number.isFinite(v)) throw new FormulaError(`non-finite value at sample ${i}`);
    x[i] = v;
  }
  return shape(x);
}

export function generateFormula(
  fn: FormulaFn,
  expr: string,
  name: string,
  seed: number,
  count: number,
): GeneratedTable[] {
  const out: GeneratedTable[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      data: formulaTable(fn, seed, i, count),
      recipe: {
        op: 'formula',
        params: { expr, name },
        seed: seed >>> 0,
        parents: [],
        batch: { index: i, count },
      },
    });
  }
  return out;
}
