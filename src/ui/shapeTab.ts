/**
 * Generate → Shape: edit waveforms with a chain of steps (core/shapeChain.ts). Left: the
 * chain (steps with an on/off toggle, a summary and a thumbnail of the wave after that
 * step; + Add step). Main: the source chip and the selected step's settings, a large plot
 * of that step alone (its input dashed, its output solid, its drawing in the draw colour)
 * in the Waveform or Harmonics view, the batch row and the result cards.
 *
 * The chain lives in the model (model.shapeChain; every edit an undo step, a drag or a
 * drawn stroke one). Results are computed in the frame loop through the same applyChain()
 * as Add (BUDGET_MS per frame, only while the tab shows), so Add appends exactly what is
 * shown. The source is the Timeline selection and stays selected after Add.
 */
import { compileRule } from '../browser/formulaEval';
import { KMAX } from '../core/constants';
import { harmonicMagnitudes } from '../core/fft';
import { compileRules, RuleError, rulesUseBatch } from '../core/generators/harmonicRules';
import { drawingSpan, drawingValue, StrokeBuffer, type Drawing, type DrawTool, type Pt } from '../core/drawing';
import { MUTATION_CHOICES, MUTATION_REV } from '../core/mutations';
import { randomSeed } from '../core/prng';
import {
  applyChain,
  batchUOf,
  chainJson,
  MAX_CHAIN_NAME,
  EMPTY_CHAIN,
  recipeChain,
  chainStages,
  ShapeStepError,
  chainSweeps,
  chainUsesSeed,
  freshStepId,
  MAX_STEPS,
  shapeRecipe,
  stepAmount,
  stepSeed,
  type BatchPos,
  type ShapeChain,
} from '../core/shapeChain';
import { chainsFile, FACTORY_CHAINS, parseChainsFile } from '../core/shapeFactory';
import {
  defaultDrawing,
  DEFAULT_LIMIT_DRAW,
  GAIN_RANGE,
  HARM_DB,
  harmonicSet,
  isDrawOp,
  KNEE_RANGE,
  LAW_RANGE,
  MOD_RANGES,
  newStep,
  RADIUS_RANGE,
  ROTATE_RANGE,
  rulesStepEval,
  STEP_INFO,
  stepInfo,
  stepUsesSeed,
  WAVE_Y,
  type HarmModKind,
  type ShapeStep,
  type StepOp,
} from '../core/shapeSteps';
import { describeRecipe, type GeneratedTable, type WaveTable } from '../core/table';
import { LAST_BATCH_WAVETABLE_ID, type Cell } from '../core/wavetable';
import { buildStepper, buildStrip, drawCard, flasher } from './batch';
import { cssColor, drawWave, fit, fitFixed, onThemeChange } from './canvas';
import { isOnScreen, watchVisibility, type GenerateView, type UiContext } from './context';
import { h } from './dom';
import { popupMenu } from './presets';
import { pitchBadge } from './pitchBadge';
import { chainEnv, chainError, previewOf } from './shapeOnAdd';
import { buildRulesEditor, ruleColor, type RulesEditor } from './rulesEditor';
import { downloadBytes, pickFile } from './session';
import { ask } from './dialogs';

/** Minimum interval between preview restarts while something is dragged. */
const PREVIEW_MS = 50;
/** Main-thread time per frame spent computing result cards. */
const BUDGET_MS = 8;
const THUMB_W = 40;
const THUMB_H = 18;
const SRC_W = 34;
const SRC_H = 20;
/** Pointer distance (CSS px) that grabs a drawing's point. */
const HIT_PX = 9;
/** Plot padding below the harmonic bars (set-membership dots). */
const DOTS_H = 7;

export interface ShapePanelOpts {
  /** Shared batch size N (also used by Seed / Mutate / Breed). */
  count(): number;
  setCount(n: number): void;
  onCount(fn: (n: number) => void): void;
  /** True while the Generate section is open and the Shape tab is showing. */
  active(): boolean;
}

type Step = ShapeStep;
type DrawStep = Extract<Step, { draw: Drawing }>;
type View = 'wave' | 'harm';

const hex = (s: number) => (s >>> 0).toString(16).padStart(8, '0');
const pct = (v: number) => `${Math.round(v * 100)}%`;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const TOOL_LABELS: Record<DrawTool, string> = { line: 'Line', curve: 'Curve', free: 'Free' };
const SET_LABELS = { multiples: 'Multiples of', list: 'List', odd: 'Odd', even: 'Even', primes: 'Primes', fibonacci: 'Fibonacci', drawn: 'Drawn bars' } as const;
const MODE_LABELS = { keep: 'Keep only', remove: 'Remove', add: 'Add', replace: 'Replace with' } as const;
const MOD_LABELS: Record<HarmModKind, string> = { shift: 'Shift', stretch: 'Stretch', tilt: 'Tilt', mirror: 'Mirror', randomize: 'Randomize' };
const LIMIT_LABELS = { limit: 'Limit', floor: 'Floor', fit: 'Fit', scale: 'Scale' } as const;
const SIDE_LABELS = { above: 'Above', below: 'Below', both: 'Both ±' } as const;

/** One line describing a step's settings (chain list). */
export function stepSummary(s: Step): string {
  if ('draw' in s && s.op !== 'harmLimit') {
    const tool = TOOL_LABELS[s.draw.tool];
    if (s.op === 'clip' || s.op === 'fold') return `${tool} · ${s.side}`;
    if (s.op === 'soft') return `${tool} · ${s.side} · knee ${s.knee.toFixed(2)}`;
    if (s.op === 'push' || s.op === 'pull') return `${tool} · radius ${s.radius.toFixed(2)}`;
    return tool;
  }
  switch (s.op) {
    case 'harmSet': {
      const set = s.set.kind === 'multiples' || s.set.kind === 'list' ? `${s.set.kind === 'multiples' ? 'multiples of ' : ''}${s.set.of.join(', ')}` : SET_LABELS[s.set.kind].toLowerCase();
      return `${MODE_LABELS[s.mode]} ${set}`;
    }
    case 'harmMod':
      return s.kind === 'tilt'
        ? `Tilt ${s.value} dB/oct`
        : s.kind === 'shift'
          ? `Shift ${s.value > 0 ? '+' : ''}${s.value}`
          : s.kind === 'stretch'
            ? `Stretch ×${s.value.toFixed(2)}`
            : s.kind === 'mirror'
              ? `Mirror h${s.range[0]}–${s.range[1]}`
              : `Randomize ${pct(s.value)}`;
    case 'harmLimit':
      return `${LIMIT_LABELS[s.mode]} · ${TOOL_LABELS[s.draw.tool].toLowerCase()}`;
    case 'rules': {
      const on = s.rules.filter((r) => r.on);
      if (!on.length) return 'no rules';
      const r = on[0];
      return `${r.when.trim() || 'always'} → ${r.value}${on.length > 1 ? ` (+${on.length - 1})` : ''}`;
    }
    case 'mutation':
      return MUTATION_CHOICES.find((m) => m.id === s.mutation)?.label ?? s.mutation;
    case 'gain':
      return `×${s.value.toFixed(2)}`;
    case 'rotate':
      return `${s.value > 0 ? '+' : ''}${s.value.toFixed(2)} cycle`;
    default:
      return '';
  }
}

/** A finished result job: the cards for one source + chain + N, computed incrementally. */
interface Job {
  key: string;
  /** Source of each result. */
  srcs: WaveTable[];
  chain: ShapeChain;
  n: number;
  tables: (GeneratedTable | undefined)[];
  /** Results that failed (a Rules step whose rule fails): the message. */
  errors: (string | undefined)[];
  next: number;
}

