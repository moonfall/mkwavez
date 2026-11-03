/**
 * Main-thread MIDI glue (no Web MIDI here; see browser/webMidi.ts): raw messages →
 * core MidiRouter → note / bend events to the engine (via `sink`), controller moves →
 * the CC map → AppModel voice params (so sliders follow the knob). Owns the persisted
 * settings (input choice, Omni, CC map) and the learn mode.
 */
import {
  assignCc,
  CC_MOD_WHEEL,
  ccPatch,
  DEFAULT_CC_MAP,
  isLearnableCc,
  MidiRouter,
  normalizeCcMap,
  parseMidi,
  type CcMap,
  type CcParam,
  type MidiRouting,
  type MidiVoiceEvent,
} from '../core/midi';
import { applyVoicePatch, mergeVoicePatch, type VoicePatch } from '../core/voice';

import type { AppModel } from './model';

/** Input choice: 'off', 'all', or an input's id. */
export type MidiInputChoice = string;

export interface MidiSettings {
  input: MidiInputChoice;
  /** Name of the chosen input (shown while it is unplugged). */
  inputName: string;
  omni: boolean;
  cc: CcMap;
}

export const DEFAULT_MIDI_SETTINGS: MidiSettings = { input: 'off', inputName: '', omni: false, cc: DEFAULT_CC_MAP };

/** Minimal key-value store (localStorage in the browser; may throw or be absent). */
export interface SettingsStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export const MIDI_STORAGE_KEY = 'mkwavez.midi';

/** Where routed MIDI goes: note / bend events and light param patches, both to the engine. */
export interface MidiOutput {
  notes(events: readonly MidiVoiceEvent[]): void;
  params(voiceId: number, patch: VoicePatch): void;
}

/** 'settings' = input / Omni / CC map changed; 'learn' = learn target changed; 'activity' = a message arrived. */
export type MidiTopic = 'settings' | 'learn' | 'activity';

export function parseSettings(raw: string | null): MidiSettings {
  if (!raw) return DEFAULT_MIDI_SETTINGS;
  try {
    const o = JSON.parse(raw) as Partial<MidiSettings>;
    return {
      input: typeof o.input === 'string' && o.input ? o.input : 'off',
      inputName: typeof o.inputName === 'string' ? o.inputName : '',
      omni: o.omni === true,
      cc: normalizeCcMap(o.cc),
    };
  } catch {
    return DEFAULT_MIDI_SETTINGS;
  }
}

export class MidiController {
  readonly router = new MidiRouter();
  settings: MidiSettings;
  /** Parameter waiting for a controller move (learn mode), or null. */
  learn: CcParam | null = null;
  private listeners = new Map<MidiTopic, Set<() => void>>();
  /** CC patches not yet applied to the model (per voice), flushed once per `schedule` tick. */
  private pending = new Map<number, VoicePatch>();
  private flushScheduled = false;

  constructor(
    private model: AppModel,
    private out: MidiOutput,
    /** The voice Omni plays (the selected voice tab). */
    private omniVoice: () => number | null,
    private store?: SettingsStore,
    /** Runs the model catch-up later (browser: about once per frame). */
    private schedule: (fn: () => void) => void = queueMicrotask,
  ) {
    let raw: string | null = null;
    try {
      raw = store?.get(MIDI_STORAGE_KEY) ?? null;
    } catch {
      /* storage blocked */
    }
    this.settings = parseSettings(raw);
    // Any other voice change resends the model's voices; fold pending CC values in right
    // away so that batch ends with them (never a stale value between ticks).
    model.on('voices', () => {
      if (this.pending.size) this.flush();
    });
  }

  on(topic: MidiTopic, fn: () => void): () => void {
    let s = this.listeners.get(topic);
    if (!s) this.listeners.set(topic, (s = new Set()));
    s.add(fn);
    return () => s.delete(fn);
  }

