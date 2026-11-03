import { mutateBatch, type MutateRequest } from '../core/mutateBatch';
import { MUTATION_CHOICES, sweepAmounts, type MutationId, type SweepMode } from '../core/mutations';
import { randomSeed } from '../core/prng';
import { describeRecipe, type GeneratedTable, type WaveTable } from '../core/table';
import { cssColor, drawSpectrum, drawWave, fit, onThemeChange } from './canvas';
import { isOnScreen, watchVisibility, type FrameView, type UiContext } from './context';
import { h, selectField, slider } from './dom';

const WAVE_H = 64;
const SPEC_H = 30;
/** Minimum interval between preview recomputes while a control is being dragged. */
const PREVIEW_MS = 50;
const EVOLVE_MS = 700;
const EVOLVE_MAX_AMOUNT = 0.3;

const MODES: [SweepMode, string][] = [
  ['lin', 'Linear sweep'],
  ['log', 'Log sweep (64:1)'],
  ['chain', 'Chain'],
];

export interface MutatePanelOpts {
  /** Shared batch size N from the Generate section. */
  count(): number;
  /** Subscribe to batch-size changes. */
  onCount(fn: (n: number) => void): void;
  /** True while the Generate section is open and the Mutate tab is showing. */
  active(): boolean;
}

const hex = (s: number) => (s >>> 0).toString(16).padStart(8, '0');
const pctLabel = (v: number) => {
  const p = v * 100;
  return p < 10 && p > 0 ? p.toFixed(1) : String(Math.round(p));
};

/**
 * Generate → Mutate. Source is the timeline selection; the preview is computed in the
 * frame loop (throttled, only while visible) with the same seed Apply will use.
 */
