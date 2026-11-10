/**
 * The harmonic-interest evaluation: renders batches through the app's own code paths
 * (seedTable / mutateBatch / breedBatch / applyChain / gridRowTable — every waveform
 * leaves through shape(), exactly as the app adds it) and measures them (metrics.ts,
 * score.ts). Deterministic: every seed derives from `cfg.seed` and the item's id.
 */
import { compileFormula, compileRule } from '../../src/browser/formulaEval';
import { BREED_OPS, breedBatch, defaultBreedBias, isSeededOp, type BreedMode, type BreedOpId } from '../../src/core/breed';
import { basicWave } from '../../src/core/generators/basic';
import { glyphInputs } from '../../src/core/generators/glyph';
import { compileRules } from '../../src/core/generators/harmonicRules';
import {
  SEED_LIBRARY,
  seedEntry,
  seedFormulaExpr,
  seedParams,
  seedRules,
  seedTable,
  seedUsesRandomness,
  type SeedEntry,
  type SeedRequest,
} from '../../src/core/generators/seed';
import { gridRowTable, row1Fits, type GridRowOp } from '../../src/core/grid';
import { mutateBatch } from '../../src/core/mutateBatch';
import { MUTATION_CHOICES, mutationUsesSeed, type MutationId, type SweepMode } from '../../src/core/mutations';
import { deriveSeed, Prng } from '../../src/core/prng';
import { applyChain, chainSweeps, chainUsesSeed, type ShapeChain } from '../../src/core/shapeChain';
import { FACTORY_CHAINS } from '../../src/core/shapeFactory';
import type { WaveTable } from '../../src/core/table';
import { fixtureTrace } from './glyphFixture';
import { batchMetrics, harmonics, lsd, relRms, type BatchMetrics } from './metrics';
import { scoreBatch, type ScoreParts, type ScoreWeights } from './score';

export interface EvalConfig {
  /** Random-parameter batches per Seed entry (besides the default batch). */
  k: number;
  /** Batch size (the app's default N is 8). */
  n: number;
  /** Base seed. */
  seed: number;
  weights: ScoreWeights;
  /** Sections to run. */
  sections: readonly Section[];
  /** Only items whose id contains this text (debugging). */
  only?: string;
  /** Mutate: amounts and batch modes evaluated. */
  amounts: readonly number[];
  modes: readonly SweepMode[];
}

export type Section = 'seed' | 'mutate' | 'breed' | 'shape' | 'grid';
export const SECTIONS: readonly Section[] = ['seed', 'mutate', 'breed', 'shape', 'grid'];

/**
 * App defaults the evaluation mirrors (src/ui: generate.ts N = 8, mutate.ts amount 0.25 / lin,
 * breed.ts path / rate 0.05 / sweep, and the default bias for the parent count:
 * core/breed.ts defaultBreedBias(), ½ for two parents, ¾ for three).
 */
export const APP_DEFAULTS = { n: 8, mutateAmount: 0.25, mutateMode: 'lin', breedWalk: 'path', breedRate: 0.05, breedMode: 'sweep', glyphText: 'mkwavez' } as const;

export type BatchSummary = Omit<BatchMetrics, 'mean'> & { mean: BatchMetrics['mean'] };

export interface BatchResult {
  section: Section;
  /** Unique id of this batch. */
  id: string;
  /** The generator / mutation / operator / chain id. */
  item: string;
  label: string;
  category: string;
  /** 'default', 'random-1' …, or the configuration (e.g. 'saw · lin · 0.25'). */
  variant: string;
  /** Everything needed to reproduce the batch. */
  settings: Record<string, unknown>;
  metrics?: BatchSummary;
  score?: ScoreParts;
  /** Mutate / Breed / Shape: log-spectral distance and relative RMS difference from the source (parent A) to the first and last waveform; Breed also the LSD from parent B (the second parent) to the last child. */
  effect?: { firstLsd: number; lastLsd: number; lastRel: number; toBLsd?: number };
  error?: string;
  ms: number;
}

export interface GridResult {
  id: string;
  columns: string;
  rows: string;
  w: number;
  h: number;
  row1: boolean;
  /** Mean consecutive LSD along X (between columns) and along Y (down the rows), dB. */
  meanStepX: number;
  meanStepY: number;
  /** Fraction of consecutive near-duplicates along X / Y. */
  dupX: number;
  dupY: number;
  /** Mean score of the row lines and the column lines. */
  scoreX: number;
  scoreY: number;
  ms: number;
}

