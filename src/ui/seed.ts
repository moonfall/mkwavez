import type { AppModel } from '../app/model';
import { compileFormula } from '../browser/formulaEval';
import {
  batchU,
  FormulaAborted,
  SEED_LIBRARY,
  seedParams,
  seedTable,
  seedUsesRandomness,
  type FormulaFn,
  type SeedEntry,
  type SeedRequest,
} from '../core/generators';
import { randomSeed } from '../core/prng';
import type { GeneratedTable } from '../core/table';
import { cssColor, drawSpectrum, drawWave, fit, fitFixed, onThemeChange } from './canvas';
import { isOnScreen, watchVisibility, type FrameView, type UiContext } from './context';
import { h, icon, selectField, slider, voiceColorVar } from './dom';

/** Largest batch (N) any Generate tab makes. */
export const MAX_BATCH = 64;
/** Minimum interval between preview restarts while typing / dragging. */
const PREVIEW_MS = 50;
/** Main-thread time per frame spent computing preview tables and thumbnails. */
const BUDGET_MS = 8;
/** Formula edits restart the preview only after this long without typing. */
const TYPING_MS = 300;
/** A formula table taking longer than this is aborted (runaway expression). */
const TABLE_CAP_MS = 150;
const THUMB_W = 44;
const THUMB_H = 18;
const CARD_W = 84;
const CARD_WAVE_H = 30;
const CARD_SPEC_H = 14;
const SPEC_BINS = 64;
/** Library thumbnails: default params, middle of a 3-table batch (u = 0.5), fixed seed. */
const THUMB_SEED = 1;
const NARROW = '(max-width: 719px)';
const DEFAULT_ENTRY = 'chebyshev';
const CUSTOM_ENTRY = 'blank-formula';

const UP = 'M6 15l6-6 6 6';
const DOWN = 'M6 9l6 6 6-6';

export interface SeedPanelOpts {
  /** Shared batch size N (also used by Mutate / Breed). */
  count(): number;
  setCount(n: number): void;
  onCount(fn: (n: number) => void): void;
  /** True while the Generate section is open and the Seed tab is showing. */
  active(): boolean;
}

const hex = (s: number) => (s >>> 0).toString(16).padStart(8, '0');
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const tagOf = (e: SeedEntry) => (e.mode === 'formula' ? 'f(x)' : e.mode === 'basic' ? 'basic' : 'params');

/** "Sets window of" checkboxes, one per voice, in voice colours. */
export function voiceTargetChecks(model: AppModel): HTMLElement {
  const checks = h('div', { class: 'checks' });
  const render = () => {
    checks.replaceChildren(
      ...model.voices.map((v) => {
        const cb = h('input', { type: 'checkbox', checked: model.batchTargets.has(v.id) });
        cb.addEventListener('change', () => model.setBatchTarget(v.id, cb.checked));
        return h('label', { class: 'check', style: `color:var(${voiceColorVar(v.id - 1)})` }, cb, v.name);
      }),
    );
    if (!model.voices.length) checks.append(h('span', { class: 'hint' }, 'No voices'));
  };
  model.on('voices', render);
  model.on('batchTargets', render);
  render();
  return checks;
}

/** A preview batch being computed incrementally in the frame loop. */
interface Job {
  key: string;
  req: SeedRequest;
  fn?: FormulaFn;
  tables: (GeneratedTable | undefined)[];
  /** Per-table runtime errors (the other tables still compute). */
  errors: (string | undefined)[];
  next: number;
  /** Set when a table was aborted as too slow: the whole preview stops. */
  fatal: string;
}

/**
 * Generate → Seed: library (search, ▲/▼), formula or parameters, the shown table large,
 * and the batch strip. Preview tables are computed in the frame loop (only while the
 * tab is visible, restarted at most every PREVIEW_MS, BUDGET_MS per frame) through the
 * same seedTable() as Add, with the same seed / N, so Add appends exactly what is shown.
 */
