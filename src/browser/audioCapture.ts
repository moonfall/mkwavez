/**
 * Audio sources for Generate → Sample in the browser: audio files (decoded by the Web
 * Audio API, which also works inside the plugin's web view), and live sources — an input
 * device (getUserMedia) or a shared tab's / the system's audio (getDisplayMedia) —
 * through a recorder worklet. A live source keeps the last GRAB_SEC seconds at all times
 * (Grab), records takes of up to TAKE_MAX_SEC, and can start on sound / stop on silence.
 */
import type { Take } from '../core/sample';
import recorderUrl from '../audio/recorderWorklet.ts?worker&url';

export const TAKE_MAX_SEC = 60;
export const GRAB_SEC = 10;
/** Start on sound: level that starts a take (dBFS). Stop on silence: level and hold. */
export const START_DB = -40;
export const SILENCE_DB = -50;
export const SILENCE_HOLD_SEC = 1.2;
const RECORDER_NAME = 'mkwavez-recorder';

/** Audio files Sample accepts (extensions: the plugin's native dialog filters on them). */
export const AUDIO_ACCEPT = '.wav,.aif,.aiff,.mp3,.m4a,.aac,.ogg,.oga,.opus,.flac,.webm';

/** A file decoded to a mono take (cut to TAKE_MAX_SEC), at its own sample rate. */
export async function decodeAudioFile(file: Blob & { name?: string }): Promise<Take> {
  const bytes = await file.arrayBuffer();
  // An OfflineAudioContext decodes without needing a user gesture or an output device.
  const ctx = new OfflineAudioContext(1, 1, 48000);
  const buf = await ctx.decodeAudioData(bytes);
  const n = Math.min(buf.length, Math.round(TAKE_MAX_SEC * buf.sampleRate));
  const data = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < n; i++) data[i] += ch[i] / buf.numberOfChannels;
  }
  const name = (file.name ?? 'file').replace(/\.[^.]+$/, '') || 'file';
  return { name, sampleRate: buf.sampleRate, data };
}

export type LiveKind = 'input' | 'tab';

export interface LiveEvents {
  /** Peak level of the latest chunk (dBFS, −∞ … 0). */
  level?(db: number): void;
  /** Recording started (manually or on sound) or stopped (a take, or null when it was silent). */
  started?(): void;
  stopped?(take: Take | null): void;
}

const dbOf = (x: Float32Array) => {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  return m > 0 ? 20 * Math.log10(m) : -Infinity;
};

/** Input devices (labels only once the page has had microphone access). */
export async function inputDevices(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
}

/** Whether the browser can capture a tab's / the system's audio. */
export const canCaptureTab = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
export const canCaptureInput = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

