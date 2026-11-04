/**
 * The compact, committed summary of an evaluation: one rounded row per item (Seed entry,
 * mutation, breed operator, Shape chain, grid), no timings or dates, so re-running with
 * nothing changed reproduces it byte for byte. The report's tables are built from it; the
 * full per-batch dump goes to a local, git-ignored directory (main.ts).
 */
import { flagsOf, summarizeItems, summarizeSeed, type ItemSummary } from './aggregate';
import { APP_DEFAULTS, type BatchResult, type EvalOutput } from './evaluate';
import { PHASE_ONLY_REL } from './metrics';

/** Round to `d` decimals (null for non-finite). */
export const rnd = (v: number | null | undefined, d = 2): number | null => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const mean = (xs: readonly number[]) => {
  const ok = xs.filter((x) => Number.isFinite(x));
  return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : NaN;
};
const sc = (b: BatchResult) => (b.error ? 0 : b.score!.score);

export interface SeedRow {
  rank: number;
  item: string;
  label: string;
  category: string;
  mode: string;
  overall: number | null;
  defaultScore: number | null;
  randomMean: number | null;
  minScore: number | null;
  maxScore: number | null;
  batches: number;
  sig: number | null;
  centroid: number | null;
  slope: number | null;
  flatness: number | null;
  irregularity: number | null;
  h1Db: number | null;
  divisor: number | null;
  pathLsd: number | null;
  netLsd: number | null;
  travel: number | null;
  straightness: number | null;
  dupFrac: number | null;
  flags: string;
  worstVariant: string;
  worstSettings: string;
  centroids: (number | null)[];
}

export interface MutateRow {
  item: string;
  label: string;
  group: string;
  meanScore: number | null;
  effectSaw: number | null;
  effectFormant: number | null;
  effectNoisy: number | null;
  effectFull: number | null;
  scoreLin: number | null;
  scoreLog: number | null;
  scoreChain: number | null;
  dupFrac: number | null;
  notes: string;
}

export interface BreedRow {
  item: string;
  label: string;
  seeded: boolean;
  meanScore: number | null;
  sweepHalf: number | null;
  sweepFull: number | null;
  genHalf: number | null;
  effectA: number | null;
  effectB: number | null;
  dupFrac: number | null;
  phaseOnlyFrac: number | null;
}

export interface ShapeRow {
  item: string;
  label: string;
  kind: string;
  effectSaw: number | null;
  effectFormant: number | null;
  effectNoisy: number | null;
  effectSine: number | null;
  sigSaw: number | null;
  centroidSaw: number | null;
  pathLsd: number | null;
  meanScore: number | null;
}

export interface GridRow {
  columns: string;
  rows: string;
  row1: boolean;
  stepX: number | null;
  stepY: number | null;
  dupX: number | null;
  dupY: number | null;
  scoreX: number | null;
  scoreY: number | null;
}

export interface Summary {
  config: { k: number; n: number; seed: number; amounts: readonly number[]; modes: readonly string[]; weights: Record<string, number> };
  references: EvalOutput['references'];
  notes: string[];
  seed: SeedRow[];
  mutate: MutateRow[];
  breed: BreedRow[];
  shape: ShapeRow[];
  grid: GridRow[];
}

