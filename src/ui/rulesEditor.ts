/**
 * The Harmonic rules editor (Seed entry and the Shape step "Rules"): one row per rule —
 * its colour and number, an enable toggle, the condition and value fields, move up / down
 * and remove — plus "+ Rule" and the variable legend. Errors show under their row, like the
 * formula editor's. The owner keeps the rules; the editor reports edits through onChange
 * and shows what sync() gives it (a focused field is left alone while typing).
 */
import { MAX_RULE_EXPR, MAX_RULES, type HarmonicRule } from '../core/generators/harmonicRules';
import { cssColor } from './canvas';
import { h } from './dom';

/** Rule colours (CSS tokens --rule-1 … --rule-8, both themes), repeating after 8. */
export const RULE_COLOR_COUNT = 8;
export const ruleColorVar = (i: number) => `--rule-${(i % RULE_COLOR_COUNT) + 1}`;
/** Rule i's colour as a canvas colour (the basis plot's stems). */
export const ruleColor = (i: number) => cssColor(ruleColorVar(i));

export interface RulesEditorOpts {
  /** Element id prefix (rows: `${id}-when-0`, `${id}-value-0`, `${id}-on-0`, …). */
  readonly id: string;
  /** The rules after an edit; `gesture` groups a run of typing into one undo step. */
  onChange(rules: HarmonicRule[], gesture?: string): void;
  /** A key was typed in a field (owners debounce their previews). */
  onTyping?(): void;
  /** A typing run ended (the field lost focus or Enter). */
  onCommit?(): void;
  /** Extra legend items after the variables. */
  readonly legendExtra?: string;
}

export interface RulesEditor {
  readonly el: HTMLElement;
  /** Show these rules. */
  sync(rules: readonly HarmonicRule[]): void;
  /** Per-rule errors (compile or runtime); undefined = fine. */
  setErrors(errors: readonly (string | undefined)[]): void;
}

interface Row {
  el: HTMLElement;
  on: HTMLInputElement;
  when: HTMLInputElement;
  value: HTMLInputElement;
  up: HTMLButtonElement;
  down: HTMLButtonElement;
  err: HTMLElement;
}