  private emit(t: MidiTopic): void {
    for (const fn of this.listeners.get(t) ?? []) fn();
  }

  private save(): void {
    try {
      this.store?.set(MIDI_STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      /* storage full / blocked: settings just aren't remembered */
    }
    this.emit('settings');
  }

  /** One raw MIDI message from input `source` (a small integer per device). */
  handle(data: ArrayLike<number>, source = 0): void {
    const msg = parseMidi(data);
    if (!msg) return;
    this.emit('activity');
    if (msg.kind === 'cc' && this.learn && isLearnableCc(msg.cc)) {
      this.setCc(this.learn, msg.cc);
      this.setLearn(null);
      // Fall through: the move that was learned also applies.
    }
    const routing = this.routing();
    const out: MidiVoiceEvent[] = this.router.retarget(routing);
    for (const ev of this.router.route(msg, routing, source)) {
      if (ev.type !== 'cc') {
        out.push(ev);
        continue;
      }
      // LFO targets edit one entry of a list: start from the voice with pending moves applied.
      const cur = this.model.voice(ev.voiceId);
      const pend = this.pending.get(ev.voiceId);
      // On a Synth voice the mod wheel is a matrix source: CC 1 doesn't also drive Position X.
      const map = cur?.type === 'synth' && ev.cc === CC_MOD_WHEEL && this.settings.cc.position === CC_MOD_WHEEL ? { ...this.settings.cc, position: -1 } : this.settings.cc;
      const patch = ccPatch(map, ev.cc, ev.value, cur && pend ? applyVoicePatch(cur, pend) : cur);
      if (!patch) continue;
      // The engine hears the knob now; the model (sliders, voice/set) catches up once per tick.
      this.out.params(ev.voiceId, patch);
      this.pending.set(ev.voiceId, mergeVoicePatch(this.pending.get(ev.voiceId), patch));
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        this.schedule(() => this.flush());
      }
    }
    if (out.length) this.out.notes(out);
  }

  /** Apply pending CC patches to the model (one 'voices' event for the lot). */
  flush(): void {
    this.flushScheduled = false;
    if (!this.pending.size) return;
    const pending = this.pending;
    this.pending = new Map();
    for (const [id, patch] of pending) if (this.model.voice(id)) this.model.updateVoice(id, patch, { undo: false });

  }

  private routing(): MidiRouting {
    return { omni: this.settings.omni, selectedVoice: this.omniVoice(), voiceIds: this.model.voices.map((v) => v.id) };
  }

  /** The selected voice or the voice list changed: move a held pitch bend with its channel. */
  retarget(): void {
    const evs = this.router.retarget(this.routing());
    if (evs.length) this.out.notes(evs);
  }

  /** An input disconnected (or was deselected): release its notes. */
  sourceLost(source: number): void {
    this.out.notes(this.router.releaseSource(source));
  }

  releaseAll(): void {
    this.out.notes(this.router.releaseAll());
  }

  setInput(input: MidiInputChoice, inputName = ''): void {
    if (input === this.settings.input && inputName === this.settings.inputName) return;
    this.settings = { ...this.settings, input, inputName };
    this.save();
  }

  setOmni(omni: boolean): void {
    if (omni === this.settings.omni) return;
    // Held notes stay tracked to the voice they went to; their note-offs still arrive there.
    this.settings = { ...this.settings, omni };
    this.save();
    this.retarget();
  }

  setCc(param: CcParam, cc: number): void {
    this.settings = { ...this.settings, cc: assignCc(this.settings.cc, param, cc) };
    this.save();
  }

  resetCc(): void {
    this.settings = { ...this.settings, cc: DEFAULT_CC_MAP };
    this.save();
  }

  /** Arm learn for a parameter (null cancels). The next controller move (0..119) is assigned to it. */
  setLearn(param: CcParam | null): void {
    if (param === this.learn) return;
    this.learn = param;
    this.emit('learn');
  }
}