export function buildSeedPanel(ctx: UiContext, opts: SeedPanelOpts): { el: HTMLElement; view: FrameView } {
  const { model } = ctx;
  const narrowMq = matchMedia(NARROW);

  // ---- state ----
  let sel = Math.max(
    0,
    SEED_LIBRARY.findIndex((e) => e.id === DEFAULT_ENTRY),
  );
  const edits = new Map<string, string>();
  const paramEdits = new Map<string, Record<string, number>>();
  let seed = randomSeed();
  let shown = 0;
  let filtered: number[] = SEED_LIBRARY.map((_, i) => i);
  let libOpen = false;

  const entry = () => SEED_LIBRARY[sel];
  const exprOf = (e: SeedEntry) => edits.get(e.id) ?? e.expr ?? '';
  const paramsOf = (e: SeedEntry) => seedParams(e, paramEdits.get(e.id));
  const request = (): SeedRequest => {
    const e = entry();
    return { entry: e, expr: exprOf(e), params: paramsOf(e), seed, count: opts.count() };
  };
  const keyOf = (r: SeedRequest) =>
    `${r.entry.id}|${r.entry.mode === 'formula' ? r.expr : JSON.stringify(r.params)}|${r.seed}|${r.count}`;

  let compiledExpr: string | null = null;
  let compiled: { fn?: FormulaFn; err?: string } = {};
  const compile = (expr: string) => {
    if (expr !== compiledExpr) {
      compiledExpr = expr;
      try {
        compiled = { fn: compileFormula(expr) };
      } catch (e) {
        compiled = { err: errText(e) };
      }
    }
    return compiled;
  };

  /** Last formula keystroke (the preview restarts TYPING_MS after it). */
  let lastTypedAt = -Infinity;

  // Dirty flags (drawn in the frame loop).
  let mainDirty = true;
  let cardsDirty = true;
  let thumbsDirty = true;
  let statusDirty = true;

  // ---- library ----
  const hay = SEED_LIBRARY.map((e) => `${e.name}\n${e.cat}\n${e.expr ?? ''}`.toLowerCase());
  const list = h('div', { id: 'seed-list', class: 'seed-list', role: 'group', 'aria-label': 'Presets and modes' });
  const entryButtons: HTMLButtonElement[] = [];
  const thumbs: HTMLCanvasElement[] = [];
  const thumbData: (Float32Array | undefined)[] = [];
  const thumbDrawn: string[] = [];
  const groupTitles = new Map<string, HTMLElement>();
  SEED_LIBRARY.forEach((e, i) => {
    if (!groupTitles.has(e.cat)) {
      const t = h('div', { class: 'seed-group' }, e.cat);
      groupTitles.set(e.cat, t);
      list.append(t);
    }
    const thumb = h('canvas', { class: 'seed-thumb', 'aria-hidden': 'true' });
    const b = h(
      'button',
      { class: 'seed-entry', 'data-id': e.id, tabindex: -1, onclick: () => pick(i) },
      h('span', { class: 'seed-entry-name' }, e.name),
      h('span', { class: 'seed-tag' }, tagOf(e)),
      thumb,
    );
    entryButtons.push(b);
    thumbs.push(thumb);
    thumbDrawn.push('');
    list.append(b);
  });
  const empty = h('p', { class: 'seed-empty', id: 'seed-empty', hidden: true });
  list.append(empty);

  const search = h('input', {
    type: 'search',
    id: 'seed-search',
    class: 'seed-search',
    placeholder: 'Search name, category, formula',
    'aria-label': 'Search the library',
    'aria-controls': 'seed-list',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: false,
  });
  const pos = h('span', { class: 'seed-pos', id: 'seed-pos' });
  const curCat = h('span', { class: 'seed-cur-cat' });
  const curName = h('span', { class: 'seed-cur-name' });
  const curPos = h('span', { class: 'seed-cur-pos' });
  const currentBtn = h(
    'button',
    {
      id: 'seed-current',
      class: 'seed-current',
      'aria-expanded': 'false',
      'aria-controls': 'seed-lib-body',
      onclick: () => setOpen(!libOpen),
    },
    curCat,
    curName,
    curPos,
  );
  const upBtn = h('button', { id: 'seed-up', class: 'seed-step', 'aria-label': 'Previous entry', onclick: () => stepSel(-1, false) }, icon(UP));
  const downBtn = h('button', { id: 'seed-down', class: 'seed-step', 'aria-label': 'Next entry', onclick: () => stepSel(1, false) }, icon(DOWN));
  const libBody = h('div', { class: 'seed-lib-body', id: 'seed-lib-body' }, h('div', { class: 'seed-search-wrap' }, search), list);
  const lib = h(
    'nav',
    { class: 'seed-lib', 'aria-label': 'Library' },
    h('div', { class: 'seed-lib-head' }, h('span', { class: 'seed-lib-title' }, 'Library'), pos, upBtn, currentBtn, downBtn),
    libBody,
  );

  const setOpen = (o: boolean) => {
    libOpen = o;
    lib.classList.toggle('open', o);
    currentBtn.setAttribute('aria-expanded', String(o));
    if (o) {
      thumbsDirty = true;
      requestAnimationFrame(() => scrollEntryIntoView(sel));
    }
  };

  const applyFilter = () => {
    const tokens = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    filtered = [];
    const catsShown = new Set<string>();
    SEED_LIBRARY.forEach((e, i) => {
      const m = tokens.every((t) => hay[i].includes(t));
      entryButtons[i].hidden = !m;
      if (m) {
        filtered.push(i);
        catsShown.add(e.cat);
      }
    });
    for (const [cat, t] of groupTitles) t.hidden = !catsShown.has(cat);
    empty.hidden = filtered.length > 0;
    empty.textContent = `No matches for “${search.value.trim()}”`;
    syncLibrary();
    scrollEntryIntoView(sel);
    thumbsDirty = true;
  };

  search.addEventListener('input', applyFilter);
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (!filtered.length) return;
      if (!filtered.includes(sel)) selectEntry(filtered[0], false);
      if (libOpen && narrowMq.matches) {
        setOpen(false);
        currentBtn.focus();
      }
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (filtered.length) selectEntry(filtered.includes(sel) ? sel : filtered[0], true);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      if (search.value) {
        search.value = '';
        applyFilter();
      } else if (libOpen) {
        setOpen(false);
        currentBtn.focus();
      }
    }
  });
  list.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      stepSel(ev.key === 'ArrowDown' ? 1 : -1, true);
    } else if ((ev.key === 'Home' || ev.key === 'End') && filtered.length) {
      ev.preventDefault();
      selectEntry(ev.key === 'Home' ? filtered[0] : filtered[filtered.length - 1], true);
    } else if (ev.key === 'Escape' && libOpen) {
      setOpen(false);
      currentBtn.focus();
    }
  });

  /** Step to the next / previous entry within the search results. */
  const stepSel = (d: number, focus: boolean) => {
    if (!filtered.length) return;
    const next =
      d > 0
        ? (filtered.find((i) => i > sel) ?? filtered[filtered.length - 1])
        : ([...filtered].reverse().find((i) => i < sel) ?? filtered[0]);
    selectEntry(next, focus);
  };

  const pick = (i: number) => {
    selectEntry(i, false);
    if (libOpen) {
      setOpen(false);
      if (narrowMq.matches) currentBtn.focus();
    }
  };

  const selectEntry = (i: number, focus: boolean) => {
    if (i !== sel) {
      thumbDrawn[sel] = thumbDrawn[i] = '';
      sel = i;
      setShown(0, false);
      flash('');
      renderEditor();
      thumbsDirty = mainDirty = cardsDirty = true;
      updateStatus();
    }
    syncLibrary();
    scrollEntryIntoView(i);
    if (focus) entryButtons[i].focus({ preventScroll: true });
  };

  /** aria-current, roving tabindex, position counter and the compact label. */
  const syncLibrary = () => {
    const k = filtered.indexOf(sel);
    const tabStop = k >= 0 ? sel : (filtered[0] ?? -1);
    entryButtons.forEach((b, i) => {
      b.setAttribute('aria-current', String(i === sel));
      b.tabIndex = i === tabStop ? 0 : -1;
    });
    const p = `${k >= 0 ? k + 1 : '–'} / ${filtered.length}`;
    pos.textContent = p;
    curPos.textContent = p;
    const e = entry();
    curCat.textContent = `${e.cat} ›`;
    curName.textContent = e.name;
    upBtn.disabled = !filtered.length || filtered[0] >= sel;
    downBtn.disabled = !filtered.length || filtered[filtered.length - 1] <= sel;
  };

  /** Scroll the list (only) so entry i is visible. */
  const scrollEntryIntoView = (i: number) => {
    const b = entryButtons[i];
    if (b.hidden || !list.clientHeight) return;
    const prev = b.previousElementSibling;
    const top = b.offsetTop - (prev?.classList.contains('seed-group') ? (prev as HTMLElement).offsetHeight + 6 : 4);
    const bottom = b.offsetTop + b.offsetHeight + 4;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  };

  // ---- formula / parameters ----
  const edKind = h('span', { class: 'seed-h', id: 'seed-kind' });
  const edPath = h('span', { class: 'seed-path', id: 'seed-title' });
  const editedBadge = h('span', { class: 'seed-badge', id: 'seed-edited', hidden: true }, 'edited');
  const revertBtn = h('button', { class: 'seed-link', id: 'seed-revert', hidden: true, onclick: () => revert() }, 'Revert to preset');
  const edBody = h('div', { class: 'seed-editor-body' });
  const errEl = h('div', { class: 'error', id: 'seed-error', role: 'status' });
  let exprInput: HTMLInputElement | null = null;
  const editor = h(
    'div',
    { class: 'seed-box seed-editor' },
    h('div', { class: 'seed-box-head' }, edKind, edPath, editedBadge, revertBtn),
    edBody,
    errEl,
  );

  const isEdited = (e: SeedEntry) => (e.mode === 'formula' ? edits.has(e.id) : paramEdits.has(e.id));

  const onEdit = () => {
    const e = entry();
    const ed = isEdited(e);
    editedBadge.hidden = revertBtn.hidden = !ed;
    flash('');
    updateStatus();
  };

  const revert = () => {
    const e = entry();
    edits.delete(e.id);
    paramEdits.delete(e.id);
    renderEditor();
    onEdit();
  };

  const setParam = (e: SeedEntry, key: string, v: number) => {
    const cur = { ...paramEdits.get(e.id), [key]: v };
    const def = seedParams(e);
    if (Object.keys(cur).every((k) => cur[k] === def[k])) paramEdits.delete(e.id);
    else paramEdits.set(e.id, cur);
    onEdit();
  };

  const legendItem = (name: string, text: string) => h('span', {}, h('b', {}, name), ` ${text}`);

  const renderEditor = () => {
    const e = entry();
    edKind.textContent = e.mode === 'formula' ? 'Formula' : e.mode === 'basic' ? 'Basic wave' : 'Parameters';
    edPath.textContent = `${e.cat} › ${e.name}`;
    revertBtn.textContent = e.mode === 'formula' ? 'Revert to preset' : 'Revert to defaults';
    editedBadge.hidden = revertBtn.hidden = !isEdited(e);
    exprInput = null;
    if (e.mode === 'formula') {
      const input = h('input', {
        type: 'text',
        id: 'seed-expr',
        class: 'seed-expr',
        value: exprOf(e),
        'aria-label': 'Formula in p, t, n, u and pnoise()',
        'aria-describedby': 'seed-error',
        spellcheck: false,
        autocapitalize: 'off',
        autocomplete: 'off',
      });
      input.addEventListener('input', () => {
        lastTypedAt = performance.now();
        if (input.value === e.expr) edits.delete(e.id);
        else edits.set(e.id, input.value);
        onEdit();
      });
      exprInput = input;
      edBody.replaceChildren(
        h('label', { class: 'seed-formula' }, h('span', { class: 'seed-f' }, 'f ='), input),
        h(
          'div',
          { class: 'seed-legend' },
          legendItem('p', 'phase 0–2π'),
          legendItem('t', '0–1'),
          legendItem('n', 'batch index'),
          legendItem('u', '0–1 across batch'),
          legendItem('pnoise', '(freq, z, oct, pers)'),
        ),
      );
    } else if (e.mode === 'basic') {
      const asF = h(
        'button',
        {
          id: 'seed-as-formula',
          class: 'small',
          onclick: () => {
            const ci = SEED_LIBRARY.findIndex((x) => x.id === CUSTOM_ENTRY);
            const prev = edits.get(CUSTOM_ENTRY);
            if (prev !== undefined && prev !== e.asFormula && !confirm(`Replace your Blank formula edits with the ${e.name} formula?`))
              return;
            edits.set(CUSTOM_ENTRY, e.asFormula!);
            selectEntry(ci, false);
            onEdit();
          },
        },
        'Edit as formula',
      );
      edBody.replaceChildren(
        h('p', { class: 'seed-about' }, e.about ?? ''),
        h(
          'p',
          { class: 'hint' },
          'Band-limited additive generator (harmonics ≤ 72); every table of a batch is the same. ',
          asF,
        ),
      );
    } else {
      const vals = paramsOf(e);
      const controls = (e.params ?? []).map((p) => {
        if (p.options) {
          const f = selectField(
            p.label,
            p.options.map(([v, l]) => [String(v), l]),
            String(vals[p.key]),
            (v) => setParam(e, p.key, Number(v)),
          );
          f.select.id = `seed-param-${p.key}`;
          return f.el;
        }
        const s = slider({
          label: p.label,
          min: p.min,
          max: p.max,
          step: p.step,
          value: vals[p.key],
          format: (v) => (p.step >= 1 ? String(Math.round(v)) : v.toFixed(2)),
          onInput: (v) => setParam(e, p.key, v),
        });
        s.input.id = `seed-param-${p.key}`;
        return s.el;
      });
      const hints: Record<string, string> = {
        pulse: 'Band-limited pulse; the width sweeps from Width to “Batch → width” across the batch.',
        perlin: 'Loop-seamless noise. A batch shares one noise region (the seed) and drifts through z.',
        ca: 'Each generation’s cells become ±1 steps of one table; a batch is N consecutive generations from the start.',
      };
      edBody.replaceChildren(h('div', { class: 'seed-params' }, ...controls), h('p', { class: 'hint' }, hints[e.mode] ?? ''));
    }
  };

  // ---- waveform ----
  const shownLabel = h('span', { class: 'mono-label', id: 'seed-shown' });
  const waveC = h('canvas', { id: 'seed-wave', role: 'img', 'aria-label': 'Waveform of the shown table' });
  const specC = h('canvas', { id: 'seed-spec', role: 'img', 'aria-label': 'Harmonic spectrum of the shown table' });
  const axis = (...labels: string[]) => h('div', { class: 'seed-axis' }, ...labels.map((l) => h('span', {}, l)));
  // Canvases fill their box (absolutely positioned; sized from the box in drawMain).
  const waveBox = h(
    'div',
    { class: 'seed-plot-box' },
    waveC,
    h(
      'div',
      { class: 'seed-plot-tags' },
      shownLabel,
      // Planned: an Edit layer (draw the waveform / edit harmonics) between the generated
      // table and Add — see finalTable().
      h(
        'div',
        { class: 'seg', role: 'group', 'aria-label': 'Preview mode' },
        h('button', { class: 'seg-on', 'aria-pressed': 'true', tabindex: -1 }, 'View'),
        h('button', { id: 'seed-edit-mode', disabled: true, title: 'Planned: draw / edit the waveform and harmonics' }, 'Edit · planned'),
      ),
    ),
  );
  const specBox = h('div', { class: 'seed-plot-box' }, specC);
  const viewer = h(
    'div',
    { class: 'seed-viewer' },
    h(
      'div',
      { class: 'seed-views' },
      h('div', { class: 'seed-plot seed-plot-wave' }, waveBox, axis('0', 'π', '2π')),
      h('div', { class: 'seed-plot seed-plot-spec' }, specBox, axis('h1', 'dB (−60…0)', `h${SPEC_BINS}`)),
    ),
  );

  // ---- batch ----
  const nInput = h('input', {
    type: 'number',
    id: 'seed-n',
    min: 1,
    max: MAX_BATCH,
    step: 1,
    value: opts.count(),
    inputmode: 'numeric',
    'aria-label': 'Batch size N',
  });
  nInput.addEventListener('change', () => {
    const v = Math.round(Number(nInput.value));
    if (Number.isFinite(v)) opts.setCount(v);
    nInput.value = String(opts.count());
  });
  const stepper = h(
    'div',
    { class: 'seed-stepper', role: 'group', 'aria-label': 'Batch size' },
    h('button', { id: 'seed-n-dec', 'aria-label': 'Fewer tables', onclick: () => opts.setCount(opts.count() - 1) }, '−'),
    h('label', { class: 'seed-n-label' }, 'N', nInput),
    h('button', { id: 'seed-n-inc', 'aria-label': 'More tables', onclick: () => opts.setCount(opts.count() + 1) }, '+'),
  );
  const seedLabel = h('span', { id: 'seed-seed', class: 'mono-label', title: 'Shared by the preview and every Add' });
  const seedBox = h(
    'div',
    { class: 'seed-seedbox' },
    h('span', {}, 'Seed'),
    seedLabel,
    h('button', { id: 'seed-reroll', class: 'small', 'aria-label': 'Reroll the seed', onclick: () => newSeed() }, 'Reroll'),
  );
  const addShownBtn = h('button', { id: 'seed-add-shown', onclick: () => addShown() }, 'Add shown');
  const addBatchBtn = h('button', { id: 'seed-add-batch', class: 'primary', onclick: () => addBatch() }, `Add batch (+${opts.count()})`);
  const status = h('div', { class: 'seed-status', id: 'seed-status', role: 'status' });
  const strip = h('div', { id: 'seed-strip', class: 'seed-strip', role: 'group', 'aria-label': 'Batch tables (←/→ to move)' });
  const batchBox = h(
    'div',
    { class: 'seed-box seed-batch' },
    h(
      'div',
      { class: 'seed-batch-head' },
      h('span', { class: 'seed-h' }, 'Batch'),
      stepper,
      seedBox,
      h('div', { class: 'seed-targets' }, h('span', {}, 'Sets window of'), voiceTargetChecks(model)),
      status,
      h('div', { class: 'seed-adds' }, addShownBtn, addBatchBtn),
    ),
    strip,
  );

  interface Card {
    el: HTMLButtonElement;
    wave: HTMLCanvasElement;
    spec: HTMLCanvasElement;
    label: HTMLSpanElement;
    drawn: GeneratedTable | null | undefined;
  }
  const cards: Card[] = [];
  const rebuildCards = (n: number) => {
    while (cards.length < n) {
      const i = cards.length;
      const wave = h('canvas', { 'aria-hidden': 'true' });
      const spec = h('canvas', { 'aria-hidden': 'true' });
      const label = h('span', { class: 'seed-card-label' });
      const el = h('button', { class: 'seed-card', tabindex: -1, onclick: () => setShown(i, false) }, wave, spec, label);
      cards.push({ el, wave, spec, label, drawn: null });
      strip.append(el);
    }
    while (cards.length > n) cards.pop()!.el.remove();
    cards.forEach((c, i) => {
      c.label.textContent = `#${i + 1} · u ${batchU(i, n).toFixed(2)}`;
      c.el.setAttribute('aria-label', `Show table ${i + 1} of ${n}`);
    });
    if (shown > n - 1) shown = n - 1;
    syncCards();
    cardsDirty = mainDirty = true;
  };
  strip.addEventListener('keydown', (ev) => {
    const n = opts.count();
    const to =
      ev.key === 'ArrowRight' ? shown + 1 : ev.key === 'ArrowLeft' ? shown - 1 : ev.key === 'Home' ? 0 : ev.key === 'End' ? n - 1 : null;
    if (to === null) return;
    ev.preventDefault();
    setShown(Math.max(0, Math.min(n - 1, to)), true);
  });

  const syncCards = () => {
    const n = opts.count();
    cards.forEach((c, i) => {
      c.el.setAttribute('aria-pressed', String(i === shown));
      c.el.tabIndex = i === shown ? 0 : -1;
    });
    shownLabel.textContent = `#${shown + 1} of ${n} · n ${shown} · u ${batchU(shown, n).toFixed(2)}`;
  };

  /** Scroll the strip (only) so card i is visible. */
  const scrollCardIntoView = (i: number) => {
    const c = cards[i]?.el;
    if (!c || !strip.clientWidth) return;
    const left = c.offsetLeft - 4;
    const right = c.offsetLeft + c.offsetWidth + 4;
    if (left < strip.scrollLeft) strip.scrollLeft = left;
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth;
  };

  const setShown = (i: number, focus: boolean) => {
    if (i !== shown) {
      shown = i;
      mainDirty = statusDirty = true;
    }
    syncCards();
    scrollCardIntoView(i);
    if (focus) cards[i]?.el.focus({ preventScroll: true });
  };

  const newSeed = () => {
    seed = randomSeed();
    seedLabel.textContent = hex(seed);
    flash('');
  };

  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  const flash = (msg: string, warn = false) => {
    status.textContent = msg;
    status.classList.toggle('warn', warn);
    clearTimeout(flashTimer);
    if (msg) flashTimer = setTimeout(() => (status.textContent = ''), 4000);
  };

  // ---- preview job ----
  let job: Job | null = null;
  let lastStart = -Infinity;

  /** Start computing the current request; null when the formula doesn't compile. */
  const startJob = (): Job | null => {
    const req = request();
    let fn: FormulaFn | undefined;
    if (req.entry.mode === 'formula') {
      fn = compile(req.expr).fn;
      if (!fn) return null;
    }
    job = { key: keyOf(req), req, fn, tables: new Array(req.count), errors: new Array(req.count), next: 0, fatal: '' };
    cardsDirty = mainDirty = statusDirty = true;
    return job;
  };

  /** The job for the current request (started synchronously if needed), or null. */
  const currentJob = (): Job | null => {
    const key = keyOf(request());
    if (job?.key === key) return job;
    return startJob();
  };

  /**
   * Compute table i of the job if missing; false if it failed. A runtime error marks
   * only that table; a table over TABLE_CAP_MS aborts and stops the whole job.
   */
  const computeOne = (j: Job, i: number): boolean => {
    if (j.fatal || j.errors[i]) return false;
    if (j.tables[i]) return true;
    const stopAt = performance.now() + TABLE_CAP_MS;
    try {
      j.tables[i] = seedTable(j.req, i, j.fn, () => performance.now() > stopAt);
    } catch (e) {
      if (e instanceof FormulaAborted) j.fatal = `too slow (one table took over ${TABLE_CAP_MS} ms); simplify the formula`;
      else j.errors[i] = errText(e);
      statusDirty = cardsDirty = mainDirty = true;
      return false;
    }
    cardsDirty = true;
    if (i === shown) mainDirty = true;
    return true;
  };

  const work = (j: Job, deadline: number) => {
    if (shown < j.req.count) computeOne(j, shown);
    while (!j.fatal && j.next < j.req.count && performance.now() < deadline) computeOne(j, j.next++);
  };

  /** Indices of the job's failed tables (so far). */
  const failedOf = (j: Job): number[] => {
    const out: number[] = [];
    for (let i = 0; i < j.req.count; i++) if (j.errors[i]) out.push(i);
    return out;
  };

  /**
   * The table that is shown and added. Planned Edit layer (draw / edit harmonics) slots
   * in here: it will map the generated table to an edited, re-shaped one.
   */
  const finalTable = (j: Job, i: number): GeneratedTable | undefined => j.tables[i];

  const updateStatus = () => {
    statusDirty = false;
    const e = entry();
    const syntax = e.mode === 'formula' ? compile(exprOf(e)).err : undefined;
    const j = job && job.key === keyOf(request()) ? job : null;
    const failed = j ? failedOf(j) : [];
    // Syntax errors and aborted (too slow) formulas invalidate the whole preview.
    const blocking = syntax ? `Syntax: ${syntax}` : j?.fatal ? `Stopped: ${j.fatal}` : '';
    let err = blocking;
    if (!err && j && failed.length) {
      const first = failed.includes(shown) ? shown : failed[0];
      err = `Error at #${first + 1}: ${j.errors[first]}${failed.length > 1 ? ` (${failed.length} tables failed)` : ''}`;
    }
    errEl.textContent = err;
    exprInput?.classList.toggle('invalid', !!blocking);
    addShownBtn.disabled = !!blocking || !!j?.errors[shown];
    addBatchBtn.disabled = !!blocking || failed.length > 0;
    addBatchBtn.title = failed.length ? 'Every table of the batch must evaluate; Add shown still works for the others' : '';
    el.classList.toggle('seed-stale', !!blocking);
    seedBox.hidden = !seedUsesRandomness(e, exprOf(e));
  };

  // ---- actions ----
  const addShown = () => {
    const j = currentJob();
    if (!j || !computeOne(j, shown)) return updateStatus();
    model.addTables([finalTable(j, shown)!], 'single', true);
    flash(`Added #${shown + 1} to the Timeline`);
  };

  const addBatch = () => {
    const j = currentJob();
    if (!j) return updateStatus();
    for (let i = 0; i < j.req.count && !j.fatal; i++) computeOne(j, i);
    const failed = failedOf(j);
    if (j.fatal || failed.length) {
      updateStatus();
      if (failed.length)
        flash(`Batch not added: ${failed.length} of ${j.req.count} tables failed (first #${failed[0] + 1}). Fix the formula, or Add shown for single tables.`, true);
      return;
    }
    model.addTables(
      j.tables.map((_, i) => finalTable(j, i)!),
      'batch',
      true,
    );
    const n = j.req.count;
    if (seedUsesRandomness(j.req.entry, j.req.expr)) {
      newSeed();
      flash(`Added ${n} table${n > 1 ? 's' : ''} to the Timeline · new seed`);
    } else flash(`Added ${n} table${n > 1 ? 's' : ''} to the Timeline`);
  };

  // ---- drawing ----
  // While a restarted preview is computing, the previous tables stay drawn (no flicker).
  // Only the selected entry's tables are drawn: a different entry (e.g. one whose edited
  // formula doesn't compile) or a failed table clears the view.
  let lastMain: GeneratedTable | undefined;
  const currentEntryJob = () => (job && job.req.entry === entry() ? job : null);
  const drawMain = () => {
    mainDirty = false;
    const cur = currentEntryJob();
    const i = cur ? Math.min(shown, cur.req.count - 1) : 0;
    const failed = !cur || !!cur.errors[i] || !!cur.fatal;
    const t = (cur && finalTable(cur, i)) || (failed ? undefined : lastMain);
    lastMain = t;
    const axisC = cssColor('--border');
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
    if (t) drawWave(g, 0, 0, w, hh, t.data, cssColor('--wave'), { axis: axisC, lineWidth: 2 });
    const [gs, sw, sh] = fit(specC, Math.max(30, specBox.clientHeight || 90));
    gs.strokeStyle = grid;
    gs.beginPath();
    for (const f of [1 / 3, 2 / 3]) {
      gs.moveTo(0, Math.round(sh * f) + 0.5);
      gs.lineTo(sw, Math.round(sh * f) + 0.5);
    }
    gs.stroke();
    if (t) drawSpectrum(gs, sw, sh, t.data, cssColor('--accent'), { bins: SPEC_BINS });
  };

  const drawCards = () => {
    cardsDirty = false;
    const cw = cssColor('--wave');
    const cs = cssColor('--accent');
    const axisC = cssColor('--border');
    const cur = currentEntryJob();
    cards.forEach((c, i) => {
      const err = cur && i < cur.req.count ? cur.errors[i] : undefined;
      c.el.classList.toggle('failed', !!err);
      c.el.title = err ? `Error: ${err}` : '';
      const t = cur && i < cur.req.count ? finalTable(cur, i) : undefined;
      // Keep the previous drawing while a restarted job computes this card.
      if (c.drawn === t || (!t && c.drawn && cur && !err && !cur.fatal)) return;
      c.drawn = t;
      const g = fitFixed(c.wave, CARD_W - 10, CARD_WAVE_H);
      const gs = fitFixed(c.spec, CARD_W - 10, CARD_SPEC_H);
      if (!t) return;
      drawWave(g, 0, 0, CARD_W - 10, CARD_WAVE_H, t.data, cw, { axis: axisC, lineWidth: 1.25 });
      drawSpectrum(gs, CARD_W - 10, CARD_SPEC_H, t.data, cs, { bins: SPEC_BINS });
    });
  };

  const thumbTable = (e: SeedEntry): Float32Array => {
    try {
      const fn = e.mode === 'formula' ? compileFormula(e.expr!) : undefined;
      return seedTable({ entry: e, expr: e.expr ?? '', params: {}, seed: THUMB_SEED, count: 3 }, 1, fn).data;
    } catch {
      return new Float32Array(2);
    }
  };

  /** Draw visible thumbnails whose colour changed; compute missing ones within the budget. */
  const drawThumbs = (deadline: number) => {
    if (libBody.offsetParent === null) {
      thumbsDirty = false;
      return;
    }
    let pending = false;
    const normal = cssColor('--text-2');
    const current = cssColor('--accent-text');
    for (const i of filtered) {
      const want = i === sel ? current : normal;
      if (thumbDrawn[i] === want) continue;
      if (!thumbData[i]) {
        if (performance.now() > deadline) {
          pending = true;
          break;
        }
        thumbData[i] = thumbTable(SEED_LIBRARY[i]);
      }
      const g = fitFixed(thumbs[i], THUMB_W, THUMB_H);
      drawWave(g, 0, 0, THUMB_W, THUMB_H, thumbData[i]!, want, { lineWidth: 1.2, points: THUMB_W * 2 });
      thumbDrawn[i] = want;
    }
    thumbsDirty = pending;
  };

  // ---- assembly ----
  const el = h(
    'div',
    { role: 'tabpanel', id: 'panel-seed', class: 'seed' },
    lib,
    h('div', { class: 'seed-main' }, editor, viewer, batchBox),
  );
  watchVisibility(el);

  opts.onCount((n) => {
    if (document.activeElement !== nInput) nInput.value = String(n);
    addBatchBtn.textContent = `Add batch (+${n})`;
    rebuildCards(n);
    flash('');
  });
  onThemeChange(() => {
    thumbDrawn.fill('');
    for (const c of cards) c.drawn = null;
    thumbsDirty = cardsDirty = mainDirty = true;
  });
  narrowMq.addEventListener('change', () => {
    mainDirty = thumbsDirty = true;
  });
  new ResizeObserver(() => (mainDirty = true)).observe(viewer);

  renderEditor();
  rebuildCards(opts.count());
  applyFilter();
  newSeed();

  return {
    el,
    view: {
      frame(now) {
        if (!opts.active() || !isOnScreen(el)) return;
        const deadline = performance.now() + BUDGET_MS;
        const key = keyOf(request());
        const typing = entry().mode === 'formula' && performance.now() - lastTypedAt < TYPING_MS;
        if (job?.key !== key && !typing && now - lastStart >= PREVIEW_MS) {
          lastStart = now;
          startJob();
          statusDirty = true;
        }
        if (job?.key === key) work(job, deadline);
        if (statusDirty) updateStatus();
        if (mainDirty) drawMain();
        if (cardsDirty) drawCards();
        if (thumbsDirty) drawThumbs(deadline + 4);
      },
    },
  };
}
