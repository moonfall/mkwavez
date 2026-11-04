/**
 * The plugin's engine port: the web app runs inside the plugin's embedded web view and
 * talks to the native engine through JUCE's WebView bridge (`window.__JUCE__.backend`)
 * on one event id. Typed arrays travel as base64 (tables) or plain arrays (wavetables).
 */
import { f32ToBase64 } from '../app/base64';
import type { EnginePort } from './port';
import type { FromNative, FromWorklet, ToWorklet } from './protocol';

/** JUCE's backend object, injected into the page by WebBrowserComponent. */
export interface JuceBackend {
  emitEvent(eventId: string, payload: unknown): void;
  addEventListener(eventId: string, fn: (payload: unknown) => void): unknown;
}

/** The event id both sides use. */
export const NATIVE_EVENT = 'mkwavez';

/** The backend when running inside the plugin, else null. */
export function juceBackend(): JuceBackend | null {
  const juce = (globalThis as { __JUCE__?: { backend?: JuceBackend } }).__JUCE__;
  return juce?.backend ?? null;
}

/** Messages to the native side besides engine batches (see plugin/host.ts). */
export type ToNative =
  | { type: 'batch'; ops: unknown[] }
  /** Page loaded: send the saved session (init + record chunks). */
  | { type: 'hello' }
  /** Session backend writes (app/autosave.ts SessionBackend), records as JSON with base64 samples. */
  | { type: 'session/put'; records: { id: number; json: string }[] }
  | { type: 'session/commit'; meta: string; remove: number[]; records: { id: number; json: string }[] }
  | { type: 'session/remove'; ids: number[] }
  | { type: 'session/clear' }
  /** Plugin-only settings (MIDI routing), JSON object of strings. */
  | { type: 'settings'; json: string }
  /** Save a file through a native dialog (exports: session, presets, shape chains). */
  | { type: 'file/save'; name: string; data: string }
  /** Open a file through a native dialog; answered by file/opened (data null = cancelled). */
  | { type: 'file/open'; id: number; accept: string }
  /** Page errors / warnings, for the native log (MKWAVEZ_WEB_DEBUG=1). */
  | { type: 'log'; level: 'error' | 'warn'; message: string };

/** JSON-safe form of an engine op. */
export function encodeOp(op: ToWorklet): unknown {
  switch (op.type) {
    case 'tables/addData':
      return { type: op.type, items: op.items.map((i) => ({ id: i.id, data: f32ToBase64(i.data) })) };
    case 'tables/add':
      throw new Error('the native engine builds its own mip sets (use tables/addData)');
    case 'wavetable/set':
      return {
        type: op.type,
        id: op.id,
        wavetable: { shape: op.wavetable.shape, interp: op.wavetable.interp, rowStart: Array.from(op.wavetable.rowStart), ids: Array.from(op.wavetable.ids) },
      };
    case 'batch':
      return { type: op.type, ops: op.ops.map(encodeOp) };
    default:
      return op;
  }
}

export class NativePort implements EnginePort {
  readonly rawTables = true;
  sampleRate = 48000;
  /** Non-status messages (host transport, automation, controller moves, init / records). */
  onHost?: (m: FromNative | { type: string; [k: string]: unknown }) => void;
  private onMessage?: (m: FromWorklet) => void;

  constructor(private backend: JuceBackend) {
    backend.addEventListener(NATIVE_EVENT, (payload) => this.receive(payload));
  }

  open(onMessage: (m: FromWorklet) => void): Promise<void> {
    this.onMessage = onMessage;
    return Promise.resolve();
  }

  post(ops: ToWorklet[]): void {
    if (ops.length) this.send({ type: 'batch', ops: ops.map(encodeOp) });
  }

  send(m: ToNative): void {
    this.backend.emitEvent(NATIVE_EVENT, m);
  }

  private receive(payload: unknown): void {
    const m = payload as { type?: string; sampleRate?: number };
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'status') {
      if (typeof m.sampleRate === 'number' && m.sampleRate > 0) this.sampleRate = m.sampleRate;
      this.onMessage?.(m as FromWorklet);
      return;
    }
    this.onHost?.(m as FromNative);
  }
}
