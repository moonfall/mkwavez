/**
 * Polygon: a regular polygon or star polygon {n/k} (vertices on the unit circle; a star
 * whose step shares a factor with n is the compound of its loops, e.g. {6/2} = two
 * triangles), read one of two ways:
 *  - Radius vs angle: the distance from the centre to the outline along each angle (the
 *    farthest crossing for stars), the cycle going once around.
 *  - Trace: the outline drawn at constant speed, edge after edge; the waveform is the
 *    pen's x coordinate (so rotation changes the waveform; for the radius it only shifts
 *    the cycle, which shape()'s phase alignment undoes).
 * Roundness rounds the corners (each a quadratic Bézier from partway along its edges).
 */
import { TABLE_SIZE } from '../constants';
import { shape } from '../shape';
import { batchU } from './perlin';

export const POLYGON_READS = ['Radius vs angle', 'Trace (x as it is drawn)'] as const;
export const POLYGON_BATCHES = ['Add a side per waveform', 'Sweep roundness', 'Sweep rotation'] as const;
/** Most sides a polygon takes (the slider's 16 + one per batch waveform, with headroom). */
export const POLYGON_MAX_SIDES = 128;

export interface PolygonParams {
  /** POLYGON_READS index. */
  read: number;
  /** 3 … 16 (+ the batch index when adding sides). */
  sides: number;
  /** Star step k of {n/k}: 1 = convex; clamped to < n/2. */
  star: number;
  /** 0 … 0.95: how far along each edge the rounded corners reach (× ½). */
  roundness: number;
  roundnessEnd: number;
  /** Turns (Trace: which way the outline is projected). */
  rotation: number;
  rotationEnd: number;
  /** POLYGON_BATCHES index. */
  batch: number;
}

export const DEFAULT_POLYGON: PolygonParams = { read: 0, sides: 3, star: 1, roundness: 0, roundnessEnd: 0.6, rotation: 0, rotationEnd: 0.25, batch: 0 };

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** Sides and star step as used: n rounded to 3 … POLYGON_MAX_SIDES, k to 1 … ⌊(n−1)/2⌋ (at least 1). */
export function polygonShape(sides: number, star: number): { n: number; k: number } {
  const n = clamp(Math.round(sides), 3, POLYGON_MAX_SIDES);
  const k = clamp(Math.round(star), 1, Math.max(1, Math.floor((n - 1) / 2)));
  return { n, k };
}

/** Corner rounding: a corner becomes a quadratic Bézier sampled at this many segments. */
const CORNER_STEPS = 12;

/** The vertices of each loop, in drawing order (one loop unless the star is a compound). */
function loops(sides: number, star: number, rotation: number): [number, number][][] {
  const { n, k } = polygonShape(sides, star);
  const count = gcd(n, k);
  const per = n / count;
  const at = (v: number): [number, number] => {
    const a = 2 * Math.PI * (v / n + rotation);
    return [Math.cos(a), Math.sin(a)];
  };
  return Array.from({ length: count }, (_, l) => Array.from({ length: per }, (_, m) => at(l + m * k)));
}

/**
 * Each loop's outline as a closed polyline (first point repeated last). Roundness r cuts
 * every corner from r/2 of the way along each of its edges, replacing it with a quadratic
 * Bézier through the corner (r = 1 would leave no straight part).
 */
export function polygonOutline(sides: number, star: number, roundness: number, rotation: number): [number, number][][] {
  const t = clamp(roundness, 0, 1) / 2;
  return loops(sides, star, rotation).map((V) => {
    const m = V.length;
    const out: [number, number][] = [];
    for (let j = 0; j < m; j++) {
      const [cx, cy] = V[j];
      if (!t) {
        out.push([cx, cy]);
        continue;
      }
      const [px, py] = V[(j + m - 1) % m];
      const [nx, ny] = V[(j + 1) % m];
      const ax = cx + t * (px - cx);
      const ay = cy + t * (py - cy);
      const bx = cx + t * (nx - cx);
      const by = cy + t * (ny - cy);
      for (let q = 0; q <= CORNER_STEPS; q++) {
        const s = q / CORNER_STEPS;
        const w0 = (1 - s) * (1 - s);
        const w1 = 2 * s * (1 - s);
        const w2 = s * s;
        out.push([w0 * ax + w1 * cx + w2 * bx, w0 * ay + w1 * cy + w2 * by]);
      }
    }
    out.push(out[0]);
    return out;
  });
}

