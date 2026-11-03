/**
 * Life-like cellular automata: a 2D outer-totalistic rule (B/S notation) on a small
 * torus, started from a seeded random fill. Each table reads one line of the board (a
 * row, a column, the diagonal) or a projection (live cells per column / per row) as
 * steps across the cycle; a batch is consecutive generations (start + i·step).
 * A board that dies out or fills up is refilled from the same PRNG, so every generation is
 * reproducible from (rule, size, density, seed, generation).
 */
import { TABLE_SIZE } from '../constants';
import { Prng } from '../prng';
import { shape } from '../shape';
import { StepCache } from './simCache';

export const LIFE_RULES: readonly { label: string; rule: string }[] = [
  { label: 'Life', rule: 'B3/S23' },
  { label: 'HighLife', rule: 'B36/S23' },
  { label: 'Seeds', rule: 'B2/S' },
  { label: 'Day & Night', rule: 'B3678/S34678' },
  { label: 'Maze', rule: 'B3/S12345' },
  { label: 'Diamoeba', rule: 'B35678/S5678' },
  { label: '2×2', rule: 'B36/S125' },
  { label: 'Morley', rule: 'B368/S245' },
  { label: 'Anneal', rule: 'B4678/S35678' },
];

export const LIFE_READS = ['Middle row', 'Middle column', 'Diagonal', 'Live cells per column', 'Live cells per row'] as const;

export interface LifeParams {
  /** Index into LIFE_RULES. */
  rule: number;
  /** Board side, 8..64. */
  size: number;
  /** Initial live fraction, 0.05..0.95. */
  density: number;
  /** Index into LIFE_READS. */
  read: number;
  /** Generation of the first table. */
  start: number;
  /** Generations between tables, 1..16. */
  step: number;
}

export const DEFAULT_LIFE: LifeParams = { rule: 0, size: 32, density: 0.35, read: 0, start: 8, step: 1 };

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** B/S rule string → (birth, survival) masks indexed by neighbour count. */
export function parseRule(rule: string): { birth: boolean[]; survive: boolean[] } {
  const birth = Array<boolean>(9).fill(false);
  const survive = Array<boolean>(9).fill(false);
  const m = /^B(\d*)\/S(\d*)$/i.exec(rule.trim());
  if (m) {
    for (const c of m[1]) birth[Number(c)] = true;
    for (const c of m[2]) survive[Number(c)] = true;
  }
  return { birth, survive };
}

export interface Board {
  cells: Uint8Array;
  rng: number;
}

/** Seeded random fill, never all dead or all alive (one cell is flipped if it would be). */
function fill(cells: Uint8Array, r: Prng, density: number): void {
  let alive = 0;
  for (let i = 0; i < cells.length; i++) alive += cells[i] = r.next() < density ? 1 : 0;
  if (alive === 0 || alive === cells.length) cells[r.int(cells.length)] ^= 1;
}

function advance(b: Board, n: number, size: number, rule: { birth: boolean[]; survive: boolean[] }, density: number): void {
  const r = new Prng(0);
  r.state = b.rng;
  const next = new Uint8Array(size * size);
  for (let g = 0; g < n; g++) {
    let alive = 0;
    for (let y = 0; y < size; y++) {
      const ym = ((y - 1 + size) % size) * size;
      const y0 = y * size;
      const yp = ((y + 1) % size) * size;
      for (let x = 0; x < size; x++) {
        const xm = (x - 1 + size) % size;
        const xp = (x + 1) % size;
        const c = b.cells;
        const nb = c[ym + xm] + c[ym + x] + c[ym + xp] + c[y0 + xm] + c[y0 + xp] + c[yp + xm] + c[yp + x] + c[yp + xp];
        const v = c[y0 + x] ? (rule.survive[nb] ? 1 : 0) : rule.birth[nb] ? 1 : 0;
        next[y0 + x] = v;
        alive += v;
      }
    }
    b.cells.set(next);
    // A dead or completely full board (uniform: silent) is refilled from the same PRNG.
    if (alive === 0 || alive === size * size) fill(b.cells, r, density);
  }
  b.rng = r.state;
}

/** Board checkpoints (a pure memo: results never depend on it). */
const defaultCache = new StepCache<Board>();
const clone = (b: Board): Board => ({ cells: b.cells.slice(), rng: b.rng });

/** The board after `generation` generations (row-major, size × size). `cache` only saves time. */
export function lifeBoard(p: LifeParams, seed: number, generation: number, cache: StepCache<Board> = defaultCache): Uint8Array {
  const size = clamp(Math.round(p.size), 8, 64);
  const density = clamp(p.density, 0.05, 0.95);
  const ruleIdx = clamp(Math.round(p.rule), 0, LIFE_RULES.length - 1);
  const rule = parseRule(LIFE_RULES[ruleIdx].rule);
  return cache.at(
    `${ruleIdx}|${size}|${density}|${seed >>> 0}`,
    generation,
    () => {
      const r = new Prng(seed);
      const cells = new Uint8Array(size * size);
      fill(cells, r, density);
      return { cells, rng: r.state };
    },
    (b, n) => advance(b, n, size, rule, density),
    clone,
  ).cells;
}

const uniform = (v: readonly number[]) => v.every((x) => x === v[0]);

/**
 * The values a table reads from a board. If the chosen read is uniform (silent) the
 * next one that varies is used: other rows / columns, then the projections. Any board
 * that isn't uniform has a varying row or column, and boards are never uniform.
 */
export function lifeLine(cells: Uint8Array, size: number, read: number): number[] {
  const row = (y: number) => Array.from(cells.subarray(y * size, (y + 1) * size));
  const col = (x: number) => Array.from({ length: size }, (_, y) => cells[y * size + x]);
  const perCol = () => Array.from({ length: size }, (_, x) => col(x).reduce((s, v) => s + v, 0));
  const perRow = () => Array.from({ length: size }, (_, y) => row(y).reduce((s, v) => s + v, 0));
  const diag = () => Array.from({ length: size }, (_, i) => cells[i * size + i]);
  const mid = size >> 1;
  const rows = Array.from({ length: size }, (_, d) => () => row((mid + d) % size));
  const cols = Array.from({ length: size }, (_, d) => () => col((mid + d) % size));
  const order: (() => number[])[] = [
    [...rows, ...cols, perCol, perRow],
    [...cols, ...rows, perCol, perRow],
    [diag, ...rows, ...cols, perCol, perRow],
    [perCol, perRow, ...rows, ...cols],
    [perRow, perCol, ...rows, ...cols],
  ][clamp(Math.round(read), 0, 4)];
  let line: number[] = [];
  for (const f of order) if (!uniform((line = f()))) break;
  return line;
}

/** Table `index` of a batch: generation start + index·step, read as held steps. */
export function lifeTable(p: LifeParams, seed: number, index: number): Float32Array {
  const size = clamp(Math.round(p.size), 8, 64);
  const gen = Math.max(0, Math.round(p.start)) + index * clamp(Math.round(p.step), 1, 16);
  const line = lifeLine(lifeBoard(p, seed, gen), size, p.read);
  const x = new Float64Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i++) x[i] = line[Math.floor((i * size) / TABLE_SIZE)];
  return shape(x);
}
