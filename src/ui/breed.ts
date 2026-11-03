import {
  breed,
  breedBatchTable,
  breedBiasAt,
  breedWeights,
  BREED_OPS,
  isSeededOp,
  MAX_PARENTS,
  mutationAmount,
  type BiasWalk,
  type BreedMode,
  type BreedRequest,
} from '../core/breed';
import { randomSeed } from '../core/prng';
import { describeRecipe, type GeneratedTable, type TableId, type WaveTable } from '../core/table';
import { buildStepper, buildStrip, drawCard, flasher, SPEC_BINS } from './batch';
import { cssColor, drawSpectrum, drawWave, fit, fitFixed, onThemeChange } from './canvas';
import { isOnScreen, watchVisibility, type FrameView, type UiContext } from './context';
import { h, icon, ICONS } from './dom';
import { buildLibrary } from './library';

/** Minimum interval between preview restarts while a control is dragged. */
const PREVIEW_MS = 50;
/** Minimum interval between library thumbnail restarts (parents / bias / walk / seed changes). */
const THUMBS_MS = 150;
/** Main-thread time per frame spent computing preview children and thumbnails. */
const BUDGET_MS = 8;
const THUMB_W = 44;
const THUMB_H = 18;
const CHIP_W = 26;
const CHIP_H = 16;
/** Pointer travel (px) before a press on a parent chip becomes a drag. */
const DRAG_SLOP = 4;
const DEFAULT_OP = 'mix';
/** "Use window" icon: a bracketed span. */
const WINDOW_ICON = 'M8 5H4v14h4M16 5h4v14h-4M8 12h8';

type BatchMode = Exclude<BreedMode, 'single'>;

const MODES: { mode: BatchMode; label: string; title: string }[] = [
  { mode: 'sweep', label: 'Sweep', title: 'Sweep: child i of N uses bias B·i/N (the last is B), one seed' },
  { mode: 'gen', label: 'Generation', title: 'Generation: N children at bias B, each with its own seed' },
];
const WALKS: { walk: BiasWalk; label: string; title: string }[] = [
  { walk: 'path', label: 'Path', title: 'Bias walks A → B → C → … → the last parent' },
  { walk: 'ring', label: 'Ring', title: 'Bias walks A → B → … → the last parent → back to A' },
  { walk: 'weights', label: 'Custom', title: 'Bias moves from A alone to your per-parent weights (sliders on the parent chips)' },
];

export interface BreedPanelOpts {
  /** Shared batch size N (also used by Seed / Mutate). */
  count(): number;
  setCount(n: number): void;
  onCount(fn: (n: number) => void): void;
  /** True while the Generate section is open and the Breed tab is showing. */
  active(): boolean;
}

export const parentLetter = (i: number) => String.fromCharCode(65 + i);
/** Parent colour CSS variable (`--par-0`…`--par-7`; palette in styles.css). */
const parentVar = (i: number) => `--par-${i % MAX_PARENTS}`;
interface BreedPrefs {
  op: string;
  bias: number;
  walk: BiasWalk;
  rate: number;
  mode: BatchMode;
}

/** Saved Breed prefs, or null if anything is off (unknown operator, out-of-range values). */
function parsePrefs(p: Record<string, unknown>): BreedPrefs | null {
  const num = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null);
  const bias = num(p.bias, 1);
  const rate = num(p.rate, 0.5);
  const op = BREED_OPS.some((o) => o.id === p.op) ? String(p.op) : null;
  const walk = p.walk === 'path' || p.walk === 'ring' || p.walk === 'weights' ? p.walk : null;
  const mode = p.mode === 'sweep' || p.mode === 'gen' ? p.mode : null;
  return bias === null || rate === null || !op || !walk || !mode ? null : { op, bias, walk, rate, mode };
}

const hex = (s: number) => (s >>> 0).toString(16).padStart(8, '0');
const pct = (v: number) => {
  const p = v * 100;
  return `${p < 10 && p > 0 ? p.toFixed(1) : Math.round(p)}%`;
};
const pctN = (v: number) => {
  const p = v * 100;
  return p < 10 && p > 0 ? p.toFixed(1) : String(Math.round(p));
};

/** A preview batch being computed incrementally in the frame loop. */
interface Job {
  key: string;
  req: BreedRequest;
  parents: WaveTable[];
  tables: (GeneratedTable | undefined)[];
  next: number;
}

/**
 * Generate → Breed: operator library (search, ▲/▼, thumbnails of each operator applied to
 * the parents at the current bias), parent chips + parameters, the shown child large over
 * the parents, and the batch strip. Parents live in the model (AppModel.breedParents) so
 * the Timeline can toggle them; evicted parents drop out there. Preview children are
 * computed in the frame loop (only while the tab is visible, restarted at most every
 * PREVIEW_MS, BUDGET_MS per frame) through the same breedBatchTable() as Add, with the same
 * seed / bias / walk / mode / N, so Add appends exactly what is shown. Add shown / Add +N
 * select the last waveform added.
 */
