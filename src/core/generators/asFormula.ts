/**
 * Basic presets' expressions: the waveform function (`saw(p)`, `pulse(p, …)`) or the naive
 * formula. Batch sweeps become u terms written in exactly the generator's arithmetic
 * (`a+(b-a)*u`) with numbers that read back exactly, so they render the same waveforms.
 */
import type { SeedEntry } from './seed';

/** Where a basic preset's expression comes from: its waveform function, or the naive formula. */
export type ExprSource = 'builtin' | 'formula';

/** A number literal that reads back as exactly `v` (negatives parenthesised). */
export function lit(v: number): string {
  if (Object.is(v, -0)) return '(-0)';
  return v < 0 ? `(${String(v)})` : String(v);
}

/** a → b across the batch, as the generators compute it: a + (b − a)·u. */
export function lerpExpr(a: number, b: number): string {
  if (a === b) return lit(a);
  if (a === 0) return `${lit(b)}*u`;
  return `${lit(a)}+(${lit(b)}-${lit(a)})*u`;
}

/** The Pulse preset's expression from its params: pulse(p, w) or the naive comparison. */
export function pulseExpr(width: number, widthEnd: number, source: ExprSource = 'builtin'): string {
  const w = lerpExpr(width, widthEnd);
  return source === 'builtin' ? `pulse(p, ${w})` : `t < ${w} ? 1 : -1`;
}

/**
 * The expression a basic preset (Sine … Square, Pulse) shows for `source`: its waveform
 * function (`saw(p)`, `pulse(p, …)`) or the naive formula ("Edit as formula" before).
 */
export function sourceExpr(entry: SeedEntry, source: ExprSource, params: Readonly<Record<string, number>> = {}): string {
  if (entry.mode === 'pulse') {
    const def = (k: string) => params[k] ?? entry.params?.find((p) => p.key === k)?.value ?? 0;
    return pulseExpr(def('width'), def('widthEnd'), source);
  }
  return (source === 'builtin' ? entry.fn : entry.asFormula) ?? '';
}
