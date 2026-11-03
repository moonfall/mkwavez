import './ui/styles.css';
import { MidiController } from './app/midi';
import { AppModel } from './app/model';
import { AudioBridge } from './audio/bridge';
import { WebMidi } from './browser/webMidi';
import { generateBasic } from './core/generators';
import { LAST_BATCH_WAVETABLE_ID } from './core/wavetable';
import { setTheme, storedTheme, throttle } from './ui/canvas';
import { UiState, type FrameView, type UiContext } from './ui/context';
import { h } from './ui/dom';
import { buildGenerate } from './ui/generate';
import { buildMidi } from './ui/midi';
import { buildSequences } from './ui/sequences';
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

// ---- initial state (as the prototype): five basic tables (one batch), three voices, one
// sequence each; only voice 1 starts unmuted. V1 plays the built-in Last batch, so each new
// batch (or single add) becomes what it plays; V2 / V3 play windows of the Timeline. ----
model.addTables(
  (['sine', 'tri', 'saw', 'square', 'p25'] as const).map((w) => generateBasic(w, 0)),
  false,
);
const v1 = model.addVoice({ wavetableId: LAST_BATCH_WAVETABLE_ID, windowStart: 0, windowEnd: 4, position: 0.3, lfoDepth: 0.6, lfoRate: 0.25, octave: 0 })!;
const v2 = model.addVoice({ windowStart: 1, windowEnd: 4, position: 0.75, lfoDepth: 0.3, lfoRate: 0.11, lfoPhase: 1.5, octave: 1, mute: true })!;
const v3 = model.addVoice({
  windowStart: 0,
  windowEnd: 2,
  position: 0.5,
  lfoDepth: 0.9,
  lfoRate: 1.2,
  lfoPhase: 3,
  octave: -1,
  mute: true,
})!;
model.addSequence(v1.id, [0, -1, 3, -1, 4, 4, -1, 2, 0, -1, 5, 4, -1, 3, 2, -1]);
model.addSequence(v2.id, [-1, -1, 7, -1, -1, 5, -1, -1, -1, -1, 6, -1, 4, -1, -1, -1]);
model.addSequence(v3.id, [0, -1, -1, -1, 0, -1, -1, -1, 3, -1, -1, -1, 2, -1, -1, -1]);
model.select(model.timeline[0].id);
model.clearUndo();

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
const root = document.getElementById('app')!;
root.replaceChildren(
  buildTransport(ctx, buildMidi(ctx, midi, webMidi)),
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
(window as unknown as { mkwavez: unknown }).mkwavez = { model, bridge, ui: ctx.ui, setTheme, midi, webMidi };
