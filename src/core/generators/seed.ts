/**
 * The Seed library: every way to make a table from nothing (basic waves, formula
 * presets, parameter modes), as plain data, plus one entry point that renders table i
 * of a batch. Every table goes through shape(); recipes record the library entry, the
 * (possibly edited) formula or the params, the seed and the batch position, so
 * renderRecipe() reproduces them exactly.
 */
import type { GeneratedTable, ParamValue } from '../table';
import { sourceExpr, type ExprSource } from './asFormula';
import { basicWave, pulse, type BasicWave } from './basic';
import { CA_RULES, caGenerations } from './ca';
import { formulaTable, type FormulaFn } from './formula';
import { FORMULA_PRESETS } from './formulaPresets';
import { PARAM_MODES, paramMode, type ParamModeDef, type ParamModeId, type SeedParam } from './paramModes';
import { batchU, DEFAULT_PERLIN, perlinTable, type PerlinParams } from './perlin';

export type { SeedParam } from './paramModes';

/** Built-in modes, or a PARAM_MODES mode (e.g. 'dynamical'). */
export type SeedMode = 'basic' | 'pulse' | 'formula' | 'perlin' | 'ca' | ParamModeId;

export interface SeedEntry {
  /** Stable id, recorded in recipes as `params.preset`. */
  readonly id: string;
  readonly cat: string;
  readonly name: string;
  readonly mode: SeedMode;
  /** Preset expression (mode 'formula'). */
  readonly expr?: string;
  /** Additive generator (mode 'basic'). */
  readonly wave?: BasicWave;
  /** Editable parameters (every mode except 'basic' and 'formula'). */
  readonly params?: readonly SeedParam[];
  /** One-line description (basic waves, PARAM_MODES). */
  readonly about?: string;
  /** The naive formula of a basic wave (its "Formula" source; "Edit as formula" before the waveform functions). */
  readonly asFormula?: string;
  /** The basic wave's waveform function call (its "Built-in function" source), e.g. `saw(p)`. */
  readonly fn?: string;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const basic = (name: string, wave: BasicWave, fn: string, about: string, asFormula: string): SeedEntry => ({
  id: slug(name),
  cat: 'Basic',
  name,
  mode: 'basic',
  wave,
  about,
  asFormula,
  fn,
});

const MODES: readonly ParamModeDef[] = PARAM_MODES;
function modeEntry(m: ParamModeDef): SeedEntry {
  return { id: m.id, cat: m.cat, name: m.name, mode: m.mode as ParamModeId, params: m.params, about: m.about };
}

const BASE_LIBRARY: readonly SeedEntry[] = [
  basic('Sine', 'sine', 'sine(p)', 'The fundamental alone.', 'sin(p)'),
  basic(
    'Triangle',
    'tri',
    'tri(p)',
    'Additive: odd harmonics at 1/k², alternating sign (k ≤ 72).',
    '[...Array(36)].reduce((s,_,k)=>s+(k%2?-1:1)*sin((2*k+1)*p)/pow(2*k+1,2),0)',
  ),
  basic('Saw', 'saw', 'saw(p)', 'Additive: every harmonic at 1/k (k ≤ 72).', '[...Array(72)].reduce((s,_,k)=>s+sin((k+1)*p)/(k+1),0)'),
  basic(
    'Square',
    'square',
    'square(p)',
    'Additive: odd harmonics at 1/k (k ≤ 72).',
    '[...Array(36)].reduce((s,_,k)=>s+sin((2*k+1)*p)/(2*k+1),0)',
  ),
  {
    id: 'pulse',
    cat: 'Basic',
    name: 'Pulse',
    mode: 'pulse',
    params: [
      { key: 'width', label: 'Width', min: 0.02, max: 0.5, step: 0.01, value: 0.25 },
      { key: 'widthEnd', label: 'Batch → width', min: 0.02, max: 0.5, step: 0.01, value: 0.05 },
    ],
  },
  ...FORMULA_PRESETS.map(
    (p): SeedEntry => ({ id: slug(p.name), cat: p.group, name: p.name, mode: 'formula', expr: p.expr }),
  ),
  {
    id: 'perlin-noise',
    cat: 'Noise & automata',
    name: 'Perlin noise',
    mode: 'perlin',
    params: [
      { key: 'freq', label: 'Frequency', min: 0.5, max: 8, step: 0.05, value: DEFAULT_PERLIN.freq },
      { key: 'z', label: 'Z start', min: 0, max: 10, step: 0.05, value: DEFAULT_PERLIN.z },
      { key: 'zDrift', label: 'Z drift (batch)', min: 0, max: 4, step: 0.05, value: DEFAULT_PERLIN.zDrift },
      { key: 'octaves', label: 'Octaves', min: 1, max: 8, step: 1, value: DEFAULT_PERLIN.octaves },
      { key: 'persistence', label: 'Persistence', min: 0.1, max: 0.9, step: 0.01, value: DEFAULT_PERLIN.persistence },
    ],
  },
  {
    id: 'cellular-automaton',
    cat: 'Noise & automata',
    name: 'Cellular automaton',
    mode: 'ca',
    params: [
      {
        key: 'rule',
        label: 'Rule',
        min: 0,
        max: 255,
        step: 1,
        value: 30,
        options: CA_RULES.map((r) => [r.rule, `${r.rule} · ${r.label}`] as const),
      },
      { key: 'cells', label: 'Cells', min: 8, max: 64, step: 4, value: 32 },
      { key: 'start', label: 'Start generation', min: 0, max: 64, step: 1, value: 0 },
    ],
  },
  ...MODES.filter((m) => !m.after).map(modeEntry),
  { id: 'blank-formula', cat: 'Custom', name: 'Blank formula', mode: 'formula', expr: 'sin(p) + 0.5*sin(2*p)*u' },
];

/** Every entry in library order: modes with `after` right after that entry (e.g. Supersaw after Pulse, in Basic). */
export const SEED_LIBRARY: readonly SeedEntry[] = BASE_LIBRARY.flatMap((e) => [e, ...MODES.filter((m) => m.after === e.id).map(modeEntry)]);

export function seedEntry(id: string): SeedEntry | undefined {
  return SEED_LIBRARY.find((e) => e.id === id);
}

/** Defaults of an entry's params, overridden by `over`. */
export function seedParams(entry: SeedEntry, over: Readonly<Record<string, number>> = {}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of entry.params ?? []) out[p.key] = over[p.key] ?? p.value;
  return out;
}

