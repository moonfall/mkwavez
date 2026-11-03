/**
 * MIDI → voice events. Portable (no Web MIDI, no DOM): byte parsing, channel routing
 * (channel N → voice N, or Omni → one chosen voice), note tracking so a note-off reaches
 * the voice its note-on went to, pitch-bend scaling, the velocity curve and the
 * CC → parameter map (with learn). The per-voice note stack (last-note priority,
 * legato) lives in the engine (engine/noteStack.ts), next to the sequencer it overrides.
 */
import type { VoiceParams } from './voice';

/** Pitch-bend range: full wheel = ± this many semitones. */
export const BEND_RANGE_SEMITONES = 2;
export const CC_MOD_WHEEL = 1;
export const CC_ALL_SOUND_OFF = 120;
export const CC_ALL_NOTES_OFF = 123;
/** Highest assignable controller (120..127 are channel mode messages). */
export const CC_MAX_ASSIGNABLE = 119;
/** LFO rate range (Hz) of the voice panel slider; CCs map onto it exponentially. */
export const LFO_RATE_MIN = 0.02;
export const LFO_RATE_MAX = 4;

/** Channels are 1..16. Bend value is -1..1 (0 = centre). */
export type MidiMessage =
  | { readonly kind: 'noteOn'; readonly channel: number; readonly note: number; readonly velocity: number }
  | { readonly kind: 'noteOff'; readonly channel: number; readonly note: number }
  | { readonly kind: 'cc'; readonly channel: number; readonly cc: number; readonly value: number }
  | { readonly kind: 'bend'; readonly channel: number; readonly value: number };

/**
 * Parse one complete MIDI message (Web MIDI and plugin hosts deliver whole messages, no
 * running status). Note-on with velocity 0 is a note-off. Returns null for everything else
 * (aftertouch, program change, system messages, malformed data).
 */
export function parseMidi(data: ArrayLike<number>): MidiMessage | null {
  if (data.length < 2) return null;
  const status = data[0];
  if (status < 0x80 || status >= 0xf0) return null;
  const type = status & 0xf0;
  const channel = (status & 0x0f) + 1;
  const d1 = data[1] & 0x7f;
  const hasD2 = data.length >= 3;
  const d2 = hasD2 ? data[2] & 0x7f : 0;
  switch (type) {
    case 0x80:
      return hasD2 ? { kind: 'noteOff', channel, note: d1 } : null;
    case 0x90:
      if (!hasD2) return null;
      return d2 === 0 ? { kind: 'noteOff', channel, note: d1 } : { kind: 'noteOn', channel, note: d1, velocity: d2 };
    case 0xb0:
      return hasD2 ? { kind: 'cc', channel, cc: d1, value: d2 } : null;
    case 0xe0: {
      if (!hasD2) return null;
      const v = ((d2 << 7) | d1) - 8192;
      return { kind: 'bend', channel, value: v >= 0 ? v / 8191 : v / 8192 };
    }
  }
  return null;
}

/**
 * Velocity → amplitude: squared (≈ perceptually even steps) over a 40 dB range, so
 * velocity 127 = 1, 64 ≈ −12 dB, 1 = −40 dB. Velocity 0 = 0.
 */
export function velocityGain(velocity: number): number {
  if (velocity <= 0) return 0;
  const x = Math.min(127, velocity) / 127;
  return 0.01 + 0.99 * x * x;
}

/** Equal-tempered note frequency (A4 = note 69 = 440 Hz), shifted by the voice octave. */
export function midiNoteFreq(note: number, octave = 0): number {
  return 440 * Math.pow(2, (note - 69) / 12 + octave);
}

export function bendSemitones(value: number): number {
  return Math.max(-1, Math.min(1, value)) * BEND_RANGE_SEMITONES;
}

// ---- routing ----

