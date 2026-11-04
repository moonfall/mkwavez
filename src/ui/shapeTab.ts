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
import { KMAX } from '../core/constants';
import { drawingSpan, drawingValue, resampleStroke, type Drawing, type DrawTool, type Pt } from '../core/drawing';
import { MUTATION_CHOICES } from '../core/mutations';
import { randomSeed } from '../core/prng';
import {
  applyChain,
  batchUOf,
  chainStages,
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
import { FACTORY_CHAINS } from '../core/shapeFactory';
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
  STEP_INFO,
  stepInfo,
  stepUsesSeed,
  WAVE_Y,
  type HarmModKind,
  type ShapeStep,
  type StepOp,
} from '../core/shapeSteps';
import { describeRecipe, type GeneratedTable, type WaveTable } from '../core/table';
import { buildStepper, buildStrip, drawCard, flasher } from './batch';
import { cssColor, drawWave, fit, fitFixed, onThemeChange } from './canvas';
import { isOnScreen, watchVisibility, type FrameView, type UiContext } from './context';
import { h } from './dom';
import { popupMenu } from './presets';

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
  src: WaveTable;
  chain: ShapeChain;
  n: number;
  tables: (GeneratedTable | undefined)[];
  next: number;
}

export function buildShapePanel(ctx: UiContext, opts: ShapePanelOpts): { el: HTMLElement; view: FrameView } {
  const { model } = ctx;
  const chain = () => model.shapeChain;
  let selId: string | null = chain().steps[0]?.id ?? null;
  let view: View = 'wave';

  const selIndex = () => {
    const i = chain().steps.findIndex((s) => s.id === selId);
    return i >= 0 ? i : chain().steps.length ? 0 : -1;
  };
  const sel = (): Step | undefined => chain().steps[selIndex()];
  const source = (): WaveTable | undefined => model.table(model.selectedId);
  const batchN = () => (chainSweeps(chain()) ? opts.count() : 1);

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
  const chainPick = h('select', { id: 'shape-chains', class: 'shape-chain-pick', 'aria-label': 'Load a chain', title: 'Load a factory chain (undoable)' });
  const fillChainPick = () => {
    chainPick.replaceChildren(
      h('option', { value: '' }, chain().name),
      h('optgroup', { label: 'Factory' }, ...FACTORY_CHAINS.map((f) => h('option', { value: `f:${f.id}` }, f.chain.name))),
    );
    chainPick.value = '';
  };
  chainPick.addEventListener('change', () => {
    const f = FACTORY_CHAINS.find((x) => `f:${x.id}` === chainPick.value);
    if (f) {
      model.setShapeChain(f.chain);
      selId = f.chain.steps[0]?.id ?? null;
      viewFor = null;
      syncAll();
      flash(`Loaded “${f.chain.name}”`);
    }
    chainPick.value = '';
  });
  const list = h('div', { id: 'shape-steps', class: 'shape-steps', role: 'listbox', 'aria-label': 'Steps (Alt+↑/↓ moves, Space turns on / off, Delete removes)' });
  const addBtn = h('button', { id: 'shape-add', class: 'shape-add', title: 'Add a step after the selected one' }, '+ Add step');
  const chainCol = h(
    'div',
    { class: 'gen-lib shape-chain' },
    h('div', { class: 'gen-lib-head' }, h('span', { class: 'gen-lib-title' }, 'Chain'), chainPick),
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
    return info.draws ?? (s.op === 'harmSet' || s.op === 'harmMod' ? 'harm' : null);
  };
  /** The step the view last followed: a newly selected step (any way) brings its view. */
  let viewFor: string | null = null;

  let rowSig = '';
  let dragId: string | null = null;
  const thumbs: HTMLCanvasElement[] = [];
  const renderList = () => {
    const c = chain();
    const si = selIndex();
    const sig = JSON.stringify([c.steps.map((s) => [s.id, s.op, s.on, stepSummary(s)]), si]);
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
          h('span', { class: 'shape-step-name' }, h('b', {}, `${i + 1} · ${stepInfo(s.op).label}`), h('span', {}, stepSummary(s))),
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
  const sweepBtn = h('button', { id: 'shape-sweep', class: 'small shape-sweep', title: 'Sweep this step’s amount across the batch (N different results)' }, '↦ Sweep');
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
  sweepBtn.addEventListener('click', () => {
    const s = sel();
    if (!s) return;
    if (s.amountEnd === undefined) updateStep(s.id, (x) => ({ ...x, amount: 0, amountEnd: x.amount || 1 }));
    else updateStep(s.id, (x) => {
      const { amountEnd, ...rest } = x;
      return { ...rest, amount: amountEnd } as Step;
    });
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
      (s) => ('draw' in s ? s.draw.tool : 'line'),
      (tool) => {
        const s = sel();
        if (!s || !('draw' in s)) return;
        updateStep(s.id, (x) => {
          const d = (x as DrawStep).draw;
          const pts = tool === 'line' && d.pts.length > 2 ? [d.pts[0], d.pts[d.pts.length - 1]] : d.pts;
          return { ...x, draw: { tool, pts } } as Step;
        });
      },
    );
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
          updateStep(s.id, (x) => ({ ...x, draw: x.op === 'harmLimit' ? DEFAULT_LIMIT_DRAW : defaultDrawing(x.op as DrawStep['op'] & Exclude<StepOp, 'harmLimit'>) }) as Step);
        },
      },
      'Reset',
    );
  const sep = () => h('span', { class: 'shape-sep', 'aria-hidden': 'true' });
  const note = (text: string) => h('span', { class: 'shape-note' }, text);

  const buildParams = (s: Step | undefined) => {
    syncs = [];
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
      kids.push(sep(), drawTools(), resetDraw());
    } else if (s.op === 'harmSet') {
      kids.push(
        select('shape-hmode', 'What to do with the set', Object.entries(MODE_LABELS) as [keyof typeof MODE_LABELS, string][], (x) => (x.op === 'harmSet' ? x.mode : 'keep'), (mode, x) => ({ ...x, mode }) as Step),
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
      kids.push(h('label', { class: 'shape-check' }, fund, 'Fundamental'));
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
      );
    } else if (s.op === 'mutation') {
      kids.push(
        select(
          'shape-mutation',
          'Mutation',
          MUTATION_CHOICES.map((m) => [m.id, `${m.group} › ${m.label}`] as const),
          (x) => (x.op === 'mutation' ? x.mutation : 'smooth'),
          (mutation, x) => ({ ...x, mutation }) as Step,
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
      ? JSON.stringify([s.id, s.op, s.op === 'harmSet' ? [s.mode === 'add' || s.mode === 'replace', s.set.kind === 'multiples' || s.set.kind === 'list', s.set.kind === 'drawn'] : 0, s.op === 'harmMod' ? s.kind : 0])
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
  const sideBox = h('div', { class: 'gen-plot-box' }, sideCanvas);
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
    const keys = c.steps.map((s) => `${JSON.stringify(s)}|${stepAmount(s, u)}|${stepUsesSeed(s) ? stepSeed(c, s, b) : ''}`);
    let keep = 0;
    if (stageCache && stageCache.srcId === src.id) while (keep < keys.length && keep < stageCache.keys.length && keys[keep] === stageCache.keys[keep]) keep++;
    const outs = chainStages(src.data, c, b, stageCache && stageCache.srcId === src.id ? stageCache.outs.slice(0, keep) : []);
    stageCache = { srcId: src.id, keys, outs };
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
  const dbOf = (x: ArrayLike<number>): Float64Array => {
    const n = x.length;
    const m = new Float64Array(KMAX + 1);
    // Direct DFT over KMAX harmonics (cheap enough for one plot).
    for (let k = 1; k <= KMAX; k++) {
      let re = 0;
      let im = 0;
      const w = (2 * Math.PI * k) / n;
      for (let i = 0; i < n; i += 1) {
        re += x[i] * Math.cos(w * i);
        im -= x[i] * Math.sin(w * i);
      }
      m[k] = Math.hypot(re, im);
    }
    return m;
  };
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
    return { di: toDb(specCache.mi, ref), dout: toDb(specCache.mo, ref) };
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
  const editable = (): Drawing | null => {
    const s = sel();
    if (!s || !('draw' in s)) return null;
    return (s.op === 'harmLimit') === (view === 'harm') ? s.draw : null;
  };

  const drawDrawing = (g: CanvasRenderingContext2D, d: Drawing, w: number, hh: number, mirror: boolean) => {
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
      return;
    }
    const { inp, out } = st;
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
      const d = s && isDrawOp(s.op) && 'draw' in s ? s.draw : null;
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
      bars(g, di, w, hh - DOTS_H, cssColor('--border-strong'), 0.85);
      g.globalAlpha = 0.9;
      bars(g, dout, w, hh - DOTS_H, cssColor('--accent'), 0.45);
      g.globalAlpha = 1;
      if (s && s.op === 'harmLimit') drawDrawing(g, s.draw, w, hh, false);
      if (s && s.op === 'harmSet' && s.set.kind === 'drawn') {
        // The painted level of each harmonic: a tick across its bar.
        g.strokeStyle = cssColor('--v2');
        g.lineWidth = 2;
        g.beginPath();
        const bw = (w / KMAX) * 0.8;
        s.set.mags.forEach((db, i) => {
          if (db <= HARM_DB[0]) return;
          const y = Math.round(((hh - DOTS_H) * -db) / -HARM_DB[0]) + 0.5;
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
      );
    }
    // Hint when this step has nothing to draw in this view.
    const drawnSet = !!s && s.op === 'harmSet' && s.set.kind === 'drawn';
    const otherView = !!s && ('draw' in s || drawnSet) && !canDraw;
    edHint.hidden = !otherView;
    if (otherView) edHint.textContent = view === 'wave' ? 'This step draws on the harmonics: switch to Harmonics' : 'This step draws on the waveform: switch to Waveform';
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
  let drawing: { pt: [number, number] | null; raw: Pt[] | null; stepId: string; stroke: number; draw: Drawing } | null = null;
  let strokeNo = 0;
  const commitDraw = (d: Drawing) => {
    if (!drawing) return;
    const id = drawing.stepId;
    const key = `draw:${id}:${drawing.stroke}`;
    updateStep(id, (x) => ({ ...x, draw: d }) as Step, key);
  };
  const ptsOf = (d: Drawing): [number, number][] => d.pts.map((p) => [p[0], p[1]]);
  let painting: { stepId: string; stroke: number; mags: number[]; lastK: number } | null = null;
  const paintAt = (e: PointerEvent) => {
    if (!painting) return;
    const r = edCanvas.getBoundingClientRect();
    const [u, db0] = fromPx(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
    const k = clamp(Math.round(1 + u * (KMAX - 1)), 1, KMAX);
    // The bottom few dB (and the dots row) remove the harmonic.
    const db = db0 <= HARM_DB[0] + 2 ? HARM_DB[0] : Math.round(db0 * 10) / 10;
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
    if (d.tool !== 'free') {
      const hit = pts.findIndex((q) => {
        const [x, y] = toPx(q, r.width, hh);
        return Math.hypot(x - px, y - py) < HIT_PX;
      });
      if (hit >= 0) {
        drawing = { pt: pts[hit], raw: null, stepId: s.id, stroke: strokeNo, draw: { tool: d.tool, pts } };
        return;
      }
    }
    if (d.tool === 'line') {
      const np: [number, number][] = [[p[0], p[1]], [p[0], p[1]]];
      drawing = { pt: np[1], raw: null, stepId: s.id, stroke: strokeNo, draw: { tool: 'line', pts: np } };
    } else if (d.tool === 'curve') {
      const q: [number, number] = [p[0], p[1]];
      pts.push(q);
      pts.sort((a, b) => a[0] - b[0]);
      drawing = { pt: q, raw: null, stepId: s.id, stroke: strokeNo, draw: { tool: 'curve', pts } };
      commitDraw(drawing.draw);
    } else {
      drawing = { pt: null, raw: [p], stepId: s.id, stroke: strokeNo, draw: { tool: 'free', pts: [p] } };
    }
  });
  edCanvas.addEventListener('pointermove', (e) => {
    if (painting) return paintAt(e);
    if (!drawing) return;
    const r = edCanvas.getBoundingClientRect();
    const p = fromPx(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
    if (drawing.pt) {
      drawing.pt[0] = p[0];
      drawing.pt[1] = p[1];
      const pts = (drawing.draw.pts as [number, number][]).slice().sort((a, b) => a[0] - b[0]);
      drawing.draw = { tool: drawing.draw.tool, pts };
    } else if (drawing.raw) {
      drawing.raw.push(p);
      drawing.draw = { tool: 'free', pts: resampleStroke(drawing.raw) };
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
    const d = drawing.draw;
    // A click without a drag (line tool): a horizontal line across the whole cycle at that level.
    if (d.tool === 'line' && d.pts.length === 2 && Math.abs(d.pts[1][0] - d.pts[0][0]) < 0.01) commitDraw({ tool: 'line', pts: [[0, d.pts[0][1]], [1, d.pts[0][1]]] });
    else commitDraw(d);
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
  const seedBox = h(
    'div',
    { class: 'gen-seedbox', id: 'shape-seedbox' },
    h('span', {}, 'Seed'),
    seedLabel,
    h('button', { id: 'shape-reroll', class: 'small', 'aria-label': 'Reroll the seed', onclick: () => setChain((c) => ({ ...c, seed: randomSeed() })) }, 'Reroll'),
    h('label', { class: 'shape-check', title: 'Seeded steps use a different seed for each waveform of the batch' }, varyBox, 'Vary'),
  );
  const addShownBtn = h('button', { id: 'shape-add-shown', onclick: () => addShown() }, 'Add shown');
  const addBatchBtn = h('button', { id: 'shape-add-batch', class: 'primary', onclick: () => addBatch() }, 'Add +N');
  const status = h('div', { class: 'gen-status', id: 'shape-status', role: 'status' });
  const flash = flasher(status);
  const strip = buildStrip('shape-strip', {
    onShow: () => {
      mainDirty = true;
    },
  });
  const batchBox = h(
    'div',
    { class: 'gen-box gen-batch' },
    h('div', { class: 'gen-batch-head' }, h('span', { class: 'gen-h' }, 'Batch'), stepper.el, seedBox, status, h('div', { class: 'gen-adds' }, addShownBtn, addBatchBtn)),
    strip.el,
  );

  const cardLabel = (i: number, n: number) => {
    const sw = chain().steps.find((s) => s.on && s.amountEnd !== undefined);
    if (n <= 1 || !sw) return 'result';
    return `#${i + 1} · ${pct(stepAmount(sw, batchUOf({ index: i, count: n })))}`;
  };
  let stripSig = '';
  const syncBatch = () => {
    const n = batchN();
    const sweeps = n > 1;
    const sig = JSON.stringify([n, chain().steps.map((s) => (s.on ? [s.amount, s.amountEnd] : 0))]);
    if (sig !== stripSig) {
      const atEnd = strip.shown() >= strip.cards.length - 1;
      stripSig = sig;
      strip.resize(n, (i) => cardLabel(i, n));
      if (atEnd) strip.setShown(n - 1);
      cardsDirty = mainDirty = true;
    }
    stepper.el.hidden = !sweeps;
    addBatchBtn.hidden = !sweeps;
    addBatchBtn.textContent = `Add +${n}`;
    addShownBtn.textContent = sweeps ? 'Add shown' : 'Add';
    seedBox.hidden = !chainUsesSeed(chain());
    seedLabel.textContent = hex(chain().seed);
    varyBox.checked = chain().varySeed;
    srcDirty = true;
  };

  // ---------------- result job ----------------
  let job: Job | null = null;
  let lastStart = -Infinity;
  const keyOf = (src: WaveTable | undefined, c: ShapeChain, n: number) => (src ? `${src.id}|${JSON.stringify(c)}|${n}` : 'none');
  const startJob = (): Job | null => {
    const src = source();
    const c = chain();
    const n = batchN();
    job = src ? { key: keyOf(src, c, n), src, chain: c, n, tables: new Array(n), next: 0 } : null;
    cardsDirty = true;
    return job;
  };
  const currentJob = (): Job | null => (job?.key === keyOf(source(), chain(), batchN()) ? job : startJob());
  const computeOne = (j: Job, i: number): GeneratedTable => {
    let t = j.tables[i];
    if (!t) {
      const b = { index: i, count: j.n };
      t = { data: applyChain(j.src.data, j.chain, b), recipe: shapeRecipe(j.src.id, j.chain, b) };
      j.tables[i] = t;
      cardsDirty = true;
    }
    return t;
  };
  const work = (j: Job, deadline: number) => {
    computeOne(j, Math.min(strip.shown(), j.n - 1));
    while (j.next < j.n && performance.now() < deadline) computeOne(j, j.next++);
  };

  const addShown = () => {
    const j = currentJob();
    if (!j) return;
    const i = Math.min(strip.shown(), j.n - 1);
    if (!model.addTables([computeOne(j, i)], false).length) return; // refused (Timeline full): the notice says why
    flash(j.n > 1 ? `Added #${i + 1} to the Timeline (the source stays selected)` : 'Added to the Timeline (the source stays selected)');
  };
  const addBatch = () => {
    const j = currentJob();
    if (!j) return;
    const tables = Array.from({ length: j.n }, (_, i) => computeOne(j, i));
    if (!model.addTables(tables, false).length) return;
    flash(`Added ${tables.length} waveforms to the Timeline (the source stays selected)`);
  };

  const drawCards = () => {
    cardsDirty = false;
    const src = source();
    const cur = job && job.src === src && job.chain === chain() ? job : null;
    strip.cards.forEach((c, i) => {
      const t = cur && i < cur.n ? cur.tables[i] : undefined;
      if (c.drawn === t || (!t && src)) return;
      c.drawn = t;
      drawCard(c, t?.data);
    });
  };

  const drawSource = () => {
    srcDirty = false;
    const src = source();
    const idx = model.indexOf(model.selectedId);
    srcNo.textContent = src ? `#${idx + 1}` : '—';
    srcChip.title = src ? `The Timeline selection: #${idx + 1} · id ${src.id} · ${describeRecipe(src.recipe)}` : 'Select a waveform in the Timeline';
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
    if (!chain().steps.some((s) => s.id === selId)) selId = chain().steps[Math.min(Math.max(0, selIndex()), chain().steps.length - 1)]?.id ?? null;
    const cur = sel();
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
  model.on('timeline', onSource);
  model.on('selection', onSource);
  model.on('wavetables', () => (srcDirty = true));
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

  syncView();
  syncAll();
  stepper.sync(opts.count());

  return {
    el,
    view: {
      frame(now) {
        if (!opts.active() || !isOnScreen(el)) return;
        const deadline = performance.now() + BUDGET_MS;
        const key = keyOf(source(), chain(), batchN());
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
