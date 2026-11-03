/**
 * The start state (as the prototype): five basic tables (one batch), three voices, one
 * sequence each; only voice 1 starts unmuted. V1 plays the built-in Last batch, so each
 * new batch (or single add) becomes what it plays; V2 / V3 play windows of the Timeline.
 */
import { generateBasic } from '../core/generators';
import { LAST_BATCH_WAVETABLE_ID } from '../core/wavetable';
import type { AppModel } from './model';

export function applyStartState(model: AppModel): void {
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
}
