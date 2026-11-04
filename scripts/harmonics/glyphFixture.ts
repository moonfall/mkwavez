/**
 * A Node stand-in for the browser's glyph tracer (src/browser/glyphTrace.ts), which needs a
 * canvas and the system font. Characters come from a tiny stroke font (centre lines,
 * thickened by the weight), are rasterised, and the outer contour of the largest
 * connected part is traced the same way (Moore-neighbour tracing, ≤ 64 points). The shapes
 * resemble the letters of the default text "mkwavez" but are NOT the system-ui glyphs the
 * app traces, so Glyph contour results here are indicative only.
 */
import { encodeContour } from '../../src/core/generators/glyph';

const SIZE = 96;
const MAX_POINTS = 64;

type Pt = readonly [number, number];

const arc = (cx: number, cy: number, r: number, a0: number, a1: number, n = 12): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  });

/** Stroke font: polylines in a unit box, y up (baseline 0.2, x-height 0.6). */
const STROKES: Record<string, Pt[][]> = {
  m: [
    [[0.2, 0.2], [0.2, 0.6]],
    [[0.2, 0.5], [0.3, 0.6], [0.4, 0.6], [0.5, 0.5], [0.5, 0.2]],
    [[0.5, 0.5], [0.6, 0.6], [0.7, 0.6], [0.8, 0.5], [0.8, 0.2]],
  ],
  k: [
    [[0.32, 0.2], [0.32, 0.85]],
    [[0.7, 0.6], [0.32, 0.36]],
    [[0.44, 0.43], [0.72, 0.2]],
  ],
  w: [[[0.2, 0.6], [0.33, 0.2], [0.5, 0.5], [0.67, 0.2], [0.8, 0.6]]],
  a: [arc(0.46, 0.33, 0.14, 0, 360, 16), [[0.6, 0.2], [0.6, 0.52], [0.52, 0.6], [0.36, 0.6], [0.3, 0.55]]],
  v: [[[0.25, 0.6], [0.5, 0.2], [0.75, 0.6]]],
  e: [[[0.28, 0.4], [0.72, 0.4]], arc(0.5, 0.4, 0.22, 0, 320, 18)],
  z: [[[0.25, 0.6], [0.75, 0.6], [0.25, 0.2], [0.75, 0.2]]],
};
const FALLBACK: Pt[][] = [arc(0.5, 0.4, 0.2, 0, 360, 20)];

function segDist(px: number, py: number, a: Pt, b: Pt): number {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const l2 = ex * ex + ey * ey;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - a[0]) * ex + (py - a[1]) * ey) / l2)) : 0;
  return Math.hypot(px - a[0] - t * ex, py - a[1] - t * ey);
}

function rasterize(ch: string, weight: number): Uint8Array {
  const strokes = STROKES[ch.toLowerCase()] ?? FALLBACK;
  const r = 0.025 + (0.07 * (Math.max(100, Math.min(900, weight)) - 100)) / 800;
  const out = new Uint8Array(SIZE * SIZE);
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const x = (px + 0.5) / SIZE;
      const y = 1 - (py + 0.5) / SIZE;
      let hit = false;
      for (const s of strokes) {
        for (let i = 0; i + 1 < s.length && !hit; i++) if (segDist(x, y, s[i], s[i + 1]) <= r) hit = true;
        if (hit) break;
      }
      out[py * SIZE + px] = hit ? 1 : 0;
    }
  }
  return out;
}

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

/** Outer contour of `ch` at `weight` ("x,y x,y …", y up, about 0..1), like traceGlyph(). */
export function fixtureTrace(ch: string, weight: number): string {
  const comp = largest(rasterize(ch, weight));
  if (!comp) return '';
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < SIZE && y < SIZE && comp[y * SIZE + x] === 1;
  const start = comp.indexOf(1);
  const sx = start % SIZE;
  const sy = (start - sx) / SIZE;
  const pts: number[] = [sx, sy];
  let x = sx;
  let y = sy;
  let back = 0;
  for (let iter = 0; iter < SIZE * SIZE * 4; iter++) {
    let moved = false;
    for (let j = 1; j <= 8; j++) {
      const d = (back + j) % 8;
      const nx = x + DIRS[d][0];
      const ny = y + DIRS[d][1];
      if (!on(nx, ny)) continue;
      const bx = x + DIRS[(d + 7) % 8][0];
      const by = y + DIRS[(d + 7) % 8][1];
      x = nx;
      y = ny;
      back = DIRS.findIndex(([dx, dy]) => dx === bx - x && dy === by - y);
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