/** Events for the engine (one voice each). `allNotesOff` with voiceId -1 = every voice. */
export type MidiVoiceEvent =
  | { readonly type: 'noteOn'; readonly voiceId: number; readonly note: number; readonly velocity: number }
  | { readonly type: 'noteOff'; readonly voiceId: number; readonly note: number }
  | { readonly type: 'allNotesOff'; readonly voiceId: number }
  | { readonly type: 'bend'; readonly voiceId: number; readonly semitones: number };

/** Router output: engine events, plus controller moves for the CC map (applied to params). */
export type MidiRouterEvent =
  | MidiVoiceEvent
  | { readonly type: 'cc'; readonly voiceId: number; readonly cc: number; readonly value: number };

export interface MidiRouting {
  /** Omni: every channel goes to `selectedVoice`; otherwise channel N → voice id N. */
  readonly omni: boolean;
  readonly selectedVoice: number | null;
  /** Voices that exist. */
  readonly voiceIds: readonly number[];
}

/** The voice a channel plays, or null. */
export function targetVoice(channel: number, r: MidiRouting): number | null {
  const id = r.omni ? r.selectedVoice : channel;
  return id !== null && r.voiceIds.includes(id) ? id : null;
}

/**
 * Stateful router. Remembers where each held note went (per source, channel and note), so
 * its note-off releases the same voice even if Omni's voice or the routing changed in
 * between, and so losing a device (or all-notes-off) releases exactly its notes.
 * A source is a small integer per input device.
 */
export class MidiRouter {
  /** key(source, channel, note) → voice id. */
  private held = new Map<number, number>();
  /** Voice id → source that last bent it (to recentre on device loss). */
  private bent = new Map<number, number>();

  private static key(source: number, channel: number, note: number): number {
    return source * 2048 + (channel - 1) * 128 + note;
  }

  /** Number of notes currently held (all sources). */
  get heldCount(): number {
    return this.held.size;
  }

  route(msg: MidiMessage, routing: MidiRouting, source = 0): MidiRouterEvent[] {
    switch (msg.kind) {
      case 'noteOn': {
        const k = MidiRouter.key(source, msg.channel, msg.note);
        const out: MidiRouterEvent[] = [];
        const prev = this.held.get(k);
        if (prev !== undefined) {
          // Repeated note-on without a note-off: release it where it went first.
          this.held.delete(k);
          out.push({ type: 'noteOff', voiceId: prev, note: msg.note });
        }
        const v = targetVoice(msg.channel, routing);
        if (v === null) return out;
        this.held.set(k, v);
        out.push({ type: 'noteOn', voiceId: v, note: msg.note, velocity: msg.velocity });
        return out;
      }
      case 'noteOff': {
        const k = MidiRouter.key(source, msg.channel, msg.note);
        const v = this.held.get(k);
        if (v === undefined) return [];
        this.held.delete(k);
        return [{ type: 'noteOff', voiceId: v, note: msg.note }];
      }
      case 'bend': {
        const v = targetVoice(msg.channel, routing);
        if (v === null) return [];
        if (msg.value === 0) this.bent.delete(v);
        else this.bent.set(v, source);
        return [{ type: 'bend', voiceId: v, semitones: bendSemitones(msg.value) }];
      }
      case 'cc': {
        if (msg.cc === CC_ALL_NOTES_OFF || msg.cc === CC_ALL_SOUND_OFF) return this.channelOff(msg.channel, routing, source);
        const v = targetVoice(msg.channel, routing);
        return v === null ? [] : [{ type: 'cc', voiceId: v, cc: msg.cc, value: msg.value }];
      }
    }
  }

  /** All-notes-off on a channel: release its held notes and clear the voice it plays now. */
  private channelOff(channel: number, routing: MidiRouting, source: number): MidiVoiceEvent[] {
    const voices = new Set<number>();
    for (const [k, v] of this.held) {
      if (Math.floor(k / 2048) === source && Math.floor((k % 2048) / 128) === channel - 1) voices.add(v);
    }
    const now = targetVoice(channel, routing);
    if (now !== null) voices.add(now);
    return this.voicesOff(voices);
  }

