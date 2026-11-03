import type { TableId } from './table';

export type WavetableId = number;

/** The auto-maintained wavetable mirroring the whole timeline. */
export const ALL_WAVETABLE_ID: WavetableId = 0;

interface WavetableBase {
  readonly id: WavetableId;
  readonly name: string;
  /** 'all' = derived from the timeline; never pins tables. */
  readonly auto?: 'all';
}

/** Ordered row of table ids. Duplicates are allowed. */
export interface Wavetable1D extends WavetableBase {
  readonly kind: '1d';
  readonly ids: readonly TableId[];
}

/** width x height grid of table ids, row-major; null = empty cell. (Model only in M1.) */
export interface Wavetable2D extends WavetableBase {
  readonly kind: '2d';
  readonly width: number;
  readonly height: number;
  readonly ids: readonly (TableId | null)[];
}

export type Wavetable = Wavetable1D | Wavetable2D;

export function allWavetable(timelineIds: readonly TableId[]): Wavetable1D {
  return { id: ALL_WAVETABLE_ID, name: 'All', kind: '1d', auto: 'all', ids: timelineIds.slice() };
}

export function make1D(id: WavetableId, name: string, ids: readonly TableId[]): Wavetable1D {
  return { id, name, kind: '1d', ids: ids.slice() };
}

export function make2D(
  id: WavetableId,
  name: string,
  width: number,
  height: number,
  ids?: readonly (TableId | null)[],
): Wavetable2D {
  const cells = width * height;
  const out: (TableId | null)[] = new Array(cells).fill(null);
  if (ids) for (let i = 0; i < Math.min(cells, ids.length); i++) out[i] = ids[i];
  return { id, name, kind: '2d', width, height, ids: out };
}

export function cell2D(wt: Wavetable2D, x: number, y: number): TableId | null {
  if (x < 0 || y < 0 || x >= wt.width || y >= wt.height) return null;
  return wt.ids[y * wt.width + x];
}

/** Number of addressable positions (1D length, or 2D cell count). */
export function wavetableLength(wt: Wavetable): number {
  return wt.kind === '1d' ? wt.ids.length : wt.width * wt.height;
}

/**
 * Playback order as a flat id list. 1D: as is. 2D: row-major, skipping empty cells
 * (M1 voices scan 1D; true 2D addressing is a later milestone).
 */
export function playbackIds(wt: Wavetable): TableId[] {
  if (wt.kind === '1d') return wt.ids.slice();
  return wt.ids.filter((x): x is TableId => x !== null);
}

/** Ids that must never be evicted: anything referenced by a non-auto wavetable. */
export function pinnedIds(wavetables: readonly Wavetable[]): Set<TableId> {
  const s = new Set<TableId>();
  for (const wt of wavetables) {
    if (wt.auto) continue;
    for (const id of wt.ids) if (id !== null) s.add(id);
  }
  return s;
}

/** Clamp a window to a wavetable of `length` positions; returns ordered [start, end]. */
export function clampWindow(start: number, end: number, length: number): [number, number] {
  const max = Math.max(0, length - 1);
  let a = Math.max(0, Math.min(max, Math.round(start)));
  let b = Math.max(0, Math.min(max, Math.round(end)));
  if (a > b) [a, b] = [b, a];
  return [a, b];
}