export function buildRulesEditor(o: RulesEditorOpts): RulesEditor {
  let rules: HarmonicRule[] = [];
  let rows: Row[] = [];
  const list = h('div', { class: 'rules-list', id: `${o.id}-list`, role: 'list', 'aria-label': 'Rules, applied in order' });
  const addBtn = h(
    'button',
    {
      id: `${o.id}-add`,
      class: 'small',
      title: `Add a rule at the end (at most ${MAX_RULES})`,
      onclick: () => change([...rules, { when: '', value: 'v', on: true }]),
    },
    '+ Rule',
  );
  const legendItem = (name: string, text: string) => h('span', {}, h('b', {}, name), ` ${text}`);
  const legend = h(
    'div',
    {
      class: 'seed-legend rules-legend',
      title:
        'Each rule is a pass over k = 1…72 (ascending): where the condition is non-zero (empty = always) the harmonic takes the value. ' +
        'k harmonic · K = 72 · v its current value · a(j) harmonic j (lower ones already updated by this rule) · n, u batch index / position · ' +
        'prime(x) · db(x) dB → linear · rand(x) seeded 0–1 · pnoise(freq, z, oct, pers) · Math and the waveform functions. Negative = inverted.',
    },
    addBtn,
    legendItem('k', 'harmonic'),
    legendItem('v', 'value'),
    legendItem('a(j)', 'harmonic j'),
    legendItem('n u', 'batch'),
    legendItem('K', '72'),
    h('span', {}, h('b', {}, 'prime() db() rand()')),
    ...(o.legendExtra ? [h('span', {}, o.legendExtra)] : []),
  );
  const el = h('div', { class: 'rules-editor', id: o.id }, list, legend);

  const change = (next: HarmonicRule[], gesture?: string) => {
    rules = next;
    render();
    o.onChange(next.map((r) => ({ ...r })), gesture);
  };
  const edit = (i: number, patch: Partial<HarmonicRule>, gesture?: string) => change(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)), gesture);
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= rules.length) return;
    const next = rules.slice();
    [next[i], next[j]] = [next[j], next[i]];
    change(next);
    // Keep the moved rule's button under the keyboard.
    (d < 0 ? rows[j].up : rows[j].down).focus();
  };

  const field = (i: number, key: 'when' | 'value', label: string, placeholder: string) => {
    const input = h('input', {
      type: 'text',
      id: `${o.id}-${key}-${i}`,
      class: `seed-expr rules-${key}`,
      'aria-label': `Rule ${i + 1} ${label}`,
      placeholder,
      maxlength: MAX_RULE_EXPR,
      spellcheck: false,
      autocapitalize: 'off',
      autocomplete: 'off',
    });
    input.addEventListener('input', () => {
      o.onTyping?.();
      edit(i, { [key]: input.value }, `rule-${key}-${i}`);
    });
    input.addEventListener('change', () => o.onCommit?.());
    return input;
  };

  const buildRow = (i: number): Row => {
    const on = h('input', { type: 'checkbox', id: `${o.id}-on-${i}`, 'aria-label': `Rule ${i + 1} on`, title: 'Rule on / off' });
    on.addEventListener('change', () => edit(i, { on: on.checked }));
    const when = field(i, 'when', 'condition', 'always');
    const value = field(i, 'value', 'value', 'value');
    const btn = (key: string, label: string, text: string, onclick: () => void) =>
      h('button', { id: `${o.id}-${key}-${i}`, class: 'small icon-btn', 'aria-label': `${label} rule ${i + 1}`, title: label, onclick }, text);
    const up = btn('up', 'Move up', '▲', () => move(i, -1));
    const down = btn('down', 'Move down', '▼', () => move(i, 1));
    const del = btn('del', 'Remove', '×', () => change(rules.filter((_, j) => j !== i)));
    const err = h('div', { class: 'error rules-err', id: `${o.id}-err-${i}`, role: 'status' });
    const sw = h('span', { class: 'rules-num', style: `--rule: var(${ruleColorVar(i)})`, 'aria-hidden': 'true' }, String(i + 1));
    const line = h(
      'div',
      { class: 'rules-line' },
      sw,
      on,
      h('label', { class: 'seed-formula rules-field rules-field-when' }, h('span', { class: 'seed-f' }, 'if'), when),
      h('label', { class: 'seed-formula rules-field rules-field-value' }, h('span', { class: 'seed-f' }, '→'), value),
      up,
      down,
      del,
    );
    const rowEl = h('div', { class: 'rules-row', role: 'listitem' }, line, err);
    return { el: rowEl, on, when, value, up, down, err };
  };

  const render = () => {
    if (rows.length !== rules.length) {
      rows = rules.map((_, i) => buildRow(i));
      list.replaceChildren(...rows.map((r) => r.el));
    }
    rules.forEach((r, i) => {
      const row = rows[i];
      row.on.checked = r.on;
      if (document.activeElement !== row.when) row.when.value = r.when;
      if (document.activeElement !== row.value) row.value.value = r.value;
      row.el.classList.toggle('off', !r.on);
      row.up.disabled = i === 0;
      row.down.disabled = i === rules.length - 1;
    });
    addBtn.disabled = rules.length >= MAX_RULES;
    list.classList.toggle('empty', !rules.length);
  };

  return {
    el,
    sync(next) {
      rules = next.map((r) => ({ ...r }));
      render();
    },
    setErrors(errors) {
      rows.forEach((row, i) => {
        const e = errors[i];
        row.err.textContent = e ?? '';
        row.el.classList.toggle('invalid', !!e);
        const part = e?.startsWith('condition:') ? row.when : e ? row.value : null;
        row.when.classList.toggle('invalid', part === row.when);
        row.value.classList.toggle('invalid', part === row.value);
      });
    },
  };
}
