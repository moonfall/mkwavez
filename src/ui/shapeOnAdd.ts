/**
 * "Shape on add" for Seed, Mutate and Breed: a chip in the batch row whose menu picks a Shape
 * chain (none, the Shape tab's chain, a factory or saved chain). The tab's finalTable()
 * passes each previewed / added table through apply(): the chain at the table's batch
 * position, recorded in its recipe (`Recipe.shape`) so renderRecipe reproduces it. The
 * choice is a UI pref per tab (saved with the session).
 */
import { compileRule } from '../browser/formulaEval';
import { FormulaAborted } from '../core/generators/formula';
import { applyChain, chainJson, ShapeStepError, type BatchPos, type ChainEnv, type ShapeChain } from '../core/shapeChain';
import { FACTORY_CHAINS } from '../core/shapeFactory';
import type { GeneratedTable } from '../core/table';
import type { GeneratePreview, UiContext } from './context';
import { h } from './dom';
import { popupMenu } from './presets';

/** Longest a chain may take on one waveform in the UI before it is stopped (a runaway Rules step). */
export const CHAIN_CAP_MS = 150;

/**
 * What chains need in the browser: the Rules step's compiler, and a stop CHAIN_CAP_MS after
 * the rules start evaluating (the clock starts at the first poll, so other steps don't count).
 */
export function chainEnv(): ChainEnv {
  let stopAt = 0;
  return {
    compileRule,
    abort: () => {
      const now = performance.now();
      if (!stopAt) stopAt = now + CHAIN_CAP_MS;
      return now > stopAt;
    },
  };
}

/** A failed chain's message (a runaway rule says so). */
export function chainError(e: unknown): string {
  if (e instanceof ShapeStepError && e.cause instanceof FormulaAborted) return `Step ${e.index + 1} is too slow (its rules took over ${CHAIN_CAP_MS} ms on one waveform): simplify them`;
  return e instanceof Error ? e.message : String(e);
}

export interface ShapeOnAdd {
  el: HTMLElement;
  /** The chosen chain, or null (none). */
  chain(): ShapeChain | null;
  /** Why the chosen chain fails (a Rules step whose rule fails; waveforms then stay unshaped), or ''. */
  failure(): string;
  /** t shaped by the chosen chain at its batch position (t itself when none); memoised per table. */
  apply(t: GeneratedTable, b: BatchPos): GeneratedTable;
  /** Like apply(), but undefined if it isn't memoised and `deadline` (performance.now()) has passed: try again next frame. */
  applyWithin(t: GeneratedTable, b: BatchPos, deadline: number): GeneratedTable | undefined;
}

/**
 * A Generate tab's preview from its job's tables (null until every one is computed and, with a
 * Shape chain on, shaped within `budgetMs` this frame; the rest on later frames).
 */
export function previewOf(tables: readonly (GeneratedTable | undefined)[], shapeOn: ShapeOnAdd | null, shown: number, budgetMs = 2): GeneratePreview | null {
  if (!tables.length) return null;
  const deadline = performance.now() + budgetMs;
  const batch: Float32Array[] = [];
  for (let i = 0; i < tables.length; i++) {
    const raw = tables[i];
    if (!raw) return null;
    const t = shapeOn ? shapeOn.applyWithin(raw, { index: i, count: tables.length }, deadline) : raw;
    if (!t) return null;
    batch.push(t.data);
  }
  return { batch, shown: Math.max(0, Math.min(batch.length - 1, shown)) };
}

/** Main-thread time a tab's card drawing may spend shaping per frame. */
export const SHAPE_CARDS_MS = 6;

/** Menu item id for a choice value ('none', 'tab', 'f:<id>', 'u:<id>'). */
export const shapeChoiceId = (prefix: string, value: string) => `${prefix}-shape-${value.replace(':', '-')}`;

