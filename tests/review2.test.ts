/** Fixes from the stage 2–3 review: saved matrices, preset wavetable refs, the unison guard, controller resets. */
import { describe, expect, it } from 'vitest';
import { defaultSessionState } from '../src/app/defaultSession';
import { MidiController } from '../src/app/midi';
import { AppModel } from '../src/app/model';
import { SynthEngine, UNISON_BUDGET } from '../src/core/engine/engine';
import { SynthVoice, type SynthControl } from '../src/core/engine/synthVoice';
import { generateBasic } from '../src/core/generators';
import { MidiRouter, parseMidi, type MidiVoiceEvent } from '../src/core/midi';
import { buildMipSet } from '../src/core/mipmap';
import { DEFAULT_LFO } from '../src/core/modulation';
import { normalizePresets } from '../src/core/presets';
import { decodeSession, encodeMeta, encodeWaveforms, type SessionMeta } from '../src/core/session';
import { DEFAULT_SYNTH, normalizeSynth, type SynthParams } from '../src/core/synth';
import { DEFAULT_VOICE, type VoicePatch, type VoiceParams } from '../src/core/voice';
import { LAST_BATCH_WAVETABLE_ID } from '../src/core/wavetable';
import { packIds } from '../src/core/wavetablePlayback';

const SR = 48000;

function model(): AppModel {
  const m = new AppModel(64);
  m.loadState(defaultSessionState());
  return m;
}

describe('1: saved Synth voices without a matrix', () => {
  it('load with every slot empty (they keep sounding as saved, no LFO sweep)', () => {
    const m = model();
    const v = m.addVoice({ type: 'synth' })!;
    expect(v.synth.mods[0].src).toBe('lfo1'); // a new voice gets the default route
    const st = m.exportState();
    const meta = JSON.parse(JSON.stringify(encodeMeta({ model: st, ui: {} }))) as SessionMeta;
    const raw = (meta.voices as unknown as { synth: Record<string, unknown> }[]).at(-1)!;
    delete raw.synth.mods;
    delete raw.synth.lfos;
    const out = decodeSession(meta, new Map(encodeWaveforms(st.timeline).map((r) => [r.id, r]))).state.model.voices.at(-1)!;
    expect(out.synth.mods.every((s) => s.src === 'none' && s.amt === 0)).toBe(true);
  });
});

describe('2: preset wavetable references', () => {
  it('a user wavetable is found by name + shape; a colliding id with another name is not used', () => {
    const m = model();
    const pad = m.createWavetable('2d');
    m.renameWavetable(pad.id, 'My pad');
    const v = m.addVoice({ type: 'synth', wavetableId: pad.id })!;
    const p = m.savePreset(v.id, 'On my pad')!;
    expect(p.sound.aRef).toEqual({ name: 'My pad', shape: '2d' });
    // Another session: same id, different wavetable; "My pad" exists under another id.
    const m2 = model();
    const other = m2.createWavetable('1d');
    m2.renameWavetable(other.id, 'Other');
    expect(other.id).toBe(pad.id);
    const mine = m2.createWavetable('2d');
    m2.renameWavetable(mine.id, 'My pad');
    const t = m2.voices[0];
    m2.applyPreset(t.id, p.sound, p.name);
    expect(m2.voice(t.id)!.wavetableId).toBe(mine.id);
  });

  it('missing → Last batch with a notice, one undo step; factory presets use built-ins by kind', () => {
    const m = model();
    const [p] = normalizePresets([{ id: 'x', name: 'Lost', sound: { a: { wavetableId: 99 }, aRef: { name: 'Gone', shape: '1d' }, synth: { b: { wavetableId: 98 } }, bRef: { name: 'Gone too', shape: '2d' } } }]);
    const t = m.voices[1];
    const d = m.undoDepth;
    m.applyPreset(t.id, p.sound, p.name);
    const out = m.voice(t.id)!;
    expect([out.wavetableId, out.synth.b.wavetableId]).toEqual([LAST_BATCH_WAVETABLE_ID, LAST_BATCH_WAVETABLE_ID]);
    expect(out.type).toBe('synth');
    expect(m.notice).toMatch(/Lost: wavetable not in this session for osc A \(“Gone”\) and osc B \(“Gone too”\)/);
    expect(m.undoDepth).toBe(d + 1);
    expect(m.presetsMissingWavetables([p])).toBe(1);
  });

  it('updateVoice with a wavetable that does not exist makes no undo step', () => {
    const m = model();
    const v = m.addVoice({ type: 'synth' })!;
    const d = m.undoDepth;
    m.updateVoice(v.id, { wavetableId: 999 });
    expect(m.undoDepth).toBe(d);
    expect(m.voice(v.id)!.wavetableId).toBe(v.wavetableId);
  });
});