/** Farthest crossing of the ray from the centre along angle a with the outlines (0 if none). */
function rayRadius(outlines: readonly [number, number][][], a: number): number {
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  let best = 0;
  for (const L of outlines)
    for (let i = 0; i + 1 < L.length; i++) {
      const [ax, ay] = L[i];
      const ex = L[i + 1][0] - ax;
      const ey = L[i + 1][1] - ay;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = (ax * ey - ay * ex) / den;
      const s = (ax * dy - ay * dx) / den;
      if (t > 0 && s >= -1e-12 && s <= 1 + 1e-12 && t > best) best = t;
    }
  return best;
}

/**
 * The points the waveform reads, one per sample (N = TABLE_SIZE): Radius — the outline
 * point at each angle; Trace — the pen position, moving at constant speed along the
 * outline (loop after loop).
 */
export function polygonPoints(sides: number, star: number, roundness: number, rotation: number, read: number): [number, number][] {
  const outlines = polygonOutline(sides, star, roundness, rotation);
  const N = TABLE_SIZE;
  const out: [number, number][] = [];
  if (Math.round(read) === 1) {
    const seg: number[][] = [];
    for (const L of outlines) for (let i = 0; i + 1 < L.length; i++) seg.push([L[i][0], L[i][1], L[i + 1][0], L[i + 1][1], Math.hypot(L[i + 1][0] - L[i][0], L[i + 1][1] - L[i][1])]);
    const total = seg.reduce((sum, e) => sum + e[4], 0);
    let e = 0;
    let before = 0; // length of the segments before seg[e]
    for (let i = 0; i < N; i++) {
      const s = (i * total) / N;
      while (e < seg.length - 1 && before + seg[e][4] <= s) before += seg[e++][4];
      const [ax, ay, bx, by, len] = seg[e];
      const f = len > 0 ? (s - before) / len : 0;
      out.push([ax + (bx - ax) * f, ay + (by - ay) * f]);
    }
  } else {
    for (let i = 0; i < N; i++) {
      const a = (2 * Math.PI * i) / N;
      const r = rayRadius(outlines, a);
      out.push([r * Math.cos(a), r * Math.sin(a)]);
    }
  }
  return out;
}

/** The raw cycle (before shape()): the radius at each angle, or the traced x. */
export function polygonRaw(sides: number, star: number, roundness: number, rotation: number, read: number): Float64Array {
  const pts = polygonPoints(sides, star, roundness, rotation, read);
  const trace = Math.round(read) === 1;
  return Float64Array.from(pts, ([x, y]) => (trace ? x : Math.hypot(x, y)));
}

/** Sides, roundness and rotation of table `index` (the batch sweeps one of them). */
export function polygonAt(p: PolygonParams, index: number, count: number): { sides: number; roundness: number; rotation: number } {
  const u = batchU(index, count);
  const b = Math.round(p.batch);
  return {
    sides: Math.round(p.sides) + (b === 0 ? index : 0),
    roundness: b === 1 ? p.roundness + (p.roundnessEnd - p.roundness) * u : p.roundness,
    rotation: b === 2 ? p.rotation + (p.rotationEnd - p.rotation) * u : p.rotation,
  };
}

export function polygonTable(p: PolygonParams, index: number, count: number): Float32Array {
  const a = polygonAt(p, index, count);
  return shape(polygonRaw(a.sides, p.star, a.roundness, a.rotation, p.read));
}
