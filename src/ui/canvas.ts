import { KMAX } from '../core/constants';
import { harmonicMagnitudes } from '../core/fft';

// ---- theme colours (cached; invalidated on scheme change) ----

let colorCache = new Map<string, string>();
const themeListeners = new Set<() => void>();

export function cssColor(name: string): string {
  let c = colorCache.get(name);
  if (c === undefined) {
    c = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
    colorCache.set(name, c);
  }
  return c;
}

export function onThemeChange(fn: () => void): void {
  themeListeners.add(fn);
}

// ---- theme: dark by default; an explicit choice (toggle) is remembered ----

export type Theme = 'dark' | 'light';
const THEME_KEY = 'mkwavez.theme';

export function storedTheme(): Theme | null {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : null;
  } catch {
    return null;
  }
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/** Apply a theme (data-theme on <html>), optionally remember it, and redraw canvases. */
export function setTheme(t: Theme, persist = true): void {
  document.documentElement.dataset.theme = t;
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      /* storage blocked: the choice lasts for this page only */
    }
  }
  colorCache = new Map();
  for (const fn of themeListeners) fn();
}

// ---- sizing ----

interface Sized {
  _w?: number;
  _h?: number;
  _d?: number;
}

/**
 * Size the backing store to CSS width x `cssHeight` at device pixel ratio, only when
 * it changed (the CSS height lives in our argument, never read back from the canvas).
 * Returns a context with the transform set to CSS pixels and the canvas cleared.
 */
export function fit(c: HTMLCanvasElement, cssHeight: number): [CanvasRenderingContext2D, number, number] {
  const s = c as HTMLCanvasElement & Sized;
  const w = Math.max(1, c.clientWidth || c.parentElement?.clientWidth || 1);
  const d = window.devicePixelRatio || 1;
  if (s._w !== w || s._h !== cssHeight || s._d !== d) {
    c.style.height = `${cssHeight}px`;
    c.width = Math.round(w * d);
    c.height = Math.round(cssHeight * d);
    s._w = w;
    s._h = cssHeight;
    s._d = d;
  }
  const g = c.getContext('2d')!;
  g.setTransform(d, 0, 0, d, 0, 0);
  g.clearRect(0, 0, w, cssHeight);
  return [g, w, cssHeight];
}

/**
 * Like fit() for a canvas of fixed CSS size (thumbnails): never reads layout, so it
 * works while the canvas is hidden. Backing store resized only when size / DPR change.
 */
export function fitFixed(c: HTMLCanvasElement, cssWidth: number, cssHeight: number): CanvasRenderingContext2D {
  const s = c as HTMLCanvasElement & Sized;
  const d = window.devicePixelRatio || 1;
  if (s._w !== cssWidth || s._h !== cssHeight || s._d !== d) {
    c.style.width = `${cssWidth}px`;
    c.style.height = `${cssHeight}px`;
    c.width = Math.round(cssWidth * d);
    c.height = Math.round(cssHeight * d);
    s._w = cssWidth;
    s._h = cssHeight;
    s._d = d;
  }
  const g = c.getContext('2d')!;
  g.setTransform(d, 0, 0, d, 0, 0);
  g.clearRect(0, 0, cssWidth, cssHeight);
  return g;
}

// ---- drawing ----

/** Waveform of A (optionally crossfaded toward B by frac) in the given box. */
export function drawWave(
  g: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  w: number,
  h: number,
  A: ArrayLike<number>,
  color: string,
  opts: { B?: ArrayLike<number>; frac?: number; lineWidth?: number; axis?: string; points?: number } = {},
): void {
  const B = opts.B ?? A;
  const fr = opts.frac ?? 0;
  const pad = Math.min(4, h * 0.08);
  const mid = y0 + h / 2;
  const amp = h / 2 - pad;
  if (opts.axis) {
    g.strokeStyle = opts.axis;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x0, mid);
    g.lineTo(x0 + w, mid);
    g.stroke();
  }
  const n = A.length;
  const pts = Math.max(2, Math.min(opts.points ?? Math.ceil(w), n));
  g.strokeStyle = color;
  g.lineWidth = opts.lineWidth ?? 1.5;
  g.lineJoin = 'round';
  g.beginPath();
  for (let i = 0; i <= pts; i++) {
    const k = Math.min(n - 1, Math.floor((i / pts) * n));
    const v = A[k] + (B[k] - A[k]) * fr;
    const px = x0 + (i / pts) * w;
    const py = mid - v * amp;
    if (i) g.lineTo(px, py);
    else g.moveTo(px, py);
  }
  g.stroke();
}

const specCache = new WeakMap<object, Float64Array>();

function spectrum(x: Float32Array): Float64Array {
  let s = specCache.get(x);
  if (!s) {
    s = harmonicMagnitudes(x, KMAX);
    specCache.set(x, s);
  }
  return s;
}

/** Harmonic magnitude bars (dB, 60 dB range), optionally crossfaded A->B. */
export function drawSpectrum(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  A: Float32Array,
  color: string,
  opts: { B?: Float32Array; frac?: number; bins?: number } = {},
): void {
  const sa = spectrum(A);
  const sb = opts.B ? spectrum(opts.B) : sa;
  const fr = opts.frac ?? 0;
  const bins = opts.bins ?? 40;
  let mx = 1e-12;
  const m = new Float64Array(bins + 1);
  for (let k = 1; k <= bins; k++) {
    m[k] = sa[k] + (sb[k] - sa[k]) * fr;
    mx = Math.max(mx, m[k]);
  }
  const bw = w / bins;
  g.fillStyle = color;
  for (let k = 1; k <= bins; k++) {
    const t = Math.max(0, (20 * Math.log10(m[k] / mx + 1e-9) + 60) / 60);
    if (t > 0) {
      const bh = Math.max(1, t * (h - 3));
      g.fillRect((k - 1) * bw + 0.5, h - bh - 1.5, Math.max(1, bw - 1), bh);
    }
  }
}

/** Parse #rrggbb / #rgb / rgb() to [r,g,b]. */
export function parseColor(c: string): [number, number, number] {
  const s = c.trim();
  if (s.startsWith('#')) {
    const hex = s.length === 4 ? s.slice(1).replace(/./g, (x) => x + x) : s.slice(1, 7);
    const n = parseInt(hex, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = s.match(/\d+(\.\d+)?/g);
  return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : [128, 128, 128];
}

/** Frame limiter: true at most every `ms`. */
export function throttle(ms: number): (now: number) => boolean {
  let last = -Infinity;
  return (now) => {
    if (now - last < ms) return false;
    last = now;
    return true;
  };
}
