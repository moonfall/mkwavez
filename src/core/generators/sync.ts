/**
 * Hard sync: a slave oscillator at `ratio` times the cycle's frequency, restarted at every
 * cycle (the master). A non-integer ratio leaves the characteristic jump at the restart;
 * the batch sweeps the ratio.
 */
import { TABLE_SIZE } from '../constants';
import { shape } from '../shape';
import { batchU } from './perlin';

export const SYNC_WAVES = ['Sine', 'Triangle', 'Saw', 'Square'] as const;

export interface SyncParams {
  /** SYNC_WAVES index. */
  wave: number;
  /** Slave ratio at the batch start / end. */
  ratio: number;
  ratioEnd: number;
}

export const DEFAULT_SYNC: SyncParams = { wave: 0, ratio: 1, ratioEnd: 4 };

/** The slave wave of its own phase (radians, from 0 at the restart). */
export function syncWave(wave: number): (ph: number) => number {
  switch (Math.round(wave)) {
    case 1:
      return (ph) => (2 / Math.PI) * Math.asin(Math.sin(ph));
    case 2:
      return (ph) => ((ph / (2 * Math.PI) + 0.5) % 1) * 2 - 1;
    case 3:
      return (ph) => (ph / (2 * Math.PI)) % 1 < 0.5 ? 1 : -1;
    default:
      return (ph) => Math.sin(ph);
  }
}

/** The raw cycle (before shape()): the slave restarted at the cycle start. */
export function syncRaw(wave: number, ratio: number): Float64Array {
  const f = syncWave(wave);
  return Float64Array.from({ length: TABLE_SIZE }, (_, i) => f(((2 * Math.PI * i) / TABLE_SIZE) * ratio));
}

export function syncRatio(p: SyncParams, index: number, count: number): number {
  return p.ratio + (p.ratioEnd - p.ratio) * batchU(index, count);
}

export function syncTable(p: SyncParams, index: number, count: number): Float32Array {
  return shape(syncRaw(p.wave, syncRatio(p, index, count)));
}
