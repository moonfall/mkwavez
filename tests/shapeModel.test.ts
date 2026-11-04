import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { defaultSessionState } from '../src/app/defaultSession';
import { AppModel } from '../src/app/model';
import { basicWave } from '../src/core/generators';
import { harmonicMagnitudes } from '../src/core/fft';
import { shapeFrom } from '../src/core/shape';
import { decodeSession, encodeMeta, encodeWaveforms, type SessionMeta } from '../src/core/session';
import { applyChain, normalizeChain, chainJson } from '../src/core/shapeChain';
import { chainsFile, DEFAULT_CHAIN, FACTORY_CHAINS, MAX_SAVED_CHAINS, normalizeSavedChains, parseChainsFile } from '../src/core/shapeFactory';
import { newStep } from '../src/core/shapeSteps';
import { PREVIEW_BATCH_WAVETABLE_ID, PREVIEW_ID_BASE, PREVIEW_WAVETABLE_ID, SELECTION_WAVETABLE_ID } from '../src/core/wavetable';

const model = () => {
  const m = new AppModel();
  m.loadState(defaultSessionState());
  return m;
};
const peak = (x: ArrayLike<number>) => Array.from(x).reduce((a, v) => Math.max(a, Math.abs(v)), 0);

describe('Shape chain in the model', () => {
  it('edits are undo steps; a gesture is one; undo restores the chain', () => {
    const m = model();
    expect(m.shapeChain).toEqual(DEFAULT_CHAIN);
    const d0 = m.undoDepth;
    const c = m.shapeChain;
    m.setShapeChain({ ...c, steps: c.steps.map((s, i) => (i === 0 ? { ...s, amount: 0.5 } : s)) }, 'amount:x');
    m.setShapeChain({ ...m.shapeChain, steps: m.shapeChain.steps.map((s, i) => (i === 0 ? { ...s, amount: 0.4 } : s)) }, 'amount:x');
    expect(m.undoDepth).toBe(d0 + 1);
    m.setShapeChain(m.shapeChain); // no change: no step
    expect(m.undoDepth).toBe(d0 + 1);
    m.setShapeChain({ ...m.shapeChain, name: 'Mine' });
    expect(m.undoDepth).toBe(d0 + 2);
    m.undo();
    expect(m.shapeChain.steps[0].amount).toBe(0.4);
    m.undo();
    expect(m.shapeChain).toEqual(DEFAULT_CHAIN);
  });

  it('save / overwrite / delete / import; names unique; the list is capped', () => {
    // Every id below is minted in the same millisecond (as on a fast CI runner): the counter
    // alone must keep them apart.
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const m = model();
    const a = m.saveShapeChain('  Warm  ')!;
    expect(a.chain.name).toBe('Warm');
    expect(m.shapeChain.name).toBe('Warm');
    m.setShapeChain({ ...m.shapeChain, steps: [newStep('invert', 'i')] });
    const b = m.saveShapeChain('Warm')!;
    expect(b.id).toBe(a.id);
    expect(m.shapeChains.length).toBe(1);
    expect(m.shapeChains[0].chain.steps.map((s) => s.op)).toEqual(['invert']);
    expect(m.saveShapeChain('   ')).toBeNull();
    expect(m.importShapeChains([m.shapeChain, m.shapeChain])).toBe(2);
    expect(m.shapeChains.map((c) => c.chain.name)).toEqual(['Warm', 'Warm 2', 'Warm 3']);
    expect(new Set(m.shapeChains.map((c) => c.id)).size).toBe(3);
    const gone = m.shapeChains[2].id;
    m.deleteShapeChain(m.shapeChains[1].id);
    expect(m.shapeChains.map((c) => c.chain.name)).toEqual(['Warm', 'Warm 3']);
    // A deleted chain's id is never handed out again (a Shape chip may still point at it).
    m.deleteShapeChain(gone);
    const again = m.saveShapeChain('Fresh')!;
    expect(again.id).not.toBe(gone);
    expect([a.id, gone]).not.toContain(again.id);
    expect(normalizeSavedChains(m.shapeChains).map((c) => c.id)).toEqual(m.shapeChains.map((c) => c.id));
    expect(m.importShapeChains(Array.from({ length: 100 }, () => DEFAULT_CHAIN))).toBe(MAX_SAVED_CHAINS - 2);
    const long = 'x'.repeat(60);
    const n2 = model();
    n2.importShapeChains([{ ...DEFAULT_CHAIN, name: long }, { ...DEFAULT_CHAIN, name: long }]);
    expect(n2.shapeChains.map((c) => c.chain.name)).toEqual([long, `${'x'.repeat(58)} 2`]);
    expect(m.saveShapeChain('One more')).toBeNull();
  });

  it('round-trips in the session; older sessions get the default chain and none saved', () => {
    const m = model();
    m.setShapeChain({ ...m.shapeChain, name: 'Edited', varySeed: true });
    m.saveShapeChain('Edited');
    m.saveShapeChain('Other');
    const st = m.exportState();
    const meta = JSON.parse(JSON.stringify(encodeMeta({ model: st, ui: {} }))) as SessionMeta;
    const recs = new Map(encodeWaveforms(st.timeline).map((r) => [r.id, r]));
    const out = decodeSession(meta, recs).state.model;
    expect(out.shapeChain).toEqual(m.shapeChain);
    expect(out.shapeChains).toEqual(m.shapeChains);
    const { shapeChain: _c, shapeChains: _s, ...old } = meta;
    const prev = decodeSession(old, recs).state.model;
    expect(prev.shapeChain).toEqual(DEFAULT_CHAIN);
    expect(prev.shapeChains).toEqual([]);
    const m2 = model();
    m2.loadState(out);
    expect(chainJson(m2.shapeChain)).toBe(chainJson(m.shapeChain));
    expect(m2.shapeChains.length).toBe(2);
  });

  it('export file round-trip; bad files throw; saved lists are repaired', () => {
    const list = FACTORY_CHAINS.map((f) => f.chain);
    expect(parseChainsFile(chainsFile(list))).toEqual(list);
    expect(() => parseChainsFile('{"format":"other"}')).toThrow();
    expect(() => parseChainsFile('nope')).toThrow();
    const fixed = normalizeSavedChains([{ id: 'chain-1', chain: DEFAULT_CHAIN }, { id: 'chain-1', chain: DEFAULT_CHAIN }, { id: 'evil!', chain: {} }, { id: 'chain-9' }, 7]);
    expect(fixed.map((c) => c.id)).toEqual(['chain-1', 'chain-2', 'chain-3']);
    expect(fixed.map((c) => c.chain.name)).toEqual([DEFAULT_CHAIN.name, `${DEFAULT_CHAIN.name} 2`, 'Untitled chain']);
  });
});

