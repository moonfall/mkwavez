/**
 * Browser-only convenience: compile a JavaScript expression into a FormulaFn.
 * Kept out of src/core so the core stays portable (a native port needs its own
 * expression parser for the same preset language).
 *
 * Scope: p, t, n, u, pnoise(freq, z, octaves, persistence), noise(x, y, z), and every
 * Math member (sin, PI, pow, ...), like the prototype's with(Math).
 */
import type { FormulaFn } from '../core/generators/formula';

const MATH_NAMES = Object.getOwnPropertyNames(Math);
const MATH_VALUES = MATH_NAMES.map((k) => (Math as unknown as Record<string, unknown>)[k]);

export function compileFormula(expr: string): FormulaFn {
  if (!expr.trim()) throw new SyntaxError('empty expression');
  const factory = new Function(
    ...MATH_NAMES,
    `"use strict"; return function (p, t, n, u, pnoise, noise) { return (${expr}); };`,
  ) as (...m: unknown[]) => FormulaFn;
  return factory(...MATH_VALUES);
}
