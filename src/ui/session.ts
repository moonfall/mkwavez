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
  MAX_FILE_BYTES,
  packSessionFile,
  SessionError,
  unpackSessionFile,
} from '../core/session';
import type { UiContext } from './context';
import { h, icon } from './dom';
import { ask } from './dialogs';

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

/** Browser-side hooks the menu needs beyond the autosaver. */
export interface SessionHooks {
  /** Take autosave over from another tab (asks first). */
  takeOver(): Promise<void>;
  /** Sessions that couldn't be restored, kept in storage. */
  keptCount(): number;
  exportKept(): Promise<void>;
  discardKept(): Promise<void>;
}

export interface SessionMenu {
  el: HTMLElement;
  /** Re-read the hooks' state (kept session present, ...). */
  sync(): void;
  /** Export the session as a .mkwz file download. */
  exportFile(): void;
  /** Import a .mkwz file (asks before replacing the current session). */
  importFile(file: File): Promise<void>;
  newSession(): Promise<void>;
}

export function buildSessionMenu(ctx: UiContext, saver: Autosaver, hooks: SessionHooks): SessionMenu {
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
    sync: () => {},
    exportFile() {
      try {
        const state = model.exportState();
        const bytes = packSessionFile(encodeMeta({ model: state, ui: ui.exportPrefs() }, Date.now()), encodeWaveforms(state.timeline));
        downloadBytes(bytes, `mkwavez-${stamp(new Date())}${FILE_EXTENSION}`);
      } catch (e) {
        console.warn('[session] export failed', e);
        showNotice(`Couldn’t export the session: ${message(e)}`);
      }
    },
    async importFile(f: File) {
      try {
        if (f.size > MAX_FILE_BYTES) throw new SessionError('file is too large');
        const { meta, records } = unpackSessionFile(new Uint8Array(await f.arrayBuffer()));
        const { state, warnings } = decodeSession(meta, records);
        const n = state.model.timeline.length;
        const ok = await ask.confirm(
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
      const ok = await ask.confirm(
        'Start a new session?\n\nThis clears the current waveforms, wavetables, voices and sequences, and the autosaved copy (export first to keep them).',
      );
      if (!ok) return;
      const state = defaultSessionState();
      await saver.replace({ model: state, ui: { ...ui.exportPrefs(), voiceId: state.voices[0]?.id ?? null } }, applyUi);
    },
  };

  const newBtn = h('button', { id: 'session-new', class: 'small', onclick: () => void menu.newSession() }, 'New session…');
  const exportBtn = h('button', { id: 'session-export', class: 'small', onclick: () => menu.exportFile() }, 'Export…');
  const importBtn = h('button', { id: 'session-import', class: 'small', onclick: () => pickFile(file) }, 'Import…');
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    file.value = '';
    if (f) void menu.importFile(f);
  });

  const takeOverBtn = h('button', { id: 'session-takeover', class: 'small', hidden: true, onclick: () => void hooks.takeOver() }, 'Use autosave in this tab…');
  const keptLabel = h('span', {});
  const kept = h(
    'div',
    { id: 'session-kept', class: 'session-kept', hidden: true },
    keptLabel,
    h('button', { id: 'session-kept-export', class: 'small', onclick: () => void hooks.exportKept() }, 'Export it'),
    h('button', { id: 'session-kept-discard', class: 'small', onclick: () => void hooks.discardKept().then(() => menu.sync()) }, 'Discard it'),
  );
  const pop = h(
    'div',
    { id: 'session-pop', class: 'midi-pop session-pop', role: 'dialog', 'aria-label': 'Session' },
    h('div', { class: 'midi-pop-head' }, h('strong', {}, 'Session')),
    status,
    takeOverBtn,
    h('div', { class: 'session-actions' }, newBtn, exportBtn, importBtn, file),
    kept,
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
        text = saver.quotaFull
          ? 'Autosave stopped: browser storage is full. Export the session to keep it, or free up space; it retries on the next change.'
          : `Autosave failed: ${saver.lastError}. It retries on the next change; Export keeps a copy.`;
        break;
      case 'paused':
        text = 'Autosave is paused: mkwavez is open in another tab, which saves its session.';
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
    takeOverBtn.hidden = saver.status !== 'paused';
    const nKept = hooks.keptCount();
    kept.hidden = nKept === 0;
    keptLabel.textContent = nKept === 1 ? 'A session that couldn’t be restored is kept: ' : `${nKept} sessions that couldn’t be restored are kept; the latest: `;
    open.dataset.state = saver.status;
    open.title = text;
  };
  let lastErrorShown = '';
  saver.onChange = () => {
    syncStatus();
    if (saver.status === 'error' && saver.lastError !== lastErrorShown) {
      lastErrorShown = saver.lastError;
      if (saver.quotaFull) showNotice('Browser storage is full: autosave stopped. Export the session to keep it, or free up space.', [{ label: 'Export', run: () => menu.exportFile() }]);
      else showNotice(`Autosave failed: ${saver.lastError}.`);
    }
  };
  syncStatus();

  menu.sync = syncStatus;
  menu.el = h('span', { class: 'session' }, open, pop);
  return menu;
}

/** Where files go and come from: the browser's download / file picker, or the plugin's native dialogs. */
export interface FileHost {
  save(bytes: Uint8Array, name: string): void;
  /** Open a file (native dialog); resolves null if cancelled. `accept` as on <input type=file>. */
  open(accept: string): Promise<File | null>;
}

let fileHost: FileHost | null = null;

/** Inside the plugin: native save / open dialogs (embedded web views don't all do downloads). */
export function setFileHost(h: FileHost): void {
  fileHost = h;
}

/**
 * Let the user pick a file for `input` (a hidden <input type=file> whose change handler
 * reads input.files): the browser's picker, or inside the plugin the native one, whose
 * result is handed to the same handler.
 */
export function pickFile(input: HTMLInputElement): void {
  if (!fileHost) return input.click();
  void fileHost.open(input.accept).then((f) => {
    if (!f) return;
    const dt = new DataTransfer();
    dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  });
}

/** Offer bytes as a file download (inside the plugin: a native save dialog). */
export function downloadBytes(bytes: Uint8Array, name: string): void {
  if (fileHost) return fileHost.save(bytes, name);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