describe('write back into a wavetable', () => {
  it('addReplacing puts each result in its slot, one undo step; refused for built-ins and Live wavetables', () => {
    const m = model();
    const w = m.createWavetable('1d');
    const ids = m.timeline.slice(0, 3).map((t) => t.id);
    ids.forEach((id, i) => m.placeInWavetable(w.id, { kind: 'gap', x: i, y: 0 }, id));
    const gen = ids.map((id) => ({ data: m.table(id)!.data, recipe: { op: 'shape', params: {}, seed: 1, parents: [id] } }));
    const cells = ids.map((_, x) => ({ x, y: 0 }));
    const d0 = m.undoDepth;
    const n0 = m.timeline.length;
    const added = m.addReplacing(gen, w.id, cells);
    expect(added.length).toBe(3);
    expect(m.timeline.length).toBe(n0 + 3);
    expect(m.wavetable(w.id)!.rows[0]).toEqual(added.map((t) => t.id));
    expect(m.undoDepth).toBe(d0 + 1);
    m.undo();
    expect(m.wavetable(w.id)!.rows[0]).toEqual(ids);
    expect(m.timeline.length).toBe(n0);
    expect(m.addReplacing(gen, 1, cells)).toEqual([]); // Last batch: built-in
    m.setWavetableLive(w.id, true);
    expect(m.addReplacing(gen, w.id, cells)).toEqual([]);
    expect(m.addReplacing(gen.slice(1), w.id, cells)).toEqual([]);
  });
});

