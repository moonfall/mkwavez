import './ui/styles.css';
import { MidiController } from './app/midi';
import { AppModel } from './app/model';
import { AudioBridge } from './audio/bridge';
import { juceBackend, NativePort } from './audio/nativePort';
import { applyStartState } from './app/startState';
import { WebMidi, type MidiInputs } from './browser/webMidi';
import { NO_MIDI_OUTPUT, PluginHost } from './plugin/host';
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
// Inside the plugin (JUCE web view) the native engine plays and the host owns MIDI and state.
const backend = juceBackend();
const nativePort = backend ? new NativePort(backend) : null;
const bridge = new AudioBridge(model, nativePort ?? undefined);
const plugin = nativePort ? new PluginHost(model, bridge, nativePort) : null;
const ctx: UiContext = { model, bridge, ui: new UiState(model) };
if (plugin) {
  document.documentElement.dataset.host = 'plugin';
  plugin.forwardLogs();
}
// Dark by default; an explicit choice (theme toggle) is remembered.
setTheme(storedTheme() ?? 'dark', false);

// ---- initial state: the plugin's saved project, else the start state ----
if (plugin) await plugin.connect();
else applyStartState(model);

// ---- MIDI: input events go straight to the router and the worklet (not via the frame loop) ----
// CC moves reach the worklet at once (voice/patch); the model and sliders catch up per frame
// (a timer, so it also runs in a background tab). In the plugin the native side routes the
// host's MIDI; controller moves come back for learn / sliders, settings live in the project.
const browserStore = { get: (k: string) => localStorage.getItem(k), set: (k: string, v: string) => localStorage.setItem(k, v) };
const midi = new MidiController(
  model,
  plugin ? NO_MIDI_OUTPUT : { notes: (evs) => bridge.sendMidi(evs), params: (id, patch) => bridge.patchVoice(id, patch) },
  () => ctx.ui.voiceId,
  plugin ? plugin.store : browserStore,
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
const generate = buildGenerate(ctx);
const timeline = buildTimeline(ctx);
const wavetables = buildWavetables(ctx);
const voices = buildVoices(ctx);
const sequences = buildSequences(ctx);
const root = document.getElementById('app')!;
root.replaceChildren(
  buildTransport(ctx, buildMidi(ctx, midi, midiInputs)),
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

// ---- frame loop: views draw only when dirty (or animating while playing), ~25 fps cap while playing ----
const views: FrameView[] = [generate.view, timeline.view, wavetables.view, voices.view, sequences.view];
const limiter = throttle(40);
const loop = (now: number) => {
  if (!model.playing || limiter(now)) for (const v of views) v.frame(now);
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);

// A remembered MIDI input (not 'off') reconnects on load; 'off' never prompts for access.
if (webMidi && midi.settings.input !== 'off') void webMidi.select(midi.settings.input);

bridge.onStatus = (s) => {
  document.body.dataset.step = String(s.step);
};

// Debug handle for the console and smoke tests.
(window as unknown as { mkwavez: unknown }).mkwavez = { model, bridge, ui: ctx.ui, setTheme, midi, webMidi, plugin };
