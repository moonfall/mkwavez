/**
 * Plugin mode: the web app inside the plugin's embedded web view. The native side owns
 * the audio engine, the host's MIDI and the saved state; this glue
 *  - asks for the saved project on load (`hello` → `init` + `tables` chunks) and restores
 *    it, or starts from the start state;
 *  - sends the project back (without samples: the native state holds them) whenever it
 *    changes, so the host saves it with the session;
 *  - applies host-side changes to the model: transport (host play / tempo, Play / BPM
 *    automation), voice parameter automation, controller moves (learn, LED, sliders);
 *  - keeps the native MIDI routing (input on / off, Omni, selected voice, CC map) in step.
 */
import type { AudioBridge } from '../audio/bridge';
import { decodeWireTable, type NativePort, type WireTable } from '../audio/nativePort';
import type { FromNative } from '../audio/protocol';
import type { MidiInputs, WebMidiState } from '../browser/webMidi';
import type { TableId } from '../core/table';
import type { VoiceParams } from '../core/voice';
import { MIDI_STORAGE_KEY, type MidiController, type MidiOutput, type SettingsStore } from '../app/midi';
import type { AppModel, Topic } from '../app/model';
import { parseProject } from '../app/project';
import { applyStartState } from '../app/startState';

/** Inside the plugin, MIDI comes from the host: on by default, Omni (any channel → selected voice). */
const DEFAULT_PLUGIN_MIDI = JSON.stringify({ input: 'all', inputName: '', omni: true });

const SAVE_DEBOUNCE_MS = 300;
const INIT_TIMEOUT_MS = 4000;

interface InitMessage {
  type: 'init';
  project: string | null;
  tables: number;
  sampleRate?: number;
  /** Current host parameter values per voice (they win over the saved project). */
  voices?: { id: number; patch: Partial<VoiceParams> }[];
  /** Current host transport. */
  transport?: { playing: boolean; bpm: number };
  /** Ids the engine holds now (tables are the `tables` chunks). */
  engine?: { wavetables: number[]; voices: number[]; sequences: number[] };
}

/** The host's MIDI as the MIDI panel sees it (one always-ready input). */
export class HostMidi implements MidiInputs {
  state: WebMidiState = 'ready';
  detail = '';
  inputs = [];
  allLabel = 'Host MIDI';
  enabled = true;
  onChange?: () => void;

  get listening(): number {
    return this.enabled ? 1 : 0;
  }

  get listeningText(): string {
    return 'Playing from the host’s MIDI (the track or device routed to this plugin).';
  }

  select(choice: string): Promise<void> {
    this.enabled = choice !== 'off';
    this.onChange?.();
    return Promise.resolve();
  }
}

/** Engine-bound MIDI output: nothing to do (the native side already routed the host's MIDI). */
export const NO_MIDI_OUTPUT: MidiOutput = { notes: () => {}, params: () => {} };

export class PluginHost {
  /** Per-project settings (saved inside the project). */
  readonly settings = new Map<string, string>();
  readonly store: SettingsStore = {
    get: (k) => this.settings.get(k) ?? null,
    set: (k, v) => {
      this.settings.set(k, v);
      this.scheduleSave();
    },
  };
  readonly midiInputs = new HostMidi();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private midi: MidiController | null = null;
  private selectedVoice: () => number | null = () => null;

  constructor(
    private model: AppModel,
    private bridge: AudioBridge,
    private port: NativePort,
  ) {}

