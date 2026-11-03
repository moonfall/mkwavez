/**
 * Main-thread MIDI glue (no Web MIDI here; see browser/webMidi.ts): raw messages →
 * core MidiRouter → note / bend events to the engine (via `sink`), controller moves →
 * the CC map → AppModel voice params (so sliders follow the knob). Owns the persisted
 * settings (input choice, Omni, CC map) and the learn mode.
 */
import {
  assignCc,
  CC_MAX_ASSIGNABLE,
  ccPatch,
  DEFAULT_CC_MAP,
  MidiRouter,
  normalizeCcMap,
  parseMidi,
  type CcMap,
  type CcParam,
  type MidiVoiceEvent,
} from '../core/midi';
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

  constructor(
    private model: AppModel,
    private sink: (events: readonly MidiVoiceEvent[]) => void,
    /** The voice Omni plays (the selected voice tab). */
    private omniVoice: () => number | null,
    private store?: SettingsStore,
  ) {
    let raw: string | null = null;
    try {
      raw = store?.get(MIDI_STORAGE_KEY) ?? null;
    } catch {
      /* storage blocked */
    }
    this.settings = parseSettings(raw);
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
    if (msg.kind === 'cc' && this.learn && msg.cc <= CC_MAX_ASSIGNABLE) {
      this.setCc(this.learn, msg.cc);
      this.setLearn(null);
      // Fall through: the move that was learned also applies.
    }
    const evs = this.router.route(
      msg,
      { omni: this.settings.omni, selectedVoice: this.omniVoice(), voiceIds: this.model.voices.map((v) => v.id) },
      source,
    );
    const out: MidiVoiceEvent[] = [];
    for (const ev of evs) {
      if (ev.type !== 'cc') {
        out.push(ev);
        continue;
      }
      const patch = ccPatch(this.settings.cc, ev.cc, ev.value);
      if (patch) this.model.updateVoice(ev.voiceId, patch);
    }
    if (out.length) this.sink(out);
  }

  /** An input disconnected (or was deselected): release its notes. */
  sourceLost(source: number): void {
    this.sink(this.router.releaseSource(source));
  }

  releaseAll(): void {
    this.sink(this.router.releaseAll());
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