/** Compact settings for reproducing a Seed batch. */
export function seedSettings(b: BatchResult): string {
  const p = b.settings.params as Record<string, number>;
  const ps = Object.entries(p ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  return `seed ${b.settings.seed}${ps ? ` · ${ps}` : ''}`;
}

function mutateRow(s: ItemSummary, mb: readonly BatchResult[]): MutateRow {
  const pick = (src: string, mode: string, amount: number) =>
    mb.find((b) => b.item === s.item && b.settings.source === src && b.settings.mode === mode && b.settings.amount === amount);
  const def = ['saw', 'formant', 'noisy'].map((src) => pick(src, APP_DEFAULTS.mutateMode, APP_DEFAULTS.mutateAmount));
  const full = ['saw', 'formant', 'noisy'].map((src) => pick(src, 'lin', 1));
  const eff = def.map((b) => b?.effect?.lastLsd ?? NaN);
  const rel = def.map((b) => b?.effect?.lastRel ?? NaN);
  const modeScore = (m: string) => mean(s.batches.filter((b) => b.settings.mode === m).map(sc));
  const notes: string[] = [];
  if (Math.max(...eff) < 1) notes.push(Math.min(...rel) > PHASE_ONLY_REL ? 'phase-only' : 'near no-op @ default');
  else if (eff.filter((v) => v < 1).length >= 2) notes.push('≈ no-op on 2 of 3 refs @ default');
  const silent = s.batches.filter((b) => (b.metrics?.silentFrac ?? 0) > 0);
  if (silent.length) notes.push(`silent waveforms in ${silent.length} batch(es): ${silent.slice(0, 3).map((b) => b.variant).join('; ')}`);
  if (s.batches.some((b) => b.settings.mode === 'chain' && b.settings.amount === 1 && (b.metrics?.mean.sigCount ?? 99) <= 3)) notes.push('chain @ 1 collapses to ≤ 3 harmonics');
  return {
    item: s.item,
    label: s.label,
    group: s.category,
    meanScore: rnd(s.meanScore, 1),
    effectSaw: rnd(eff[0], 1),
    effectFormant: rnd(eff[1], 1),
    effectNoisy: rnd(eff[2], 1),
    effectFull: rnd(mean(full.map((b) => b?.effect?.lastLsd ?? NaN)), 1),
    scoreLin: rnd(modeScore('lin'), 1),
    scoreLog: rnd(modeScore('log'), 1),
    scoreChain: rnd(modeScore('chain'), 1),
    dupFrac: rnd(mean(s.batches.map((b) => b.metrics?.dupFrac ?? 0)), 2),
    notes: notes.join('; '),
  };
}

export function buildSummary(r: EvalOutput): Summary {
  const seed = summarizeSeed(r.batches);
  const bb = r.batches.filter((b) => b.section === 'breed');
  const mb = r.batches.filter((b) => b.section === 'mutate');
  const cfgBreed = (item: string, config: string) => bb.filter((b) => b.item === item && b.settings.config === config);
  return {
    config: {
      k: r.config.k,
      n: r.config.n,
      seed: r.config.seed,
      amounts: r.config.amounts,
      modes: r.config.modes,
      weights: { ...r.config.weights } as unknown as Record<string, number>,
    },
    references: r.references,
    notes: r.notes,
    seed: seed.map((e, i): SeedRow => {
      const m = e.default.metrics;
      return {
        rank: i + 1,
        item: e.item,
        label: e.label,
        category: e.category,
        mode: e.mode,
        overall: rnd(e.overall, 1),
        defaultScore: rnd(e.defaultScore, 1),
        randomMean: rnd(e.randomMean, 1),
        minScore: rnd(e.minScore, 1),
        maxScore: rnd(e.maxScore, 1),
        batches: e.batches.length,
        sig: rnd(m?.mean.sigCount, 1),
        centroid: rnd(m?.mean.centroid, 1),
        slope: rnd(m?.mean.slopeDbOct, 1),
        flatness: rnd(m?.mean.flatness, 2),
        irregularity: rnd(m?.mean.irregularityDb, 1),
        h1Db: rnd(m?.mean.h1Db, 1),
        divisor: rnd(m?.mean.divisor, 2),
        pathLsd: rnd(m?.pathLsd, 1),
        netLsd: rnd(m?.netLsd, 1),
        travel: rnd(e.default.score?.travel, 1),
        straightness: rnd(m?.straightness, 2),
        dupFrac: rnd(m?.dupFrac, 2),
        flags: e.default.error ? `error: ${e.default.error}` : flagsOf(e.default).join(' '),
        worstVariant: e.worst.variant,
        worstSettings: seedSettings(e.worst),
        centroids: (m?.centroids ?? []).map((c) => rnd(c, 2)),
      };
    }),
    mutate: summarizeItems(r.batches, 'mutate').map((s) => mutateRow(s, mb)),
    breed: summarizeItems(r.batches, 'breed').map((s): BreedRow => {
      const half = cfgBreed(s.item, 'sweep-default');
      return {
        item: s.item,
        label: s.label,
        seeded: Boolean(s.batches[0].settings.seeded),
        meanScore: rnd(s.meanScore, 1),
        sweepHalf: rnd(mean(half.map(sc)), 1),
        sweepFull: rnd(mean(cfgBreed(s.item, 'sweep-1').map(sc)), 1),
        genHalf: rnd(mean(cfgBreed(s.item, 'gen-default').map(sc)), 1),
        effectA: rnd(mean(half.map((b) => b.effect?.lastLsd ?? NaN)), 1),
        effectB: rnd(mean(half.map((b) => b.effect?.toBLsd ?? NaN)), 1),
        dupFrac: rnd(mean(s.batches.map((b) => b.metrics?.dupFrac ?? 0)), 2),
        phaseOnlyFrac: rnd(mean(s.batches.map((b) => b.metrics?.phaseOnlyFrac ?? 0)), 2),
      };
    }),
    shape: summarizeItems(r.batches, 'shape').map((s): ShapeRow => {
      const by = (src: string) => s.batches.find((b) => b.settings.source === src);
      const eff = (src: string) => rnd(Math.max(by(src)?.effect?.firstLsd ?? NaN, by(src)?.effect?.lastLsd ?? NaN), 1);
      return {
        item: s.item,
        label: s.label,
        kind: s.category,
        effectSaw: eff('saw'),
        effectFormant: eff('formant'),
        effectNoisy: eff('noisy'),
        effectSine: eff('sine'),
        sigSaw: rnd(by('saw')?.metrics?.mean.sigCount, 1),
        centroidSaw: rnd(by('saw')?.metrics?.mean.centroid, 1),
        pathLsd: rnd(mean(s.batches.map((b) => b.metrics?.pathLsd ?? 0)), 1),
        meanScore: rnd(s.meanScore, 1),
      };
    }),
    grid: r.grids.map((g) => ({
      columns: g.columns,
      rows: g.rows,
      row1: g.row1,
      stepX: rnd(g.meanStepX, 1),
      stepY: rnd(g.meanStepY, 1),
      dupX: rnd(g.dupX, 2),
      dupY: rnd(g.dupY, 2),
      scoreX: rnd(g.scoreX, 1),
      scoreY: rnd(g.scoreY, 1),
    })),
  };
}
