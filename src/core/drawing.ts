/**
 * Drawings for Shape chain steps: a line, a smooth curve or a freehand stroke, stored as
 * points (x, y) sorted by x. Waveform drawings use x = phase 0–1 and y = level (±1 = the
 * source's peak); harmonic drawings use x = 0–1 over harmonics 1..KMAX and y = dB relative
 * to the strongest harmonic. A drawing covers only the x range it was drawn across (its
 * span); a step using it fades out over FEATHER at the span's ends unless the span reaches
 * that edge of the cycle. One point = a constant over the whole range.
 */

export type Pt = readonly [x: number, y: number];
export type DrawTool = 'line' | 'curve' | 'free';
export interface Drawing {
  readonly tool: DrawTool;
  readonly pts: readonly Pt[];
}

export const DRAW_TOOLS: readonly DrawTool[] = ['line', 'curve', 'free'];
/** Edge fade width (fraction of the x range). */
export const FEATHER = 0.03;
/** Most points a drawing keeps (freehand strokes are resampled to this). */
export const MAX_DRAW_POINTS = 64;
/** A span end this close to 0 or 1 counts as reaching the edge (no fade there). */
const EDGE = 0.002;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
/** Points are kept to 1e-4 so a normalised drawing is stable under re-normalising. */
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** The x range a drawing covers, or null for an empty drawing. */
export function drawingSpan(d: Drawing): [number, number] | null {
  const P = d.pts;
  if (!P.length) return null;
  if (P.length === 1) return [0, 1];
  return [P[0][0], P[P.length - 1][0]];
}

