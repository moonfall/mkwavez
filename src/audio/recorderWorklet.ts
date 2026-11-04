/// <reference path="./worklet-globals.d.ts" />
/**
 * AudioWorklet for Generate → Sample's live sources: mixes its input to mono and posts it
 * to the main thread in chunks (RECORDER_CHUNK frames), where browser/audioCapture.ts
 * keeps the rolling buffer and the take being recorded.
 */
const RECORDER_NAME = 'mkwavez-recorder'; // (browser/audioCapture.ts uses the same name)
const CHUNK = 2048;

class RecorderProcessor extends AudioWorkletProcessor {
  private buf = new Float32Array(CHUNK);
  private n = 0;

  process(inputs: Float32Array[][]): boolean {
    const chans = inputs[0];
    if (!chans || !chans.length) return true;
    const len = chans[0].length;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (const c of chans) s += c[i];
      this.buf[this.n++] = s / chans.length;
      if (this.n === CHUNK) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(CHUNK);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor(RECORDER_NAME, RecorderProcessor);
