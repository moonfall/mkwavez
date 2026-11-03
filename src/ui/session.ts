/**
 * Session menu (transport bar): autosave status, New session, Export / Import a .mkwz file;
 * plus a small non-blocking notice (storage unavailable, restore problems, import errors).
 */
import { defaultSessionState } from '../app/defaultSession';
import type { Autosaver } from '../app/autosave';
import {
  decodeSession,
  encodeMeta,
  encodeWaveforms,
  FILE_EXTENSION,
  packSessionFile,
  SessionError,
  unpackSessionFile,
} from '../core/session';
import type { UiContext } from './context';
import { h, icon } from './dom';

const hasPopover = typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype;
/** A floppy-disk-ish "session" icon. */
const SESSION_ICON = 'M5 3h11l3 3v15H5zM8 3v5h7V3M8 21v-7h8v7';

// ---- notice ----

let noticeEl: HTMLElement | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Show a small notice at the bottom of the page (replaces the previous one). Plain notices
 * hide after a while; ones with actions stay until dismissed.
 */
export function showNotice(text: string, actions: { label: string; run: () => void }[] = []): void {
  if (!noticeEl) {
    noticeEl = h('div', { id: 'session-notice', class: 'session-notice', role: 'status', 'aria-live': 'polite' });
    document.body.append(noticeEl);
  }
  const el = noticeEl;
  const close = () => {
    el.hidden = true;
  };
  el.replaceChildren(
    h('span', { class: 'session-notice-text' }, text),
    ...actions.map((a) =>
      h('button', {
        class: 'small',
        onclick: () => {
          close();
          a.run();
        },
      }, a.label),
    ),
    h('button', { class: 'small session-notice-close', 'aria-label': 'Dismiss', title: 'Dismiss', onclick: close }, '×'),
  );
  el.hidden = false;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = actions.length ? null : setTimeout(close, 9000);
}

// ---- menu ----

export interface SessionMenu {
  el: HTMLElement;
  /** Export the session as a .mkwz file download. */
  exportFile(): void;
  /** Import a .mkwz file (asks before replacing the current session). */
  importFile(file: File): Promise<void>;
  newSession(): Promise<void>;
}

export function buildSessionMenu(ctx: UiContext, saver: Autosaver): SessionMenu {
  const { model, ui } = ctx;
  const open = h(
    'button',
    { id: 'session-menu', class: 'session-open', 'aria-label': 'Session: autosave, new, export, import', 'aria-haspopup': 'dialog' },
    icon(SESSION_ICON),
    h('span', { class: 'session-label' }, 'Session'),
  );
  const status = h('p', { id: 'session-status', class: 'session-status' });
  const file = h('input', { type: 'file', id: 'session-file', accept: `${FILE_EXTENSION},application/octet-stream`, hidden: true });

  const applyUi = (p: Readonly<Record<string, unknown>>) => ui.loadPrefs(p);

  const menu: SessionMenu = {
    el: h('span'),
    exportFile() {
      try {
        const state = model.exportState();
        const bytes = packSessionFile(encodeMeta({ model: state, ui: ui.exportPrefs() }, Date.now()), encodeWaveforms(state.timeline));
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
        const a = h('a', { href: url, download: `mkwavez-${stamp(new Date())}${FILE_EXTENSION}` });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } catch (e) {
        console.warn('[session] export failed', e);
        showNotice(`Couldn’t export the session: ${message(e)}`);
      }
    },
    async importFile(f: File) {
      try {
        const { meta, records } = unpackSessionFile(new Uint8Array(await f.arrayBuffer()));
        const { state, warnings } = decodeSession(meta, records);
        const n = state.model.timeline.length;
        const ok = window.confirm(
          `Replace the current session with “${f.name}” (${n} waveform${n === 1 ? '' : 's'})?\n\n` +
            'The current waveforms, wavetables, voices and sequences are replaced (export them first to keep them). Undo history is cleared.',
        );
        if (!ok) return;
        await saver.replace(state, applyUi);
        showNotice(warnings.length ? `Imported “${f.name}”: ${warnings[0]}${warnings.length > 1 ? ` (+${warnings.length - 1} more)` : ''}.` : `Imported “${f.name}”.`);
      } catch (e) {
        if (!(e instanceof SessionError)) console.warn('[session] import failed', e);
        showNotice(`Couldn’t import “${f.name}”: ${message(e)}.`);
      }
    },
    async newSession() {
      const ok = window.confirm(
        'Start a new session?\n\nThis clears the current waveforms, wavetables, voices and sequences, and the autosaved copy (export first to keep them).',
      );
      if (!ok) return;
      const state = defaultSessionState();
      await saver.replace({ model: state, ui: { ...ui.exportPrefs(), voiceId: state.voices[0]?.id ?? null } }, applyUi);
    },
  };

  const newBtn = h('button', { id: 'session-new', class: 'small', onclick: () => void menu.newSession() }, 'New session…');
  const exportBtn = h('button', { id: 'session-export', class: 'small', onclick: () => menu.exportFile() }, 'Export…');
  const importBtn = h('button', { id: 'session-import', class: 'small', onclick: () => file.click() }, 'Import…');
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    file.value = '';
    if (f) void menu.importFile(f);
  });

  const pop = h(
    'div',
    { id: 'session-pop', class: 'midi-pop session-pop', role: 'dialog', 'aria-label': 'Session' },
    h('div', { class: 'midi-pop-head' }, h('strong', {}, 'Session')),
    status,
    h('div', { class: 'session-actions' }, newBtn, exportBtn, importBtn, file),
    h(
      'p',
      { class: 'hint' },
      'Your session (waveforms, wavetables, voices, sequences, tempo) is saved in this browser automatically and restored on reload; undo history isn’t kept. ' +
        `Export saves it as one ${FILE_EXTENSION} file; Import replaces the current session with one.`,
    ),
  );
  if (hasPopover) {
    pop.setAttribute('popover', 'auto');
    open.setAttribute('popovertarget', 'session-pop');
    pop.addEventListener('toggle', (e) => open.setAttribute('aria-expanded', String((e as ToggleEvent).newState === 'open')));
  } else {
    pop.hidden = true;
    open.addEventListener('click', () => {
      pop.hidden = !pop.hidden;
      open.setAttribute('aria-expanded', String(!pop.hidden));
    });
  }
  open.setAttribute('aria-expanded', 'false');

  const syncStatus = () => {
    let text: string;
    switch (saver.status) {
      case 'off':
        text = 'Autosave is off: this browser isn’t allowing storage (private window?). Use Export to keep your work.';
        break;
      case 'error':
        text = `Autosave failed: ${saver.lastError}. It retries on the next change; Export keeps a copy.`;
        break;
      case 'saving':
      case 'pending':
        text = 'Autosave on · saving…';
        break;
      default:
        text = saver.lastSaved ? `Autosave on · saved ${new Date(saver.lastSaved).toLocaleTimeString()}` : 'Autosave on';
    }
    status.textContent = text;
    status.classList.toggle('session-status-error', saver.status === 'off' || saver.status === 'error');
    open.dataset.state = saver.status;
    open.title = text;
  };
  let lastErrorShown = '';
  saver.onChange = () => {
    syncStatus();
    if (saver.status === 'error' && saver.lastError !== lastErrorShown) {
      lastErrorShown = saver.lastError;
      showNotice(`Autosave failed: ${saver.lastError}.`);
    }
  };
  syncStatus();

  menu.el = h('span', { class: 'session' }, open, pop);
  return menu;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