describe('Shape chain engine (review fixes)', () => {
  it('a Mutation step keeps the chain’s phase (a Rotate before it stays)', () => {
    const sine = basicWave('sine', 0);
    const rot = normalizeChain({ realign: false, steps: [{ op: 'rotate', id: 'r', value: 0.25 }] });
    const both = normalizeChain({ realign: false, steps: [{ op: 'rotate', id: 'r', value: 0.25 }, { op: 'mutation', id: 'm', mutation: 'smooth', amount: 0.01 }] });
    const a = applyChain(sine, rot);
    const b = applyChain(sine, both);
    let d = 0;
    for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
    expect(d).toBeLessThan(1e-3);
    expect(peak(b)).toBeCloseTo(1, 9);
  });
});

describe('Selection wavetable', () => {
  it('holds the Timeline selection, follows select / add / undo, and a voice can play it', () => {
    const m = model();
    const sel = () => m.wavetable(SELECTION_WAVETABLE_ID)!.rows;
    expect(sel()).toEqual([[m.selectedId]]);
    m.select(m.timeline[1].id);
    expect(sel()).toEqual([[m.timeline[1].id]]);
    const [t] = m.addTables([{ data: m.timeline[0].data, recipe: m.timeline[0].recipe }]);
    expect(sel()).toEqual([[t.id]]);
    m.undo();
    expect(sel()).toEqual([[m.selectedId]]);
    const v = m.voices[0];
    m.updateVoice(v.id, { wavetableId: SELECTION_WAVETABLE_ID });
    expect(m.windowTables(m.voice(v.id)!).map((x) => x.id)).toEqual([m.selectedId]);
  });
});

describe('Preview wavetable', () => {
  it('holds the shown preview waveform; unchanged data keeps its id; survives undo; a voice can play it', () => {
    const m = model();
    const a = new Float32Array(2048).fill(0.1);
    const b = new Float32Array(2048).fill(0.2);
    let n = 0;
    m.on('preview', () => n++);
    m.setPreview([a, b], 1);
    const ids = m.previewTables.map((t) => t.id);
    expect(ids.every((id) => id >= PREVIEW_ID_BASE)).toBe(true);
    expect(m.wavetable(PREVIEW_WAVETABLE_ID)!.rows).toEqual([[ids[1]]]);
    expect(m.table(ids[1])!.data).toBe(b);
    m.setPreview([a, b], 1); // same: no event
    expect(n).toBe(1);
    const c = new Float32Array(2048).fill(0.3);
    m.setPreview([a, c], 0);
    expect(m.previewTables[0].id).toBe(ids[0]); // unchanged data, same table
    expect(m.previewTables[1].id).not.toBe(ids[1]);
    expect(m.wavetable(PREVIEW_WAVETABLE_ID)!.rows).toEqual([[ids[0]]]);
    // Undo restores a stale wavetable list; the derived built-in follows the preview again.
    m.addTables([{ data: m.timeline[0].data, recipe: m.timeline[0].recipe }]);
    m.setPreview([c], 0);
    m.undo();
    expect(m.wavetable(PREVIEW_WAVETABLE_ID)!.rows).toEqual([[m.previewTables[0].id]]);
    const v = m.voices[0];
    m.updateVoice(v.id, { wavetableId: PREVIEW_WAVETABLE_ID });
    expect(m.windowTables(m.voice(v.id)!).map((t) => t.data)).toEqual([c]);
    // Never saved: a restore drops the preview slot.
    const st = m.exportState();
    expect(st.timeline.some((t) => t.id >= PREVIEW_ID_BASE)).toBe(false);
  });
});

