import { describe, expect, it } from 'vitest';
import { AppModel } from '../src/app/model';
import { generateBasic } from '../src/core/generators';
import { voiceWindow } from '../src/core/voice';
import { BATCHES_WAVETABLE_ID, GRID_WAVETABLE_ID, LAST_BATCH_WAVETABLE_ID, TIMELINE_WAVETABLE_ID } from '../src/core/wavetable';
import { windowIds, packWavetable } from '../src/core/wavetablePlayback';
import { SynthEngine } from '../src/core/engine/engine';
import { buildMipSet } from '../src/core/mipmap';

/** Five waveforms (ids 1–5, one batch of 2 then three single adds); V1 on Timeline 1–3, V2 on Last batch. */
function model() {
  const m = new AppModel(64);
  m.addTables([generateBasic('sine', 0), generateBasic('tri', 0)]);
  for (const w of ['saw', 'square', 'p25'] as const) m.addTables([generateBasic(w, 0)]);
  const a = m.addVoice({ windowStart: 1, windowEnd: 3 })!;
  const b = m.addVoice({ wavetableId: LAST_BATCH_WAVETABLE_ID })!;
  m.select(3);
  m.clearUndo();
  return { m, a, b };
}

const ids = (m: AppModel) => m.timeline.map((t) => t.id);
const timelineRow = (m: AppModel) => m.wavetable(TIMELINE_WAVETABLE_ID)!.rows[0];