export interface EvalOutput {
  config: Omit<EvalConfig, 'weights'> & { weights: ScoreWeights };
  generatedAt: string;
  durationMs: number;
  sectionMs: Partial<Record<Section, number>>;
  batches: BatchResult[];
  grids: GridResult[];
  references: Record<string, { label: string; how: string }>;
  notes: string[];
}

/** FNV-1a hash of a string (stable stream index for deriveSeed). */
export function hashId(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function summarize(m: ReturnType<typeof batchMetrics>): BatchSummary {
  const { waves: _w, ...rest } = m;
  void _w;
  return rest;
}

function measure(waves: readonly Float32Array[], W: ScoreWeights): { metrics: BatchSummary; score: ScoreParts } {
  const m = batchMetrics(waves);
  return { metrics: summarize(m), score: scoreBatch(m, W) };
}

function effectOf(src: Float32Array, waves: readonly Float32Array[], b?: Float32Array): BatchResult['effect'] {
  const ms = harmonics(src);
  const first = harmonics(waves[0]);
  const last = harmonics(waves[waves.length - 1]);
  return {
    firstLsd: lsd(ms, first),
    lastLsd: lsd(ms, last),
    lastRel: relRms(src, waves[waves.length - 1]),
    ...(b ? { toBLsd: lsd(harmonics(b), last) } : {}),
  };
}

const roundTo = (v: number, step: number, min: number) => {
  const q = Math.round((v - min) / step) * step + min;
  return Number(q.toFixed(6));
};

/** Uniformly random values for every param of an entry (options: a random choice; sliders: on the step grid). */
export function randomParams(entry: SeedEntry, rng: Prng): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of entry.params ?? []) {
    if (p.options?.length) out[p.key] = p.options[rng.int(p.options.length)][0];
    else out[p.key] = Math.min(p.max, roundTo(p.min + rng.next() * (p.max - p.min), p.step, p.min));
  }
  return out;
}

/** The Seed request the app would make for this entry (default source; glyph contours from the Node fixture tracer). */
export function seedRequest(entry: SeedEntry, params: Record<string, number>, seed: number, count: number): SeedRequest {
  const inputs =
    entry.mode === 'glyph'
      ? glyphInputs([...APP_DEFAULTS.glyphText], { batch: params.batch, weight: params.weight, weightEnd: params.weightEnd }, count, fixtureTrace)
      : undefined;
  return { entry, expr: entry.expr ?? '', params, seed, count, inputs };
}

/** Render a Seed batch (formulas compiled with the browser's compiler, which is plain `new Function`). */
export function renderSeed(req: SeedRequest): Float32Array[] {
  const fn = compiledFor(req);
  return Array.from({ length: req.count }, (_, i) => seedTable(req, i, fn).data);
}

/** What seedTable needs compiled for a request: its formula, or its Harmonic rules. */
function compiledFor(req: SeedRequest) {
  if (req.entry.mode === 'rules') return compileRules(seedRules(req), compileRule);
  const fexpr = seedFormulaExpr(req);
  return fexpr !== null ? compileFormula(fexpr) : undefined;
}

/** Can random batches differ from the default one? (params to randomise, or a seed that matters) */
export function randomizable(entry: SeedEntry): boolean {
  return (entry.params?.length ?? 0) > 0 || seedUsesRandomness(entry, entry.expr ?? '', seedParams(entry));
}

const want = (cfg: EvalConfig, id: string) => !cfg.only || id.includes(cfg.only);

function timed<T>(f: () => T): { value?: T; error?: string; ms: number } {
  const t = performance.now();
  try {
    const value = f();
    return { value, ms: performance.now() - t };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), ms: performance.now() - t };
  }
}

// ---- Seed ----