describe('Preview batch wavetable', () => {
  it('holds the whole preview batch; a voice covering it all follows its size, a partial window is clamped', () => {
    const m = model();
    const mk = (v: number) => new Float32Array(2048).fill(v);
    const four = [mk(0.1), mk(0.2), mk(0.3), mk(0.4)];
    m.setPreview(four, 0);
    expect(m.wavetable(PREVIEW_BATCH_WAVETABLE_ID)!.rows).toEqual([m.previewTables.map((t) => t.id)]);
    const [a, b] = m.voices;
    m.updateVoice(a.id, { wavetableId: PREVIEW_BATCH_WAVETABLE_ID });
    m.updateVoice(b.id, { wavetableId: PREVIEW_BATCH_WAVETABLE_ID, windowStart: 1, windowEnd: 2 });
    expect([m.voice(a.id)!.windowStart, m.voice(a.id)!.windowEnd]).toEqual([0, 3]);
    let voicesEvents = 0;
    m.on('voices', () => voicesEvents++);
    m.setPreview([...four, mk(0.5), mk(0.6)], 5);
    expect([m.voice(a.id)!.windowStart, m.voice(a.id)!.windowEnd]).toEqual([0, 5]); // whole → whole
    expect([m.voice(b.id)!.windowStart, m.voice(b.id)!.windowEnd]).toEqual([1, 2]); // partial stays
    expect(voicesEvents).toBe(1);
    m.setPreview(four.slice(0, 2), 0);
    expect([m.voice(a.id)!.windowStart, m.voice(a.id)!.windowEnd]).toEqual([0, 1]);
    expect([m.voice(b.id)!.windowStart, m.voice(b.id)!.windowEnd]).toEqual([1, 1]); // clamped
    expect(m.windowTables(m.voice(a.id)!).map((t) => t.data)).toEqual(four.slice(0, 2));
  });
});

