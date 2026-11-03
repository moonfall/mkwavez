/**
 * Glyph contour: a closed polyline (the outer contour of a character, traced by the host
 * — browser: src/browser/glyphTrace.ts) read as radius vs angle around its centroid.
 * The core never sees fonts: recipes store the polyline itself, so a table re-renders
 * anywhere. A skew (x += s·y) can sweep across the batch; a rotation would only shift
 * the cycle (undone by shape()'s phase alignment), so there is none.
 */
import { TABLE_SIZE } from '../constants';
import { shape } from '../shape';
import { batchU } from './perlin';

/** Fallback contour (a five-pointed star) when the host supplies none. */
export const DEFAULT_CONTOUR = Array.from({ length: 10 }, (_, j) => {
  const a = (Math.PI * j) / 5 - Math.PI / 2;
  const r = j % 2 ? 0.2 : 0.45;
  return `${(0.5 + r * Math.cos(a)).toFixed(3)},${(0.5 + r * Math.sin(a)).toFixed(3)}`;
}).join(' ');

/** "x,y x,y …" → flat [x0, y0, x1, y1, …] (invalid pairs skipped). */
export function parseContour(s: string): number[] {
  const out: number[] = [];
  for (const pt of s.trim().split(/\s+/)) {
    const [x, y] = pt.split(',').map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push(x, y);
  }
  return out;
}

/** Flat points → "x,y x,y …" with 3 decimals (coordinates normalised to about 0..1). */
export function encodeContour(pts: readonly number[]): string {
  const out: string[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) out.push(`${pts[i].toFixed(3)},${pts[i + 1].toFixed(3)}`);
  return out.join(' ');
}

/** Area centroid of a closed polygon (vertex mean if degenerate). */
function centroid(p: readonly number[]): [number, number] {
  const n = p.length / 2;
  let A = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const c = p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1];
    A += c;
    cx += (p[2 * i] + p[2 * j]) * c;
    cy += (p[2 * i + 1] + p[2 * j + 1]) * c;
  }
  if (Math.abs(A) > 1e-9) return [cx / (3 * A), cy / (3 * A)];
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += p[2 * i];
    my += p[2 * i + 1];
  }
  return [mx / n, my / n];
}

/** Farthest hit of the ray from (cx, cy) along (dx, dy) on the polygon's edges (0 if none). */
function rayRadius(p: readonly number[], cx: number, cy: number, dx: number, dy: number): number {
  const n = p.length / 2;
  let best = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = p[2 * i] - cx;
    const ay = p[2 * i + 1] - cy;
    const ex = p[2 * j] - p[2 * i];
    const ey = p[2 * j + 1] - p[2 * i + 1];
    // Solve t·d = a + s·e for t ≥ 0, s ∈ [0, 1].
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = (ax * ey - ay * ex) / den;
    const s = (ax * dy - ay * dx) / den;
    if (t > 0 && s >= 0 && s <= 1 && t > best) best = t;
  }
  return best;
}

export interface GlyphParams {
  /** The contour ("x,y x,y …"); empty → DEFAULT_CONTOUR. */
  contour: string;
  /** Skew x += s·y at the batch start / end, −1..1. */
  skew: number;
  skewEnd: number;
}

/** |area| of a closed polygon. */
function area(p: readonly number[]): number {
  const n = p.length / 2;
  let A = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    A += p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1];
  }
  return Math.abs(A) / 2;
}

/** Radius vs angle of the (skewed) contour, or null when it is flat (silent). */
function radii(contour: readonly number[], s: number): Float64Array | null {
  const pts = contour.map((v, i) => (i % 2 ? v : v + s * (contour[i + 1] - 0.5)));
  const [cx, cy] = centroid(pts);
  const x = new Float64Array(TABLE_SIZE);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < TABLE_SIZE; i++) {
    const a = (2 * Math.PI * i) / TABLE_SIZE;
    x[i] = rayRadius(pts, cx, cy, Math.cos(a), Math.sin(a));
    lo = Math.min(lo, x[i]);
    hi = Math.max(hi, x[i]);
  }
  return hi - lo > 1e-6 ? x : null;
}

/**
 * Table `index` of a batch: the contour's radius vs angle, skewed by skew → skewEnd. A
 * missing, degenerate (area ≈ 0, e.g. collinear) or flat-reading contour falls back to
 * DEFAULT_CONTOUR, so a table is never silent.
 */
export function glyphTable(p: GlyphParams, index: number, count: number): Float32Array {
  const s = p.skew + (p.skewEnd - p.skew) * batchU(index, count);
  const pts = parseContour(p.contour);
  const x = (pts.length >= 6 && area(pts) > 1e-4 && radii(pts, s)) || radii(parseContour(DEFAULT_CONTOUR), s)!;
  return shape(x);
}