export function evalSeed(cfg: EvalConfig, log: (s: string) => void = () => {}): BatchResult[] {
  const out: BatchResult[] = [];
  for (const entry of SEED_LIBRARY) {
    if (!want(cfg, entry.id)) continue;
    const variants: { variant: string; params: Record<string, number>; seed: number }[] = [
      { variant: 'default', params: seedParams(entry), seed: cfg.seed },
    ];
    if (randomizable(entry)) {
      for (let j = 1; j <= cfg.k; j++) {
        const seed = deriveSeed(cfg.seed ^ hashId(entry.id), j);
        variants.push({ variant: `random-${j}`, params: randomParams(entry, new Prng(seed)), seed });
      }
    }
    for (const v of variants) {
      const req = seedRequest(entry, v.params, v.seed, cfg.n);
      const r = timed(() => renderSeed(req));
      const res: BatchResult = {
        section: 'seed',
        id: `seed:${entry.id}:${v.variant}`,
        item: entry.id,
        label: entry.family ? `${entry.name} (${entry.family})` : entry.name,
        category: entry.cat,
        variant: v.variant,
        settings: { entry: entry.id, mode: entry.mode, params: v.params, seed: v.seed, count: cfg.n, ...(entry.expr ? { expr: entry.expr } : {}) },
        ms: r.ms,
      };
      if (r.error) res.error = r.error;
      else Object.assign(res, measure(r.value!, cfg.weights));
      out.push(res);
    }
    log(`seed ${entry.id}: ${variants.length} batch(es)`);
  }
  return out;
}

// ---- reference waveforms (Mutate / Breed / Shape sources) ----

export interface Reference {
  id: string;
  label: string;
  how: string;
  table: WaveTable;
}

function seedRef(id: string, entryId: string, index: number, count: number, seed: number, label: string): Reference {
  const entry = seedEntry(entryId);
  if (!entry) throw new Error(`no Seed entry ${entryId}`);
  const req = seedRequest(entry, seedParams(entry), seed, count);
  const t = seedTable(req, index, compiledFor(req));
  return { id, label, how: `Seed '${entryId}', defaults, seed ${seed}, waveform ${index + 1} of ${count}`, table: { id: hashId(id), data: t.data, recipe: t.recipe } };
}

export function references(): Record<string, Reference> {
  const saw = basicWave('saw', 0);
  const sine = basicWave('sine', 0);
  return {
    saw: { id: 'saw', label: 'Saw', how: "basicWave('saw')", table: { id: 1, data: saw, recipe: { op: 'basic', params: { wave: 'saw' }, seed: 0, parents: [] } } },
    formant: seedRef('formant', 'vowel-formants', 4, 8, 1, 'Formant wave'),
    noisy: seedRef('noisy', 'perlin-noise', 0, 8, 1, 'Noisy wave'),
    sine: { id: 'sine', label: 'Sine', how: "basicWave('sine')", table: { id: 4, data: sine, recipe: { op: 'basic', params: { wave: 'sine' }, seed: 0, parents: [] } } },
  };
}

// ---- Mutate ----

export function evalMutate(cfg: EvalConfig, log: (s: string) => void = () => {}): BatchResult[] {
  const refs = references();
  const sources = [refs.saw, refs.formant, refs.noisy];
  const out: BatchResult[] = [];
  for (const m of MUTATION_CHOICES) {
    if (!want(cfg, m.id)) continue;
    const seed = deriveSeed(cfg.seed, hashId(m.id));
    for (const src of sources) {
      for (const amount of cfg.amounts) {
        for (const mode of cfg.modes) {
          const req = { mutation: m.id as MutationId, amount, seed, mode, count: cfg.n };
          const r = timed(() => mutateBatch(req, src.table).map((t) => t.data));
          const res: BatchResult = {
            section: 'mutate',
            id: `mutate:${m.id}:${src.id}:${mode}:${amount}`,
            item: m.id,
            label: m.label,
            category: m.group,
            variant: `${src.id} · ${mode} · ${amount}`,
            settings: { mutation: m.id, source: src.id, amount, mode, seed, count: cfg.n, seeded: mutationUsesSeed(m.id as MutationId) },
            ms: r.ms,
          };
          if (r.error) res.error = r.error;
          else Object.assign(res, measure(r.value!, cfg.weights), { effect: effectOf(src.table.data, r.value!) });
          out.push(res);
        }
      }
    }
    log(`mutate ${m.id}`);
  }
  return out;
}

// ---- Breed ----

