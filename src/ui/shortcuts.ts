import type { UiContext } from './context';

/**
 * Page-wide keyboard shortcuts (one place for all of them):
 *  - Space            play / stop (also while a button has focus: it doesn't click it)
 *  - [ / ]            previous / next voice tab (wrapping)
 *  - M                mute / unmute the selected voice
 *  - Shift+← / →      move the selected waveform one place earlier / later in the Timeline
 *
 * Ignored while typing (text inputs, textareas, selects, contenteditable) and when any
 * modifier other than the listed ones is held. Space on a focused checkbox / radio keeps
 * toggling it. Handled keys stop at the document (capture phase), so local handlers
 * (plain arrows in the library lists, batch strips and voice tabs) never see Shift+arrows.
 * Panel-local keys stay with their panels (Ctrl/⌘+D in the Timeline strip, arrows in
 * lists / strips / tabs).
 */
export const SHORTCUTS = {
  play: 'Space',
  prevVoice: '[',
  nextVoice: ']',
  mute: 'M',
  moveLeft: 'Shift+ArrowLeft',
  moveRight: 'Shift+ArrowRight',
} as const;

/** Input types that don't take typed text (everything else does). */
const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);

/** True if keys typed at `el` go into a text field (or a select). */
export function isTextField(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(el.type);
  return el.isContentEditable;
}

export interface ShortcutActions {
  togglePlay(): void;
}

export function installShortcuts(ctx: UiContext, actions: ShortcutActions, target: Document = document): void {
  const { model, ui } = ctx;
  /** A Space keydown we handled: its keyup is swallowed too (a focused button would click on it). */
  let spaceDown = false;

  const stepVoice = (d: number) => {
    const vs = model.voices;
    if (!vs.length) return;
    const i = vs.findIndex((v) => v.id === ui.voiceId);
    const next = vs[(Math.max(0, i) + d + vs.length) % vs.length];
    const hadFocus = document.activeElement?.closest('#voice-tabs');
    ui.setVoice(next.id);
    if (hadFocus) document.getElementById(`voice-tab-${next.id}`)?.focus();
  };

  const handle = (e: KeyboardEvent): boolean => {
    if (e.isComposing || isTextField(e.target)) return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.key === ' ') {
      if (e.shiftKey) return false;
      const t = e.target;
      if (t instanceof HTMLInputElement && (t.type === 'checkbox' || t.type === 'radio')) return false;
      spaceDown = true;
      if (!e.repeat) actions.togglePlay();
      return true;
    }
    if (e.shiftKey) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return false;
      model.moveTable(model.selectedId, e.key === 'ArrowLeft' ? -1 : 1);
      return true;
    }
    if (e.key === '[' || e.key === ']') {
      stepVoice(e.key === '[' ? -1 : 1);
      return true;
    }
    if (e.key === 'm' || e.key === 'M') {
      const v = ui.voiceId === null ? undefined : model.voice(ui.voiceId);
      if (v && !e.repeat) model.updateVoice(v.id, { mute: !v.mute });
      return true;
    }
    return false;
  };

  target.addEventListener(
    'keydown',
    (e) => {
      if (!handle(e)) return;
      e.preventDefault();
      e.stopPropagation();
    },
    { capture: true },
  );
  target.addEventListener(
    'keyup',
    (e) => {
      if (e.key !== ' ' || !spaceDown) return;
      spaceDown = false;
      e.preventDefault();
      e.stopPropagation();
    },
    { capture: true },
  );
}
