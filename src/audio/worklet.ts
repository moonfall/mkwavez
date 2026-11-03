/// <reference path="./worklet-globals.d.ts" />
/**
 * AudioWorklet entry: a thin message adapter around the portable SynthEngine.
 * All state changes arrive as messages; status goes back at ~30 Hz.
 */
import { emptyStatus, SynthEngine } from '../core/engine/engine';
import { PROCESSOR_NAME, type FromWorklet, type ToWorklet } from './protocol';

const STATUS_HZ = 30;

class EngineProcessor extends AudioWorkletProcessor {
  private engine = new SynthEngine(sampleRate);
  private status = emptyStatus();
  private statusCountdown = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => {
      try {
        this.handle(e.data);
      } catch (err) {
        this.send({ type: 'error', message: String(err) });
      }
    };
    this.send({ type: 'ready' });
  }

  private send(m: FromWorklet): void {
    this.port.postMessage(m);
  }

  private handle(m: ToWorklet): void {
    const e = this.engine;
    switch (m.type) {
      case 'tables/add':
        for (const it of m.items) e.addTable(it.id, it.mips);
        break;
      case 'tables/remove':
        e.removeTables(m.ids);
        break;
      case 'wavetable/set':
        e.setWavetable(m.id, m.ids);
        break;
      case 'wavetable/remove':
        e.removeWavetable(m.id);
        break;
      case 'voice/set':
        e.setVoice(m.voice);
        break;
      case 'voice/patch':
        e.patchVoice(m.id, m.patch);
        break;
      case 'voice/remove':
        e.removeVoice(m.id);
        break;
      case 'sequence/set':
        e.setSequence(m.sequence);
        break;
      case 'sequence/remove':
        e.removeSequence(m.id);
        break;
      case 'transport':
        e.setTransport(m.playing, m.bpm);
        break;
      case 'midi':
        for (const ev of m.events) e.applyMidi(ev);
        break;
      case 'batch':
        for (const op of m.ops) this.handle(op);
        break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const ch0 = out?.[0];
    if (!ch0) return true;
    this.engine.process(ch0, ch0.length);
    for (let c = 1; c < out.length; c++) out[c].set(ch0);
    this.statusCountdown -= ch0.length;
    if (this.statusCountdown <= 0) {
      this.statusCountdown = sampleRate / STATUS_HZ;
      this.send({ type: 'status', status: this.engine.status(this.status), tableCount: this.engine.tableCount });
    }
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, EngineProcessor);
