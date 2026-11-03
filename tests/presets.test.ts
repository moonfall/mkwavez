import { describe, expect, it } from 'vitest';
import { defaultSessionState } from '../src/app/defaultSession';
import { AppModel } from '../src/app/model';
import { SynthEngine } from '../src/core/engine/engine';
import { buildMipSet } from '../src/core/mipmap';
import { FACTORY_PRESETS, MAX_USER_PRESETS, normalizePresets, parsePresetsFile, presetsFile } from '../src/core/presets';
import { decodeSession, encodeMeta, encodeWaveforms, type SessionMeta } from '../src/core/session';
import { GRID_WAVETABLE_ID } from '../src/core/wavetable';
import { packWavetable } from '../src/core/wavetablePlayback';

function model(): AppModel {
  const m = new AppModel(64);
  m.loadState(defaultSessionState());
  return m;
}

describe('factory presets', () => {
  it('Init plus six; each applies (one undo step), plays the built-in wavetables, and renders finite, audible output', () => {
    expect(FACTORY_PRESETS.map((p) => p.name)).toEqual(['Init', 'Sub bass', 'Pluck', 'Evolving pad', 'Sync lead', 'Brass', 'Noise sweep']);
    for (const p of FACTORY_PRESETS) {
      const m = model();
      const v = m.voices[0];
      const d = m.undoDepth;
      m.applyPreset(v.id, p.sound);
      const out = m.voice(v.id)!;
      expect(out.type).toBe('synth');
      expect(m.undoDepth).toBe(d + 1);
      expect(m.wavetable(out.wavetableId)?.builtin).toBeTruthy();
      expect(m.wavetable(out.synth.b.wavetableId)?.builtin).toBeTruthy();
      // Windows are clamped to the wavetable: the whole of it.
      const wt = m.wavetable(out.wavetableId)!;
      if (wt.shape === '1d') expect(out.windowEnd).toBe(wt.rows[0].length - 1);
      if (out.wavetableId === GRID_WAVETABLE_ID) expect([out.windowEnd, out.windowEndY]).toEqual([7, 7]);
      // Render it.
      const e = new SynthEngine(48000);
      for (const t of m.timeline) e.addTable(t.id, buildMipSet(t.data));
      for (const w of m.wavetables) e.setWavetable(w.id, packWavetable(w));
      e.setVoice({ ...out, mute: false });
      e.applyMidi({ type: 'noteOn', voiceId: out.id, note: 57, velocity: 110 });
      const L = new Float32Array(24000);
      const R = new Float32Array(24000);
      for (let i = 0; i < L.length; i += 128) e.process(L.subarray(i, i + 128), 128, R.subarray(i, i + 128));
      let s = 0;
      for (let i = 0; i < L.length; i++) {
        expect(Number.isFinite(L[i]) && Number.isFinite(R[i])).toBe(true);
        s += L[i] * L[i] + R[i] * R[i];
      }
      expect(Math.sqrt(s / L.length)).toBeGreaterThan(0.003);
      m.undo();
      expect(m.voice(v.id)!.type).toBe('simple');
    }
  });
});

describe('user presets', () => {
  it('save / delete; names unique; ids never clash', () => {
    const m = model();
    const v = m.addVoice({ type: 'synth' })!;
    m.updateVoice(v.id, { synth: { cutoff: 777 } });
    const a = m.savePreset(v.id, '  Fat  ')!;
    const b = m.savePreset(v.id, 'Fat')!;
    expect([a.name, b.name]).toEqual(['Fat', 'Fat 2']);
    expect(a.id).not.toBe(b.id);
    expect(a.sound.synth.cutoff).toBe(777);
    m.deletePreset(a.id);
    expect(m.voicePresets.map((p) => p.name)).toEqual(['Fat 2']);
    const c = m.savePreset(v.id, 'x')!;
    expect(c.id).not.toBe(b.id);
    // Apply onto another voice.
    m.applyPreset(m.voices[0].id, b.sound);
    expect(m.voices[0].synth.cutoff).toBe(777);
  });

  it('round-trip in the session, and through the export file', () => {
    const m = model();
    const v = m.addVoice({ type: 'synth' })!;
    m.updateVoice(v.id, { synth: { resonance: 0.66, aUnison: 3 } });
    m.savePreset(v.id, 'Mine');
    const st = m.exportState();
    const meta = JSON.parse(JSON.stringify(encodeMeta({ model: st, ui: {} }))) as SessionMeta;
    const out = decodeSession(meta, new Map(encodeWaveforms(st.timeline).map((r) => [r.id, r]))).state.model;
    expect(out.voicePresets).toEqual(st.voicePresets);
    // A session without presets (older save) decodes to none.
    const { voicePresets: _p, ...old } = meta;
    expect(decodeSession(old, new Map(encodeWaveforms(st.timeline).map((r) => [r.id, r]))).state.model.voicePresets).toEqual([]);
    // Export file.
    const back = parsePresetsFile(presetsFile(m.voicePresets));
    expect(back).toEqual(m.voicePresets);
    const m2 = model();
    m2.savePreset(m2.voices[0].id, 'Mine');
    expect(m2.importPresets(back)).toBe(1);
    expect(m2.voicePresets.map((p) => p.name)).toEqual(['Mine', 'Mine 2']);
    expect(() => parsePresetsFile('{"format":"other"}')).toThrow();
    expect(() => parsePresetsFile('nope')).toThrow();
  });

  it('untrusted preset lists: bad entries dropped, values clamped, capped', () => {
    const list = normalizePresets([
      { id: 'a', name: 'ok', sound: { synth: { cutoff: -5 }, attack: 99, a: { wavetableId: 'x' } } },
      { id: 'a', name: 'dup', sound: {} },
      { name: 'no id' },
      7,
      ...Array.from({ length: 200 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, sound: {} })),
    ]);
    expect(list.length).toBe(MAX_USER_PRESETS);
    expect(list[0].sound.synth.cutoff).toBe(20);
    expect(list[0].sound.attack).toBe(10);
    expect(list[0].sound.a.wavetableId).toBe(1);
  });

  it('paste copies another voice’s settings (not its id, name or mute); undoable on a Synth voice', () => {
    const m = model();
    const src = m.addVoice({ type: 'synth' })!;
    m.updateVoice(src.id, { synth: { cutoff: 1234, pan: 0.5 }, mute: true });
    const dst = m.addVoice({ type: 'synth' })!;
    m.pasteVoice(dst.id, m.voice(src.id)!);
    const out = m.voice(dst.id)!;
    expect(out.synth.cutoff).toBe(1234);
    expect([out.id, out.name, out.mute]).toEqual([dst.id, dst.name, false]);
    m.undo();
    expect(m.voice(dst.id)!.synth.cutoff).toBe(dst.synth.cutoff);
  });
});
