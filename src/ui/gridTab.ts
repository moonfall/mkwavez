/**
 * Generate → Grid: a 2D block of waveforms from two batch operations (core/grid.ts). The
 * columns are another tab's batch (exactly what its Add +N would add, Shape chip included)
 * or the Last batch already in the Timeline; the rows apply a Mutate sweep or a Shape chain
 * to each column. Preview: the whole grid as thumbnails, the selected cell large with what
 * made it. Add grid adds every waveform as one batch (one undo step, replayable recipes:
 * a row table's parent is its column) and places it: into a new 2D wavetable (the selected
 * voice then plays it), the selected voice's window on its 2D wavetable, or a wavetable's
 * write window. An existing window sets the grid's size (N = its width, rows = its height).
 * Cells compute in the frame loop (BUDGET_MS per frame) only while the tab is showing.
 */
import { columnRef, gridDims, gridLimit, gridRowTable, gridXY, GRID_MAX, opRows, row1Fits, rowOpVaries, type GridRowOp } from '../core/grid';
import { MUTATION_CHOICES, mutationUsesSeed, type MutationId, type SweepMode } from '../core/mutations';
import { randomSeed } from '../core/prng';
import { chainJson, chainSweeps, EMPTY_CHAIN, type ShapeChain } from '../core/shapeChain';
import { FACTORY_CHAINS } from '../core/shapeFactory';
import { describeRecipe, type GeneratedTable, type TableId, type WaveTable } from '../core/table';
import { LAST_BATCH_WAVETABLE_ID, wavetableDims, writeWindowOf, type WavetableId } from '../core/wavetable';
import { buildStepper, flasher } from './batch';
import { cssColor, drawWave, fit, onThemeChange } from './canvas';
import { isOnScreen, watchVisibility, type GenerateView, type UiContext } from './context';
import { h } from './dom';

const BUDGET_MS = 8;
const PLOT_H = 56;
const SOURCES = ['Seed', 'Mutate', 'Breed', 'Shape', 'last'] as const;
type Source = (typeof SOURCES)[number];
const SOURCE_LABEL: Record<Source, string> = { Seed: 'Seed tab’s batch', Mutate: 'Mutate tab’s batch', Breed: 'Breed tab’s batch', Shape: 'Shape tab’s batch', last: 'Last batch (Timeline)' };
const MODES: { mode: SweepMode; label: string; title: string }[] = [
  { mode: 'lin', label: 'Linear', title: 'Row i of n uses amount A·i/n (the last row is A)' },
  { mode: 'log', label: 'Log', title: 'Log sweep up to A: fine steps at small amounts' },
  { mode: 'chain', label: 'Chain', title: 'Each row mutates the previous one at A' },
];
const ROW_MUTATIONS = MUTATION_CHOICES.filter((m) => m.id !== 'breed');
const DEFAULT_CHAIN_CHOICE = `f:${(FACTORY_CHAINS.find((f) => chainSweeps(f.chain)) ?? FACTORY_CHAINS[0]).id}`;

export interface GridPanelOpts {
  count(): number;
  setCount(n: number): void;
  onCount(fn: (n: number) => void): void;
  active(): boolean;
  /** The other Generate tabs (their batch is the columns). */
  sources: Readonly<Record<Exclude<Source, 'last'>, GenerateView>>;
  setTab(name: string): void;
}

interface Prefs {
  source: Source;
  rowKind: 'mutate' | 'shape';
  mutation: MutationId;
  amount: number;
  mode: SweepMode;
  chain: string;
  rows: number;
  swap: boolean;
}
const DEFAULTS: Prefs = { source: 'Seed', rowKind: 'shape', mutation: 'fold', amount: 0.6, mode: 'lin', chain: DEFAULT_CHAIN_CHOICE, rows: 8, swap: false };

/** Where the grid goes. */
type Into =
  | { kind: 'new'; label: string }
  | { kind: 'cells'; value: string; label: string; wtId: WavetableId; x0: number; y0: number; w: number; h: number };

