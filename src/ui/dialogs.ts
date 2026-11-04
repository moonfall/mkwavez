/**
 * Confirm / prompt dialogs, async. The browser uses its own (window.confirm / prompt);
 * inside the plugin the page uses an in-page dialog instead, because embedded web views
 * don't all provide them (macOS WKWebView in JUCE answers confirm() with false and prompt()
 * with null, silently).
 */
import { h } from './dom';

export interface DialogHost {
  confirm(message: string): Promise<boolean>;
  prompt(message: string, defaultValue?: string): Promise<string | null>;
}

const browserHost: DialogHost = {
  confirm: (m) => Promise.resolve(window.confirm(m)),
  prompt: (m, d) => Promise.resolve(window.prompt(m, d)),
};

let host: DialogHost = browserHost;

/** Where dialogs go (the plugin sets pageDialogs()). */
export function setDialogHost(h: DialogHost): void {
  host = h;
}

export const ask = {
  confirm: (message: string): Promise<boolean> => host.confirm(message),
  prompt: (message: string, defaultValue?: string): Promise<string | null> => host.prompt(message, defaultValue),
};

/**
 * Dialogs drawn in the page: a modal <div role="dialog"> over a backdrop, Enter = OK,
 * Escape = Cancel, focus kept inside and restored afterwards. One at a time (a second
 * request waits for the first).
 */
export function pageDialogs(): DialogHost {
  let queue: Promise<unknown> = Promise.resolve();
  const open = (message: string, input: string | null): Promise<string | null> => {
    const run = () =>
      new Promise<string | null>((resolve) => {
        const prev = document.activeElement as HTMLElement | null;
        const field = input === null ? null : h('input', { type: 'text', class: 'app-dialog-input', id: 'app-dialog-input', value: input });
        const done = (v: string | null) => {
          backdrop.remove();
          prev?.focus?.();
          resolve(v);
        };
        const ok = h('button', { class: 'primary', id: 'app-dialog-ok', onclick: () => done(field ? field.value : '') }, 'OK');
        const cancel = h('button', { id: 'app-dialog-cancel', onclick: () => done(null) }, 'Cancel');
        const box = h(
          'div',
          { class: 'app-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'app-dialog-text' },
          h('p', { class: 'app-dialog-text', id: 'app-dialog-text' }, message),
          ...(field ? [field] : []),
          h('div', { class: 'app-dialog-actions' }, cancel, ok),
        );
        const backdrop = h('div', { class: 'app-dialog-backdrop', id: 'app-dialog' }, box);
        backdrop.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            done(null);
          } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
            e.preventDefault();
            e.stopPropagation();
            ok.click();
          } else if (e.key === 'Tab') {
            // Keep focus inside the dialog.
            const items = [field, cancel, ok].filter((x): x is HTMLInputElement | HTMLButtonElement => !!x);
            const i = items.indexOf(document.activeElement as HTMLInputElement | HTMLButtonElement);
            e.preventDefault();
            items[(i + (e.shiftKey ? items.length - 1 : 1)) % items.length].focus();
          }
          // Shortcuts must not fire behind the dialog.
          e.stopPropagation();
        });
        backdrop.addEventListener('pointerdown', (e) => {
          if (e.target === backdrop) done(null);
        });
        document.body.append(backdrop);
        if (field) {
          field.focus();
          field.select();
        } else ok.focus();
      });
    const p = queue.then(run, run);
    queue = p;
    return p;
  };
  return {
    confirm: (m) => open(m, null).then((v) => v !== null),
    prompt: (m, d = '') => open(m, d),
  };
}
