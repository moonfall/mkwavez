/**
 * Superformula (Gielis): r(φ) = (|cos(mφ/4)|^n2 + |sin(mφ/4)|^n3)^(−1/n1), read as radius vs
 * angle. m sets the symmetry, n1 how pinched the shape is, n2 / n3 its sides; the batch
 * sweeps n2 and n3.
 *
 * Read from the centre, an m-fold shape repeats m times per cycle (m/2 when n2 ≠ n3), so
 * only multiples of m survive and it sounds above its note. Offset reads the radius from a
 * point off the centre (a fraction of the inner radius, toward angle 0), which keeps the
 * fundamental with the shape's lobes on top (radial.ts). Offset 0 is the centre reading.
 */
import { TABLE_SIZE } from '../constants';
import { shape } from '../shape';
import { batchU } from './perlin';
import { minOf, radiusFrom } from './radial';

export interface SuperformulaParams {
  /** Symmetry m. */
  m: number;
  n1: number;
  /** n2 and n3 at the batch start / end. */
  n2: number;
  n2End: number;
  n3: number;
  n3End: number;
  /** Reading point's distance from the centre, as a fraction of the inner radius (0 = centre). */
  offset: number;
}

export const DEFAULT_SUPERFORMULA: SuperformulaParams = { m: 6, n1: 2, n2: 2, n2End: 8, n3: 2, n3End: 8, offset: 0.25 };

/** Largest reading-point offset (a fraction of the inner radius: the point stays inside). */
export const SUPERFORMULA_MAX_OFFSET = 0.9;
/** Outline points traced for an off-centre reading. */
const OUTLINE_POINTS = 2 * TABLE_SIZE;

/** The radius at angle φ. */
export function superformulaRadius(m: number, n1: number, n2: number, n3: number, phi: number): number {
  return Math.pow(Math.pow(Math.abs(Math.cos((m / 4) * phi)), n2) + Math.pow(Math.abs(Math.sin((m / 4) * phi)), n3), -1 / n1);
}

const finiteRadius = (r: number) => (Number.isFinite(r) ? Math.min(r, 1e6) : 1e6);

/**
 * The raw cycle (before shape()): the radius from the centre, or from the point `offset` ×
 * the inner radius toward angle 0. Non-finite radii (n1 → 0) are clamped to stay finite.
 */
export function superformulaRaw(m: number, n1: number, n2: number, n3: number, offset = 0): Float64Array {
  const raw = Float64Array.from({ length: TABLE_SIZE }, (_, i) => finiteRadius(superformulaRadius(m, n1, n2, n3, (2 * Math.PI * i) / TABLE_SIZE)));
  const off = Math.min(Math.max(offset, 0), SUPERFORMULA_MAX_OFFSET);
  if (!(off > 0)) return raw;
  const outline: [number, number][] = [];
  for (let i = 0; i <= OUTLINE_POINTS; i++) {
    const phi = (2 * Math.PI * (i % OUTLINE_POINTS)) / OUTLINE_POINTS;
    const r = finiteRadius(superformulaRadius(m, n1, n2, n3, phi));
    outline.push([r * Math.cos(phi), r * Math.sin(phi)]);
  }
  return radiusFrom([outline], off * minOf(raw), 0);
}

/** n2 and n3 of table `index` of a batch. */
export function superformulaAt(p: SuperformulaParams, index: number, count: number): { n2: number; n3: number } {
  const u = batchU(index, count);
  return { n2: p.n2 + (p.n2End - p.n2) * u, n3: p.n3 + (p.n3End - p.n3) * u };
}

export function superformulaTable(p: SuperformulaParams, index: number, count: number): Float32Array {
  const a = superformulaAt(p, index, count);
  return shape(superformulaRaw(p.m, p.n1, a.n2, a.n3, p.offset));
}