// ---- 3: unison guard and copies ----

function engine(): SynthEngine {
  const e = new SynthEngine(SR);
  (['sine', 'saw', 'square', 'tri'] as const).forEach((w, i) => e.addTable(i + 1, buildMipSet(generateBasic(w, 0).data)));
  e.setWavetable(0, packIds([1, 2, 3, 4]));
  return e;
}
const sv = (id: number, synth: Partial<SynthParams>): VoiceParams => ({
  ...DEFAULT_VOICE,
  id,
  name: `V${id}`,
  type: 'synth',
  windowStart: 1,
  windowEnd: 1,
  sustain: 1,
  synth: normalizeSynth({ ...DEFAULT_SYNTH, mods: [], cutoff: 20000, envAmount: 0, resonance: 0, ...synth, b: { ...DEFAULT_SYNTH.b, windowStart: 1, windowEnd: 1 } }),
});
function render(e: SynthEngine, n: number): [Float32Array, Float32Array] {
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i += 128) e.process(L.subarray(i, i + 128), Math.min(128, n - i), R.subarray(i, i + 128));
  return [L, R];
}
const maxStep = (...xs: Float32Array[]) => {
  let m = 0;
  for (const x of xs) for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
};
const joined = (a: Float32Array, b: Float32Array) => {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

describe('3: unison copies fade, copy 0 stays put, the guard has hysteresis', () => {
  it('changing the unison count mid-note (and turning spread on) is click-free', () => {
    const e = engine();
    const v = sv(1, { aUnison: 1, aDetune: 30, aSpread: 0 });
    e.setVoice(v);
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 45, velocity: 127 });
    const [l0, r0] = render(e, SR / 8);
    const base = maxStep(l0, r0);
    e.setVoice({ ...v, synth: { ...v.synth, aUnison: 4, aSpread: 1 } });
    const [l1, r1] = render(e, SR / 8);
    e.setVoice({ ...v, synth: { ...v.synth, aUnison: 1, aSpread: 1 } });
    const [l2, r2] = render(e, SR / 8);
    expect(maxStep(joined(joined(l0, l1), l2), joined(joined(r0, r1), r2))).toBeLessThan(base * 2.5);
  });

  it('unison is symmetric around the centre pitch and pan for every count; copies glide to new places', () => {
    const c: SynthControl = { bend: 0, blockLen: 64, tables: new Map(), wtA: undefined, wtB: undefined, slew: 0.1, glideCoef: () => 1, gainTarget: 1, bpm: 120, wheel: 0, pressure: 0, unisonScale: 1, beat: -1 };
    const s = new SynthVoice(SR, 1, 64);
    const priv = s as unknown as { ratA: Float64Array; gAL: Float64Array; gAR: Float64Array };
    let prev = 1;
    for (const n of [1, 2, 3, 4, 2]) {
      const p = sv(1, { aUnison: n, aDetune: 40, aSpread: 1 });
      s.control(p, c);
      // The first block after a count change moves a copy only a little (a glide, not a jump).
      expect(Math.abs(1200 * Math.log2(priv.ratA[0] / prev))).toBeLessThan(15);
      for (let k = 0; k < 300; k++) s.control(p, c);
      prev = priv.ratA[0];
      let cents = 0;
      let left = 0;
      let right = 0;
      for (let i = 0; i < n; i++) {
        cents += 1200 * Math.log2(priv.ratA[i]);
        left += priv.gAL[i];
        right += priv.gAR[i];
      }
      expect(Math.abs(cents / n)).toBeLessThan(0.01);
      expect(left).toBeCloseTo(right, 4);
    }
  });

  it('the guard counts held notes only and has hysteresis', () => {
    const e = engine();
    const per = 8; // 4 + 4 copies
    const n = Math.floor(UNISON_BUDGET / per) + 1;
    for (let id = 1; id <= n; id++) {
      e.setVoice(sv(id, { aUnison: 4, bUnison: 4, bLevel: 0.3 }));
      e.applyMidi({ type: 'noteOn', voiceId: id, note: 40 + id, velocity: 100 });
    }
    const lim = () => {
      render(e, 256);
      return e.status({ tick: -1, playing: false, voices: [] }).unisonLimited;
    };
    expect(lim()).toBe(true);
    // One note off: just under the budget, still limited (hysteresis) — its release tail doesn't count.
    e.applyMidi({ type: 'noteOff', voiceId: 1, note: 41 });
    expect(n * per - per).toBeGreaterThan(UNISON_BUDGET * 0.75);
    expect(lim()).toBe(true);
    // Down to 3/4 of the budget: off.
    for (let id = 2; id <= n && (n - id + 1) * per > UNISON_BUDGET * 0.75; id++) e.applyMidi({ type: 'noteOff', voiceId: id, note: 40 + id });
    expect(lim()).toBe(false);
  });
});

