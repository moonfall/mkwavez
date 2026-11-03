import { compileFormula } from '../browser/formulaEval';
import {
  BASIC_WAVES,
  CA_RULES,
  DEFAULT_PERLIN,
  FORMULA_PRESETS,
  generateBasic,
  generateCa,
  generateFormula,
  generatePerlin,
  type BasicWave,
  type PerlinParams,
} from '../core/generators';
import { randomSeed } from '../core/prng';
import type { GeneratedTable } from '../core/table';
import type { UiContext } from './context';
import { h, section, selectField, slider, voiceColorVar } from './dom';

const BASIC_LABELS: Record<BasicWave, string> = {
  sine: 'Sine',
  tri: 'Tri',
  saw: 'Saw',
  square: 'Square',
  p25: 'P25',
  p10: 'P10',
  noise: 'Noise',
};

const MAX_BATCH = 64;

export function buildGenerate(ctx: UiContext): HTMLElement {
  const { model } = ctx;
  const sec = section('sec-generate', 'Generate');
  let count = 8;

  // ---- shared: batch size + batch window targets ----
  const countSlider = slider({
    label: 'Batch size (N)',
    min: 1,
    max: MAX_BATCH,
    step: 1,
    value: count,
    onInput: (v) => {
      count = v;
      for (const b of nButtons) b.textContent = `+${count}`;
    },
  });
  const checks = h('div', { class: 'checks' });
  const renderChecks = () => {
    checks.replaceChildren(
      ...model.voices.map((v) => {
        const cb = h('input', { type: 'checkbox', checked: model.batchTargets.has(v.id) });
        cb.addEventListener('change', () => model.setBatchTarget(v.id, cb.checked));
        return h('label', { class: 'check', style: `color:var(${voiceColorVar(v.id - 1)})` }, cb, v.name);
      }),
    );
    if (!model.voices.length) checks.append(h('span', { class: 'hint' }, 'No voices'));
  };
  model.on('voices', renderChecks);
  model.on('batchTargets', renderChecks);
  renderChecks();
  sec.body.append(
    h(
      'div',
      { class: 'grid2' },
      countSlider.el,
      h('div', { class: 'field' }, h('div', { class: 'label' }, h('span', {}, 'Batch sets window of')), checks),
    ),
  );

  const nButtons: HTMLButtonElement[] = [];
  const nButton = (onClick: () => void, aria: string) => {
    const b = h('button', { class: 'primary', 'aria-label': aria, onclick: onClick }, `+${count}`);
    nButtons.push(b);
    return b;
  };

  const add = (list: GeneratedTable[] | null, mode: 'single' | 'batch') => {
    if (list && list.length) model.addTables(list, mode, true);
  };

  // ---- tabs ----
  const tabNames = ['Seed', 'Mutate', 'Breed', 'Sample'] as const;
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const panels = new Map<string, HTMLElement>();
  const tabButtons = new Map<string, HTMLButtonElement>();
  const setTab = (name: string) => {
    for (const [n, b] of tabButtons) b.setAttribute('aria-selected', String(n === name));
    for (const [n, p] of panels) p.hidden = n !== name;
  };
  for (const name of tabNames) {
    const b = h('button', { role: 'tab', id: `tab-${name.toLowerCase()}`, onclick: () => setTab(name) }, name);
    tabButtons.set(name, b);
    tabs.append(b);
  }
  sec.body.append(tabs);

  // ---- Seed panel ----
  const seed = h('div', { role: 'tabpanel', id: 'panel-seed' });
  panels.set('Seed', seed);

  // Basic waves
  seed.append(h('div', { class: 'group-title' }, 'Basic'));
  seed.append(
    h(
      'div',
      { class: 'btns', id: 'basic-buttons' },
      ...BASIC_WAVES.map((w) =>
        h(
          'button',
          { 'data-wave': w, 'aria-label': `Add ${w}`, onclick: () => add([generateBasic(w, randomSeed())], 'single') },
          BASIC_LABELS[w],
        ),
      ),
    ),
  );

  // Formula
  seed.append(h('div', { class: 'group-title' }, 'Formula'));
  const presetSel = h('select', { 'aria-label': 'Formula preset', style: 'flex:0 0 32%' });
  const groups = new Map<string, HTMLOptGroupElement>();
  FORMULA_PRESETS.forEach((p, i) => {
    let g = groups.get(p.group);
    if (!g) {
      g = h('optgroup', { label: p.group });
      groups.set(p.group, g);
      presetSel.append(g);
    }
    g.append(h('option', { value: String(i) }, p.name));
  });
  const exprInput = h('input', {
    type: 'text',
    class: 'grow',
    value: FORMULA_PRESETS[0].expr,
    'aria-label': 'Expression in p, t, n, u with pnoise()',
    spellcheck: false,
    autocapitalize: 'off',
    autocomplete: 'off',
  });
  const err = h('div', { class: 'error', role: 'status' });
  let presetName = FORMULA_PRESETS[0].name;
  presetSel.addEventListener('change', () => {
    const p = FORMULA_PRESETS[Number(presetSel.value)];
    exprInput.value = p.expr;
    presetName = p.name;
    err.textContent = '';
  });
  exprInput.addEventListener('input', () => {
    err.textContent = '';
    presetName = 'formula';
  });
  const evalFormula = (n: number): GeneratedTable[] | null => {
    try {
      const fn = compileFormula(exprInput.value);
      return generateFormula(fn, exprInput.value, presetName, randomSeed(), n);
    } catch {
      err.textContent = "Couldn't evaluate. Use p, t, n, u, Math functions and pnoise(freq, z, octaves, persistence).";
      return null;
    }
  };
  seed.append(
    h(
      'div',
      { class: 'row' },
      presetSel,
      exprInput,
      h('button', { id: 'formula-add1', style: 'flex:0 0 40px', onclick: () => add(evalFormula(1), 'single') }, '+1'),
      nButton(() => add(evalFormula(count), 'batch'), 'Add a batch of formula tables'),
    ),
    err,
    h('p', { class: 'hint' }, 'p = phase 0–2π, t = 0–1, n = batch index, u = 0–1 across the batch.'),
  );

  // Perlin
  seed.append(h('div', { class: 'group-title' }, 'Perlin noise'));
  const perlin: PerlinParams = { ...DEFAULT_PERLIN };
  const pSlider = (label: string, key: keyof PerlinParams, min: number, max: number, step: number) =>
    slider({
      label,
      min,
      max,
      step,
      value: perlin[key],
      format: (v) => (step < 1 ? v.toFixed(2) : String(v)),
      onInput: (v) => {
        perlin[key] = v;
      },
    }).el;
  seed.append(
    h(
      'div',
      { class: 'grid2 grid4' },
      pSlider('Frequency', 'freq', 0.5, 8, 0.05),
      pSlider('Octaves', 'octaves', 1, 8, 1),
      pSlider('Persistence', 'persistence', 0.1, 0.9, 0.01),
      pSlider('Z drift (batch)', 'zDrift', 0, 4, 0.05),
    ),
    h(
      'div',
      { class: 'row' },
      h('span', { class: 'hint grow', style: 'margin:0' }, 'A batch shares one noise region and drifts through z.'),
      h(
        'button',
        { id: 'perlin-add1', style: 'flex:0 0 40px', onclick: () => add(generatePerlin(perlin, randomSeed(), 1), 'single') },
        '+1',
      ),
      nButton(() => add(generatePerlin(perlin, randomSeed(), count), 'batch'), 'Add a batch of Perlin tables'),
    ),
  );

  // Cellular automaton
  seed.append(h('div', { class: 'group-title' }, 'Cellular automaton'));
  let rule = 30;
  let cells = 32;
  const ruleField = selectField(
    'Rule',
    CA_RULES.map((r) => [String(r.rule), `${r.rule} · ${r.label}`]),
    String(rule),
    (v) => {
      rule = Number(v);
    },
  );
  seed.append(
    h(
      'div',
      { class: 'grid2' },
      ruleField.el,
      slider({ label: 'Cells', min: 8, max: 64, step: 4, value: cells, onInput: (v) => (cells = v) }).el,
    ),
    h(
      'div',
      { class: 'row' },
      h(
        'span',
        { class: 'hint grow', style: 'margin:0' },
        'Each generation’s cells become ±1 steps of one table; a batch is N consecutive generations.',
      ),
      h(
        'button',
        { id: 'ca-add1', style: 'flex:0 0 40px', onclick: () => add(generateCa({ rule, cells }, randomSeed(), 1), 'single') },
        '+1',
      ),
      nButton(() => add(generateCa({ rule, cells }, randomSeed(), count), 'batch'), 'Add N CA generations'),
    ),
  );

  // ---- placeholders ----
  const soon: Record<string, string> = {
    Mutate: 'Mutate the selected table: morph, waveshape, spectral and random mutations with preview and sweeps.',
    Breed: 'Combine two or more parents: crossfades, spectral and per-harmonic genetic crossover.',
    Sample: 'Extract single cycles from the microphone or an audio file.',
  };
  for (const name of ['Mutate', 'Breed', 'Sample']) {
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
  return sec.el;
}