/** A live source: open → (record | grab) → close. */
export class LiveCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  /** Rolling buffer (the last GRAB_SEC), as chunks. */
  private ring: Float32Array[] = [];
  private ringLen = 0;
  private rec: Float32Array[] | null = null;
  private recLen = 0;
  private quietFor = 0;
  /** Start recording on sound / stop on silence. */
  auto = false;
  /** Waiting for sound to start a take (auto). */
  armed = false;
  kind: LiveKind | null = null;
  /** The shared tab / device label, for display. */
  label = '';
  takeCount = 0;

  constructor(private readonly ev: LiveEvents = {}) {}

  get open(): boolean {
    return !!this.node;
  }
  get recording(): boolean {
    return !!this.rec;
  }
  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }
  /** Seconds recorded so far. */
  get recordedSec(): number {
    return this.recLen / this.sampleRate;
  }
  /** Seconds in the rolling buffer. */
  get bufferedSec(): number {
    return this.ringLen / this.sampleRate;
  }

  /** Open a live source (asks for permission; the tab picker for 'tab'). Closes any other first. */
  async start(kind: LiveKind, deviceId?: string): Promise<void> {
    this.close();
    const stream =
      kind === 'input'
        ? await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          })
        : await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    const audio = stream.getAudioTracks();
    if (!audio.length) {
      for (const t of stream.getTracks()) t.stop();
      throw new Error(kind === 'tab' ? 'No audio was shared: tick “Share tab audio” (or system audio) in the picker' : 'The device has no audio');
    }
    // Only the audio is needed: drop a shared tab's video right away.
    for (const t of stream.getVideoTracks()) t.stop();
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(recorderUrl);
    const src = ctx.createMediaStreamSource(new MediaStream(audio));
    const node = new AudioWorkletNode(ctx, RECORDER_NAME, { numberOfInputs: 1, numberOfOutputs: 0 });
    node.port.onmessage = (e: MessageEvent<Float32Array>) => this.chunk(e.data);
    src.connect(node);
    if (ctx.state !== 'running') await ctx.resume();
    this.ctx = ctx;
    this.stream = stream;
    this.node = node;
    this.kind = kind;
    this.label = audio[0].label;
    audio[0].addEventListener('ended', () => this.close());
  }

  close(): void {
    if (this.rec) this.stop();
    this.node?.disconnect();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    void this.ctx?.close();
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.kind = null;
    this.ring = [];
    this.ringLen = 0;
    this.armed = false;
  }

  /** Start a take now (or arm one to start on sound, with `auto`). */
  record(): void {
    if (!this.open || this.rec) return;
    if (this.auto) {
      this.armed = true;
      return;
    }
    this.begin();
  }

  private begin(): void {
    this.armed = false;
    this.rec = [];
    this.recLen = 0;
    this.quietFor = 0;
    this.ev.started?.();
  }

  /** Stop the take: the take, or null if it was silent (or never started). */
  stop(): Take | null {
    this.armed = false;
    const chunks = this.rec;
    this.rec = null;
    if (!chunks) {
      this.ev.stopped?.(null);
      return null;
    }
    const take = this.join(chunks, this.recLen, `Take ${this.takeCount + 1}`);
    const silent = !take || dbOf(take.data) < SILENCE_DB;
    if (!silent) this.takeCount++;
    this.ev.stopped?.(silent ? null : take);
    return silent ? null : take;
  }

  /** The last GRAB_SEC seconds (whatever the source played), or null if nothing yet. */
  grab(): Take | null {
    const take = this.join(this.ring, this.ringLen, `Grab ${this.takeCount + 1}`);
    if (!take || dbOf(take.data) < SILENCE_DB) return null;
    this.takeCount++;
    return take;
  }

  private join(chunks: Float32Array[], len: number, name: string): Take | null {
    if (!len) return null;
    const data = new Float32Array(len);
    let o = 0;
    for (const c of chunks) {
      data.set(c, o);
      o += c.length;
    }
    return { name, sampleRate: this.sampleRate, data };
  }

  private chunk(c: Float32Array): void {
    const sr = this.sampleRate;
    this.ring.push(c);
    this.ringLen += c.length;
    while (this.ringLen - this.ring[0].length >= GRAB_SEC * sr) this.ringLen -= this.ring.shift()!.length;
    const db = dbOf(c);
    this.ev.level?.(db);
    if (this.armed && db >= START_DB) this.begin();
    if (!this.rec) return;
    this.rec.push(c);
    this.recLen += c.length;
    if (this.auto) {
      this.quietFor = db < SILENCE_DB ? this.quietFor + c.length / sr : 0;
      if (this.quietFor >= SILENCE_HOLD_SEC && this.recLen / sr > SILENCE_HOLD_SEC + 0.1) {
        // Drop the trailing silence.
        const keep = Math.max(0, this.recLen - Math.round(this.quietFor * sr) + Math.round(0.1 * sr));
        this.trimRec(keep);
        this.stop();
        return;
      }
    }
    if (this.recLen >= TAKE_MAX_SEC * sr) this.stop();
  }

  private trimRec(len: number): void {
    if (!this.rec) return;
    let left = len;
    const out: Float32Array[] = [];
    for (const c of this.rec) {
      if (left <= 0) break;
      out.push(c.length <= left ? c : c.subarray(0, left));
      left -= c.length;
    }
    this.rec = out;
    this.recLen = Math.min(this.recLen, len);
  }
}
