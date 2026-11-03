import {
  breedBatch,
  breedWeights,
  BREED_OPS,
  isSeededOp,
  MAX_PARENTS,
  sweepBiases,
  type BiasWalk,
  type BreedMode,
  type BreedOpId,
  type BreedRequest,
} from '../core/breed';
import { randomSeed } from '../core/prng';
import { describeRecipe, type GeneratedTable, type TableId, type WaveTable } from '../core/table';
import { cssColor, drawSpectrum, drawWave, fit, onThemeChange } from './canvas';
import { isOnScreen, watchVisibility, type FrameView, type UiContext } from './context';
import { h, selectField, slider } from './dom';

const WAVE_H = 64;
const SPEC_H = 30;
const THUMB_H = 34;
/** Minimum interval between preview recomputes while a control is being dragged. */
const PREVIEW_MS = 50;

const WALKS: [BiasWalk, string][] = [
  ['path', 'Path A→B→…'],
  ['ring', 'Ring A→…→A'],
  ['weights', 'Custom weights'],
];
const MODES: [Exclude<BreedMode, 'single'>, string][] = [
  ['sweep', 'Sweep (0→Bias)'],
  ['gen', 'Generation'],
];

export interface BreedPanelOpts {
  /** Shared batch size N from the Generate section. */
  count(): number;
  onCount(fn: (n: number) => void): void;
  /** True while the Generate section is open and the Breed tab is showing. */
  active(): boolean;
}

export const parentLetter = (i: number) => String.fromCharCode(65 + i);
const hex = (s: number) => (s >>> 0).toString(16).padStart(8, '0');
const pct = (v: number) => {
  const p = v * 100;
  return p < 10 && p > 0 ? p.toFixed(1) : String(Math.round(p));
};

/**
 * Generate → Breed. Parents live in the model (AppModel.breedParents) so the Timeline
 * can toggle them; evicted parents drop out there. The preview is computed in the frame
 * loop (throttled, only while visible) with the seed Breed / Breed N will use.
 */
