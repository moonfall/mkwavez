/**
 * Reaction-diffusion ring: a 1D Gray-Scott system on a ring of cells, started from
 * seeded spots of V. Table i is V around the ring after start + i·steps steps, so a
 * batch is the pattern evolving over time (pulses splitting, travelling, dying out).
 */
import { Prng } from '../prng';
import { shape } from '../shape';
import { resamplePeriodic } from './resample';
import { StepCache } from './simCache';

/**
 * Feed / kill presets (the last one = the custom sliders), chosen so the pattern keeps
 * living and changing over a default batch for any seed.
 */
export const RD_PRESETS: readonly { label: string; feed: number; kill: number }[] = [
  { label: 'Wandering pulses', feed: 0.022, kill: 0.0525 },
  { label: 'Waves', feed: 0.018, kill: 0.05 },
  { label: 'Splitting', feed: 0.038, kill: 0.06 },
  { label: 'Growing spots', feed: 0.03, kill: 0.0575 },
  { label: 'Slow growth', feed: 0.054, kill: 0.0625 },
];
export const RD_CUSTOM = RD_PRESETS.length;

export interface RdParams {
  /** Index into RD_PRESETS, or RD_CUSTOM for feed / kill. ('preset' is taken: recipes use it for the library entry.) */
  system: number;
  feed: number;
  kill: number;
  /** Ring size, 16..256. */
  cells: number;
  /** Simulation steps between snapshots, 1..1000. */
  steps: number;
  /** Steps before the first snapshot. */
  start: number;
  /** Initial V spots (seeded positions / widths), 1..8. */
  spots: number;
}

export const DEFAULT_RD: RdParams = { system: 0, feed: 0.022, kill: 0.0525, cells: 128, steps: 400, start: 200, spots: 3 };

const DU = 0.16;
const DV = 0.08;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export interface RdState {
  u: Float64Array;
  v: Float64Array;
  /** Steps taken (die-out checks run at absolute step multiples, so checkpoints agree). */
  step: number;
  /** PRNG state for spots (initial and re-seeded). */
  rng: number;
}

/** Steps between die-out checks; a ring whose V spans less than DEAD gets new spots. */
const CHECK_EVERY = 50;
const DEAD = 1e-3;

function addSpots(s: RdState, spots: number): void {
  const r = new Prng(0);
  r.state = s.rng;
  const cells = s.u.length;
  for (let j = 0; j < spots; j++) {
    const c = r.int(cells);
    const w = 4 + r.int(6);
    for (let d = -w; d <= w; d++) {
      const i = (c + d + cells) % cells;
      s.u[i] = 0.5;
      s.v[i] = 0.25;
    }
  }
  for (let i = 0; i < cells; i++) s.v[i] += 0.01 * r.next();
  s.rng = r.state;
}

function init(cells: number, spots: number, seed: number): RdState {
  const s: RdState = { u: new Float64Array(cells).fill(1), v: new Float64Array(cells), step: 0, rng: seed >>> 0 };
  addSpots(s, spots);
  return s;
}

function advance(s: RdState, n: number, F: number, k: number, spots: number): void {
  const { u, v } = s;
  const L = u.length;
  const nu = new Float64Array(L);
  const nv = new Float64Array(L);
  for (let t = 0; t < n; t++) {
    for (let i = 0; i < L; i++) {
      const l = (i - 1 + L) % L;
      const r = (i + 1) % L;
      const uvv = u[i] * v[i] * v[i];
      nu[i] = u[i] + DU * (u[l] + u[r] - 2 * u[i]) - uvv + F * (1 - u[i]);
      nv[i] = v[i] + DV * (v[l] + v[r] - 2 * v[i]) + uvv - (F + k) * v[i];
    }
    u.set(nu);
    v.set(nv);
    if (++s.step % CHECK_EVERY === 0) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < L; i++) {
        lo = Math.min(lo, v[i]);
        hi = Math.max(hi, v[i]);
      }
      // Died out (or froze uniform): new seeded spots, so the batch stays audible.
      if (hi - lo < DEAD) addSpots(s, spots);
    }
  }
}

/** Simulation checkpoints (a pure memo: results never depend on it). */
const defaultCache = new StepCache<RdState>();
const clone = (s: RdState): RdState => ({ u: s.u.slice(), v: s.v.slice(), step: s.step, rng: s.rng });

/**
 * The ring's V after `step` steps. `cache` (default: a module-level memo of recent
 * simulations) only saves time; a port can pass its own or none.
 */
export function rdState(p: Pick<RdParams, 'system' | 'feed' | 'kill' | 'cells' | 'spots'>, seed: number, step: number, cache: StepCache<RdState> = defaultCache): Float64Array {
  const preset = RD_PRESETS[Math.round(p.system)];
  const F = preset ? preset.feed : clamp(p.feed, 0, 0.1);
  const k = preset ? preset.kill : clamp(p.kill, 0, 0.1);
  const cells = clamp(Math.round(p.cells), 16, 256);
  const spots = clamp(Math.round(p.spots), 1, 8);
  const key = `${F}|${k}|${cells}|${spots}|${seed >>> 0}`;
  return cache.at(
    key,
    step,
    () => init(cells, spots, seed >>> 0),
    (s, n) => advance(s, n, F, k, spots),
    clone,
  ).v;
}

/** Table `index` of a batch: V after start + index·steps steps. */
export function rdTable(p: RdParams, seed: number, index: number): Float32Array {
  const steps = clamp(Math.round(p.steps), 1, 1000);
  return shape(rdRaw(p, seed, Math.max(0, Math.round(p.start)) + index * steps));
}

/** The raw cycle (before shape()): V around the ring after `step` steps, resampled. */
export function rdRaw(p: Pick<RdParams, 'system' | 'feed' | 'kill' | 'cells' | 'spots'>, seed: number, step: number): Float64Array {
  // A pattern that died out (V uniform to 1e-6) is silence, not amplified residue.
  return resamplePeriodic(rdState(p, seed, step), 1e-6);
}
