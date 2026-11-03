/**
 * Browser-only: render one character to an offscreen canvas and trace the outer contour
 * of its largest connected part (Moore-neighbour tracing), as the polyline string the
 * core's Glyph contour mode takes (core/generators/glyph.ts). Fonts stay out of the core:
 * recipes store this polyline.
 */
import { encodeContour } from '../core/generators/glyph';

const SIZE = 192;
const MAX_POINTS = 240;
/** Clockwise (screen coordinates) from west. */
const DIRS: readonly (readonly [number, number])[] = [
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
];

let canvas: HTMLCanvasElement | null = null;

/** Filled pixels (alpha ≥ 50%) of `ch` drawn at the given weight, SIZE × SIZE. */
function rasterize(ch: string, weight: number): Uint8Array {
  canvas ??= document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.clearRect(0, 0, SIZE, SIZE);
  g.fillStyle = '#000';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `${weight} ${Math.round(SIZE * 0.72)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  g.fillText(ch, SIZE / 2, SIZE / 2);
  const d = g.getImageData(0, 0, SIZE, SIZE).data;
  const out = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < out.length; i++) out[i] = d[4 * i + 3] >= 128 ? 1 : 0;
  return out;
}

/** Label of the largest 8-connected component (others 0), or null if empty. */
function largest(px: Uint8Array): Uint8Array | null {
  const label = new Int32Array(px.length);
  let best = 0;
  let bestSize = 0;
  let next = 0;
  const stack: number[] = [];
  for (let i = 0; i < px.length; i++) {
    if (!px[i] || label[i]) continue;
    const id = ++next;
    let size = 0;
    label[i] = id;
    stack.push(i);
    while (stack.length) {
      const c = stack.pop()!;
      size++;
      const x = c % SIZE;
      const y = (c - x) / SIZE;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
        const n = ny * SIZE + nx;
        if (px[n] && !label[n]) {
          label[n] = id;
          stack.push(n);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = id;
    }
  }
  if (!best) return null;
  const out = new Uint8Array(px.length);
  for (let i = 0; i < px.length; i++) out[i] = label[i] === best ? 1 : 0;
  return out;
}

/**
 * Outer contour of `ch` ("x,y x,y …", y up, roughly 0..1), or '' for a blank character
 * (the core then uses its fallback contour).
 */
export function traceGlyph(ch: string, weight: number): string {
  const comp = largest(rasterize(ch, weight));
  if (!comp) return '';
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < SIZE && y < SIZE && comp[y * SIZE + x] === 1;
  const start = comp.indexOf(1);
  const sx = start % SIZE;
  const sy = (start - sx) / SIZE;
  const pts: number[] = [sx, sy];
  let x = sx;
  let y = sy;
  let back = 0; // the west neighbour of the first pixel in raster order is empty
  for (let iter = 0; iter < SIZE * SIZE * 4; iter++) {
    let moved = false;
    for (let j = 1; j <= 8; j++) {
      const d = (back + j) % 8;
      const nx = x + DIRS[d][0];
      const ny = y + DIRS[d][1];
      if (!on(nx, ny)) continue;
      // The new backtrack: the empty neighbour checked just before, seen from the new pixel.
      const px = x + DIRS[(d + 7) % 8][0];
      const py = y + DIRS[(d + 7) % 8][1];
      x = nx;
      y = ny;
      back = DIRS.findIndex(([dx, dy]) => dx === px - x && dy === py - y);
      if (back < 0) back = (d + 4) % 8;
      moved = true;
      break;
    }
    if (!moved || (x === sx && y === sy)) break;
    pts.push(x, y);
  }
  const n = pts.length / 2;
  const step = Math.max(1, Math.ceil(n / MAX_POINTS));
  const out: number[] = [];
  for (let i = 0; i < n; i += step) out.push((pts[2 * i] + 0.5) / SIZE, 1 - (pts[2 * i + 1] + 0.5) / SIZE);
  return out.length >= 6 ? encodeContour(out) : '';
}
