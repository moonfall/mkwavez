/**
 * Superformula (Gielis): r(φ) = (|cos(mφ/4)|^n2 + |sin(mφ/4)|^n3)^(−1/n1), read as radius vs
 * angle. m sets the symmetry, n1 how pinched the shape is, n2 / n3 its sides; the batch
 * sweeps n2 and n3.
 */
import { TABLE_SIZE } from '../constants';
import { shape } from '../shape';
import { batchU } from './perlin';

export interface SuperformulaParams {
  /** Symmetry m. */
  m: number;
  n1: number;
  /** n2 and n3 at the batch start / end. */
  n2: number;
  n2End: number;
  n3: number;
  n3End: number;
}

export const DEFAULT_SUPERFORMULA: SuperformulaParams = { m: 6, n1: 2, n2: 2, n2End: 8, n3: 2, n3End: 8 };

/** The radius at angle φ. */
export function superformulaRadius(m: number, n1: number, n2: number, n3: number, phi: number): number {
  return Math.pow(Math.pow(Math.abs(Math.cos((m / 4) * phi)), n2) + Math.pow(Math.abs(Math.sin((m / 4) * phi)), n3), -1 / n1);
}

/** The raw cycle (before shape()); non-finite radii (n1 → 0) are clamped to stay finite. */
export function superformulaRaw(m: number, n1: number, n2: number, n3: number): Float64Array {
  return Float64Array.from({ length: TABLE_SIZE }, (_, i) => {
    const r = superformulaRadius(m, n1, n2, n3, (2 * Math.PI * i) / TABLE_SIZE);
    return Number.isFinite(r) ? Math.min(r, 1e6) : 1e6;
  });
}

/** n2 and n3 of table `index` of a batch. */
export function superformulaAt(p: SuperformulaParams, index: number, count: number): { n2: number; n3: number } {
  const u = batchU(index, count);
  return { n2: p.n2 + (p.n2End - p.n2) * u, n3: p.n3 + (p.n3End - p.n3) * u };
}

export function superformulaTable(p: SuperformulaParams, index: number, count: number): Float32Array {
  const a = superformulaAt(p, index, count);
  return shape(superformulaRaw(p.m, p.n1, a.n2, a.n3));
}