/** Formula calls that may use the seed: pnoise() and the seeded waveform functions. */
const SEEDED_CALL = /\b(pnoise|perlin|ca|ks|additive|rd|life|spline|supersaw)\s*\(/;

/**
 * True when the seed changes the result: Perlin, CA, a formula (or a basic preset's
 * expression) that calls pnoise() or a seeded waveform function, or a parameter mode that is
 * seeded for these params (defaults when omitted).
 */
export function seedUsesRandomness(
  entry: SeedEntry,
  expr = entry.expr ?? '',
  params: Readonly<Record<string, number>> = {},
): boolean {
  if (entry.mode === 'perlin' || entry.mode === 'ca') return true;
  const pm = paramMode(entry.mode);
  if (pm) return pm.seeded(seedParams(entry, params));
  return (entry.mode === 'formula' || entry.mode === 'basic' || entry.mode === 'pulse') && SEEDED_CALL.test(expr);
}

/** One Seed batch: what the preview shows and what Add / Add batch append. */
export interface SeedRequest {
  readonly entry: SeedEntry;
  /**
   * The expression for 'formula' entries (may differ from the preset: edited). Basic
   * presets (Sine … Square, Pulse): the shown expression of `source`; '' or the source's
   * own expression = unedited.
   */
  readonly expr: string;
  /**
   * Basic presets: 'builtin' (default: the band-limited generator, i.e. its waveform
   * function, e.g. `saw(p)`) or 'formula' (the naive formula). An unedited built-in
   * renders through the generator (recipe op 'basic' / 'pulse'); anything else is a formula.
   */
  readonly source?: ExprSource;
  /** Param values for parameter-mode entries (missing keys use defaults). */
  readonly params: Readonly<Record<string, number>>;
  readonly seed: number;
  /** Batch size N (u = index / (N-1)). */
  readonly count: number;
  /**
   * Per-table params supplied by the host for parameter modes that need data the core
   * can't make (e.g. a glyph's traced contour): table i gets inputs[i % length], merged
   * over the params and recorded in its recipe, so it re-renders without the host.
   */
  readonly inputs?: readonly Readonly<Record<string, ParamValue>>[];
}

/**
 * The expression a request renders as a formula — formula entries, and basic presets with
 * the Formula source or an edited expression — or null when it renders through a generator.
 */
export function seedFormulaExpr(req: SeedRequest): string | null {
  const { entry } = req;
  if (entry.mode === 'formula') return req.expr;
  if (entry.mode !== 'basic' && entry.mode !== 'pulse') return null;
  const source = req.source ?? 'builtin';
  const def = sourceExpr(entry, source, seedParams(entry, req.params));
  const expr = req.expr || def;
  return source === 'builtin' && expr === def ? null : expr;
}

/**
 * Table `index` of a Seed batch. Formula entries need the compiled expression (the core
 * never parses expressions). Throws FormulaError on non-finite formula output and
 * FormulaAborted when `abort()` returns true (polled during formula evaluation only;
 * the other modes are bounded).
 */
export function seedTable(req: SeedRequest, index: number, fn?: FormulaFn, abort?: () => boolean): GeneratedTable {
  const { entry, count } = req;
  const seed = req.seed >>> 0;
  const batch = { index, count };
  const p = seedParams(entry, req.params);
  const recipe = (op: string, params: Record<string, number | string | boolean>) => ({
    op,
    params: { ...params, preset: entry.id },
    seed,
    parents: [],
    batch,
  });
  const fexpr = entry.mode === 'basic' || entry.mode === 'pulse' ? seedFormulaExpr(req) : null;
  if (fexpr !== null) {
    // A basic preset as a formula (Formula source, or an edited expression).
    if (!fn) throw new Error('seedTable: formula sources need a compiled expression');
    const def = sourceExpr(entry, req.source ?? 'builtin', p);
    return {
      data: formulaTable(fn, seed, index, count, abort),
      recipe: recipe('formula', { expr: fexpr, name: entry.name, edited: fexpr !== def }),
    };
  }
  switch (entry.mode) {
    case 'basic':
      return { data: basicWave(entry.wave!, seed), recipe: recipe('basic', { wave: entry.wave! }) };
    case 'pulse':
      return {
        data: pulse(pulseWidth(p.width, p.widthEnd, index, count)),
        recipe: recipe('pulse', { width: p.width, widthEnd: p.widthEnd }),
      };
    case 'formula': {
      if (!fn) throw new Error('seedTable: formula entries need a compiled expression');
      return {
        data: formulaTable(fn, seed, index, count, abort),
        recipe: recipe('formula', { expr: req.expr, name: entry.name, edited: req.expr !== entry.expr }),
      };
    }
    case 'perlin': {
      const pp: PerlinParams = {
        freq: p.freq,
        z: p.z,
        zDrift: p.zDrift,
        octaves: p.octaves,
        persistence: p.persistence,
      };
      return { data: perlinTable(pp, seed, index, count), recipe: recipe('perlin', { ...pp }) };
    }
    case 'ca': {
      const generation = p.start + index;
      return {
        data: caGenerations({ rule: p.rule, cells: p.cells }, seed, generation, 1)[0],
        recipe: recipe('ca', { rule: p.rule, cells: p.cells, start: p.start, generation }),
      };
    }
    default: {
      const pm = paramMode(entry.mode);
      if (!pm) throw new Error(`seedTable: unknown mode ${entry.mode}`);
      const extra = req.inputs?.length ? req.inputs[index % req.inputs.length] : {};
      const all = { ...p, ...extra };
      return { data: pm.render(all, seed, index, count), recipe: recipe(pm.mode, { ...all, name: entry.name }) };
    }
  }
}

/** Every table of a Seed batch, in order. */
export function seedBatch(req: SeedRequest, fn?: FormulaFn): GeneratedTable[] {
  return Array.from({ length: req.count }, (_, i) => seedTable(req, i, fn));
}

/** Pulse duty of table `index`: width → widthEnd across the batch. */
export function pulseWidth(width: number, widthEnd: number, index: number, count: number): number {
  return width + (widthEnd - width) * batchU(index, count);
}
