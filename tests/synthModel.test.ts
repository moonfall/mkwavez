/** Synth voices in the model (add, osc B following, undo) and in sessions (v3 → v4, round-trip). */
import { describe, expect, it } from 'vitest';
import { defaultSessionState } from '../src/app/defaultSession';
import { AppModel } from '../src/app/model';
import { generateBasic } from '../src/core/generators';
import { decodeSession, encodeMeta, encodeWaveforms, migrateMeta, MIGRATIONS, SESSION_VERSION, type SessionMeta } from '../src/core/session';
import { DEFAULT_SYNTH, EMPTY_MODS, normalizeSynth } from '../src/core/synth';
import { DEFAULT_VOICE } from '../src/core/voice';
import { GRID_WAVETABLE_ID, LAST_BATCH_WAVETABLE_ID, TIMELINE_WAVETABLE_ID } from '../src/core/wavetable';

function model(): AppModel {
  const m = new AppModel(64);
  m.loadState(defaultSessionState());
  return m;
}

describe('Synth voices in the model', () => {
  it('existing voices are Simple; a new Synth voice gets the Init patch with osc B on osc A’s wavetable', () => {
    const m = model();
    expect(m.voices.every((v) => v.type === 'simple')).toBe(true);
    const v = m.addVoice({ type: 'synth', wavetableId: LAST_BATCH_WAVETABLE_ID })!;
    expect(v.type).toBe('synth');
    expect(v.synth.filterMode).toBe(DEFAULT_SYNTH.filterMode);
    expect(v.synth.b.wavetableId).toBe(LAST_BATCH_WAVETABLE_ID);
    expect([v.synth.b.windowStart, v.synth.b.windowEnd]).toEqual([v.windowStart, v.windowEnd]);
    expect(v.sustain).toBe(0.7);
    expect(m.addVoice()!.type).toBe('simple');
  });

  it('osc B follows edits of its wavetable (window grows with Last batch / Timeline adds)', () => {
    const m = model();
    const v = m.addVoice({ type: 'synth' })!;
    m.updateVoice(v.id, { synth: { b: { ...v.synth.b, wavetableId: TIMELINE_WAVETABLE_ID } } });
    const n = m.timeline.length;
    expect(m.voice(v.id)!.synth.b.windowEnd).toBe(n - 1);
    m.addTables([generateBasic('saw', 0), generateBasic('tri', 0)]);
    expect(m.voice(v.id)!.synth.b.windowEnd).toBe(n + 1);
  });

  it('switching osc B’s wavetable selects all of it; its window is clamped and ordered', () => {
    const m = model();
    const v = m.addVoice({ type: 'synth' })!;
    m.updateVoice(v.id, { synth: { b: { ...v.synth.b, wavetableId: GRID_WAVETABLE_ID } } });
    let b = m.voice(v.id)!.synth.b;
    expect([b.windowStart, b.windowEnd, b.windowStartY, b.windowEndY]).toEqual([0, 7, 0, 7]);
    m.updateVoice(v.id, { synth: { b: { ...b, windowStart: 99, windowStartY: 5 } } });
    b = m.voice(v.id)!.synth.b;
    expect([b.windowStart, b.windowEnd, b.windowStartY]).toEqual([7, 7, 5]);
  });

  it('a deleted wavetable moves osc B to the Timeline; undo brings it back', () => {
    const m = model();
    const v = m.addVoice({ type: 'synth' })!;
    const wt = m.createWavetable('2d');
    m.updateVoice(v.id, { synth: { b: { ...v.synth.b, wavetableId: wt.id } } });
    m.endGesture();
    m.deleteWavetable(wt.id);
    expect(m.voice(v.id)!.synth.b.wavetableId).toBe(TIMELINE_WAVETABLE_ID);
    m.undo();
    expect(m.voice(v.id)!.synth.b.wavetableId).toBe(wt.id);
  });

  it('synth edits are undoable (a drag is one step); type switches too; MIDI controller moves are not', () => {
    const m = model();
    const v = m.addVoice({ type: 'synth' })!;
    const d0 = m.undoDepth;
    m.updateVoice(v.id, { synth: { cutoff: 500 } });
    m.updateVoice(v.id, { synth: { cutoff: 700 } });
    m.updateVoice(v.id, { synth: { cutoff: 900 } });
    m.endGesture();
    m.updateVoice(v.id, { attack: 0.5 });
    m.endGesture();
    expect(m.undoDepth).toBe(d0 + 2);
    m.updateVoice(v.id, { synth: { resonance: 0.9 } }, { undo: false });
    expect(m.undoDepth).toBe(d0 + 2);
    m.undo();
    expect(m.voice(v.id)!.attack).toBe(v.attack);
    expect(m.voice(v.id)!.synth.cutoff).toBe(900);
    m.undo();
    expect(m.voice(v.id)!.synth.cutoff).toBe(DEFAULT_SYNTH.cutoff);
    // Type switch on a Simple voice: one step, undo restores Simple (its own params untouched).
    const s = m.voices[0];
    m.updateVoice(s.id, { type: 'synth' });
    m.endGesture();
    expect(m.voice(s.id)!.type).toBe('synth');
    m.undo();
    expect(m.voice(s.id)).toEqual(s);
    // Simple voices' slider moves stay non-undoable (as before).
    const d1 = m.undoDepth;
    m.updateVoice(s.id, { level: 0.1, attack: 0.3 });
    expect(m.undoDepth).toBe(d1);
  });

  it('undo restores only the sound the undone action edited (live CC moves elsewhere survive)', () => {
    const m = model();
    const v = m.addVoice({ type: 'synth' })!;
    const w = m.addVoice({ type: 'synth' })!;
    m.updateVoice(w.id, { synth: { resonance: 0.5 } });
    m.endGesture();
    // Unrelated action, then live (non-undoable) controller moves on both voices.
    m.addTables([generateBasic('saw', 0)]);
    m.updateVoice(v.id, { synth: { cutoff: 333 }, position: 0.9 }, { undo: false });
    m.updateVoice(w.id, { synth: { cutoff: 444 } }, { undo: false });
    m.undo(); // the add
    expect(m.voice(v.id)!.synth.cutoff).toBe(333);
    expect(m.voice(v.id)!.position).toBe(0.9);
    expect(m.voice(w.id)!.synth.cutoff).toBe(444);
    m.undo(); // w's resonance edit: only w's sound goes back
    expect(m.voice(w.id)!.synth.resonance).toBe(DEFAULT_SYNTH.resonance);
    expect(m.voice(v.id)!.synth.cutoff).toBe(333);
  });

  it('mute is not an undo step on a Synth voice', () => {
    const m = model();
    const v = m.addVoice({ type: 'synth' })!;
    const d = m.undoDepth;
    m.updateVoice(v.id, { mute: true });
    expect(m.undoDepth).toBe(d);
  });
});

