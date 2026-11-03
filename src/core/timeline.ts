import type { TableId } from './table';

export interface HasId {
  readonly id: TableId;
}

export interface AppendResult<T> {
  /** New ordered list (a fresh array; inputs are not modified). */
  readonly list: T[];
  /** Evicted items, oldest first. */
  readonly evicted: T[];
  /** Ascending indices of evicted items within (old list ++ added). */
  readonly evictedIndices: number[];
}

/**
 * Append items and evict oldest-first until the list fits `cap`, skipping pinned items
 * (tables referenced by a user wavetable). If everything left is pinned the list may
 * exceed `cap`.
 */
export function appendWithEviction<T extends HasId>(
  list: readonly T[],
  add: readonly T[],
  cap: number,
  isPinned: (id: TableId) => boolean,
): AppendResult<T> {
  const all = list.concat(add);
  let excess = all.length - cap;
  if (excess <= 0) return { list: all, evicted: [], evictedIndices: [] };
  const evictedIndices: number[] = [];
  for (let i = 0; i < all.length && excess > 0; i++) {
    if (!isPinned(all[i].id)) {
      evictedIndices.push(i);
      excess--;
    }
  }
  const drop = new Set(evictedIndices);
  return {
    list: all.filter((_, i) => !drop.has(i)),
    evicted: evictedIndices.map((i) => all[i]),
    evictedIndices,
  };
}

/**
 * Where an index lands after the items at `removed` (ascending) are deleted.
 * If the item itself was removed, 'next' moves to the following survivor and
 * 'prev' to the preceding one. Result is clamped to [0, newLength-1] (0 if empty).
 */
export function remapIndex(
  index: number,
  removed: readonly number[],
  bias: 'next' | 'prev',
  newLength: number,
): number {
  let before = 0;
  let self = false;
  for (const r of removed) {
    if (r < index) before++;
    else if (r === index) self = true;
    else break;
  }
  let out = index - before;
  if (self && bias === 'prev') out -= 1;
  return Math.max(0, Math.min(newLength - 1, out));
}

/** Remap a [start, end] window after removals; keeps start <= end. */
export function remapWindow(
  start: number,
  end: number,
  removed: readonly number[],
  newLength: number,
): [number, number] {
  const s = remapIndex(start, removed, 'next', newLength);
  let e = remapIndex(end, removed, 'prev', newLength);
  if (e < s) e = s;
  return [s, e];
}
