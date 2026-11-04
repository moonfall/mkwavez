/**
 * Browser-only convenience: compile a JavaScript expression into a FormulaFn.
 * Kept out of src/core so the core stays portable (a native port needs its own
 * expression parser for the same preset language).
 *
 * Scope: p, t, n, u, pnoise(freq, z, octaves, persistence), noise(x, y, z), every Math
 * member (sin, PI, pow, ...), like the prototype's with(Math), and the waveform functions
 * (sine, saw, ca, ks, …: core/generators/waveFunctions.ts), which the core passes per table.
 */
import type { FormulaFn } from '../core/generators/formula';
import { WAVE_FUNCTION_NAMES } from '../core/generators/waveFunctions';

const MATH_NAMES = Object.getOwnPropertyNames(Math);
const MATH_VALUES = MATH_NAMES.map((k) => (Math as unknown as Record<string, unknown>)[k]);

export function compileFormula(expr: string): FormulaFn {
  if (!expr.trim()) throw new SyntaxError('empty expression');
  // Bind only the waveform functions the expression mentions (no per-sample cost otherwise).
  const used = WAVE_FUNCTION_NAMES.filter((name) => new RegExp(`\\b${name}\\b`).test(expr));
  const bind = used.length ? `const { ${used.join(', ')} } = fx$;` : '';
  const factory = new Function(
    ...MATH_NAMES,
    `"use strict"; return function (p, t, n, u, pnoise, noise, fx$) { ${bind} return (${expr}); };`,
  ) as (...m: unknown[]) => FormulaFn;
  return factory(...MATH_VALUES);
}
