/**
 * "Edit as formula": the formula that renders a library entry's batch with the waveform
 * functions (waveFunctions.ts), from its current parameter values. Batch sweeps become
 * n / u terms written in exactly the generators' arithmetic (`a+(b-a)*u`, `start+n`, …)
 * and numbers are written so they read back exactly, so the formula renders the same
 * waveforms bit for bit (tests/formulaFunctions.test.ts).
 */
import { RD_PRESETS } from './reactionDiffusion';
import { KS_MAX_PASS } from './karplus';
import { compactContour, glyphWeight, type ContourOf } from './glyph';
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

/** start + step·n (integers), simplified. */
function stepExpr(start: number, step: number): string {
  const s = step === 0 ? '' : step === 1 ? 'n' : `${lit(step)}*n`;
  if (!s) return lit(start);
  return start === 0 ? s : `${lit(start)}+${s}`;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const r0 = (v: number) => Math.max(0, Math.round(v));

/** Options for entries whose formula needs host data (Glyph contour: the text and the tracer). */
export interface FormulaOptions {
  /** Glyph contour: the text's non-blank characters. */
  glyphChars?: readonly string[];
  /** Glyph contour: the host's tracer (browser: traceGlyph). */
  contourOf?: ContourOf;
}

/** A contour as a formula string literal (compact when exact, else the plain polyline). */
const contourLit = (c: string) => JSON.stringify(compactContour(c) ?? c);

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

/**
 * The formula equivalent of a parameter-mode entry (and Pulse) at `params` (complete:
 * seedParams()), or null for entries without one (formula presets). Seeded modes use the
 * formula's own seed implicitly, so with the same seed the formula renders the same batch.
 */
export function modeFormula(entry: SeedEntry, p: Readonly<Record<string, number>>, opts: FormulaOptions = {}): string | null {
  switch (entry.mode) {
    case 'basic':
      return entry.fn ?? null;
    case 'pulse':
      return pulseExpr(p.width, p.widthEnd);
    case 'perlin': {
      const z = p.zDrift === 0 ? lit(p.z) : p.z === 0 ? `${lit(p.zDrift)}*u` : `${lit(p.z)}+${lit(p.zDrift)}*u`;
      return `perlin(p, ${lit(p.freq)}, ${z}, ${lit(p.octaves)}, ${lit(p.persistence)})`;
    }
    case 'ca':
      return `ca(p, ${lit(p.rule)}, ${lit(p.cells)}, ${p.start === 0 ? 'n' : `${lit(p.start)}+n`})`;
    case 'dynamical':
      return `dyn(p, ${lit(p.map)}, ${lerpExpr(p.control, p.controlEnd)}, ${lit(p.iterations)}, ${lit(p.spread)}, ${lit(p.output)})`;
    case 'karplus': {
      const a = clamp(p.start, 0, KS_MAX_PASS);
      const b = clamp(p.end, 0, KS_MAX_PASS);
      const d = `pow(${lit(Math.abs(b - a) + 1)},u)-1`;
      const passes = a === b ? lit(a) : b > a ? (a === 0 ? d : `${lit(a)}+(${d})`) : `${lit(a)}-(${d})`;
      return `ks(p, ${passes}, ${lit(p.damping)}, ${lit(p.position)}, ${lit(p.length)}, ${lit(p.excite)})`;
    }
    case 'additive': {
      const move = p.shift === 0 ? '1' : `pow(2,${lit(p.shift)}*u)`;
      const formants = [1, 2, 3].map((i) => [p[`f${i}`], p[`w${i}`], p[`g${i}`]]);
      let last = -1;
      formants.forEach((f, i) => f[2] > 0 && (last = i));
      const fs = formants.slice(0, last + 1).map((f) => `, ${f.map(lit).join(', ')}`);
      return `additive(p, ${lerpExpr(p.slope, p.slopeEnd)}, ${lit(p.balance)}, ${move}, ${lit(p.phase)}${fs.join('')})`;
    }
    case 'numseq': {
      const adv = r0(p.advance);
      if (Math.round(p.source) === 4) return `seq(p, 4, ${lit(p.steps)}, ${lit(p.smoothing)}, ${stepExpr(0, adv)}, ${lit(p.pulses)})`;
      return `seq(p, ${lit(p.source)}, ${lit(p.steps)}, ${lit(p.smoothing)}, ${stepExpr(r0(p.offset), adv)})`;
    }
    case 'rd': {
      const step = stepExpr(r0(p.start), clamp(Math.round(p.steps), 1, 1000));
      const custom = RD_PRESETS[Math.round(p.system)] ? '' : `, ${lit(p.feed)}, ${lit(p.kill)}`;
      return `rd(p, ${lit(p.system)}, ${step}, ${lit(p.cells)}, ${lit(p.spots)}${custom})`;
    }
    case 'life':
      return `life(p, ${lit(p.rule)}, ${lit(p.read)}, ${lit(p.size)}, ${lit(p.density)}, ${stepExpr(r0(p.start), clamp(Math.round(p.step), 1, 16))})`;
    case 'spline':
      return Math.round(p.batch) === 1
        ? `spline(p, ${stepExpr(Math.round(p.points), 1)}, ${lit(p.kind)}, ${lit(p.tension)}, ${lit(p.jitter)})`
        : `spline(p, ${lit(p.points)}, ${lit(p.kind)}, ${lit(p.tension)}, ${lerpExpr(p.jitter, p.jitterEnd)})`;
    case 'glyph':
      return glyphFormula(p, opts);
    default:
      return null;
  }
}

/**
 * Glyph contour: the traced contours become string literals (compact: 4 characters per
 * point), picked per waveform by n (next characters) or by the swept weight.
 */
function glyphFormula(p: Readonly<Record<string, number>>, opts: FormulaOptions): string {
  const batch = Math.round(p.batch);
  const skew = batch === 0 ? lit(p.skew) : lerpExpr(p.skew, p.skewEnd);
  const chars = opts.glyphChars ?? [];
  const trace = opts.contourOf;
  if (!chars.length || !trace) return `glyph(p, "", ${skew})`;
  const gb = { batch, weight: p.weight, weightEnd: p.weightEnd };
  let contour: string;
  if (batch === 0) {
    const w = glyphWeight(gb, 0, 1);
    const list = chars.map((ch) => contourLit(trace(ch, w)));
    contour = list.length === 1 ? list[0] : `[${list.join(', ')}][n%${list.length}]`;
  } else if (batch === 1 && glyphWeight(gb, 0, 2) !== glyphWeight(gb, 1, 2)) {
    // The weight sweeps: one contour per weight step between the ends, indexed as glyphWeight() rounds.
    const lo = Math.min(glyphWeight(gb, 0, 2), glyphWeight(gb, 1, 2)) / 100;
    const hi = Math.max(glyphWeight(gb, 0, 2), glyphWeight(gb, 1, 2)) / 100;
    const list = Array.from({ length: hi - lo + 1 }, (_, i) => contourLit(trace(chars[0], (lo + i) * 100)));
    contour = `[${list.join(', ')}][round((${lerpExpr(p.weight, p.weightEnd)})/100)-${lo}]`;
  } else contour = contourLit(trace(chars[0], glyphWeight(gb, 0, 1)));
  return `glyph(p, ${contour}, ${skew})`;
}
