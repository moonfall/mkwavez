import { describe, expect, it } from 'vitest';
import { defaultSessionState, PLUGIN_UI_PREFS, pluginSession } from '../src/app/defaultSession';
import { AppModel } from '../src/app/model';
import { SYNTH_AMP_DEFAULTS } from '../src/core/synth';
import { LAST_BATCH_WAVETABLE_ID } from '../src/core/wavetable';
import { maximized, parseLayoutState } from '../src/ui/layout';

describe("the plugin's fresh session", () => {
  it('is one Synth voice on Last batch, with its sequence (the browser keeps three Simple voices)', () => {
    const { model, ui } = pluginSession();
    expect(model.voices).toHaveLength(1);
    const v = model.voices[0];
    expect(v.type).toBe('synth');
    expect(v.mute).toBe(false);
    expect(v.wavetableId).toBe(LAST_BATCH_WAVETABLE_ID);
    expect({ attack: v.attack, decay: v.decay, sustain: v.sustain, release: v.release }).toEqual(SYNTH_AMP_DEFAULTS);
    expect(model.sequences.map((s) => s.voiceId)).toEqual([v.id]);
    expect(model.timeline).toHaveLength(5);
    expect(ui.voiceId).toBe(v.id);
    // The browser's default is unchanged.
    expect(defaultSessionState().voices.map((x) => x.type)).toEqual(['simple', 'simple', 'simple']);
    // It loads as is (the model accepts it unchanged).
    const m = new AppModel();
    m.loadState(model);
    expect(m.voices).toEqual(model.voices);
  });

  it('opens with the Voice panel maximized (the full Synth view); Restore brings the rest back, Sequence collapsed', () => {
    const s = parseLayoutState(PLUGIN_UI_PREFS.layoutWide, 'wide');
    expect(s).toEqual(maximized({ collapsed: ['seq'], max: null, restore: null }, 'voice'));
    expect(maximized(s, 'voice')).toEqual({ collapsed: ['seq'], max: null, restore: null });
  });
});
