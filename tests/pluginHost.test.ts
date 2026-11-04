import { afterEach, describe, expect, it, vi } from 'vitest';
import { Autosaver } from '../src/app/autosave';
import { AppModel } from '../src/app/model';
import { restoreSession } from '../src/app/restore';
import { AudioBridge } from '../src/audio/bridge';
import { NATIVE_EVENT, NativePort, type JuceBackend } from '../src/audio/nativePort';
import { DEFAULT_PERLIN, generatePerlin } from '../src/core/generators';
import { encodeMeta, encodeWaveforms } from '../src/core/session';
import { decodeRecord, encodeRecord, PluginHost } from '../src/plugin/host';
import { defaultSessionState } from '../src/app/defaultSession';

/** A stand-in for JUCE's backend: records what the page sends, lets the test answer. */
class FakeBackend implements JuceBackend {
  sent: { type: string; [k: string]: unknown }[] = [];
  private listener?: (p: unknown) => void;
  onSend?: (m: { type: string; [k: string]: unknown }) => void;
  emitEvent(id: string, payload: unknown): void {
    expect(id).toBe(NATIVE_EVENT);
    // Round-trip through JSON like the real bridge.
    const m = JSON.parse(JSON.stringify(payload)) as { type: string };
    this.sent.push(m);
    this.onSend?.(m);
  }
  addEventListener(id: string, fn: (p: unknown) => void): void {
    expect(id).toBe(NATIVE_EVENT);
    this.listener = fn;
  }
  reply(m: unknown): void {
    this.listener?.(JSON.parse(JSON.stringify(m)));
  }
  ops(): { type: string; [k: string]: unknown }[] {
    return this.sent.filter((m) => m.type === 'batch').flatMap((m) => m.ops as { type: string }[]);
  }
}

const immediate = { now: () => Date.now(), setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimer: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>), idle: (fn: () => void) => setTimeout(fn, 0) };

/** The plugin boot sequence of src/main.ts. */
async function boot(answer: (b: FakeBackend) => void) {
  const backend = new FakeBackend();
  backend.onSend = (m) => {
    if (m.type === 'hello') answer(backend);
  };
  const port = new NativePort(backend);
  const model = new AppModel();
  const bridge = new AudioBridge(model, port);
  const host = new PluginHost(model, bridge, port);
  await host.connect();
  const b = await restoreSession(() => Promise.resolve(host.session), () => Promise.resolve(true));
  model.loadState(b.state.model);
  await host.start(b.restored);
  const saver = new Autosaver(model, () => ({}), b.store, immediate, { delay: 0, maxWait: 0 });
  saver.init(b.stored);
  if (!b.restored) saver.markDirty();
  return { backend, port, model, bridge, host, boot: b, saver };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

/** Wait (real timers) until `cond` holds: a fixed sleep is flaky on a loaded machine. */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
}

afterEach(() => vi.useRealTimers());

