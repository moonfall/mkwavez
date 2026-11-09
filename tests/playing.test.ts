import { describe, expect, it } from 'vitest';
import { AppModel } from '../src/app/model';
import { pluginSessionState } from '../src/app/defaultSession';
import type { AudioBridge } from '../src/audio/bridge';
import { emptyStatus, type VoiceStatus } from '../src/core/engine/engine';
import { oscPositions, voicePositions } from '../src/ui/playing';

const status = (v: Partial<VoiceStatus>): AudioBridge =>
  ({ status: { ...emptyStatus(), voices: [{ id: 1, pos: 0.81, posY: 0.2, index: 0, y: 0, env: 0, note: -1, posB: 0.66, posYB: 0.4, indexB: 0, yB: 0, ...v }] } }) as unknown as AudioBridge;

describe('where a voice plays (the position the UI shows)', () => {
  const model = new AppModel();
  model.loadState(pluginSessionState());
  const v = model.voice(1)!;

  it("follows the engine while a note sounds, with the transport stopped (the plugin's MIDI)", () => {
    expect(model.playing).toBe(false);
    expect(voicePositions(model, status({ note: 60, env: 0.5 }), v)).toEqual({ x: 0.81, y: 0.2, live: true });
    expect(oscPositions(model, status({ note: 60, env: 0.5 }), v, 'b')).toEqual({ x: 0.66, y: 0.4, live: true });
    // A released note still ringing.
    expect(voicePositions(model, status({ note: -1, env: 0.2 }), v).live).toBe(true);
  });

  it('shows the sliders while the voice is silent and the transport stopped', () => {
    expect(voicePositions(model, status({ note: -1, env: 0 }), v)).toEqual({ x: v.position, y: v.positionY, live: false });
    expect(oscPositions(model, status({ note: -1, env: 0 }), v, 'b')).toEqual({ x: v.synth.b.position, y: v.synth.b.positionY, live: false });
  });

  it('follows the engine while the transport runs', () => {
    model.setTransport({ playing: true, bpm: 120 });
    expect(voicePositions(model, status({ note: -1, env: 0 }), v).live).toBe(true);
    model.setTransport({ playing: false, bpm: 120 });
  });
});

describe('views animate while voices play', () => {
  it('while a voice sounds (transport stopped), and briefly after, so they settle on the sliders', async () => {
    const { animating } = await import('../src/ui/playing');
    const model = new AppModel();
    model.loadState(pluginSessionState());
    expect(animating(model, status({ note: -1, env: 0 }), 0)).toBe(false);
    expect(animating(model, status({ note: 60, env: 0.4 }), 1000)).toBe(true);
    expect(animating(model, status({ note: -1, env: 0 }), 1200)).toBe(true); // settling
    expect(animating(model, status({ note: -1, env: 0 }), 2000)).toBe(false);
    model.setTransport({ playing: true, bpm: 120 });
    expect(animating(model, status({ note: -1, env: 0 }), 5000)).toBe(true);
    model.setTransport({ playing: false, bpm: 120 });
  });
});