  /** Clear the given voices' note stacks and forget every note routed to them. */
  private voicesOff(voices: Set<number>): MidiVoiceEvent[] {
    for (const [k, v] of [...this.held]) if (voices.has(v)) this.held.delete(k);
    return [...voices].map((voiceId) => ({ type: 'allNotesOff', voiceId }) as const);
  }

  /** A device went away: release its notes and recentre the pitch bend it applied. */
  releaseSource(source: number): MidiVoiceEvent[] {
    const out: MidiVoiceEvent[] = [];
    for (const [k, v] of [...this.held]) {
      if (Math.floor(k / 2048) !== source) continue;
      this.held.delete(k);
      out.push({ type: 'noteOff', voiceId: v, note: k % 128 });
    }
    for (const [v, s] of [...this.bent]) {
      if (s !== source) continue;
      this.bent.delete(v);
      out.push({ type: 'bend', voiceId: v, semitones: 0 });
    }
    return out;
  }

  /** MIDI turned off / input switched: release everything and recentre all bends. */
  releaseAll(): MidiVoiceEvent[] {
    const out: MidiVoiceEvent[] = this.voicesOff(new Set(this.held.values()));
    for (const v of this.bent.keys()) out.push({ type: 'bend', voiceId: v, semitones: 0 });
    this.bent.clear();
    return out;
  }
}

// ---- CC → parameter map ----

export const CC_PARAMS = ['position', 'lfoDepth', 'lfoRate', 'level'] as const;
export type CcParam = (typeof CC_PARAMS)[number];

export const CC_PARAM_LABELS: Readonly<Record<CcParam, string>> = {
  position: 'Position',
  lfoDepth: 'LFO depth',
  lfoRate: 'LFO rate',
  level: 'Level',
};

/** Parameter → controller number (0..119), or -1 = unassigned. */
export type CcMap = Readonly<Record<CcParam, number>>;

export const DEFAULT_CC_MAP: CcMap = { position: CC_MOD_WHEEL, lfoDepth: -1, lfoRate: -1, level: -1 };

const validCc = (cc: unknown): number =>
  typeof cc === 'number' && Number.isInteger(cc) && cc >= 0 && cc <= CC_MAX_ASSIGNABLE ? cc : -1;

/**
 * Assign `cc` to `param` (-1 clears it). A controller drives one parameter: assigning it
 * removes it from any other parameter (so learn just "moves" a knob to a new target).
 */
export function assignCc(map: CcMap, param: CcParam, cc: number): CcMap {
  const c = validCc(cc);
  const out = { ...map };
  if (c >= 0) for (const p of CC_PARAMS) if (out[p] === c) out[p] = -1;
  out[param] = c;
  return out;
}

/** A map from untrusted data (storage): unknown keys dropped, bad values → unassigned. */
export function normalizeCcMap(x: unknown): CcMap {
  if (!x || typeof x !== 'object') return DEFAULT_CC_MAP;
  const o = x as Record<string, unknown>;
  let map: CcMap = { position: -1, lfoDepth: -1, lfoRate: -1, level: -1 };
  for (const p of CC_PARAMS) if (p in o) map = assignCc(map, p, validCc(o[p]));
  return map;
}

/** A 7-bit controller value → that parameter's value. LFO rate is exponential. */
export function ccValue(param: CcParam, value: number): number {
  const x = Math.max(0, Math.min(127, value)) / 127;
  if (param === 'lfoRate') return LFO_RATE_MIN * Math.pow(LFO_RATE_MAX / LFO_RATE_MIN, x);
  return x;
}

/** The voice-parameter change a controller move makes, or null if it is unmapped. */
export function ccPatch(map: CcMap, cc: number, value: number): Partial<VoiceParams> | null {
  let patch: Partial<Record<CcParam, number>> | null = null;
  for (const p of CC_PARAMS) if (map[p] === cc) (patch ??= {})[p] = ccValue(p, value);
  return patch;
}
