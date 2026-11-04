import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { defaultSessionState } from '../src/app/defaultSession';
import { AppModel } from '../src/app/model';
import { basicWave } from '../src/core/generators';
import { decodeSession, encodeMeta, encodeWaveforms, type SessionMeta } from '../src/core/session';
import { applyChain, normalizeChain, chainJson } from '../src/core/shapeChain';
import { chainsFile, DEFAULT_CHAIN, FACTORY_CHAINS, MAX_SAVED_CHAINS, normalizeSavedChains, parseChainsFile } from '../src/core/shapeFactory';
import { newStep } from '../src/core/shapeSteps';
import { PREVIEW_ID_BASE, PREVIEW_WAVETABLE_ID, SELECTION_WAVETABLE_ID } from '../src/core/wavetable';

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
