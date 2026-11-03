import type { AppModel } from '../app/model';
import type { AudioBridge } from '../audio/bridge';

/** Shared handles passed to every UI section. */
export interface UiContext {
  model: AppModel;
  bridge: AudioBridge;
}

/** A section that draws on animation frames. Draw only when dirty or animating, and visible. */
export interface FrameView {
  frame(now: number): void;
}

const visible = new WeakMap<Element, boolean>();
const io =
  typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver((entries) => {
        for (const e of entries) visible.set(e.target, e.isIntersecting);
      })
    : null;

/** Track on-screen visibility of an element (canvas). */
export function watchVisibility(el: Element): void {
  visible.set(el, true);
  io?.observe(el);
}

export function isOnScreen(el: Element): boolean {
  return visible.get(el) ?? true;
}
