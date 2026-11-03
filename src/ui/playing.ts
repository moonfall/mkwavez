import type { AppModel } from '../app/model';
import type { AudioBridge } from '../audio/bridge';
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

/**
 * The positions a voice plays: the worklet's live LFO-modulated positions while the
 * transport runs, else the static (unmodulated) slider positions.
 */
export function voicePositions(model: AppModel, bridge: AudioBridge, v: VoiceParams): { x: number; y: number; live: boolean } {
  const st = model.playing ? bridge.status.voices.find((s) => s.id === v.id) : undefined;
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
