/**
 * Dynamical systems: iterate a 1D (or 2D) map from an initial condition that follows
 * the cycle's phase, so the result is periodic and loops cleanly. Sweeping the control
 * parameter across a batch walks the map's bifurcation diagram (period doubling →
 * chaos). Deterministic: no randomness.
 */
import { TABLE_SIZE } from '../constants';
import { shape } from '../shape';
import { batchU } from './perlin';

export const DYN_MAPS = ['logistic', 'sine', 'circle', 'henon', 'tent'] as const;
export type DynMap = (typeof DYN_MAPS)[number];

/** Dropdown labels, by map index (recipes store the index). */
export const DYN_MAP_LABELS: readonly string[] = [
  'Logistic (r 2.8–4)',
  'Sine map (r 0.6–1)',
  'Circle / Arnold (K 0–4)',
  'Hénon, x (a 0.9–1.4)',
  'Tent (μ 1–1.99)',
];

export interface DynParams {
  /** Index into DYN_MAPS. */
  map: number;
  /** Control parameter at the batch start / end, 0..1 (mapped onto the map's range). */
  control: number;
  controlEnd: number;
  /** Iterations per sample, 1..64. */
  iterations: number;
  /** Size of the phase-driven initial condition, 0.01..1. */
  spread: number;
  /** 0 = linear output, 1 = soft clip. */
  output: number;
}

export const DEFAULT_DYN: DynParams = { map: 0, control: 0.6, controlEnd: 1, iterations: 12, spread: 0.8, output: 0 };

const CIRCLE_OMEGA = 0.3;
const HENON_B = 0.3;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** The map's own control value for a normalised c in [0, 1]. */
export function dynControl(map: number, c: number): number {
  c = clamp(c, 0, 1);
  switch (DYN_MAPS[map] ?? 'logistic') {
    case 'logistic':
      return 2.8 + 1.2 * c;
    case 'sine':
      return 0.6 + 0.4 * c;
    case 'circle':
      return 4 * c;
    case 'henon':
      return 0.9 + 0.5 * c;
    case 'tent':
      return 1 + 0.99 * c;
  }
}

/** One sample: iterate the map from the initial condition at phase `ph` (radians). */
function iterate(map: DynMap, k: number, iters: number, spread: number, ph: number): number {
  const s = Math.sin(ph);
  switch (map) {
    case 'logistic': {
      let x = 0.5 + 0.49 * spread * s;
      for (let j = 0; j < iters; j++) x = k * x * (1 - x);
      return 2 * x - 1;
    }
    case 'sine': {
      let x = 0.5 + 0.49 * spread * s;
      for (let j = 0; j < iters; j++) x = k * Math.sin(Math.PI * x);
      return 2 * x - 1;
    }
    case 'tent': {
      let x = 0.5 + 0.49 * spread * s;
      for (let j = 0; j < iters; j++) x = k * Math.min(x, 1 - x);
      return 2 * x - 1;
    }
    case 'circle': {
      // θ0 = t (+ a periodic wobble as spread falls): the map commutes with integer
      // shifts of θ, so sin(2πθ) stays periodic over the cycle.
      let th = ph / (2 * Math.PI) + 0.15 * (1 - spread) * s;
      for (let j = 0; j < iters; j++) th = th + CIRCLE_OMEGA - (k / (2 * Math.PI)) * Math.sin(2 * Math.PI * th);
      return Math.sin(2 * Math.PI * th);
    }
    case 'henon': {
      let x = 0.6 * spread * s;
      let y = 0.6 * spread * HENON_B * Math.cos(ph);
      for (let j = 0; j < iters; j++) {
        // Clamped so orbits outside the basin stay finite (deterministically).
        const nx = clamp(1 - k * x * x + y, -2, 2);
        y = HENON_B * x;
        x = nx;
      }
      return x;
    }
  }
}

/**
 * One orbit sample for display (Seed's bifurcation diagram): map index `map`, the map's own
 * control `k` (dynControl), `iters` steps from the initial value at phase `ph`.
 */
export function dynIterate(map: number, k: number, iters: number, spread: number, ph: number): number {
  return iterate(DYN_MAPS[Math.round(map)] ?? 'logistic', k, iters, clamp(spread, 0.01, 1), ph);
}

/**
 * Table `index` of a batch: the control sweeps control → controlEnd across it. Where the
 * map settles on a fixed point (e.g. low r with many iterations) the cycle would be a
 * constant, i.e. silence after shaping: the iterations are halved until the transient
 * toward the fixed point still varies (≥ 1e-6), so every table is audible.
 */
export function dynamicalTable(p: DynParams, index: number, count: number): Float32Array {
  return shape(dynamicalRaw(p.map, p.control + (p.controlEnd - p.control) * batchU(index, count), p.iterations, p.spread, p.output));
}

/** The raw cycle (before shape()) for one normalised control value c ∈ [0, 1]. */
export function dynamicalRaw(map: number, c: number, iterations: number, spreadIn: number, output: number): Float64Array {
  const m = Math.round(map);
  const mapName = DYN_MAPS[m] ?? 'logistic';
  const k = dynControl(m, c);
  const spread = clamp(spreadIn, 0.01, 1);
  const x = new Float64Array(TABLE_SIZE);
  for (let iters = clamp(Math.round(iterations), 1, 64); ; iters = Math.floor(iters / 2)) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < TABLE_SIZE; i++) {
      const v = iterate(mapName, k, iters, spread, (2 * Math.PI * i) / TABLE_SIZE);
      x[i] = output >= 0.5 ? Math.tanh(3 * v) : v;
      lo = Math.min(lo, x[i]);
      hi = Math.max(hi, x[i]);
    }
    if (hi - lo >= 1e-6 || !(iters > 1)) break; // (also stops on NaN)
  }
  return x;
}
