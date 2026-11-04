/**
 * Seed → the "basis" plot: a small picture of what a builder is based on (a shaper's
 * transfer curve, a polygon, the noise plane a loop is read from, a cellular automaton's
 * generations, …), drawn beside the shown waveform and its spectrum. Keyed by Seed
 * library id; builders without one (basic waves, plain spectral sums, …) hide the plot.
 * Formula presets draw the unedited preset (seed.ts hides the plot once it is edited).
 */
import { KMAX } from '../core/constants';
import {
  caRows,
  FM_ROUTINGS,
  FRACTAL_BASES,
  fractalBase,
  fractalDecay,
  fmIndex,
  fmModulator,
  contourPoints,
  DYN_MAP_LABELS,
  dynControl,
  dynIterate,
  KS_MAX_PASS,
  ksExcite,
  ksPasses,
  LIFE_RULES,
  PD_SHAPES,
  perlinAt,
  pdAmount,
  pdMap,
  lifeBoard,
  rdState,
  RESONANCE_WINDOWS,
  resonanceRatio,
  resonanceWindow,
  SEQ_SOURCES,
  sequenceValues,
  splinePoints,
  splineRaw,
  polygonAt,
  polygonOutline,
  polygonShape,
  SHAPERS,
  shaperAt,
  shaperCurve,
  StepCache,
  superformulaAt,
  superformulaRadius,
  supersawLevel,
  supersawPhases,
  SYNC_WAVES,
  syncRatio,
  syncWave,
  type Board,
  type FmParams,
  type FractalParams,
  type LifeParams,
  type PdParams,
  type PerlinParams,
  type PolygonParams,
  type ShaperParams,
  type RdParams,
  type RdState,
  type ResonanceParams,
  type SequenceParams,
  type SplineParams,
  type SuperformulaParams,
  type SyncParams,
} from '../core/generators';
import { fbm, noiseField } from '../core/perlin';
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
 * input range inMin…inMax (default ±inMax) shaded and the identity dashed.
 */
