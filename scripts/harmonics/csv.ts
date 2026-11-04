/**
 * CSV exports: the committed per-item summary tables (summary.ts) and the full per-batch
 * tables for the local dump.
 */
import { flagsOf } from './aggregate';
import type { BatchResult, EvalOutput } from './evaluate';
import type { Summary } from './summary';

const cell = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(Number.isInteger(v) ? v : Number(v.toPrecision(6))) : '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [header.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\n') + '\n';
}

/** Objects with the same keys → CSV (header = the first row's keys). */
export function objectsCsv(rows: readonly object[]): string {
  if (!rows.length) return '';
  const header = Object.keys(rows[0]);
  return toCsv(header, rows.map((r) => header.map((k) => (r as Record<string, unknown>)[k])));
}

const BATCH_HEADER = [
  'id', 'section', 'item', 'label', 'category', 'variant', 'score', 'richness', 'balance', 'pitch', 'motion', 'smoothness', 'structure', 'travel',
  'sigCount', 'highestSig', 'centroid', 'spread', 'flatness', 'entropy', 'slopeDbOct', 'oddEvenDb', 'evenFrac', 'crest',
  'irregularityDb', 'formantPeaks', 'formantProminenceDb', 'h1Db', 'h1Frac', 'divisor', 'silentFrac', 'dupFrac', 'phaseOnlyFrac', 'static', 'meanStepLsd',
  'maxStepLsd', 'pathLsd', 'netLsd', 'meanStepCos', 'endToEndLsd', 'straightness', 'stepCv', 'centroidRange', 'centroidMonotonic',
  'effectFirstLsd', 'effectLastLsd', 'effectLastRel', 'effectToBLsd', 'flags', 'error', 'ms', 'settings',
] as const;

export function batchRow(b: BatchResult): unknown[] {
  const m = b.metrics;
  const s = b.score;
  const w = m?.mean;
  return [
    b.id, b.section, b.item, b.label, b.category, b.variant, s?.score, s?.richness, s?.balance, s?.pitch, s?.motion, s?.smoothness, s?.structure, s?.travel,
    w?.sigCount, w?.highestSig, w?.centroid, w?.spread, w?.flatness, w?.entropy, w?.slopeDbOct, w?.oddEvenDb, w?.evenFrac, w?.crest,
    w?.irregularityDb, w?.formantPeaks, w?.formantProminenceDb, w?.h1Db, w?.h1Frac, w?.divisor, m?.silentFrac, m?.dupFrac, m?.phaseOnlyFrac, m?.static, m?.meanStepLsd,
    m?.maxStepLsd, m?.pathLsd, m?.netLsd, m?.meanStepCos, m?.endToEndLsd, m?.straightness, m?.stepCv, m?.centroidRange, m?.centroidMonotonic,
    b.effect?.firstLsd, b.effect?.lastLsd, b.effect?.lastRel, b.effect?.toBLsd, flagsOf(b).join(' '), b.error, b.ms, b.settings,
  ];
}

type Write = (path: string, text: string) => void;

/** The committed per-item tables; returns the file names. */
export function writeSummaryCsvs(s: Summary, dir: string, writeFile: Write): string[] {
  const files: string[] = [];
  const put = (name: string, rows: readonly object[]) => {
    if (!rows.length) return;
    writeFile(`${dir}/${name}`, objectsCsv(rows));
    files.push(name);
  };
  put('seed.csv', s.seed.map(({ centroids, ...rest }) => ({ ...rest, centroids: centroids.join(' ') })));
  put('mutate.csv', s.mutate);
  put('breed.csv', s.breed);
  put('shape.csv', s.shape);
  put('grid.csv', s.grid);
  return files;
}

/** The full per-batch tables (local dump); returns the file names. */
export function writeBatchCsvs(r: EvalOutput, dir: string, writeFile: Write): string[] {
  const files: string[] = [];
  for (const section of ['seed', 'mutate', 'breed', 'shape'] as const) {
    const rows = r.batches.filter((b) => b.section === section);
    if (!rows.length) continue;
    writeFile(`${dir}/${section}-batches.csv`, toCsv(BATCH_HEADER, rows.map(batchRow)));
    files.push(`${section}-batches.csv`);
  }
  return files;
}
