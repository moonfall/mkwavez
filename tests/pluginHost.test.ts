import { afterEach, describe, expect, it, vi } from 'vitest';
import { f32ToBase64 } from '../src/app/base64';
import { AppModel } from '../src/app/model';
import { applyStartState } from '../src/app/startState';
import { AudioBridge } from '../src/audio/bridge';
import { NATIVE_EVENT, NativePort, type JuceBackend } from '../src/audio/nativePort';
import { DEFAULT_PERLIN, generatePerlin } from '../src/core/generators';
import { PluginHost } from '../src/plugin/host';

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

function setup(answer: (b: FakeBackend) => void) {
  const backend = new FakeBackend();
  backend.onSend = (m) => {
    if (m.type === 'hello') answer(backend);
  };
  const port = new NativePort(backend);
  const model = new AppModel();
  const bridge = new AudioBridge(model, port);
  const host = new PluginHost(model, bridge, port);
  return { backend, port, model, bridge, host };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.useRealTimers());

describe('PluginHost (plugin mode)', () => {
  it('fresh instance: start state, every table sent raw, project saved', async () => {
    const { backend, model, host } = setup((b) => b.reply({ type: 'init', project: null, tables: 0, sampleRate: 44100 }));
    await host.connect();
    await flush();
    expect(model.timeline.length).toBe(5);
    const ops = backend.ops();
    const added = ops.filter((o) => o.type === 'tables/addData').flatMap((o) => o.items as { id: number; data: string }[]);
    expect(added.map((t) => t.id).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(typeof added[0].data).toBe('string');
    // Tables precede the wavetables that reference them; voices and sequences follow.
    const order = ops.map((o) => o.type);
    expect(order.indexOf('tables/addData')).toBeLessThan(order.indexOf('wavetable/set'));
    expect(order).toContain('voice/set');
    expect(order).toContain('sequence/set');
    expect(order).not.toContain('tables/add'); // never mip sets
    const saved = backend.sent.filter((m) => m.type === 'project');
    expect(saved.length).toBe(1);
    expect(JSON.parse(saved[0].json as string).tables.length).toBe(5);
  });

  it('restores a saved project with samples from the native side and sends no tables', async () => {
    const src = new AppModel();
    applyStartState(src);
    src.addTables(generatePerlin(DEFAULT_PERLIN, 9, 3));
    const project = JSON.stringify(src.toProject(false));
    const items = src.timeline.map((t) => ({ id: t.id, data: f32ToBase64(t.data) }));
    const { backend, model, host } = setup((b) => {
      b.reply({ type: 'init', project, tables: items.length });
      b.reply({ type: 'tables', items: items.slice(0, 4) });
      b.reply({ type: 'tables', items: items.slice(4) });
    });
    await host.connect();
    await flush();
    expect(model.timeline.map((t) => t.id)).toEqual(src.timeline.map((t) => t.id));
    expect(Array.from(model.timeline[6].data)).toEqual(Array.from(src.timeline[6].data));
    expect(model.selectedId).toBe(src.selectedId);
    expect(backend.ops().some((o) => o.type === 'tables/addData')).toBe(false);
    expect(backend.ops().some((o) => o.type === 'wavetable/set')).toBe(true);
  });

  it('a corrupt saved project falls back to the start state', async () => {
    const { model, host } = setup((b) => b.reply({ type: 'init', project: '{"format":"nope"}', tables: 0 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await host.connect();
    expect(model.timeline.length).toBe(5);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('follows host transport and automation without echoing transport back', async () => {
    const { backend, model, host } = setup((b) => b.reply({ type: 'init', project: null, tables: 0 }));
    await host.connect();
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
    // A transport change made in the UI does go out.
    model.setTransport({ playing: false });
    await flush();
    expect(backend.ops().filter((o) => o.type === 'transport').length).toBe(1);
  });

  it('starts fresh if the native side never answers', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { model, host } = setup(() => {});
    const done = host.connect();
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(model.timeline.length).toBe(5);
    warn.mockRestore();
  });
});