describe('factory chains', () => {
  const N = 8;
  const saw = basicWave('saw', 0);
  const sine = basicWave('sine', 0);
  const cheby = shapeFrom((i) => Math.cos(3 * Math.acos(0.95 * Math.sin((2 * Math.PI * i) / 2048))));
  const centroid = (x: Float32Array) => {
    const m = harmonicMagnitudes(x, 72);
    let a = 0;
    let b = 0;
    for (let k = 1; k <= 72; k++) {
      a += k * m[k] ** 2;
      b += m[k] ** 2;
    }
    return a / b;
  };
  const batch = (id: string, src: Float32Array) => {
    const c = FACTORY_CHAINS.find((f) => f.id === id)!.chain;
    return Array.from({ length: N }, (_, i) => applyChain(src, c, { index: i, count: N }));
  };
  const maxDiff = (a: Float32Array, b: Float32Array) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

  it('every factory chain gives finite, normalised waveforms on a saw, a sine and a rich wave', () => {
    for (const f of FACTORY_CHAINS)
      for (const src of [saw, sine, cheby])
        for (const t of batch(f.id, src)) {
          expect(t.every(Number.isFinite), f.id).toBe(true);
          expect(peak(t), f.id).toBeCloseTo(1, 6);
        }
  });

  it('Low-pass opening brightens steadily across the batch', () => {
    for (const src of [saw, cheby]) {
      const c = batch('lowpass-opening', src).map(centroid);
      for (let i = 1; i < N; i++) expect(c[i]).toBeGreaterThanOrEqual(c[i - 1] - 1e-9);
      expect(c[0]).toBeLessThan(c[N - 1] * 0.5);
    }
  });

  it('PWM from anything sweeps the pulse width (an offset carries into the clip)', () => {
    const duty = batch('pwm-anything', saw).map((t) => t.filter((v) => v > 0).length / t.length);
    for (let i = 1; i < N; i++) expect(duty[i]).toBeGreaterThan(duty[i - 1]);
    expect(duty[0]).toBeLessThan(0.2);
    expect(duty[N - 1]).toBeGreaterThan(0.8);
  });

  it('Talking vowels moves the low formant down ("ah" → "ee"); West-coast fold gets brighter', () => {
    const strongest = (t: Float32Array) => {
      const m = harmonicMagnitudes(t, 72);
      let best = 2;
      for (let k = 2; k <= 30; k++) if (m[k] > m[best]) best = k;
      return best;
    };
    const v = batch('talking-vowels', saw);
    expect(strongest(v[0])).toBeGreaterThanOrEqual(5);
    expect(strongest(v[N - 1])).toBeLessThanOrEqual(4);
    const w = batch('west-coast-fold', sine).map(centroid);
    expect(w[N - 1]).toBeGreaterThan(w[0] * 2);
  });

  /** Harmonic magnitudes relative to the strongest, in dB (−200 for absent). */
  const dbs = (t: Float32Array) => {
    const m = harmonicMagnitudes(t, 72);
    const mx = Math.max(...m.slice(1));
    return Array.from(m, (v) => (v > 0 ? 20 * Math.log10(v / mx) : -200));
  };

  it('Hollow out removes the even harmonics by the end; Phaser comb notches travel up the spectrum', () => {
    const h = batch('hollow-out', saw);
    expect(dbs(h[0])[2]).toBeGreaterThan(-8);
    expect(dbs(h[N - 1])[2]).toBeLessThan(-100);
    expect(dbs(h[N - 1])[3]).toBeGreaterThan(-12);
    const notch = (t: Float32Array) => {
      const d = dbs(t);
      let b = 12;
      for (let k = 12; k <= 20; k++) if (d[k] < d[b]) b = k;
      return b;
    };
    const n = batch('phaser-comb', saw).slice(1).map(notch);
    for (let i = 1; i < n.length; i++) expect(n[i]).toBeGreaterThanOrEqual(n[i - 1]);
    expect(n.at(-1)! - n[0]).toBeGreaterThanOrEqual(4);
  });

  it('Diode grit adds even harmonics; Drawbar organ gives the drawbar harmonics; Metallic thins out non-primes', () => {
    expect(dbs(batch('diode-grit', sine)[0])[2]).toBeGreaterThan(-25);
    for (const src of [saw, sine, cheby]) {
      const d = dbs(batch('drawbar-organ', src)[0]);
      for (const k of [1, 2, 3, 4, 6, 8]) expect(d[k], `h${k}`).toBeGreaterThan(-12);
      expect(d[9]).toBeLessThan(-24);
    }
    const m = dbs(batch('metallic', saw)[0]);
    expect(m[5]).toBeGreaterThan(m[4] + 6); // a prime above its non-prime neighbour
  });

  it('Phase scatter: every waveform has the same spectrum (relative to h1) but a different shape', () => {
    const p = batch('phase-scatter', saw);
    const rel = (t: Float32Array) => {
      const m = harmonicMagnitudes(t, 72);
      return Array.from(m, (v) => v / m[1]);
    };
    const r0 = rel(p[0]);
    for (const t of p.slice(1)) {
      const r = rel(t);
      for (let k = 1; k <= 40; k++) expect(Math.abs(r[k] - r0[k])).toBeLessThan(1e-3);
      expect(maxDiff(t, p[0])).toBeGreaterThan(0.1);
    }
  });

  it('Tape warmth stays close to its source; Ensemble drift gives N different copies of similar brightness', () => {
    for (const src of [sine, cheby]) expect(maxDiff(batch('tape-warmth', src)[0], src)).toBeLessThan(0.3);
    const e = batch('ensemble-drift', saw);
    for (let i = 1; i < N; i++) expect(maxDiff(e[i], e[i - 1])).toBeGreaterThan(1e-3);
    for (const t of e) expect(Math.abs(centroid(t) / centroid(saw) - 1)).toBeLessThan(0.15);
  });
});
