/**
 * Where the AudioBridge's messages go: the AudioWorklet in the browser (WorkletPort), or
 * the native engine inside the plugin (audio/nativePort.ts). Both take the same
 * batched protocol (audio/protocol.ts).
 */
import { PROCESSOR_NAME, type FromWorklet, type ToWorklet } from './protocol';
import workletUrl from './worklet.ts?worker&url';

export interface EnginePort {
  /** true: send raw tables (`tables/addData`; the engine builds mip sets); false: mip sets. */
  readonly rawTables: boolean;
  readonly sampleRate: number;
  /** Connect (idempotent; may need a user gesture in the browser). */
  open(onMessage: (m: FromWorklet) => void): Promise<void>;
  /** One atomic batch. */
  post(ops: ToWorklet[], transfer: Transferable[]): void;
}

/** The browser: an AudioContext + AudioWorkletNode running core/engine. */
export class WorkletPort implements EnginePort {
  readonly rawTables = false;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  async open(onMessage: (m: FromWorklet) => void): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state !== 'running') await this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.port.onmessage = (e: MessageEvent<FromWorklet>) => onMessage(e.data);
    node.connect(ctx.destination);
    this.node = node;
    if (ctx.state !== 'running') await ctx.resume();
  }

  post(ops: ToWorklet[], transfer: Transferable[]): void {
    this.node?.port.postMessage({ type: 'batch', ops } satisfies ToWorklet, transfer);
  }
}