export function buildShapeOnAdd(ctx: UiContext, prefix: string, onChange: () => void): ShapeOnAdd {
  const { model, ui } = ctx;
  const prefKey = `shapeOnAdd.${prefix}`;
  const resolve = (v: string): ShapeChain | null => {
    if (v === 'tab') return model.shapeChain;
    if (v.startsWith('f:')) return FACTORY_CHAINS.find((f) => `f:${f.id}` === v)?.chain ?? null;
    if (v.startsWith('u:')) return model.shapeChains.find((c) => `u:${c.id}` === v)?.chain ?? null;
    return null;
  };
  /** The chosen value; a saved chain that was deleted counts as none. */
  const choice = () => {
    const v = ui.pref(prefKey, 'none', (x) => typeof x === 'string');
    return v === 'none' || resolve(v) ? v : 'none';
  };
  const value = h('span', { class: 'shape-chip-v' });
  const el = h(
    'button',
    { id: `${prefix}-shape`, class: 'shape-chip', 'aria-label': 'Shape each added waveform with a chain' },
    h('span', { class: 'shape-chip-k' }, 'Shape'),
    value,
  );
  const pick = (v: string) => ui.setPref(prefKey, v);
  popupMenu(`${prefix}-shape-menu`, el, () => {
    const cur = choice();
    const item = (v: string, label: string) =>
      h(
        'button',
        { id: shapeChoiceId(prefix, v), role: 'menuitemradio', 'aria-checked': String(v === cur), class: 'menu-item', onclick: () => pick(v) },
        h('b', {}, `${v === cur ? '✓ ' : ''}${label}`),
      );
    const group = (label: string) => h('button', { class: 'menu-group', disabled: true, tabindex: -1 }, label);
    return [
      item('none', 'None'),
      item('tab', `Shape tab: ${model.shapeChain.name}`),
      group('Factory'),
      ...FACTORY_CHAINS.map((f) => item(`f:${f.id}`, f.chain.name)),
      ...(model.shapeChains.length ? [group('Yours'), ...model.shapeChains.map((c) => item(`u:${c.id}`, c.chain.name))] : []),
    ];
  });

  let lastJson = '';
  /** Set when the chain failed on a waveform: the chip warns and the waveform stays unshaped. */
  let failure = '';
  const showFailure = () => {
    el.classList.toggle('warn', !!failure);
    if (failure) el.title = failure;
  };
  const sync = (notify = true) => {
    const v = choice();
    const c = resolve(v);
    value.textContent = c ? (v === 'tab' ? `tab: ${c.name}` : c.name) : 'off';
    el.classList.toggle('on', !!c);
    el.title = c ? `Each added waveform is shaped by “${c.name}”${v === 'tab' ? ' (the Shape tab’s chain)' : ''}` : 'Shape each added waveform with a chain (off)';
    const json = c ? chainJson(c) : '';
    if (json !== lastJson) {
      lastJson = json;
      failure = '';
      if (notify) onChange();
    }
    showFailure();
  };
  model.on('shape', () => sync());
  ui.onPrefs(() => sync());
  // The owner is still being built: no change callback for the initial state.
  sync(false);

  const memo = new WeakMap<GeneratedTable, { json: string; out: GeneratedTable }>();
  const self: ShapeOnAdd = {
    el,
    chain: () => resolve(choice()),
    failure: () => failure,
    applyWithin(t, b, deadline) {
      const c = resolve(choice());
      if (!c || !c.steps.some((s) => s.on)) return t;
      const m = memo.get(t);
      if (m && m.json === (lastJson || chainJson(c))) return m.out;
      return performance.now() < deadline ? self.apply(t, b) : undefined;
    },
    apply(t, b) {
      const c = resolve(choice());
      if (!c || !c.steps.some((s) => s.on)) return t;
      const json = lastJson || chainJson(c);
      const m = memo.get(t);
      if (m && m.json === json) return m.out;
      // The recipe's batch position is what renderRecipe applies the chain at.
      const pos = t.recipe.batch ?? { index: b.index, count: b.count };
      let out: GeneratedTable;
      try {
        out = { data: applyChain(t.data, c, pos, chainEnv()), recipe: { ...t.recipe, batch: pos, shape: json } };
      } catch (e) {
        // A chain that fails here (a Rules step) isn't applied: the waveform (and its recipe) stay unshaped.
        out = t;
        failure = `“${c.name}” fails (${chainError(e)}): waveforms are added unshaped`;
        showFailure();
      }
      memo.set(t, { json, out });
      return out;
    },
  };
  return self;
}
