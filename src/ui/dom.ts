import { isNarrowShell, layout, type PanelKey } from './layout';

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
  maximize: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  restore: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
};

export { NARROW_SHELL, isNarrowShell } from './layout';

export interface Panel {
  el: HTMLElement;
  /** Header row: collapse chevron, title, `tools`, `meta`, maximize (wide shell). */
  head: HTMLElement;
  tools: HTMLDivElement;
  meta: HTMLSpanElement;
  body: HTMLDivElement;
  /** Body showing: the panel isn't collapsed in the current layout (wide / narrow). */
  isOpen(): boolean;
  /** Called when the body may have been shown / hidden (collapse, shell width change). */
  onToggle(fn: () => void): void;
  /** Expand the body if collapsed (in both layouts: it should show on either shell). */
  open(): void;
  /** The one-line status a collapsed panel shows (polled a few times a second while collapsed). */
  setStatus(fn: () => string): void;
}

/** Header elements that keep their own clicks (a double-click on them doesn't maximize). */
const DBLCLICK_GUARD_MS = 400;
const INTERACTIVE = 'button, input, select, textarea, label, a, [role="tab"], [role="slider"], [tabindex]';

/**
 * A panel of the app shell (state in layout.ts). On the wide shell it fills its place in its
 * row (the body scrolls if its content overflows); collapsed it becomes a strip / bar
 * button with the title and a one-line status that expands it again. The header's maximize
 * button (or a double-click on the header) gives it the whole content area. On the narrow
 * shell the header chevron collapses the body.
 */
export function panel(id: string, title: string, key: PanelKey): Panel {
  let expandedAt = -Infinity;
  const meta = h('span', { class: 'meta' });
  const tools = h('div', { class: 'panel-tools' });
  const body = h('div', { class: 'panel-body', id: `${id}-body` });
  const chev = h('button', { class: 'panel-collapse', 'aria-controls': body.id, onclick: () => layout.toggle(key) }, icon(ICONS.chevron, 'chev'));
  const maxBtn = h('button', { class: 'panel-max', id: `${id}-max`, onclick: () => layout.maximize(key) }, icon(ICONS.maximize, 'max-icon'), icon(ICONS.restore, 'restore-icon'));
  const head = h('div', { class: 'panel-head' }, chev, h('h2', { class: 'panel-title' }, title), tools, meta, maxBtn);
  const status = h('span', { class: 'strip-status' });
  const strip = h(
    'button',
    {
      class: 'panel-strip',
      id: `${id}-strip`,
      'aria-controls': body.id,
      'aria-expanded': 'false',
      onclick: () => {
        expandedAt = performance.now();
        layout.setCollapsed(key, false);
      },
    },
    icon(ICONS.chevron, 'strip-chev'),
    h('span', { class: 'strip-title' }, title),
    status,
  );
  const el = h('section', { class: 'panel', id, 'aria-label': title, 'data-panel': key }, head, strip, body);
  // A double-click on a strip / bar: its first click expands the panel, the second may land on
  // the header that just appeared; that isn't a request to maximize.
  const onHeader = (e: Event) =>
    !isNarrowShell() && performance.now() - expandedAt > DBLCLICK_GUARD_MS && !(e.target instanceof Element && e.target !== head && e.target.closest(INTERACTIVE));
  // A double-click on the header (not on its controls) maximizes / restores; it doesn't select text.
  head.addEventListener('mousedown', (e) => {
    if (e.detail > 1 && onHeader(e)) e.preventDefault();
  });
  head.addEventListener('dblclick', (e) => {
    if (onHeader(e)) layout.maximize(key);
  });
  const reg = layout.register(key, { el, title, statusEl: status, stripBtn: strip, collapseBtn: chev, maxBtn });
  return {
    el,
    head,
    tools,
    meta,
    body,
    isOpen: () => !layout.isCollapsed(key),
    onToggle: reg.onToggle,
    open: () => layout.expandEverywhere(key),
    setStatus: reg.setStatus,
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
