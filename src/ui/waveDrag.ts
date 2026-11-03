/**
 * Dragging a waveform (from the Timeline strip or a wavetable slot) onto a drop zone (the
 * wavetable editor's view or list). Pointer events, so mouse, pen and touch all work: the
 * source decides when a press becomes a drag (a small movement with the mouse; on touch
 * a vertical move out of the Timeline, or a long-press on an editor slot) and calls
 * beginDrag(); from then on this module tracks the pointer, shows a ghost of the waveform
 * with a label saying what a drop would do, asks the zones what is under the pointer
 * every frame (so zones can auto-scroll), and drops on release. Escape cancels.
 */
import type { TableId } from '../core/table';
import type { WavetableId } from '../core/wavetable';
import { cssColor, drawWave, fitFixed } from './canvas';
import { h, isNarrowShell } from './dom';

export interface DragSource {
  readonly tableId: TableId;
  /** The slot it was picked up from (a wavetable drag), else from the Timeline. */
  readonly from?: { readonly wtId: WavetableId; readonly x: number; readonly y: number };
}

export interface DragPoint {
  readonly clientX: number;
  readonly clientY: number;
  /** Alt / Ctrl / ⌘ held: copy instead of move (drags within a wavetable). */
  readonly copy: boolean;
}

/** What a drop would do here: `ok` = it would change something. */
export interface DropHint {
  readonly label: string;
  readonly ok: boolean;
}

export interface DropZone {
  /** Whether the zone takes drops at all right now (e.g. the editor is open). */
  active(): boolean;
  /** Hit test (null = not over this zone); the zone shows its own indicator. */
  over(p: DragPoint, src: DragSource): DropHint | null;
  /** Drop at the last position `over` accepted. */
  drop(p: DragPoint, src: DragSource): void;
  /** The pointer left the zone or the drag ended: clear indicators. */
  leave(): void;
}

const zones: DropZone[] = [];
export function addDropZone(z: DropZone): void {
  zones.push(z);
}

/** Any zone ready for drops (sources start drags only then). */
export const dropTargetsActive = (): boolean => zones.some((z) => z.active());

/** Mouse: movement (px) before a press becomes a drag. */
export const DRAG_SLOP = 5;

interface Drag {
  src: DragSource;
  p: DragPoint;
  zone: DropZone | null;
  hint: DropHint | null;
  ghost: HTMLElement;
  label: HTMLElement;
  raf: number;
}

let drag: Drag | null = null;
/** A drop just happened: the click that follows the pointerup must not select. */
let swallowUntil = 0;
// A new press ends the window at once (only the click of the drag's own release is swallowed).
if (typeof window !== 'undefined') window.addEventListener('pointerdown', () => (swallowUntil = 0), true);

export const isDragging = (): boolean => drag !== null;

/** True (once) right after a drag ended: sources skip the click that follows it. */
export function consumeDragClick(): boolean {
  return performance.now() < swallowUntil;
}

const point = (e: PointerEvent | KeyboardEvent, last?: DragPoint): DragPoint => ({
  clientX: 'clientX' in e ? e.clientX : (last?.clientX ?? 0),
  clientY: 'clientY' in e ? e.clientY : (last?.clientY ?? 0),
  copy: e.altKey || e.ctrlKey || e.metaKey,
});

function update(): void {
  if (!drag) return;
  let hit: DropHint | null = null;
  let zone: DropZone | null = null;
  for (const z of zones) {
    if (!z.active()) continue;
    const r = z.over(drag.p, drag.src);
    if (r && !zone) {
      zone = z;
      hit = r;
    } else z.leave();
  }
  if (drag.zone && drag.zone !== zone) drag.zone.leave();
  drag.zone = zone;
  drag.hint = hit;
  drag.label.textContent = hit?.label ?? 'Drop on a wavetable slot';
  drag.ghost.classList.toggle('ok', !!hit?.ok);
  drag.ghost.style.transform = `translate(${Math.round(drag.p.clientX - 31)}px, ${Math.round(drag.p.clientY - 78)}px)`;
}

/** Narrow shell: scroll the page when dragging near the top / bottom of the viewport. */
function autoScroll(): void {
  if (!drag || !isNarrowShell()) return;
  const y = drag.p.clientY;
  const edge = 48;
  if (y < edge) window.scrollBy(0, -Math.ceil((edge - y) / 4));
  else if (y > innerHeight - edge) window.scrollBy(0, Math.ceil((y - innerHeight + edge) / 4));
}

function frame(): void {
  if (!drag) return;
  autoScroll();
  update();
  drag.raf = requestAnimationFrame(frame);
}

function end(drop: boolean): void {
  const d = drag;
  if (!d) return;
  drag = null;
  cancelAnimationFrame(d.raf);
  window.removeEventListener('pointermove', onMove, true);
  window.removeEventListener('pointerup', onUp, true);
  window.removeEventListener('pointercancel', onCancel, true);
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('keyup', onKey, true);
  window.removeEventListener('touchmove', onTouchMove);
  d.ghost.remove();
  document.body.classList.remove('wave-dragging');
  swallowUntil = performance.now() + 400;
  if (drop && d.zone && d.hint?.ok) d.zone.drop(d.p, d.src);
  d.zone?.leave();
  for (const z of zones) z.leave();
}

function onMove(e: PointerEvent): void {
  if (!drag) return;
  drag.p = point(e);
  update();
}
function onUp(e: PointerEvent): void {
  if (!drag) return;
  drag.p = point(e);
  update();
  end(true);
}
const onCancel = () => end(false);
function onKey(e: KeyboardEvent): void {
  if (!drag) return;
  if (e.type === 'keydown' && e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    end(false);
    return;
  }
  // No other key acts while dragging (shortcuts such as Shift+←/→, Space, Delete, the
  // editor's arrows): this listener runs first (window, capture phase).
  e.preventDefault();
  e.stopPropagation();
  // Modifier changes (Alt / Ctrl / ⌘ = copy) update the label at once.
  drag.p = point(e, drag.p);
  update();
}
/** While a touch drag runs, the page must not scroll under the finger. */
const onTouchMove = (e: TouchEvent) => {
  if (drag && e.cancelable) e.preventDefault();
};

/**
 * Start dragging `src` (its waveform `data` drawn in the ghost) from the pointer event `e`.
 * The caller has decided this press is a drag (and cancelled its own long-press etc.).
 */
export function beginDrag(src: DragSource, e: PointerEvent, data: Float32Array | undefined, captureEl?: Element): void {
  if (drag) end(false);
  const c = h('canvas', { class: 'wdrag-wave' });
  const label = h('span', { class: 'wdrag-label' });
  const ghost = h('div', { class: 'wdrag-ghost', 'aria-hidden': 'true', id: 'wave-drag-ghost' }, label, c);
  document.body.append(ghost);
  if (data) {
    const g = fitFixed(c, 58, 54);
    drawWave(g, 2, 2, 54, 50, data, cssColor('--wave'), { points: 40, lineWidth: 1.4 });
  }
  try {
    if (captureEl && 'setPointerCapture' in captureEl) (captureEl as HTMLElement).setPointerCapture(e.pointerId);
  } catch {
    /* the pointer may already be gone */
  }
  drag = { src, p: point(e), zone: null, hint: null, ghost, label, raf: 0 };
  document.body.classList.add('wave-dragging');
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onCancel, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  window.addEventListener('touchmove', onTouchMove, { passive: false });
  update();
  drag.raf = requestAnimationFrame(frame);
}
