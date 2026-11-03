/**
 * MIDI → voice events. Portable (no Web MIDI, no DOM): byte parsing, channel routing
 * (channel N → voice N, or Omni → one chosen voice), note tracking so a note-off reaches
 * the voice its note-on went to, pitch-bend scaling, the velocity curve and the
 * CC → parameter map (with learn). The per-voice note stack (last-note priority,
 * legato) lives in the engine (engine/noteStack.ts), next to the sequencer it overrides.
 */
import { CUTOFF_MAX, CUTOFF_MIN, type SynthParams } from './synth';
import { mergeVoicePatch, type VoicePatch, type VoiceParams } from './voice';

/** Pitch-bend range: full wheel = ± this many semitones. */
export const BEND_RANGE_SEMITONES = 2;
export const CC_MOD_WHEEL = 1;
export const CC_ALL_SOUND_OFF = 120;
export const CC_RESET_ALL_CONTROLLERS = 121;
export const CC_ALL_NOTES_OFF = 123;
/** Highest assignable controller (120..127 are channel mode messages). */
export const CC_MAX_ASSIGNABLE = 119;

/**
 * Controllers learn ignores: bank select (0 / 32), data entry (6 / 38) and NRPN / RPN
 * (96..101) arrive as side effects of program and parameter changes, not knob moves.
 * They can still be typed in. Channel mode messages (120..127) are never assignable.
 */
export function isLearnableCc(cc: number): boolean {
  return cc >= 0 && cc <= CC_MAX_ASSIGNABLE && cc !== 0 && cc !== 32 && cc !== 6 && cc !== 38 && !(cc >= 96 && cc <= 101);
}
/** LFO rate range (Hz) of the voice panel slider; CCs map onto it exponentially. */
export const LFO_RATE_MIN = 0.02;
export const LFO_RATE_MAX = 4;

/** Channels are 1..16. Bend value is -1..1 (0 = centre). */
export type MidiMessage =
  | { readonly kind: 'noteOn'; readonly channel: number; readonly note: number; readonly velocity: number }
  | { readonly kind: 'noteOff'; readonly channel: number; readonly note: number }
  | { readonly kind: 'cc'; readonly channel: number; readonly cc: number; readonly value: number }
  | { readonly kind: 'bend'; readonly channel: number; readonly value: number }
  /** Channel pressure (aftertouch), 0..1. */
  | { readonly kind: 'pressure'; readonly channel: number; readonly value: number };

