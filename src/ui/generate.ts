import type { FrameView, GenerateView, UiContext } from './context';
import { h, panel } from './dom';
import { buildBreedPanel } from './breed';
import { buildMutatePanel } from './mutate';
import { MAX_BATCH } from './batch';
import { buildSeedPanel } from './seed';
import { buildShapePanel } from './shapeTab';
import { buildGridPanel } from './gridTab';

export function buildGenerate(ctx: UiContext): { el: HTMLElement; view: FrameView } {
  const sec = panel('sec-generate', 'Generate', 'gen');
  let count = 8;
  const countListeners: ((n: number) => void)[] = [];
  const setCount = (n: number) => {
    n = Math.max(1, Math.min(MAX_BATCH, Math.round(n)));
    if (n === count) return;
    count = n;
    for (const fn of countListeners) fn(count);
  };
  const onCount = (fn: (n: number) => void) => countListeners.push(fn);

  // ---- tabs ----
  const tabNames = ['Seed', 'Mutate', 'Breed', 'Shape', 'Grid', 'Sample'] as const;
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Generate methods' });
  const panels = new Map<string, HTMLElement>();
  const tabButtons = new Map<string, HTMLButtonElement>();
  let currentTab = 'Seed';
  const setTab = (name: string) => {
    currentTab = name;
    ctx.ui.setPref('generateTab', name);
    for (const [n, b] of tabButtons) b.setAttribute('aria-selected', String(n === name));
    for (const [n, p] of panels) p.hidden = n !== name;
    sec.el.dataset.tab = name.toLowerCase();
    sec.body.scrollTop = 0;
  };
  for (const name of tabNames) {
    const b = h('button', { role: 'tab', id: `tab-${name.toLowerCase()}`, onclick: () => setTab(name) }, name);
    tabButtons.set(name, b);
    tabs.append(b);
  }
  sec.tools.append(tabs);

  // ---- Seed panel ----
  const seed = buildSeedPanel(ctx, {
    count: () => count,
    setCount,
    onCount,
    active: () => sec.isOpen() && currentTab === 'Seed',
  });
  panels.set('Seed', seed.el);

  // ---- Mutate panel ----
  const mutate = buildMutatePanel(ctx, {
    count: () => count,
    setCount,
    onCount,
    active: () => sec.isOpen() && currentTab === 'Mutate',
  });
  panels.set('Mutate', mutate.el);

  // ---- Breed panel ----
  const breed = buildBreedPanel(ctx, {
    count: () => count,
    setCount,
    onCount,
    active: () => sec.isOpen() && currentTab === 'Breed',
  });
  panels.set('Breed', breed.el);

  // ---- Shape panel ----
  const shapeTab = buildShapePanel(ctx, {
    count: () => count,
    setCount,
    onCount,
    active: () => sec.isOpen() && currentTab === 'Shape',
  });
  panels.set('Shape', shapeTab.el);

  // ---- Grid panel ----
  const grid = buildGridPanel(ctx, {
    count: () => count,
    setCount,
    onCount,
    active: () => sec.isOpen() && currentTab === 'Grid',
    sources: { Seed: seed.view, Mutate: mutate.view, Breed: breed.view, Shape: shapeTab.view },
    setTab: (name) => setTab(name),
  });
  panels.set('Grid', grid.el);

  // ---- placeholders ----
  const soon: Record<string, string> = {
    Sample: 'Extract single cycles from the microphone or an audio file.',
  };
  for (const name of ['Sample']) {
    const p = h(
      'div',
      { role: 'tabpanel', id: `panel-${name.toLowerCase()}`, class: 'placeholder' },
      h('strong', {}, `${name}: coming soon`),
      h('p', { class: 'hint', style: 'margin:6px 0 0' }, soon[name]),
    );
    panels.set(name, p);
  }
  sec.body.append(...panels.values());
  // The open tab is saved with the session (and follows an imported one).
  const savedTab = () => ctx.ui.pref('generateTab', 'Seed', (v) => tabNames.includes(v as (typeof tabNames)[number]));
  setTab(savedTab());
  sec.setStatus(() => {
    if (currentTab === 'Breed') return `Breed · ${ctx.model.breedParents.length} parents`;
    if (currentTab === 'Shape') return `Shape · ${ctx.model.shapeChain.name}`;
    if (currentTab === 'Grid') return 'Grid';
    if (currentTab === 'Mutate') {
      const i = ctx.model.indexOf(ctx.model.selectedId);
      return i >= 0 ? `Mutate · source #${i + 1}` : 'Mutate';
    }
    return `${currentTab} · batch of ${count}`;
  });
  ctx.ui.onPrefs(() => {
    if (savedTab() !== currentTab) setTab(savedTab());
  });
  return {
    el: sec.el,
    view: {
      frame(now) {
        seed.view.frame(now);
        mutate.view.frame(now);
        breed.view.frame(now);
        shapeTab.view.frame(now);
        grid.view.frame(now);
        // The open tab's preview feeds the Preview wavetables (unchanged data is a no-op).
        const views: Record<string, GenerateView> = { Seed: seed.view, Mutate: mutate.view, Breed: breed.view, Shape: shapeTab.view, Grid: grid.view };
        const p = views[currentTab]?.preview();
        if (p) ctx.model.setPreview(p.batch, p.shown, p.grid ?? null);
      },
    },
  };
}
