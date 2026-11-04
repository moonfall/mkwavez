import { batchAmountAt, mutateBatchTable, type MutateRequest } from '../core/mutateBatch';
import { LOG_SWEEP_RANGE, mutate, MUTATION_CHOICES, mutationUsesSeed, type MutationId, type SweepMode } from '../core/mutations';
import { randomSeed } from '../core/prng';
import { describeRecipe, type GeneratedTable, type WaveTable } from '../core/table';
import { buildStepper, buildStrip, drawCard, flasher, SPEC_BINS } from './batch';
import { cssColor, drawSpectrum, drawWave, fit, fitFixed, onThemeChange } from './canvas';
import { isOnScreen, watchVisibility, type GenerateView, type UiContext } from './context';
import { h } from './dom';
import { buildLibrary } from './library';
import { buildShapeOnAdd, previewOf, SHAPE_CARDS_MS } from './shapeOnAdd';

/** Minimum interval between preview restarts while a control is dragged. */
const PREVIEW_MS = 50;
/** Minimum interval between library thumbnail restarts (source / amount / seed changes). */
const THUMBS_MS = 150;
/** Main-thread time per frame spent computing preview tables and thumbnails. */
const BUDGET_MS = 8;
const THUMB_W = 44;
const THUMB_H = 18;
const SRC_W = 34;
const SRC_H = 20;
const DEFAULT_MUTATION: MutationId = 'fold';

const MODES: { mode: SweepMode; label: string; title: string }[] = [
  { mode: 'lin', label: 'Linear', title: 'Linear sweep: waveform i of N uses amount A·i/N (the last is A)' },
  {
    mode: 'log',
    label: 'Log',
    title: `Log sweep: waveform i uses A·${LOG_SWEEP_RANGE}^((i−N)/(N−1)), ${LOG_SWEEP_RANGE}:1 down to A — fine steps at small amounts`,
  },
  { mode: 'chain', label: 'Chain', title: 'Chain: each waveform mutates the previous one at A (waveform i = i compounding steps)' },
];

export interface MutatePanelOpts {
  /** Shared batch size N (also used by Seed / Breed). */
  count(): number;
  setCount(n: number): void;
  onCount(fn: (n: number) => void): void;
  /** True while the Generate section is open and the Mutate tab is showing. */
  active(): boolean;
}

const hex = (s: number) => (s >>> 0).toString(16).padStart(8, '0');
const pct = (v: number) => {
  const p = v * 100;
  return `${p < 10 && p > 0 ? p.toFixed(1) : Math.round(p)}%`;
};

/** A preview batch being computed incrementally in the frame loop. */
interface Job {
  key: string;
  req: MutateRequest;
  source: WaveTable;
  tables: (GeneratedTable | undefined)[];
  /** Next table the background pass computes (a chain only ever computes in order). */
  next: number;
}

/**
 * Generate → Mutate: mutation library (search, ▲/▼, thumbnails of each mutation applied
 * to the source), source + parameters, the shown table large over the source, and the
 * batch strip. The source is the Timeline selection; Add shown / Add +N select the last
 * table added, so the next mutation continues from it. Preview tables are computed in the
 * frame loop (only while the tab is visible, restarted at most every PREVIEW_MS, BUDGET_MS
 * per frame) through the same mutateBatchTable() as Add, with the same seed / amount /
 * mode / N, so Add appends exactly what is shown.
 */
