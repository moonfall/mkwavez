/**
 * Seed → the "basis" plot: a small picture of what a builder is based on (a shaper's
 * transfer curve, a polygon, the noise plane a loop is read from, a cellular automaton's
 * generations, …), drawn beside the shown waveform and its spectrum. Keyed by Seed
 * library id; builders without one (basic waves, plain spectral sums, …) hide the plot.
 * Formula presets draw the unedited preset (seed.ts hides the plot once it is edited).
 */
import type { ParamValue } from '../core/table';
import { parseColor } from './canvas';

/** What the shown waveform was made from. */
export interface VizInput {
  /** The entry's params (defaults merged); empty for formula presets. */
  readonly params: Readonly<Record<string, number>>;
  readonly seed: number;
  /** Shown waveform: n (= index) and u (0–1 across the batch). */
  readonly index: number;
  readonly count: number;
  readonly u: number;
  /** Per-table host inputs (Glyph contour: the traced contour and character). */
  readonly inputs?: Readonly<Record<string, ParamValue>>;
}

export interface VizColors {
  /** Main curves. */
  readonly line: string;
  /** The highlighted part (what the shown waveform reads). */
  readonly accent: string;
  /** Secondary curves / context. */
  readonly muted: string;
  /** Grid lines. */
  readonly grid: string;
  /** Zero axes. */
  readonly axis: string;
  readonly bg: string;
  /** Heat-map ends and middle (noise, concentrations). */
  readonly heatLo: string;
  readonly heatMid: string;
  readonly heatHi: string;
}

export interface SeedViz {
  /** The caption under the plot: left · middle · right. */
  axis(i: VizInput): readonly [string, string, string];
  draw(g: CanvasRenderingContext2D, w: number, h: number, i: VizInput, c: VizColors): void;
}

const VIZ = new Map<string, SeedViz>();
const viz = (id: string, v: SeedViz) => VIZ.set(id, v);

/** The basis plot of a Seed library entry, if it has one. */
export function seedViz(id: string): SeedViz | undefined {
  return VIZ.get(id);
}

// ---------------- drawing helpers ----------------

const PAD = 5;
const TAU = 2 * Math.PI;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
/** Subscript digits (T₄). */
export const sub = (k: number) => String(k).replace(/\d/g, (d) => '₀₁₂₃₄₅₆₇₈₉'[Number(d)]);
export const f2 = (v: number) => v.toFixed(2);

/** Maps data coordinates (x0..x1, y0..y1; y up) into the plot box. */
export interface Scale {
  x(v: number): number;
  y(v: number): number;
}
export function scale(w: number, h: number, x0: number, x1: number, y0: number, y1: number, pad = PAD): Scale {
  return {
    x: (v) => pad + ((v - x0) / (x1 - x0)) * (w - 2 * pad),
    y: (v) => h - pad - ((v - y0) / (y1 - y0)) * (h - 2 * pad),
  };
}

/** Straight lines at data x = xs (vertical) and y = ys (horizontal). */
export function rules(g: CanvasRenderingContext2D, s: Scale, w: number, h: number, xs: readonly number[], ys: readonly number[], color: string, dash: number[] = []): void {
  g.strokeStyle = color;
  g.lineWidth = 1;
  g.setLineDash(dash);
  g.beginPath();
  for (const v of xs) {
    const x = Math.round(s.x(v)) + 0.5;
    g.moveTo(x, 0);
    g.lineTo(x, h);
  }
  for (const v of ys) {
    const y = Math.round(s.y(v)) + 0.5;
    g.moveTo(0, y);
    g.lineTo(w, y);
  }
  g.stroke();
  g.setLineDash([]);
}

/** y = f(x) for x in x0..x1 (non-finite values break the line). */
export function plot(g: CanvasRenderingContext2D, s: Scale, f: (x: number) => number, x0: number, x1: number, color: string, lineWidth = 1.5, steps = 240, dash: number[] = []): void {
  g.strokeStyle = color;
  g.lineWidth = lineWidth;
  g.lineJoin = 'round';
  g.setLineDash(dash);
  g.beginPath();
  let pen = false;
  for (let i = 0; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps;
    const y = f(x);
    if (!Number.isFinite(y)) {
      pen = false;
      continue;
    }
    if (pen) g.lineTo(s.x(x), s.y(y));
    else g.moveTo(s.x(x), s.y(y));
    pen = true;
  }
  g.stroke();
  g.setLineDash([]);
}

