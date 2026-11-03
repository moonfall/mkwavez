/** Messages between the main thread and the AudioWorklet (structured-clone plain data). */
import type { EngineStatus } from '../core/engine/engine';
import type { MidiVoiceEvent } from '../core/midi';
import type { SequenceData } from '../core/sequence';
import type { VoiceParams } from '../core/voice';
import type { PackedWavetable } from '../core/wavetablePlayback';

export const PROCESSOR_NAME = 'mkwavez-engine';

export type ToWorklet =
  /** Packed mip sets (buffers are transferred). */
  | { type: 'tables/add'; items: { id: number; mips: Float32Array }[] }
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
  /** Ops applied in order, atomically (no audio rendered in between). */
  | { type: 'batch'; ops: ToWorklet[] };

export type FromWorklet =
  | { type: 'ready' }
  | { type: 'status'; status: EngineStatus; tableCount: number }
  | { type: 'error'; message: string };
