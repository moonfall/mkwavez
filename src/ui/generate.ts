import type { FrameView, UiContext } from './context';
import { h, panel, slider } from './dom';
import { buildBreedPanel } from './breed';
import { buildMutatePanel } from './mutate';
import { MAX_BATCH } from './batch';
import { buildSeedPanel } from './seed';

export function buildGenerate(ctx: UiContext): { el: HTMLElement; view: FrameView } {
  const sec = panel('sec-generate', 'Generate');
  let count = 8;
  const countListeners: ((n: number) => void)[] = [];
  const setCount = (n: number) => {
    n = Math.max(1, Math.min(MAX_BATCH, Math.round(n)));
    if (n === count) return;
    count = n;
    countSlider.set(n);
    for (const fn of countListeners) fn(count);
  };
  const onCount = (fn: (n: number) => void) => countListeners.push(fn);

  // ---- Breed: batch size (Seed / Mutate have their own batch row) ----
  const countSlider = slider({
    label: 'Batch size (N)',
    min: 1,
    max: MAX_BATCH,
    step: 1,
    value: count,
    onInput: (v) => setCount(v),
  });
  const shared = h(
    'div',
    { class: 'grid2', id: 'gen-shared' },
    countSlider.el,
  );

  // ---- tabs ----
  const tabNames = ['Seed', 'Mutate', 'Breed', 'Sample'] as const;
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Generate methods' });
  const panels = new Map<string, HTMLElement>();
  const tabButtons = new Map<string, HTMLButtonElement>();
  let currentTab = 'Seed';
  const setTab = (name: string) => {
    currentTab = name;
    for (const [n, b] of tabButtons) b.setAttribute('aria-selected', String(n === name));
    for (const [n, p] of panels) p.hidden = n !== name;
    shared.hidden = name !== 'Breed';
    sec.el.dataset.tab = name.toLowerCase();
    sec.body.scrollTop = 0;
  };
  for (const name of tabNames) {
    const b = h('button', { role: 'tab', id: `tab-${name.toLowerCase()}`, onclick: () => setTab(name) }, name);
    tabButtons.set(name, b);
    tabs.append(b);
  }
  sec.tools.append(tabs);
  sec.body.append(shared);

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
    onCount,
    active: () => sec.isOpen() && currentTab === 'Breed',
  });
  panels.set('Breed', breed.el);

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
  setTab('Seed');
  return {
    el: sec.el,
    view: {
      frame(now) {
        seed.view.frame(now);
        mutate.view.frame(now);
        breed.view.frame(now);
      },
    },
  };
}
