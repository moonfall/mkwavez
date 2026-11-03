import { describe, expect, it } from 'vitest';
import { appendWithEviction, remapIndex, remapWindow } from '../src/core/timeline';
import { modulatedPosition } from '../src/core/voice';

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

describe('LFO', () => {
  it('position reflects into [0,1]', () => {
    expect(modulatedPosition(0.5, 1, Math.PI / 2)).toBeCloseTo(1);
    expect(modulatedPosition(0.9, 0.6, Math.PI / 2)).toBeCloseTo(0.8);
    expect(modulatedPosition(0.1, 0.6, -Math.PI / 2)).toBeCloseTo(0.2);
  });
});
