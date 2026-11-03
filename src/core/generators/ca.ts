import { TABLE_SIZE } from '../constants';
import { Prng } from '../prng';
import { shape } from '../shape';
import type { GeneratedTable } from '../table';

export const CA_RULES: readonly { rule: number; label: string }[] = [
  { rule: 30, label: 'chaotic' },
  { rule: 45, label: 'chaotic' },
  { rule: 73, label: 'stripes' },
  { rule: 90, label: 'fractal' },
  { rule: 105, label: 'fractal' },
  { rule: 110, label: 'structured' },
  { rule: 150, label: 'fractal' },
  { rule: 184, label: 'drifting' },
];

export interface CaParams {
  rule: number;
  /** 8..64 cells. */
  cells: number;
}

function randomRow(r: Prng, cells: number, row: Uint8Array): void {
  for (let c = 0; c < cells; c++) row[c] = r.next() < 0.5 ? 1 : 0;
}

function isUniform(row: Uint8Array): boolean {
  for (let i = 1; i < row.length; i++) if (row[i] !== row[0]) return false;
  return true;
}

/** Step a 1D elementary CA (wrapping edges) in place. */
export function caStep(rule: number, row: Uint8Array, scratch: Uint8Array): void {
  const n = row.length;
  for (let c = 0; c < n; c++) {
    const l = row[(c - 1 + n) % n];
    const m = row[c];
    const r = row[(c + 1) % n];
    scratch[c] = (rule >> ((l << 2) | (m << 1) | r)) & 1;
  }
  row.set(scratch);
}

/**
 * Generations [start, start+count) of a CA seeded from `seed`. Each generation's cells
 * become +-1 steps of one table. A uniform row (dead end) is reseeded from the same PRNG,
 * so any generation is reproducible from (rule, cells, seed, generation).
 */
export function caGenerations(p: CaParams, seed: number, start: number, count: number): Float32Array[] {
  const cells = Math.max(2, Math.round(p.cells));
  const r = new Prng(seed);
  const row = new Uint8Array(cells);
  const scratch = new Uint8Array(cells);
  randomRow(r, cells, row);
  const out: Float32Array[] = [];
  for (let g = 0; g < start + count; g++) {
    if (isUniform(row)) randomRow(r, cells, row);
    if (g >= start) {
      const x = new Float64Array(TABLE_SIZE);
      for (let i = 0; i < TABLE_SIZE; i++) x[i] = row[Math.floor((i * cells) / TABLE_SIZE)] * 2 - 1;
      out.push(shape(x));
    }
    caStep(p.rule, row, scratch);
  }
  return out;
}

export function generateCa(p: CaParams, seed: number, count: number): GeneratedTable[] {
  return caGenerations(p, seed, 0, count).map((data, i) => ({
    data,
    recipe: {
      op: 'ca',
      params: { rule: p.rule, cells: p.cells, generation: i },
      seed: seed >>> 0,
      parents: [],
      batch: { index: i, count },
    },
  }));
}
