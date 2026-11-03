import './ui/styles.css';
import { AppModel } from './app/model';
import { AudioBridge } from './audio/bridge';
import { generateBasic } from './core/generators';
import { throttle } from './ui/canvas';
import type { FrameView, UiContext } from './ui/context';
import { h } from './ui/dom';
import { buildGenerate } from './ui/generate';
import { buildSequences } from './ui/sequences';
import { buildTimeline } from './ui/timeline';
import { buildTransport } from './ui/transport';
import { buildVoices } from './ui/voices';
import { buildWavetables } from './ui/wavetables';

const model = new AppModel();
const bridge = new AudioBridge(model);
const ctx: UiContext = { model, bridge };

// ---- initial state (as the prototype): five basic tables, three voices, one sequence each ----
for (const w of ['sine', 'tri', 'saw', 'square', 'p25'] as const) model.addTables([generateBasic(w, 0)], 'single', false);
const v1 = model.addVoice({ windowStart: 0, windowEnd: 4, position: 0.3, lfoDepth: 0.6, lfoRate: 0.25, octave: 0 })!;
const v2 = model.addVoice({ windowStart: 1, windowEnd: 4, position: 0.75, lfoDepth: 0.3, lfoRate: 0.11, lfoPhase: 1.5, octave: 1 })!;
const v3 = model.addVoice({
  windowStart: 0,
  windowEnd: 2,
  position: 0.5,
  lfoDepth: 0.9,
  lfoRate: 1.2,
  lfoPhase: 3,
  octave: -1,
  interp: 'step',
  mute: true,
})!;
model.addSequence(v1.id, [0, -1, 3, -1, 4, 4, -1, 2, 0, -1, 5, 4, -1, 3, 2, -1]);
model.addSequence(v2.id, [-1, -1, 7, -1, -1, 5, -1, -1, -1, -1, 6, -1, 4, -1, -1, -1]);
model.addSequence(v3.id, [0, -1, -1, -1, 0, -1, -1, -1, 3, -1, -1, -1, 2, -1, -1, -1]);
model.setBatchTarget(v1.id, true);
model.select(model.timeline[0].id);
model.clearUndo();

// ---- UI ----
const timeline = buildTimeline(ctx);
const wavetables = buildWavetables(ctx);
const voices = buildVoices(ctx);
const sequences = buildSequences(ctx);
const root = document.getElementById('app')!;
root.replaceChildren(
  buildTransport(ctx),
  h(
    'main',
    {},
    h('h1', { class: 'sr-only' }, 'mkwavez — evolving wavetable synth'),
    buildGenerate(ctx),
    timeline.el,
    wavetables.el,
    voices.el,
    sequences.el,
  ),
);

// ---- frame loop: views draw only when dirty (or animating while playing), ~25 fps cap while playing ----
const views: FrameView[] = [timeline.view, wavetables.view, voices.view, sequences.view];
const limiter = throttle(40);
const loop = (now: number) => {
  if (!model.playing || limiter(now)) for (const v of views) v.frame(now);
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);

bridge.onStatus = (s) => {
  document.body.dataset.step = String(s.step);
};

// Debug handle for the console and smoke tests.
(window as unknown as { mkwavez: unknown }).mkwavez = { model, bridge };
