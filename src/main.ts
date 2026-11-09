import './ui/styles.css';
import { MidiController } from './app/midi';
import { AppModel } from './app/model';
import { AudioBridge } from './audio/bridge';
import { juceBackend, NativePort } from './audio/nativePort';
import { WebMidi, type MidiInputs } from './browser/webMidi';
import { Autosaver, type SaveScheduler } from './app/autosave';
import { NO_MIDI_OUTPUT, PluginHost } from './plugin/host';
import { SessionStore } from './browser/sessionStore';
import { FILE_EXTENSION, packSessionFile, type SessionMeta } from './core/session';
import { becomeOwner, restoreSession } from './app/restore';
import { TabLock } from './browser/tabLock';
import { setTheme, storedTheme, throttle } from './ui/canvas';
import { UiState, type FrameView, type UiContext } from './ui/context';
import { h } from './ui/dom';
import { ask, pageDialogs, setDialogHost } from './ui/dialogs';
import { buildGenerate } from './ui/generate';
import { layout } from './ui/layout';
import { buildMidi } from './ui/midi';
import { buildSequences } from './ui/sequences';
import { buildSessionMenu, downloadBytes, setDefaultSession, setFileHost, showNotice, stamp, type SessionHooks } from './ui/session';
import { pluginSession } from './app/defaultSession';
import { versionLabel } from './version';
import { installShortcuts } from './ui/shortcuts';
import { buildTimeline } from './ui/timeline';
import { buildTransport, togglePlay } from './ui/transport';
import { buildVoices } from './ui/voices';
import { buildWavetables } from './ui/wavetables';

const model = new AppModel();
// Inside the plugin (JUCE web view) the native engine plays; the host owns MIDI and the saved session.
const backend = juceBackend();
const nativePort = backend ? new NativePort(backend) : null;
const bridge = new AudioBridge(model, nativePort ?? undefined);
const plugin = nativePort ? new PluginHost(model, bridge, nativePort) : null;
const ctx: UiContext = { model, bridge, ui: new UiState(model) };
if (plugin) {
  document.documentElement.dataset.host = 'plugin';
  plugin.forwardLogs();
  // Embedded web views don't all provide confirm / prompt or downloads: in-page dialogs,
  // native save / open dialogs.
  setDialogHost(pageDialogs());
  setFileHost(plugin.files);
  // A fresh plugin instance (and Session → New in it): one Synth voice, opened in full.
  setDefaultSession(pluginSession);
  plugin.onFileMessage = (text) => showNotice(text);
}
// Which build (also in the Session menu and the title's tooltip).
console.info(`[mkwavez] ${versionLabel()}${plugin ? ' (plugin)' : ''}`);
// Dark by default; an explicit choice (theme toggle) is remembered.
setTheme(storedTheme() ?? 'dark', false);

// ---- session: restore the autosaved one (before the first render), else the default ----
// In the plugin the session lives in the host's project (one page per plugin instance:
// no tab lock); saves are quick because the editor can close at any moment.
const lock = new TabLock();
if (plugin) await plugin.connect();
const boot = plugin
  ? await restoreSession(() => Promise.resolve(plugin.session), () => Promise.resolve(true), pluginSession)
  : await restoreSession(() => SessionStore.open(), () => lock.acquire());
model.loadState(boot.state.model);
ctx.ui.loadPrefs(boot.state.ui);
if (plugin) await plugin.start(boot.restored);
const saver = new Autosaver(model, () => ctx.ui.exportPrefs(), boot.store, browserScheduler(), plugin ? { delay: 250, maxWait: 1000 } : {});
// Ownership first: a tab that doesn't own autosave never deletes or writes anything.
if (!boot.owner) saver.setActive(false);
saver.init(boot.stored);
// Never reuse an id that a kept (unrestorable) session uses either.
model.reserveTableIds(boot.reserve);
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
  const ok = await ask.confirm(
    'Use autosave in this tab?\n\nThis tab’s session replaces the one saved by the other tab, and the other tab stops saving.',
  );
  if (!ok || !(await lock.takeOver())) return;
  try {
    await becomeOwner(saver, boot.store, boot, true);
    session.sync();
  } catch (e) {
    console.warn('[session] take over failed', e);
    showNotice('Couldn’t take over autosave in this tab.');
  }
}