export function dot(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  g.fillStyle = color;
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.fill();
}

/**
 * A waveshaper's transfer curve y = f(x) over x ∈ [−1, 1] (y clipped to ±1.1), with the
 * input range ±inMax shaded and the identity dashed.
 */
export function transfer(g: CanvasRenderingContext2D, w: number, h: number, c: VizColors, f: (x: number) => number, inMax = 1): void {
  const side = Math.min(w, h);
  const s = scale(side, side, -1.1, 1.1, -1.1, 1.1);
  g.save();
  g.translate((w - side) / 2, (h - side) / 2);
  g.fillStyle = c.grid;
  g.fillRect(s.x(-inMax), 0, s.x(inMax) - s.x(-inMax), side);
  rules(g, s, side, side, [0], [0], c.axis);
  plot(g, s, (x) => x, -1, 1, c.muted, 1, 2, [3, 3]);
  plot(g, s, (x) => clamp(f(x), -1.1, 1.1), -1, 1, c.accent, 1.8, 300);
  g.restore();
}

/** A closed polar curve r(φ) ≥ 0 (φ in 0..2π, y up), scaled so its largest radius fits. */
export function polar(g: CanvasRenderingContext2D, w: number, h: number, r: (phi: number) => number, color: string, lineWidth = 1.8, steps = 360): void {
  const rs = Array.from({ length: steps + 1 }, (_, i) => r((TAU * i) / steps));
  const max = Math.max(1e-9, ...rs.filter(Number.isFinite));
  const R = Math.min(w, h) / 2 - PAD;
  g.strokeStyle = color;
  g.lineWidth = lineWidth;
  g.lineJoin = 'round';
  g.beginPath();
  rs.forEach((v, i) => {
    const a = (TAU * i) / steps;
    const k = (Number.isFinite(v) ? v : 0) / max;
    const x = w / 2 + R * k * Math.cos(a);
    const y = h / 2 - R * k * Math.sin(a);
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  });
  g.stroke();
}

/** Linear blend of two parsed colours as rgb(). */
function mix(a: [number, number, number], b: [number, number, number], t: number): string {
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
}

/** Diverging colour map for v ∈ [−1, 1] (heatLo · heatMid · heatHi). */
export function heatScale(c: VizColors): (v: number) => string {
  const lo = parseColor(c.heatLo);
  const mid = parseColor(c.heatMid);
  const hi = parseColor(c.heatHi);
  return (v) => {
    const t = clamp(v, -1, 1);
    return t < 0 ? mix(mid, lo, -t) : mix(mid, hi, t);
  };
}

/** A grid of cells (rows top to bottom), each filled with color(value) (null = leave empty). */
export function cells(g: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number, rows: readonly ArrayLike<number>[], color: (v: number, row: number, col: number) => string | null): void {
  const nr = rows.length;
  if (!nr) return;
  const ch = h / nr;
  rows.forEach((row, r) => {
    const cw = w / row.length;
    for (let k = 0; k < row.length; k++) {
      const col = color(row[k], r, k);
      if (!col) continue;
      g.fillStyle = col;
      // Snap to whole pixels (no seams between cells).
      const x = Math.floor(x0 + k * cw);
      const y = Math.floor(y0 + r * ch);
      g.fillRect(x, y, Math.floor(x0 + (k + 1) * cw) - x, Math.floor(y0 + (r + 1) * ch) - y);
    }
  });
}

/** Outline the box of row `r` of an `nr`-row grid drawn by cells(). */
export function rowMark(g: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number, nr: number, r: number, color: string): void {
  const ch = h / nr;
  g.strokeStyle = color;
  g.lineWidth = 1.5;
  g.strokeRect(x0 + 0.75, y0 + r * ch + 0.75, w - 1.5, Math.max(1, ch - 1.5));
}

/**
 * Stacked rows, one curve each: row k draws f(k, x) (values in −1..1) over x ∈ 0..1 at
 * amplitude amps[k] (≤ 1) of the row's half-height.
 */
