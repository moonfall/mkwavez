/**
 * Resample: render one voice holding a note, offline, through the TypeScript engine (the
 * one the browser's AudioWorklet runs; the plugin's native engine matches it sample for
 * sample), so it works the same in the browser and the plugin and can take one voice
 * after its own filter, unison and envelope. The result is a take for Generate → Sample.
 */
import { buildMipSet } from '../core/mipmap';
import { SynthEngine } from '../core/engine/engine';
import type { Take } from '../core/sample';
import type { TableId, WaveTable } from '../core/table';
import type { VoiceParams } from '../core/voice';
import type { Wavetable, WavetableId } from '../core/wavetable';
import { packWavetable } from '../core/wavetablePlayback';

/** What the render needs from the model. */
export interface ResampleSource {
  voice(id: number): VoiceParams | undefined;
  wavetable(id: WavetableId): Wavetable | undefined;
  table(id: TableId | null): WaveTable | undefined;
}

export interface ResampleOptions {
  voiceId: number;
  /** MIDI note (the voice's octave setting still applies, as when played). */
  note: number;
  /** Seconds the note is held (the take's length). */
  seconds: number;
  /** MIDI velocity 1–127. */
  velocity?: number;
  sampleRate?: number;
}

/** Longest resample (seconds). */
export const RESAMPLE_MAX_SEC = 10;
const BLOCK = 128;

/** Render the voice holding the note; null if the voice doesn't exist. Mono (L + R) / 2. */
export function resampleVoice(src: ResampleSource, o: ResampleOptions, name = 'Resample'): Take | null {
  const v = src.voice(o.voiceId);
  if (!v) return null;
  const sr = o.sampleRate ?? 48000;
  const engine = new SynthEngine(sr);
  // The wavetables the voice reads (osc A; osc B on Synth voices) and every table in them.
  const wtIds = new Set<WavetableId>([v.wavetableId]);
  if (v.type === 'synth') wtIds.add(v.synth.b.wavetableId);
  const sent = new Set<TableId>();
  for (const id of wtIds) {
    const wt = src.wavetable(id);
    if (!wt) continue;
    for (const row of wt.rows)
      for (const t of row) {
        if (t === null || sent.has(t)) continue;
        const table = src.table(t);
        if (!table) continue;
        engine.addTable(t, buildMipSet(table.data));
        sent.add(t);
      }
    engine.setWavetable(id, packWavetable(wt));
  }
  engine.setVoice({ ...v, mute: false });
  engine.midiNoteOn(v.id, o.note, Math.max(1, Math.min(127, Math.round(o.velocity ?? 100))));
  const frames = Math.max(BLOCK, Math.round(Math.min(RESAMPLE_MAX_SEC, Math.max(0.05, o.seconds)) * sr));
  const out = new Float32Array(frames);
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let f = 0; f < frames; f += BLOCK) {
    const n = Math.min(BLOCK, frames - f);
    l.fill(0);
    r.fill(0);
    engine.process(l, n, r);
    for (let i = 0; i < n; i++) out[f + i] = 0.5 * (l[i] + r[i]);
  }
  return { name, sampleRate: sr, data: out };
}