export function buildShapePanel(ctx: UiContext, opts: ShapePanelOpts): { el: HTMLElement; view: GenerateView } {
  const { model } = ctx;
  const chain = () => model.shapeChain;
  let selId: string | null = chain().steps[0]?.id ?? null;
  let view: View = 'wave';

  const selIndex = () => {
    const i = chain().steps.findIndex((s) => s.id === selId);
    return i >= 0 ? i : chain().steps.length ? 0 : -1;
  };
  const sel = (): Step | undefined => chain().steps[selIndex()];
  /** The Timeline selection (the source when applying to the selection). */
  const selected = (): WaveTable | undefined => model.table(model.selectedId);
  /** What the chain applies to: 'sel', 'last' (Last batch), `v:<voice id>` (its window) or `w:<wavetable id>`. */
  let applyTo = 'sel';
  let writeBack = false;
  interface Targets {
    tables: WaveTable[];
    /** Wavetable sources: the slot each table came from (for Write back). */
    cells?: Cell[];
    wtId?: number;
    label: string;
  }
  let targetsCache: { key: unknown[]; t: Targets } | null = null;
  const targets = (): Targets => {
    const key = [applyTo, model.timeline, model.wavetables, model.voices];
    if (targetsCache && targetsCache.key.every((k, i) => k === key[i])) return targetsCache.t;
    const fromWavetable = (id: number, label: string): Targets => {
      const wt = model.wavetable(id);
      const tables: WaveTable[] = [];
      const cells: Cell[] = [];
      wt?.rows.forEach((row, y) =>
        row.forEach((tid, x) => {
          const t = tid === null ? undefined : model.table(tid);
          if (t) {
            tables.push(t);
            cells.push({ x, y });
          }
        }),
      );
      return { tables, cells, wtId: id, label };
    };
    let t: Targets;
    if (applyTo === 'last') t = { ...fromWavetable(LAST_BATCH_WAVETABLE_ID, 'Last batch'), cells: undefined, wtId: undefined };
    else if (applyTo.startsWith('v:')) {
      const v = model.voice(Number(applyTo.slice(2)));
      t = { tables: v ? model.windowTables(v) : [], label: v ? `V${model.voiceIndex(v.id) + 1} window` : 'Voice window' };
    } else if (applyTo.startsWith('w:')) {
      const id = Number(applyTo.slice(2));
      t = fromWavetable(id, model.wavetable(id)?.name ?? 'Wavetable');
    } else {
      const sel = selected();
      t = { tables: sel ? [sel] : [], label: 'Selection' };
    }
    targetsCache = { key, t };
    return t;
  };
  const multi = () => applyTo !== 'sel';
  /** Results per Add: one per source; for the selection, N when a step sweeps or seeded steps vary, else 1. */
  const batchVaries = (c: ShapeChain) => chainSweeps(c) || (c.varySeed && chainUsesSeed(c));
  const batchN = () => (multi() ? Math.max(1, targets().tables.length) : batchVaries(chain()) ? opts.count() : 1);
  /** Source of result i (undefined: nothing to shape). */
  const srcFor = (i: number): WaveTable | undefined => (multi() ? targets().tables[i] : selected());
  /** The source of the shown card. */
  const source = (): WaveTable | undefined => srcFor(Math.min(strip.shown(), batchN() - 1));
  /** Whether results go back into the source wavetable's slots instead of only the Timeline. */
  const writingBack = () => {
    const t = targets();
    const wt = t.wtId === undefined ? undefined : model.wavetable(t.wtId);
    return writeBack && !!wt && !wt.builtin && !wt.live && !!t.cells && t.cells.length > 0;
  };

  /** Replace step `id` (an undo step; `gesture` coalesces a drag). */
  const updateStep = (id: string, fn: (s: Step) => Step, gesture?: string) => {
    const c = chain();
    model.setShapeChain({ ...c, steps: c.steps.map((s) => (s.id === id ? fn(s) : s)) }, gesture);
  };
  const setChain = (fn: (c: ShapeChain) => ShapeChain) => model.setShapeChain(fn(chain()));

  // Dirty flags (drawn in the frame loop).
  let mainDirty = true;
  let cardsDirty = true;
  let thumbsDirty = true;
  let srcDirty = true;

  // ---------------- chain column ----------------
  const chainPick = h('select', { id: 'shape-chains', class: 'shape-chain-pick', 'aria-label': 'Load a chain', title: 'Load a chain (undoable)' });
  /** The saved or factory chain the current one has the name of (null: none, or it was edited). */
  const namesake = () => model.savedChainNamed(chain().name)?.chain ?? FACTORY_CHAINS.find((f) => f.chain.name === chain().name)?.chain ?? null;
  const fillChainPick = () => {
    const ref = namesake();
    const edited = !ref || chainJson(ref) !== chainJson(chain());
    chainPick.replaceChildren(
      h('option', { value: '' }, `${chain().name}${edited && ref ? ' (edited)' : ''}`),
      h('optgroup', { label: 'Factory' }, ...FACTORY_CHAINS.map((f) => h('option', { value: `f:${f.id}` }, f.chain.name))),
      ...(model.shapeChains.length ? [h('optgroup', { label: 'Yours' }, ...model.shapeChains.map((c) => h('option', { value: `u:${c.id}` }, c.chain.name)))] : []),
    );
    chainPick.value = '';
  };
  const loadChain = (c: ShapeChain) => {
    model.setShapeChain(c);
    selId = c.steps[0]?.id ?? null;
    viewFor = null;
    syncAll();
    flash(`Loaded “${c.name}”`);
  };
  chainPick.addEventListener('change', () => {
    const v = chainPick.value;
    const c = v.startsWith('f:') ? FACTORY_CHAINS.find((x) => `f:${x.id}` === v)?.chain : model.shapeChains.find((x) => `u:${x.id}` === v)?.chain;
    chainPick.value = '';
    if (c) loadChain(c);
  });
  const chainFile = h('input', { type: 'file', id: 'shape-chain-file', accept: '.json,application/json', hidden: true });
  chainFile.addEventListener('change', async () => {
    const f = chainFile.files?.[0];
    chainFile.value = '';
    if (!f) return;
    try {
      const n = model.importShapeChains(parseChainsFile(await f.text()));
      flash(n ? `Imported ${n} chain${n === 1 ? '' : 's'}` : 'No chains imported (the list is full or the file is empty)', !n);
    } catch (e) {
      flash(`Import failed: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  });
  const chainMenuBtn = h('button', { id: 'shape-chain-menu', class: 'small icon-btn', 'aria-label': 'Chain actions', title: 'Save, rename, export / import chains; options' }, '⋯');
  const menuItem = (id: string, label: string, onclick: () => void, disabled = false, note = '') =>
    h('button', { id, role: 'menuitem', class: 'menu-item', disabled, onclick }, h('b', {}, label), note ? h('span', {}, note) : null);
  popupMenu('shape-chain-actions', chainMenuBtn, () => {
    const c = chain();
    const saved = model.savedChainNamed(c.name);
    const isFactory = !saved && FACTORY_CHAINS.some((f) => f.chain.name === c.name);
    const srcChain = (() => {
      const t = selected();
      return t ? recipeChain(t.recipe) : null;
    })();
    const saveAs = async () => {
      const name = await ask.prompt('Save the chain as', isFactory ? `${c.name} (mine)` : c.name);
      if (name === null) return;
      const nm = name.trim().slice(0, MAX_CHAIN_NAME);
      if (model.savedChainNamed(nm) && !(await ask.confirm(`Replace your saved chain “${nm}”?`))) return;
      const r = model.saveShapeChain(name);
      flash(r ? `Saved “${r.chain.name}”` : 'Not saved: the name is empty or your list is full', !r);
    };
    return [
      menuItem('shape-chain-save', saved ? `Save “${c.name}”` : 'Save…', () => {
        if (!saved || isFactory) return void saveAs();
        model.saveShapeChain(c.name);
        flash(`Saved “${c.name}”`);
      }),
      menuItem('shape-chain-saveas', 'Save as…', () => void saveAs()),
      menuItem('shape-chain-rename', 'Rename…', async () => {
        const name = await ask.prompt('Chain name', c.name);
        if (name !== null && name.trim()) setChain((x) => ({ ...x, name: name.trim() }));
      }),
      menuItem(
        'shape-chain-delete',
        saved ? `Delete “${saved.chain.name}”` : 'Delete saved chain',
        async () => {
          if (saved && (await ask.confirm(`Delete your saved chain “${saved.chain.name}”? (The chain being edited stays.)`))) model.deleteShapeChain(saved.id);
        },
        !saved,
      ),
      menuItem('shape-chain-new', 'New chain', () => loadChain({ ...EMPTY_CHAIN, seed: randomSeed() })),
      menuItem(
        'shape-chain-from-recipe',
        'Load the selection’s chain',
        () => srcChain && loadChain(srcChain),
        !srcChain,
        srcChain ? srcChain.name : 'the selection wasn’t shaped',
      ),
      menuItem('shape-chain-export', 'Export chains…', () => downloadBytes(new TextEncoder().encode(chainsFile([c, ...model.shapeChains.map((x) => x.chain).filter((x) => x.name !== c.name)])), 'mkwavez-shapes.json'), false, 'this one + yours'),
      menuItem('shape-chain-import', 'Import chains…', () => pickFile(chainFile)),
      menuItem('shape-chain-realign', `${c.realign ? '✓ ' : ''}Realign phase`, () => setChain((x) => ({ ...x, realign: !x.realign })), false, c.realign ? 'results in sine phase, like other waveforms' : 'results keep the drawn phase'),
    ];
  });
  const list = h('div', { id: 'shape-steps', class: 'shape-steps', role: 'listbox', 'aria-label': 'Steps (Alt+↑/↓ moves, Space turns on / off, Delete removes)' });
  const addBtn = h('button', { id: 'shape-add', class: 'shape-add', title: 'Add a step after the selected one' }, '+ Add step');
  const chainCol = h(
    'div',
    { class: 'gen-lib shape-chain' },
    h('div', { class: 'gen-lib-head' }, h('span', { class: 'gen-lib-title' }, 'Chain'), chainPick, chainMenuBtn, chainFile),
    list,
    h('div', { class: 'shape-chain-foot' }, addBtn),
  );

  const insertStep = (op: StepOp) => {
    const c = chain();
    if (c.steps.length >= MAX_STEPS) return flash(`A chain holds at most ${MAX_STEPS} steps`, true);
    const s = newStep(op, freshStepId(c));
    const at = selIndex() + 1;
    model.setShapeChain({ ...c, steps: [...c.steps.slice(0, at), s, ...c.steps.slice(at)] });
    selId = s.id;
    syncAll();
  };
  popupMenu('shape-add-menu', addBtn, () => {
    const out: HTMLButtonElement[] = [];
    let group = '';
    for (const info of STEP_INFO) {
      if (info.group !== group) {
        group = info.group;
        out.push(h('button', { class: 'menu-group', disabled: true, tabindex: -1 }, group));
      }
      out.push(
        h('button', { id: `shape-add-${info.op}`, role: 'menuitem', class: 'menu-item', title: info.hint, onclick: () => insertStep(info.op) }, h('b', {}, info.label)),
      );
    }
    return out;
  });

  const moveStep = (id: string, delta: number) => {
    const c = chain();
    const i = c.steps.findIndex((s) => s.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= c.steps.length) return;
    const steps = c.steps.slice();
    [steps[i], steps[j]] = [steps[j], steps[i]];
    model.setShapeChain({ ...c, steps });
  };
  const moveStepTo = (id: string, to: number) => {
    const c = chain();
    const i = c.steps.findIndex((s) => s.id === id);
    if (i < 0 || i === to) return;
    const steps = c.steps.slice();
    const [m] = steps.splice(i, 1);
    steps.splice(to, 0, m);
    model.setShapeChain({ ...c, steps });
  };
  const removeStep = (id: string) => {
    const c = chain();
    const i = c.steps.findIndex((s) => s.id === id);
    if (i < 0) return;
    const steps = c.steps.filter((s) => s.id !== id);
    model.setShapeChain({ ...c, steps });
    selId = steps[Math.min(i, steps.length - 1)]?.id ?? null;
    syncAll();
  };
  const duplicateStep = (id: string) => {
    const c = chain();
    const i = c.steps.findIndex((s) => s.id === id);
    if (i < 0) return;
    if (c.steps.length >= MAX_STEPS) return flash(`A chain holds at most ${MAX_STEPS} steps`, true);
    const copy = { ...c.steps[i], id: freshStepId(c) };
    model.setShapeChain({ ...c, steps: [...c.steps.slice(0, i + 1), copy, ...c.steps.slice(i + 1)] });
    selId = copy.id;
    syncAll();
  };
  const toggleStep = (id: string) => updateStep(id, (s) => ({ ...s, on: !s.on }));
  const selectStep = (id: string) => {
    if (selId === id && sel()?.id === id) return;
    selId = id;
    syncAll();
  };
  /** The view a step works in (its drawing's, harmonics for harmonic steps); null = keep the current one. */
  const viewOf = (s: Step): View | null => {
    const info = stepInfo(s.op);
    return info.draws ?? (s.op === 'harmSet' || s.op === 'harmMod' || s.op === 'rules' ? 'harm' : null);
  };
  /** Index of the selection at the last sync (a vanished step's neighbour is selected). */
  let lastSelIndex = 0;
  /** The step the view last followed: a newly selected step (any way) brings its view. */
  let viewFor: string | null = null;

  /** A step's sweep in its row: a ramp from its amount to its end amount (empty when it doesn't sweep). */
  const sweepMark = (s: Step): HTMLElement => {
    const el = h('span', { class: 'shape-step-sweep', 'aria-hidden': 'true' });
    const moves = 'draw' in s && !!s.drawEnd;
    if (s.amountEnd === undefined && !moves) return el;
    const y = (a: number) => (10 - a * 9).toFixed(1);
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 11');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '11');
    if (s.amountEnd !== undefined) {
      const poly = document.createElementNS(ns, 'polygon');
      poly.setAttribute('points', `0,10.5 0,${y(s.amount)} 16,${y(s.amountEnd)} 16,10.5`);
      svg.append(poly);
    } else {
      // Only the drawing sweeps: a line moving from low to high.
      const line = document.createElementNS(ns, 'polyline');
      line.setAttribute('points', '0,9 6,9 10,3 16,3');
      svg.append(line);
    }
    el.append(svg);
    el.title = [
      s.amountEnd !== undefined ? `Sweeps ${pct(s.amount)} → ${pct(s.amountEnd)} across the batch` : '',
      moves ? 'The drawing moves from its start to its end drawing across the batch' : '',
    ]
      .filter(Boolean)
      .join('; ');
    el.classList.add('on');
    if (!s.on) el.classList.add('off');
    return el;
  };
  /** The plot edits the selected step's end drawing (when it has one) instead of its start drawing. */
  let editEnd = false;
  let editEndFor: string | null = null;
  let rowSig = '';
  let dragId: string | null = null;
  const thumbs: HTMLCanvasElement[] = [];
  const renderList = () => {
    const c = chain();
    const si = selIndex();
    const sig = JSON.stringify([c.steps.map((s) => [s.id, s.op, s.on, stepSummary(s), s.amount, s.amountEnd ?? null, 'draw' in s && !!s.drawEnd]), si]);
    if (sig === rowSig) return;
    const hadFocus = list.contains(document.activeElement);
    rowSig = sig;
    thumbs.length = 0;
    list.replaceChildren(
      ...c.steps.map((s, i) => {
        const thumb = h('canvas', { class: 'shape-step-thumb', 'aria-hidden': 'true' });
        thumbs.push(thumb);
        const row = h(
          'div',
          {
            class: `shape-step${i === si ? ' sel' : ''}${s.on ? '' : ' off'}`,
            id: `shape-step-${i + 1}`,
            role: 'option',
            'aria-selected': String(i === si),
            tabindex: i === si ? 0 : -1,
            draggable: 'true',
            title: stepInfo(s.op).hint,
          },
          h('span', { class: 'shape-step-grip', 'aria-hidden': 'true' }, '⋮⋮'),
          h('button', {
            class: `shape-step-on${s.on ? ' on' : ''}`,
            'aria-label': s.on ? `Turn step ${i + 1} off` : `Turn step ${i + 1} on`,
            'aria-pressed': String(s.on),
            title: s.on ? 'On (click to bypass)' : 'Off (click to turn on)',
            tabindex: -1,
            onclick: (e: Event) => {
              e.stopPropagation();
              toggleStep(s.id);
            },
          }),
          h('span', { class: 'shape-step-name' }, h('b', {}, `${i + 1} · ${stepInfo(s.op).label}`), h('span', {}, sweepMark(s), stepSummary(s))),
          thumb,
          h(
            'button',
            {
              class: 'shape-step-x',
              'aria-label': `Remove step ${i + 1}`,
              title: 'Remove step',
              tabindex: -1,
              onclick: (e: Event) => {
                e.stopPropagation();
                removeStep(s.id);
              },
            },
            '×',
          ),
        );
        row.addEventListener('click', () => selectStep(s.id));
        row.addEventListener('keydown', (e) => {
          if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey) {
            e.preventDefault();
            moveStep(s.id, e.key === 'ArrowUp' ? -1 : 1);
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const j = i + (e.key === 'ArrowUp' ? -1 : 1);
            if (c.steps[j]) selectStep(c.steps[j].id);
          } else if (e.key === ' ') {
            e.preventDefault();
            toggleStep(s.id);
          } else if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            removeStep(s.id);
          }
        });
        row.addEventListener('dragstart', (e) => {
          dragId = s.id;
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        });
        row.addEventListener('dragover', (e) => {
          if (dragId === null) return;
          e.preventDefault();
          row.classList.add('drop');
        });
        row.addEventListener('dragleave', () => row.classList.remove('drop'));
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          row.classList.remove('drop');
          if (dragId !== null) moveStepTo(dragId, i);
          dragId = null;
        });
        row.addEventListener('dragend', () => (dragId = null));
        return row;
      }),
    );
    if (!c.steps.length) list.append(h('p', { class: 'shape-empty' }, 'No steps yet: + Add step.'));
    if (hadFocus) (list.querySelector('.shape-step.sel') as HTMLElement | null)?.focus();
    thumbsDirty = true;
  };

  // ---------------- head: source, title, amount, sweep ----------------
  const srcThumb = h('canvas', { 'aria-hidden': 'true' });
  const srcNo = h('span', { class: 'mut-src-no', id: 'shape-src-no' });
  const srcChip = h('div', { class: 'mut-src', id: 'shape-src' }, srcThumb, h('span', {}, 'Source'), srcNo);
  const title = h('span', { class: 'mut-name', id: 'shape-title' });
  const hint = h('span', { class: 'mut-hint', id: 'shape-hint' });
  const amountInput = h('input', { type: 'range', id: 'shape-amount', min: 0, max: 1, step: 0.01, 'aria-label': 'Amount' });
  const amountVal = h('span', { class: 'mut-amount-val', id: 'shape-amount-val' });
  const endInput = h('input', { type: 'range', id: 'shape-amount-end', min: 0, max: 1, step: 0.01, 'aria-label': 'Amount at the end of the batch' });
  const endVal = h('span', { class: 'mut-amount-val', id: 'shape-amount-end-val' });
  const endBox = h('span', { class: 'shape-end', title: 'Amount at the last waveform of the batch' }, '→', endInput, endVal);
  const sweepBtn = h('button', { id: 'shape-sweep', class: 'small shape-sweep', title: 'Sweep this step’s amount across the batch (N different results). Shift-click: every step.' }, '↦ Sweep');
  const stepMenuBtn = h('button', { id: 'shape-step-menu', class: 'small icon-btn', 'aria-label': 'Step actions', title: 'Move, duplicate or remove the step' }, '⋯');
  amountInput.addEventListener('input', () => {
    const s = sel();
    if (s) updateStep(s.id, (x) => ({ ...x, amount: Number(amountInput.value) }), `amount:${s.id}`);
  });
  endInput.addEventListener('input', () => {
    const s = sel();
    if (s) updateStep(s.id, (x) => ({ ...x, amountEnd: Number(endInput.value) }), `amountEnd:${s.id}`);
  });
  for (const i of [amountInput, endInput]) i.addEventListener('change', () => model.endGesture());
  /** A step with its sweep on (0 → its amount, or 1 if it was at 0) or off (at its end amount); unchanged if already so. */
  const withSweep = (x: Step, on: boolean): Step => {
    if (on === (x.amountEnd !== undefined)) return x;
    if (on) return { ...x, amount: 0, amountEnd: x.amount || 1 };
    const { amountEnd, ...rest } = x;
    return { ...rest, amount: amountEnd } as Step;
  };
  // Shift-click: every step of the chain follows the selected step's new state (one undo step).
  sweepBtn.addEventListener('click', (e) => {
    const s = sel();
    if (!s) return;
    const on = s.amountEnd === undefined;
    if (e.shiftKey) {
      setChain((c) => ({ ...c, steps: c.steps.map((x) => withSweep(x, on)) }));
      flash(on ? 'Sweep on for every step' : 'Sweep off for every step');
    } else updateStep(s.id, (x) => withSweep(x, on));
  });
  popupMenu('shape-step-actions', stepMenuBtn, () => {
    const s = sel();
    const i = selIndex();
    const n = chain().steps.length;
    return [
      h('button', { id: 'shape-step-up', role: 'menuitem', class: 'menu-item', disabled: !s || i <= 0, onclick: () => s && moveStep(s.id, -1) }, h('b', {}, 'Move up')),
      h('button', { id: 'shape-step-down', role: 'menuitem', class: 'menu-item', disabled: !s || i >= n - 1, onclick: () => s && moveStep(s.id, 1) }, h('b', {}, 'Move down')),
      h('button', { id: 'shape-step-dup', role: 'menuitem', class: 'menu-item', disabled: !s, onclick: () => s && duplicateStep(s.id) }, h('b', {}, 'Duplicate')),
      h('button', { id: 'shape-step-remove', role: 'menuitem', class: 'menu-item', disabled: !s, onclick: () => s && removeStep(s.id) }, h('b', {}, 'Remove')),
    ];
  });
  const head = h(
    'div',
    { class: 'mut-params shape-head' },
    srcChip,
    h('div', { class: 'mut-title' }, title, hint),
    h('label', { class: 'mut-amount shape-amount' }, h('span', {}, 'Amount'), amountInput, amountVal),
    endBox,
    sweepBtn,
    stepMenuBtn,
  );

  // ---------------- step settings ----------------
  const params = h('div', { class: 'shape-params', id: 'shape-params' });
  let paramSig = '';
  let syncs: ((s: Step) => void)[] = [];
  /** The Rules step's editor while a Rules step is selected. */
  let rulesEd: RulesEditor | null = null;
  /** Per-rule errors of a Rules step: compile errors, and the shown waveform's runtime error if this step failed. */
  const syncRuleErrors = (s: Step) => {
    if (!rulesEd || s.op !== 'rules') return;
    const errs = [...compileRules(s.rules, compileRule).errors];
    if (stageErr && stageErr.stepId === s.id && stageErr.cause instanceof RuleError) {
      const r = stageErr.cause.rule;
      if (errs[r] === undefined) errs[r] = stageErr.cause.message.replace(/^Rule \d+: /, '');
    }
    rulesEd.setErrors(errs);
  };

  const seg = <T extends string>(idp: string, label: string, options: Record<T, string>, get: (s: Step) => T, set: (v: T) => void) => {
    const btns = (Object.keys(options) as T[]).map((v) => h('button', { id: `${idp}-${v}`, onclick: () => set(v) }, options[v]));
    syncs.push((s) => {
      const cur = get(s);
      (Object.keys(options) as T[]).forEach((v, i) => {
        btns[i].classList.toggle('seg-on', v === cur);
        btns[i].setAttribute('aria-pressed', String(v === cur));
      });
    });
    return h('div', { class: 'seg', role: 'group', 'aria-label': label }, ...btns);
  };
  const range = (id: string, label: string, min: number, max: number, step: number, get: (s: Step) => number, set: (v: number, s: Step) => Step, fmt: (v: number) => string) => {
    const input = h('input', { type: 'range', id, min, max, step, 'aria-label': label });
    const val = h('span', { class: 'shape-val' });
    input.addEventListener('input', () => {
      const s = sel();
      if (s) updateStep(s.id, (x) => set(Number(input.value), x), `${id}:${s.id}`);
    });
    input.addEventListener('change', () => model.endGesture());
    syncs.push((s) => {
      const v = get(s);
      if (document.activeElement !== input) input.value = String(v);
      val.textContent = fmt(v);
    });
    return h('label', { class: 'shape-field' }, h('span', {}, label), input, val);
  };
  const select = <T extends string>(id: string, label: string, options: readonly (readonly [T, string])[], get: (s: Step) => T, set: (v: T, s: Step) => Step) => {
    const el = h('select', { id, 'aria-label': label }, ...options.map(([v, l]) => h('option', { value: v }, l)));
    el.addEventListener('change', () => {
      const s = sel();
      if (s) updateStep(s.id, (x) => set(el.value as T, x));
    });
    syncs.push((s) => {
      el.value = get(s);
    });
    return el;
  };
  const drawTools = () =>
    seg(
      'shape-tool',
      'Drawing tool',
      TOOL_LABELS,
      (s) => ('draw' in s ? s[editField(s)]!.tool : 'line'),
      (tool) => {
        const s = sel();
        if (!s || !('draw' in s)) return;
        const f = editField(s);
        updateStep(s.id, (x) => {
          const d = (x as DrawStep)[f]!;
          const pts = tool === 'line' && d.pts.length > 2 ? [d.pts[0], d.pts[d.pts.length - 1]] : d.pts;
          return { ...x, [f]: { tool, pts } } as Step;
        });
      },
    );
  /** "↦ End": give the step an end drawing (the drawing moves to it across the batch) or drop it. */
  const endDrawControls = (s0: DrawStep) => {
    const btn = h(
      'button',
      {
        id: 'shape-draw-end',
        class: 'small shape-sweep',
        title: 'Give this step an end drawing: across the batch the drawing moves from Start to End',
        onclick: () => {
          const s = sel();
          if (!s || !('draw' in s)) return;
          if (s.drawEnd) {
            editEnd = false;
            updateStep(s.id, (x) => {
              const { drawEnd: _e, ...rest } = x as DrawStep;
              return rest as Step;
            });
          } else {
            editEnd = true;
            updateStep(s.id, (x) => ({ ...x, drawEnd: (x as DrawStep).draw }) as Step);
          }
          paramSig = '';
          syncParams();
          mainDirty = true;
        },
      },
      '↦ End',
    );
    syncs.push((s) => {
      const on = 'draw' in s && !!s.drawEnd;
      btn.classList.toggle('seg-on', on);
      btn.setAttribute('aria-pressed', String(on));
    });
    if (!s0.drawEnd) return [btn];
    const which = seg(
      'shape-edit',
      'Edit the start or end drawing',
      { start: 'Start', end: 'End' },
      () => (editEnd ? 'end' : 'start'),
      (v) => {
        editEnd = v === 'end';
        const cur = sel();
        if (cur) for (const f of syncs) f(cur);
        mainDirty = true;
      },
    );
    return [btn, which];
  };
  const resetDraw = () =>
    h(
      'button',
      {
        id: 'shape-reset',
        class: 'small',
        title: 'Back to the default drawing',
        onclick: () => {
          const s = sel();
          if (!s || !('draw' in s)) return;
          const f = editField(s);
          updateStep(s.id, (x) => ({ ...x, [f]: x.op === 'harmLimit' ? DEFAULT_LIMIT_DRAW : defaultDrawing(x.op as DrawStep['op'] & Exclude<StepOp, 'harmLimit'>) }) as Step);
        },
      },
      'Reset',
    );
  const sep = () => h('span', { class: 'shape-sep', 'aria-hidden': 'true' });
  const note = (text: string) => h('span', { class: 'shape-note' }, text);

  const buildParams = (s: Step | undefined) => {
    syncs = [];
    rulesEd = null;
    if (!s) {
      params.replaceChildren(note('Add a step to start shaping.'));
      return;
    }
    const kids: HTMLElement[] = [];
    if (isDrawOp(s.op)) {
      kids.push(
        select(
          'shape-op',
          'Draw step',
          STEP_INFO.filter((i) => isDrawOp(i.op)).map((i) => [i.op, i.label] as const),
          (x) => x.op,
          (op, x) => {
            const fresh = newStep(op, x.id) as DrawStep;
            return { ...fresh, on: x.on, amount: x.amount, ...(x.amountEnd !== undefined ? { amountEnd: x.amountEnd } : {}), draw: (x as DrawStep).draw } as Step;
          },
        ),
      );
      if (s.op === 'clip' || s.op === 'soft' || s.op === 'fold')
        kids.push(
          seg(
            'shape-side',
            'Side',
            SIDE_LABELS,
            (x) => ('side' in x ? x.side : 'both'),
            (side) => {
              const cur = sel();
              if (cur) updateStep(cur.id, (x) => ({ ...x, side }) as Step);
            },
          ),
        );
      if (s.op === 'soft') kids.push(range('shape-knee', 'Knee', KNEE_RANGE[0], KNEE_RANGE[1], 0.01, (x) => ('knee' in x ? x.knee : 0.1), (v, x) => ({ ...x, knee: v }) as Step, (v) => v.toFixed(2)));
      if (s.op === 'push' || s.op === 'pull')
        kids.push(range('shape-radius', 'Radius', RADIUS_RANGE[0], RADIUS_RANGE[1], 0.01, (x) => ('radius' in x ? x.radius : 0.4), (v, x) => ({ ...x, radius: v }) as Step, (v) => v.toFixed(2)));
      kids.push(sep(), drawTools(), resetDraw(), ...endDrawControls(s as DrawStep));
    } else if (s.op === 'harmSet') {
      kids.push(
        select(
          'shape-hmode',
          'What to do with the set',
          Object.entries(MODE_LABELS) as [keyof typeof MODE_LABELS, string][],
          (x) => (x.op === 'harmSet' ? x.mode : 'keep'),
          // Removing a set rarely means removing the fundamental (the pitch): switching to Remove leaves it out of the set.
          (mode, x) => ({ ...x, mode, ...(mode === 'remove' && x.op === 'harmSet' && x.mode !== 'remove' ? { fundamental: false } : {}) }) as Step,
        ),
        select(
          'shape-hset',
          'Which harmonics',
          Object.entries(SET_LABELS) as [keyof typeof SET_LABELS, string][],
          (x) => (x.op === 'harmSet' ? x.set.kind : 'multiples'),
          (kind, x) => {
            if (x.op !== 'harmSet') return x;
            if (kind === 'drawn') {
              // Start from the current set at its law (members audible, the rest absent).
              const member = harmonicSet(x);
              const mags = Array.from({ length: KMAX }, (_, i) => (member[i + 1] ? Math.max(HARM_DB[0] + 1, -20 * x.law * Math.log10(i + 1)) : HARM_DB[0]));
              return { ...x, set: { kind, mags } } as Step;
            }
            const of = x.set.kind === 'multiples' || x.set.kind === 'list' ? x.set.of : [2, 3];
            return { ...x, set: kind === 'multiples' || kind === 'list' ? { kind, of } : { kind } } as Step;
          },
        ),
      );
      if (s.set.kind === 'multiples' || s.set.kind === 'list') {
        const of = h('input', { type: 'text', id: 'shape-hof', class: 'shape-of', 'aria-label': 'Harmonic numbers', spellcheck: false, autocomplete: 'off', title: 'Harmonic numbers 1–72, separated by commas or spaces' });
        of.addEventListener('input', () => {
          const cur = sel();
          const nums = of.value.split(/[^0-9]+/).filter(Boolean).map(Number);
          if (!cur || cur.op !== 'harmSet' || !nums.length) return;
          updateStep(cur.id, (x) => ({ ...x, set: { kind: (x as Extract<Step, { op: 'harmSet' }>).set.kind as 'multiples' | 'list', of: nums } }) as Step, `hof:${cur.id}`);
        });
        of.addEventListener('change', () => model.endGesture());
        syncs.push((x) => {
          if (x.op === 'harmSet' && (x.set.kind === 'multiples' || x.set.kind === 'list') && document.activeElement !== of) of.value = x.set.of.join(', ');
        });
        kids.push(of);
      }
      if (s.set.kind === 'drawn') {
        const setMags = (mags: number[]) => {
          const cur = sel();
          if (cur && cur.op === 'harmSet') updateStep(cur.id, (x) => ({ ...x, set: { kind: 'drawn', mags } }) as Step);
        };
        kids.push(
          h(
            'button',
            {
              id: 'shape-hdraw-input',
              class: 'small',
              title: 'Set the bars to the input’s harmonics',
              onclick: () => {
                const st = stages();
                if (!st) return;
                const { di } = specs(st.inp, st.inp);
                setMags(di.slice(1).map((v) => Math.round(v * 100) / 100));
              },
            },
            'From input',
          ),
          h('button', { id: 'shape-hdraw-clear', class: 'small', title: 'Remove every bar', onclick: () => setMags(Array.from({ length: KMAX }, () => HARM_DB[0])) }, 'Clear'),
        );
      }
      const fund = h('input', { type: 'checkbox', id: 'shape-hfund' });
      fund.addEventListener('change', () => {
        const cur = sel();
        if (cur) updateStep(cur.id, (x) => ({ ...x, fundamental: fund.checked }) as Step);
      });
      syncs.push((x) => (fund.checked = x.op === 'harmSet' && x.fundamental));
      kids.push(h('label', { class: 'shape-check', title: 'Whether harmonic 1 belongs to the set (Remove takes it out)' }, fund, 'Fundamental in set'));
      if (s.mode === 'add' || s.mode === 'replace') {
        if (s.set.kind !== 'drawn')
          kids.push(sep(), range('shape-hlaw', 'Law 1/kᵖ', LAW_RANGE[0], LAW_RANGE[1], 0.05, (x) => (x.op === 'harmSet' ? x.law : 1), (v, x) => ({ ...x, law: v }) as Step, (v) => `p ${v.toFixed(2)}`));
        else kids.push(sep());
        kids.push(select('shape-hphase', 'Phase of new harmonics', [['sine', 'Sine phase'], ['cos', 'Cosine phase'], ['schroeder', 'Schroeder'], ['random', 'Random (seeded)']] as const, (x) => (x.op === 'harmSet' ? x.phase : 'sine'), (phase, x) => ({ ...x, phase }) as Step));
      }
    } else if (s.op === 'harmMod') {
      kids.push(
        select('shape-mkind', 'Modification', Object.entries(MOD_LABELS) as [HarmModKind, string][], (x) => (x.op === 'harmMod' ? x.kind : 'tilt'), (kind, x) => {
          const fresh = { tilt: -3, shift: 2, stretch: 1.25, mirror: 0, randomize: 0.3 }[kind];
          return { ...x, kind, value: fresh } as Step;
        }),
      );
      const k = s.kind;
      if (k !== 'mirror') {
        const [lo, hi] = MOD_RANGES[k];
        const label = { tilt: 'dB / octave', shift: 'By', stretch: 'Factor', randomize: 'Depth', mirror: '' }[k];
        const fmt = { tilt: (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`, shift: (v: number) => `${v > 0 ? '+' : ''}${v}`, stretch: (v: number) => `×${v.toFixed(2)}`, randomize: pct, mirror: String }[k];
        kids.push(range('shape-mvalue', label, lo, hi, k === 'shift' ? 1 : k === 'tilt' ? 0.5 : 0.01, (x) => (x.op === 'harmMod' ? x.value : 0), (v, x) => ({ ...x, value: v }) as Step, fmt));
      }
      const rangeIn = (id: string, idx: 0 | 1, label: string) => {
        const input = h('input', { type: 'number', id, min: 1, max: KMAX, step: 1, class: 'shape-num', 'aria-label': label });
        input.addEventListener('change', () => {
          const cur = sel();
          if (!cur || cur.op !== 'harmMod') return;
          const r: [number, number] = [cur.range[0], cur.range[1]];
          r[idx] = clamp(Math.round(Number(input.value)) || 1, 1, KMAX);
          updateStep(cur.id, (x) => ({ ...x, range: r }) as Step);
        });
        syncs.push((x) => {
          if (x.op === 'harmMod' && document.activeElement !== input) input.value = String(x.range[idx]);
        });
        return input;
      };
      kids.push(sep(), h('label', { class: 'shape-field' }, h('span', {}, 'Harmonics'), rangeIn('shape-mk0', 0, 'From harmonic'), '–', rangeIn('shape-mk1', 1, 'To harmonic')));
    } else if (s.op === 'harmLimit') {
      kids.push(
        seg(
          'shape-lmode',
          'Mode',
          LIMIT_LABELS,
          (x) => (x.op === 'harmLimit' ? x.mode : 'limit'),
          (mode) => {
            const cur = sel();
            if (cur) updateStep(cur.id, (x) => ({ ...x, mode }) as Step);
          },
        ),
        sep(),
        drawTools(),
        resetDraw(),
        ...endDrawControls(s),
      );
    } else if (s.op === 'rules') {
      const ed = buildRulesEditor({
        id: 'shape-rules',
        legendExtra: 'v starts at the input’s level (strongest = 1)',
        onChange: (rules, gesture) => {
          const cur = sel();
          if (cur && cur.op === 'rules') updateStep(cur.id, (x) => ({ ...x, rules }) as Step, gesture ? `rules:${cur.id}:${gesture}` : undefined);
        },
        onCommit: () => model.endGesture(),
      });
      rulesEd = ed;
      syncs.push((x) => {
        if (x.op !== 'rules') return;
        ed.sync(x.rules);
        syncRuleErrors(x);
      });
      kids.push(ed.el);
    } else if (s.op === 'mutation') {
      kids.push(
        select(
          'shape-mutation',
          'Mutation',
          MUTATION_CHOICES.map((m) => [m.id, `${m.group} › ${m.label}`] as const),
          (x) => (x.op === 'mutation' ? x.mutation : 'smooth'),
          // Picking a mutation takes its current revision (a step saved before keeps its own until then).
          (mutation, x) => ({ ...x, mutation, rev: MUTATION_REV }) as Step,
        ),
        note('Amount is the mutation’s amount'),
      );
    } else if (s.op === 'gain') {
      kids.push(range('shape-gain', 'Gain', GAIN_RANGE[0], GAIN_RANGE[1], 0.05, (x) => ('value' in x ? x.value : 1), (v, x) => ({ ...x, value: v }) as Step, (v) => `×${v.toFixed(2)}`));
    } else if (s.op === 'rotate') {
      kids.push(range('shape-rotate', 'By', ROTATE_RANGE[0], ROTATE_RANGE[1], 0.01, (x) => ('value' in x ? x.value : 0), (v, x) => ({ ...x, value: v }) as Step, (v) => `${v.toFixed(2)} cycle`));
    } else kids.push(note('No settings'));
    params.replaceChildren(...kids);
  };

  const syncParams = () => {
    const s = sel();
    const sig = s
      ? JSON.stringify(['draw' in s && !!s.drawEnd, s.id, s.op, s.op === 'harmSet' ? [s.mode === 'add' || s.mode === 'replace', s.set.kind === 'multiples' || s.set.kind === 'list', s.set.kind === 'drawn'] : 0, s.op === 'harmMod' ? s.kind : 0])
      : '';
    if (sig !== paramSig) {
      paramSig = sig;
      buildParams(s);
    }
    if (s) for (const f of syncs) f(s);
    // Head.
    const i = selIndex();
    title.textContent = s ? `Step ${i + 1} · ${stepInfo(s.op).label}` : 'No step selected';
    hint.textContent = s ? stepInfo(s.op).hint : 'Add a step from the chain column';
    hint.title = hint.textContent;
    amountInput.disabled = endInput.disabled = sweepBtn.disabled = !s;
    if (s) {
      if (document.activeElement !== amountInput) amountInput.value = String(s.amount);
      amountVal.textContent = pct(s.amount);
      endBox.hidden = s.amountEnd === undefined;
      if (s.amountEnd !== undefined) {
        if (document.activeElement !== endInput) endInput.value = String(s.amountEnd);
        endVal.textContent = pct(s.amountEnd);
      }
      sweepBtn.classList.toggle('seg-on', s.amountEnd !== undefined);
      sweepBtn.setAttribute('aria-pressed', String(s.amountEnd !== undefined));
    } else endBox.hidden = true;
  };

  // ---------------- plot ----------------
  const edCanvas = h('canvas', { id: 'shape-ed', role: 'img', 'aria-label': 'The selected step: input dashed, output solid, drawing in the draw colour' });
  const legend = h('span', { class: 'mut-legend shape-legend', 'aria-hidden': 'true' });
  const viewWave = h('button', { id: 'shape-view-wave', onclick: () => setView('wave') }, 'Waveform');
  const viewHarm = h('button', { id: 'shape-view-harm', onclick: () => setView('harm') }, 'Harmonics');
  const edHint = h('div', { class: 'shape-ed-hint', id: 'shape-ed-hint', hidden: true });
  const edBox = h(
    'div',
    { class: 'gen-plot-box shape-ed-box' },
    edCanvas,
    h('div', { class: 'gen-plot-tags' }, legend, h('div', { class: 'seg', role: 'group', 'aria-label': 'View' }, viewWave, viewHarm)),
    edHint,
  );
  const sideCanvas = h('canvas', { id: 'shape-side', role: 'img', 'aria-label': 'The selected step in the other view' });
  // The shown waveform (the chain's output) may sound above its note: badge over the side plot.
  const pitch = pitchBadge('shape-pitch');
  const sideBox = h('div', { class: 'gen-plot-box' }, sideCanvas, pitch.el);
  const sideAxis = h('div', { class: 'gen-axis' });
  const edAxis = h('div', { class: 'gen-axis' });
  const viewer = h(
    'div',
    { class: 'gen-viewer' },
    h('div', { class: 'gen-views' }, h('div', { class: 'gen-plot gen-plot-wave' }, edBox, edAxis), h('div', { class: 'gen-plot gen-plot-spec' }, sideBox, sideAxis)),
  );
  const setView = (v: View) => {
    if (view === v) return;
    view = v;
    syncView();
    mainDirty = true;
  };
  const syncView = () => {
    viewWave.classList.toggle('seg-on', view === 'wave');
    viewHarm.classList.toggle('seg-on', view === 'harm');
    viewWave.setAttribute('aria-pressed', String(view === 'wave'));
    viewHarm.setAttribute('aria-pressed', String(view === 'harm'));
    edAxis.replaceChildren(...(view === 'wave' ? ['0', 'π', '2π'] : ['h1', 'dB (−60…0)', `h${KMAX}`]).map((t) => h('span', {}, t)));
    sideAxis.replaceChildren(...(view === 'wave' ? ['h1', 'grey = input', `h${KMAX}`] : ['0', 'waveform', '2π']).map((t) => h('span', {}, t)));
  };

  // ---- stages of the shown card (prefix-cached) ----
  let stageCache: { srcId: number; keys: string[]; outs: Float64Array<ArrayBufferLike>[] } | null = null;
  /** The step that failed computing the shown card's stages (a Rules step), if any. */
  let stageErr: ShapeStepError | null = null;
  const shownPos = (): BatchPos => {
    const n = batchN();
    return { index: Math.min(strip.shown(), n - 1), count: n };
  };
  const stages = (): { inp: ArrayLike<number>; out: ArrayLike<number>; all: Float64Array<ArrayBufferLike>[] } | null => {
    const src = source();
    if (!src) return null;
    const c = chain();
    const b = shownPos();
    const u = batchUOf(b);
    // A step's output depends on u through its amount sweep and its drawing sweep (end drawing).
    // Rules that read n / u depend on the batch position itself.
    const keys = c.steps.map(
      (s) =>
        `${JSON.stringify(s)}|${stepAmount(s, u)}|${'drawEnd' in s && s.drawEnd ? u : ''}|${stepUsesSeed(s) ? stepSeed(c, s, b) : ''}|${s.op === 'rules' && rulesUseBatch(s.rules) ? `${b.index}/${b.count}` : ''}`,
    );
    let keep = 0;
    if (stageCache && stageCache.srcId === src.id) while (keep < keys.length && keep < stageCache.keys.length && keys[keep] === stageCache.keys[keep]) keep++;
    let outs: Float64Array<ArrayBufferLike>[];
    stageErr = null;
    try {
      outs = chainStages(src.data, c, b, stageCache && stageCache.srcId === src.id ? stageCache.outs.slice(0, keep) : [], chainEnv());
      stageCache = { srcId: src.id, keys, outs };
    } catch (e) {
      if (!(e instanceof ShapeStepError)) throw e;
      // A failing step (a Rules step) and the steps after it pass their input on in the plots; the error is shown.
      stageErr = e;
      stageCache = { srcId: src.id, keys: keys.slice(0, e.index), outs: e.stages.slice() };
      outs = e.stages.slice();
      while (outs.length < c.steps.length) outs.push(outs.at(-1) ?? Float64Array.from(src.data));
    }
    const i = selIndex();
    if (i < 0) return { inp: src.data, out: src.data, all: outs };
    return { inp: i > 0 ? outs[i - 1] : src.data, out: outs[i], all: outs };
  };

  /** Level range of the waveform plot (frozen while a stroke is drawn). */
  let plotR = 1.25;
  const peakOf = (x: ArrayLike<number>) => {
    let p = 0;
    for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
    return p;
  };
  /** Harmonic magnitudes in dB relative to `ref` (the stronger of input / output). */
  const dbOf = (x: ArrayLike<number>): Float64Array => harmonicMagnitudes(x, KMAX);
  const toDb = (m: Float64Array, ref: number) => Array.from(m, (v, k) => (k === 0 || ref <= 0 ? HARM_DB[0] : clamp(20 * Math.log10(Math.max(v, 1e-300) / ref), HARM_DB[0], 0)));
  const bars = (g: CanvasRenderingContext2D, db: number[], w: number, h: number, color: string, frac: number) => {
    g.fillStyle = color;
    const bw = (w / KMAX) * frac;
    for (let k = 1; k <= KMAX; k++) {
      const t = (db[k] - HARM_DB[0]) / -HARM_DB[0];
      if (t <= 0.002) continue;
      const cx = ((k - 0.5) / KMAX) * w;
      g.fillRect(cx - bw / 2, h * (1 - t), Math.max(1, bw), h * t);
    }
  };
  let specCache: { a: unknown; b: unknown; mi: Float64Array; mo: Float64Array } | null = null;
  const specs = (inp: ArrayLike<number>, out: ArrayLike<number>) => {
    if (!specCache || specCache.a !== inp || specCache.b !== out) specCache = { a: inp, b: out, mi: dbOf(inp), mo: dbOf(out) };
    const ref = Math.max(...specCache.mi.slice(1), ...specCache.mo.slice(1));
    const inMax = Math.max(...specCache.mi.slice(1));
    // A drawn set's levels are relative to the input's strongest harmonic; the plot's to the stronger of both.
    const drawnOffset = ref > 0 && inMax > 0 ? 20 * Math.log10(inMax / ref) : 0;
    return { di: toDb(specCache.mi, ref), dout: toDb(specCache.mo, ref), drawnOffset };
  };

  // Plot geometry ↔ drawing coordinates.
  const plotH = () => Math.max(40, edBox.clientHeight || 150);
  /** Half-height that ±plotR spans in the waveform view (drawWave's padding). */
  const amp = (hh: number) => hh / 2 - Math.min(4, hh * 0.08);
  const toPx = (p: Pt, w: number, hh: number): [number, number] =>
    view === 'wave' ? [p[0] * w, hh / 2 - (p[1] / plotR) * amp(hh)] : [((1 + p[0] * (KMAX - 1) - 0.5) / KMAX) * w, ((hh - DOTS_H) * -p[1]) / -HARM_DB[0]];
  const fromPx = (px: number, py: number, w: number, hh: number): Pt =>
    view === 'wave'
      ? [clamp(px / w, 0, 1), clamp(((hh / 2 - py) / amp(hh)) * plotR, WAVE_Y[0], WAVE_Y[1])]
      : [clamp(((px / w) * KMAX + 0.5 - 1) / (KMAX - 1), 0, 1), clamp((-py / (hh - DOTS_H)) * -HARM_DB[0], HARM_DB[0], HARM_DB[1])];
  /** The drawing the plot edits now (null: this step draws in the other view, or not at all). */
  /** The drawn-bars set step the Harmonics plot paints now, or null. */
  const paintable = (): Extract<Step, { op: 'harmSet' }> | null => {
    const s = sel();
    return view === 'harm' && s && s.op === 'harmSet' && s.set.kind === 'drawn' ? s : null;
  };
  /** Which of the selected step's drawings the plot edits. */
  const editField = (s: DrawStep): 'draw' | 'drawEnd' => (editEnd && s.drawEnd ? 'drawEnd' : 'draw');
  const editable = (): Drawing | null => {
    const s = sel();
    if (!s || !('draw' in s)) return null;
    return (s.op === 'harmLimit') === (view === 'harm') ? s[editField(s)]! : null;
  };

  const drawDrawing = (g: CanvasRenderingContext2D, d: Drawing, w: number, hh: number, mirror: boolean, faded = false) => {
    if (faded) {
      // The other end of a drawing sweep: thin and faint, no handles.
      g.save();
      g.globalAlpha = 0.45;
      g.setLineDash([3, 3]);
      g.strokeStyle = cssColor('--v2');
      g.lineWidth = 1.25;
      g.beginPath();
      const span = drawingSpan(d) ?? [0, 1];
      const n = Math.max(2, Math.ceil((span[1] - span[0]) * w));
      for (let j = 0; j <= n; j++) {
        const x = span[0] + ((span[1] - span[0]) * j) / n;
        const v = drawingValue(d, x);
        if (v === null) continue;
        const [px, py] = toPx([x, v], w, hh);
        if (j) g.lineTo(px, py);
        else g.moveTo(px, py);
      }
      g.stroke();
      g.restore();
      return;
    }
    const color = cssColor('--v2');
    const span = drawingSpan(d) ?? [0, 1];
    for (const sign of mirror ? [1, -1] : [1]) {
      g.save();
      g.strokeStyle = color;
      g.lineWidth = 2;
      if (sign < 0) {
        g.setLineDash([4, 4]);
        g.globalAlpha = 0.7;
      }
      g.beginPath();
      const n = Math.max(2, Math.ceil((span[1] - span[0]) * w));
      for (let j = 0; j <= n; j++) {
        const x = span[0] + ((span[1] - span[0]) * j) / n;
        const v = drawingValue(d, x);
        if (v === null) continue;
        const [px, py] = toPx([x, mirror ? sign * Math.abs(v) : v], w, hh);
        if (j) g.lineTo(px, py);
        else g.moveTo(px, py);
      }
      g.stroke();
      g.restore();
    }
    if (d.tool === 'free') return;
    g.lineWidth = 2;
    for (const p of d.pts) {
      const [px, py] = toPx(p, w, hh);
      g.fillStyle = cssColor('--bg');
      g.strokeStyle = color;
      g.beginPath();
      g.arc(px, py, 4.5, 0, 2 * Math.PI);
      g.fill();
      g.stroke();
    }
  };

  const drawMain = () => {
    mainDirty = false;
    const st = stages();
    const s = sel();
    const [g, w, hh] = fit(edCanvas, plotH());
    const grid = cssColor('--surface-2');
    const border = cssColor('--border');
    const canDraw = !!editable() || !!paintable();
    edBox.classList.toggle('drawable', canDraw);
    if (!st) {
      edHint.hidden = false;
      edHint.textContent = 'Select a waveform in the Timeline to shape it';
      legend.replaceChildren();
      fit(sideCanvas, Math.max(30, sideBox.clientHeight || 90));
      pitch.show(undefined);
      return;
    }
    const { inp, out } = st;
    pitch.show(st.all.at(-1) ?? source()?.data);
    if (view === 'wave') {
      if (!drawing) plotR = Math.max(1.25, Math.ceil(Math.max(peakOf(inp), peakOf(out)) * 4.4) / 4);
      g.strokeStyle = grid;
      g.lineWidth = 1;
      g.beginPath();
      for (const f of [0.25, 0.5, 0.75]) {
        g.moveTo(Math.round(w * f) + 0.5, 0);
        g.lineTo(Math.round(w * f) + 0.5, hh);
      }
      g.stroke();
      g.strokeStyle = border;
      g.beginPath();
      g.moveTo(0, Math.round(hh / 2) + 0.5);
      g.lineTo(w, Math.round(hh / 2) + 0.5);
      g.stroke();
      g.save();
      g.setLineDash([2, 4]);
      for (const v of [1, -1]) {
        const y = Math.round(hh / 2 - (v / plotR) * amp(hh)) + 0.5;
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(w, y);
        g.stroke();
      }
      g.restore();
      const d = s && isDrawOp(s.op) && 'draw' in s ? s[editField(s)]! : null;
      const other = s && isDrawOp(s.op) && 'draw' in s && s.drawEnd ? (editEnd ? s.draw : s.drawEnd) : null;
      const span = d ? drawingSpan(d) : null;
      if (span) {
        g.fillStyle = cssColor('--surface');
        g.globalAlpha = 0.5;
        if (span[0] > 0.001) g.fillRect(0, 0, span[0] * w, hh);
        if (span[1] < 0.999) g.fillRect(span[1] * w, 0, w - span[1] * w, hh);
        g.globalAlpha = 1;
      }
      // drawWave maps ±1 to the box (less a small pad): scale the box so ±plotR fills it.
      const scaled = (x: ArrayLike<number>) => Array.from(x, (v) => v / plotR);
      g.setLineDash([5, 4]);
      drawWave(g, 0, 0, w, hh, scaled(inp), cssColor('--muted'), { lineWidth: 1.25 });
      g.setLineDash([]);
      drawWave(g, 0, 0, w, hh, scaled(out), cssColor('--wave'), { lineWidth: 2 });
      if (other) drawDrawing(g, other, w, hh, false, true);
      if (d && s) drawDrawing(g, d, w, hh, (s.op === 'clip' || s.op === 'soft' || s.op === 'fold') && 'side' in s && s.side === 'both');
      legend.replaceChildren(
        h('span', {}, h('i', { class: 'mut-key-src' }), 'input'),
        h('span', {}, h('i', { class: 'mut-key-res' }), 'output'),
        ...(d ? [h('span', {}, h('i', { class: 'shape-key-draw' }), 'drawing')] : []),
      );
    } else {
      const { di, dout } = specs(inp, out);
      g.strokeStyle = grid;
      g.lineWidth = 1;
      g.beginPath();
      for (const db of [-20, -40]) {
        const y = Math.round(((hh - DOTS_H) * -db) / -HARM_DB[0]) + 0.5;
        g.moveTo(0, y);
        g.lineTo(w, y);
      }
      g.stroke();
      if (s && s.op === 'harmSet') {
        const set = harmonicSet(s);
        g.fillStyle = cssColor('--v2');
        for (let k = 1; k <= KMAX; k++) {
          if (!set[k]) continue;
          g.beginPath();
          g.arc(((k - 0.5) / KMAX) * w, hh - 3, 1.8, 0, 2 * Math.PI);
          g.fill();
        }
      }
      if (s && s.op === 'rules' && !(stageErr && stageErr.index <= selIndex())) {
        // Each harmonic a rule matched: a dot in that rule's colour (the last one that matched).
        try {
          const b = shownPos();
          const r = rulesStepEval(s, inp, stepSeed(chain(), s, b), { ...chainEnv(), index: b.index, count: b.count });
          for (let k = 1; k <= KMAX; k++) {
            if (r.last[k] < 0) continue;
            g.fillStyle = ruleColor(r.last[k]);
            g.beginPath();
            g.arc(((k - 0.5) / KMAX) * w, hh - 3, 1.8, 0, 2 * Math.PI);
            g.fill();
          }
        } catch {
          // The error is shown on the rule's row.
        }
      }
      bars(g, di, w, hh - DOTS_H, cssColor('--border-strong'), 0.85);
      g.globalAlpha = 0.9;
      bars(g, dout, w, hh - DOTS_H, cssColor('--accent'), 0.45);
      g.globalAlpha = 1;
      if (s && s.op === 'harmLimit') {
        if (s.drawEnd) drawDrawing(g, editEnd ? s.draw : s.drawEnd, w, hh, false, true);
        drawDrawing(g, s[editField(s)]!, w, hh, false);
      }
      if (s && s.op === 'harmSet' && s.set.kind === 'drawn') {
        // The painted level of each harmonic: a tick across its bar.
        g.strokeStyle = cssColor('--v2');
        g.lineWidth = 2;
        g.beginPath();
        const bw = (w / KMAX) * 0.8;
        const off = specs(inp, out).drawnOffset;
        s.set.mags.forEach((db, i) => {
          // Harmonic 1 follows "Fundamental in set", not its bar.
          if (db <= HARM_DB[0] || (i === 0 && !s.fundamental)) return;
          const y = Math.round(((hh - DOTS_H) * -Math.max(HARM_DB[0], db + off)) / -HARM_DB[0]) + 0.5;
          const cx = ((i + 0.5) / KMAX) * w;
          g.moveTo(cx - bw / 2, y);
          g.lineTo(cx + bw / 2, y);
        });
        g.stroke();
      }
      legend.replaceChildren(
        h('span', {}, h('i', { class: 'shape-key-in' }), 'input'),
        h('span', {}, h('i', { class: 'shape-key-out' }), 'output'),
        ...(s?.op === 'harmLimit' ? [h('span', {}, h('i', { class: 'shape-key-draw' }), 'curve')] : []),
        ...(s?.op === 'harmSet' ? [h('span', { class: 'shape-key-set' }, '• in set')] : []),
        ...(s?.op === 'rules' ? [h('span', { class: 'shape-key-rule', title: 'Each harmonic a rule matched: a dot in the colour of the last rule that matched it' }, '• last rule')] : []),
      );
    }
    // Hint when this step has nothing to draw in this view.
    const drawnSet = !!s && s.op === 'harmSet' && s.set.kind === 'drawn';
    const otherView = !!s && ('draw' in s || drawnSet) && !canDraw;
    edHint.hidden = !otherView && !stageErr;
    if (otherView) edHint.textContent = view === 'wave' ? 'This step draws on the harmonics: switch to Harmonics' : 'This step draws on the waveform: switch to Waveform';
    if (stageErr) edHint.textContent = `${chainError(stageErr)} (skipped in this plot; results fail until it is fixed)`;
    edHint.classList.toggle('error', !!stageErr);
    if (s) syncRuleErrors(s);
    // Side: the other view.
    const [gs, sw, sh] = fit(sideCanvas, Math.max(30, sideBox.clientHeight || 90));
    if (view === 'wave') {
      const { di, dout } = specs(inp, out);
      gs.strokeStyle = grid;
      gs.beginPath();
      for (const f of [1 / 3, 2 / 3]) {
        gs.moveTo(0, Math.round(sh * f) + 0.5);
        gs.lineTo(sw, Math.round(sh * f) + 0.5);
      }
      gs.stroke();
      bars(gs, di, sw, sh - 1, cssColor('--border-strong'), 0.85);
      gs.globalAlpha = 0.85;
      bars(gs, dout, sw, sh - 1, cssColor('--accent'), 0.45);
      gs.globalAlpha = 1;
    } else {
      const r = Math.max(1, peakOf(inp), peakOf(out));
      gs.setLineDash([4, 3]);
      drawWave(gs, 0, 0, sw, sh, Array.from(inp, (v) => v / r), cssColor('--muted'), { lineWidth: 1.2 });
      gs.setLineDash([]);
      drawWave(gs, 0, 0, sw, sh, Array.from(out, (v) => v / r), cssColor('--wave'), { lineWidth: 1.6 });
    }
  };

  // ---- drawing with the pointer ----
  /** A whole-drawing move: where it started, the points then, and which way the grabbed copy moves (−1: the mirrored one). */
  interface Move {
    x0: number;
    y0: number;
    pts0: Pt[];
    sgn: number;
    /** Pointer position at press (CSS px): a click (no drag) on a curve adds a point there instead. */
    px0: number;
    py0: number;
    dragged: boolean;
  }
  /**
   * A point being dragged: where it was and where the pointer pressed (data coordinates), and
   * whether it is the far end of a new line (Shift then keeps the line level).
   */
  interface PointDrag {
    q0: Pt;
    p0: Pt;
    newLine: boolean;
  }
  let drawing: {
    pt: [number, number] | null;
    /** A freehand stroke being drawn (later samples overwrite earlier ones at the same x). */
    raw: StrokeBuffer | null;
    move?: Move;
    drag?: PointDrag;
    stepId: string;
    stroke: number;
    draw: Drawing;
    /** The step's drawing being edited: its start or its end drawing. */
    field?: 'draw' | 'drawEnd';
  } | null = null;
  /** Shift: a drag from (x0, y0) to (x, y) keeps only its larger component (in screen terms). */
  const axisLock = (x0: number, y0: number, x: number, y: number, w: number, hh: number): [number, number] => {
    const [ax, ay] = toPx([x0, y0], w, hh);
    const [bx, by] = toPx([x, y], w, hh);
    return Math.abs(bx - ax) >= Math.abs(by - ay) ? [x, y0] : [x0, y];
  };
  /** Whether the selected step's drawing shows mirrored (± about 0). */
  const mirrored = () => {
    const s = sel();
    return view === 'wave' && !!s && (s.op === 'clip' || s.op === 'soft' || s.op === 'fold') && s.side === 'both';
  };
  /** A point handle of `d` under (px, py), or -1. */
  const hitPoint = (d: Drawing, px: number, py: number, w: number, hh: number) =>
    d.tool === 'free'
      ? -1
      : d.pts.findIndex((q) => {
          const [x, y] = toPx(q, w, hh);
          return Math.hypot(x - px, y - py) < HIT_PX;
        });
  /**
   * The drawing's line under (px, py): 0 = none, else the factor a vertical drag moves its
   * values by (1 for the line as drawn; for a mirrored drawing ±1 so the grabbed copy follows).
   */
  const hitLine = (d: Drawing, px: number, py: number, w: number, hh: number): number => {
    const [x] = fromPx(px, py, w, hh);
    const v = drawingValue(d, x);
    if (v === null) return 0;
    if (!mirrored()) return Math.abs(toPx([x, v], w, hh)[1] - py) < HIT_PX ? 1 : 0;
    const sv = v >= 0 ? 1 : -1;
    if (Math.abs(toPx([x, Math.abs(v)], w, hh)[1] - py) < HIT_PX) return sv;
    if (Math.abs(toPx([x, -Math.abs(v)], w, hh)[1] - py) < HIT_PX) return -sv;
    return 0;
  };
  let strokeNo = 0;
  const commitDraw = (d: Drawing) => {
    if (!drawing) return;
    const id = drawing.stepId;
    const key = `draw:${id}:${drawing.stroke}`;
    // Fixed for the stroke on its first commit (Start / End can't change mid-drag).
    const cur = sel();
    drawing.field ??= cur && 'draw' in cur ? editField(cur) : 'draw';
    const f = drawing.field;
    updateStep(id, (x) => ({ ...x, [f]: d }) as Step, key);
  };
  const ptsOf = (d: Drawing): [number, number][] => d.pts.map((p) => [p[0], p[1]]);
  let painting: { stepId: string; stroke: number; mags: number[]; lastK: number } | null = null;
  const paintAt = (e: PointerEvent) => {
    if (!painting) return;
    const r = edCanvas.getBoundingClientRect();
    const [u, db0] = fromPx(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
    const k = clamp(Math.round(1 + u * (KMAX - 1)), 1, KMAX);
    // The bottom few dB (and the dots row) remove the harmonic.
    const st = stages();
    const off = st ? specs(st.inp, st.out).drawnOffset : 0;
    const db = db0 <= HARM_DB[0] + 2 ? HARM_DB[0] : clamp(Math.round((db0 - off) * 10) / 10, HARM_DB[0] + 0.1, HARM_DB[1]);
    const k0 = painting.lastK;
    const from = Math.min(k0, k);
    const to = Math.max(k0, k);
    const d0 = painting.mags[k0 - 1];
    for (let j = from; j <= to; j++) {
      const t = to === from ? 1 : (j - k0) / (k - k0);
      painting.mags[j - 1] = j === k ? db : k0 === k ? db : d0 + (db - d0) * t;
    }
    painting.lastK = k;
    const mags = painting.mags.slice();
    updateStep(painting.stepId, (x) => ({ ...x, set: { kind: 'drawn', mags } }) as Step, `bars:${painting.stepId}:${painting.stroke}`);
  };
  edCanvas.addEventListener('pointerdown', (e) => {
    const ps = paintable();
    if (ps && e.button <= 0) {
      e.preventDefault();
      edCanvas.setPointerCapture(e.pointerId);
      const r = edCanvas.getBoundingClientRect();
      const [u] = fromPx(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
      const set = ps.set as { kind: 'drawn'; mags: readonly number[] };
      painting = { stepId: ps.id, stroke: ++strokeNo, mags: set.mags.slice(), lastK: clamp(Math.round(1 + u * (KMAX - 1)), 1, KMAX) };
      paintAt(e);
      return;
    }
    const d = editable();
    const s = sel();
    if (!d || !s || e.button > 0) return;
    e.preventDefault();
    edCanvas.setPointerCapture(e.pointerId);
    const r = edCanvas.getBoundingClientRect();
    const hh = r.height;
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const p = fromPx(px, py, r.width, hh);
    const pts = ptsOf(d);
    strokeNo++;
    if (d.tool === 'free' && e.shiftKey) {
      // Shift with the Free tool: add to the drawing (the stroke overwrites only where it goes).
      const sb = new StrokeBuffer();
      sb.seed(d);
      sb.add(p);
      drawing = { pt: null, raw: sb, stepId: s.id, stroke: strokeNo, draw: d };
      return;
    }
    const hit = hitPoint(d, px, py, r.width, hh);
    if (hit >= 0) {
      drawing = { pt: pts[hit], raw: null, drag: { q0: [pts[hit][0], pts[hit][1]], p0: p, newLine: false }, stepId: s.id, stroke: strokeNo, draw: { tool: d.tool, pts } };
      return;
    }
    // On the line itself: drag the whole drawing.
    const sgn = hitLine(d, px, py, r.width, hh);
    if (sgn) {
      drawing = { pt: null, raw: null, move: { x0: p[0], y0: p[1], pts0: pts, sgn, px0: px, py0: py, dragged: false }, stepId: s.id, stroke: strokeNo, draw: d };
      return;
    }
    if (d.tool === 'line') {
      const np: [number, number][] = [[p[0], p[1]], [p[0], p[1]]];
      drawing = { pt: np[1], raw: null, drag: { q0: p, p0: p, newLine: true }, stepId: s.id, stroke: strokeNo, draw: { tool: 'line', pts: np } };
    } else if (d.tool === 'curve') {
      const q: [number, number] = [p[0], p[1]];
      pts.push(q);
      pts.sort((a, b) => a[0] - b[0]);
      drawing = { pt: q, raw: null, drag: { q0: [q[0], q[1]], p0: p, newLine: false }, stepId: s.id, stroke: strokeNo, draw: { tool: 'curve', pts } };
      commitDraw(drawing.draw);
    } else {
      // Committed once the stroke has length (a tap changes nothing).
      const sb = new StrokeBuffer();
      sb.add(p);
      drawing = { pt: null, raw: sb, stepId: s.id, stroke: strokeNo, draw: d };
    }
  });
  edCanvas.addEventListener('pointermove', (e) => {
    if (painting) return paintAt(e);
    const r = edCanvas.getBoundingClientRect();
    if (!drawing) {
      // Hover: a handle grabs a point, the line moves the drawing, elsewhere draws.
      const d = editable();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      edCanvas.style.cursor = !d ? '' : hitPoint(d, px, py, r.width, r.height) >= 0 ? 'grab' : hitLine(d, px, py, r.width, r.height) ? 'move' : '';
      return;
    }
    const p = fromPx(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
    if (drawing.move) {
      const m = drawing.move;
      if (!m.dragged && Math.hypot(e.clientX - r.left - m.px0, e.clientY - r.top - m.py0) < 3) return;
      m.dragged = true;
      const xs = m.pts0.map((q) => q[0]);
      // Shift: move only horizontally or only vertically.
      const [lx, ly] = e.shiftKey ? axisLock(m.x0, m.y0, p[0], p[1], r.width, r.height) : [p[0], p[1]];
      const dx = clamp(lx - m.x0, -Math.min(...xs), 1 - Math.max(...xs));
      const dy = (ly - m.y0) * m.sgn;
      const [lo, hi] = view === 'wave' ? WAVE_Y : HARM_DB;
      drawing.draw = { tool: drawing.draw.tool, pts: m.pts0.map(([x, y]) => [x + dx, clamp(y + dy, lo, hi)] as Pt) };
    } else if (drawing.pt) {
      let [x, y] = p;
      const g = drawing.drag;
      if (g && e.shiftKey) {
        // Shift: a new line stays level; a dragged point moves only horizontally or vertically.
        if (g.newLine) y = g.q0[1];
        else [x, y] = axisLock(g.q0[0], g.q0[1], g.q0[0] + (p[0] - g.p0[0]), g.q0[1] + (p[1] - g.p0[1]), r.width, r.height);
      }
      drawing.pt[0] = clamp(x, 0, 1);
      drawing.pt[1] = y;
      const pts = (drawing.draw.pts as [number, number][]).slice().sort((a, b) => a[0] - b[0]);
      drawing.draw = { tool: drawing.draw.tool, pts };
    } else if (drawing.raw) {
      drawing.raw.add(p);
      const pts = drawing.raw.points();
      if (pts.length < 2) return;
      drawing.draw = { tool: 'free', pts };
    }
    commitDraw(drawing.draw);
  });
  const endDraw = () => {
    if (painting) {
      painting = null;
      model.endGesture();
      return;
    }
    if (!drawing) return;
    const m = drawing.move;
    if (m && !m.dragged && drawing.draw.tool === 'curve') {
      // A click on a curve: a new point on it.
      const v = drawingValue(drawing.draw, m.x0);
      const pts = [...m.pts0, [m.x0, v ?? m.y0] as Pt].sort((a, b) => a[0] - b[0]);
      commitDraw({ tool: 'curve', pts });
      drawing = null;
      model.endGesture();
      mainDirty = true;
      return;
    }
    const d = drawing.draw;
    // A click without a drag (line tool): a horizontal line across the whole cycle at that level.
    if (d.tool === 'line' && d.pts.length === 2 && Math.abs(d.pts[1][0] - d.pts[0][0]) < 0.01) commitDraw({ tool: 'line', pts: [[0, d.pts[0][1]], [1, d.pts[0][1]]] });
    else if (d.tool !== 'free' || d.pts.length > 1) commitDraw(d);
    // A freehand tap (no stroke) leaves the drawing as it was.
    drawing = null;
    model.endGesture();
    mainDirty = true;
  };
  edCanvas.addEventListener('pointerup', endDraw);
  edCanvas.addEventListener('pointercancel', endDraw);
  edCanvas.addEventListener('lostpointercapture', endDraw);
  edCanvas.addEventListener('dblclick', (e) => {
    const d = editable();
    const s = sel();
    if (!d || !s || d.tool !== 'curve' || d.pts.length <= 2) return;
    const r = edCanvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const hit = d.pts.findIndex((q) => {
      const [x, y] = toPx(q, r.width, r.height);
      return Math.hypot(x - px, y - py) < HIT_PX;
    });
    if (hit >= 0) updateStep(s.id, (x) => ({ ...x, draw: { tool: 'curve', pts: d.pts.filter((_, i) => i !== hit) } }) as Step);
  });

  // ---------------- batch ----------------
  const stepper = buildStepper('shape', opts);
  const seedLabel = h('span', { id: 'shape-seed', class: 'mono-label', title: 'The chain’s seed (saved with it)' });
  const varyBox = h('input', { type: 'checkbox', id: 'shape-vary' });
  varyBox.addEventListener('change', () => setChain((c) => ({ ...c, varySeed: varyBox.checked })));
  const rerollBtn = h('button', { id: 'shape-reroll', class: 'small', 'aria-label': 'Reroll the seed', onclick: () => setChain((c) => ({ ...c, seed: randomSeed() })) }, 'Reroll');
  const seedBox = h(
    'div',
    { class: 'gen-seedbox', id: 'shape-seedbox' },
    h('span', {}, 'Seed'),
    seedLabel,
    rerollBtn,
    h('label', { class: 'shape-check', title: 'Seeded steps use a different seed for each waveform of the batch' }, varyBox, 'Vary'),
  );
  const applyPick = h('select', { id: 'shape-apply', 'aria-label': 'Apply the chain to', title: 'What the chain applies to' });
  const fillApply = () => {
    const voices = model.voices.map((v, i) => h('option', { value: `v:${v.id}` }, `V${i + 1} window`));
    const wts = model.wavetables.filter((w) => w.builtin === 'grid' || w.builtin === 'batches' || !w.builtin).map((w) => h('option', { value: `w:${w.id}` }, w.name));
    applyPick.replaceChildren(
      h('option', { value: 'sel' }, 'Selection'),
      h('option', { value: 'last' }, 'Last batch'),
      ...(voices.length ? [h('optgroup', { label: 'Voice windows' }, ...voices)] : []),
      ...(wts.length ? [h('optgroup', { label: 'Wavetables' }, ...wts)] : []),
    );
    if (![...applyPick.options].some((o) => o.value === applyTo)) applyTo = 'sel';
    applyPick.value = applyTo;
  };
  applyPick.addEventListener('change', () => {
    applyTo = applyPick.value;
    targetsCache = null;
    strip.setShown(0);
    syncBatch();
    onSource();
  });
  const writeBox = h('input', { type: 'checkbox', id: 'shape-writeback' });
  writeBox.addEventListener('change', () => {
    writeBack = writeBox.checked;
    syncBatch();
  });
  const writeLabel = h('label', { class: 'shape-check', id: 'shape-writeback-label', title: 'Put each result in its source’s slot (one undo step)' }, writeBox, 'Write back');
  const addShownBtn = h('button', { id: 'shape-add-shown', 'aria-keyshortcuts': 'A', onclick: () => addShown() }, 'Add shown');
  const addBatchBtn = h('button', { id: 'shape-add-batch', 'aria-keyshortcuts': 'N', class: 'primary', onclick: () => addBatch() }, 'Add +N');
  const status = h('div', { class: 'gen-status', id: 'shape-status', role: 'status' });
  const flash = flasher(status);
  const strip = buildStrip('shape-strip', {
    onShow: () => {
      mainDirty = thumbsDirty = true;
    },
  });
  const batchBox = h(
    'div',
    { class: 'gen-box gen-batch' },
    h('div', { class: 'gen-batch-head' }, h('span', { class: 'gen-h' }, 'Apply to'), applyPick, writeLabel, stepper.el, seedBox, status, h('div', { class: 'gen-adds' }, addShownBtn, addBatchBtn)),
    strip.el,
  );

  const cardLabel = (i: number, n: number) => {
    const sw = chain().steps.find((s) => s.on && s.amountEnd !== undefined);
    const amt = sw && n > 1 ? ` · ${pct(stepAmount(sw, batchUOf({ index: i, count: n })))}` : '';
    if (multi()) {
      const t = srcFor(i);
      return `${t ? `#${model.indexOf(t.id) + 1}` : '—'}${amt}`;
    }
    if (n <= 1) return 'result';
    return `#${i + 1}${amt}`;
  };
  let stripSig = '';
  const syncBatch = () => {
    const n = batchN();
    const sweeps = n > 1;
    const sig = JSON.stringify([n, chain().steps.map((s) => (s.on ? [s.amount, s.amountEnd] : 0)), chain().varySeed, applyTo, targets().tables.map((t) => [t.id, model.indexOf(t.id)])]);
    if (sig !== stripSig) {
      const atEnd = strip.shown() >= strip.cards.length - 1;
      stripSig = sig;
      strip.resize(n, (i) => cardLabel(i, n));
      if (atEnd) strip.setShown(n - 1);
      cardsDirty = mainDirty = true;
    }
    const t = targets();
    const wt = t.wtId === undefined ? undefined : model.wavetable(t.wtId);
    writeLabel.hidden = !wt || !!wt.builtin;
    writeBox.checked = writeBack;
    writeBox.disabled = !!wt?.live;
    writeLabel.title = wt?.live ? 'Freeze the wavetable to write back into it (a Live one takes every add)' : 'Put each result in its source’s slot (one undo step)';
    stepper.el.hidden = multi() || !sweeps;
    addBatchBtn.hidden = !sweeps && !writingBack();
    addBatchBtn.textContent = writingBack() ? `Write back ${n}` : `Add +${n}`;
    addShownBtn.textContent = sweeps ? 'Add shown' : 'Add';
    addShownBtn.hidden = writingBack();
    seedBox.hidden = !chainUsesSeed(chain());
    seedLabel.textContent = hex(chain().seed);
    rerollBtn.title = `Seed ${hex(chain().seed)} — reroll it`;
    varyBox.checked = chain().varySeed;
    srcDirty = true;
  };

  // ---------------- result job ----------------
  let job: Job | null = null;
  let lastStart = -Infinity;
  /** Sources of the N results, or null when there is nothing to shape. */
  const jobSources = (): WaveTable[] | null => {
    const n = batchN();
    const srcs = Array.from({ length: n }, (_, i) => srcFor(i));
    return srcs.every((x): x is WaveTable => !!x) ? srcs : null;
  };
  const keyOf = (srcs: WaveTable[] | null, c: ShapeChain) => (srcs ? `${srcs.map((x) => x.id).join(',')}|${JSON.stringify(c)}` : 'none');
  const startJob = (): Job | null => {
    const srcs = jobSources();
    const c = chain();
    job = srcs ? { key: keyOf(srcs, c), srcs, chain: c, n: srcs.length, tables: new Array(srcs.length), errors: new Array(srcs.length), next: 0 } : null;
    cardsDirty = true;
    return job;
  };
  const currentJob = (): Job | null => (job?.key === keyOf(jobSources(), chain()) ? job : startJob());
  /** Result i of the job (computed if missing), or undefined when the chain fails on it (j.errors[i] says why). */
  const computeOne = (j: Job, i: number): GeneratedTable | undefined => {
    let t = j.tables[i];
    if (!t && !j.errors[i]) {
      const b = { index: i, count: j.n };
      try {
        t = { data: applyChain(j.srcs[i].data, j.chain, b, chainEnv()), recipe: shapeRecipe(j.srcs[i].id, j.chain, b) };
        j.tables[i] = t;
      } catch (e) {
        j.errors[i] = chainError(e);
      }
      cardsDirty = true;
    }
    return t;
  };
  const work = (j: Job, deadline: number) => {
    computeOne(j, Math.min(strip.shown(), j.n - 1));
    while (j.next < j.n && performance.now() < deadline) computeOne(j, j.next++);
  };

  const silent = (t: GeneratedTable) => !t.data.some((v) => v !== 0);
  const SILENT = 'The result is silent: nothing added (check steps that replace or multiply by zero)';
  const addShown = () => {
    const j = currentJob();
    if (!j) return;
    const i = Math.min(strip.shown(), j.n - 1);
    const t = computeOne(j, i);
    if (!t) return flash(`Not added: ${j.errors[i]}`, true);
    if (silent(t)) return flash(SILENT, true);
    if (!model.addTables([t], false).length) return; // refused (Timeline full): the notice says why
    if (applyTo === 'last') return fromLastBatchDone(1);
    flash(multi() ? `Added the result for ${cardLabel(i, j.n).split(' ')[0]} to the Timeline` : j.n > 1 ? `Added #${i + 1} to the Timeline (the source stays selected)` : 'Added to the Timeline (the source stays selected)');
  };
  const addBatch = () => {
    const j = currentJob();
    if (!j) return;
    const all = Array.from({ length: j.n }, (_, i) => computeOne(j, i));
    const bad = all.findIndex((t) => !t);
    if (bad >= 0) return flash(`Not added: #${bad + 1}: ${j.errors[bad]}`, true);
    const tables = all as GeneratedTable[];
    if (tables.some(silent)) return flash(SILENT, true);
    if (writingBack()) {
      const t = targets();
      if (!model.addReplacing(tables, t.wtId!, t.cells!).length) return;
      return flash(`Wrote ${tables.length} results back into ${t.label} (one undo step)`);
    }
    if (!model.addTables(tables, false).length) return;
    if (applyTo === 'last') return fromLastBatchDone(tables.length);
    flash(multi() ? `Added ${tables.length} results to the Timeline (one per source)` : `Added ${tables.length} waveforms to the Timeline (the source stays selected)`);
  };
  /** After adding from Last batch, it holds the results: go back to the selection rather than shape them again. */
  const fromLastBatchDone = (n: number) => {
    applyTo = 'sel';
    targetsCache = null;
    applyPick.value = 'sel';
    syncBatch();
    onSource();
    flash(`Added ${n} result${n === 1 ? '' : 's'}; Last batch now holds them, so Apply to is back on Selection`);
  };

  const drawCards = () => {
    cardsDirty = false;
    const src = source();
    const cur = job && job.key === keyOf(jobSources(), chain()) ? job : null;
    strip.cards.forEach((c, i) => {
      const t = cur && i < cur.n ? cur.tables[i] : undefined;
      const err = cur && i < cur.n ? cur.errors[i] : undefined;
      c.el.classList.toggle('failed', !!err);
      c.el.title = err ? `Error: ${err}` : '';
      if (err && c.drawn) {
        c.drawn = null;
        drawCard(c, undefined);
      }
      if (c.drawn === t || (!t && src)) return;
      c.drawn = t;
      drawCard(c, t?.data);
    });
  };

  const drawSource = () => {
    srcDirty = false;
    const src = source();
    const idx = src ? model.indexOf(src.id) : -1;
    if (multi()) {
      const t = targets();
      srcNo.textContent = `${t.label} · ${t.tables.length}`;
      srcChip.title = t.tables.length ? `${t.label}: ${t.tables.length} waveforms; the plot shows #${idx + 1} (the shown card’s)` : `${t.label} is empty`;
    } else {
      srcNo.textContent = src ? `#${idx + 1}` : '—';
      srcChip.title = src ? `The Timeline selection: #${idx + 1} · id ${src.id} · ${describeRecipe(src.recipe)}` : 'Select a waveform in the Timeline';
    }
    const n = batchN();
    const room1 = model.roomFor(1);
    const roomN = model.roomFor(n);
    const noSteps = !chain().steps.some((s) => s.on);
    addShownBtn.disabled = !src || !room1 || noSteps;
    addBatchBtn.disabled = !src || !roomN || noSteps;
    addShownBtn.title = !room1 ? model.fullMessage() : noSteps ? 'Turn on at least one step' : '';
    addBatchBtn.title = !roomN ? model.fullMessage() : noSteps ? 'Turn on at least one step' : '';
    const g = fitFixed(srcThumb, SRC_W, SRC_H);
    if (src) drawWave(g, 0, 0, SRC_W, SRC_H, src.data, cssColor('--wave'), { lineWidth: 1.2, points: SRC_W * 2 });
  };

  const drawThumbs = () => {
    thumbsDirty = false;
    const st = source() ? stages() : null;
    const si = selIndex();
    chain().steps.forEach((s, i) => {
      const c = thumbs[i];
      if (!c) return;
      const g = fitFixed(c, THUMB_W, THUMB_H);
      const x = st?.all[i];
      if (!x) return;
      const r = Math.max(1, peakOf(x));
      drawWave(g, 0, 0, THUMB_W, THUMB_H, Array.from(x, (v) => v / r), cssColor(!s.on ? '--muted' : i === si ? '--accent-text' : '--text-2'), { lineWidth: 1.2, points: THUMB_W * 2 });
    });
  };

  // ---------------- assembly ----------------
  const el = h('div', { role: 'tabpanel', id: 'panel-shape', class: 'gen-tab shape' }, chainCol, h('div', { class: 'gen-main' }, head, params, viewer, batchBox));
  watchVisibility(el);

  const syncAll = () => {
    if (!chain().steps.some((s) => s.id === selId)) selId = chain().steps[Math.min(lastSelIndex, chain().steps.length - 1)]?.id ?? null;
    lastSelIndex = Math.max(0, selIndex());
    const cur = sel();
    if ((cur?.id ?? null) !== editEndFor) {
      // Another step: edit its start drawing.
      editEndFor = cur?.id ?? null;
      editEnd = false;
    }
    if (cur && `${cur.id}:${cur.op}` !== viewFor) {
      viewFor = `${cur.id}:${cur.op}`;
      view = viewOf(cur) ?? view;
    }
    fillChainPick();
    renderList();
    syncParams();
    syncView();
    syncBatch();
    mainDirty = thumbsDirty = true;
  };
  model.on('shape', syncAll);
  const onSource = () => {
    srcDirty = mainDirty = thumbsDirty = cardsDirty = true;
  };
  const onTargets = () => {
    fillApply();
    syncBatch();
    onSource();
  };
  model.on('timeline', onTargets);
  model.on('selection', onSource);
  model.on('wavetables', onTargets);
  model.on('voices', onTargets);
  opts.onCount((n) => {
    stepper.sync(n);
    syncBatch();
    flash('');
  });
  onThemeChange(() => {
    for (const c of strip.cards) c.drawn = null;
    thumbsDirty = cardsDirty = mainDirty = srcDirty = true;
  });
  new ResizeObserver(() => (mainDirty = true)).observe(viewer);

  fillApply();
  syncView();
  syncAll();
  stepper.sync(opts.count());

  return {
    el,
    view: {
      preview() {
        const cur = job && job.key === keyOf(jobSources(), chain()) ? job : null;
        return cur ? previewOf(cur.tables, null, strip.shown()) : null;
      },
      batch(deadline) {
        const j = currentJob();
        if (!j) return { error: 'Shape: select a source waveform in the Timeline' };
        const tables: GeneratedTable[] = [];
        for (let i = 0; i < j.n; i++) {
          if (!j.tables[i] && !j.errors[i] && performance.now() > deadline) return { wait: true };
          const t = computeOne(j, i);
          if (!t) return { error: `Shape: #${i + 1}: ${j.errors[i]}` };
          tables.push(t);
        }
        if (tables.some(silent)) return { error: 'Shape: a result is silent' };
        return { tables };
      },
      frame(now) {
        if (!opts.active() || !isOnScreen(el)) return;
        const deadline = performance.now() + BUDGET_MS;
        const key = keyOf(jobSources(), chain());
        if (job?.key !== key && now - lastStart >= PREVIEW_MS) {
          lastStart = now;
          startJob();
        }
        if (job?.key === key) work(job, deadline);
        if (srcDirty) drawSource();
        if (mainDirty) drawMain();
        if (thumbsDirty) drawThumbs();
        if (cardsDirty) drawCards();
      },
    },
  };
}