export function transfer(g: CanvasRenderingContext2D, w: number, h: number, c: VizColors, f: (x: number) => number, inMax = 1, inMin = -inMax): void {
  const side = Math.min(w, h);
  const s = scale(side, side, -1.1, 1.1, -1.1, 1.1);
  g.save();
  g.translate((w - side) / 2, (h - side) / 2);
  g.fillStyle = c.grid;
  const lo = clamp(inMin, -1.1, 1.1);
  const hi = clamp(inMax, -1.1, 1.1);
  g.fillRect(s.x(lo), 0, s.x(hi) - s.x(lo), side);
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

// Supersaw: each voice's phase (mod 1) across the batch (time →), the shown moment marked.
viz('supersaw', {
  axis: (i) => ['u 0', `${Math.round(i.params.voices)} voices · outer ±${f2(i.params.detune * i.u)} cycles`, '1'],
  draw: (g, w, h, i, c) => {
    const p = i.params;
    const V = clamp(Math.round(p.voices), 1, 15);
    const s = scale(w, h, 0, 1, 0, 1);
    rules(g, s, w, h, [0.5], [0.5], c.grid);
    const at = (u: number) => supersawPhases(V, p.detune * u, p.phases, i.seed);
    const steps = Math.ceil(w);
    const frac = (v: number) => v - Math.floor(v);
    for (let j = 0; j < V; j++) {
      g.strokeStyle = j === (V - 1) / 2 ? c.accent : c.line;
      g.globalAlpha = 0.35 + 0.65 * supersawLevel(j, V, p.outer);
      g.lineWidth = 1.2;
      g.beginPath();
      let prev = NaN;
      for (let k = 0; k <= steps; k++) {
        const u = k / steps;
        const y = frac(at(u)[j]);
        // Break the line where the phase wraps.
        if (k && Math.abs(y - prev) < 0.5) g.lineTo(s.x(u), s.y(y));
        else g.moveTo(s.x(u), s.y(y));
        prev = y;
      }
      g.stroke();
    }
    g.globalAlpha = 1;
    rules(g, s, w, h, [i.u], [], c.accent);
    at(i.u).forEach((v, j) => dot(g, s.x(i.u), s.y(frac(v)), 2.5, j === (V - 1) / 2 ? c.accent : c.line));
  },
});

// Waveshaper (Soft clip, Chebyshev, Superellipse, Shaped PWM, …): the transfer curve at the shown
// waveform's amount, the input's range (level around the bias) shaded.
viz('mode:shaper', {
  axis: (i) => {
    const a = shaperAt(i.params as unknown as ShaperParams, i.index, i.count);
    const b = a.bias ? ` · bias ${a.bias < 0 ? '−' : '+'}${f2(Math.abs(a.bias))}` : '';
    return ['−1', `${SHAPERS[Math.round(i.params.shaper)] ?? ''} · amount ${f2(a.amount)}${b}`, '1'];
  },
  draw: (g, w, h, i, c) => {
    const a = shaperAt(i.params as unknown as ShaperParams, i.index, i.count);
    const f = shaperCurve(i.params.shaper, a.amount);
    transfer(g, w, h, c, f, a.bias + i.params.level, a.bias - i.params.level);
  },
});

// Superformula: the shape in polar form at the shown n2 / n3 (radius vs angle is the waveform).
viz('mode:superformula', {
  axis: (i) => {
    const a = superformulaAt(i.params as unknown as SuperformulaParams, i.index, i.count);
    return ['', `m ${i.params.m} · n1 ${f2(i.params.n1)} · n2 ${f2(a.n2)} · n3 ${f2(a.n3)}`, ''];
  },
  draw: (g, w, h, i, c) => {
    const p = i.params;
    const a = superformulaAt(p as unknown as SuperformulaParams, i.index, i.count);
    g.strokeStyle = c.grid;
    g.beginPath();
    g.arc(w / 2, h / 2, Math.min(w, h) / 2 - 5, 0, TAU);
    g.stroke();
    polar(g, w, h, (phi) => Math.min(1e6, superformulaRadius(p.m, p.n1, a.n2, a.n3, phi)), c.accent);
  },
});

// Phase distortion (CZ phase dist, …): the phase map t → φ at the shown amount (identity dashed).
viz('mode:pd', {
  axis: (i) => ['t 0', `${PD_SHAPES[Math.round(i.params.shape)] ?? ''} phase map · amount ${f2(pdAmount(i.params as unknown as PdParams, i.index, i.count))}`, '1'],
  draw: (g, w, h, i, c) => {
    const f = pdMap(i.params.shape, pdAmount(i.params as unknown as PdParams, i.index, i.count));
    const s = scale(w, h, 0, 1, 0, 1);
    rules(g, s, w, h, [0.5], [0.25, 0.5, 0.75], c.grid);
    plot(g, s, (t) => t, 0, 1, c.muted, 1, 2, [3, 3]);
    plot(g, s, f, 0, 1, c.accent, 1.8, 600);
  },
});

// Phase modulation presets: the modulator φ(p) added to the carrier's phase.
const modulator = (g: CanvasRenderingContext2D, w: number, h: number, c: VizColors, f: (p: number) => number, max: number) => {
  const s = scale(w, h, 0, TAU, -max, max);
  rules(g, s, w, h, [Math.PI / 2, Math.PI, 1.5 * Math.PI], [], c.grid);
  rules(g, s, w, h, [], [0], c.axis);
  plot(g, s, f, 0, TAU, c.accent, 1.8, 400);
};
// FM / PM (FM sweep, Nested FM, Cross PM, …): the modulator index·M(p) at the shown index, on the
// batch's largest scale (so the sweep is visible).
viz('mode:fm', {
  axis: (i) => ['0', `index ${f2(fmIndex(i.params as unknown as FmParams, i.index, i.count))} · ${FM_ROUTINGS[Math.round(i.params.routing)]?.split(' (')[0] ?? ''}`, '2π'],
  draw: (g, w, h, i, c) => {
    const p = i.params;
    const m = fmModulator(p.ratio, p.ratio2, p.amount2, p.routing);
    const I = fmIndex(p as unknown as FmParams, i.index, i.count);
    const peak = Math.max(1e-6, ...Array.from({ length: 256 }, (_, k) => Math.abs(m((2 * Math.PI * k) / 256))));
    const max = Math.max(Math.abs(p.index), Math.abs(p.indexEnd), 0.1) * peak * 1.05;
    modulator(g, w, h, c, (x) => I * m(x), max);
  },
});

// Hard sync (Sync sweep, …): two master cycles — the slave restarted at each (solid) against the
// free-running slave (dashed), at the shown ratio.
viz('mode:sync', {
  axis: (i) => ['0', `${SYNC_WAVES[Math.round(i.params.wave)] ?? ''} slave ×${f2(syncRatio(i.params as unknown as SyncParams, i.index, i.count))}, reset each cycle`, '4π'],
  draw: (g, w, h, i, c) => {
    const r = syncRatio(i.params as unknown as SyncParams, i.index, i.count);
    const f = syncWave(i.params.wave);
    const s = scale(w, h, 0, 2 * TAU, -1.1, 1.1);
    rules(g, s, w, h, [TAU], [], c.axis);
    rules(g, s, w, h, [], [0], c.grid);
    plot(g, s, (p) => f(r * p), 0, 2 * TAU, c.muted, 1, 800, [3, 3]);
    plot(g, s, (p) => (p % TAU < 1e-9 && p > 0 ? NaN : f(r * (p % TAU))), 0, 2 * TAU, c.accent, 1.8, 800);
  },
});

// Pluck position: a string pulled into a triangle at x = 0.05 + 0.45u of its length.
viz('pluck-position', {
  axis: (i) => ['nut', `plucked at ${f2(0.05 + 0.45 * i.u)}`, 'bridge'],
  draw: (g, w, h, i, c) => {
    const x = 0.05 + 0.45 * i.u;
    const s = scale(w, h, 0, 1, -0.4, 1.1, 10);
    rules(g, s, w, h, [], [0], c.grid, [3, 3]);
    g.strokeStyle = c.accent;
    g.lineWidth = 1.8;
    g.beginPath();
    g.moveTo(s.x(0), s.y(0));
    g.lineTo(s.x(x), s.y(0.8));
    g.lineTo(s.x(1), s.y(0));
    g.stroke();
    for (const e of [0, 1]) {
      g.fillStyle = c.line;
      g.fillRect(s.x(e) - 1.5, s.y(0) - 7, 3, 14);
    }
    dot(g, s.x(x), s.y(0.8), 3.5, c.line);
  },
});

// Fractal sum (Weierstrass, Blancmange, …): the terms stacked, one row each at its amplitude
// decay^k (the first highlighted).
viz('mode:fractal', {
  axis: (i) => {
    const d = fractalDecay(i.params as unknown as FractalParams, i.index, i.count);
    return ['0', `${Math.round(i.params.terms)} × ${FRACTAL_BASES[Math.round(i.params.base)]?.split(' (')[0].toLowerCase() ?? ''} · ratio ${i.params.ratio} · decay ${f2(d)}`, '1'];
  },
  draw: (g, w, h, i, c) => {
    const p = i.params;
    const d = fractalDecay(p as unknown as FractalParams, i.index, i.count);
    const K = clamp(Math.round(p.terms), 1, 10);
    const base = fractalBase(p.base);
    // Each base scaled to ±1 for drawing (the triangle's 0 … ½ centred).
    const unit = Math.round(p.base) === 1 ? (k: number, t: number) => 4 * base(Math.pow(p.ratio, k), t) - 1 : (k: number, t: number) => base(Math.pow(p.ratio, k), t);
    layers(g, w, h, c, K, unit, Array.from({ length: K }, (_, k) => Math.pow(d, k)));
  },
});

// Polygon: the outline the waveform reads (sides, star, roundness, rotation of the shown waveform).
viz('polygon', {
  axis: (i) => {
    const a = polygonAt(i.params as unknown as PolygonParams, i.index, i.count);
    const { n, k } = polygonShape(a.sides, i.params.star);
    return ['', `${k === 1 ? `${n}-gon` : `{${n}/${k}} star`} · ${Math.round(i.params.read) === 1 ? 'traced x' : 'radius vs angle'}`, ''];
  },
  draw: (g, w, h, i, c) => {
    const a = polygonAt(i.params as unknown as PolygonParams, i.index, i.count);
    const trace = Math.round(i.params.read) === 1;
    const R = Math.min(w, h) / 2 - 6;
    const cx = w / 2;
    const cy = h / 2;
    const X = (x: number) => cx + R * x;
    const Y = (y: number) => cy - R * y;
    g.strokeStyle = c.grid;
    g.lineWidth = 1;
    g.beginPath();
    g.arc(cx, cy, R, 0, TAU);
    g.moveTo(cx - R, cy);
    g.lineTo(cx + R, cy);
    g.stroke();
    const outlines = polygonOutline(a.sides, i.params.star, a.roundness, a.rotation);
    g.strokeStyle = c.accent;
    g.lineWidth = 1.8;
    g.lineJoin = 'round';
    g.beginPath();
    for (const L of outlines) L.forEach(([x, y], j) => (j ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
    g.stroke();
    // Where the cycle starts: angle 0 (radius) or the pen's first point (trace).
    const [sx, sy] = trace ? outlines[0][0] : [1, 0];
    if (!trace) {
      g.strokeStyle = c.line;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(X(sx), Y(sy));
      g.stroke();
    }
    dot(g, X(sx), Y(sy), 3, c.line);
  },
});

// Gray code: bits of g = s ^ (s >> 1), s = 0…63, masked by n + 7.
viz('gray-code', {
  axis: (i) => ['0', `Gray-code bits & ${i.index + 7}`, '63'],
  draw: (g, w, h, i, c) => {
    const mask = i.index + 7;
    const rows = Array.from({ length: 6 }, (_, r) => {
      const b = 5 - r;
      return Array.from({ length: 64 }, (_, s) => ((s ^ (s >> 1)) >> b) & 1);
    });
    cells(g, 0, 2, w, h - 4, rows, (v, r) => (v ? (((mask >> (5 - r)) & 1) ? c.accent : c.grid) : null));
  },
});

// Bytebeat: bit planes of (s·(s>>3 | s>>(5 + n%3))) & 255, s = 0…255.
viz('bytebeat', {
  axis: (i) => ['0', `bits of s·(s>>3 | s>>${5 + (i.index % 3)}) & 255`, '255'],
  draw: (g, w, h, i, c) => {
    const sh = 5 + (i.index % 3);
    const v = Array.from({ length: 256 }, (_, s) => (s * ((s >> 3) | (s >> sh))) & 255);
    const rows = Array.from({ length: 8 }, (_, r) => v.map((x) => (x >> (7 - r)) & 1));
    cells(g, 0, 2, w, h - 4, rows, (b, r) => (b ? (r < 2 ? c.accent : c.line) : null));
  },
});

// Logistic map: bifurcation diagram for r ∈ [3.4, 4]; the shown r marked.
let logisticCache: { key: string; img: ImageData } | null = null;
viz('logistic-map', {
  axis: (i) => ['r 3.4', `x → r·x(1−x) · r = ${f2(3.5 + 0.5 * i.u)}`, '4'],
  draw: (g, w, h, i, c) => {
    const s = scale(w, h, 3.4, 4, 0, 1);
    const d = window.devicePixelRatio || 1;
    const key = `${w}|${h}|${d}|${c.line}`;
    if (logisticCache?.key !== key) {
      g.fillStyle = c.line;
      g.globalAlpha = 0.5;
      for (let px = 0; px < w; px++) {
        const r = 3.4 + (0.6 * px) / w;
        let x = 0.5;
        for (let j = 0; j < 200; j++) x = r * x * (1 - x);
        for (let j = 0; j < 120; j++) {
          x = r * x * (1 - x);
          g.fillRect(px, s.y(x), 1, 1);
        }
      }
      g.globalAlpha = 1;
      logisticCache = { key, img: g.getImageData(0, 0, Math.round(w * d), Math.round(h * d)) };
    } else g.putImageData(logisticCache.img, 0, 0);
    rules(g, s, w, h, [3.5 + 0.5 * i.u], [], c.accent);
  },
});

// Iterated sine map: f(x) = sin(π(1+u)x) with the identity and a cobweb of 3 + n steps from x₀ = 0.6.
viz('iterated-sine-map', {
  axis: (i) => ['−1', `x → sin(${f2(1 + i.u)}π·x) · ${3 + i.index} steps`, '1'],
  draw: (g, w, h, i, c) => {
    const a = Math.PI * (1 + i.u);
    const side = Math.min(w, h);
    const s = scale(side, side, -1.1, 1.1, -1.1, 1.1);
    g.save();
    g.translate((w - side) / 2, (h - side) / 2);
    rules(g, s, side, side, [0], [0], c.axis);
    plot(g, s, (x) => x, -1.1, 1.1, c.muted, 1, 2, [3, 3]);
    plot(g, s, (x) => Math.sin(a * x), -1.1, 1.1, c.line, 1.4, 300);
    g.strokeStyle = c.accent;
    g.lineWidth = 1.2;
    g.beginPath();
    let x = 0.6;
    g.moveTo(s.x(x), s.y(0));
    for (let k = 0; k < 3 + i.index; k++) {
      const y = Math.sin(a * x);
      g.lineTo(s.x(x), s.y(y));
      g.lineTo(s.x(y), s.y(y));
      x = y;
    }
    g.stroke();
    dot(g, s.x(x), s.y(x), 3, c.accent);
    g.restore();
  },
});

// Vowel formants: harmonic weights from two Gaussian formants (+ a 1/k floor), harmonics 1–40.
viz('vowel-formants', {
  axis: (i) => ['h1', `formants at h${(7 - 4 * i.u).toFixed(1)} · h${(11 + 10 * i.u).toFixed(1)}`, 'h40'],
  draw: (g, w, h, i, c) => {
    const env = (k: number) => Math.exp(-Math.pow((k - 7 + 4 * i.u) / 1.5, 2)) + 0.7 * Math.exp(-Math.pow((k - 11 - 10 * i.u) / 2, 2)) + 0.05 / k;
    const s = scale(w, h, 0.5, 40.5, 0, 1.15);
    g.strokeStyle = c.line;
    g.lineWidth = 1;
    g.beginPath();
    for (let k = 1; k <= 40; k++) {
      g.moveTo(s.x(k), s.y(0));
      g.lineTo(s.x(k), s.y(env(k)));
    }
    g.stroke();
    plot(g, s, env, 1, 40, c.accent, 1.6, 400);
  },
});

// Resonance (the CZ resonance presets, …): the window (±, solid / dashed) and the resonant sine it
// shapes at the shown ratio (faint).
viz('mode:resonance', {
  axis: (i) => {
    const r = resonanceRatio(i.params as unknown as ResonanceParams, i.index, i.count);
    return ['0', `${RESONANCE_WINDOWS[Math.round(i.params.window)] ?? ''} window × sin(${r.toFixed(2)}·p)`, '2π'];
  },
  draw: (g, w, h, i, c) => {
    const r = resonanceRatio(i.params as unknown as ResonanceParams, i.index, i.count);
    const win = resonanceWindow(i.params.window);
    const s = scale(w, h, 0, 1, -1.1, 1.1);
    rules(g, s, w, h, [], [0], c.grid);
    plot(g, s, (t) => Math.sin(r * TAU * t), 0, 1, c.muted, 1, 600);
    plot(g, s, win, 0, 1, c.accent, 1.8, 300);
    plot(g, s, (t) => -win(t), 0, 1, c.accent, 1, 300, [3, 3]);
  },
});

// Euclidean pulses: k = 1 + (4+n)%15 onsets over 16 steps, as the formula spreads them.
viz('euclidean-pulses', {
  axis: (i) => ['', `E(${1 + ((4 + i.index) % 15)}, 16)`, ''],
  draw: (g, w, h, i, c) => {
    const k = 1 + ((4 + i.index) % 15);
    rhythmCircle(g, w, h, c, Array.from({ length: 16 }, (_, j) => Math.floor((j * k) / 16) - Math.floor(((j - 1) * k) / 16)));
  },
});

// Digits of π: the 16 digits in playing order from digit n % 16.
const PI16 = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9, 3];
viz('digits-of', {
  axis: (i) => ['', `π digits from #${(i.index % 16) + 1}`, ''],
  draw: (g, w, h, i, c) => valueCells(g, w, h, c, PI16.map((_, j) => PI16[(j + i.index) % 16])),
});

// Perlin: loop-seamless noise is fBm read around a circle (radius = frequency) in a slice of the field.
let planeCache: { key: string; rows: Float64Array[] } | null = null;
const noisePlane = (g: CanvasRenderingContext2D, w: number, h: number, c: VizColors, seed: number, freq: number, z: number, octaves: number, persistence: number) => {
  const ext = Math.max(2.5, freq * 1.3);
  const nx = 56;
  const ny = Math.max(8, Math.round((nx * h) / w));
  const key = `${seed}|${freq}|${z}|${octaves}|${persistence}|${nx}|${ny}`;
  if (planeCache?.key !== key) {
    const f = noiseField(seed);
    const ey = (ext * ny) / nx;
    const rows = Array.from({ length: ny }, (_, r) => {
      const y = ey - (2 * ey * (r + 0.5)) / ny;
      return Float64Array.from({ length: nx }, (_, k) => fbm(-ext + (2 * ext * (k + 0.5)) / nx + f.ox, y + f.oy, z + f.oz, octaves, persistence));
    });
    // Normalise to the slice's own range (fBm's amplitude depends on octaves / persistence).
    const m = Math.max(1e-9, ...rows.map((r) => Math.max(...r.map(Math.abs))));
    planeCache = { key, rows: rows.map((r) => r.map((v) => v / m)) };
  }
  const heat = heatScale(c);
  cells(g, 0, 0, w, h, planeCache.rows, (v) => heat(v));
  const R = (freq / ext) * (w / 2);
  g.strokeStyle = c.bg;
  g.lineWidth = 3.5;
  g.beginPath();
  g.arc(w / 2, h / 2, R, 0, TAU);
  g.stroke();
  g.strokeStyle = c.line;
  g.lineWidth = 1.5;
  g.stroke();
  dot(g, w / 2 + R, h / 2, 3, c.line);
};
// Perlin noise and its variants (Drift, Zoom, Add octaves, Roughen): the slice at the shown
// waveform's z, frequency (circle radius), octaves and persistence.
viz('mode:perlin', {
  axis: (i) => {
    const a = perlinAt(i.params as unknown as PerlinParams, i.index, i.count);
    return ['', `r ${f2(a.freq)} · z ${f2(a.z)} · ${a.octaves} oct · pers ${f2(a.persistence)}`, ''];
  },
  draw: (g, w, h, i, c) => {
    const a = perlinAt(i.params as unknown as PerlinParams, i.index, i.count);
    noisePlane(g, w, h, c, i.seed, a.freq, a.z, a.octaves, a.persistence);
  },
});

// Cellular automaton: generations (time downward), the shown one outlined.
viz('cellular-automaton', {
  axis: (i) => ['', `rule ${i.params.rule} · generation ${i.params.start + i.index}`, ''],
  draw: (g, w, h, i, c) => {
    const p = { rule: i.params.rule, cells: i.params.cells };
    const last = i.params.start + i.count - 1;
    const cellPx = w / Math.max(2, Math.round(p.cells));
    const fit = Math.max(4, Math.floor(h / Math.max(2, cellPx)));
    const first = Math.max(0, last + 1 - fit);
    const rows = caRows(p, i.seed, last + 1).slice(first);
    const shown = i.params.start + i.index - first;
    const rh = Math.min(h / rows.length, cellPx);
    const top = (h - rh * rows.length) / 2;
    cells(g, 0, top, w, rh * rows.length, rows, (v, r) => (v ? (r === shown ? c.accent : c.line) : null));
    if (shown >= 0) rowMark(g, 0, top, w, rh * rows.length, rows.length, shown, c.accent);
  },
});

// Dynamical systems: the map's bifurcation diagram over control 0…1 (normalised), batch range shaded.
let dynCache: { key: string; img: ImageData } | null = null;
viz('dynamical-systems', {
  axis: (i) => {
    const cv = i.params.control + (i.params.controlEnd - i.params.control) * i.u;
    return ['0', `${DYN_MAP_LABELS[Math.round(i.params.map)] ?? ''} · control ${f2(cv)}`, '1'];
  },
  draw: (g, w, h, i, c) => {
    const map = Math.round(i.params.map);
    const lim = map === 3 ? 1.6 : 1.05;
    const s = scale(w, h, 0, 1, -lim, lim);
    const d = window.devicePixelRatio || 1;
    const key = `${map}|${i.params.spread}|${w}|${h}|${d}|${c.line}`;
    if (dynCache?.key !== key) {
      g.fillStyle = c.line;
      g.globalAlpha = 0.45;
      for (let px = 0; px < w; px += 1) {
        const k = dynControl(map, px / w);
        for (let n = 40; n < 104; n += 2) for (const ph of [0.7, 2.3]) {
          const v = dynIterate(map, k, n, i.params.spread, ph);
          if (Number.isFinite(v)) g.fillRect(px, s.y(v), 1, 1);
        }
      }
      g.globalAlpha = 1;
      dynCache = { key, img: g.getImageData(0, 0, Math.round(w * d), Math.round(h * d)) };
    } else g.putImageData(dynCache.img, 0, 0);
    const a = Math.min(i.params.control, i.params.controlEnd);
    const b = Math.max(i.params.control, i.params.controlEnd);
    g.fillStyle = c.accent;
    g.globalAlpha = 0.12;
    g.fillRect(s.x(a), 0, Math.max(1, s.x(b) - s.x(a)), h);
    g.globalAlpha = 1;
    rules(g, s, w, h, [i.params.control + (i.params.controlEnd - i.params.control) * i.u], [], c.accent);
  },
});

// Karplus-Strong: the excited buffer (pass 0) and where each batch snapshot falls on a log pass scale.
viz('karplus-strong', {
  axis: (i) => ['pass 0', `excitation · pass ${Math.round(ksPasses(i.params.start, i.params.end, i.u))}`, String(KS_MAX_PASS)],
  draw: (g, w, h, i, c) => {
    const L = clamp(Math.round(i.params.length), 16, 512);
    const buf = ksExcite({ excite: i.params.excite, position: i.params.position }, L, i.seed >>> 0);
    const m = Math.max(1e-9, ...buf.map(Math.abs));
    const bh = h - 16;
    const s = scale(w, bh, 0, L - 1, -1.05, 1.05, 4);
    rules(g, s, w, bh, [], [0], c.grid);
    plot(g, s, (x) => buf[Math.round(x)] / m, 0, L - 1, c.line, 1.2, Math.min(L - 1, Math.ceil(w)));
    // Pass scale: log(1 + passes).
    const px = (n: number) => 4 + (Math.log1p(n) / Math.log1p(KS_MAX_PASS)) * (w - 8);
    const y = h - 7;
    g.strokeStyle = c.axis;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(4, y + 0.5);
    g.lineTo(w - 4, y + 0.5);
    g.stroke();
    for (let k = 0; k < i.count; k++) {
      const u = i.count > 1 ? k / (i.count - 1) : 0;
      const x = px(ksPasses(i.params.start, i.params.end, u));
      g.fillStyle = k === i.index ? c.accent : c.muted;
      g.fillRect(x - (k === i.index ? 1.5 : 0.5), y - (k === i.index ? 6 : 3), k === i.index ? 3 : 1, k === i.index ? 12 : 6);
    }
  },
});

// Additive designer: the slope envelope k^−s and the formant boost, harmonics 1…KMAX.
viz('additive-designer', {
  axis: (i) => ['h1', `k^−${f2(i.params.slope + (i.params.slopeEnd - i.params.slope) * i.u)} × formant boost`, `h${KMAX}`],
  draw: (g, w, h, i, c) => {
    const p = i.params;
    const slope = p.slope + (p.slopeEnd - p.slope) * i.u;
    const move = Math.pow(2, p.shift * i.u);
    const odd = 1 + Math.min(0, p.balance);
    const even = 1 - Math.max(0, p.balance);
    const formants = [
      [p.f1, p.w1, p.g1],
      [p.f2, p.w2, p.g2],
      [p.f3, p.w3, p.g3],
    ];
    const boost = (k: number) => 1 + formants.reduce((sum, [cc, ww, gg]) => (gg > 0 ? sum + gg * Math.exp(-(((k - cc * move) / Math.max(0.25, ww)) ** 2)) : sum), 0);
    const maxBoost = Math.max(...Array.from({ length: KMAX }, (_, k) => boost(k + 1)));
    const s = scale(w, h, 0.5, KMAX + 0.5, 0, 1.08);
    g.strokeStyle = c.muted;
    g.lineWidth = 1;
    g.beginPath();
    for (let k = 1; k <= KMAX; k++) {
      const a = Math.pow(k, -slope) * (k === 1 ? 1 : k % 2 ? odd : even);
      g.moveTo(s.x(k), s.y(0));
      g.lineTo(s.x(k), s.y(a));
    }
    g.stroke();
    plot(g, s, (k) => boost(k) / maxBoost, 1, KMAX, c.accent, 1.6, 400);
    for (const [cc, , gg] of formants) if (gg > 0 && cc * move <= KMAX) dot(g, s.x(cc * move), s.y(boost(cc * move) / maxBoost), 2.5, c.accent);
  },
});

// Number sequences: the window's values (Euclidean: the rhythm circle).
viz('number-sequences', {
  axis: (i) => ['', `${SEQ_SOURCES[Math.round(i.params.source)] ?? ''} · window ${i.index + 1}`, ''],
  draw: (g, w, h, i, c) => {
    const v = sequenceValues(i.params as unknown as SequenceParams, i.index);
    if (Math.round(i.params.source) === 4) rhythmCircle(g, w, h, c, v);
    else valueCells(g, w, h, c, v);
  },
});

// Reaction-diffusion: V around the ring over time (downward), the shown snapshot outlined.
const rdCache = new StepCache<RdState>(2, 64);
viz('reaction-diffusion', {
  axis: (i) => ['', `V around the ring · step ${Math.max(0, Math.round(i.params.start)) + i.index * clamp(Math.round(i.params.steps), 1, 1000)}`, ''],
  draw: (g, w, h, i, c) => {
    const steps = clamp(Math.round(i.params.steps), 1, 1000);
    const start = Math.max(0, Math.round(i.params.start));
    const last = start + (i.count - 1) * steps;
    const nr = clamp(Math.floor(h / 3), 8, 48);
    const at = Array.from({ length: nr }, (_, r) => Math.round((last * r) / (nr - 1)));
    const shownStep = start + i.index * steps;
    // The row nearest the shown snapshot shows exactly that snapshot.
    let best = 0;
    at.forEach((s, r) => {
      if (Math.abs(s - shownStep) < Math.abs(at[best] - shownStep)) best = r;
    });
    at[best] = shownStep;
    const rows = at.map((s) => rdState(i.params as unknown as RdParams, i.seed, s, rdCache).slice());
    const hi = Math.max(1e-9, ...rows.map((r) => Math.max(...r)));
    const heat = heatScale(c);
    cells(g, 0, 0, w, h, rows, (v) => heat((v / hi) * 2 - 1));
    rowMark(g, 0, 0, w, h, nr, best, c.line);
  },
});

// Life-like CA: the board at the shown generation; the line read (row / column / diagonal) highlighted.
const lifeCache = new StepCache<Board>(2, 64);
viz('life-like-ca', {
  axis: (i) => {
    const gen = Math.max(0, Math.round(i.params.start)) + i.index * clamp(Math.round(i.params.step), 1, 16);
    return ['', `${LIFE_RULES[Math.round(i.params.rule)]?.label ?? ''} · generation ${gen}`, ''];
  },
  draw: (g, w, h, i, c) => {
    const size = clamp(Math.round(i.params.size), 8, 64);
    const gen = Math.max(0, Math.round(i.params.start)) + i.index * clamp(Math.round(i.params.step), 1, 16);
    const board = lifeBoard(i.params as unknown as LifeParams, i.seed, gen, lifeCache);
    const side = Math.floor(Math.min(w, h) / size) * size || Math.min(w, h);
    const x0 = Math.floor((w - side) / 2);
    const y0 = Math.floor((h - side) / 2);
    const read = Math.round(i.params.read);
    const mid = size >> 1;
    const onLine = (r: number, k: number) => (read === 0 ? r === mid : read === 1 ? k === mid : read === 2 ? r === k : false);
    const rows = Array.from({ length: size }, (_, r) => board.subarray(r * size, (r + 1) * size));
    g.fillStyle = c.grid;
    g.fillRect(x0, y0, side, side);
    cells(g, x0, y0, side, side, rows, (v, r, k) => (onLine(r, k) ? (v ? c.accent : c.muted) : v ? c.line : null));
  },
});

// Spline: the control points and the raw curve through them.
viz('spline', {
  axis: (i) => ['0', `${splinePoints(i.params as unknown as SplineParams, i.seed, i.index, i.count).length} control points`, '2π'],
  draw: (g, w, h, i, c) => {
    const P = splinePoints(i.params as unknown as SplineParams, i.seed, i.index, i.count);
    const x = splineRaw(P, i.params.kind, i.params.tension);
    const m = Math.max(1e-9, ...P.map(Math.abs), ...Array.from(x, Math.abs));
    const s = scale(w, h, 0, 1, -m * 1.05, m * 1.05);
    rules(g, s, w, h, P.map((_, j) => j / P.length), [0], c.grid);
    plot(g, s, (t) => x[Math.min(x.length - 1, Math.floor(t * x.length))], 0, 1, c.line, 1.2, Math.ceil(w));
    P.forEach((v, j) => dot(g, s.x(j / P.length), s.y(v), 3, c.accent));
  },
});

// Glyph contour: the traced outline, skewed as the table is.
viz('glyph-contour', {
  axis: (i) => ['', `“${String(i.inputs?.glyph ?? '')}” outline · radius vs angle`, ''],
  draw: (g, w, h, i, c) => {
    const pts = contourPoints(String(i.inputs?.contour ?? ''));
    if (pts.length < 6) return;
    const skewEnd = Math.round(i.params.batch) === 0 ? i.params.skew : i.params.skewEnd;
    const sk = i.params.skew + (skewEnd - i.params.skew) * i.u;
    const xs = pts.map((v, k) => (k % 2 ? v : v + sk * (pts[k + 1] - 0.5)));
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < xs.length; k += 2) {
      x0 = Math.min(x0, xs[k]);
      x1 = Math.max(x1, xs[k]);
      y0 = Math.min(y0, xs[k + 1]);
      y1 = Math.max(y1, xs[k + 1]);
    }
    const span = Math.max(x1 - x0, y1 - y0, 1e-6);
    const k = (Math.min(w, h) - 12) / span;
    const ox = w / 2 - ((x0 + x1) / 2) * k;
    const oy = h / 2 - ((y0 + y1) / 2) * k;
    g.fillStyle = c.grid;
    g.strokeStyle = c.accent;
    g.lineWidth = 1.6;
    g.lineJoin = 'round';
    g.beginPath();
    for (let j = 0; j < xs.length; j += 2) {
      const x = ox + xs[j] * k;
      const y = oy + xs[j + 1] * k;
      if (j) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
    g.closePath();
    g.fill();
    g.stroke();
  },
});