/**
 * Parse one complete MIDI message (Web MIDI and plugin hosts deliver whole messages, no
 * running status). Note-on with velocity 0 is a note-off. Returns null for everything else
 * (polyphonic aftertouch, program change, system messages, malformed data).
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
    case 0xd0:
      return { kind: 'pressure', channel, value: d1 / 127 };
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
  | { readonly type: 'bend'; readonly voiceId: number; readonly semitones: number }
  /** Mod wheel (CC 1) and channel pressure, 0..1: Synth voice mod matrix sources. */
  | { readonly type: 'mod'; readonly voiceId: number; readonly value: number }
  | { readonly type: 'pressure'; readonly voiceId: number; readonly value: number };

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
  /** bendKey(source, channel) → the voice that channel's wheel is bending, and by how much. */
  private bent = new Map<number, { voiceId: number; semitones: number }>();

  private static bendKey(source: number, channel: number): number {
    return source * 16 + channel - 1;
  }

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
        const k = MidiRouter.bendKey(source, msg.channel);
        const out: MidiRouterEvent[] = [];
        const prev = this.bent.get(k);
        const v = targetVoice(msg.channel, routing);
        // The channel now plays another voice: recentre the one it was bending.
        if (prev && prev.voiceId !== v) out.push({ type: 'bend', voiceId: prev.voiceId, semitones: 0 });
        this.bent.delete(k);
        if (v === null) return out;
        const semitones = bendSemitones(msg.value);
        if (semitones !== 0) this.bent.set(k, { voiceId: v, semitones });
        out.push({ type: 'bend', voiceId: v, semitones });
        return out;
      }
      case 'cc': {
        if (msg.cc === CC_ALL_NOTES_OFF || msg.cc === CC_ALL_SOUND_OFF) return this.channelOff(msg.channel, routing, source);
        if (msg.cc === CC_RESET_ALL_CONTROLLERS) return this.resetControllers(msg.channel, source);
        const v = targetVoice(msg.channel, routing);
        if (v === null) return [];
        // The mod wheel is also a mod matrix source (whatever the CC map does with it).
        if (msg.cc === CC_MOD_WHEEL) return [{ type: 'cc', voiceId: v, cc: msg.cc, value: msg.value }, { type: 'mod', voiceId: v, value: msg.value / 127 }];
        return [{ type: 'cc', voiceId: v, cc: msg.cc, value: msg.value }];
      }
      case 'pressure': {
        const v = targetVoice(msg.channel, routing);
        return v === null ? [] : [{ type: 'pressure', voiceId: v, value: msg.value }];
      }

    }
  }

  /**
   * Reset all controllers (CC 121): recentre the channel's pitch bend. Mapped CCs set
   * stored voice parameters (like moving a slider), so they are not reset.
   */
  private resetControllers(channel: number, source: number): MidiVoiceEvent[] {
    const k = MidiRouter.bendKey(source, channel);
    const prev = this.bent.get(k);
    if (!prev) return [];
    this.bent.delete(k);
    return [{ type: 'bend', voiceId: prev.voiceId, semitones: 0 }];
  }

  /**
   * Routing changed (Omni toggled, another voice tab selected, voices removed): a wheel
   * held off-centre moves with its channel — the old voice is recentred, the new target
   * gets the same bend. Notes stay on the voice they started on.
   */
  retarget(routing: MidiRouting): MidiVoiceEvent[] {
    const out: MidiVoiceEvent[] = [];
    for (const [k, b] of [...this.bent]) {
      const v = targetVoice((k % 16) + 1, routing);
      if (v === b.voiceId) continue;
      out.push({ type: 'bend', voiceId: b.voiceId, semitones: 0 });
      if (v === null) {
        this.bent.delete(k);
      } else {
        this.bent.set(k, { voiceId: v, semitones: b.semitones });
        out.push({ type: 'bend', voiceId: v, semitones: b.semitones });
      }
    }
    return out;
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
    for (const [k, b] of [...this.bent]) {
      if (Math.floor(k / 16) !== source) continue;
      this.bent.delete(k);
      out.push({ type: 'bend', voiceId: b.voiceId, semitones: 0 });
    }
    return out;
  }

  /** MIDI turned off / input switched: release everything and recentre all bends. */
  releaseAll(): MidiVoiceEvent[] {
    const out: MidiVoiceEvent[] = this.voicesOff(new Set(this.held.values()));
    for (const v of new Set([...this.bent.values()].map((b) => b.voiceId))) out.push({ type: 'bend', voiceId: v, semitones: 0 });
    this.bent.clear();
    return out;
  }
}

// ---- CC → parameter map ----

/**
 * Controller targets. The first five drive every voice (position / LFO depth / LFO rate are
 * the Simple voice's; on a Synth voice position is osc A's); the rest are Synth voice
 * parameters (on a Simple voice they set its stored synth settings, unheard until it
 * becomes a Synth voice).
 */
export const CC_PARAMS = [
  'position',
  'positionY',
  'lfoDepth',
  'lfoRate',
  'level',
  'cutoff',
  'resonance',
  'drive',
  'filterEnv',
  'oscMix',
  'subLevel',
  'noiseLevel',
  'glide',
  'lfo1Rate',
  'lfo1Depth',
  'lfo2Rate',
  'lfo2Depth',
  'lfo3Rate',
  'lfo3Depth',
] as const;
export type CcParam = (typeof CC_PARAMS)[number];

export const CC_PARAM_LABELS: Readonly<Record<CcParam, string>> = {
  position: 'Position X',
  positionY: 'Position Y',
  lfoDepth: 'LFO depth',
  lfoRate: 'LFO rate',
  level: 'Level',
  cutoff: 'Cutoff',
  resonance: 'Resonance',
  drive: 'Drive',
  filterEnv: 'Filter env amount',
  oscMix: 'Osc A / B mix',
  subLevel: 'Sub level',
  noiseLevel: 'Noise level',
  glide: 'Glide',
  lfo1Rate: 'LFO 1 rate',
  lfo1Depth: 'LFO 1 depth',
  lfo2Rate: 'LFO 2 rate',
  lfo2Depth: 'LFO 2 depth',
  lfo3Rate: 'LFO 3 rate',
  lfo3Depth: 'LFO 3 depth',
};