export function buildMutatePanel(ctx: UiContext, opts: MutatePanelOpts): { el: HTMLElement; view: GenerateView } {
  const { model } = ctx;

  // ---- state ----
  let sel = Math.max(
    0,
    MUTATION_CHOICES.findIndex((m) => m.id === DEFAULT_MUTATION),
  );
  let amount = 0.25;
  let mode: SweepMode = 'lin';
  let seed = randomSeed();

  const info = () => MUTATION_CHOICES[sel];
  const seeded = () => mutationUsesSeed(info().id);
  const source = (): WaveTable | undefined => model.table(model.selectedId);
  const request = (): MutateRequest => ({ mutation: info().id, amount, seed, mode, count: opts.count() });
  const keyOf = (src: WaveTable | undefined, r: MutateRequest) => `${src?.id ?? 'none'}|${r.mutation}|${r.amount}|${r.seed}|${r.mode}|${r.count}`;

  // Dirty flags (drawn in the frame loop).
  let mainDirty = true;
  let cardsDirty = true;
  let thumbsDirty = true;
  let srcDirty = true;

  // ---- library ----
  const lib = buildLibrary({
    idPrefix: 'mutate',
    title: 'Mutations',
    placeholder: 'Search name, group, mapping',
    items: MUTATION_CHOICES.map((m) => ({
      id: m.id,
      group: m.group,
      name: m.label,
      tag: 'seeded' in m ? 'rnd' : undefined,
      tagTitle: 'Uses the seed',
      search: `${m.label}\n${m.group}\n${m.hint}`,
    })),
    initial: sel,
    onChange: (i) => {
      sel = i;
      flash('');
      syncParams();
      strip.setShown(opts.count() - 1);
      thumbsDirty = mainDirty = cardsDirty = true;
    },
    onThumbs: () => (thumbsDirty = true),
  });

  // ---- source + parameters ----
  const srcThumb = h('canvas', { 'aria-hidden': 'true' });
  const srcNo = h('span', { class: 'mut-src-no', id: 'mutate-src-no' });
  const srcChip = h('div', { class: 'mut-src', id: 'mutate-src' }, srcThumb, h('span', {}, 'Source'), srcNo);
  const title = h('span', { class: 'mut-name', id: 'mutate-title' });
  const hint = h('span', { class: 'mut-hint', id: 'mutate-hint' });
  const amountVal = h('span', { class: 'mut-amount-val', id: 'mutate-amount-val' });
  const amountInput = h('input', { type: 'range', id: 'mutate-amount', min: 0, max: 1, step: 0.01, value: amount, 'aria-label': 'Amount' });
  amountInput.addEventListener('input', () => {
    amount = Number(amountInput.value);
    syncAmount();
  });
  const seedLabel = h('span', { id: 'mutate-seed', class: 'mono-label', title: 'Shared by the preview, every card and Add' });
  const seedBox = h(
    'div',
    { class: 'gen-seedbox', id: 'mutate-seedbox' },
    h('span', {}, 'Seed'),
    seedLabel,
    h('button', { id: 'mutate-reroll', class: 'small', 'aria-label': 'Reroll the seed', onclick: () => newSeed() }, 'Reroll'),
  );
  const params = h(
    'div',
    { class: 'mut-params' },
    srcChip,
    h('div', { class: 'mut-title' }, title, hint),
    h('label', { class: 'mut-amount' }, h('span', {}, 'Amount'), amountInput, amountVal),
    seedBox,
  );

  const syncParams = () => {
    const m = info();
    title.textContent = `${m.group} › ${m.label}`;
    hint.textContent = `${m.hint} · 0% = unchanged`;
    hint.title = hint.textContent;
    seedBox.hidden = !seeded();
  };

  const syncAmount = () => {
    amountVal.textContent = pct(amount);
    relabelCards();
    syncShownLabel();
  };

  // ---- result over source ----
  const shownLabel = h('span', { class: 'mono-label', id: 'mutate-shown' });
  const waveC = h('canvas', { id: 'mutate-wave', role: 'img', 'aria-label': 'Shown waveform (solid) over the source (dashed)' });
  const specC = h('canvas', { id: 'mutate-spec', role: 'img', 'aria-label': 'Harmonic spectrum of the shown waveform over the source (grey)' });
  const axis = (...labels: string[]) => h('div', { class: 'gen-axis' }, ...labels.map((l) => h('span', {}, l)));
  const waveBox = h(
    'div',
    { class: 'gen-plot-box' },
    waveC,
    h(
      'div',
      { class: 'gen-plot-tags' },
      shownLabel,
      h(
        'span',
        { class: 'mut-legend', 'aria-hidden': 'true' },
        h('span', {}, h('i', { class: 'mut-key-src' }), 'source'),
        h('span', {}, h('i', { class: 'mut-key-res' }), 'result'),
      ),
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
      h('div', { class: 'gen-plot gen-plot-spec' }, specBox, axis('h1', 'grey = source', `h${SPEC_BINS}`)),
    ),
  );

  // ---- batch ----
  const modeButtons = MODES.map((m) =>
    h('button', { id: `mutate-mode-${m.mode}`, title: m.title, onclick: () => setMode(m.mode) }, m.label),
  );
  const stepper = buildStepper('mutate', opts);
  const shapeOn = buildShapeOnAdd(ctx, 'mutate', () => {
    for (const c of strip.cards) c.drawn = null;
    cardsDirty = mainDirty = true;
  });
  const addShownBtn = h('button', { id: 'mutate-add-shown', onclick: () => addShown() }, 'Add shown');
  const addBatchBtn = h('button', { id: 'mutate-add-batch', class: 'primary', onclick: () => addBatch() }, `Add +${opts.count()}`);
  const status = h('div', { class: 'gen-status', id: 'mutate-status', role: 'status' });
  const flash = flasher(status);
  const strip = buildStrip('mutate-strip', {
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
      shapeOn.el,
      h('div', { class: 'gen-adds' }, addShownBtn, addBatchBtn),
    ),
    strip.el,
  );

  const setMode = (m: SweepMode) => {
    mode = m;
    MODES.forEach((x, i) => {
      modeButtons[i].classList.toggle('seg-on', x.mode === m);
      modeButtons[i].setAttribute('aria-pressed', String(x.mode === m));
    });
    flash('');
    relabelCards();
    syncShownLabel();
  };

  const cardLabel = (i: number) => (mode === 'chain' ? `step ${i + 1}` : `a ${pct(batchAmountAt(request(), i))}`);
  const relabelCards = () => strip.resize(opts.count(), cardLabel);

  const syncShownLabel = () => {
    const n = opts.count();
    const i = strip.shown();
    shownLabel.textContent =
      mode === 'chain' ? `#${i + 1} of ${n} · amount ${pct(amount)} × ${i + 1}` : `#${i + 1} of ${n} · amount ${pct(batchAmountAt(request(), i))}`;
  };

  const newSeed = () => {
    seed = randomSeed();
    seedLabel.textContent = hex(seed);
  };

  // ---- preview job ----
  let job: Job | null = null;
  let lastStart = -Infinity;

  const startJob = (): Job | null => {
    const src = source();
    const req = request();
    job = src ? { key: keyOf(src, req), req, source: src, tables: new Array(req.count), next: 0 } : null;
    cardsDirty = mainDirty = true;
    return job;
  };

  /** The job for the current request (started synchronously if needed), or null. */
  const currentJob = (): Job | null => (job?.key === keyOf(source(), request()) ? job : startJob());

  /** Compute table i (and, for a chain, every missing table before it). */
  const computeOne = (j: Job, i: number): GeneratedTable => {
    let k = j.req.mode === 'chain' ? 0 : i;
    while (j.tables[k] && k < i) k++;
    for (; k <= i; k++) {
      if (j.tables[k]) continue;
      j.tables[k] = mutateBatchTable(j.req, j.source, k, j.tables[k - 1]?.data);
      cardsDirty = true;
      if (k === strip.shown()) mainDirty = true;
    }
    return j.tables[i]!;
  };

  /** Shown table first (a sweep table is independent; a chain computes in order), then the rest. */
  const work = (j: Job, deadline: number) => {
    const shown = Math.min(strip.shown(), j.req.count - 1);
    if (j.req.mode !== 'chain') computeOne(j, shown);
    while (j.next < j.req.count && performance.now() < deadline) computeOne(j, j.next++);
  };

  /** Table i as shown and added: shaped when a Shape chain is chosen (a Chain sweep continues from the unshaped one). */
  const shaped = (j: Job, t: GeneratedTable | undefined, i: number) => t && shapeOn.apply(t, { index: i, count: j.req.count });
  const finalTable = (j: Job, i: number): GeneratedTable => shaped(j, computeOne(j, i), i)!;

  // ---- actions ----
  const afterAdd = (msg: string) => {
    if (seeded()) {
      newSeed();
      flash(`${msg} · new seed`);
    } else flash(msg);
  };

  const addShown = () => {
    const j = currentJob();
    if (!j) return;
    const i = strip.shown();
    if (!model.addTables([finalTable(j, i)], true).length) return; // refused (Timeline full): the notice says why
    afterAdd(`Added #${i + 1} to the Timeline (now the source)`);
  };

  const addBatch = () => {
    const j = currentJob();
    if (!j) return;
    const tables = Array.from({ length: j.req.count }, (_, i) => finalTable(j, i));
    // Select the last added table (the end of the batch): it becomes the next source.
    if (!model.addTables(tables, true).length) return; // refused: keep the seed
    afterAdd(`Added ${tables.length} waveform${tables.length > 1 ? 's' : ''} to the Timeline (the last is now the source)`);
  };

  // ---- drawing ----
  // Until a restarted preview has produced a table (new source, amount, mode, …), the
  // last good frame stays drawn: never an old result over a new source, no flicker.
  // Only a missing source clears the views.
  let drawnSrc: WaveTable | null | undefined;
  const drawMain = () => {
    mainDirty = false;
    const src = source();
    const si = job ? Math.min(strip.shown(), job.req.count - 1) : 0;
    const t = job && src && job.source === src ? shaped(job, job.tables[si], si) : undefined;
    if (src && !t) return; // redrawn when computeOne() produces the shown table
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
    if (src) {
      g.setLineDash([5, 4]);
      drawWave(g, 0, 0, w, hh, src.data, cssColor('--muted'), { lineWidth: 1.25 });
      g.setLineDash([]);
    }
    if (data) drawWave(g, 0, 0, w, hh, data, cssColor('--wave'), { lineWidth: 2 });
    const [gs, sw, sh] = fit(specC, Math.max(30, specBox.clientHeight || 90));
    gs.strokeStyle = grid;
    gs.beginPath();
    for (const f of [1 / 3, 2 / 3]) {
      gs.moveTo(0, Math.round(sh * f) + 0.5);
      gs.lineTo(sw, Math.round(sh * f) + 0.5);
    }
    gs.stroke();
    if (src) drawSpectrum(gs, sw, sh, src.data, cssColor('--border-strong'), { bins: SPEC_BINS });
    if (data) {
      gs.globalAlpha = 0.85;
      drawSpectrum(gs, sw, sh, data, cssColor('--accent'), { bins: SPEC_BINS });
      gs.globalAlpha = 1;
    }
  };

  const drawCards = () => {
    cardsDirty = false;
    const src = source();
    const cur = job && job.source === src ? job : null;
    const deadline = performance.now() + SHAPE_CARDS_MS;
    strip.cards.forEach((c, i) => {
      const raw = cur && i < cur.req.count ? cur.tables[i] : undefined;
      // Shaping (Shape chip) within a per-frame budget: the rest next frame.
      const t = raw && shapeOn.applyWithin(raw, { index: i, count: cur!.req.count }, deadline);
      if (raw && !t) cardsDirty = true;
      // Keep the previous drawing until the current job has computed this card.
      if (c.drawn === t || (!t && src)) return;
      c.drawn = t;
      drawCard(c, t?.data);
    });
  };

  const drawSource = () => {
    srcDirty = false;
    const src = source();
    drawnSrc = src ?? null;
    const idx = model.indexOf(model.selectedId);
    srcNo.textContent = src ? `#${idx + 1}` : '—';
    srcChip.title = src ? `The Timeline selection: #${idx + 1} · id ${src.id} · ${describeRecipe(src.recipe)}` : 'Select a waveform in the Timeline';
    // Timeline full (every waveform used by a wavetable): adds are refused.
    const room1 = model.roomFor(1);
    const roomN = model.roomFor(opts.count());
    addShownBtn.disabled = !src || !room1;
    addBatchBtn.disabled = !src || !roomN;
    addShownBtn.title = room1 ? '' : model.fullMessage();
    addBatchBtn.title = roomN ? '' : model.fullMessage();
    const g = fitFixed(srcThumb, SRC_W, SRC_H);
    if (src) drawWave(g, 0, 0, SRC_W, SRC_H, src.data, cssColor('--wave'), { lineWidth: 1.2, points: SRC_W * 2 });
  };

  // Library thumbnails: each mutation applied to the source at the current amount (and
  // seed). Restarted at most every THUMBS_MS; only entries scrolled into view, within
  // the frame budget; old drawings stay until replaced.
  const thumbDrawn: string[] = MUTATION_CHOICES.map(() => '');
  let thumbTarget = '';
  let thumbTargetAt = -Infinity;
  const thumbKey = () => `${source()?.id ?? 'none'}|${amount}|${seed}`;
  const drawThumbs = (now: number, deadline: number) => {
    const src = source();
    const target = thumbKey();
    if (target !== thumbTarget) {
      if (now - thumbTargetAt < THUMBS_MS) return; // stay dirty; retried next frame
      thumbTarget = target;
      thumbTargetAt = now;
    }
    const [srcId, a, s] = thumbTarget.split('|');
    const thumbSrc = src && String(src.id) === srcId ? src : undefined;
    const normal = cssColor('--text-2');
    const current = cssColor('--accent-text');
    const ghost = cssColor('--border-strong');
    let pending = false;
    for (const i of lib.inView()) {
      const m = MUTATION_CHOICES[i];
      const color = i === sel ? current : normal;
      const want = `${srcId}|${a}|${'seeded' in m ? s : ''}|${color}`;
      if (thumbDrawn[i] === want) continue;
      if (performance.now() > deadline) {
        pending = true;
        break;
      }
      const g = fitFixed(lib.thumbs[i], THUMB_W, THUMB_H);
      if (thumbSrc) {
        drawWave(g, 0, 0, THUMB_W, THUMB_H, thumbSrc.data, ghost, { lineWidth: 1, points: THUMB_W * 2 });
        const out = mutate(m.id, thumbSrc.data, Number(a), Number(s));
        drawWave(g, 0, 0, THUMB_W, THUMB_H, out, color, { lineWidth: 1.2, points: THUMB_W * 2 });
      }
      thumbDrawn[i] = want;
    }
    thumbsDirty = pending || thumbTarget !== target;
  };

  // ---- assembly ----
  const el = h(
    'div',
    { role: 'tabpanel', id: 'panel-mutate', class: 'gen-tab mutate' },
    lib.el,
    h('div', { class: 'gen-main' }, params, viewer, batchBox),
  );
  watchVisibility(el);

  opts.onCount((n) => {
    const atEnd = strip.shown() >= strip.cards.length - 1;
    stepper.sync(n);
    addBatchBtn.textContent = `Add +${n}`;
    srcDirty = true;
    relabelCards();
    if (atEnd) strip.setShown(n - 1);
    syncShownLabel();
    cardsDirty = mainDirty = true;
    flash('');
  });
  const onSource = () => {
    srcDirty = mainDirty = thumbsDirty = true;
  };
  model.on('timeline', onSource);
  model.on('selection', onSource);
  model.on('wavetables', () => (srcDirty = true));
  onThemeChange(() => {
    thumbDrawn.fill('');
    for (const c of strip.cards) c.drawn = null;
    thumbsDirty = cardsDirty = mainDirty = srcDirty = true;
  });
  new ResizeObserver(() => (mainDirty = true)).observe(viewer);

  syncParams();
  setMode(mode);
  strip.setShown(opts.count() - 1);
  syncAmount();
  newSeed();

  return {
    el,
    view: {
      preview() {
        const cur = job && job.key === keyOf(source(), request()) ? job : null;
        return cur ? previewOf(cur.tables, shapeOn, strip.shown()) : null;
      },
      frame(now) {
        if (!opts.active() || !isOnScreen(el)) return;
        const deadline = performance.now() + BUDGET_MS;
        const src = source();
        const key = keyOf(src, request());
        if (job?.key !== key && now - lastStart >= PREVIEW_MS) {
          lastStart = now;
          startJob();
        }
        if (job?.key === key) work(job, deadline);
        if (srcDirty || drawnSrc !== (src ?? null)) drawSource();
        if (mainDirty) drawMain();
        if (cardsDirty) drawCards();
        if (thumbsDirty || thumbKey() !== thumbTarget) drawThumbs(now, deadline + 4);
      },
    },
  };
}
