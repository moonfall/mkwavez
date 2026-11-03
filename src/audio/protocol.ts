/** Messages between the main thread and the AudioWorklet (structured-clone plain data). */
import type { EngineStatus } from '../core/engine/engine';
import type { CcMap, MidiVoiceEvent } from '../core/midi';
import type { SequenceData } from '../core/sequence';
import type { VoiceParams } from '../core/voice';
import type { PackedWavetable } from '../core/wavetablePlayback';

export const PROCESSOR_NAME = 'mkwavez-engine';

export type ToWorklet =
  /** Packed mip sets (buffers are transferred). */
  | { type: 'tables/add'; items: { id: number; mips: Float32Array }[] }
  /** Raw tables (native engine: it builds the mip sets itself). */
  | { type: 'tables/addData'; items: { id: number; data: Float32Array }[] }
  | { type: 'tables/remove'; ids: number[] }
  /** Wavetable structure: row offsets + slot ids (-1 = empty), interpolation. */
  | { type: 'wavetable/set'; id: number; wavetable: PackedWavetable }
  | { type: 'wavetable/remove'; id: number }
  | { type: 'voice/set'; voice: VoiceParams }
  | { type: 'voice/remove'; id: number }
  /** A few params of one voice (MIDI CCs), without resending the whole voice. */
  | { type: 'voice/patch'; id: number; patch: Partial<VoiceParams> }
  | { type: 'sequence/set'; sequence: SequenceData }
  | { type: 'sequence/remove'; id: number }
  | { type: 'transport'; playing: boolean; bpm: number }
  /** Routed MIDI note / bend events, applied in order (see SynthEngine.applyMidi). */
  | { type: 'midi'; events: MidiVoiceEvent[] }
  /**
   * Native engine only: host MIDI routing (it routes the host's MIDI itself). `enabled`
   * false ignores MIDI input; `voice` is the voice Omni plays (the selected tab).
   */
  | { type: 'midi/settings'; enabled: boolean; omni: boolean; voice: number | null; cc: CcMap }
  /** Ops applied in order, atomically (no audio rendered in between). */
  | { type: 'batch'; ops: ToWorklet[] };

export type FromWorklet =
  | { type: 'ready' }
  | { type: 'status'; status: EngineStatus; tableCount: number }
  | { type: 'error'; message: string };

/** What the native engine (plugin) sends besides status: host-side changes the model should follow. */
export type FromNative =
  | FromWorklet
  /** Host transport / automation of Play and BPM. */
  | { type: 'transport'; playing: boolean; bpm: number }
  /** Parameter automation of a voice (position, LFOs, level, mute, envelope, octave). */
  | { type: 'voice/params'; id: number; patch: Partial<VoiceParams> }
  /** Controller messages from the host's MIDI (raw bytes), for learn, the LED and the model's sliders. */
  | { type: 'midi/cc'; messages: number[][] };