describe('4: mod wheel / pressure resets', () => {
  const routing = (sel: number) => ({ omni: true, selectedVoice: sel, voiceIds: [1, 2, 3] });

  it('CC 121, routing changes and a lost input reset them like the bend', () => {
    const r = new MidiRouter();
    r.route(parseMidi([0xb0, 1, 127])!, routing(1));
    r.route(parseMidi([0xd0, 64])!, routing(1));
    expect(r.retarget(routing(2))).toEqual([
      { type: 'mod', voiceId: 1, value: 0 },
      { type: 'mod', voiceId: 2, value: 1 },
      { type: 'pressure', voiceId: 1, value: 0 },
      { type: 'pressure', voiceId: 2, value: 64 / 127 },
    ]);
    expect(r.route(parseMidi([0xb0, 121, 0])!, routing(2))).toEqual([
      { type: 'mod', voiceId: 2, value: 0 },
      { type: 'pressure', voiceId: 2, value: 0 },
    ]);
    r.route(parseMidi([0xb0, 1, 100])!, routing(2));
    expect(r.releaseAll()).toEqual([{ type: 'mod', voiceId: 2, value: 0 }]);
    r.route(parseMidi([0xd0, 30])!, routing(3), 4);
    expect(r.releaseSource(4)).toEqual([{ type: 'pressure', voiceId: 3, value: 0 }]);
  });

  it('on a Synth voice CC 1 is the mod wheel only (it does not also move Position X)', () => {
    const m = model();
    const sent: MidiVoiceEvent[] = [];
    const patches: [number, VoicePatch][] = [];
    const c = new MidiController(m, { notes: (e) => void sent.push(...e), params: (id, p) => void patches.push([id, p]) }, () => 1, undefined, (fn) => fn());
    c.handle([0xb0, 1, 127]);
    expect(patches).toEqual([[1, { position: 1 }]]); // Simple voice: as before
    m.updateVoice(1, { type: 'synth' });
    patches.length = 0;
    sent.length = 0;
    c.handle([0xb0, 1, 0]);
    expect(patches).toEqual([]);
    expect(sent).toEqual([{ type: 'mod', voiceId: 1, value: 0 }]);
  });
});

