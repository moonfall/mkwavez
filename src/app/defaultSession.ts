import { generateBasic } from '../core/generators';
import type { ModelState, SessionState } from '../core/session';
import { LAST_BATCH_WAVETABLE_ID } from '../core/wavetable';
import { AppModel } from './model';

/**
 * The fresh session (as the prototype): five basic waveforms (one batch), three voices, one
 * sequence each; only voice 1 starts unmuted. V1 plays the built-in Last batch, so each new
 * batch (or single add) becomes what it plays; V2 / V3 play windows of the Timeline.
 */
export function defaultSessionState(): ModelState {
  const model = new AppModel();
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
  return model.exportState();
}

/**
 * The plugin's fresh session: the same five waveforms and one Synth voice (V1, on Last
 * batch) that the host's MIDI plays. Its sequence is kept for the page's Play (the internal
 * sequencer doesn't follow the host's transport by default). The UI opens on V1 with
 * Generate, Timeline and Voice open (Wavetables and Sequence collapsed); the plugin window's
 * default size gives the Voice panel room for the Synth's full view.
 */
export function pluginSessionState(): ModelState {
  const model = new AppModel();
  model.addTables(
    (['sine', 'tri', 'saw', 'square', 'p25'] as const).map((w) => generateBasic(w, 0)),
    false,
  );
  const v1 = model.addVoice({ type: 'synth', wavetableId: LAST_BATCH_WAVETABLE_ID, windowStart: 0, windowEnd: 4, position: 0.3, lfoDepth: 0.6, lfoRate: 0.25, octave: 0 })!;
  model.addSequence(v1.id, [0, -1, 3, -1, 4, 4, -1, 2, 0, -1, 5, 4, -1, 3, 2, -1]);
  model.select(model.timeline[0].id);
  return model.exportState();
}

/** UI prefs of the plugin's fresh session (layout: see ui/layout.ts LayoutState). */
export const PLUGIN_UI_PREFS = { layoutWide: { collapsed: ['wt', 'seq'], max: null, restore: null } } as const;

export function pluginSession(): SessionState {
  const model = pluginSessionState();
  return { model, ui: { ...PLUGIN_UI_PREFS, voiceId: model.voices[0]?.id ?? null } };
}
