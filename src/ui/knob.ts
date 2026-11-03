import { h } from './dom';

/** Value ↔ position (0..1) mapping of a control. */
export interface Taper {
  toU(v: number): number;
  toV(u: number): number;
}
export const linear = (min: number, max: number): Taper => ({ toU: (v) => (v - min) / (max - min), toV: (u) => min + u * (max - min) });

const SVG_NS = 'http://www.w3.org/2000/svg';
/** 270° arc (from 7:30 to 4:30 o'clock) in a 28×28 box, path length normalised to 100. */
const ARC = 'M6.93 21.07 A10 10 0 1 1 21.07 21.07';
/** Pixels of vertical drag for the whole range (×4 with Shift: fine). */
const DRAG_PX = 160;

export interface KnobOpts {
  id: string;
  /** Short visible label; `name` (default: label) is the accessible name and tooltip. */
  label: string;
  name?: string;
  taper: Taper;
  fmt(v: number): string;
  /** Integer values (window slots, semitones, …): steps of 1, snapped. */
  int?: boolean;
  /** Arc drawn from the centre (pan, ± amounts). */
  bipolar?: boolean;
  snap?(v: number): number;
  title?: string;
  onInput(v: number): void;
  /** A gesture ended (pointer up, each key press): one undo step. */
  onCommit(): void;
  /** Double-click: back to this value. */
  reset?: number;
}

export interface Knob {
  readonly el: HTMLElement;
  readonly dial: HTMLElement;
  set(v: number): void;
  /** New taper (e.g. an integer range that depends on the wavetable). */
  setTaper(t: Taper): void;
  setDisabled(off: boolean): void;
}

/**
 * A small rotary control: role="slider" with aria-valuenow / -valuetext and keyboard
 * support (←/↓ and →/↑ step, PageUp / PageDown and Shift+↑/↓ by a tenth, Home / End);
 * vertical drag with the mouse or a finger (Shift: fine). The label shows below; the value
 * shows under it, or (`.knobs-dense` containers) in the label's place while hovered,
 * focused or dragged.
 */