export function layers(g: CanvasRenderingContext2D, w: number, h: number, c: VizColors, n: number, f: (k: number, x: number) => number, amps: readonly number[]): void {
  const rh = (h - 2) / n;
  for (let k = 0; k < n; k++) {
    const mid = 1 + rh * (k + 0.5);
    const amp = (rh / 2 - 1) * clamp(amps[k], 0, 1);
    g.strokeStyle = c.grid;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, Math.round(mid) + 0.5);
    g.lineTo(w, Math.round(mid) + 0.5);
    g.stroke();
    g.strokeStyle = k === 0 ? c.accent : c.line;
    g.lineWidth = 1.2;
    g.beginPath();
    const steps = Math.ceil(w);
    for (let i = 0; i <= steps; i++) {
      const x = i / steps;
      const y = mid - f(k, x) * amp;
      if (i) g.lineTo(x * w, y);
      else g.moveTo(x * w, y);
    }
    g.stroke();
  }
}

/** A circular rhythm: `steps` dots clockwise from the top, onsets (1) filled. */
export function rhythmCircle(g: CanvasRenderingContext2D, w: number, h: number, c: VizColors, pattern: readonly number[]): void {
  const n = pattern.length;
  const R = Math.min(w, h) / 2 - PAD - 4;
  const cx = w / 2;
  const cy = h / 2;
  const at = (j: number): [number, number] => {
    const a = -Math.PI / 2 + (TAU * j) / n;
    return [cx + R * Math.cos(a), cy + R * Math.sin(a)];
  };
  g.strokeStyle = c.grid;
  g.lineWidth = 1;
  g.beginPath();
  g.arc(cx, cy, R, 0, TAU);
  g.stroke();
  // The onsets joined: the rhythm's polygon.
  const on = pattern.flatMap((v, j) => (v ? [j] : []));
  if (on.length > 1) {
    g.strokeStyle = c.muted;
    g.beginPath();
    on.forEach((j, k) => {
      const [x, y] = at(j);
      if (k) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.closePath();
    g.stroke();
  }
  const r = clamp((TAU * R) / n / 3, 1.5, 4.5);
  pattern.forEach((v, j) => {
    const [x, y] = at(j);
    if (v) dot(g, x, y, r, c.accent);
    else {
      g.strokeStyle = c.muted;
      g.beginPath();
      g.arc(x, y, r * 0.7, 0, TAU);
      g.stroke();
    }
  });
}

/** Values as bars in a row of cells (min..max scaled), each labelled with its value when it fits. */
export function valueCells(g: CanvasRenderingContext2D, w: number, h: number, c: VizColors, values: readonly number[]): void {
  const n = values.length;
  if (!n) return;
  const lo = Math.min(0, ...values);
  const hi = Math.max(...values, lo + 1);
  const cw = w / n;
  const labels = cw >= 9;
  const top = PAD;
  const bottom = h - (labels ? 15 : PAD);
  g.font = `${Math.min(11, Math.floor(cw * 0.8))}px ui-monospace, monospace`;
  g.textAlign = 'center';
  values.forEach((v, j) => {
    const bh = ((v - lo) / (hi - lo)) * (bottom - top);
    g.fillStyle = j === 0 ? c.accent : c.line;
    g.globalAlpha = j === 0 ? 0.9 : 0.55;
    g.fillRect(j * cw + 1, bottom - bh, Math.max(1, cw - 2), Math.max(1, bh));
    g.globalAlpha = 1;
    if (labels) {
      g.fillStyle = j === 0 ? c.accent : c.muted;
      g.fillText(String(v), j * cw + cw / 2, h - 3);
    }
  });
  g.textAlign = 'left';
}

// ---------------- the builders ----------------

// Chebyshev: T_k(x) = cos(k·acos x), k = n + 2, applied to 0.95·sin p.
viz('chebyshev', {
  axis: (i) => ['−1', `T${sub(i.index + 2)}(x) on 0.95·sin p`, '1'],
  draw: (g, w, h, i, c) => transfer(g, w, h, c, (x) => Math.cos((i.index + 2) * Math.acos(clamp(x, -1, 1))), 0.95),
});

// Soft clip: tanh(d·x) / tanh(d), d = 1 + 5u.
viz('soft-clip', {
  axis: (i) => ['−1', `tanh(${(1 + 5 * i.u).toFixed(1)}·x) / tanh(${(1 + 5 * i.u).toFixed(1)})`, '1'],
  draw: (g, w, h, i, c) => {
    const d = 1 + 5 * i.u;
    transfer(g, w, h, c, (x) => Math.tanh(d * x) / Math.tanh(d));
  },
});
