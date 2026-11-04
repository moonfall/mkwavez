/**
 * `npm run eval:harmonics [-- options]`: run the harmonic-interest evaluation and write
 * the data and the Markdown report.
 *
 *   --k N             random-parameter batches per Seed entry (default 8)
 *   --n N             batch size (default 8, the app's default)
 *   --seed N          base seed (default 0x5eed)
 *   --sections a,b    any of seed,mutate,breed,shape,grid (default all)
 *   --amounts a,b     Mutate amounts (default 0.1,0.25,0.5,1)
 *   --only TEXT       only items whose id contains TEXT (debugging; full dump only)
 *   --weights FILE    JSON object overriding score weights (see score.ts DEFAULT_WEIGHTS)
 *   --w.NAME=VALUE    override one weight, e.g. --w.motion=1.5
 *   --out DIR         report directory (default docs/reports): harmonic-interest.md and
 *                     harmonic-interest-data/ (summary.json, per-item CSVs, SVG charts),
 *                     compact and deterministic (no timings or dates), so a rerun with
 *                     nothing changed produces no diff
 *   --full DIR        full per-batch dump (default .harmonics, ignored by version
 *                     control): results.json with timings, per-batch CSVs
 *   --no-report       write the data only
 *
 * Timings go to stdout.
 */
import type { SweepMode } from '../../src/core/mutations';
import { evaluate, SECTIONS, type EvalConfig, type Section } from './evaluate';
import { writeBatchCsvs, writeSummaryCsvs } from './csv';
import { renderReport } from './report';
import { weightsFrom } from './score';
import { buildSummary } from './summary';

/** File access, passed in by run.mjs (keeps Node types out of the TypeScript sources). */
export interface Io {
  readFile(path: string): string;
  /** Write a file, creating its directory. */
  writeFile(path: string, text: string): void;
}

const join = (...parts: string[]) => parts.join('/').replace(/\/+/g, '/');

export interface CliOptions {
  cfg: EvalConfig;
  out: string;
  full: string;
  report: boolean;
}

export function parseArgs(argv: readonly string[], io?: Pick<Io, 'readFile'>): CliOptions {
  const over: Record<string, unknown> = {};
  const cfg: Omit<EvalConfig, 'weights'> = {
    k: 8,
    n: 8,
    seed: 0x5eed,
    sections: SECTIONS,
    amounts: [0.1, 0.25, 0.5, 1],
    modes: ['lin', 'log', 'chain'] as SweepMode[],
  };
  let out = 'docs/reports';
  let full = '.harmonics';
  let report = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--k') cfg.k = Math.max(0, Math.round(Number(val())));
    else if (a === '--n') cfg.n = Math.max(2, Math.round(Number(val())));
    else if (a === '--seed') cfg.seed = Number(val()) >>> 0;
    else if (a === '--sections')
      cfg.sections = val()
        .split(',')
        .map((s) => {
          if (!SECTIONS.includes(s as Section)) throw new Error(`unknown section ${s}`);
          return s as Section;
        });
    else if (a === '--amounts') cfg.amounts = val().split(',').map(Number);
    else if (a === '--only') cfg.only = val();
    else if (a === '--weights') {
      if (!io) throw new Error('--weights needs file access');
      Object.assign(over, JSON.parse(io.readFile(val())));
    } else if (a.startsWith('--w.')) {
      const [k, v] = a.slice(4).split('=');
      over[k] = v;
    } else if (a === '--out') out = val();
    else if (a === '--full') full = val();
    else if (a === '--no-report') report = false;
    else throw new Error(`unknown option ${a}`);
  }
  return { cfg: { ...cfg, weights: weightsFrom(over) }, out, full, report };
}

export async function main(argv: readonly string[], io: Io): Promise<void> {
  const { cfg, out, full, report } = parseArgs(argv, io);
  const result = evaluate(cfg, (s) => {
    if (s.startsWith('==')) console.log(s);
  });
  const round = (_k: string, v: unknown) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(5)) : v);
  io.writeFile(join(full, 'results.json'), JSON.stringify(result, round) + '\n');
  const batchCsvs = writeBatchCsvs(result, full, io.writeFile);
  console.log(`full dump: ${join(full, 'results.json')} + ${batchCsvs.join(', ')}`);
  if (!cfg.only) {
    const dataDir = join(out, 'harmonic-interest-data');
    const summary = buildSummary(result);
    io.writeFile(join(dataDir, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
    const csvs = writeSummaryCsvs(summary, dataDir, io.writeFile);
    console.log(`summary: ${join(dataDir, 'summary.json')} + ${csvs.join(', ')}`);
    if (report) {
      const rep = renderReport(result, summary);
      io.writeFile(join(out, 'harmonic-interest.md'), rep.md);
      for (const [path, text] of Object.entries(rep.files)) io.writeFile(join(out, path), text);
      console.log(`report: ${join(out, 'harmonic-interest.md')}`);
    }
  }
  const ms = Object.entries(result.sectionMs).map(([k, v]) => `${k} ${(v! / 1000).toFixed(1)} s`);
  console.log(`${result.batches.length} batches in ${(result.durationMs / 1000).toFixed(1)} s (${ms.join(', ')})`);
}