export function evalBreed(cfg: EvalConfig, log: (s: string) => void = () => {}): BatchResult[] {
  const refs = references();
  const sets: { id: string; parents: Reference[] }[] = [
    { id: 'saw+formant', parents: [refs.saw, refs.formant] },
    { id: 'saw+noisy', parents: [refs.saw, refs.noisy] },
    { id: 'formant+noisy', parents: [refs.formant, refs.noisy] },
    { id: 'sine+saw', parents: [refs.sine, refs.saw] },
    { id: 'saw+formant+noisy', parents: [refs.saw, refs.formant, refs.noisy] },
  ];
  // Bias null = the app's default for the parent count (defaultBreedBias).
  const configs: { key: string; mode: BreedMode; bias: number | null }[] = [
    { key: 'sweep-default', mode: 'sweep', bias: null },
    { key: 'sweep-1', mode: 'sweep', bias: 1 },
    { key: 'gen-default', mode: 'gen', bias: null },
  ];
  const out: BatchResult[] = [];
  for (const op of BREED_OPS) {
    if (!want(cfg, op.id)) continue;
    const seed = deriveSeed(cfg.seed, hashId(`breed:${op.id}`));
    for (const set of sets) {
      for (const c of configs) {
        const bias = c.bias ?? defaultBreedBias(set.parents.length, APP_DEFAULTS.breedWalk);
        const req = { op: op.id as BreedOpId, bias, walk: APP_DEFAULTS.breedWalk, rate: APP_DEFAULTS.breedRate, seed, mode: c.mode, count: cfg.n };
        const r = timed(() => breedBatch(req, set.parents.map((p) => p.table)).map((t) => t.data));
        const res: BatchResult = {
          section: 'breed',
          id: `breed:${op.id}:${set.id}:${c.key}`,
          item: op.id,
          label: op.label,
          category: op.group,
          variant: `${set.id} · ${c.mode} · bias ${bias}`,
          settings: { op: op.id, parents: set.parents.map((p) => p.id), config: c.key, mode: c.mode, bias, walk: req.walk, rate: req.rate, seed, count: cfg.n, seeded: isSeededOp(op.id as BreedOpId) },
          ms: r.ms,
        };
        if (r.error) res.error = r.error;
        else Object.assign(res, measure(r.value!, cfg.weights), { effect: effectOf(set.parents[0].table.data, r.value!, set.parents[1].table.data) });
        out.push(res);
      }
    }
    log(`breed ${op.id}`);
  }
  return out;
}

// ---- Shape chains ----

export function evalShape(cfg: EvalConfig, log: (s: string) => void = () => {}): BatchResult[] {
  const refs = references();
  const sources = [refs.saw, refs.formant, refs.noisy, refs.sine];
  const out: BatchResult[] = [];
  for (const fc of FACTORY_CHAINS) {
    if (!want(cfg, fc.id)) continue;
    const chain: ShapeChain = fc.chain;
    for (const src of sources) {
      const r = timed(() => Array.from({ length: cfg.n }, (_, i) => applyChain(src.table.data, chain, { index: i, count: cfg.n })));
      const res: BatchResult = {
        section: 'shape',
        id: `shape:${fc.id}:${src.id}`,
        item: fc.id,
        label: chain.name,
        category: chainSweeps(chain) ? 'sweeps' : chain.varySeed ? 'seed per waveform' : 'static',
        variant: src.id,
        settings: { chain: fc.id, source: src.id, count: cfg.n, sweeps: chainSweeps(chain), varySeed: chain.varySeed, seeded: chainUsesSeed(chain), steps: chain.steps.filter((s) => s.on).map((s) => s.op) },
        ms: r.ms,
      };
      if (r.error) res.error = r.error;
      else Object.assign(res, measure(r.value!, cfg.weights), { effect: effectOf(src.table.data, r.value!) });
      out.push(res);
    }
    log(`shape ${fc.id}`);
  }
  return out;
}

// ---- Grid ----

