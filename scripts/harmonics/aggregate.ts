/**
 * Roll batch results up per item (Seed entry, mutation, breed operator, Shape chain) and
 * flag problem cases. Shared by the CSV writer and the report.
 */
import type { BatchResult } from './evaluate';

export type Flag = 'error' | 'silent' | 'static' | 'duplicates' | 'phase-only' | 'flat' | 'sine-like' | 'no-fundamental' | 'pitch-shifted' | 'erratic';

/** Problem flags of one batch (thresholds documented in the report). */
export function flagsOf(b: BatchResult): Flag[] {
  if (b.error) return ['error'];
  const m = b.metrics!;
  const f: Flag[] = [];
  if (m.silentFrac > 0) f.push('silent');
  if (m.static) f.push('static');
  else if (m.dupFrac >= 0.5) f.push('duplicates');
  if (m.phaseOnlyFrac >= 0.5) f.push('phase-only');
  if (m.mean.flatness > 0.5) f.push('flat');
  if (m.mean.sigCount <= 1.5) f.push('sine-like');
  if (m.mean.h1Db < -40) f.push('no-fundamental');
  if (m.mean.divisor >= 1.5) f.push('pitch-shifted');
  if (!m.static && m.straightness < 0.25 && m.stepCv > 0.8) f.push('erratic');
  return f;
}

export interface ItemSummary {
  item: string;
  label: string;
  category: string;
  batches: BatchResult[];
  /** Mean score over every batch of the item. */
  meanScore: number;
  minScore: number;
  maxScore: number;
  best: BatchResult;
  worst: BatchResult;
  errors: number;
}

export interface SeedSummary extends ItemSummary {
  mode: string;
  default: BatchResult;
  randoms: BatchResult[];
  defaultScore: number;
  randomMean: number | null;
  /** ½·default + ½·mean(random) (default alone when the entry has nothing to randomise). */
  overall: number;
  flags: Flag[];
}

const sc = (b: BatchResult) => (b.error ? 0 : b.score!.score);
const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function group(batches: readonly BatchResult[]): Map<string, BatchResult[]> {
  const m = new Map<string, BatchResult[]>();
  for (const b of batches) {
    const l = m.get(b.item) ?? [];
    l.push(b);
    m.set(b.item, l);
  }
  return m;
}

function itemSummary(bs: BatchResult[]): ItemSummary {
  const sorted = [...bs].sort((a, b) => sc(b) - sc(a));
  return {
    item: bs[0].item,
    label: bs[0].label,
    category: bs[0].category,
    batches: bs,
    meanScore: mean(bs.map(sc)),
    minScore: Math.min(...bs.map(sc)),
    maxScore: Math.max(...bs.map(sc)),
    best: sorted[0],
    worst: sorted[sorted.length - 1],
    errors: bs.filter((b) => b.error).length,
  };
}

export function summarizeSeed(batches: readonly BatchResult[]): SeedSummary[] {
  const out: SeedSummary[] = [];
  for (const bs of group(batches.filter((b) => b.section === 'seed')).values()) {
    const base = itemSummary(bs);
    const def = bs.find((b) => b.variant === 'default')!;
    const randoms = bs.filter((b) => b.variant !== 'default');
    const randomMean = randoms.length ? mean(randoms.map(sc)) : null;
    out.push({
      ...base,
      mode: String(def.settings.mode),
      default: def,
      randoms,
      defaultScore: sc(def),
      randomMean,
      overall: randomMean === null ? sc(def) : 0.5 * sc(def) + 0.5 * randomMean,
      flags: flagsOf(def),
    });
  }
  return out.sort((a, b) => b.overall - a.overall);
}

export function summarizeItems(batches: readonly BatchResult[], section: BatchResult['section']): ItemSummary[] {
  return [...group(batches.filter((b) => b.section === section)).values()].map(itemSummary).sort((a, b) => b.meanScore - a.meanScore);
}
