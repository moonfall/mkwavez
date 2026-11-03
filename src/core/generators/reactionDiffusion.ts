/**
 * Reaction-diffusion ring: a 1D Gray-Scott system on a ring of cells, started from
 * seeded spots of V. Table i is V around the ring after start + i·steps steps, so a
 * batch is the pattern evolving over time (pulses splitting, travelling, dying out).
 */
import { Prng } from '../prng';
import { shape } from '../shape';
import { resamplePeriodic } from './resample';
import { StepCache } from './simCache';

/** Feed / kill presets (the last one = the custom sliders). */
export const RD_PRESETS: readonly { label: string; feed: number; kill: number }[] = [
  { label: 'Self-replicating pulses', feed: 0.04, kill: 0.055 },
  { label: 'Splitting', feed: 0.03, kill: 0.05 },
  { label: 'Stable spots', feed: 0.035, kill: 0.058 },
  { label: 'Slow growth', feed: 0.05, kill: 0.062 },
  { label: 'Turbulent', feed: 0.05, kill: 0.058 },
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

export const DEFAULT_RD: RdParams = { system: 0, feed: 0.04, kill: 0.055, cells: 128, steps: 400, start: 200, spots: 3 };

const DU = 0.16;
const DV = 0.08;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

interface RdState {
  u: Float64Array;
  v: Float64Array;
}

function init(cells: number, spots: number, seed: number): RdState {
  const r = new Prng(seed);
  const u = new Float64Array(cells).fill(1);
  const v = new Float64Array(cells);
  for (let s = 0; s < spots; s++) {
    const c = r.int(cells);
    const w = 4 + r.int(6);
    for (let d = -w; d <= w; d++) {
      const i = (c + d + cells) % cells;
      u[i] = 0.5;
      v[i] = 0.25;
    }
  }
  for (let i = 0; i < cells; i++) v[i] += 0.01 * r.next();
  return { u, v };
}

function advance(s: RdState, n: number, F: number, k: number): void {
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
  }
}

const cache = new StepCache<RdState>();
const clone = (s: RdState): RdState => ({ u: s.u.slice(), v: s.v.slice() });

/** The ring's V after `step` steps (for tests / previews). */
export function rdState(p: RdParams, seed: number, step: number): Float64Array {
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
    (s, n) => advance(s, n, F, k),
    clone,
  ).v;
}

/** Table `index` of a batch: V after start + index·steps steps. */
export function rdTable(p: RdParams, seed: number, index: number): Float32Array {
  const steps = clamp(Math.round(p.steps), 1, 1000);
  // A pattern that died out (V uniform to 1e-6) is silence, not amplified residue.
  return shape(resamplePeriodic(rdState(p, seed, Math.max(0, Math.round(p.start)) + index * steps), 1e-6));
}
