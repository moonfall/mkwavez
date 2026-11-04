import { compileFormula } from '../browser/formulaEval';
import { traceGlyph } from '../browser/glyphTrace';
import {
  batchU,
  FormulaAborted,
  glyphInputs,
  modeFormula,
  SEED_LIBRARY,
  seedFormulaExpr,
  seedParams,
  seedTable,
  seedUsesRandomness,
  sourceExpr,
  WAVE_FUNCTION_DOCS,
  type ExprSource,
  type FormulaFn,
  type SeedEntry,
  type SeedRequest,
} from '../core/generators';
import { randomSeed } from '../core/prng';
import type { GeneratedTable } from '../core/table';
import { cssColor, drawSpectrum, drawWave, fit, fitFixed, onThemeChange } from './canvas';
import { isOnScreen, watchVisibility, type FrameView, type UiContext } from './context';
import { buildStepper, buildStrip, drawCard, flasher, SPEC_BINS } from './batch';
import { h, selectField, slider } from './dom';
import { buildLibrary } from './library';
import { buildShapeOnAdd, SHAPE_CARDS_MS } from './shapeOnAdd';

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
/** Library thumbnails: default params, middle of a 3-table batch (u = 0.5), fixed seed. */
const THUMB_SEED = 1;
const DEFAULT_ENTRY = 'chebyshev';
/** Glyph contour: the default text (each character is one waveform of a batch). */
const DEFAULT_GLYPH_TEXT = 'mkwavez';
const CUSTOM_ENTRY = 'blank-formula';

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
/** Basic presets (Sine … Square, Pulse): the expression comes from a source (built-in function / formula). */
const hasSource = (e: SeedEntry) => e.mode === 'basic' || e.mode === 'pulse';
const SOURCES: readonly (readonly [ExprSource, string, string])[] = [
  ['builtin', 'Built-in function', 'The band-limited waveform function, e.g. saw(p): exactly the preset'],
  ['formula', 'Formula', 'The naive formula (Math functions only)'],
];
/** The waveform functions, one per line (the legend's tooltip). */
const FUNCTIONS_TIP =
  'Waveform functions (x = phase in radians, e.g. p, 2*p, p+u; seed? defaults to the shown seed):\n' +
  WAVE_FUNCTION_DOCS.map((d) => `${d.sig} — ${d.about}`).join('\n');

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
  // ---- state ----
  let sel = Math.max(
    0,
    SEED_LIBRARY.findIndex((e) => e.id === DEFAULT_ENTRY),
  );
  /** Formula edits: by entry id, or `${id}#${source}` for basic presets (each source keeps its own). */
  const edits = new Map<string, string>();
  const paramEdits = new Map<string, Record<string, number>>();
  /** Basic presets' expression source (default: the built-in function). */
  const sources = new Map<string, ExprSource>();
  let seed = randomSeed();

  const entry = () => SEED_LIBRARY[sel];
  const sourceOf = (e: SeedEntry): ExprSource => sources.get(e.id) ?? 'builtin';
  const editKey = (e: SeedEntry) => (hasSource(e) ? `${e.id}#${sourceOf(e)}` : e.id);
  const paramsOf = (e: SeedEntry) => seedParams(e, paramEdits.get(e.id));
  /** The unedited expression: the preset's, or a basic preset's source expression (Pulse: from its params). */
  const defaultExpr = (e: SeedEntry) => (hasSource(e) ? sourceExpr(e, sourceOf(e), paramsOf(e)) : (e.expr ?? ''));
  const exprOf = (e: SeedEntry) => edits.get(editKey(e)) ?? defaultExpr(e);

  // Glyph contour: the text and the traced contours (browser layer; recipes store the contour).
  const glyphTexts = new Map<string, string>();
  const glyphTextOf = (e: SeedEntry) => glyphTexts.get(e.id) ?? DEFAULT_GLYPH_TEXT;
  const contours = new Map<string, string>();
  const contourOf = (ch: string, weight: number) => {
    const k = `${weight}|${ch}`;
    let c = contours.get(k);
    if (c === undefined) contours.set(k, (c = traceGlyph(ch, weight)));
    return c;
  };
  const glyphChars = (e: SeedEntry) => [...glyphTextOf(e)].filter((c) => c.trim());
  /** Per-table inputs: Next characters (char i of the text), or the first character at a swept weight. */
  const glyphInputsOf = (e: SeedEntry, p: Record<string, number>, count: number) =>
    glyphInputs(glyphChars(e), { batch: p.batch, weight: p.weight, weightEnd: p.weightEnd }, count, contourOf);

  const request = (): SeedRequest => {
    const e = entry();
    const params = paramsOf(e);
    const inputs = e.mode === 'glyph' ? glyphInputsOf(e, params, opts.count()) : undefined;
    return { entry: e, expr: exprOf(e), params, seed, count: opts.count(), inputs, source: hasSource(e) ? sourceOf(e) : undefined };
  };
  const keyOf = (r: SeedRequest) =>
    `${r.entry.id}|${r.source ?? ''}|${r.entry.mode === 'formula' || hasSource(r.entry) ? r.expr : ''}|${JSON.stringify(r.params)}|${r.entry.mode === 'glyph' ? glyphTextOf(r.entry) : ''}|${r.seed}|${r.count}`;
  /** The formula a request renders (formula entries, basic presets as formulas), or null. */
  const formulaOf = (r: SeedRequest) => seedFormulaExpr(r);

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
  // Room in the Timeline changes with it and with the wavetables (Add buttons).
  model.on('timeline', () => (statusDirty = true));
  model.on('wavetables', () => (statusDirty = true));

  // ---- library ----
  const thumbData: (Float32Array | undefined)[] = [];
  const thumbDrawn: string[] = SEED_LIBRARY.map(() => '');
  const lib = buildLibrary({
    idPrefix: 'seed',
    title: 'Library',
    placeholder: 'Search name, category, formula',
    items: SEED_LIBRARY.map((e) => ({ id: e.id, group: e.cat, name: e.name, tag: tagOf(e), search: `${e.name}\n${e.cat}\n${e.expr ?? ''}` })),
    initial: sel,
    onChange: (i, from) => {
      thumbDrawn[from] = thumbDrawn[i] = '';
      sel = i;
      strip.setShown(0);
      flash('');
      renderEditor();
      thumbsDirty = mainDirty = cardsDirty = true;
      updateStatus();
    },
    onThumbs: () => (thumbsDirty = true),
  });

  // ---- formula / parameters ----
  const edKind = h('span', { class: 'gen-h', id: 'seed-kind' });
  const edPath = h('span', { class: 'seed-path', id: 'seed-title' });
  // The badge and Revert keep their space while hidden (visibility), so the first edit
  // doesn't widen the head and re-flow the parameters / viewer beside and below it.
  const editedBadge = h('span', { class: 'seed-badge seed-off', id: 'seed-edited' }, 'edited');
  const revertBtn = h('button', { class: 'seed-link seed-off', id: 'seed-revert', onclick: () => revert() }, 'Revert to preset');
  const showEdited = (on: boolean) => {
    editedBadge.classList.toggle('seed-off', !on);
    revertBtn.classList.toggle('seed-off', !on);
  };
  const edBody = h('div', { class: 'seed-editor-body' });
  const errEl = h('div', { class: 'error', id: 'seed-error', role: 'status' });
  let exprInput: HTMLInputElement | null = null;
  const editor = h(
    'div',
    { class: 'gen-box seed-editor' },
    h('div', { class: 'gen-box-head' }, edKind, edPath, editedBadge, revertBtn),
    edBody,
    errEl,
  );

  const isEdited = (e: SeedEntry) =>
    e.mode === 'formula' ? edits.has(e.id) : edits.has(editKey(e)) || paramEdits.has(e.id) || glyphTexts.has(e.id);
  /** Pulse: its sliders apply only while the expression is unedited. */
  let paramInputs: (HTMLInputElement | HTMLSelectElement)[] = [];
  const syncParamLock = () => {
    const e = entry();
    const locked = hasSource(e) && edits.has(editKey(e));
    for (const i of paramInputs) {
      i.disabled = locked;
      i.title = locked ? 'The edited expression sets the waveform: Revert to use the sliders' : '';
    }
  };

  const onEdit = () => {
    const e = entry();
    const ed = isEdited(e);
    showEdited(ed);
    syncParamLock();
    flash('');
    updateStatus();
  };

  const revert = () => {
    const e = entry();
    edits.delete(editKey(e));
    paramEdits.delete(e.id);
    glyphTexts.delete(e.id);
    renderEditor();
    onEdit();
  };

  const setParam = (e: SeedEntry, key: string, v: number) => {
    const cur = { ...paramEdits.get(e.id), [key]: v };
    const def = seedParams(e);
    if (Object.keys(cur).every((k) => cur[k] === def[k])) paramEdits.delete(e.id);
    else paramEdits.set(e.id, cur);
    // Pulse: the shown (unedited) expression follows the sliders.
    if (exprInput && hasSource(e) && !edits.has(editKey(e))) exprInput.value = exprOf(e);
    onEdit();
  };

  const legendItem = (name: string, text: string) => h('span', {}, h('b', {}, name), ` ${text}`);
  /** The waveform-function reference (opened by the legend's Functions button; stays open across entries). */
  let fnHelpOpen = false;
  let fnBtn: HTMLButtonElement | null = null;
  const setFnHelp = (open: boolean) => {
    fnHelpOpen = open;
    fnHelp.hidden = !open;
    fnBtn?.setAttribute('aria-expanded', String(open));
    fnBtn?.classList.toggle('seg-on', open);
    mainDirty = true;
  };
  const fnHelp = h(
    'div',
    { id: 'seed-fn-help', class: 'seed-fn-help', role: 'region', 'aria-label': 'Waveform functions', hidden: true },
    h(
      'div',
      { class: 'seed-fn-help-head' },
      h('span', {}, 'Waveform functions — x is a phase in radians (p, 2*p, p+u); each peaks at ±1; seed? defaults to the shown seed.'),
      h('button', { class: 'small', id: 'seed-fn-help-close', 'aria-label': 'Close the function reference', onclick: () => setFnHelp(false) }, '×'),
    ),
    h('dl', {}, ...WAVE_FUNCTION_DOCS.flatMap((d) => [h('dt', {}, h('code', {}, d.sig)), h('dd', {}, d.about)])),
  );
  /** The formula legend (and the function reference below it, when open). */
  const legend = (): HTMLElement[] => {
    fnBtn = h(
      'button',
      {
        id: 'seed-functions',
        class: `small seed-fns${fnHelpOpen ? ' seg-on' : ''}`,
        'aria-expanded': String(fnHelpOpen),
        'aria-controls': 'seed-fn-help',
        title: FUNCTIONS_TIP,
        onclick: () => setFnHelp(!fnHelpOpen),
      },
      'ƒ Functions',
    );
    fnHelp.hidden = !fnHelpOpen;
    return [
      h(
        'div',
        { class: 'seed-legend' },
        fnBtn,
        legendItem('p', 'phase 0–2π'),
        legendItem('t', '0–1'),
        legendItem('n', 'batch index'),
        legendItem('u', '0–1 across batch'),
        legendItem('pnoise', '(freq, z, oct, pers)'),
      ),
      fnHelp,
    ];
  };

  /** The formula input (formula entries and basic presets). */
  const formulaInput = (e: SeedEntry) => {
    const input = h('input', {
      type: 'text',
      id: 'seed-expr',
      class: 'seed-expr',
      value: exprOf(e),
      'aria-label': 'Formula in p, t, n, u, pnoise() and the waveform functions',
      'aria-describedby': 'seed-error',
      spellcheck: false,
      autocapitalize: 'off',
      autocomplete: 'off',
    });
    input.addEventListener('input', () => {
      lastTypedAt = performance.now();
      if (input.value === defaultExpr(e)) edits.delete(editKey(e));
      else edits.set(editKey(e), input.value);
      onEdit();
    });
    exprInput = input;
    return h('label', { class: 'seed-formula' }, h('span', { class: 'seed-f' }, 'f ='), input);
  };

  /** "Edit as formula": write `expr` into the Blank formula entry (asking before replacing its edits). */
  const editAsFormula = (e: SeedEntry, expr: string) => {
    const ci = SEED_LIBRARY.findIndex((x) => x.id === CUSTOM_ENTRY);
    const prev = edits.get(CUSTOM_ENTRY);
    if (prev !== undefined && prev !== expr && !confirm(`Replace your Blank formula edits with the ${e.name} formula?`)) return;
    edits.set(CUSTOM_ENTRY, expr);
    lib.select(ci);
    onEdit();
  };
  const asFormulaButton = (e: SeedEntry, expr: () => string | null) =>
    h(
      'button',
      {
        id: 'seed-as-formula',
        class: 'small',
        title: 'Write the equivalent formula (waveform functions, n / u for the batch) into Blank formula',
        onclick: () => {
          const x = expr();
          if (x) editAsFormula(e, x);
        },
      },
      'Edit as formula',
    );

  /** Basic presets: Built-in function | Formula. */
  const sourceSeg = (e: SeedEntry) =>
    h(
      'div',
      { class: 'seg seed-source', role: 'group', 'aria-label': 'Expression source' },
      ...SOURCES.map(([s, label, tip]) =>
        h(
          'button',
          {
            id: `seed-source-${s}`,
            class: sourceOf(e) === s ? 'seg-on' : '',
            'aria-pressed': String(sourceOf(e) === s),
            title: tip,
            onclick: () => {
              if (sourceOf(e) === s) return;
              if (s === 'builtin') sources.delete(e.id);
              else sources.set(e.id, s);
              renderEditor();
              onEdit();
            },
          },
          label,
        ),
      ),
    );

  /** Slider / dropdown controls of an entry's params. */
  const paramControls = (e: SeedEntry): HTMLElement[] => {
    const vals = paramsOf(e);
    return (e.params ?? []).map((p) => {
      if (p.options) {
        const f = selectField(
          p.label,
          p.options.map(([v, l]) => [String(v), l]),
          String(vals[p.key]),
          (v) => setParam(e, p.key, Number(v)),
        );
        f.select.id = `seed-param-${p.key}`;
        paramInputs.push(f.select);
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
      paramInputs.push(s.input);
      return s.el;
    });
  };

  const renderEditor = () => {
    const e = entry();
    edKind.textContent = e.mode === 'formula' ? 'Formula' : e.mode === 'basic' ? 'Basic wave' : 'Parameters';
    edPath.textContent = `${e.cat} › ${e.name}`;
    revertBtn.textContent = e.mode === 'formula' || e.mode === 'basic' ? 'Revert to preset' : 'Revert to defaults';
    showEdited(isEdited(e));
    exprInput = null;
    paramInputs = [];
    const hints: Record<string, string> = {
      pulse: 'Band-limited pulse; the width sweeps from Width to “Batch → width” across the batch.',
      perlin: 'Loop-seamless noise. A batch shares one noise region (the seed) and drifts through z.',
      ca: 'Each generation’s cells become ±1 steps of one waveform; a batch is N consecutive generations from the start.',
    };
    if (e.mode === 'formula') {
      edBody.replaceChildren(formulaInput(e), ...legend());
    } else if (hasSource(e)) {
      // Basic presets: the expression (built-in function or naive formula), Pulse's sliders below it.
      const builtin = sourceOf(e) === 'builtin';
      const about =
        e.mode === 'basic'
          ? builtin
            ? `${e.about ?? ''} Band-limited additive generator (harmonics ≤ 72); every waveform of a batch is the same.`
            : 'The naive formula: Math functions only, band-limited by the waveform pipeline (float rounding differs slightly from the built-in function).'
          : builtin
            ? hints.pulse
            : 'The naive formula: ±1 by comparing t with the width (identical to the band-limited pulse once shaped).';
      const controls = e.mode === 'pulse' ? [h('div', { class: 'seed-params' }, ...paramControls(e))] : [];
      edBody.replaceChildren(
        h('div', { class: 'seed-source-row' }, sourceSeg(e), formulaInput(e)),
        ...legend(),
        ...controls,
        h('p', { class: 'hint' }, `${about} `, asFormulaButton(e, () => exprOf(e))),
      );
      syncParamLock();
    } else {
      const controls = paramControls(e);
      if (e.mode === 'glyph') {
        const text = h('input', {
          type: 'text',
          id: 'seed-glyph-text',
          class: 'seed-expr',
          value: glyphTextOf(e),
          maxlength: 64,
          'aria-label': 'Characters (one waveform each)',
          spellcheck: false,
          autocapitalize: 'off',
          autocomplete: 'off',
        });
        text.addEventListener('input', () => {
          if (text.value === DEFAULT_GLYPH_TEXT) glyphTexts.delete(e.id);
          else glyphTexts.set(e.id, text.value);
          onEdit();
        });
        controls.unshift(h('label', { class: 'seed-formula' }, h('span', { class: 'seed-f' }, 'Text'), text));
      }
      const asF = asFormulaButton(e, () => modeFormula(e, paramsOf(e), { glyphChars: glyphChars(e), contourOf }));
      edBody.replaceChildren(h('div', { class: 'seed-params' }, ...controls), h('p', { class: 'hint' }, `${e.about ?? hints[e.mode] ?? ''} `, asF));
    }
  };

  // ---- waveform ----
  const shownLabel = h('span', { class: 'mono-label', id: 'seed-shown' });
  const waveC = h('canvas', { id: 'seed-wave', role: 'img', 'aria-label': 'Shown waveform' });
  const specC = h('canvas', { id: 'seed-spec', role: 'img', 'aria-label': 'Harmonic spectrum of the shown waveform' });
  const axis = (...labels: string[]) => h('div', { class: 'gen-axis' }, ...labels.map((l) => h('span', {}, l)));
  // Canvases fill their box (absolutely positioned; sized from the box in drawMain).
  const waveBox = h(
    'div',
    { class: 'gen-plot-box' },
    waveC,
    h(
      'div',
      { class: 'gen-plot-tags' },
      shownLabel,
    ),
  );
  const specBox = h('div', { class: 'gen-plot-box' }, specC);
  const viewer = h(
    'div',
    { class: 'gen-viewer' },
    h(
      'div',
      { class: 'gen-views' },
      h('div', { class: 'gen-plot gen-plot-wave' }, waveBox, axis('0', 'π', '2π')),
      h('div', { class: 'gen-plot gen-plot-spec' }, specBox, axis('h1', 'dB (−60…0)', `h${SPEC_BINS}`)),
    ),
  );

  // ---- batch ----
  const stepper = buildStepper('seed', opts);
  const shapeOn = buildShapeOnAdd(ctx, 'seed', () => {
    for (const c of strip.cards) c.drawn = null;
    cardsDirty = mainDirty = true;
  });
  const seedLabel = h('span', { id: 'seed-seed', class: 'mono-label', title: 'Shared by the preview and every Add' });
  const seedBox = h(
    'div',
    { class: 'gen-seedbox' },
    h('span', {}, 'Seed'),
    seedLabel,
    h('button', { id: 'seed-reroll', class: 'small', 'aria-label': 'Reroll the seed', onclick: () => newSeed() }, 'Reroll'),
  );
  const addShownBtn = h('button', { id: 'seed-add-shown', onclick: () => addShown() }, 'Add shown');
  const addBatchBtn = h('button', { id: 'seed-add-batch', class: 'primary', onclick: () => addBatch() }, `Add batch (+${opts.count()})`);
  const status = h('div', { class: 'gen-status', id: 'seed-status', role: 'status' });
  const flash = flasher(status);
  const strip = buildStrip('seed-strip', {
    onShow: () => {
      mainDirty = statusDirty = true;
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
      stepper.el,
      seedBox,
      status,
      shapeOn.el,
      h('div', { class: 'gen-adds' }, addShownBtn, addBatchBtn),
    ),
    strip.el,
  );

  const rebuildCards = (n: number) => {
    strip.resize(n, (i) => `#${i + 1} · u ${batchU(i, n).toFixed(2)}`);
    syncShownLabel();
    cardsDirty = mainDirty = true;
  };

  const syncShownLabel = () => {
    const n = opts.count();
    const shown = strip.shown();
    shownLabel.textContent = `#${shown + 1} of ${n} · n ${shown} · u ${batchU(shown, n).toFixed(2)}`;
  };

  const newSeed = () => {
    seed = randomSeed();
    seedLabel.textContent = hex(seed);
    flash('');
  };

  // ---- preview job ----
  let job: Job | null = null;
  let lastStart = -Infinity;

  /** Start computing the current request; null when the formula doesn't compile. */
  const startJob = (): Job | null => {
    const req = request();
    let fn: FormulaFn | undefined;
    const fexpr = formulaOf(req);
    if (fexpr !== null) {
      fn = compile(fexpr).fn;
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
      if (e instanceof FormulaAborted) j.fatal = `too slow (one waveform took over ${TABLE_CAP_MS} ms); simplify the formula`;
      else j.errors[i] = errText(e);
      statusDirty = cardsDirty = mainDirty = true;
      return false;
    }
    cardsDirty = true;
    if (i === strip.shown()) mainDirty = true;
    return true;
  };

  const work = (j: Job, deadline: number) => {
    const shown = strip.shown();
    if (shown < j.req.count) computeOne(j, shown);
    while (!j.fatal && j.next < j.req.count && performance.now() < deadline) computeOne(j, j.next++);
  };

  /** Indices of the job's failed tables (so far). */
  const failedOf = (j: Job): number[] => {
    const out: number[] = [];
    for (let i = 0; i < j.req.count; i++) if (j.errors[i]) out.push(i);
    return out;
  };

  /** The table that is shown and added: the generated one, shaped when a Shape chain is chosen. */
  const finalTable = (j: Job, i: number): GeneratedTable | undefined => {
    const t = j.tables[i];
    return t && shapeOn.apply(t, { index: i, count: j.req.count });
  };

  const updateStatus = () => {
    statusDirty = false;
    const e = entry();
    const fexpr = formulaOf(request());
    const syntax = fexpr !== null ? compile(fexpr).err : undefined;
    const j = job && job.key === keyOf(request()) ? job : null;
    const failed = j ? failedOf(j) : [];
    const shown = strip.shown();
    // Syntax errors and aborted (too slow) formulas invalidate the whole preview.
    const blocking = syntax ? `Syntax: ${syntax}` : j?.fatal ? `Stopped: ${j.fatal}` : '';
    let err = blocking;
    if (!err && j && failed.length) {
      const first = failed.includes(shown) ? shown : failed[0];
      err = `Error at #${first + 1}: ${j.errors[first]}${failed.length > 1 ? ` (${failed.length} waveforms failed)` : ''}`;
    }
    errEl.textContent = err;
    exprInput?.classList.toggle('invalid', !!blocking);
    // Timeline full (every waveform used by a wavetable): adds are refused.
    const room1 = model.roomFor(1);
    const roomN = model.roomFor(opts.count());
    addShownBtn.disabled = !!blocking || !!j?.errors[shown] || !room1;
    addBatchBtn.disabled = !!blocking || failed.length > 0 || !roomN;
    addShownBtn.title = room1 ? '' : model.fullMessage();
    addBatchBtn.title = !roomN ? model.fullMessage() : failed.length ? 'Every waveform of the batch must evaluate; Add shown still works for the others' : '';
    el.classList.toggle('seed-stale', !!blocking);
    // Parameter entries keep the seed box's space when a param turns the seed off (e.g.
    // Karplus excitation), so changing it doesn't shift the batch row.
    const seeded = seedUsesRandomness(e, fexpr ?? exprOf(e), paramsOf(e));
    seedBox.hidden = !seeded && !e.params?.length;
    seedBox.classList.toggle('seed-off', !seeded);
  };

  // ---- actions ----
  const addShown = () => {
    const j = currentJob();
    const shown = strip.shown();
    if (!j || !computeOne(j, shown)) return updateStatus();
    if (!model.addTables([finalTable(j, shown)!], true).length) return; // refused (Timeline full): the notice says why
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
        flash(`Batch not added: ${failed.length} of ${j.req.count} waveforms failed (first #${failed[0] + 1}). Fix the formula, or Add shown for single waveforms.`, true);
      return;
    }
    if (!model.addTables(j.tables.map((_, i) => finalTable(j, i)!), true).length) return; // refused: keep the seed
    const n = j.req.count;
    if (seedUsesRandomness(j.req.entry, formulaOf(j.req) ?? j.req.expr, j.req.params)) {
      newSeed();
      flash(`Added ${n} waveform${n > 1 ? 's' : ''} to the Timeline · new seed`);
    } else flash(`Added ${n} waveform${n > 1 ? 's' : ''} to the Timeline`);
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
    const i = cur ? Math.min(strip.shown(), cur.req.count - 1) : 0;
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
    const cur = currentEntryJob();
    const deadline = performance.now() + SHAPE_CARDS_MS;
    strip.cards.forEach((c, i) => {
      const err = cur && i < cur.req.count ? cur.errors[i] : undefined;
      c.el.classList.toggle('failed', !!err);
      c.el.title = err ? `Error: ${err}` : '';
      const raw = cur && i < cur.req.count ? cur.tables[i] : undefined;
      // Shaping (Shape chip) within a per-frame budget: the rest next frame.
      const t = raw && shapeOn.applyWithin(raw, { index: i, count: cur!.req.count }, deadline);
      if (raw && !t) cardsDirty = true;
      // Keep the previous drawing while a restarted job computes this card.
      if (c.drawn === t || (!t && c.drawn && cur && !err && !cur.fatal)) return;
      c.drawn = t;
      drawCard(c, t?.data);
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
    if (!lib.listShown()) {
      thumbsDirty = false;
      return;
    }
    let pending = false;
    const normal = cssColor('--text-2');
    const current = cssColor('--accent-text');
    for (const i of lib.filtered()) {
      const want = i === sel ? current : normal;
      if (thumbDrawn[i] === want) continue;
      if (!thumbData[i]) {
        if (performance.now() > deadline) {
          pending = true;
          break;
        }
        thumbData[i] = thumbTable(SEED_LIBRARY[i]);
      }
      const g = fitFixed(lib.thumbs[i], THUMB_W, THUMB_H);
      drawWave(g, 0, 0, THUMB_W, THUMB_H, thumbData[i]!, want, { lineWidth: 1.2, points: THUMB_W * 2 });
      thumbDrawn[i] = want;
    }
    thumbsDirty = pending;
  };

  // ---- assembly ----
  const el = h(
    'div',
    { role: 'tabpanel', id: 'panel-seed', class: 'gen-tab' },
    lib.el,
    h('div', { class: 'gen-main' }, editor, viewer, batchBox),
  );
  watchVisibility(el);

  opts.onCount((n) => {
    stepper.sync(n);
    addBatchBtn.textContent = `Add batch (+${n})`;
    rebuildCards(n);
    flash('');
  });
  onThemeChange(() => {
    thumbDrawn.fill('');
    for (const c of strip.cards) c.drawn = null;
    thumbsDirty = cardsDirty = mainDirty = true;
  });
  new ResizeObserver(() => (mainDirty = true)).observe(viewer);

  renderEditor();
  rebuildCards(opts.count());
  newSeed();

  return {
    el,
    view: {
      frame(now) {
        if (!opts.active() || !isOnScreen(el)) return;
        const deadline = performance.now() + BUDGET_MS;
        const key = keyOf(request());
        const typing = (entry().mode === 'formula' || hasSource(entry())) && performance.now() - lastTypedAt < TYPING_MS;
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
