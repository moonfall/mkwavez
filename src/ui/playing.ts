import type { AppModel } from '../app/model';
import type { AudioBridge } from '../audio/bridge';
import type { VoiceStatus } from '../core/engine/engine';
import type { VoiceParams } from '../core/voice';
import { voiceWindow } from '../core/voice';
import type { Wavetable } from '../core/wavetable';
import { Mix, packWavetable, resolveMix, type PackedWavetable } from '../core/wavetablePlayback';

const packed = new WeakMap<Wavetable, PackedWavetable>();

/** Packed form of a wavetable (cached per immutable wavetable object). */
export function packedOf(wt: Wavetable): PackedWavetable {
  let p = packed.get(wt);
  if (!p) packed.set(wt, (p = packWavetable(wt)));
  return p;
}

/** Envelope level above which a voice counts as sounding (a note held, or still releasing). */
const SOUNDING_ENV = 1e-3;

/**
 * The engine's status for a voice while it is live: the transport runs, or it sounds (a
 * note from MIDI, the host or Hold, held or releasing) — in the plugin the host's MIDI plays
 * the voices with the transport stopped. Else undefined (the sliders show where it would play).
 */
export function liveStatus(model: AppModel, bridge: AudioBridge, v: VoiceParams): VoiceStatus | undefined {
  const st = bridge.status.voices.find((s) => s.id === v.id);
  return st && isLive(model, st) ? st : undefined;
}

/** A voice's status entry is live: the transport runs, or the voice sounds. */
export function isLive(model: AppModel, st: VoiceStatus): boolean {
  return model.playing || st.note >= 0 || st.env > SOUNDING_ENV;
}

/** How long views keep redrawing after the last voice falls silent (back to the sliders). */
const SETTLE_MS = 400;
let lastLiveAt = -Infinity;

/**
 * Whether views showing where voices play must redraw every frame: the transport runs or a
 * voice sounds (host / MIDI notes, Hold), and briefly after (to settle on the sliders).
 */
export function animating(model: AppModel, bridge: AudioBridge, now = performance.now()): boolean {
  if (model.playing || bridge.status.voices.some((s) => isLive(model, s))) {
    lastLiveAt = now;
    return true;
  }
  return now - lastLiveAt < SETTLE_MS;
}

/**
 * The positions a voice plays: the engine's live (LFO / matrix-modulated) positions while
 * it is live (see liveStatus), else the static (unmodulated) slider positions.
 */
export function voicePositions(model: AppModel, bridge: AudioBridge, v: VoiceParams): { x: number; y: number; live: boolean } {
  const st = liveStatus(model, bridge, v);
  if (st) return { x: st.pos, y: st.posY ?? v.positionY, live: true };
  return { x: v.position, y: v.positionY, live: false };
}

/** Tables (and weights) a voice is playing, resolved exactly as the engine does. */
export function playingMix(model: AppModel, bridge: AudioBridge, v: VoiceParams, out = new Mix()): Mix {
  out.n = 0;
  const wt = model.wavetable(v.wavetableId);
  if (!wt) return out;
  const p = voicePositions(model, bridge, v);
  return resolveMix(packedOf(wt), voiceWindow(v), p.x, p.y, wt.interp === 'step', out);
}

/**
 * A Synth voice's oscillator as a voice-shaped view (wavetable, window, position; no
 * position LFO: Synth voices don't use the Simple voice's LFOs), for the pad and scope.
 */
export function oscView(v: VoiceParams, osc: 'a' | 'b'): VoiceParams {
  const src = osc === 'b' ? v.synth.b : v;
  return { ...v, ...(osc === 'b' ? src : {}), lfoDepth: 0, lfoDepthY: 0 };
}

/** Where a Synth voice's oscillator plays: live (status) while the voice is live, else its sliders. */
export function oscPositions(model: AppModel, bridge: AudioBridge, v: VoiceParams, osc: 'a' | 'b'): { x: number; y: number; live: boolean } {
  const src = osc === 'b' ? v.synth.b : v;
  const st = liveStatus(model, bridge, v);
  if (st && st.posB !== undefined) return osc === 'b' ? { x: st.posB, y: st.posYB, live: true } : { x: st.pos, y: st.posY, live: true };
  return { x: src.position, y: src.positionY, live: false };
}

/** Tables (and weights) a Synth voice's oscillator plays, resolved as the engine does. */
export function oscMix(model: AppModel, bridge: AudioBridge, v: VoiceParams, osc: 'a' | 'b', out = new Mix()): Mix {
  out.n = 0;
  const src = osc === 'b' ? v.synth.b : v;
  const wt = model.wavetable(src.wavetableId);
  if (!wt) return out;
  const p = oscPositions(model, bridge, v, osc);
  return resolveMix(packedOf(wt), voiceWindow(src), p.x, p.y, wt.interp === 'step', out);
}

/** The table with the largest weight in a mix (-1 if none). */
export function dominantId(m: Mix): number {
  let best = -1;
  let w = -1;
  for (let k = 0; k < m.n; k++) {
    if (m.w[k] > w) {
      w = m.w[k];
      best = m.ids[k];
    }
  }
  return best;
}
