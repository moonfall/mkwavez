import { noiseCycle, noiseField } from '../perlin';
import { shape } from '../shape';
import type { GeneratedTable } from '../table';

export interface PerlinParams {
  /** Radius of the sampling circle; higher = more wiggles per cycle. */
  freq: number;
  /** Start position through the noise. */
  z: number;
  /** Total z travelled across a batch (table i uses z + zDrift * u). */
  zDrift: number;
  octaves: number;
  persistence: number;
}

export const DEFAULT_PERLIN: PerlinParams = { freq: 2, z: 0, zDrift: 1.5, octaves: 4, persistence: 0.5 };

/** Batch-position parameter u in [0,1] (0 for a single table). */
export function batchU(index: number, count: number): number {
  return count > 1 ? index / (count - 1) : 0;
}

export function perlinTable(p: PerlinParams, seed: number, index: number, count: number): Float32Array {
  const z = p.z + p.zDrift * batchU(index, count);
  return shape(noiseCycle(noiseField(seed), p.freq, z, p.octaves, p.persistence));
}

/** N tables from one noise region (same seed), drifting through z. */
export function generatePerlin(p: PerlinParams, seed: number, count: number): GeneratedTable[] {
  const out: GeneratedTable[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      data: perlinTable(p, seed, i, count),
      recipe: {
        op: 'perlin',
        params: { ...p },
        seed: seed >>> 0,
        parents: [],
        batch: { index: i, count },
      },
    });
  }
  return out;
}