export function evalGrid(cfg: EvalConfig, log: (s: string) => void = () => {}): GridResult[] {
  const n = cfg.n;
  const columnSets = ['additive-designer', 'karplus-strong', 'fm-sweep'];
  const lowpass = FACTORY_CHAINS.find((c) => c.id === 'lowpass-opening')?.chain;
  const rowOps: { id: string; op: GridRowOp }[] = [
    { id: `mutate fold · lin · ${APP_DEFAULTS.mutateAmount}`, op: { kind: 'mutate', mutation: 'fold', amount: APP_DEFAULTS.mutateAmount, mode: 'lin', seed: cfg.seed } },
    { id: 'mutate smooth · lin · 1', op: { kind: 'mutate', mutation: 'smooth', amount: 1, mode: 'lin', seed: cfg.seed } },
    ...(lowpass ? [{ id: 'shape Low-pass opening', op: { kind: 'shape', chain: lowpass } as GridRowOp }] : []),
  ];
  const out: GridResult[] = [];
  for (const colId of columnSets) {
    const entry = seedEntry(colId);
    if (!entry) continue;
    const cols = renderSeed(seedRequest(entry, seedParams(entry), cfg.seed, n)).map((data, i): WaveTable => ({ id: 100 + i, data, recipe: { op: 'col', params: {}, seed: 0, parents: [] } }));
    for (const ro of rowOps) {
      const id = `grid:${colId}:${ro.id}`;
      if (!want(cfg, id)) continue;
      const t = performance.now();
      const row1 = row1Fits(ro.op, cols[0], n);
      const opCount = row1 ? n - 1 : n;
      // cells[r][c]
      const cells: Float32Array[][] = Array.from({ length: n }, () => []);
      for (let c = 0; c < cols.length; c++) {
        let prev: Float32Array | undefined;
        for (let r = 0; r < n; r++) {
          if (row1 && r === 0) {
            cells[0][c] = cols[c].data;
            continue;
          }
          const j = row1 ? r - 1 : r;
          const g = gridRowTable(ro.op, cols[c], j, opCount, prev);
          prev = g.data;
          cells[r][c] = g.data;
        }
      }
      const rowsM = cells.map((row) => batchMetrics(row));
      const colsM = cols.map((_, c) => batchMetrics(cells.map((row) => row[c])));
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      out.push({
        id,
        columns: colId,
        rows: ro.id,
        w: cols.length,
        h: n,
        row1,
        meanStepX: mean(rowsM.map((m) => m.meanStepLsd)),
        meanStepY: mean(colsM.map((m) => m.meanStepLsd)),
        dupX: mean(rowsM.map((m) => m.dupFrac)),
        dupY: mean(colsM.map((m) => m.dupFrac)),
        scoreX: mean(rowsM.map((m) => scoreBatch(m, cfg.weights).score)),
        scoreY: mean(colsM.map((m) => scoreBatch(m, cfg.weights).score)),
        ms: performance.now() - t,
      });
      log(`grid ${id}`);
    }
  }
  return out;
}

export function evaluate(cfg: EvalConfig, log: (s: string) => void = () => {}): EvalOutput {
  const t0 = performance.now();
  const sectionMs: EvalOutput['sectionMs'] = {};
  const batches: BatchResult[] = [];
  let grids: GridResult[] = [];
  const run = <T>(s: Section, f: () => T): T | undefined => {
    if (!cfg.sections.includes(s)) return undefined;
    const t = performance.now();
    const v = f();
    sectionMs[s] = performance.now() - t;
    log(`== ${s}: ${(sectionMs[s]! / 1000).toFixed(1)} s`);
    return v;
  };
  batches.push(...(run('seed', () => evalSeed(cfg, log)) ?? []));
  batches.push(...(run('mutate', () => evalMutate(cfg, log)) ?? []));
  batches.push(...(run('breed', () => evalBreed(cfg, log)) ?? []));
  batches.push(...(run('shape', () => evalShape(cfg, log)) ?? []));
  grids = run('grid', () => evalGrid(cfg, log)) ?? [];
  const refs = references();
  return {
    config: { ...cfg },
    generatedAt: new Date().toISOString(),
    durationMs: performance.now() - t0,
    sectionMs,
    batches,
    grids,
    references: Object.fromEntries(Object.entries(refs).map(([k, r]) => [k, { label: r.label, how: r.how }])),
    notes: [
      'Glyph contour uses a Node stand-in tracer (scripts/harmonics/glyphFixture.ts: a small stroke font for "mkwavez"), not the browser font tracer; its numbers are indicative only.',
      'Formula presets are compiled with src/browser/formulaEval.ts (plain `new Function`), unchanged.',
      'Spectral metrics see harmonic magnitudes only; phase-only changes count as near-duplicates (reported separately as phase-only).',
      'Generate → Sample (waveforms extracted from recordings, src/core/sample/) is not evaluated: it needs audio input.',
    ],
  };
}