export function buildBreedPanel(ctx: UiContext, opts: BreedPanelOpts): { el: HTMLElement; view: FrameView } {
  const { model } = ctx;
  let op: BreedOpId = 'mix';
  let bias = 0.5;
  let walk: BiasWalk = 'path';
  let rate = 0.05;
  let mode: Exclude<BreedMode, 'single'> = 'sweep';
  let seed = randomSeed();
  let windowVoiceId: number | null = null;
  /** Custom weights by table id (walk 'weights'); default 1. */
  const weights = new Map<TableId, number>();

  // ---- parents ----
  const cards = h('div', { id: 'breed-parents', class: 'parents' });
  const addSel = h('button', { id: 'breed-add-selected', class: 'grow', onclick: () => addSelected() }, 'Add selected');
  const winSel = h('select', { id: 'breed-window-voice', 'aria-label': 'Voice whose window to use as parents', style: 'flex:0 0 auto' });
  winSel.addEventListener('change', () => (windowVoiceId = Number(winSel.value)));
  const useWin = h('button', { id: 'breed-use-window', style: 'flex:0 0 auto', onclick: () => useWindow() }, 'Use window');
  const clear = h('button', { id: 'breed-clear', onclick: () => model.setBreedParents([]) }, 'Clear');
  const parentsMeta = h('span', { class: 'hint-inline', id: 'breed-parents-meta' });

  // ---- preview ----
  const pvWave = h('canvas', { id: 'breed-pv-wave', 'aria-label': 'Preview of the Breed result over parent A' });
  const pvSpec = h('canvas', { id: 'breed-pv-spec', 'aria-label': 'Preview spectrum' });
  const seedLabel = h('span', { id: 'breed-seed', class: 'mono-label', title: 'Shared by the preview, Breed and Breed N' });
  const weightsLabel = h('span', { id: 'breed-weights', class: 'mono-label' });
  const reroll = h('button', { id: 'breed-reroll', class: 'small', 'aria-label': 'Reroll the seed', onclick: () => newSeed() }, 'Reroll');
  watchVisibility(pvWave);

  // ---- controls ----
  const opSel = h('select', { id: 'breed-op', 'aria-label': 'Breed operator' });
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const o of BREED_OPS) {
    let g = groups.get(o.group);
    if (!g) {
      g = h('optgroup', { label: o.group });
      groups.set(o.group, g);
      opSel.append(g);
    }
    g.append(h('option', { value: o.id }, o.label));
  }
  opSel.value = op;
  opSel.addEventListener('change', () => {
    op = opSel.value as BreedOpId;
    updateSteps();
  });
  const biasSlider = slider({
    label: 'Bias (A → others)',
    min: 0,
    max: 1,
    step: 0.01,
    value: bias,
    format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => {
      bias = v;
      updateSteps();
    },
  });
  biasSlider.input.id = 'breed-bias';
  const walkField = selectField('Bias walks', WALKS, walk, (v) => {
    walk = v as BiasWalk;
    cards.classList.toggle('show-weights', walk === 'weights');
  });
  walkField.select.id = 'breed-walk';
  const rateSlider = slider({
    label: 'Mutation',
    min: 0,
    max: 0.5,
    step: 0.01,
    value: rate,
    format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => {
      rate = v;
      updateSteps();
    },
  });
  rateSlider.input.id = 'breed-rate';
  const modeField = selectField('Batch mode', MODES, mode, (v) => {
    mode = v as typeof mode;
    updateSteps();
  });
  modeField.select.id = 'breed-mode';
  const stepsLabel = h('div', { id: 'breed-steps', class: 'steps' });

  const apply1 = h('button', { id: 'breed-apply1', class: 'primary grow', onclick: () => applySingle() }, 'Breed');
  const applyN = h('button', { id: 'breed-applyN', class: 'primary grow', onclick: () => applyBatch() }, `Breed ${opts.count()}`);
  opts.onCount((n) => {
    applyN.textContent = `Breed ${n}`;
    updateSteps();
  });

  const el = h(
    'div',
    { role: 'tabpanel', id: 'panel-breed' },
    h('div', { class: 'label' }, h('span', {}, `Parents (2–${MAX_PARENTS})`), parentsMeta),
    cards,
    h('div', { class: 'row' }, addSel, winSel, useWin, clear),
    h(
      'div',
      { class: 'field' },
      h('div', { class: 'label' }, h('span', {}, 'Preview'), weightsLabel, reroll),
      pvWave,
      pvSpec,
      h('div', { class: 'label' }, seedLabel, h('span', { class: 'hint-inline' }, 'faint = A')),
    ),
    h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('div', { class: 'label' }, h('span', {}, 'Operator')), opSel), biasSlider.el),
    h('div', { class: 'grid2' }, walkField.el, rateSlider.el),
    h('div', { class: 'grid2' }, modeField.el, h('div', { class: 'field' }, h('div', { class: 'label' }, h('span', {}, 'Children')), stepsLabel)),
    h('div', { class: 'row' }, apply1, applyN),
    h(
      'p',
      { class: 'hint' },
      'Shift-click or long-press tables in the Timeline to add or remove parents. Bias 0 is parent A. ' +
        'Breed adds one child and selects it; Breed N sweeps the bias from A (or makes N seeded children at the same bias) ' +
        'and sets the ticked voices’ windows. Mutation adds seeded jitter, strongest between parents.',
    ),
  );

  // ---- state helpers ----
  const parents = (): WaveTable[] => model.breedParents.map((id) => model.table(id)).filter((t): t is WaveTable => !!t);
  const weightList = () => model.breedParents.map((id) => weights.get(id) ?? 1);
  const ready = () => model.breedParents.length >= 2;
  /** Generation of a deterministic operator without mutation would add N identical children. */
  const genIdentical = () => mode === 'gen' && !isSeededOp(op) && rate === 0;

  const addSelected = () => {
    if (model.selectedId !== null && !model.breedParents.includes(model.selectedId)) model.toggleBreedParent(model.selectedId);
  };

  /** Parents = the voice's window (evenly spaced picks if it holds more than MAX_PARENTS). */
  const useWindow = () => {
    const v = windowVoiceId === null ? undefined : model.voice(windowVoiceId);
    if (!v) return;
    const len = v.windowEnd - v.windowStart + 1;
    const n = Math.min(len, MAX_PARENTS);
    const ids: TableId[] = [];
    for (let i = 0; i < n; i++) {
      const idx = v.windowStart + (n > 1 ? Math.round((i * (len - 1)) / (n - 1)) : 0);
      const t = model.tableAt(v.wavetableId, idx);
      if (t) ids.push(t.id);
    }
    model.setBreedParents(ids);
  };

  /** Rebuild voice options only when the voice list or names change (keeps an open dropdown open). */
  let voiceSig = '';
  const renderVoices = () => {
    const vs = model.voices;
    if (windowVoiceId === null || !vs.some((v) => v.id === windowVoiceId)) {
      windowVoiceId = vs.find((v) => model.batchTargets.has(v.id))?.id ?? vs[0]?.id ?? null;
    }
    const sig = vs.map((v) => `${v.id}:${v.name}`).join('|');
    if (sig !== voiceSig) {
      voiceSig = sig;
      winSel.replaceChildren(...vs.map((v) => h('option', { value: String(v.id) }, v.name)));
    }
    if (windowVoiceId !== null && winSel.value !== String(windowVoiceId)) winSel.value = String(windowVoiceId);
    winSel.disabled = useWin.disabled = !vs.length;
  };

  let thumbs: { id: TableId; canvas: HTMLCanvasElement; label: HTMLElement }[] = [];
  const renderCards = () => {
    const ids = model.breedParents;
    for (const id of [...weights.keys()]) if (!ids.includes(id)) weights.delete(id);
    thumbs = [];
    if (!ids.length) {
      cards.replaceChildren(
        h('p', { class: 'hint parents-empty' }, 'No parents yet: add the selected table, use a voice’s window, or Shift-click / long-press tables in the Timeline.'),
      );
    } else {
      cards.replaceChildren(
        ...ids.map((id, i) => {
          const L = parentLetter(i);
          const canvas = h('canvas', { class: 'pc-wave', 'aria-label': `Parent ${L} waveform` });
          const label = h('span', { class: 'pc-id' });
          thumbs.push({ id, canvas, label });
          const w = slider({
            label: `Weight ${L}`,
            min: 0,
            max: 1,
            step: 0.01,
            value: weights.get(id) ?? 1,
            format: (v) => `${Math.round(v * 100)}`,
            onInput: (v) => weights.set(id, v),
          });
          w.input.classList.add('pc-weight');
          w.el.classList.add('pc-weight-field');
          return h(
            'div',
            { class: 'parent-card', 'data-id': String(id) },
            h('div', { class: 'pc-head' }, h('span', { class: 'pc-letter' }, L), label),
            canvas,
            w.el,
            h(
              'div',
              { class: 'pc-btns' },
              h('button', { class: 'small', 'aria-label': `Move ${L} earlier`, disabled: i === 0, onclick: () => model.moveBreedParent(id, -1) }, '‹'),
              h('button', { class: 'small', 'aria-label': `Move ${L} later`, disabled: i === ids.length - 1, onclick: () => model.moveBreedParent(id, 1) }, '›'),
              h('button', { class: 'small', 'aria-label': `Remove parent ${L}`, onclick: () => model.toggleBreedParent(id) }, '×'),
            ),
          );
        }),
      );
    }
    parentsMeta.textContent = ids.length ? `${ids.length} · ${ids.map((_, i) => parentLetter(i)).join(' ')}` : '';
    clear.disabled = !ids.length;
    dirtyThumbs = dirty = true;
    syncButtons();
  };

  const syncButtons = () => {
    apply1.disabled = !ready();
    applyN.disabled = !ready() || genIdentical();
    addSel.disabled = model.selectedId === null || model.breedParents.includes(model.selectedId) || model.breedParents.length >= MAX_PARENTS;
  };

  const updateSteps = () => {
    const n = opts.count();
    const s =
      mode === 'gen'
        ? genIdentical()
          ? 'identical: pick a seeded operator or raise Mutation'
          : `${n} × ${pct(bias)}%, seeds differ`
        : sweepBiases(n, bias).map(pct).join(' ');
    stepsLabel.textContent = s;
    stepsLabel.title = s;
    syncButtons();
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
  let dirtyThumbs = true;

  const request = (m: BreedMode, count: number): BreedRequest => ({
    op,
    bias,
    walk,
    weights: walk === 'weights' ? weightList() : undefined,
    rate,
    seed,
    mode: m,
    count,
  });
  const currentKey = () =>
    `${model.breedParents.join(',')}|${op}|${bias}|${walk}|${walk === 'weights' ? weightList().join(',') : ''}|${rate}|${seed}`;

  const computePreview = (key: string) => {
    pv = ready() ? breedBatch(request('single', 1), parents())[0] : null;
    pvKey = key;
    dirty = true;
  };

  const drawThumbs = () => {
    const c = cssColor('--text');
    for (const t of thumbs) {
      const tab = model.table(t.id);
      const [g, w, hh] = fit(t.canvas, THUMB_H);
      if (!tab) continue;
      t.label.textContent = `#${model.indexOf(t.id) + 1}`;
      t.label.title = `id ${t.id} · ${describeRecipe(tab.recipe)}`;
      drawWave(g, 0, 0, w, hh, tab.data, c, { lineWidth: 1.25 });
    }
  };

  const draw = () => {
    const P = model.breedParents.length;
    const w = P ? breedWeights(P, bias, walk, weightList()) : [];
    weightsLabel.textContent = P >= 2 ? w.map((v, i) => `${parentLetter(i)} ${pct(v)}`).join(' · ') : '';
    const axis = cssColor('--border');
    const [g, ww, hh] = fit(pvWave, WAVE_H);
    const [s, sw, sh] = fit(pvSpec, SPEC_H);
    const a = model.table(model.breedParents[0] ?? null);
    if (!pv || !a) {
      g.fillStyle = cssColor('--muted');
      g.font = '12px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(P < 2 ? 'Add at least two parents' : '…', ww / 2, hh / 2);
      return;
    }
    const cPv = cssColor('--new');
    drawWave(g, 0, 0, ww, hh, a.data, cssColor('--muted'), { axis, lineWidth: 1 });
    drawWave(g, 0, 0, ww, hh, pv.data, cPv, { lineWidth: 1.75 });
    drawSpectrum(s, sw, sh, pv.data, cPv);
  };

  // ---- actions ----
  const applySingle = () => {
    if (!ready()) return;
    const gen = pv && pvKey === currentKey() ? pv : breedBatch(request('single', 1), parents())[0];
    model.addTables([gen], 'single', true);
    newSeed();
  };

  const applyBatch = () => {
    if (!ready() || genIdentical()) return;
    model.addTables(breedBatch(request(mode, opts.count()), parents()), 'batch', false);
    newSeed();
  };

  // ---- subscriptions ----
  model.on('parents', renderCards);
  model.on('voices', renderVoices);
  model.on('batchTargets', renderVoices);
  model.on('selection', syncButtons);
  model.on('timeline', () => (dirtyThumbs = dirty = true));
  onThemeChange(() => (dirtyThumbs = dirty = true));
  new ResizeObserver(() => (dirtyThumbs = dirty = true)).observe(el);

  renderVoices();
  renderCards();
  updateSteps();
  newSeed();

  return {
    el,
    view: {
      frame(now) {
        if (!opts.active()) return;
        if (dirtyThumbs && thumbs.length) {
          dirtyThumbs = false;
          drawThumbs();
        }
        if (!isOnScreen(pvWave)) return;
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