interface Job {
  key: string;
  cols: readonly WaveTable[];
  op: GridRowOp;
  n: number;
  /** cells[c][j] = row table j of column c (j < n). */
  cells: (GeneratedTable | undefined)[][];
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const hex = (s: number) => (s >>> 0).toString(16).padStart(8, '0');

export function buildGridPanel(ctx: UiContext, opts: GridPanelOpts): { el: HTMLElement; view: GenerateView } {
  const { model, ui } = ctx;

  // ---- state (UI prefs, saved with the session) ----
  const loadPrefs = (): Prefs => {
    const raw = ui.pref('grid', {}, (v) => !!v && typeof v === 'object') as Partial<Prefs>;
    const p = { ...DEFAULTS, ...raw };
    if (!SOURCES.includes(p.source)) p.source = DEFAULTS.source;
    if (p.rowKind !== 'mutate' && p.rowKind !== 'shape') p.rowKind = DEFAULTS.rowKind;
    if (!ROW_MUTATIONS.some((m) => m.id === p.mutation)) p.mutation = DEFAULTS.mutation;
    if (!MODES.some((m) => m.mode === p.mode)) p.mode = DEFAULTS.mode;
    p.amount = Number.isFinite(p.amount) ? Math.max(0, Math.min(1, p.amount)) : DEFAULTS.amount;
    p.rows = Number.isFinite(p.rows) ? Math.max(1, Math.min(GRID_MAX, Math.round(p.rows))) : DEFAULTS.rows;
    p.swap = !!p.swap;
    if (typeof p.chain !== 'string') p.chain = DEFAULTS.chain;
    return p;
  };
  let P = loadPrefs();
  const save = () => ui.setPref('grid', { ...P });
  const set = (patch: Partial<Prefs>) => {
    P = { ...P, ...patch };
    save();
    syncAll();
  };
  let seed = randomSeed();
  let row1 = true;
  /** The row operation row 1 was last chosen automatically for (the user may override it). */
  let row1For = '';
  let into = 'new';
  let selCell = { c: 0, r: 0 };

  const resolveChain = (v: string): ShapeChain | null => {
    if (v === 'tab') return model.shapeChain;
    if (v.startsWith('f:')) return FACTORY_CHAINS.find((f) => `f:${f.id}` === v)?.chain ?? null;
    if (v.startsWith('u:')) return model.shapeChains.find((c) => `u:${c.id}` === v)?.chain ?? null;
    return null;
  };
  const chainOf = () => resolveChain(P.chain) ?? resolveChain(DEFAULT_CHAIN_CHOICE) ?? EMPTY_CHAIN;
  const rowOp = (): GridRowOp =>
    P.rowKind === 'mutate' ? { kind: 'mutate', mutation: P.mutation, amount: P.amount, mode: P.mode, seed } : { kind: 'shape', chain: chainOf() };
  const opKey = (op: GridRowOp) => (op.kind === 'mutate' ? `m|${op.mutation}|${op.amount}|${op.mode}|${op.seed}` : `s|${chainJson(op.chain)}`);

  // ---- columns ----
  const objIds = new WeakMap<object, number>();
  let nextObj = 1;
  const objId = (o: object) => {
    let i = objIds.get(o);
    if (!i) objIds.set(o, (i = nextObj++));
    return i;
  };
  type Cols = { cols: WaveTable[]; fresh: readonly GeneratedTable[] | null } | { wait: true } | { error: string };
  let colsCache: { key: string; v: Cols } | null = null;
  /** The columns now (new tables carry placeholder ids columnRef(k)), computing within `deadline`. */
  const columns = (deadline: number): Cols => {
    if (P.source === 'last') {
      const ids = (model.wavetable(LAST_BATCH_WAVETABLE_ID)?.rows[0] ?? []).filter((x): x is TableId => x !== null);
      const cols = ids.map((id) => model.table(id)).filter((t): t is WaveTable => !!t);
      if (!cols.length) return { error: 'Last batch is empty: add a batch first' };
      return { cols, fresh: null };
    }
    const r = opts.sources[P.source].batch(deadline);
    if (!('tables' in r)) return r;
    const key = r.tables.map(objId).join(',');
    if (colsCache?.key === key) return colsCache.v;
    const v: Cols = { cols: r.tables.map((t, k) => ({ id: columnRef(k), data: t.data, recipe: t.recipe })), fresh: r.tables };
    colsCache = { key, v };
    return v;
  };

  // ---- into ----
  const voiceNo = (id: number) => `V${model.voiceIndex(id) + 1}`;
  const intoOptions = (): Into[] => {
    const out: Into[] = [];
    const v = ui.voiceId === null ? undefined : model.voice(ui.voiceId);
    out.push({ kind: 'new', label: `New 2D wavetable${v ? ` · ${voiceNo(v.id)} plays it` : ''}` });
    const vwt = v && model.wavetable(v.wavetableId);
    if (v && vwt && !vwt.builtin && vwt.shape === '2d') {
      const x0 = Math.min(v.windowStart, v.windowEnd);
      const y0 = Math.min(v.windowStartY, v.windowEndY);
      const w = Math.abs(v.windowEnd - v.windowStart) + 1;
      const hh = Math.abs(v.windowEndY - v.windowStartY) + 1;
      out.push({ kind: 'cells', value: `voice:${v.id}`, label: `${voiceNo(v.id)}’s window on “${vwt.name}” (${w} × ${hh})`, wtId: vwt.id, x0, y0, w, h: hh });
    }
    for (const wt of model.wavetables) {
      if (wt.builtin || wt.shape !== '2d') continue;
      const win = writeWindowOf(wt);
      if (!win) continue;
      const w = win.x1 - win.x0 + 1;
      const hh = win.y1 - win.y0 + 1;
      out.push({ kind: 'cells', value: `win:${wt.id}`, label: `“${wt.name}” write window (${w} × ${hh})`, wtId: wt.id, x0: win.x0, y0: win.y0, w, h: hh });
    }
    return out;
  };
  const intoNow = (): Into => {
    const o = intoOptions();
    return o.find((x) => (x.kind === 'new' ? 'new' : x.value) === into) ?? o[0];
  };
  /** The grid size a window target needs (columns × rows), or null for a new wavetable. */
  const needed = (t: Into) => (t.kind === 'cells' ? (P.swap ? { cols: t.h, rows: t.w } : { cols: t.w, rows: t.h }) : null);
  /** Size the grid to the target window: N (the shared batch size) and rows. */
  const fitToTarget = () => {
    const nd = needed(intoNow());
    if (!nd) return;
    if (P.source !== 'last' && opts.count() !== nd.cols) opts.setCount(nd.cols);
    if (P.rows !== nd.rows) {
      P = { ...P, rows: Math.min(GRID_MAX, nd.rows) };
      save();
    }
  };

  // ---- controls: columns ----
  const srcSelect = h(
    'select',
    { id: 'grid-source', 'aria-label': 'Columns from' },
    ...SOURCES.map((s) => h('option', { value: s }, SOURCE_LABEL[s])),
  );
  srcSelect.addEventListener('change', () => {
    set({ source: srcSelect.value as Source });
    fitToTarget();
  });
  const stepper = buildStepper('grid', opts);
  const editSrc = h('button', { class: 'small', id: 'grid-edit-source', onclick: () => P.source !== 'last' && opts.setTab(P.source) }, 'Edit');
  const colsInfo = h('span', { class: 'grid-info', id: 'grid-cols-info' });
  const colsBox = h(
    'div',
    { class: 'gen-box grid-box' },
    h('div', { class: 'gen-box-head' }, h('span', { class: 'gen-h' }, 'Columns'), srcSelect),
    h('div', { class: 'grid-row' }, stepper.el, colsInfo, editSrc),
  );

  // ---- controls: rows ----
  const kindBtns = (['mutate', 'shape'] as const).map((k) =>
    h('button', { id: `grid-rows-${k}`, onclick: () => set({ rowKind: k }) }, k === 'mutate' ? 'Mutate' : 'Shape'),
  );
  const mutSelect = h('select', { id: 'grid-mutation', 'aria-label': 'Mutation' }, ...ROW_MUTATIONS.map((m) => h('option', { value: m.id }, `${m.group} › ${m.label}`)));
  mutSelect.addEventListener('change', () => set({ mutation: mutSelect.value as MutationId }));
  const amountInput = h('input', { type: 'range', id: 'grid-amount', min: 0, max: 1, step: 0.01, 'aria-label': 'Amount' });
  const amountVal = h('span', { class: 'mut-amount-val', id: 'grid-amount-val' });
  amountInput.addEventListener('input', () => set({ amount: Number(amountInput.value) }));
  const modeBtns = MODES.map((m) => h('button', { id: `grid-mode-${m.mode}`, title: m.title, onclick: () => set({ mode: m.mode }) }, m.label));
  const seedLabel = h('span', { class: 'mono-label', id: 'grid-seed' });
  const seedBox = h(
    'div',
    { class: 'gen-seedbox', id: 'grid-seedbox' },
    h('span', {}, 'Seed'),
    seedLabel,
    h('button', { class: 'small', id: 'grid-reroll', onclick: () => ((seed = randomSeed()), syncAll()) }, 'Reroll'),
  );
  const mutBox = h(
    'div',
    { class: 'grid-op', id: 'grid-op-mutate' },
    mutSelect,
    h('label', { class: 'mut-amount' }, h('span', {}, 'Amount'), amountInput, amountVal),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Sweep mode' }, ...modeBtns),
    seedBox,
  );
  const chainSelect = h('select', { id: 'grid-chain', 'aria-label': 'Shape chain' });
  chainSelect.addEventListener('change', () => set({ chain: chainSelect.value }));
  const shapeBox = h('div', { class: 'grid-op', id: 'grid-op-shape' }, chainSelect);
  const rowsInput = h('input', { type: 'number', id: 'grid-rows', min: 1, max: GRID_MAX, step: 1, inputmode: 'numeric', 'aria-label': 'Rows' });
  rowsInput.addEventListener('change', () => {
    const v = Math.round(Number(rowsInput.value));
    if (Number.isFinite(v)) set({ rows: Math.max(1, Math.min(GRID_MAX, v)) });
  });
  const rowsDec = h('button', { id: 'grid-rows-dec', 'aria-label': 'Fewer rows', onclick: () => set({ rows: Math.max(1, P.rows - 1) }) }, '−');
  const rowsInc = h('button', { id: 'grid-rows-inc', 'aria-label': 'More rows', onclick: () => set({ rows: Math.min(GRID_MAX, P.rows + 1) }) }, '+');
  const rowsStepper = h('div', { class: 'gen-stepper', role: 'group', 'aria-label': 'Rows' }, rowsDec, h('label', { class: 'gen-n-label' }, 'Rows', rowsInput), rowsInc);
  const row1Box = h('input', { type: 'checkbox', id: 'grid-row1' });
  row1Box.addEventListener('change', () => {
    row1 = row1Box.checked;
    syncAll();
  });
  const swapBtn = h('button', { class: 'small', id: 'grid-swap', 'aria-pressed': 'false', title: 'Swap axes: columns down the Y axis, rows across X', onclick: () => (set({ swap: !P.swap }), fitToTarget(), syncAll()) }, '⇄ Swap');
  const opWarn = h('span', { class: 'grid-info warn', id: 'grid-op-warn' });
  const rowsBox = h(
    'div',
    { class: 'gen-box grid-box' },
    h('div', { class: 'gen-box-head' }, h('span', { class: 'gen-h' }, 'Rows'), h('div', { class: 'seg', role: 'group', 'aria-label': 'Row operation' }, ...kindBtns)),
    mutBox,
    shapeBox,
    opWarn,
    rowsStepper,
    h('div', { class: 'grid-row' }, h('label', { class: 'grid-check', title: 'Row 1 of the grid is the columns themselves (the row operation fills the rows after it)' }, row1Box, 'Row 1 = columns'), swapBtn),
  );

  // ---- controls: into + add ----
  const intoSelect = h('select', { id: 'grid-into', 'aria-label': 'Into' });
  intoSelect.addEventListener('change', () => {
    into = intoSelect.value;
    fitToTarget();
    syncAll();
  });
  const addBtn = h('button', { class: 'primary', id: 'grid-add-batch', 'aria-keyshortcuts': 'A N', onclick: () => addGrid() }, 'Add grid');
  const status = h('div', { class: 'gen-status', id: 'grid-status', role: 'status' });
  const flash = flasher(status);

  // ---- preview ----
  const canvas = h('canvas', { id: 'grid-canvas', role: 'img', 'aria-label': 'The grid: click a cell to see it', title: 'Click a cell to see it' });
  const plot = h('canvas', { id: 'grid-cell', role: 'img', 'aria-label': 'The selected cell (solid) over its column (grey)' });
  const cellInfo = h('span', { class: 'grid-info', id: 'grid-cell-info' });
  const sizeInfo = h('span', { class: 'gen-h', id: 'grid-size' });
  const viewBox = h(
    'div',
    { class: 'gen-box grid-view' },
    h('div', { class: 'gen-box-head grid-head' }, sizeInfo, h('label', { class: 'grid-into' }, h('span', {}, 'Into'), intoSelect), h('div', { class: 'gen-adds' }, addBtn)),
    h('div', { class: 'grid-canvas-box' }, canvas),
    h('div', { class: 'grid-cell-box' }, plot, h('div', { class: 'grid-row' }, cellInfo, status)),
  );

  const el = h(
    'div',
    { role: 'tabpanel', id: 'panel-grid', class: 'gen-tab grid' },
    colsBox,
    rowsBox,
    h('div', { class: 'gen-main' }, viewBox),
  );
  watchVisibility(el);

  // ---- job ----
  let job: Job | null = null;
  let colsState: Cols = { wait: true };
  let dirty = true;
  const nOp = () => opRows(P.rows, row1);
  const ensureJob = (c: WaveTable[]): Job => {
    const op = rowOp();
    const n = nOp();
    const key = `${c.map((t) => `${t.id}:${objId(t.data)}`).join(',')}|${opKey(op)}|${n}`;
    if (job?.key !== key) {
      job = { key, cols: c, op, n, cells: c.map(() => new Array(n)) };
      dirty = true;
    }
    return job;
  };
  const computeCell = (j: Job, c: number, k: number): GeneratedTable => {
    const col = j.cells[c];
    let i = j.op.kind === 'mutate' && j.op.mode === 'chain' ? 0 : k;
    while (i < k && col[i]) i++;
    for (; i <= k; i++) if (!col[i]) col[i] = gridRowTable(j.op, j.cols[c], i, j.n, col[i - 1]?.data);
    dirty = true;
    return col[k]!;
  };
  const work = (j: Job, deadline: number) => {
    // The selected cell's column first, then column by column.
    const order = [Math.min(selCell.c, j.cols.length - 1), ...j.cols.map((_, c) => c)];
    for (const c of order)
      for (let k = 0; k < j.n; k++) {
        if (j.cells[c][k]) continue;
        if (performance.now() > deadline) return;
        computeCell(j, c, k);
      }
  };
  const doneCount = (j: Job) => j.cells.reduce((a, col) => a + col.filter(Boolean).length, 0);
  /** Data of cell (c, r) of the grid (row 0 = the column with row 1 on), if computed. */
  const cellData = (j: Job, c: number, r: number): Float32Array | undefined => (row1 ? (r === 0 ? j.cols[c].data : j.cells[c][r - 1]?.data) : j.cells[c][r]?.data);

  // ---- sync ----
  let chainKey = '';
  const syncChainOptions = () => {
    const key = JSON.stringify([model.shapeChain.name, model.shapeChains.map((c) => [c.id, c.chain.name])]);
    if (key === chainKey) {
      chainSelect.value = resolveChain(P.chain) ? P.chain : DEFAULT_CHAIN_CHOICE;
      return;
    }
    chainKey = key;
    const opt = (v: string, label: string) => h('option', { value: v }, label);
    const items = [
      opt('tab', `Shape tab: ${model.shapeChain.name}`),
      h('optgroup', { label: 'Factory' }, ...FACTORY_CHAINS.map((f) => opt(`f:${f.id}`, f.chain.name))),
      ...(model.shapeChains.length ? [h('optgroup', { label: 'Yours' }, ...model.shapeChains.map((c) => opt(`u:${c.id}`, c.chain.name)))] : []),
    ];
    chainSelect.replaceChildren(...items);
    chainSelect.value = resolveChain(P.chain) ? P.chain : DEFAULT_CHAIN_CHOICE;
  };
  let intoKey = '';
  const syncInto = () => {
    const o = intoOptions();
    const cur = intoNow();
    const val = cur.kind === 'new' ? 'new' : cur.value;
    into = val;
    const cols = colsState && 'cols' in colsState ? colsState.cols.length : opts.count();
    const { w, h: hh } = gridDims(cols, P.rows, P.swap);
    const items = o.map((x) => [x.kind === 'new' ? 'new' : x.value, x.kind === 'new' ? x.label.replace('New 2D wavetable', `New 2D wavetable (${w} × ${hh})`) : x.label]);
    // Rebuilt only when it changes (an open list would close).
    const key = JSON.stringify(items);
    if (key !== intoKey) {
      intoKey = key;
      intoSelect.replaceChildren(...items.map(([v, l]) => h('option', { value: v }, l)));
    }
    intoSelect.value = val;
  };
  const syncAll = () => {
    srcSelect.value = P.source;
    editSrc.hidden = P.source === 'last';
    editSrc.textContent = P.source === 'last' ? 'Edit' : `Edit in ${P.source}`;
    stepper.el.hidden = P.source === 'last';
    kindBtns.forEach((b, i) => {
      const on = (i === 0 ? 'mutate' : 'shape') === P.rowKind;
      b.classList.toggle('seg-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    mutBox.hidden = P.rowKind !== 'mutate';
    shapeBox.hidden = P.rowKind !== 'shape';
    mutSelect.value = P.mutation;
    if (document.activeElement !== amountInput) amountInput.value = String(P.amount);
    amountVal.textContent = pct(P.amount);
    modeBtns.forEach((b, i) => {
      const on = MODES[i].mode === P.mode;
      b.classList.toggle('seg-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    seedLabel.textContent = hex(seed);
    seedBox.hidden = !mutationUsesSeed(P.mutation);
    syncChainOptions();
    const fixedSize = !!needed(intoNow());
    if (document.activeElement !== rowsInput) rowsInput.value = String(P.rows);
    rowsInput.disabled = rowsDec.disabled = rowsInc.disabled = fixedSize;
    rowsStepper.title = fixedSize ? 'The target window sets the number of rows' : '';
    swapBtn.setAttribute('aria-pressed', String(P.swap));
    swapBtn.classList.toggle('seg-on', P.swap);
    row1Box.checked = row1;
    const op = rowOp();
    opWarn.textContent = rowOpVaries(op)
      ? ''
      : op.kind === 'mutate'
        ? 'Amount 0: every row would be the same as its column.'
        : 'This chain doesn’t sweep: every row would be the same. Turn on a sweep in the Shape tab, or pick another chain.';
    syncInto();
    dirty = true;
  };

  /** Why Add grid can't run now, or null. */
  const blocked = (): string | null => {
    if ('error' in colsState) return colsState.error;
    if (!('cols' in colsState)) return 'Computing the columns…';
    const nc = colsState.cols.length;
    const lim = gridLimit(nc, P.rows);
    if (lim) return lim;
    const t = intoNow();
    const nd = needed(t);
    if (nd && (nd.cols !== nc || nd.rows !== P.rows)) return `The window needs ${nd.cols} columns × ${nd.rows} rows; the columns are ${nc}${P.source === 'last' ? ' (Last batch)' : ''}`;
    const total = (colsState.fresh ? nc : 0) + nc * nOp();
    if (!model.roomFor(total)) return model.fullMessage();
    return null;
  };

  const syncStatus = () => {
    const b = blocked();
    addBtn.disabled = !!b;
    addBtn.title = b ?? '';
    const nc = 'cols' in colsState ? colsState.cols.length : 0;
    const n = nc * P.rows;
    addBtn.textContent = nc ? `Add grid (${n})` : 'Add grid';
    colsInfo.textContent =
      'error' in colsState ? colsState.error : 'cols' in colsState ? `${nc} column${nc === 1 ? '' : 's'}${P.source === 'last' ? ' from the Timeline' : ''}` : 'computing…';
    colsInfo.classList.toggle('warn', 'error' in colsState);
    const { w, h: hh } = gridDims(nc, P.rows, P.swap);
    sizeInfo.textContent = nc ? `${w} × ${hh}` : '';
    sizeInfo.title = nc ? `The grid: ${w} × ${hh} (X × Y), ${n} waveforms` : '';
    el.dataset.ready = String(!!job && 'cols' in colsState && doneCount(job) === job.cols.length * job.n);
  };

  // ---- drawing ----
  let layout: { x0: number; y0: number; cw: number; ch: number; W: number; H: number } | null = null;
  const drawGrid = () => {
    const [g, cw0, ch0] = fit(canvas, Math.max(120, canvas.parentElement?.clientHeight || 240));
    g.clearRect(0, 0, cw0, ch0);
    layout = null;
    const j = job;
    if (!j || !('cols' in colsState)) return;
    const nc = j.cols.length;
    const { w: W, h: H } = gridDims(nc, P.rows, P.swap);
    const gap = W > 16 || H > 16 ? 1 : 2;
    const cw = Math.max(2, Math.floor((cw0 - (W - 1) * gap) / W));
    const ch = Math.max(2, Math.floor((ch0 - (H - 1) * gap) / H));
    const x0 = Math.floor((cw0 - (W * cw + (W - 1) * gap)) / 2);
    const y0 = 0;
    layout = { x0, y0, cw: cw + gap, ch: ch + gap, W, H };
    const cCell = cssColor('--surface-2');
    const cWave = cssColor('--wave');
    const cBorder = cssColor('--border');
    const cSel = cssColor('--accent');
    for (let c = 0; c < nc; c++)
      for (let r = 0; r < P.rows; r++) {
        const { x, y } = gridXY(c, r, P.swap);
        const px = x0 + x * (cw + gap);
        const py = y0 + y * (ch + gap);
        g.fillStyle = cCell;
        g.fillRect(px, py, cw, ch);
        const d = cellData(j, c, r);
        if (d && cw >= 6 && ch >= 6) drawWave(g, px + 1, py + 1, cw - 2, ch - 2, d, cWave, { points: Math.min(48, Math.max(12, cw)), lineWidth: 1 });
        if (row1 && r === 0) {
          g.strokeStyle = cBorder;
          g.lineWidth = 1;
          g.strokeRect(px + 0.5, py + 0.5, cw - 1, ch - 1);
        }
        if (selCell.c === c && selCell.r === r) {
          g.strokeStyle = cSel;
          g.lineWidth = 2;
          g.strokeRect(px + 1, py + 1, cw - 2, ch - 2);
        }
      }
  };
  const describeCell = (j: Job, c: number, r: number): string => {
    const col = j.cols[c];
    const colText = `Column ${c + 1}: ${describeRecipe(col.recipe)}`;
    if (row1 && r === 0) return `${colText} · row 1: the column itself`;
    const k = row1 ? r - 1 : r;
    const t = j.cells[c][k];
    let rowText: string;
    if (j.op.kind === 'mutate') {
      const m = ROW_MUTATIONS.find((x) => x.id === (j.op as { mutation: MutationId }).mutation);
      rowText = j.op.mode === 'chain' ? `${m?.label ?? ''} × ${k + 1} at ${pct(j.op.amount)}` : `${m?.label ?? ''} at ${pct(Number(t?.recipe.params.amount ?? 0))}`;
    } else rowText = `${j.op.chain.name} at ${pct(j.n > 1 ? k / (j.n - 1) : 0)}`;
    return `${colText} · row ${r + 1}: ${rowText}`;
  };
  const drawPlot = () => {
    const [g, w] = fit(plot, PLOT_H);
    g.clearRect(0, 0, w, PLOT_H);
    const j = job;
    if (!j || !('cols' in colsState) || selCell.c >= j.cols.length || selCell.r >= P.rows) {
      cellInfo.textContent = '';
      return;
    }
    const d = cellData(j, selCell.c, selCell.r);
    drawWave(g, 0, 0, w, PLOT_H, j.cols[selCell.c].data, cssColor('--border'), { lineWidth: 1 });
    if (d) drawWave(g, 0, 0, w, PLOT_H, d, cssColor('--wave'), { axis: cssColor('--border'), lineWidth: 1.5 });
    cellInfo.textContent = describeCell(j, selCell.c, selCell.r);
    cellInfo.title = cellInfo.textContent;
  };
  onThemeChange(() => (dirty = true));
  canvas.addEventListener('click', (e) => {
    if (!layout) return;
    const r = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left - layout.x0) / layout.cw);
    const y = Math.floor((e.clientY - r.top - layout.y0) / layout.ch);
    if (x < 0 || y < 0 || x >= layout.W || y >= layout.H) return;
    selCell = P.swap ? { c: y, r: x } : { c: x, r: y };
    dirty = true;
  });

  // ---- add ----
  const addGrid = () => {
    const b = blocked();
    if (b) return flash(b, true);
    if (!('cols' in colsState)) return;
    const cs = colsState;
    const j = ensureJob(cs.cols);
    for (let c = 0; c < j.cols.length; c++) for (let k = 0; k < j.n; k++) if (!j.cells[c][k]) computeCell(j, c, k);
    const t = intoNow();
    const v = ui.voiceId;
    const done = model.addGrid({
      columns: cs.fresh ? { kind: 'new', tables: cs.fresh } : { kind: 'existing', ids: cs.cols.map((x) => x.id) },
      rows: j.cells as GeneratedTable[][],
      row1,
      swap: P.swap,
      into: t.kind === 'new' ? { kind: 'new', voiceId: v } : { kind: 'cells', wtId: t.wtId, x0: t.x0, y0: t.y0 },
    });
    if (!done) return flash('Grid not added', true);
    const { w, h: hh } = wavetableDims(done);
    const n = j.cols.length * P.rows;
    flash(
      t.kind === 'new'
        ? `Added ${n} waveforms as “${done.name}” (${w} × ${hh})${v !== null && model.voice(v) ? `; ${voiceNo(v)} plays it` : ''}`
        : `Added ${n} waveforms into ${t.label}`,
    );
  };

  // ---- shared N, model changes ----
  opts.onCount((n) => {
    stepper.sync(n);
    dirty = true;
  });
  model.on('shape', () => syncAll());
  model.on('wavetables', () => syncInto());
  model.on('voices', () => syncInto());
  ui.onVoice(() => syncInto());
  ui.onPrefs(() => {
    const p = loadPrefs();
    if (JSON.stringify(p) !== JSON.stringify(P)) {
      P = p;
      syncAll();
    }
  });
  syncAll();
  stepper.sync(opts.count());

  return {
    el,
    view: {
      preview: () => null,
      batch: () => ({ error: 'Grid: use Add grid' }),
      frame() {
        if (!opts.active() || !isOnScreen(el)) return;
        const deadline = performance.now() + BUDGET_MS;
        const prev = colsState;
        colsState = columns(deadline);
        if (colsState !== prev) dirty = true;
        if ('cols' in colsState) {
          const j = ensureJob(colsState.cols);
          // Row 1: chosen automatically for each new row operation (the user may override it).
          const k = opKey(j.op);
          if (k !== row1For) {
            row1For = k;
            const fits = row1Fits(j.op, j.cols[0], P.rows);
            if (fits !== row1) {
              row1 = fits;
              row1Box.checked = row1;
              ensureJob(colsState.cols);
            }
          }
          if (selCell.c >= j.cols.length) selCell = { ...selCell, c: j.cols.length - 1 };
          if (selCell.r >= P.rows) selCell = { ...selCell, r: P.rows - 1 };
          work(job!, deadline);
        }
        if (dirty) {
          dirty = false;
          syncStatus();
          syncInto();
          drawGrid();
          drawPlot();
        }
      },
    },
  };
}