describe('Synth voices in sessions', () => {
  const recsOf = (m: AppModel) => new Map(encodeWaveforms(m.exportState().timeline).map((r) => [r.id, r]));

  it('a version-3 session migrates to v4: every voice Simple, synth params from the Init patch, osc B on osc A', () => {
    const m = model();
    const st = m.exportState();
    const meta = JSON.parse(JSON.stringify(encodeMeta({ model: st, ui: {} }))) as Record<string, unknown>;
    meta.version = 3;
    meta.voices = (meta.voices as Record<string, unknown>[]).map(({ type: _t, synth: _s, ...v }) => v);
    const up = migrateMeta(meta);
    expect(up.version).toBe(SESSION_VERSION);
    expect((up.voices as Record<string, unknown>[]).every((v) => v.type === 'simple')).toBe(true);
    expect(MIGRATIONS[3]({ ...meta, voices: [null, 4] }).voices).toEqual([null, 4]);
    const out = decodeSession(meta, recsOf(m)).state.model;
    expect(out.voices.map((v) => v.type)).toEqual(['simple', 'simple', 'simple']);
    for (const [i, v] of out.voices.entries()) {
      const { type: _t, synth, ...rest } = v;
      const { type: _t0, synth: _s0, ...rest0 } = st.voices[i];
      expect(rest).toEqual(rest0);
      expect({ ...synth, b: undefined }).toEqual({ ...DEFAULT_SYNTH, mods: EMPTY_MODS, poly: 1, b: undefined });
      expect(synth.b.wavetableId).toBe(v.wavetableId);
      expect([synth.b.windowStart, synth.b.windowEnd, synth.b.position]).toEqual([v.windowStart, v.windowEnd, v.position]);
    }
  });

  it('synth params round-trip; bad values fall back / clamp; unknown fields are kept', () => {
    const m = model();
    const v = m.addVoice({ type: 'synth' })!;
    m.updateVoice(v.id, {
      synth: { cutoff: 432.1, resonance: 0.77, filterMode: 'notch', subWave: 'square', subOct: 2, noiseType: 'pink', pAmount: -7, glide: 0.3, glideLegato: false, bendRange: 7, pan: -0.4, bOct: 2, b: { ...v.synth.b, wavetableId: GRID_WAVETABLE_ID } },
    });
    const st = m.exportState();
    const meta = JSON.parse(JSON.stringify(encodeMeta({ model: st, ui: {} }))) as SessionMeta;
    const out = decodeSession(meta, recsOf(m)).state.model;
    expect(out.voices).toEqual(st.voices);
    // Corrupt values.
    const bad = JSON.parse(JSON.stringify(meta)) as Record<string, unknown>;
    const bv = (bad.voices as Record<string, unknown>[]).at(-1)!;
    bv.type = 'weird';
    bv.synth = { ...(bv.synth as object), cutoff: 1e9, resonance: 'x', filterMode: 'lp48', aOct: 9.4, future: 'kept', b: { wavetableId: 999, position: 7 } };
    const dv = decodeSession(bad, recsOf(m)).state.model.voices.at(-1)!;
    expect(dv.type).toBe('simple');
    expect(dv.synth.cutoff).toBe(20000);
    expect(dv.synth.resonance).toBe(DEFAULT_SYNTH.resonance);
    expect(dv.synth.filterMode).toBe(DEFAULT_SYNTH.filterMode);
    expect(dv.synth.aOct).toBe(3);
    expect((dv.synth as unknown as Record<string, unknown>).future).toBe('kept');
    expect(dv.synth.b.wavetableId).toBe(TIMELINE_WAVETABLE_ID);
    expect(dv.synth.b.position).toBe(1);
  });

  it('normalizeSynth: missing synth → the Init patch with osc B on the given source', () => {
    const src = { ...DEFAULT_SYNTH.b, wavetableId: 2, windowEnd: 3 };
    expect(normalizeSynth(undefined, src)).toEqual({ ...DEFAULT_SYNTH, mods: EMPTY_MODS, poly: 1, b: src });
    expect(normalizeSynth({ ...DEFAULT_VOICE.synth }).cutoff).toBe(DEFAULT_SYNTH.cutoff);
  });
});
