import { cssColor, drawSpectrum, drawWave, fitFixed } from './canvas';
import { h } from './dom';

/** Shared Generate batch controls (Seed, Mutate): N stepper, card strip, status. */

/** Largest batch (N) any Generate tab makes. */
export const MAX_BATCH = 64;

/** − N + stepper over the shared batch size; ids `${p}-n`, `${p}-n-dec`, `${p}-n-inc`. */
export function buildStepper(
  p: string,
  opts: { count(): number; setCount(n: number): void; max?: number; label?: string; short?: string },
): { el: HTMLElement; sync(n: number): void } {
  const input = h('input', {
    type: 'number',
    id: `${p}-n`,
    min: 1,
    max: opts.max ?? MAX_BATCH,
    step: 1,
    value: opts.count(),
    inputmode: 'numeric',
    'aria-label': opts.label ?? 'Batch size N',
  });
  input.addEventListener('change', () => {
    const v = Math.round(Number(input.value));
    if (Number.isFinite(v)) opts.setCount(v);
    input.value = String(opts.count());
  });
  const el = h(
    'div',
    { class: 'gen-stepper', role: 'group', 'aria-label': 'Batch size' },
    h('button', { id: `${p}-n-dec`, 'aria-label': 'Fewer waveforms', onclick: () => opts.setCount(opts.count() - 1) }, '−'),
    h('label', { class: 'gen-n-label', title: opts.label ?? 'Batch size N' }, opts.short ?? 'N', input),
    h('button', { id: `${p}-n-inc`, 'aria-label': 'More waveforms', onclick: () => opts.setCount(opts.count() + 1) }, '+'),
  );
  return {
    el,
    sync(n) {
      if (document.activeElement !== input) input.value = String(n);
    },
  };
}

export interface StripCard {
  el: HTMLButtonElement;
  wave: HTMLCanvasElement;
  spec: HTMLCanvasElement;
  label: HTMLSpanElement;
  /** What the owner last drew on it (null = needs drawing). */
  drawn: unknown;
}

export interface Strip {
  el: HTMLElement;
  cards: readonly StripCard[];
  shown(): number;
  /** Show card i (click / ←/→ / Home / End call this too); fires onShow when it changed. */
  setShown(i: number, focus?: boolean): void;
  /** Make n cards; label(i) and aria(i) give each card's text. */
  resize(n: number, label: (i: number) => string): void;
}

/** Card width / plot heights (CSS px) on the strip. */
export const CARD_W = 84;
export const CARD_WAVE_H = 30;
export const CARD_SPEC_H = 14;

/**
 * Horizontal strip of batch cards (wave + spectrum + label). One card is "shown"
 * (aria-pressed, the roving tab stop); click or ←/→/Home/End when focused moves it.
 */
export function buildStrip(id: string, opts: { onShow(i: number): void }): Strip {
  const el = h('div', { id, class: 'gen-strip', role: 'group', 'aria-label': 'Batch waveforms (←/→ to move)' });
  const cards: StripCard[] = [];
  let shown = 0;

  const sync = () =>
    cards.forEach((c, i) => {
      c.el.setAttribute('aria-pressed', String(i === shown));
      c.el.tabIndex = i === shown ? 0 : -1;
    });

  /** Scroll the strip (only) so card i is visible. */
  const scrollIntoView = (i: number) => {
    const c = cards[i]?.el;
    if (!c || !el.clientWidth) return;
    const left = c.offsetLeft - 4;
    const right = c.offsetLeft + c.offsetWidth + 4;
    if (left < el.scrollLeft) el.scrollLeft = left;
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
  };

  const setShown = (i: number, focus = false) => {
    i = Math.max(0, Math.min(cards.length - 1, i));
    const changed = i !== shown;
    shown = i;
    sync();
    scrollIntoView(i);
    if (focus) cards[i]?.el.focus({ preventScroll: true });
    if (changed) opts.onShow(i);
  };

  el.addEventListener('keydown', (ev) => {
    const n = cards.length;
    const to =
      ev.key === 'ArrowRight' ? shown + 1 : ev.key === 'ArrowLeft' ? shown - 1 : ev.key === 'Home' ? 0 : ev.key === 'End' ? n - 1 : null;
    if (to === null) return;
    ev.preventDefault();
    setShown(to, true);
  });

  const resize = (n: number, label: (i: number) => string) => {
    while (cards.length < n) {
      const i = cards.length;
      const wave = h('canvas', { 'aria-hidden': 'true' });
      const spec = h('canvas', { 'aria-hidden': 'true' });
      const lab = h('span', { class: 'gen-card-label' });
      const card = h('button', { class: 'gen-card', tabindex: -1, onclick: () => setShown(i) }, wave, spec, lab);
      cards.push({ el: card, wave, spec, label: lab, drawn: null });
      el.append(card);
    }
    while (cards.length > n) cards.pop()!.el.remove();
    cards.forEach((c, i) => {
      c.label.textContent = label(i);
      c.el.setAttribute('aria-label', `Show waveform ${i + 1} of ${n}`);
    });
    if (shown > n - 1) {
      shown = n - 1;
      opts.onShow(shown);
    }
    sync();
  };

  return { el, cards, shown: () => shown, setShown, resize };
}

/** Status line that clears itself after a few seconds. */
export function flasher(status: HTMLElement): (msg: string, warn?: boolean) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (msg, warn = false) => {
    status.textContent = msg;
    status.classList.toggle('warn', warn);
    clearTimeout(timer);
    if (msg) timer = setTimeout(() => (status.textContent = ''), 4000);
  };
}

/** Harmonics shown by Generate spectra (cards and large views). */
export const SPEC_BINS = 64;

/** Draw a card's wave + spectrum (cleared when data is undefined). */
export function drawCard(c: StripCard, data: Float32Array | undefined): void {
  const w = CARD_W - 10;
  const g = fitFixed(c.wave, w, CARD_WAVE_H);
  const gs = fitFixed(c.spec, w, CARD_SPEC_H);
  if (!data) return;
  drawWave(g, 0, 0, w, CARD_WAVE_H, data, cssColor('--wave'), { axis: cssColor('--border'), lineWidth: 1.25 });
  drawSpectrum(gs, w, CARD_SPEC_H, data, cssColor('--accent'), { bins: SPEC_BINS });
}