describe('PluginHost (plugin mode)', () => {
  it('fresh instance: default session, every table sent raw, session autosaved to native', async () => {
    const { backend, model, boot: b } = await boot((x) => x.reply({ type: 'init', meta: null, records: 0, sampleRate: 44100, engine: { tables: [1, 2, 3, 4, 5], wavetables: [0, 1], voices: [1, 2, 3, 4], sequences: [1, 2, 3] } }));
    // The autosave (debounce 0 + idle callbacks) lands asynchronously: wait for its commit.
    await until(() => backend.sent.some((m) => m.type === 'session/commit'));
    await flush();
    expect(b.restored).toBe(false);
    expect(model.timeline.length).toBe(5);
    const ops = backend.ops();
    const added = ops.filter((o) => o.type === 'tables/addData').flatMap((o) => o.items as { id: number; data: string }[]);
    expect(added.map((t) => t.id).sort()).toEqual([1, 2, 3, 4, 5]); // replaced: not the same session
    expect(typeof added[0].data).toBe('string');
    const order = ops.map((o) => o.type);
    expect(order.indexOf('tables/addData')).toBeLessThan(order.indexOf('wavetable/set'));
    expect(ops.some((o) => o.type === 'voice/remove' && o.id === 4)).toBe(true); // the engine's extra voice goes
    expect(order).not.toContain('tables/add'); // never mip sets
    const commits = backend.sent.filter((m) => m.type === 'session/commit');
    expect(commits.length).toBeGreaterThan(0);
    const meta = JSON.parse(commits.at(-1)!.meta as string);
    expect(meta.format).toBe('mkwavez-session');
    expect(meta.timeline).toEqual([1, 2, 3, 4, 5]);
    const recs = backend.sent.filter((m) => m.type === 'session/put' || m.type === 'session/commit').flatMap((m) => m.records as { id: number }[]);
    expect(new Set(recs.map((r) => r.id)).size).toBe(5);
  });

  it('restores a saved session from the native side and sends no tables', async () => {
    const src = new AppModel();
    src.loadState(defaultSessionState());
    src.addTables(generatePerlin(DEFAULT_PERLIN, 9, 3));
    const state = { model: src.exportState(), ui: {} };
    const meta = JSON.stringify(encodeMeta(state, 123));
    const records = encodeWaveforms(src.timeline).map(encodeRecord);
    const { backend, model, boot: b } = await boot((x) => {
      x.reply({ type: 'init', meta, records: records.length, engine: { tables: src.timeline.map((t) => t.id), wavetables: [0, 1, 2, 3], voices: [1, 2, 3], sequences: [1, 2, 3] } });
      x.reply({ type: 'records', items: records.slice(0, 4) });
      x.reply({ type: 'records', items: records.slice(4) });
    });
    await flush();
    expect(b.restored).toBe(true);
    expect(model.timeline.map((t) => t.id)).toEqual(src.timeline.map((t) => t.id));
    expect(Array.from(model.timeline[6].data)).toEqual(Array.from(src.timeline[6].data));
    expect(backend.ops().some((o) => o.type === 'tables/addData')).toBe(false);
    expect(backend.ops().some((o) => o.type === 'wavetable/set')).toBe(true);
  });

  it('records survive the wire', () => {
    const src = new AppModel();
    src.loadState(defaultSessionState());
    for (const r of encodeWaveforms(src.timeline)) {
      const back = decodeRecord(JSON.parse(JSON.stringify(encodeRecord(r))));
      expect(back.id).toBe(r.id);
      expect(back.enc).toBe(r.enc);
      if (r.samples) expect(Array.from(back.samples!)).toEqual(Array.from(r.samples));
    }
  });

  it('an unrestorable session is set aside: fresh session, native session cleared', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { backend, model, boot: b } = await boot((x) => x.reply({ type: 'init', meta: '{"format":"mkwavez-session","version":999}', records: 0 }));
    expect(b.restored).toBe(false);
    expect(model.timeline.length).toBe(5);
    expect(backend.sent.some((m) => m.type === 'session/clear')).toBe(true);
    expect(await b.store!.keptList()).toHaveLength(1);
    warn.mockRestore();
  });

  it('follows host transport and automation without echoing transport back', async () => {
    const { backend, model } = await boot((x) => x.reply({ type: 'init', meta: null, records: 0 }));
    await flush();
    backend.sent = [];
    backend.reply({ type: 'transport', playing: true, bpm: 128 });
    backend.reply({ type: 'voice/params', id: 1, patch: { position: 0.9, level: 0.5, windowStart: 3 } });
    await flush();
    expect(model.playing).toBe(true);
    expect(model.bpm).toBe(128);
    expect(model.voice(1)!.position).toBe(0.9);
    expect(model.voice(1)!.level).toBe(0.5);
    expect(model.voice(1)!.windowStart).toBe(0); // not an automated field
    const ops = backend.ops();
    expect(ops.some((o) => o.type === 'transport')).toBe(false);
    expect(ops.some((o) => o.type === 'voice/set')).toBe(true);
    model.setTransport({ playing: false });
    await flush();
    expect(backend.ops().filter((o) => o.type === 'transport').length).toBe(1);
    // Synth parameter automation (macros, cutoff, …): only the automated synth fields apply.
    const before = model.voice(1)!.synth;
    backend.reply({ type: 'voice/params', id: 1, patch: { synth: { macro2: 0.25, cutoff: 900, poly: 2, aWarp: 'fold' } } as never });
    await flush();
    const after = model.voice(1)!.synth;
    expect([after.macro2, after.cutoff]).toEqual([0.25, 900]);
    expect([after.poly, after.aWarp]).toEqual([before.poly, before.aWarp]);
  });

  it('applies the host parameter values sent with init over the saved session', async () => {
    const { model } = await boot((x) => x.reply({ type: 'init', meta: null, records: 0, voices: [{ id: 2, patch: { position: 0.123, mute: false } }] }));
    expect(model.voice(2)!.position).toBeCloseTo(0.123, 6);
    expect(model.voice(2)!.mute).toBe(false);
  });

  it('starts fresh if the native side never answers', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = boot(() => {});
    await vi.advanceTimersByTimeAsync(5000);
    const { model } = await p;
    expect(model.timeline.length).toBe(5);
    warn.mockRestore();
  });
});
