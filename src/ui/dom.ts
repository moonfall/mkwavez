type Attrs = Record<string, string | number | boolean | undefined | null | EventListener>;
type Child = Node | string | number | null | undefined | false;

/** Tiny hyperscript: h('button', { class: 'x', onclick: fn }, 'label'). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2), v);
    } else if (k in el && !k.includes('-') && k !== 'list') {
      (el as unknown as Record<string, unknown>)[k] = v;
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Inline stroke icon (24x24 viewBox path data). */
export function icon(d: string, cls = ''): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  svg.append(p);
  return svg;
}

export const ICONS = {
  chevron: 'M6 9l6 6 6-6',
  play: 'M7 4v16l13-8z',
  stop: 'M6 6h12v12H6z',
  undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  volume: 'M11 5L6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14',
  mute: 'M11 5L6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6',
  close: 'M18 6L6 18M6 6l12 12',
  shuffle: 'M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5',
  plus: 'M12 5v14M5 12h14',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  cycle: 'M20 11a8 8 0 0 0-14.9-4M4 4v3h3M4 13a8 8 0 0 0 14.9 4M20 20v-3h-3',
};

/** Below this width the shell is one scrolling column of collapsible panels. */
export const NARROW_SHELL = '(max-width: 899px)';
const narrowShell = typeof matchMedia !== 'undefined' ? matchMedia(NARROW_SHELL) : null;
export const isNarrowShell = (): boolean => !!narrowShell?.matches;

export interface Panel {
  el: HTMLElement;
  /** Header row: collapse chevron (narrow shell only), title, `tools`, `meta`. */
  head: HTMLElement;
  tools: HTMLDivElement;
  meta: HTMLSpanElement;
  body: HTMLDivElement;
  /** Body showing: always on the wide shell; on the narrow one unless collapsed. */
  isOpen(): boolean;
  /** Called when the body may have been shown / hidden (collapse, shell width change). */
  onToggle(fn: () => void): void;
  /** Expand the body if collapsed (narrow shell). */
  open(): void;
}

/**
 * A panel of the app shell. On the wide shell it fills its grid cell (the body scrolls
 * if its content overflows); on the narrow shell the header chevron collapses the body.
 */
export function panel(id: string, title: string, opts: { collapsed?: boolean } = {}): Panel {
  const meta = h('span', { class: 'meta' });
  const tools = h('div', { class: 'panel-tools' });
  const body = h('div', { class: 'panel-body', id: `${id}-body` });
  const chev = h('button', { class: 'panel-collapse', 'aria-controls': body.id }, icon(ICONS.chevron, 'chev'));
  const head = h('div', { class: 'panel-head' }, chev, h('h2', { class: 'panel-title' }, title), tools, meta);
  const el = h('section', { class: 'panel', id, 'aria-label': title }, head, body);
  let collapsed = !!opts.collapsed;
  const fns: (() => void)[] = [];
  const apply = () => {
    el.classList.toggle('collapsed', collapsed);
    chev.setAttribute('aria-expanded', String(!collapsed));
    chev.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${title}`);
  };
  apply();
  chev.addEventListener('click', () => {
    collapsed = !collapsed;
    apply();
    for (const fn of fns) fn();
  });
  narrowShell?.addEventListener('change', () => {
    for (const fn of fns) fn();
  });
  return {
    el,
    head,
    tools,
    meta,
    body,
    isOpen: () => !collapsed || !isNarrowShell(),
    onToggle: (fn) => fns.push(fn),
    open: () => {
      if (!collapsed) return;
      collapsed = false;
      apply();
      for (const fn of fns) fn();
    },
  };
}

export interface Slider {
  el: HTMLDivElement;
  input: HTMLInputElement;
  set(v: number): void;
  setRange(min: number, max: number): void;
}

/** Labelled range input with a live value readout. */
export function slider(opts: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format?: (v: number) => string;
  onInput: (v: number) => void;
  /** Fired when the user releases the slider (change event). */
  onCommit?: (v: number) => void;
  extra?: Node;
}): Slider {
  const fmt = opts.format ?? ((v: number) => String(v));
  const val = h('span', { class: 'val' }, fmt(opts.value));
  const input = h('input', {
    type: 'range',
    min: opts.min,
    max: opts.max,
    step: opts.step,
    value: opts.value,
    'aria-label': opts.label,
  });
  input.addEventListener('input', () => {
    const v = Number(input.value);
    val.textContent = fmt(v);
    opts.onInput(v);
  });
  if (opts.onCommit) input.addEventListener('change', () => opts.onCommit!(Number(input.value)));
  const right = h('span', { style: 'display:flex;gap:6px;align-items:center' }, opts.extra ?? null, val);
  const el = h('div', { class: 'field' }, h('div', { class: 'label' }, h('span', {}, opts.label), right), input);
  return {
    el,
    input,
    set(v: number) {
      if (document.activeElement !== input || Number(input.value) !== v) input.value = String(v);
      val.textContent = fmt(v);
    },
    setRange(min: number, max: number) {
      input.min = String(min);
      input.max = String(max);
    },
  };
}

/** Labelled <select>. options: [value, label] or optgroups { group: [[v, l], ...] }. */
export function selectField(
  label: string,
  options: [string, string][],
  value: string,
  onChange: (v: string) => void,
): { el: HTMLDivElement; select: HTMLSelectElement } {
  const select = h('select', { 'aria-label': label });
  for (const [v, l] of options) select.append(h('option', { value: v }, l));
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  const el = h('div', { class: 'field' }, h('div', { class: 'label' }, h('span', {}, label)), select);
  return { el, select };
}

/** Voice colour CSS variable (`--v0`…`--v7`); index = voice id − 1. Palette in styles.css. */
export function voiceColorVar(colorIndex: number): string {
  return `--v${((colorIndex % 8) + 8) % 8}`;
}
