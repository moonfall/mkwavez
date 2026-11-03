import { describe, expect, it } from 'vitest';
import { appendWithEviction, remapIndex, remapWindow } from '../src/core/timeline';
import { DEFAULT_VOICE, followAppend, modulatedPosition, type VoiceParams } from '../src/core/voice';
import {
  allWavetable,
  ALL_WAVETABLE_ID,
  cell2D,
  clampWindow,
  make1D,
  make2D,
  pinnedIds,
  playbackIds,
  wavetableLength,
} from '../src/core/wavetable';

const items = (ids: number[]) => ids.map((id) => ({ id }));
const ids = (l: { id: number }[]) => l.map((x) => x.id);

describe('timeline eviction', () => {
  it('appends without eviction under the cap', () => {
    const r = appendWithEviction(items([1, 2]), items([3]), 5, () => false);
    expect(ids(r.list)).toEqual([1, 2, 3]);
    expect(r.evicted).toEqual([]);
  });

  it('evicts oldest first at the cap', () => {
    const r = appendWithEviction(items([1, 2, 3, 4]), items([5, 6]), 4, () => false);
    expect(ids(r.list)).toEqual([3, 4, 5, 6]);
    expect(ids(r.evicted)).toEqual([1, 2]);
    expect(r.evictedIndices).toEqual([0, 1]);
  });

  it('never evicts pinned tables', () => {
    const pinned = new Set([1, 3]);
    const r = appendWithEviction(items([1, 2, 3, 4]), items([5, 6]), 4, (id) => pinned.has(id));
    expect(ids(r.list)).toEqual([1, 3, 5, 6]);
    expect(r.evictedIndices).toEqual([1, 3]);
  });

  it('exceeds the cap rather than evicting pinned tables', () => {
    const r = appendWithEviction(items([1, 2]), items([3]), 2, (id) => id !== 3);
    expect(ids(r.list)).toEqual([1, 2]);
    expect(ids(r.evicted)).toEqual([3]);
    const r2 = appendWithEviction(items([1, 2]), items([3]), 2, () => true);
    expect(ids(r2.list)).toEqual([1, 2, 3]);
  });

  it('handles a large default-size cap', () => {
    let list: { id: number }[] = [];
    for (let i = 0; i < 5000; i += 100) {
      list = appendWithEviction(list, items(Array.from({ length: 100 }, (_, k) => i + k)), 4096, () => false).list;
    }
    expect(list.length).toBe(4096);
    expect(list[0].id).toBe(5000 - 4096);
  });

  it('remaps indices and windows after removals', () => {
    expect(remapIndex(5, [0, 1], 'next', 8)).toBe(3);
    expect(remapIndex(1, [1, 2], 'next', 8)).toBe(1);
    expect(remapIndex(2, [1, 2], 'prev', 8)).toBe(0);
    expect(remapWindow(0, 3, [0, 1], 6)).toEqual([0, 1]);
    expect(remapWindow(0, 1, [0, 1], 6)).toEqual([0, 0]);
  });
});

describe('wavetable model', () => {
  it('All mirrors timeline ids and never pins', () => {
    const all = allWavetable([4, 5, 6]);
    expect(all.id).toBe(ALL_WAVETABLE_ID);
    expect(all.auto).toBe('all');
    expect(wavetableLength(all)).toBe(3);
    const user = make1D(1, 'Mine', [5, 9, 5]);
    expect([...pinnedIds([all, user])].sort()).toEqual([5, 9]);
  });

  it('2D grids are row-major with empty cells', () => {
    const g = make2D(2, 'Grid', 3, 2, [1, 2, 3, 4]);
    expect(wavetableLength(g)).toBe(6);
    expect(cell2D(g, 0, 1)).toBe(4);
    expect(cell2D(g, 2, 1)).toBe(null);
    expect(cell2D(g, 5, 5)).toBe(null);
    expect(playbackIds(g)).toEqual([1, 2, 3, 4]);
    expect([...pinnedIds([g])]).toEqual([1, 2, 3, 4]);
  });

  it('clamps windows', () => {
    expect(clampWindow(5, 2, 10)).toEqual([2, 5]);
    expect(clampWindow(-3, 99, 10)).toEqual([0, 9]);
    expect(clampWindow(3, 4, 0)).toEqual([0, 0]);
  });
});

describe('window following', () => {
  const v = (id: number, s: number, e: number): VoiceParams => ({
    ...DEFAULT_VOICE,
    id,
    name: `V${id}`,
    windowStart: s,
    windowEnd: e,
  });

  it('single add extends windows ending on the newest table', () => {
    const out = followAppend([v(1, 0, 4), v(2, 0, 2)], 0, 5, 6, [], { kind: 'single' });
    expect([out[0].windowStart, out[0].windowEnd]).toEqual([0, 5]);
    expect([out[1].windowStart, out[1].windowEnd]).toEqual([0, 2]);
  });

  it('batch sets targeted windows to the batch only', () => {
    const out = followAppend([v(1, 0, 4), v(2, 1, 2)], 0, 5, 9, [], {
      kind: 'batch',
      count: 4,
      targets: new Set([2]),
    });
    expect([out[0].windowStart, out[0].windowEnd]).toEqual([0, 4]);
    expect([out[1].windowStart, out[1].windowEnd]).toEqual([5, 8]);
  });

  it('eviction shifts windows to keep pointing at the same tables', () => {
    // timeline of 4 at cap 4; add one -> index 0 evicted.
    const out = followAppend([v(1, 1, 2), v(2, 0, 3)], 0, 4, 4, [0], { kind: 'single' });
    expect([out[0].windowStart, out[0].windowEnd]).toEqual([0, 1]);
    expect([out[1].windowStart, out[1].windowEnd]).toEqual([0, 3]);
  });

  it('ignores voices on other wavetables', () => {
    const other = { ...v(1, 0, 0), wavetableId: 7 };
    expect(followAppend([other], 0, 1, 2, [], { kind: 'single' })[0]).toBe(other);
  });

  it('LFO position reflects into [0,1]', () => {
    expect(modulatedPosition(0.5, 1, Math.PI / 2)).toBeCloseTo(1);
    expect(modulatedPosition(0.9, 0.6, Math.PI / 2)).toBeCloseTo(0.8);
    expect(modulatedPosition(0.1, 0.6, -Math.PI / 2)).toBeCloseTo(0.2);
  });
});