describe('5–7', () => {
  it('a tempo-synced free-running LFO glides into lock with the transport (no jump at Play); rate modulation scales it', () => {
    const c: SynthControl = { bend: 0, blockLen: 64, tables: new Map(), wtA: undefined, wtB: undefined, slew: 0.1, glideCoef: () => 1, gainTarget: 1, bpm: 120, wheel: 0, pressure: 0, unisonScale: 1, beat: 0 };
    const p = sv(1, { lfos: [{ ...DEFAULT_LFO, sync: true, div: '1/4', phase: 0.25 }, DEFAULT_LFO, DEFAULT_LFO] });
    const s = new SynthVoice(SR, 1, 64);
    const inc = (2 * 64) / SR; // one cycle per beat at 120 BPM
    const dBeat = (2 * 64) / SR;
    let beat = 6.4; // Play pressed with the LFO elsewhere: it doesn't jump there
    let last = s.lfoPhase[0];
    for (let k = 0; k < 2000; k++) {
      s.control(p, { ...c, beat });
      beat += dBeat;
      let step = s.lfoPhase[0] - last;
      step -= Math.floor(step);
      expect(step).toBeLessThan(inc * 1.5 + 1e-12);
      last = s.lfoPhase[0];
    }
    const want = beat - dBeat + 0.25;
    let d = s.lfoPhase[0] - (want - Math.floor(want));
    d -= Math.round(d);
    expect(Math.abs(d)).toBeLessThan(1e-6);
    // Rate modulation (velocity → LFO 1 rate, ×2): runs at twice the speed while it lasts.
    const q = sv(1, { lfos: p.synth.lfos, mods: [{ src: 'vel', dst: 'lfo1Rate', amt: 0.25 }] });
    s.control(q, { ...c, beat });
    const a = s.lfoPhase[0];
    s.control(q, { ...c, beat: beat + dBeat });
    let step = s.lfoPhase[0] - a;
    step -= Math.floor(step);
    expect(step).toBeCloseTo(2 * inc, 9);
  });


  it('hard sync with unison and FM stays finite and bounded', () => {
    const e = engine();
    e.setVoice(sv(1, { sync: true, aCoarse: 7, aUnison: 3, bUnison: 2, fm: 0.6, width: 2, aSpread: 1, sat: 1 }));
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 100, velocity: 127 });
    const [L, R] = render(e, SR / 4);
    for (let i = 0; i < L.length; i++) expect(Number.isFinite(L[i]) && Math.abs(L[i]) <= 0.45 && Math.abs(R[i]) <= 0.45).toBe(true);
  });
});

describe('follow-up 2', () => {
  it('back to one unison copy: the centre phase locks to the audible copy (Step switches on its cycle start)', () => {
    const e = new SynthEngine(SR);
    (['sine', 'saw', 'square', 'tri'] as const).forEach((w, i) => e.addTable(i + 1, buildMipSet(generateBasic(w, 0).data)));
    e.setWavetable(0, packIds([1, 2, 3, 4], 'step'));
    const v = sv(1, { aUnison: 4, aDetune: 30, bUnison: 3, bLevel: 0.5 });
    e.setVoice(v);
    e.applyMidi({ type: 'noteOn', voiceId: 1, note: 50, velocity: 127 });
    render(e, SR / 4);
    e.setVoice({ ...v, synth: { ...v.synth, aUnison: 1, bUnison: 1 } });
    render(e, SR / 4);
    const syn = (e as unknown as { voices: { syn: { phA: Float64Array; phB: Float64Array; phCA: number; phCB: number; uA: number; uB: number } }[] }).voices[0].syn;
    expect([syn.uA, syn.uB]).toEqual([1, 1]);
    // Locked at every block start, so at most a block's drift apart while the place glides home.
    expect(Math.abs(syn.phCA - syn.phA[0])).toBeLessThan(1e-3);
    expect(Math.abs(syn.phCB - syn.phB[0])).toBeLessThan(1e-3);
    render(e, SR / 2);
    expect(Math.abs(syn.phCA - syn.phA[0])).toBeLessThan(1e-9);
  });

  it('an LFO steered back across 0 does not start a new S&H cycle', () => {
    const c: SynthControl = { bend: 0, blockLen: 64, tables: new Map(), wtA: undefined, wtB: undefined, slew: 0.1, glideCoef: () => 1, gainTarget: 1, bpm: 120, wheel: 0, pressure: 0, unisonScale: 1, beat: 0 };
    const p = sv(1, { lfos: [{ ...DEFAULT_LFO, shape: 'sh', sync: true, div: '1/4' }, DEFAULT_LFO, DEFAULT_LFO] });
    const s = new SynthVoice(SR, 1, 64);
    // Locked phase just behind the LFO's: it is steered back; values only change on forward wraps.
    let beat = 0.999;
    let wraps = 0;
    let last = s.lfoPhase[0];
    const seen = new Set<number>();
    for (let k = 0; k < 4000; k++) {
      s.control(p, { ...c, beat });
      beat += (2 * 64) / SR;
      if (s.lfoPhase[0] < last - 0.5) wraps++;
      last = s.lfoPhase[0];
      seen.add(s.lfoOut[0]);
    }
    expect(seen.size).toBeLessThanOrEqual(wraps + 1);
  });
});