// ---- MIDI: input events go straight to the router and the worklet (not via the frame loop) ----
// CC moves reach the worklet at once (voice/patch); the model and sliders catch up per frame
// (a timer, so it also runs in a background tab).
// In the plugin the native side routes the host's MIDI; controller moves come back for learn /
// sliders, and the settings are saved by the plugin.
const midi = new MidiController(
  model,
  plugin ? NO_MIDI_OUTPUT : { notes: (evs) => bridge.sendMidi(evs), params: (id, patch) => bridge.patchVoice(id, patch) },
  () => ctx.ui.voiceId,
  plugin ? plugin.store : { get: (k) => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v) },
  (fn) => setTimeout(fn, 16),
);
ctx.ui.onVoice(() => midi.retarget());
model.on('voices', () => midi.retarget());
let midiInputs: MidiInputs;
let webMidi: WebMidi | null = null;
if (plugin) {
  midiInputs = plugin.midiInputs;
  plugin.attachMidi(midi, () => ctx.ui.voiceId, (fn) => ctx.ui.onVoice(fn));
} else {
  webMidi = new WebMidi();
  webMidi.onMessage = (data, source) => midi.handle(data, source);
  webMidi.onSourceLost = (source) => midi.sourceLost(source);
  midiInputs = webMidi;
}

// ---- UI ----
// Collapsed / maximized panels: saved with the session's UI prefs (per layout).
layout.init(ctx.ui);
const generate = buildGenerate(ctx);
const timeline = buildTimeline(ctx);
const wavetables = buildWavetables(ctx);
const voices = buildVoices(ctx);
const sequences = buildSequences(ctx);
const hooks: SessionHooks = {
  takeOver,
  keptCount: () => boot.keptCount,
  async exportKept() {
    try {
      const latest = (await boot.store?.keptList())?.at(-1);
      const kept = latest && (await boot.store?.loadKept(latest.key));
      if (!kept) return;
      downloadBytes(packSessionFile(kept.meta as SessionMeta, kept.records), `mkwavez-unrestored-${stamp(new Date(kept.info.savedAt))}${FILE_EXTENSION}`);
    } catch (e) {
      console.warn('[session] export of the kept session failed', e);
      showNotice('Couldn’t export the kept session.');
    }
  },
  async discardKept() {
    if (!(await ask.confirm('Discard the most recent session that couldn’t be restored? It can’t be recovered afterwards.'))) return;
    try {
      const latest = (await boot.store?.keptList())?.at(-1);
      if (latest) await boot.store?.clearKept(latest.key);
      boot.keptCount = (await boot.store?.keptList())?.length ?? 0;
    } catch (e) {
      console.warn('[session] discarding the kept session failed', e);
    }
  },
};
const session = buildSessionMenu(ctx, saver, hooks);
const root = document.getElementById('app')!;
root.replaceChildren(
  buildTransport(ctx, fragment(session.el, buildMidi(ctx, midi, midiInputs))),
  h(
    'main',
    { class: 'shell' },
    h('h1', { class: 'sr-only' }, 'mkwavez — evolving wavetable synth'),
    // Rows of the wide shell (display: contents in the phone column).
    h('div', { class: 'shell-row', id: 'shell-top' }, generate.el, wavetables.el),
    timeline.el,
    h('div', { class: 'shell-row', id: 'shell-bottom' }, voices.el, sequences.el),
  ),
);
layout.refresh();

installShortcuts(ctx, { togglePlay: () => void togglePlay(ctx), scrollTimeline: (to) => timeline.scrollToEdge(to) });

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
  if (!model.playing || limiter(now)) {
    for (const v of views) v.frame(now);
    layout.tick(now);
  }
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);

// A remembered MIDI input (not 'off') reconnects on load; 'off' never prompts for access.
if (webMidi && midi.settings.input !== 'off') void webMidi.select(midi.settings.input);

bridge.onStatus = (s) => {
  document.body.dataset.tick = String(s.tick);
};

// Debug handle for the console and smoke tests.
(window as unknown as { mkwavez: unknown }).mkwavez = { model, bridge, ui: ctx.ui, layout, setTheme, midi, webMidi, saver, session, plugin, ask };

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
// Not the owner at startup: the app runs (autosave paused) while the lock may still come
// free (a reload's previous document releasing it); otherwise another tab owns it.
if (!boot.owner && boot.store) {
  const store = boot.store;
  void lock.wait().then(async (got) => {
    if (!got) return otherTabNotice();
    try {
      await becomeOwner(saver, store, boot, false);
      session.sync();
    } catch (e) {
      console.warn('[session] starting autosave failed', e);
      otherTabNotice();
    }
  });
}

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