  /**
   * Page errors and warnings also go to the native log (the web view has no console in a
   * DAW; MKWAVEZ_WEB_DEBUG=1 prints them).
   */
  forwardLogs(): void {
    const send = (level: 'error' | 'warn', args: unknown[]) => {
      try {
        this.port.send({ type: 'log', level, message: args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : String(a))).join(' ') });
      } catch {
        /* never let logging throw */
      }
    };
    for (const level of ['error', 'warn'] as const) {
      const orig = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        orig(...args);
        send(level, args);
      };
    }
    addEventListener('error', (e) => send('error', [e.error ?? e.message]));
    addEventListener('unhandledrejection', (e) => send('error', ['unhandled rejection:', e.reason]));
  }

  /**
   * Restore the saved project (or the start state) and open the engine port. Resolves
   * once the model is ready; never rejects (falls back to the start state).
   */
  async connect(): Promise<void> {
    const init = await this.requestInit();
    let restored = false;
    if (init?.project) {
      try {
        const p = parseProject(init.project);
        this.model.loadProject(p, init.data);
        for (const [k, v] of Object.entries(p.settings ?? {})) this.settings.set(k, v);
        restored = true;
      } catch (err) {
        console.warn('[plugin] saved project not restored:', err);
      }
    }
    if (!restored) applyStartState(this.model);
    // Reconcile with what the engine holds: restored tables (same project, same ids) aren't
    // re-sent; anything else stale goes.
    if (init) {
      const e = init.engine ?? { wavetables: [], voices: [], sequences: [] };
      this.bridge.adoptEngine({ tables: init.data.keys(), voices: e.voices, sequences: e.sequences, wavetables: e.wavetables }, restored);
    }
    // The host's parameter values and transport win (automation while the editor was closed).
    for (const v of init?.voices ?? []) this.applyVoiceParams(v.id, v.patch);
    if (init?.transport) this.model.setTransport({ playing: init.transport.playing, bpm: init.transport.bpm });
    if (!this.settings.has(MIDI_STORAGE_KEY)) this.settings.set(MIDI_STORAGE_KEY, DEFAULT_PLUGIN_MIDI);
    this.port.onHost = (m) => this.onHost(m as FromNative);
    await this.bridge.start();
    const topics: Topic[] = ['timeline', 'wavetables', 'voices', 'sequences', 'selection', 'parents', 'transport'];
    for (const t of topics) this.model.on(t, () => this.scheduleSave());
    this.saveNow();
  }

  /** Wire the MIDI controller (after the UI made it): routing to native, CC moves from native. */
  attachMidi(midi: MidiController, selectedVoice: () => number | null, onVoiceTab: (fn: () => void) => void): void {
    this.midi = midi;
    this.selectedVoice = selectedVoice;
    this.midiInputs.enabled = midi.settings.input !== 'off';
    const sync = () => this.syncMidi();
    midi.on('settings', sync);
    this.model.on('voices', sync);
    onVoiceTab(sync);
    sync();
  }

  private syncMidi(): void {
    if (!this.midi) return;
    const s = this.midi.settings;
    this.midiInputs.enabled = s.input !== 'off';
    this.bridge.sendOp({ type: 'midi/settings', enabled: s.input !== 'off', omni: s.omni, voice: this.selectedVoice(), cc: s.cc });
  }

  private onHost(m: FromNative): void {
    switch (m.type) {
      case 'transport':
        // Follow the host without echoing it back as a Play / BPM edit.
        this.bridge.withoutTransportEcho(() => this.model.setTransport({ playing: m.playing, bpm: m.bpm }));
        return;
      case 'voice/params':
        this.applyVoiceParams(m.id, m.patch);
        return;
      case 'midi/cc':
        for (const bytes of m.messages) this.midi?.handle(bytes);
        return;
      default:
        return;
    }
  }

  /** Automated fields only (window / wavetable stay with the UI); not undoable, like a slider move. */
  private applyVoiceParams(id: number, raw: Partial<VoiceParams>): void {
    const v = this.model.voice(id);
    if (!v) return;
    const patch: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(raw)) {
      if (!AUTOMATED.has(k)) continue;
      const cur = (v as unknown as Record<string, unknown>)[k];
      // Parameters are float32: ignore differences below their precision.
      if (typeof x === 'number' && typeof cur === 'number' && Math.abs(x - cur) <= 1e-6 * Math.max(1, Math.abs(cur))) continue;
      if (x !== cur) patch[k] = x;
    }
    if (Object.keys(patch).length) this.model.updateVoice(id, patch as Partial<VoiceParams>);
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => this.saveNow(), SAVE_DEBOUNCE_MS);
  }

  private saveNow(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const project = this.model.toProject(false, Object.fromEntries(this.settings));
    this.port.send({ type: 'project', json: JSON.stringify(project) });
  }

  /** `hello` → `init` (+ table chunks). Null if the native side doesn't answer in time. */
  private requestInit(): Promise<(InitMessage & { data: Map<TableId, Float32Array> }) | null> {
    return new Promise((resolve) => {
      let init: InitMessage | null = null;
      const data = new Map<TableId, Float32Array>();
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        this.port.onHost = undefined;
        resolve(ok && init ? { ...init, data } : null);
      };
      const timer = setTimeout(() => {
        console.warn('[plugin] no answer from the native side; starting fresh');
        finish(false);
      }, INIT_TIMEOUT_MS);
      this.port.onHost = (raw) => {
        const m = raw as { type: string; items?: WireTable[] };
        if (m.type === 'init') {
          init = raw as unknown as InitMessage;
          if (typeof init.sampleRate === 'number' && init.sampleRate > 0) this.port.sampleRate = init.sampleRate;
          if (data.size >= init.tables) finish(true);
        } else if (m.type === 'tables' && Array.isArray(m.items)) {
          for (const t of m.items) {
            const d = decodeWireTable(t);
            data.set(d.id, d.data);
          }
          if (init && data.size >= init.tables) finish(true);
        }
      };
      this.port.send({ type: 'hello' });
    });
  }
}

/** Voice fields the plugin exposes as host parameters (window / wavetable stay in the UI). */
const AUTOMATED = new Set<string>([
  'position', 'positionY', 'lfoDepth', 'lfoRate', 'lfoDepthY', 'lfoRateY', 'octave', 'level', 'mute', 'attack', 'decay', 'sustain', 'release',
]);
