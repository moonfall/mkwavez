import { describe, expect, it } from 'vitest';
import { maximized, parseLayoutState, toggled, wideShapes, type LayoutState } from '../src/ui/layout';

const open: LayoutState = { collapsed: [], max: null, restore: null };

describe('shell layout state', () => {
  it('parses saved states, falling back to per-layout defaults', () => {
    expect(parseLayoutState(undefined, 'wide')).toEqual(open);
    expect(parseLayoutState(null, 'narrow')).toEqual({ collapsed: ['wt'], max: null, restore: null });
    // Unknown keys dropped, order normalised; max only on the wide shell and only if open.
    expect(parseLayoutState({ collapsed: ['seq', 'nope', 'gen'], max: 'tl', restore: ['seq', 'x'] }, 'wide')).toEqual({ collapsed: ['gen', 'seq'], max: 'tl', restore: ['seq'] });
    expect(parseLayoutState({ collapsed: ['tl'], max: 'tl' }, 'wide').max).toBeNull();
    expect(parseLayoutState({ collapsed: [], max: 'tl' }, 'narrow').max).toBeNull();
    expect(parseLayoutState({ collapsed: 'gen' }, 'wide').collapsed).toEqual([]);
  });

  it('collapses / expands one panel; a manual change ends a maximize', () => {
    const a = toggled(open, 'seq', true);
    expect(a.collapsed).toEqual(['seq']);
    expect(toggled(a, 'seq', true)).toBe(a);
    expect(toggled(a, 'gen', true).collapsed).toEqual(['gen', 'seq']);
    const m = maximized(a, 'tl');
    expect(toggled(m, 'voice', false)).toEqual({ collapsed: ['gen', 'wt', 'seq'], max: null, restore: null });
  });

  it('maximize collapses the others and restores the previous arrangement', () => {
    const a = toggled(open, 'gen', true);
    const m = maximized(a, 'tl');
    expect(m).toEqual({ collapsed: ['gen', 'wt', 'voice', 'seq'], max: 'tl', restore: ['gen'] });
    // Maximizing another panel keeps the original restore point.
    const m2 = maximized(m, 'voice');
    expect(m2).toEqual({ collapsed: ['gen', 'wt', 'tl', 'seq'], max: 'voice', restore: ['gen'] });
    expect(maximized(m2, 'voice')).toEqual({ collapsed: ['gen'], max: null, restore: null });
  });

  it('maximizing a panel that was collapsed restores it collapsed, with the rest as before', () => {
    const a: LayoutState = { collapsed: ['wt', 'seq'], max: null, restore: null };
    const m = maximized(a, 'seq');
    expect(m).toEqual({ collapsed: ['gen', 'wt', 'tl', 'voice'], max: 'seq', restore: ['wt', 'seq'] });
    expect(maximized(m, 'seq')).toEqual(a);
  });

  it('wide shapes: strips beside an open sibling, bars for whole rows', () => {
    let s = wideShapes(['seq']);
    expect(s.shapes).toMatchObject({ voice: 'open', seq: 'strip', tl: 'open' });
    expect(s.rows).toEqual([false, false, false]);
    s = wideShapes(['gen', 'wt', 'tl']);
    expect(s.shapes).toMatchObject({ gen: 'bar', wt: 'bar', tl: 'bar' });
    expect(s.rows).toEqual([true, true, false]);
    // Generate hidden (the Wavetables editor covers its row): Wavetables alone in it.
    s = wideShapes(['wt'], ['gen']);
    expect(s.shapes.wt).toBe('bar');
    expect(s.rows[0]).toBe(true);
    expect(wideShapes(['gen'], ['gen']).rows[0]).toBe(false);
  });
});