export function buildMutatePanel(ctx: UiContext, opts: MutatePanelOpts): { el: HTMLElement; view: FrameView } {
  const { model } = ctx;
  let mutation: MutationId = 'toSaw';
  let amount = 0.25;
  let mode: SweepMode = 'lin';
  let seed = randomSeed();
  let evolveTimer: ReturnType<typeof setInterval> | null = null;

  // ---- source / preview views ----
  const srcLabel = h('span', { id: 'mutate-src-label', class: 'mono-label' });
  const srcWave = h('canvas', { id: 'mutate-src-wave', 'aria-label': 'Source table waveform' });
  const srcSpec = h('canvas', { id: 'mutate-src-spec', 'aria-label': 'Source table spectrum' });
  const pvWave = h('canvas', { id: 'mutate-pv-wave', 'aria-label': 'Preview of the Apply result over the source' });
  const pvSpec = h('canvas', { id: 'mutate-pv-spec', 'aria-label': 'Preview spectrum' });
  const seedLabel = h('span', { id: 'mutate-seed', class: 'mono-label', title: 'Shared by the preview, Apply and every table of Apply N' });
  const reroll = h('button', { id: 'mutate-reroll', class: 'small', 'aria-label': 'Reroll the seed', onclick: () => newSeed() }, 'Reroll');
  watchVisibility(pvWave);

  const views = h(
    'div',
    { class: 'grid2 mutate-views' },
    h(
      'div',
      { class: 'field' },
      h('div', { class: 'label' }, h('span', {}, 'Source'), h('span', { class: 'hint-inline' }, 'the Timeline selection')),
      srcWave,
      srcSpec,
      h('div', { class: 'label' }, srcLabel),
    ),
    h(
      'div',
      { class: 'field' },
      h('div', { class: 'label' }, h('span', {}, 'Preview'), reroll),
      pvWave,
      pvSpec,
      h('div', { class: 'label' }, seedLabel, h('span', { class: 'hint-inline' }, 'faint = source')),
    ),
  );

  // ---- controls ----
  const opSel = h('select', { id: 'mutate-op', 'aria-label': 'Mutation' });
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const m of MUTATION_CHOICES) {
    let g = groups.get(m.group);
    if (!g) {
      g = h('optgroup', { label: m.group });
      groups.set(m.group, g);
      opSel.append(g);
    }
    g.append(h('option', { value: m.id }, m.label));
  }
  opSel.value = mutation;
  opSel.addEventListener('change', () => {
    mutation = opSel.value as MutationId;
  });
  const amountSlider = slider({
    label: 'Amount',
    min: 0,
    max: 1,
    step: 0.01,
    value: amount,
    format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => {
      amount = v;
      updateSteps();
    },
  });
  amountSlider.input.id = 'mutate-amount';
  const modeField = selectField('Batch mode', MODES, mode, (v) => {
    mode = v as SweepMode;
    updateSteps();
  });
  modeField.select.id = 'mutate-mode';
  const stepsLabel = h('div', { id: 'mutate-steps', class: 'steps' });

  const apply1 = h('button', { id: 'mutate-apply1', class: 'primary grow', onclick: () => applySingle() }, 'Apply');
  const applyN = h('button', { id: 'mutate-applyN', class: 'primary grow', onclick: () => applyBatch() }, `Apply ${opts.count()}`);
  const evolveBtn = h('button', { id: 'mutate-evolve', class: 'grow', 'aria-pressed': 'false', onclick: () => toggleEvolve() }, 'Evolve');
  opts.onCount((n) => {
    applyN.textContent = `Apply ${n}`;
    updateSteps();
  });

  const el = h(
    'div',
    { role: 'tabpanel', id: 'panel-mutate', class: 'gen-cols' },
    h('div', { class: 'gen-col' }, views),
    h(
      'div',
      { class: 'gen-col' },
      h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('div', { class: 'label' }, h('span', {}, 'Mutation')), opSel), amountSlider.el),
      h('div', { class: 'grid2' }, modeField.el, h('div', { class: 'field' }, h('div', { class: 'label' }, h('span', {}, 'Steps')), stepsLabel)),
      h('div', { class: 'row' }, apply1, applyN, evolveBtn),
      h(
        'p',
        { class: 'hint' },
        'Apply adds one table and selects it. Apply N adds a batch from the same source (sets the ticked voices’ windows). ' +
          `Evolve mutates the newest table every ${EVOLVE_MS / 1000} s (amount capped at ${EVOLVE_MAX_AMOUNT * 100}%).`,
      ),
    ),
  );

  // ---- state helpers ----
  const source = (): WaveTable | undefined => model.table(model.selectedId);

  const syncButtons = () => {
    apply1.disabled = applyN.disabled = !source();
  };

  const updateSteps = () => {
    const n = opts.count();
    const s =
      mode === 'chain'
        ? `${n} × ${Math.round(amount * 100)}%, compounding`
        : sweepAmounts(n, amount, mode).map(pctLabel).join(' ');
    stepsLabel.textContent = s;
    stepsLabel.title = s;
  };

  const newSeed = () => {
    seed = randomSeed();
    seedLabel.textContent = `seed ${hex(seed)}`;
    dirty = true;
  };

  // ---- preview (computed in the frame loop) ----
  let pvKey = '';
  let pv: GeneratedTable | null = null;
  let lastCompute = -Infinity;
  let dirty = true;

  const request = (): MutateRequest => ({ mutation, amount, seed, mode: 'single', count: 1 });
  const currentKey = () => `${source()?.id ?? 'none'}|${mutation}|${amount}|${seed}`;

  const computePreview = (key: string) => {
    const src = source();
    pv = src ? mutateBatch(request(), src)[0] : null;
    pvKey = key;
    dirty = true;
  };

  const draw = () => {
    const src = source();
    const idx = model.indexOf(model.selectedId);
    srcLabel.textContent = src ? `#${idx + 1} · id ${src.id} · ${describeRecipe(src.recipe)}` : 'Nothing selected';
    syncButtons();
    const axis = cssColor('--border');
    const cSrc = cssColor('--text');
    const cPv = cssColor('--new');
    const cGhost = cssColor('--muted');
    const [g1, w1, h1] = fit(srcWave, WAVE_H);
    const [s1, sw1, sh1] = fit(srcSpec, SPEC_H);
    const [g2, w2, h2] = fit(pvWave, WAVE_H);
    const [s2, sw2, sh2] = fit(pvSpec, SPEC_H);
    if (!src) return;
    drawWave(g1, 0, 0, w1, h1, src.data, cSrc, { axis, lineWidth: 1.75 });
    drawSpectrum(s1, sw1, sh1, src.data, cSrc);
    if (!pv) return;
    drawWave(g2, 0, 0, w2, h2, src.data, cGhost, { axis, lineWidth: 1 });
    drawWave(g2, 0, 0, w2, h2, pv.data, cPv, { lineWidth: 1.75 });
    drawSpectrum(s2, sw2, sh2, pv.data, cPv);
  };

  // ---- actions ----
  const applySingle = () => {
    const src = source();
    if (!src) return;
    const gen = pv && pvKey === currentKey() ? pv : mutateBatch(request(), src)[0];
    model.addTables([gen], 'single', true);
    newSeed();
  };

  const applyBatch = () => {
    const src = source();
    if (!src) return;
    const req: MutateRequest = { mutation, amount, seed, mode, count: opts.count() };
    const gen = mutateBatch(req, src);
    model.addTables(gen, 'batch', false);
    newSeed();
  };

  /** Evolve pauses (skips ticks) while the Generate section / Mutate tab isn't showing. */
  const evolveTick = () => {
    const newest = model.timeline.at(-1);
    if (!newest || !opts.active()) return;
    const req: MutateRequest = { mutation, amount: Math.min(amount, EVOLVE_MAX_AMOUNT), seed: randomSeed(), mode: 'single', count: 1 };
    model.addTables(mutateBatch(req, newest), 'single', false);
  };

  const setEvolve = (on: boolean) => {
    if (on === (evolveTimer !== null)) return;
    if (on) evolveTimer = setInterval(evolveTick, EVOLVE_MS);
    else {
      clearInterval(evolveTimer!);
      evolveTimer = null;
    }
    evolveBtn.textContent = on ? 'Stop evolving' : 'Evolve';
    evolveBtn.setAttribute('aria-pressed', String(on));
    evolveBtn.classList.toggle('active', on);
  };
  const stopEvolve = () => setEvolve(false);
  const toggleEvolve = () => setEvolve(evolveTimer === null);

  // ---- subscriptions ----
  // Undo while evolving would be undone again by the next tick: stop instead.
  model.on('undone', stopEvolve);
  model.on('timeline', () => (dirty = true));
  onThemeChange(() => (dirty = true));
  new ResizeObserver(() => (dirty = true)).observe(el);

  updateSteps();
  newSeed();

  return {
    el,
    view: {
      frame(now) {
        if (!opts.active() || !isOnScreen(pvWave)) return;
        const key = currentKey();
        if (key !== pvKey && now - lastCompute >= PREVIEW_MS) {
          lastCompute = now;
          computePreview(key);
        }
        if (dirty) {
          dirty = false;
          draw();
        }
      },
    },
  };
}
