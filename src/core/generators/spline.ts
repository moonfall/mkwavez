/**
 * Spline: M seeded control points, evenly spaced around the cycle, joined by a periodic
 * cardinal (Catmull-Rom at tension 0) or uniform cubic B-spline. A batch either sweeps
 * the jitter (each point moves by jitter·d_j, d_j seeded) or adds one point per table
 * (the first points stay put: they are the same draws).
 */
import { TABLE_SIZE } from '../constants';
import { Prng } from '../prng';
import { shape } from '../shape';
import { batchU } from './perlin';

export interface SplineParams {
  /** Control points, 3..32. */
  points: number;
  /** 0 = cardinal / Catmull-Rom, 1 = B-spline. */
  kind: number;
  /** Cardinal: tangent scale 1 − tension; B-spline: blend toward the control polygon. */
  tension: number;
  /** Point jitter at the batch start / end, 0..1. */
  jitter: number;
  jitterEnd: number;
  /** 0 = sweep the jitter, 1 = add a point per table. */
  batch: number;
}

export const DEFAULT_SPLINE: SplineParams = { points: 8, kind: 0, tension: 0, jitter: 0, jitterEnd: 0.6, batch: 0 };

const MAX_POINTS = 32;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Control point values of table `index`. */
export function splinePoints(p: SplineParams, seed: number, index: number, count: number): number[] {
  const u = batchU(index, count);
  const addPoints = Math.round(p.batch) === 1;
  const M = clamp(Math.round(p.points) + (addPoints ? index : 0), 3, MAX_POINTS + 64);
  const r = new Prng(seed);
  // Base values and jitter directions, drawn in pairs so point j never depends on M.
  const base: number[] = [];
  const dir: number[] = [];
  for (let j = 0; j < M; j++) {
    base.push(r.bipolar());
    dir.push(r.bipolar());
  }
  const J = addPoints ? p.jitter : p.jitter + (p.jitterEnd - p.jitter) * u;
  return base.map((b, j) => b + J * dir[j]);
}

export function splineTable(p: SplineParams, seed: number, index: number, count: number): Float32Array {
  const P = splinePoints(p, seed, index, count);
  const M = P.length;
  const at = (j: number) => P[((j % M) + M) % M];
  const tau = clamp(p.tension, 0, 1);
  const bspline = Math.round(p.kind) === 1;
  const x = new Float64Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i++) {
    const s = (i * M) / TABLE_SIZE;
    const j = Math.floor(s);
    const f = s - j;
    const p0 = at(j - 1);
    const p1 = at(j);
    const p2 = at(j + 1);
    const p3 = at(j + 2);
    const f2 = f * f;
    const f3 = f2 * f;
    if (bspline) {
      const bs = ((1 - f) ** 3 * p0 + (3 * f3 - 6 * f2 + 4) * p1 + (-3 * f3 + 3 * f2 + 3 * f + 1) * p2 + f3 * p3) / 6;
      x[i] = (1 - tau) * bs + tau * (p1 + (p2 - p1) * f);
    } else {
      const m1 = ((1 - tau) * (p2 - p0)) / 2;
      const m2 = ((1 - tau) * (p3 - p1)) / 2;
      x[i] = (2 * f3 - 3 * f2 + 1) * p1 + (f3 - 2 * f2 + f) * m1 + (-2 * f3 + 3 * f2) * p2 + (f3 - f2) * m2;
    }
  }
  return shape(x);
}