describe('AppModel.moveTable', () => {
  it('swaps with the neighbour, selects the moved waveform and keeps the Timeline wavetable in order', () => {
    const { m } = model();
    expect(m.moveTable(3, 1)).toBe(true);
    expect(ids(m)).toEqual([1, 2, 4, 3, 5]);
    expect(timelineRow(m)).toEqual([1, 2, 4, 3, 5]);
    expect(m.selectedId).toBe(3);
    expect(m.moveTable(3, -1)).toBe(true);
    expect(m.moveTable(3, -1)).toBe(true);
    expect(ids(m)).toEqual([1, 3, 2, 4, 5]);
    expect(timelineRow(m)).toEqual(ids(m));
    // Moving another waveform selects it.
    m.moveTable(5, -1);
    expect(m.selectedId).toBe(5);
    expect(ids(m)).toEqual([1, 3, 2, 5, 4]);
  });

  it('counts moves (the strip reveals a moved waveform), not adds, evictions or no-ops', () => {
    const { m } = model();
    m.moveTable(3, 1);
    expect(m.moves).toBe(1);
    m.moveTable(1, -1);
    m.addTables([generateBasic('sine', 0)], false);
    m.undo();
    expect(m.moves).toBe(1);
  });

  it('is a no-op at the ends (no undo step)', () => {
    const { m } = model();
    expect(m.moveTable(1, -1)).toBe(false);
    expect(m.moveTable(5, 1)).toBe(false);
    expect(m.moveTable(99, 1)).toBe(false);
    expect(m.moveTable(null, 1)).toBe(false);
    expect(ids(m)).toEqual([1, 2, 3, 4, 5]);
    expect(m.undoDepth).toBe(0);
    expect(m.selectedId).toBe(3);
  });

  it('leaves other wavetables (they reference ids) untouched', () => {
    const { m } = model();
    const before = m.wavetables.filter((w) => w.id !== TIMELINE_WAVETABLE_ID);
    m.moveTable(3, -1);
    for (const w of before) expect(m.wavetable(w.id)).toBe(w);
    expect(m.wavetable(LAST_BATCH_WAVETABLE_ID)!.rows).toEqual([[5]]);
    expect(m.wavetable(BATCHES_WAVETABLE_ID)!.rows).toEqual([[1, 2], [3], [4], [5]]);
    expect(m.wavetable(GRID_WAVETABLE_ID)!.rows[0].slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps voice windows as index ranges: playback picks up the new order', () => {
    const { m, a, b } = model();
    const wa = voiceWindow(m.voice(a.id)!);
    const wb = voiceWindow(m.voice(b.id)!);
    m.moveTable(2, -1); // 2 leaves the window [1, 3], 1 enters it
    expect(voiceWindow(m.voice(a.id)!)).toEqual(wa);
    expect(windowIds(m.wavetable(TIMELINE_WAVETABLE_ID)!, wa)).toEqual([1, 3, 4]);
    expect(m.windowTables(m.voice(a.id)!).map((t) => t.id)).toEqual([1, 3, 4]);
    // Voice on Last batch: same window, same waveforms.
    expect(voiceWindow(m.voice(b.id)!)).toEqual(wb);
    expect(m.windowTables(m.voice(b.id)!).map((t) => t.id)).toEqual([5]);
    // Adding afterwards still follows windows that end at the end.
    m.updateVoice(a.id, { windowEnd: 4 });
    m.addTables([generateBasic('sine', 0)]);
    expect(m.voice(a.id)!.windowEnd).toBe(5);
    expect(timelineRow(m)).toEqual(ids(m));
  });

  it('coalesces consecutive moves of the same waveform into one undo step', () => {
    const { m } = model();
    m.moveTable(3, 1);
    m.moveTable(3, 1);
    m.moveTable(3, -1);
    expect(ids(m)).toEqual([1, 2, 4, 3, 5]);
    expect(m.undoDepth).toBe(1);
    m.undo();
    expect(ids(m)).toEqual([1, 2, 3, 4, 5]);
    expect(timelineRow(m)).toEqual([1, 2, 3, 4, 5]);
    expect(m.selectedId).toBe(3);
    expect(m.undoDepth).toBe(0);
  });

  it('starts a new undo step for another waveform or after another action', () => {
    const { m, a } = model();
    m.moveTable(3, 1); // [1, 2, 4, 3, 5]
    m.moveTable(2, 1); // another waveform: [1, 4, 2, 3, 5]
    expect(m.undoDepth).toBe(2);
    m.moveTable(2, 1); // coalesces with the previous: [1, 4, 3, 2, 5]
    expect(m.undoDepth).toBe(2);
    m.updateVoice(a.id, { level: 0.5 }); // another action (not undoable itself)
    m.moveTable(2, 1); // [1, 4, 3, 5, 2]
    expect(m.undoDepth).toBe(3);
    m.select(1);
    m.select(2);
    m.moveTable(2, -1); // [1, 4, 3, 2, 5]
    expect(m.undoDepth).toBe(4);
    m.undo();
    expect(ids(m)).toEqual([1, 4, 3, 5, 2]);
    m.undo();
    expect(ids(m)).toEqual([1, 4, 3, 2, 5]);
    m.undo();
    expect(ids(m)).toEqual([1, 2, 4, 3, 5]);
    expect(m.selectedId).toBe(3);
    m.undo();
    expect(ids(m)).toEqual([1, 2, 3, 4, 5]);
    expect(timelineRow(m)).toEqual(ids(m));
  });

  it('an add between moves ends the coalescing; undo of the add keeps the moved order', () => {
    const { m } = model();
    m.moveTable(3, 1);
    m.addTables([generateBasic('sine', 0)], false);
    m.moveTable(3, 1);
    expect(ids(m)).toEqual([1, 2, 4, 5, 3, 6]);
    expect(m.undoDepth).toBe(3);
    m.undo();
    m.undo();
    expect(ids(m)).toEqual([1, 2, 4, 3, 5]);
    expect(timelineRow(m)).toEqual(ids(m));
  });

  it('emits timeline + wavetables (and undo); selection only when it changes', () => {
    const { m } = model();
    const seen: string[] = [];
    for (const t of ['timeline', 'wavetables', 'selection', 'undo', 'voices'] as const) m.on(t, () => seen.push(t));
    m.moveTable(3, 1);
    expect(seen).toEqual(['timeline', 'wavetables', 'undo']);
    seen.length = 0;
    m.moveTable(1, 1);
    expect(seen).toEqual(['timeline', 'wavetables', 'undo', 'selection']);
  });

  it('the engine crossfades when a move changes what a voice window holds (no click)', () => {
    // Two waveforms in antiphase: a hard switch would jump by up to twice the amplitude.
    const SR = 48000;
    const sin = new Float32Array(2048).map((_, i) => Math.sin((2 * Math.PI * i) / 2048));
    const neg = sin.map((v) => -v);
    const recipe = generateBasic('sine', 0).recipe;
    const m = new AppModel(64);
    m.addTables([{ data: sin, recipe }, { data: neg, recipe }]);
    const v = m.addVoice({ windowStart: 0, windowEnd: 0, lfoDepth: 0, sustain: 1, attack: 0.001, level: 1 })!;
    const engine = (switchAt: boolean) => {
      const e = new SynthEngine(SR);
      for (const t of m.timeline) e.addTable(t.id, buildMipSet(t.data));
      e.setWavetable(TIMELINE_WAVETABLE_ID, packWavetable(m.wavetable(TIMELINE_WAVETABLE_ID)!));
      e.setVoice(m.voice(v.id)!);
      e.noteOn(1, 110, SR * 10);
      const render = (n: number) => {
        const out = new Float32Array(n);
        for (let i = 0; i < n; i += 128) e.process(out.subarray(i, i + 128), Math.min(128, n - i));
        return out;
      };
      const before = render(4096 + 128);
      if (switchAt) {
        m.moveTable(2, -1);
        // What the bridge sends: the re-ordered Timeline wavetable; the voice is unchanged.
        e.setWavetable(TIMELINE_WAVETABLE_ID, packWavetable(m.wavetable(TIMELINE_WAVETABLE_ID)!));
      }
      return { before, after: render(4096) };
    };
    const ref = engine(false);
    const { before, after } = engine(true);
    expect(m.windowTables(m.voice(v.id)!).map((t) => t.id)).toEqual([2]);
    const maxStep = (x: Float32Array) => x.reduce((mx, s, i) => (i ? Math.max(mx, Math.abs(s - x[i - 1])) : 0), 0);
    const amp = Math.max(...before.map(Math.abs));
    const joined = new Float32Array(before.length + after.length);
    joined.set(before);
    joined.set(after, before.length);
    expect(maxStep(joined)).toBeLessThan(maxStep(before) * 2 + (2 * amp) / 50);
    // It switched (after the ~6 ms crossfade the output is the inverted waveform).
    for (let i = Math.round(0.012 * SR); i < 4096; i += 97) expect(after[i]).toBeCloseTo(-ref.after[i], 4);
  });
});