/** Targets that only Synth voices hear (the MIDI popover groups them). */
export const CC_SYNTH_PARAMS: ReadonlySet<CcParam> = new Set([
  'cutoff',
  'resonance',
  'drive',
  'filterEnv',
  'oscMix',
  'subLevel',
  'noiseLevel',
  'glide',
  'lfo1Rate',
  'lfo1Depth',
  'lfo2Rate',
  'lfo2Depth',
  'lfo3Rate',
  'lfo3Depth',
]);

/** Synth LFO rate range a controller sweeps (Hz, exponential). */
export const CC_LFO_RATE_MIN = 0.02;
export const CC_LFO_RATE_MAX = 20;

/** Parameter → controller number (0..119), or -1 = unassigned. */
export type CcMap = Readonly<Record<CcParam, number>>;

const UNASSIGNED: CcMap = Object.fromEntries(CC_PARAMS.map((p) => [p, -1])) as Record<CcParam, number>;

/** CC 1 (mod wheel) drives position X; everything else is unassigned until learned. */
export const DEFAULT_CC_MAP: CcMap = { ...UNASSIGNED, position: CC_MOD_WHEEL };

/** Longest glide a controller sets (seconds; quadratic taper). */
export const CC_GLIDE_MAX = 2;

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
  let map: CcMap = UNASSIGNED;
  for (const p of CC_PARAMS) if (p in o) map = assignCc(map, p, validCc(o[p]));
  return map;
}

/**
 * A 7-bit controller value → that parameter's value. LFO rate and cutoff are exponential,
 * filter env amount bipolar (64 ≈ 0), glide quadratic; the rest linear 0..1.
 */
export function ccValue(param: CcParam, value: number): number {
  const x = Math.max(0, Math.min(127, value)) / 127;
  switch (param) {
    case 'lfoRate':
      return LFO_RATE_MIN * Math.pow(LFO_RATE_MAX / LFO_RATE_MIN, x);
    case 'lfo1Rate':
    case 'lfo2Rate':
    case 'lfo3Rate':
      return CC_LFO_RATE_MIN * Math.pow(CC_LFO_RATE_MAX / CC_LFO_RATE_MIN, x);
    case 'cutoff':
      return CUTOFF_MIN * Math.pow(CUTOFF_MAX / CUTOFF_MIN, x);
    case 'filterEnv':
      return x * 2 - 1;
    case 'glide':
      return CC_GLIDE_MAX * x * x;
    default:
      return x;
  }
}

/**
 * One target's change at controller value `value`. LFO targets change one entry of the
 * voice's LFO list, so they need the voice (current values, pending moves included); a
 * rate move also turns tempo sync off (so the knob is heard).
 */
function targetPatch(p: CcParam, value: number, voice?: VoiceParams): VoicePatch | null {
  const v = ccValue(p, value);
  const synth = (s: Partial<SynthParams>): VoicePatch => ({ synth: s });
  switch (p) {
    case 'position':
    case 'positionY':
    case 'lfoDepth':
    case 'lfoRate':
    case 'level':
      return { [p]: v };
    case 'filterEnv':
      return synth({ envAmount: v });
    case 'oscMix':
      // Crossfade: 0 = A only, 1 = B only.
      return synth({ aLevel: 1 - v, bLevel: v });
    case 'lfo1Rate':
    case 'lfo2Rate':
    case 'lfo3Rate':
    case 'lfo1Depth':
    case 'lfo2Depth':
    case 'lfo3Depth': {
      if (!voice) return null;
      const n = Number(p[3]) - 1;
      const rate = p.endsWith('Rate');
      return synth({ lfos: voice.synth.lfos.map((l, i) => (i !== n ? l : rate ? { ...l, rate: v, sync: false } : { ...l, depth: v })) });
    }
    default:
      return synth({ [p]: v });
  }
}

/**
 * The voice-parameter change a controller move makes, or null if it is unmapped. `voice`
 * (its current params) is needed for the LFO targets.
 */
export function ccPatch(map: CcMap, cc: number, value: number, voice?: VoiceParams): VoicePatch | null {
  let patch: VoicePatch | null = null;
  for (const p of CC_PARAMS) {
    if (map[p] !== cc) continue;
    const t = targetPatch(p, value, voice);
    if (t) patch = mergeVoicePatch(patch ?? undefined, t);
  }
  return patch;
}