export function buildBreedPanel(ctx: UiContext, opts: BreedPanelOpts): { el: HTMLElement; view: FrameView } {
  const { model } = ctx;

  // ---- state ----
  let sel = Math.max(
    0,
    BREED_OPS.findIndex((o) => o.id === DEFAULT_OP),
  );
  let bias = 0.5;
  let walk: BiasWalk = 'path';
  let rate = 0.05;
  let mode: BatchMode = 'sweep';
  let seed = randomSeed();
  let windowVoiceId: number | null = null;
  /** Custom weights by table id (walk 'weights'); default 1. */
  const weights = new Map<TableId, number>();

  // Operator and parameters are saved with the session (UI prefs); parents live in the model.
  const PREF = 'breed';
  const prefNow = (): BreedPrefs => ({ op: BREED_OPS[sel].id, bias, walk, rate, mode });
  const savedPrefs = (): BreedPrefs | null => {
    const p = ctx.ui.pref<unknown>(PREF, null, (v) => typeof v === 'object' && v !== null);
    return p ? parsePrefs(p as Record<string, unknown>) : null;
  };
  let applying = false;
  const savePrefs = () => {
    if (applying) return;
    const now = prefNow();
    const old = savedPrefs();
    if (!old || (Object.keys(now) as (keyof BreedPrefs)[]).some((k) => now[k] !== old[k])) ctx.ui.setPref(PREF, now);
  };
  const initial = savedPrefs();
  if (initial) {
    sel = BREED_OPS.findIndex((o) => o.id === initial.op);
    bias = initial.bias;
    walk = initial.walk;
    rate = initial.rate;
    mode = initial.mode;
  }

  const info = () => BREED_OPS[sel];
  const parents = (): WaveTable[] => model.breedParents.map((id) => model.table(id)).filter((t): t is WaveTable => !!t);
  const weightList = () => model.breedParents.map((id) => weights.get(id) ?? 1);
  const ready = () => model.breedParents.length >= 2;
  /** The result depends on the seed: a seeded operator, or mutation (seeded jitter). */
  const usesSeed = () => isSeededOp(info().id) || rate > 0;
  const request = (): BreedRequest => ({
    op: info().id,
    bias,
    walk,
    weights: walk === 'weights' ? weightList() : undefined,
    rate,
    seed,
    mode,
    count: opts.count(),
  });
  const keyOf = (ids: readonly TableId[], r: BreedRequest) =>
    `${ids.join(',')}|${r.op}|${r.bias}|${r.walk}|${r.weights?.join(',') ?? ''}|${r.rate}|${r.seed}|${r.mode}|${r.count}`;

  /**
   * Why Add +N would only add copies, or null. A sweep at bias 0 is N copies of A. A
   * generation is N identical children when there's no mutation (rate 0, or one parent
   * holding all the weight, e.g. bias 0 or a path stop on B) and either the operator
   * isn't seeded or a single parent wins every seeded pick.
   */
  const batchBlocked = (): string | null => {
    if (mode === 'sweep') return bias === 0 ? 'Bias 0: every child would be A' : null;
    const P = model.breedParents.length;
    if (P < 2) return null;
    const w = breedWeights(P, bias, walk, weightList());
    if (mutationAmount(rate, w) > 0) return null;
    if (Math.max(...w) >= 1 - 1e-9) return `${parentLetter(w.indexOf(Math.max(...w)))} holds all the weight: copies`;
    return isSeededOp(info().id) ? null : 'Identical children: pick a seeded operator or raise Mutation';
  };

  // Dirty flags (drawn in the frame loop).
  let mainDirty = true;
  let cardsDirty = true;
  let thumbsDirty = true;
  let chipsDirty = true;

  // ---- library ----
  const lib = buildLibrary({
    idPrefix: 'breed',
    title: 'Operators',
    placeholder: 'Search name, group, hint',
    items: BREED_OPS.map((o) => ({
      id: o.id,
      group: o.group,
      name: o.label,
      tag: o.seeded ? 'rnd' : undefined,
      tagTitle: 'Uses the seed',
      search: `${o.label}\n${o.group}\n${o.hint}`,
    })),
    initial: sel,
    onChange: (i) => {
      sel = i;
      flash('');
      syncParams();
      mainDirty = cardsDirty = thumbsDirty = true;
    },
    onThumbs: () => (thumbsDirty = true),
  });
  // Each entry's hint as its tooltip.
  lib.thumbs.forEach((c, i) => c.parentElement?.setAttribute('title', `${BREED_OPS[i].hint} · bias 0 = A`));

  // ---- parents ----
  const chips = h('div', { id: 'breed-parents', class: 'br-chips', role: 'list', 'aria-label': 'Parents (drag, or ← / → on a chip, to reorder)' });
  const addSel = h(
    'button',
    {
      id: 'breed-add-selected',
      'aria-label': 'Add selected',
      title: 'Add selected: the waveform selected in the Timeline becomes the next parent',
      onclick: () => addSelected(),
    },
    icon(ICONS.plus),
  );
  const winSel = h('select', { id: 'breed-window-voice', 'aria-label': 'Voice whose window to use as parents' });
  winSel.addEventListener('change', () => (windowVoiceId = Number(winSel.value)));
  const useWin = h(
    'button',
    {
      id: 'breed-use-window',
      'aria-label': 'Use window of the chosen voice',
      title: 'Use window of the chosen voice: parents = the waveforms in its window (up to 8, evenly spaced)',
      onclick: () => useWindow(),
    },
    icon(WINDOW_ICON),
  );
  const clear = h('button', { id: 'breed-clear', class: 'br-clear', title: 'Remove every parent', onclick: () => model.setBreedParents([]) }, 'Clear');
  const parentsRow = h(
    'div',
    { class: 'br-parents' },
    h('span', { class: 'br-parents-h' }, 'Parents'),
    chips,
    h('div', { class: 'seg br-parent-acts', role: 'group', 'aria-label': 'Add parents' }, addSel, useWin, winSel),
  );

  // ---- parameters ----
  const title = h('span', { class: 'br-name', id: 'breed-title' });
  const biasVal = h('span', { class: 'mut-amount-val', id: 'breed-bias-val' });
  const biasInput = h('input', { type: 'range', id: 'breed-bias', min: 0, max: 1, step: 0.01, value: bias, 'aria-label': 'Bias (0 = parent A)' });
  biasInput.addEventListener('input', () => {
    bias = Number(biasInput.value);
    syncValues();
  });
  const rateVal = h('span', { class: 'mut-amount-val', id: 'breed-rate-val' });
  const rateInput = h('input', { type: 'range', id: 'breed-rate', min: 0, max: 0.5, step: 0.01, value: rate, 'aria-label': 'Mutation rate' });
  rateInput.addEventListener('input', () => {
    rate = Number(rateInput.value);
    syncParams();
    syncValues();
  });
  const walkButtons = WALKS.map((x) => h('button', { id: `breed-walk-${x.walk}`, title: x.title, onclick: () => setWalk(x.walk) }, x.label));
  const seedLabel = h('span', { id: 'breed-seed', class: 'mono-label', title: 'Shared by the preview, every card and Add' });
  const rerollBtn = h('button', { id: 'breed-reroll', class: 'small', 'aria-label': 'Reroll the seed', onclick: () => newSeed() }, 'Reroll');
  const seedBox = h(
    'div',
    { class: 'gen-seedbox', id: 'breed-seedbox' },
    h('span', {}, 'Seed'),
    seedLabel,
    rerollBtn,
  );
  const params = h(
    'div',
    { class: 'br-params' },
    h('label', { class: 'mut-amount br-bias', title: 'Bias: 0 = parent A, then along the walk' }, h('span', {}, 'Bias'), biasInput, biasVal),
    h('div', { class: 'seg br-walk', role: 'group', 'aria-label': 'Bias walk' }, ...walkButtons),
    h(
      'label',
      { class: 'mut-amount br-rate', title: 'Seeded jitter, strongest between parents (none at a pure parent)' },
      h('span', {}, 'Mutation'),
      rateInput,
      rateVal,
    ),
    seedBox,
  );

  const syncParams = () => {
    const o = info();
    title.textContent = `${o.group} › ${o.label}`;
    title.title = `${o.hint} · bias 0 = A`;
    // Keeps its space when Mutation drops to 0 (visibility), so the params row doesn't re-wrap.
    seedBox.classList.toggle('seed-off', !usesSeed());
    syncGuards();
    savePrefs();
  };

  const syncValues = () => {
    biasVal.textContent = pct(bias);
    rateVal.textContent = pct(rate);
    relabelCards();
    syncShownLabel();
    syncGuards();
    savePrefs();
    mainDirty = true;
  };

  const setWalk = (w: BiasWalk) => {
    walk = w;
    WALKS.forEach((x, i) => {
      walkButtons[i].classList.toggle('seg-on', x.walk === w);
      walkButtons[i].setAttribute('aria-pressed', String(x.walk === w));
    });
    chips.classList.toggle('show-weights', w === 'weights');
    syncGuards();
    savePrefs();
    syncShownLabel();
    mainDirty = true;
  };

  // ---- result over parents ----
  const shownLabel = h('span', { class: 'mono-label', id: 'breed-shown' });
  const weightsLabel = h('span', { class: 'mono-label br-weights', id: 'breed-weights' });
  const legend = h('span', { class: 'mut-legend br-legend', 'aria-hidden': 'true' });
  const waveC = h('canvas', { id: 'breed-wave', role: 'img', 'aria-label': 'Shown child (solid) over the parents (faint, in their colours)' });
  const specC = h('canvas', { id: 'breed-spec', role: 'img', 'aria-label': 'Harmonic spectrum of the shown child over parent A (grey)' });
  const axis = (...labels: string[]) => h('div', { class: 'gen-axis' }, ...labels.map((l) => h('span', {}, l)));
  // Labels sit in the axis row under the waveform (not over it): operator (hint in its
  // tooltip), shown child, weights; the parents' legend on the right.
  const waveBox = h('div', { class: 'gen-plot-box' }, waveC);
  const tagRow = h('div', { class: 'gen-axis br-tagrow' }, h('span', { class: 'br-tags-left' }, title, shownLabel, weightsLabel), legend);
  const specBox = h('div', { class: 'gen-plot-box' }, specC);
  const viewer = h(
    'div',
    { class: 'gen-viewer' },
    h(
      'div',
      { class: 'gen-views' },
      h('div', { class: 'gen-plot gen-plot-wave' }, waveBox, tagRow),
      h('div', { class: 'gen-plot gen-plot-spec' }, specBox, axis('h1', 'grey = A', `h${SPEC_BINS}`)),
    ),
  );

  // ---- batch ----
  const modeButtons = MODES.map((m) => h('button', { id: `breed-mode-${m.mode}`, title: m.title, onclick: () => setMode(m.mode) }, m.label));
  const stepper = buildStepper('breed', opts);
  const addShownBtn = h('button', { id: 'breed-add-shown', onclick: () => addShown() }, 'Add shown');
  const addBatchBtn = h('button', { id: 'breed-add-batch', class: 'primary', onclick: () => addBatch() }, `Add +${opts.count()}`);
  const status = h('div', { class: 'gen-status', id: 'breed-status', role: 'status' });
  const blockedNote = h('div', { class: 'gen-status warn', id: 'breed-blocked' });
  const flash = flasher(status);
  const strip = buildStrip('breed-strip', {
    onShow: () => {
      mainDirty = true;
      syncShownLabel();
    },
  });
  const batchBox = h(
    'div',
    { class: 'gen-box gen-batch' },
    h(
      'div',
      { class: 'gen-batch-head' },
      h('span', { class: 'gen-h' }, 'Batch'),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Batch mode' }, ...modeButtons),
      stepper.el,
      status,
      blockedNote,
      h('div', { class: 'gen-adds' }, addShownBtn, addBatchBtn),
    ),
    strip.el,
  );

  const setMode = (m: BatchMode) => {
    mode = m;
    MODES.forEach((x, i) => {
      modeButtons[i].classList.toggle('seg-on', x.mode === m);
      modeButtons[i].setAttribute('aria-pressed', String(x.mode === m));
    });
    flash('');
    relabelCards();
    syncShownLabel();
    syncGuards();
    savePrefs();
  };

  const cardLabel = (i: number) => (mode === 'gen' ? `child ${i + 1}` : `b ${pct(breedBiasAt(request(), i))}`);
  const relabelCards = () => strip.resize(opts.count(), cardLabel);

  const syncShownLabel = () => {
    const n = opts.count();
    const i = strip.shown();
    const b = breedBiasAt(request(), i);
    shownLabel.textContent = mode === 'gen' ? `child ${i + 1} of ${n} · bias ${pct(b)}` : `#${i + 1} of ${n} · bias ${pct(b)}`;
    tagRow.title = `${title.textContent} · ${shownLabel.textContent}`;
    const P = model.breedParents.length;
    weightsLabel.textContent = P >= 2 ? breedWeights(P, b, walk, weightList()).map((v, k) => `${parentLetter(k)} ${pctN(v)}`).join(' · ') : '';
  };

  /** Add buttons (need two parents; Add +N refuses batches of copies) and Add selected. */
  const syncGuards = () => {
    const blocked = ready() ? batchBlocked() : null;
    // Timeline full (every waveform used by a wavetable): adds are refused.
    const room1 = model.roomFor(1);
    const roomN = model.roomFor(opts.count());
    const full = model.fullMessage();
    addShownBtn.disabled = !ready() || !room1;
    addBatchBtn.disabled = !ready() || blocked !== null || !roomN;
    addShownBtn.title = !ready() ? 'Needs at least two parents' : room1 ? '' : full;
    addBatchBtn.title = !ready() ? 'Needs at least two parents' : !roomN ? full : (blocked ?? '');
    blockedNote.textContent = ready() && !roomN ? full : (blocked ?? '');
    const s = model.selectedId;
    addSel.disabled = s === null || model.breedParents.includes(s) || model.breedParents.length >= MAX_PARENTS;
  };

  const newSeed = () => {
    seed = randomSeed();
    seedLabel.textContent = hex(seed);
    rerollBtn.title = `Seed ${hex(seed)}: shared by the preview, every card and Add. Reroll draws a new one.`;
  };

  // ---- parent actions ----
  const addSelected = () => {
    if (model.selectedId !== null && !model.breedParents.includes(model.selectedId)) model.toggleBreedParent(model.selectedId);
  };

  /** Parents = the voice's window (evenly spaced picks if it holds more than MAX_PARENTS). */
  const useWindow = () => {
    const v = windowVoiceId === null ? undefined : model.voice(windowVoiceId);
    if (!v) return;
    const win = model.windowTables(v);
    const len = win.length;
    const n = Math.min(len, MAX_PARENTS);
    const ids: TableId[] = [];
    for (let i = 0; i < n; i++) ids.push(win[n > 1 ? Math.round((i * (len - 1)) / (n - 1)) : 0].id);
    model.setBreedParents(ids);
  };

  /** Rebuild voice options only when the voice list or names change (keeps an open dropdown open). */
  let voiceSig = '';
  const renderVoices = () => {
    const vs = model.voices;
    if (windowVoiceId === null || !vs.some((v) => v.id === windowVoiceId)) windowVoiceId = vs[0]?.id ?? null;
    const sig = vs.map((v) => `${v.id}:${v.name}`).join('|');
    if (sig !== voiceSig) {
      voiceSig = sig;
      winSel.replaceChildren(...vs.map((v) => h('option', { value: String(v.id) }, v.name)));
    }
    if (windowVoiceId !== null && winSel.value !== String(windowVoiceId)) winSel.value = String(windowVoiceId);
    winSel.disabled = useWin.disabled = !vs.length;
  };

  // ---- parent chips ----
  /** Chip to focus after a keyboard move / remove re-renders the row. */
  let focusId: TableId | null = null;
  let chipEls: { id: TableId; el: HTMLElement; canvas: HTMLCanvasElement; no: HTMLElement }[] = [];
  const renderChips = () => {
    const ids = model.breedParents;
    for (const id of [...weights.keys()]) if (!ids.includes(id)) weights.delete(id);
    chipEls = ids.map((id, i) => {
      const L = parentLetter(i);
      const canvas = h('canvas', { class: 'br-chip-wave', 'aria-hidden': 'true' });
      const no = h('span', { class: 'br-chip-no' });
      const weight = h('input', {
        type: 'range',
        class: 'br-chip-weight',
        min: 0,
        max: 1,
        step: 0.01,
        value: weights.get(id) ?? 1,
        'aria-label': `Weight ${L}`,
      });
      weight.addEventListener('input', () => {
        weights.set(id, Number(weight.value));
        weight.title = `Weight ${L}: ${pctN(Number(weight.value))}`;
        syncShownLabel();
        syncGuards();
        mainDirty = true;
      });
      weight.title = `Weight ${L}: ${pctN(weights.get(id) ?? 1)}`;
      const el = h(
        'div',
        {
          class: `br-chip${id === dragId && dragging ? ' dragging' : ''}`,
          role: 'listitem',
          tabindex: 0,
          'data-id': String(id),
          'aria-label': `Parent ${L}`,
          'aria-description': 'Drag, or ← / → to reorder; Delete removes',
          style: `--pc: var(${parentVar(i)})`,
        },
        h(
          'div',
          { class: 'br-chip-row' },
          h('span', { class: 'br-letter' }, L),
          canvas,
          no,
          h('button', { class: 'br-x', tabindex: -1, 'aria-label': `Remove parent ${L}`, onclick: () => model.toggleBreedParent(id) }, '×'),
        ),
        weight,
      );
      el.addEventListener('keydown', (e) => {
        if (e.target !== el || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        const d = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
        if (d) {
          e.preventDefault();
          focusId = id;
          model.moveBreedParent(id, d);
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          const ids = model.breedParents;
          const k = ids.indexOf(id);
          focusId = ids[k + 1] ?? ids[k - 1] ?? null;
          model.toggleBreedParent(id);
        }
      });
      return { id, el, canvas, no };
    });
    chips.replaceChildren(
      ...(chipEls.length
        ? [...chipEls.map((c) => c.el), clear]
        : [h('span', { class: 'br-empty' }, `Add 2–${MAX_PARENTS}: Shift-click or long-press waveforms in the Timeline, or Add selected`)]),
    );
    if (focusId !== null) {
      chipEls.find((c) => c.id === focusId)?.el.focus();
      focusId = null;
    }
    legend.replaceChildren(
      ...ids.map((_, i) => h('span', { class: 'br-key', style: `--pc: var(${parentVar(i)})` }, parentLetter(i))),
      h('span', {}, h('i', { class: 'mut-key-res' }), 'child'),
    );
    chipsDirty = mainDirty = cardsDirty = thumbsDirty = true;
    syncShownLabel();
    syncGuards();
  };

  const drawChips = () => {
    chipsDirty = false;
    const c = cssColor('--wave');
    for (const t of chipEls) {
      const tab = model.table(t.id);
      const g = fitFixed(t.canvas, CHIP_W, CHIP_H);
      if (!tab) continue;
      const idx = model.indexOf(t.id);
      t.no.textContent = `#${idx + 1}`;
      t.el.title = `#${idx + 1} · id ${t.id} · ${describeRecipe(tab.recipe)}`;
      drawWave(g, 0, 0, CHIP_W, CHIP_H, tab.data, c, { lineWidth: 1.1, points: CHIP_W * 2 });
    }
  };

  // Drag to reorder (touch too: chips are touch-action pan-y, so a horizontal drag reorders
  // and a vertical one scrolls the page). The pointer is captured by the row, which
  // survives the chips being re-rendered.
  let dragId: TableId | null = null;
  let dragging = false;
  let dragX = 0;
  chips.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const chip = (e.target as HTMLElement).closest<HTMLElement>('.br-chip');
    if (!chip || (e.target as HTMLElement).closest('button, input')) return;
    dragId = Number(chip.dataset.id);
    dragging = false;
    dragX = e.clientX;
    chips.setPointerCapture(e.pointerId);
  });
  chips.addEventListener('pointermove', (e) => {
    if (dragId === null) return;
    if (!dragging) {
      if (Math.abs(e.clientX - dragX) < DRAG_SLOP) return;
      dragging = true;
      chips.classList.add('dragging');
      chipEls.find((c) => c.id === dragId)?.el.classList.add('dragging');
    }
    // Target slot: how many other chips the pointer is past, in reading order (chips wrap
    // on a phone). Y is clamped to the chips' extent, so on one row only X counts.
    const first = chipEls[0].el.getBoundingClientRect();
    const last = chipEls[chipEls.length - 1].el.getBoundingClientRect();
    const y = Math.max(first.top, Math.min(last.bottom, e.clientY));
    let to = 0;
    for (const c of chipEls) {
      if (c.id === dragId) continue;
      const r = c.el.getBoundingClientRect();
      if (y > r.bottom || (y >= r.top && e.clientX > r.left + r.width / 2)) to++;
    }
    const from = model.breedParents.indexOf(dragId);
    if (from >= 0 && to !== from) model.moveBreedParent(dragId, to - from);
  });
  const endDrag = () => {
    if (dragId === null) return;
    dragId = null;
    dragging = false;
    chips.classList.remove('dragging');
    for (const c of chipEls) c.el.classList.remove('dragging');
  };
  chips.addEventListener('pointerup', endDrag);
  chips.addEventListener('pointercancel', endDrag);
  chips.addEventListener('lostpointercapture', endDrag);
  // A vertical wheel scrolls the chip row sideways.
  chips.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && chips.scrollWidth > chips.clientWidth) {
        chips.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    },
    { passive: false },
  );

  // ---- preview job ----
  let job: Job | null = null;
  let lastStart = -Infinity;

  const startJob = (): Job | null => {
    const ps = parents();
    const req = request();
    job = ps.length >= 2 ? { key: keyOf(model.breedParents, req), req, parents: ps, tables: new Array(req.count), next: 0 } : null;
    cardsDirty = mainDirty = true;
    return job;
  };

  /** The job for the current request (started synchronously if needed), or null. */
  const currentJob = (): Job | null => (ready() && job?.key === keyOf(model.breedParents, request()) ? job : startJob());

  const computeOne = (j: Job, i: number): GeneratedTable => {
    let t = j.tables[i];
    if (!t) {
      t = j.tables[i] = breedBatchTable(j.req, j.parents, i);
      cardsDirty = true;
      if (i === strip.shown()) mainDirty = true;
    }
    return t;
  };

  /** Shown child first, then the rest in order, within the frame budget. */
  const work = (j: Job, deadline: number) => {
    computeOne(j, Math.min(strip.shown(), j.req.count - 1));
    while (j.next < j.req.count && performance.now() < deadline) computeOne(j, j.next++);
  };

  /**
   * The child that is shown and added. A planned Edit layer (draw / edit harmonics) slots
   * in here, as in the Seed tab.
   */
  const finalTable = (j: Job, i: number): GeneratedTable => computeOne(j, i);

  // ---- actions ----
  const afterAdd = (msg: string) => {
    if (usesSeed()) {
      newSeed();
      flash(`${msg} · new seed`);
    } else flash(msg);
  };

  const addShown = () => {
    const j = currentJob();
    if (!j) return;
    const i = strip.shown();
    if (!model.addTables([finalTable(j, i)], true).length) return; // refused (Timeline full): the notice says why
    afterAdd(`Added ${mode === 'gen' ? `child ${i + 1}` : `#${i + 1}`} to the Timeline (selected)`);
  };

  const addBatch = () => {
    if (batchBlocked()) return;
    const j = currentJob();
    if (!j) return;
    const tables = Array.from({ length: j.req.count }, (_, i) => finalTable(j, i));
    if (!model.addTables(tables, true).length) return; // refused: keep the seed
    afterAdd(`Added ${tables.length} waveform${tables.length > 1 ? 's' : ''} to the Timeline (the last is selected)`);
  };

  // ---- drawing ----
  // Until a restarted preview has produced the shown child, the last good frame stays
  // drawn (no flicker). Fewer than two parents clears the views.
  const drawMain = () => {
    mainDirty = false;
    const ps = parents();
    const cur = job && ready() && job.parents.length === ps.length && job.parents.every((p, i) => p === ps[i]) ? job : null;
    const t = cur?.tables[Math.min(strip.shown(), cur.req.count - 1)];
    if (ready() && !t) return; // redrawn when computeOne() produces the shown child
    const data = t?.data;
    const grid = cssColor('--surface-2');
    const [g, w, hh] = fit(waveC, Math.max(40, waveBox.clientHeight || 150));
    g.strokeStyle = grid;
    g.lineWidth = 1;
    g.beginPath();
    for (const f of [0.25, 0.5, 0.75]) {
      g.moveTo(Math.round(w * f) + 0.5, 0);
      g.lineTo(Math.round(w * f) + 0.5, hh);
    }
    g.stroke();
    g.strokeStyle = cssColor('--border');
    g.beginPath();
    g.moveTo(0, Math.round(hh / 2) + 0.5);
    g.lineTo(w, Math.round(hh / 2) + 0.5);
    g.stroke();
    g.globalAlpha = 0.6;
    ps.forEach((p, i) => drawWave(g, 0, 0, w, hh, p.data, cssColor(parentVar(i)), { lineWidth: 1.25 }));
    g.globalAlpha = 1;
    if (data) drawWave(g, 0, 0, w, hh, data, cssColor('--wave'), { lineWidth: 2 });
    else {
      g.fillStyle = cssColor('--text-2');
      g.font = '12px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(ps.length ? 'Add at least two parents' : 'No parents yet', w / 2, hh / 2 + 14);
    }
    const [gs, sw, sh] = fit(specC, Math.max(30, specBox.clientHeight || 90));
    gs.strokeStyle = grid;
    gs.beginPath();
    for (const f of [1 / 3, 2 / 3]) {
      gs.moveTo(0, Math.round(sh * f) + 0.5);
      gs.lineTo(sw, Math.round(sh * f) + 0.5);
    }
    gs.stroke();
    if (ps[0]) drawSpectrum(gs, sw, sh, ps[0].data, cssColor('--border-strong'), { bins: SPEC_BINS });
    if (data) {
      gs.globalAlpha = 0.85;
      drawSpectrum(gs, sw, sh, data, cssColor('--accent'), { bins: SPEC_BINS });
      gs.globalAlpha = 1;
    }
  };

  const drawCards = () => {
    cardsDirty = false;
    const cur = ready() && job?.key === keyOf(model.breedParents, request()) ? job : null;
    strip.cards.forEach((c, i) => {
      const t = cur && i < cur.req.count ? cur.tables[i] : undefined;
      // Keep the previous drawing until the current job has computed this card.
      if (c.drawn === t || (!t && ready())) return;
      c.drawn = t;
      drawCard(c, t?.data);
    });
  };

  // Library thumbnails: each operator applied to the parents at the current bias / walk /
  // mutation / seed (= the last sweep card) over a faint parent A. Restarted at most every
  // THUMBS_MS; only entries scrolled into view, within the frame budget; old drawings stay
  // until replaced.
  const thumbDrawn: string[] = BREED_OPS.map(() => '');
  let thumbTarget = '';
  let thumbTargetAt = -Infinity;
  const thumbKey = () => `${model.breedParents.join(',')}|${bias}|${walk}|${walk === 'weights' ? weightList().join(',') : ''}|${rate}|${seed}`;
  let thumbParams: { ps: WaveTable[]; bias: number; walk: BiasWalk; weights?: number[]; rate: number; seed: number } | null = null;
  const drawThumbs = (now: number, deadline: number) => {
    const target = thumbKey();
    if (target !== thumbTarget) {
      if (now - thumbTargetAt < THUMBS_MS) return; // stay dirty; retried next frame
      thumbTarget = target;
      thumbTargetAt = now;
      const ps = parents();
      thumbParams = ps.length >= 2 ? { ps, bias, walk, weights: walk === 'weights' ? weightList() : undefined, rate, seed } : null;
    }
    const tp = thumbParams;
    const normal = cssColor('--text-2');
    const current = cssColor('--accent-text');
    const ghost = cssColor('--border-strong');
    let pending = false;
    for (const i of lib.inView()) {
      const color = i === sel ? current : normal;
      const want = `${thumbTarget}|${color}`;
      if (thumbDrawn[i] === want) continue;
      if (performance.now() > deadline) {
        pending = true;
        break;
      }
      const g = fitFixed(lib.thumbs[i], THUMB_W, THUMB_H);
      if (tp) {
        drawWave(g, 0, 0, THUMB_W, THUMB_H, tp.ps[0].data, ghost, { lineWidth: 1, points: THUMB_W * 2 });
        const out = breed(
          tp.ps.map((p) => p.data),
          { op: BREED_OPS[i].id, bias: tp.bias, walk: tp.walk, weights: tp.weights, rate: tp.rate, seed: tp.seed },
        );
        drawWave(g, 0, 0, THUMB_W, THUMB_H, out, color, { lineWidth: 1.2, points: THUMB_W * 2 });
      }
      thumbDrawn[i] = want;
    }
    thumbsDirty = pending || thumbTarget !== target;
  };

  // ---- assembly ----
  const el = h(
    'div',
    { role: 'tabpanel', id: 'panel-breed', class: 'gen-tab breed' },
    lib.el,
    h('div', { class: 'gen-main' }, parentsRow, params, viewer, batchBox),
  );
  watchVisibility(el);

  opts.onCount((n) => {
    const atEnd = strip.shown() >= strip.cards.length - 1;
    stepper.sync(n);
    addBatchBtn.textContent = `Add +${n}`;
    syncGuards();
    relabelCards();
    if (atEnd) strip.setShown(n - 1);
    syncShownLabel();
    cardsDirty = mainDirty = true;
    flash('');
  });
  model.on('parents', renderChips);
  model.on('voices', renderVoices);
  model.on('selection', syncGuards);
  model.on('timeline', () => {
    chipsDirty = mainDirty = true;
    syncGuards();
  });
  model.on('wavetables', syncGuards);
  onThemeChange(() => {
    thumbDrawn.fill('');
    for (const c of strip.cards) c.drawn = null;
    thumbsDirty = cardsDirty = mainDirty = chipsDirty = true;
  });
  new ResizeObserver(() => (mainDirty = true)).observe(viewer);

  /** Apply saved prefs (a restored / imported session). */
  const applyPrefs = (p: BreedPrefs) => {
    applying = true;
    const i = BREED_OPS.findIndex((o) => o.id === p.op);
    if (i !== sel) lib.select(i);
    bias = p.bias;
    rate = p.rate;
    biasInput.value = String(bias);
    rateInput.value = String(rate);
    setWalk(p.walk);
    setMode(p.mode);
    applying = false;
    syncParams();
    syncValues();
  };
  ctx.ui.onPrefs(() => {
    const p = savedPrefs();
    const now = prefNow();
    if (p && (Object.keys(now) as (keyof BreedPrefs)[]).some((k) => now[k] !== p[k])) applyPrefs(p);
  });

  setMode(mode);
  setWalk(walk);
  strip.setShown(opts.count() - 1);
  newSeed();
  renderVoices();
  renderChips();
  syncParams();
  syncValues();

  return {
    el,
    view: {
      frame(now) {
        if (!opts.active() || !isOnScreen(el)) return;
        const deadline = performance.now() + BUDGET_MS;
        const key = keyOf(model.breedParents, request());
        if (ready() && job?.key !== key && now - lastStart >= PREVIEW_MS) {
          lastStart = now;
          startJob();
        } else if (!ready() && job) {
          job = null;
          mainDirty = cardsDirty = true;
        }
        if (job?.key === key) work(job, deadline);
        if (chipsDirty) drawChips();
        if (mainDirty) drawMain();
        if (cardsDirty) drawCards();
        if (thumbsDirty || thumbKey() !== thumbTarget) drawThumbs(now, deadline + 4);
      },
    },
  };
}