export function knob(o: KnobOpts): Knob {
  let taper = o.taper;
  let value = taper.toV(0);
  let disabled = false;
  const snap = (v: number) => {
    const s = o.snap ? o.snap(v) : v;
    return o.int ? Math.round(s) : s;
  };
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 28 28');
  svg.setAttribute('aria-hidden', 'true');
  const track = document.createElementNS(SVG_NS, 'path');
  track.setAttribute('d', ARC);
  track.setAttribute('class', 'knob-track');
  track.setAttribute('pathLength', '100');
  const arc = document.createElementNS(SVG_NS, 'path');
  arc.setAttribute('d', ARC);
  arc.setAttribute('class', 'knob-arc');
  arc.setAttribute('pathLength', '100');
  const ptr = document.createElementNS(SVG_NS, 'line');
  ptr.setAttribute('x1', '14');
  ptr.setAttribute('y1', '14');
  ptr.setAttribute('x2', '14');
  ptr.setAttribute('y2', '6');
  ptr.setAttribute('class', 'knob-ptr');
  svg.append(track, arc, ptr);
  const name = o.name ?? o.label;
  const dial = h('div', { class: 'knob-dial', id: o.id, role: 'slider', tabindex: 0, 'aria-label': name }, svg);
  const label = h('span', { class: 'knob-label' }, o.label);
  const val = h('span', { class: 'knob-val' });
  // The whole cell takes the drag (a bigger target than the dial, for touch).
  const el = h('div', { class: 'knob knob-rot', title: o.title ? `${name}: ${o.title}` : name }, dial, label, val);

  const draw = () => {
    const u = Math.max(0, Math.min(1, taper.toU(value) || 0));
    const a = o.bipolar ? Math.min(u, 0.5) * 100 : 0;
    const b = o.bipolar ? Math.max(u, 0.5) * 100 : u * 100;
    arc.setAttribute('stroke-dasharray', `0 ${a.toFixed(2)} ${(b - a).toFixed(2)} 200`);
    ptr.setAttribute('transform', `rotate(${(-135 + u * 270).toFixed(1)} 14 14)`);
    const text = o.fmt(value);
    val.textContent = text;
    dial.setAttribute('aria-valuenow', String(Math.round(value * 1000) / 1000));
    dial.setAttribute('aria-valuetext', text);
    dial.setAttribute('aria-valuemin', String(Math.round(taper.toV(0) * 1000) / 1000));
    dial.setAttribute('aria-valuemax', String(Math.round(taper.toV(1) * 1000) / 1000));
  };
  const put = (v: number) => {
    const lo = Math.min(taper.toV(0), taper.toV(1));
    const hi = Math.max(taper.toV(0), taper.toV(1));
    const x = Math.max(lo, Math.min(hi, snap(v)));
    if (x === value) return;
    value = x;
    draw();
    o.onInput(x);
  };
  const putU = (u: number) => put(taper.toV(Math.max(0, Math.min(1, u))));

  dial.addEventListener('keydown', (e) => {
    if (disabled || e.altKey || e.ctrlKey || e.metaKey) return;
    const big = e.key === 'PageUp' || e.key === 'PageDown' || (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown'));
    // Shift+←/→ stay page-wide shortcuts (move the selected waveform), as on range inputs.
    if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    const dir = e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.key === 'PageUp' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'PageDown' ? -1 : 0;
    if (dir) {
      if (o.int) {
        const span = Math.abs(taper.toV(1) - taper.toV(0));
        put(value + dir * (big ? Math.max(1, Math.round(span / 10)) : 1));
      } else putU(taper.toU(value) + dir * (big ? 0.1 : 0.01));
    } else if (e.key === 'Home') putU(0);
    else if (e.key === 'End') putU(1);
    else return;
    e.preventDefault();
    e.stopPropagation();
    o.onCommit();
  });
  let drag: { y: number; u: number; id: number; fine: boolean } | null = null;
  el.addEventListener('pointerdown', (e) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    dial.focus({ preventScroll: true });
    el.setPointerCapture(e.pointerId);
    drag = { y: e.clientY, u: taper.toU(value), id: e.pointerId, fine: e.shiftKey };
    el.classList.add('active');
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    // Shift pressed / released mid-drag: continue from here at the new speed (no jump).
    if (e.shiftKey !== drag.fine) drag = { ...drag, y: e.clientY, u: taper.toU(value), fine: e.shiftKey };
    putU(drag.u + (drag.y - e.clientY) / (drag.fine ? DRAG_PX * 4 : DRAG_PX));
  });
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    el.classList.remove('active');
    o.onCommit();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  // Capture lost some other way (the element hidden, the window blurred): end the gesture too.
  el.addEventListener('lostpointercapture', end);
  if (o.reset !== undefined) {
    const r = o.reset;
    el.addEventListener('dblclick', () => {
      if (disabled) return;
      put(r);
      o.onCommit();
    });
  }
  draw();
  return {
    el,
    dial,
    set(v) {
      if (drag) return;
      if (v === value) return;
      value = v;
      draw();
    },
    setTaper(t) {
      taper = t;
      draw();
    },
    setDisabled(off) {
      if (off === disabled) return;
      disabled = off;
      el.classList.toggle('off', off);
      dial.setAttribute('aria-disabled', String(off));
      dial.tabIndex = off ? -1 : 0;
    },
  };
}

/**
 * A small choice cell in a knob grid: a button showing the current option (click cycles;
 * two options = a toggle with aria-pressed when `pressed` is given), label below.
 */
export function choiceCell<T>(o: {
  id: string;
  label: string;
  name?: string;
  options: readonly (readonly [T, string])[];
  title?: string;
  pressed?: (x: T) => boolean;
  onPick(x: T): void;
}): { el: HTMLElement; btn: HTMLButtonElement; set(x: T): void; setDisabled(off: boolean): void } {
  let cur = o.options[0][0];
  const name = o.name ?? o.label;
  const btn = h('button', {
    class: 'knob-choice',
    id: o.id,
    onclick: () => {
      const i = o.options.findIndex(([x]) => x === cur);
      o.onPick(o.options[(i + 1) % o.options.length][0]);
    },
  });
  const el = h('div', { class: 'knob knob-cell-choice', title: o.title ? `${name}: ${o.title}` : name }, btn, h('span', { class: 'knob-label' }, o.label));
  const set = (x: T) => {
    cur = x;
    const text = o.options.find(([v]) => v === x)?.[1] ?? String(x);
    btn.textContent = text;
    btn.setAttribute('aria-label', `${name}: ${text}${o.pressed ? '' : ' (click for the next option)'}`);
    if (o.pressed) btn.setAttribute('aria-pressed', String(o.pressed(x)));
  };
  set(cur);
  return {
    el,
    btn,
    set,
    setDisabled(off) {
      btn.disabled = off;
      el.classList.toggle('off', off);
    },
  };
}
