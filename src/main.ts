import './ui/styles.css';
import { MidiController } from './app/midi';
import { AppModel } from './app/model';
import { AudioBridge } from './audio/bridge';
import { WebMidi } from './browser/webMidi';
import { Autosaver, type SaveScheduler } from './app/autosave';
import { SessionStore } from './browser/sessionStore';
import { FILE_EXTENSION, packSessionFile, type SessionMeta } from './core/session';
import { restoreSession } from './app/restore';
import { TabLock } from './browser/tabLock';
import { setTheme, storedTheme, throttle } from './ui/canvas';
import { UiState, type FrameView, type UiContext } from './ui/context';
import { h } from './ui/dom';
import { buildGenerate } from './ui/generate';
import { buildMidi } from './ui/midi';
import { buildSequences } from './ui/sequences';
import { buildSessionMenu, downloadBytes, showNotice, stamp, type SessionHooks } from './ui/session';
import { installShortcuts } from './ui/shortcuts';
import { buildTimeline } from './ui/timeline';
import { buildTransport, togglePlay } from './ui/transport';
import { buildVoices } from './ui/voices';
import { buildWavetables } from './ui/wavetables';

const model = new AppModel();
const bridge = new AudioBridge(model);
const ctx: UiContext = { model, bridge, ui: new UiState(model) };
// Dark by default; an explicit choice (theme toggle) is remembered.
setTheme(storedTheme() ?? 'dark', false);

// ---- session: restore the autosaved one (before the first render), else the default ----
const lock = new TabLock();
const boot = await restoreSession(() => SessionStore.open(), () => lock.acquire());
model.loadState(boot.state.model);
ctx.ui.loadPrefs(boot.state.ui);
const saver = new Autosaver(model, () => ctx.ui.exportPrefs(), boot.store, browserScheduler());
saver.init(boot.stored);
// Never reuse an id that a kept (unrestorable) session uses either.
model.reserveTableIds(boot.reserve);
if (!boot.owner) saver.setActive(false);
ctx.ui.onVoice(() => saver.markDirty());
ctx.ui.onPrefs(() => saver.markDirty());
// Hidden / closing: one transaction, issued synchronously (async chains don't survive unload).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void saver.flushNow();
});
window.addEventListener('pagehide', () => void saver.flushNow());
// A fresh session (nothing restored) is saved right away.
if (!boot.restored) saver.markDirty();
const otherTabNotice = () =>
  showNotice('mkwavez is open in another tab: autosave is paused here (that tab saves its session).', [{ label: 'Use autosave here…', run: () => void takeOver() }]);
lock.onLost = () => {
  saver.setActive(false);
  otherTabNotice();
};
/** Take autosave over from the other tab: this tab's session replaces the saved one. */
async function takeOver(): Promise<void> {
  if (!boot.store || saver.isActive) return;
  const ok = window.confirm(
    'Use autosave in this tab?\n\nThis tab’s session replaces the one saved by the other tab, and the other tab stops saving.',
  );
  if (!ok || !(await lock.takeOver())) return;
  try {
    saver.adopt(await boot.store.keys());
    saver.setActive(true);
  } catch (e) {
    console.warn('[session] take over failed', e);
    showNotice('Couldn’t take over autosave in this tab.');
  }
}

// ---- MIDI: input events go straight to the router and the worklet (not via the frame loop) ----
// CC moves reach the worklet at once (voice/patch); the model and sliders catch up per frame
// (a timer, so it also runs in a background tab).
const midi = new MidiController(
  model,
  { notes: (evs) => bridge.sendMidi(evs), params: (id, patch) => bridge.patchVoice(id, patch) },
  () => ctx.ui.voiceId,
  { get: (k) => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v) },
  (fn) => setTimeout(fn, 16),
);
ctx.ui.onVoice(() => midi.retarget());
model.on('voices', () => midi.retarget());
const webMidi = new WebMidi();
webMidi.onMessage = (data, source) => midi.handle(data, source);
webMidi.onSourceLost = (source) => midi.sourceLost(source);

// ---- UI ----
const generate = buildGenerate(ctx);
const timeline = buildTimeline(ctx);
const wavetables = buildWavetables(ctx);
const voices = buildVoices(ctx);
const sequences = buildSequences(ctx);
const hooks: SessionHooks = {
  takeOver,
  hasKept: () => boot.hasKept,
  async exportKept() {
    try {
      const kept = await boot.store?.loadKept();
      if (!kept) return;
      downloadBytes(packSessionFile(kept.meta as SessionMeta, kept.records), `mkwavez-unrestored-${stamp(new Date(kept.savedAt))}${FILE_EXTENSION}`);
    } catch (e) {
      console.warn('[session] export of the kept session failed', e);
      showNotice('Couldn’t export the kept session.');
    }
  },
  async discardKept() {
    if (!window.confirm('Discard the session that couldn’t be restored? It can’t be recovered afterwards.')) return;
    await boot.store?.clearKept().catch(() => {});
    boot.hasKept = false;
  },
};
const session = buildSessionMenu(ctx, saver, hooks);
const root = document.getElementById('app')!;
root.replaceChildren(
  buildTransport(ctx, fragment(session.el, buildMidi(ctx, midi, webMidi))),
  h(
    'main',
    { class: 'shell' },
    h('h1', { class: 'sr-only' }, 'mkwavez — evolving wavetable synth'),
    generate.el,
    wavetables.el,
    timeline.el,
    voices.el,
    sequences.el,
  ),
);

installShortcuts(ctx, { togglePlay: () => void togglePlay(ctx) });

// ---- notices (e.g. an add refused: the Timeline is full of waveforms wavetables use) ----
const toast = h('div', { class: 'toast', id: 'notice', role: 'status', 'aria-live': 'polite', hidden: true, onclick: () => (toast.hidden = true) });
document.body.append(toast);
let toastTimer: ReturnType<typeof setTimeout> | undefined;
model.on('notice', () => {
  toast.textContent = model.notice;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 8000);
});

// ---- frame loop: views draw only when dirty (or animating while playing), ~25 fps cap while playing ----
const views: FrameView[] = [generate.view, timeline.view, wavetables.view, voices.view, sequences.view];
const limiter = throttle(40);
const loop = (now: number) => {
  if (!model.playing || limiter(now)) for (const v of views) v.frame(now);
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);

// A remembered MIDI input (not 'off') reconnects on load; 'off' never prompts for access.
if (midi.settings.input !== 'off') void webMidi.select(midi.settings.input);

bridge.onStatus = (s) => {
  document.body.dataset.step = String(s.step);
};

// Debug handle for the console and smoke tests.
(window as unknown as { mkwavez: unknown }).mkwavez = { model, bridge, ui: ctx.ui, setTheme, midi, webMidi, saver, session };

for (const n of boot.notices) {
  showNotice(
    n.text,
    n.kind === 'kept'
      ? [
          { label: 'Export it', run: () => void hooks.exportKept() },
          { label: 'Discard it', run: () => void hooks.discardKept().then(() => session.sync()) },
        ]
      : [],
  );
}
if (!boot.owner) otherTabNotice();

function browserScheduler(): SaveScheduler {
  const ric = (globalThis as { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  return {
    now: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    idle: (fn) => (ric ? ric(fn, { timeout: 250 }) : setTimeout(fn, 16)),
  };
}

function fragment(...nodes: Node[]): DocumentFragment {
  const f = document.createDocumentFragment();
  f.append(...nodes);
  return f;
}
