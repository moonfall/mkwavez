import './ui/styles.css';
import { MidiController } from './app/midi';
import { AppModel } from './app/model';
import { AudioBridge } from './audio/bridge';
import { WebMidi } from './browser/webMidi';
import { Autosaver, type SaveScheduler } from './app/autosave';
import { defaultSessionState } from './app/defaultSession';
import { SessionStore } from './browser/sessionStore';
import { decodeSession, type SessionState, type WaveformRecord } from './core/session';
import { setTheme, storedTheme, throttle } from './ui/canvas';
import { UiState, type FrameView, type UiContext } from './ui/context';
import { h } from './ui/dom';
import { buildGenerate } from './ui/generate';
import { buildMidi } from './ui/midi';
import { buildSequences } from './ui/sequences';
import { buildSessionMenu, showNotice } from './ui/session';
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
const boot = await restoreSession();
model.loadState(boot.state.model);
ctx.ui.loadPrefs(boot.state.ui);
const saver = new Autosaver(model, () => ctx.ui.exportPrefs(), boot.store, browserScheduler());
saver.init(boot.stored);
ctx.ui.onVoice(() => saver.markDirty());
ctx.ui.onPrefs(() => saver.markDirty());
// Hidden / closing: write now (no idle yielding; audio runs on its own thread).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void saver.flush();
});
window.addEventListener('pagehide', () => void saver.flush());
// A fresh session (nothing restored) is saved right away.
if (!boot.restored) saver.markDirty();

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
const session = buildSessionMenu(ctx, saver);
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

for (const n of boot.notices) showNotice(n.text, n.actions);

// ---- session restore ----

interface Boot {
  state: SessionState;
  store: SessionStore | null;
  /** Records the store holds (so autosave writes only new waveforms). */
  stored: WaveformRecord[];
  restored: boolean;
  notices: { text: string; actions?: { label: string; run: () => void }[] }[];
}

/**
 * Open storage and decode the last session. Never throws: no storage → a fresh session,
 * autosave off and a notice; an unreadable save → a fresh session, the bad save kept in
 * the store (meta key 'corrupt') and a notice offering to discard it.
 */
async function restoreSession(): Promise<Boot> {
  const fresh = (): SessionState => ({ model: defaultSessionState(), ui: {} });
  let store: SessionStore;
  try {
    store = await SessionStore.open();
  } catch (e) {
    console.warn('[session] storage unavailable', e);
    return {
      state: fresh(),
      store: null,
      stored: [],
      restored: false,
      notices: [{ text: 'Autosave is off: this browser isn’t allowing storage (private window?). Use Session → Export to keep your work.' }],
    };
  }
  let loaded;
  try {
    loaded = await store.load();
  } catch (e) {
    console.warn('[session] reading the saved session failed', e);
    return {
      state: fresh(),
      store: null,
      stored: [],
      restored: false,
      notices: [{ text: 'Couldn’t read the saved session; autosave is off for this tab. Use Session → Export to keep your work.' }],
    };
  }
  const stored = [...loaded.records.values()];
  if (loaded.meta === undefined) return { state: fresh(), store, stored, restored: false, notices: [] };
  try {
    const { state, warnings } = decodeSession(loaded.meta, loaded.records);
    if (warnings.length) console.warn('[session] restored with warnings', warnings);
    return { state, store, stored, restored: true, notices: warnings.length ? [{ text: `Session restored, but ${warnings[0]}.` }] : [] };
  } catch (e) {
    console.warn('[session] the saved session could not be restored', e);
    const error = e instanceof Error ? e.message : String(e);
    await store.keepCorrupt(loaded.meta, error).catch(() => {});
    return {
      state: fresh(),
      store,
      stored,
      restored: false,
      notices: [
        {
          text: `Couldn’t restore the last session (${error}); started a new one. The unreadable save is kept for debugging.`,
          actions: [{ label: 'Discard it', run: () => void store.clearCorrupt().catch(() => {}) }],
        },
      ],
    };
  }
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