/** The drawing's value at x, or null outside its span. Curves are Catmull-Rom through the points. */
export function drawingValue(d: Drawing, x: number): number | null {
  const P = d.pts;
  if (!P.length) return null;
  if (P.length === 1) return P[0][1];
  if (x < P[0][0] || x > P[P.length - 1][0]) return null;
  let i = 0;
  while (i < P.length - 2 && x > P[i + 1][0]) i++;
  const a = P[i];
  const b = P[i + 1];
  const w = b[0] - a[0];
  const u = w > 1e-12 ? (x - a[0]) / w : 0;
  if (d.tool !== 'curve') return a[1] + (b[1] - a[1]) * u;
  const p0 = P[Math.max(0, i - 1)][1];
  const p1 = a[1];
  const p2 = b[1];
  const p3 = P[Math.min(P.length - 1, i + 2)][1];
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

/** Edge fade at x in [0, 1]: 1 inside the span, smoothstep to 0 over FEATHER at ends that don't reach an edge. */
export function drawingWeight(d: Drawing, x: number): number {
  const span = drawingSpan(d);
  if (!span) return 0;
  const [x0, x1] = span;
  if (x < x0 || x > x1) return 0;
  const a = x0 <= EDGE ? 1 : Math.min(1, (x - x0) / FEATHER);
  const b = x1 >= 1 - EDGE ? 1 : Math.min(1, (x1 - x) / FEATHER);
  const w = clamp(Math.min(a, b), 0, 1);
  return w * w * (3 - 2 * w);
}

/**
 * The drawing between a and b at u ∈ [0, 1] (a sweep from a start to an end drawing): each
 * point travels along its drawing's span (the same fraction of the way through each span), so
 * a line can move, tilt or stretch. Two lines stay a line; anything else becomes a dense
 * polyline (64 points). u ≤ 0 / ≥ 1 return a / b themselves.
 */
export function lerpDrawing(a: Drawing, b: Drawing, u: number): Drawing {
  if (u <= 0) return a;
  if (u >= 1) return b;
  const sa = drawingSpan(a);
  const sb = drawingSpan(b);
  if (!sa) return b;
  if (!sb) return a;
  const mix = (p: number, q: number) => p + (q - p) * u;
  if (a.tool === 'line' && b.tool === 'line' && a.pts.length === 2 && b.pts.length === 2)
    return { tool: 'line', pts: [0, 1].map((i) => [mix(a.pts[i][0], b.pts[i][0]), mix(a.pts[i][1], b.pts[i][1])] as Pt) };
  const M = MAX_DRAW_POINTS;
  const pts: Pt[] = [];
  for (let k = 0; k < M; k++) {
    const t = k / (M - 1);
    const xa = sa[0] + (sa[1] - sa[0]) * t;
    const xb = sb[0] + (sb[1] - sb[0]) * t;
    pts.push([mix(xa, xb), mix(drawingValue(a, xa) ?? 0, drawingValue(b, xb) ?? 0)]);
  }
  return { tool: 'free', pts };
}

/** Resolution of a StrokeBuffer (bins over x ∈ [0, 1]). */
const STROKE_BINS = 512;

/**
 * A freehand stroke as it is drawn: a value per x bin, where each new pointer position fills
 * the bins between it and the previous one (linear in between) and overwrites what was there.
 * Going back over the stroke therefore replaces it rather than averaging old and new samples
 * (which jitters). `seed()` starts from an existing drawing, so a stroke can extend or
 * overwrite part of it (with a jump where they meet).
 */
export class StrokeBuffer {
  private y = new Float64Array(STROKE_BINS);
  private set = new Uint8Array(STROKE_BINS);
  private last: Pt | null = null;
  private lo = STROKE_BINS;
  private hi = -1;

  private bin(x: number): number {
    return Math.max(0, Math.min(STROKE_BINS - 1, Math.round(x * (STROKE_BINS - 1))));
  }

  private put(i: number, v: number): void {
    this.y[i] = v;
    this.set[i] = 1;
    if (i < this.lo) this.lo = i;
    if (i > this.hi) this.hi = i;
  }

  /** Start from an existing drawing over its span (the next point begins a new stroke, unjoined). */
  seed(d: Drawing): void {
    const span = drawingSpan(d);
    if (!span) return;
    for (let i = this.bin(span[0]); i <= this.bin(span[1]); i++) {
      const v = drawingValue(d, i / (STROKE_BINS - 1));
      if (v !== null) this.put(i, v);
    }
    this.last = null;
  }

  /** The pointer moved to p: fill (and overwrite) the bins from the previous point to p. */
  add(p: Pt): void {
    const b = this.bin(p[0]);
    if (!this.last) this.put(b, p[1]);
    else {
      const a = this.bin(this.last[0]);
      const ya = this.last[1];
      const n = Math.abs(b - a);
      for (let k = 0; k <= n; k++) {
        const i = a + Math.sign(b - a) * k;
        this.put(i, n === 0 ? p[1] : ya + ((p[1] - ya) * k) / n);
      }
    }
    this.last = [p[0], p[1]];
  }

  /**
   * The stroke as at most `max` points over its span (bins in between that were never drawn —
   * a gap between a seeded drawing and a new stroke — are bridged linearly), each the mean of
   * its share of the bins. Fewer than 2 points = no stroke yet.
   */
  points(max = MAX_DRAW_POINTS): Pt[] {
    if (this.hi < this.lo) return [];
    if (this.hi === this.lo) return [[this.lo / (STROKE_BINS - 1), this.y[this.lo]]];
    const vals: number[] = [];
    let prev = this.lo;
    for (let i = this.lo; i <= this.hi; i++) {
      if (this.set[i]) {
        for (let j = prev + 1; j < i; j++) vals.push(this.y[prev] + ((this.y[i] - this.y[prev]) * (j - prev)) / (i - prev));
        vals.push(this.y[i]);
        prev = i;
      }
    }
    const n = vals.length;
    const m = Math.min(max, n);
    const out: Pt[] = [];
    for (let k = 0; k < m; k++) {
      // Bucket k of m over the bins; the end buckets sit exactly on the span's ends.
      const a = Math.floor((k * n) / m);
      const b = Math.max(a + 1, Math.floor(((k + 1) * n) / m));
      let sum = 0;
      for (let j = a; j < b; j++) sum += vals[j];
      const x = k === 0 ? this.lo : k === m - 1 ? this.hi : this.lo + (a + b - 1) / 2;
      out.push([x / (STROKE_BINS - 1), k === 0 ? vals[0] : k === m - 1 ? vals[n - 1] : sum / (b - a)]);
    }
    return out;
  }
}

/** A freehand stroke (any order, any length) as at most `max` points: binned along x and averaged. */
export function resampleStroke(raw: readonly Pt[], max = MAX_DRAW_POINTS): Pt[] {
  const pts = raw.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])).sort((a, b) => a[0] - b[0]);
  if (!pts.length) return [];
  const x0 = pts[0][0];
  const x1 = pts[pts.length - 1][0];
  if (x1 - x0 < 1e-4) return [pts[0]];
  const acc = Array.from({ length: max }, () => [0, 0, 0]);
  for (const [x, y] of pts) {
    const b = Math.min(max - 1, Math.floor(((x - x0) / (x1 - x0)) * max));
    acc[b][0] += x;
    acc[b][1] += y;
    acc[b][2]++;
  }
  const out: [number, number][] = acc.filter((a) => a[2] > 0).map((a) => [a[0] / a[2], a[1] / a[2]]);
  out[0][0] = x0;
  out[out.length - 1][0] = x1;
  return out;
}

/**
 * A valid drawing from untrusted data: known tool, finite points clamped to x ∈ [0, 1] and
 * y ∈ [yMin, yMax], rounded to 1e-4, sorted by x with duplicate x removed, a line reduced to
 * its two end points, at most MAX_DRAW_POINTS. Idempotent.
 */
export function normalizeDrawing(raw: unknown, yMin: number, yMax: number, fallback: Drawing): Drawing {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const tool: DrawTool = DRAW_TOOLS.includes(o.tool as DrawTool) ? (o.tool as DrawTool) : fallback.tool;
  const src = Array.isArray(o.pts) ? o.pts : fallback.pts;
  let pts: Pt[] = [];
  for (const p of src) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    pts.push([r4(clamp(x, 0, 1)), r4(clamp(y, yMin, yMax))]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  pts = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0]);
  if (pts.length > MAX_DRAW_POINTS) pts = resampleStroke(pts).map(([x, y]) => [r4(x), r4(y)] as Pt);
  if (tool === 'line' && pts.length > 2) pts = [pts[0], pts[pts.length - 1]];
  if (!pts.length) pts = fallback.pts.slice();
  return { tool, pts };
}
