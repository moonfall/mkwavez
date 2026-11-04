/**
 * Plugin mode: the web app inside the plugin's embedded web view. The native side owns
 * the audio engine, the host's MIDI and the saved state; this glue
 *  - asks for the saved session on load (`hello` → `init` + `records` chunks) and hands it
 *    to the regular restore (app/restore.ts) through PluginSessionStore, the plugin's
 *    session backend: the regular Autosaver then writes the session to the native side,
 *    which saves it with the host's project;
 *  - reconciles with what the engine already plays, then opens the engine port;
 *  - applies host-side changes to the model: transport (host play / tempo, Play / BPM
 *    automation), voice parameter automation, controller moves (learn, LED, sliders);
 *  - keeps the native MIDI routing (input on / off, Omni, selected voice, CC map) in step.
 */
import type { AudioBridge } from '../audio/bridge';
import type { NativePort } from '../audio/nativePort';
import type { FromNative } from '../audio/protocol';
import type { MidiInputs, WebMidiState } from '../browser/webMidi';
import { base64ToBytes, base64ToF32, bytesToBase64, f32ToBase64 } from '../app/base64';
import { MIDI_STORAGE_KEY, type MidiController, type MidiOutput, type SettingsStore } from '../app/midi';
import type { AppModel } from '../app/model';
import type { RestoreStore } from '../app/restore';
import type { SessionMeta, WaveformRecord } from '../core/session';
import type { TableId } from '../core/table';
import type { VoicePatch, VoiceParams } from '../core/voice';

/** Inside the plugin, MIDI comes from the host: on by default, Omni (any channel → selected voice). */
const DEFAULT_PLUGIN_MIDI = JSON.stringify({ input: 'all', inputName: '', omni: true });

const INIT_TIMEOUT_MS = 4000;

/** A waveform record as it travels: JSON with base64 samples. */
export interface WireRecord {
  id: number;
  json: string;
}

export function encodeRecord(r: WaveformRecord): WireRecord {
  return { id: r.id, json: JSON.stringify({ ...r, samples: r.samples ? f32ToBase64(r.samples) : undefined }) };
}

export function decodeRecord(w: WireRecord): WaveformRecord {
  const o = JSON.parse(w.json) as Omit<WaveformRecord, 'samples'> & { samples?: string };
  return { ...o, id: w.id, samples: typeof o.samples === 'string' ? base64ToF32(o.samples) : undefined };
}

interface InitMessage {
  type: 'init';
  /** The saved session's meta (JSON), or null. */
  meta: string | null;
  /** Number of waveform records that follow in `records` chunks. */
  records: number;
  /** Plugin-only settings (JSON object of strings): MIDI routing. */
  settings?: string | null;
  sampleRate?: number;
  /** Current host parameter values per voice (they win over the saved session). */
  voices?: { id: number; patch: Partial<VoiceParams> }[];
  /** Current host transport. */
  transport?: { playing: boolean; bpm: number };
  /** What the engine holds now. */
  engine?: { tables: number[]; wavetables: number[]; voices: number[]; sequences: number[] };
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

/** A session set aside because it couldn't be restored (kept in memory while the editor is open). */
interface KeptSession {
  info: { key: number; savedAt: number; error: string; maxId: number; count: number };
  meta: unknown;
  records: WaveformRecord[];
}

/**
 * The plugin's session backend: a mirror of what the native side stores (so reads are
 * synchronous answers), with every write forwarded to it.
 */
export class PluginSessionStore implements RestoreStore {
  meta: unknown = undefined;
  readonly records = new Map<TableId, WaveformRecord>();
  private kept: KeptSession[] = [];

  constructor(private port: NativePort) {}

  load(): Promise<{ meta: unknown; records: Map<number, WaveformRecord> }> {
    return Promise.resolve({ meta: this.meta, records: new Map(this.records) });
  }
  loadMeta(): Promise<unknown> {
    return Promise.resolve(this.meta);
  }
  keys(): Promise<number[]> {
    return Promise.resolve([...this.records.keys()]);
  }
  putWaveforms(records: readonly WaveformRecord[]): Promise<void> {
    for (const r of records) this.records.set(r.id, r);
    if (records.length) this.port.send({ type: 'session/put', records: records.map(encodeRecord) });
    return Promise.resolve();
  }
  commit(meta: SessionMeta, remove: readonly TableId[], records: readonly WaveformRecord[] = []): Promise<void> {
    for (const r of records) this.records.set(r.id, r);
    for (const id of remove) this.records.delete(id);
    this.meta = meta;
    this.port.send({ type: 'session/commit', meta: JSON.stringify(meta), remove: [...remove], records: records.map(encodeRecord) });
    return Promise.resolve();
  }
  remove(ids: readonly TableId[]): Promise<void> {
    for (const id of ids) this.records.delete(id);
    if (ids.length) this.port.send({ type: 'session/remove', ids: [...ids] });
    return Promise.resolve();
  }
  clear(): Promise<void> {
    this.meta = undefined;
    this.records.clear();
    this.port.send({ type: 'session/clear' });
    return Promise.resolve();
  }
  keptList(): Promise<KeptSession['info'][]> {
    return Promise.resolve(this.kept.map((k) => k.info));
  }
  keep(meta: unknown, records: readonly WaveformRecord[], error: string): Promise<void> {
    const savedAt = typeof meta === 'object' && meta !== null && typeof (meta as { savedAt?: unknown }).savedAt === 'number' ? (meta as { savedAt: number }).savedAt : 0;
    const maxId = records.reduce((m, r) => Math.max(m, r.id), 0);
    this.kept.push({ info: { key: Date.now(), savedAt, error, maxId, count: records.length }, meta, records: [...records] });
    return this.clear();
  }
  loadKept(key: number): Promise<KeptSession | undefined> {
    return Promise.resolve(this.kept.find((k) => k.info.key === key));
  }
  clearKept(key: number): Promise<void> {
    this.kept = this.kept.filter((k) => k.info.key !== key);
    return Promise.resolve();
  }
}

export class PluginHost {
  /** Plugin-only settings (MIDI routing), saved by the native side. */
  readonly settings = new Map<string, string>();
  readonly store: SettingsStore = {
    get: (k) => this.settings.get(k) ?? null,
    set: (k, v) => {
      this.settings.set(k, v);
      this.port.send({ type: 'settings', json: JSON.stringify(Object.fromEntries(this.settings)) });
    },
  };
  readonly midiInputs = new HostMidi();
  readonly session: PluginSessionStore;
  /** Messages for the user about native file saves (the UI shows them as notices). */
  onFileMessage?: (text: string) => void;
  private openRequests = new Map<number, (f: File | null) => void>();
  private nextOpenId = 1;
  private init: InitMessage | null = null;
  private midi: MidiController | null = null;
  private selectedVoice: () => number | null = () => null;

  constructor(
    private model: AppModel,
    private bridge: AudioBridge,
    private port: NativePort,
  ) {
    this.session = new PluginSessionStore(port);
  }

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
   * Ask the native side for the saved session and settings (fills `session`). Never
   * rejects: without an answer the session store stays empty (a fresh session).
   */
  async connect(): Promise<void> {
    this.init = await this.requestInit();
    if (this.init?.settings) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(this.init.settings) as Record<string, unknown>)) if (typeof v === 'string') this.settings.set(k, v);
      } catch {
        /* ignore bad settings */
      }
    }
    if (!this.settings.has(MIDI_STORAGE_KEY)) this.settings.set(MIDI_STORAGE_KEY, DEFAULT_PLUGIN_MIDI);
  }

  /**
   * After the model holds the restored (or fresh) session: host parameter values and
   * transport win over it (automation while the editor was closed), the bridge adopts what
   * the engine plays (`restored`: the same session, so its tables are kept), and the
   * engine port opens.
   */
  async start(restored: boolean): Promise<void> {
    const init = this.init;
    for (const v of init?.voices ?? []) this.applyVoiceParams(v.id, v.patch);
    if (init?.transport) this.model.setTransport({ playing: init.transport.playing, bpm: init.transport.bpm });
    if (init?.engine) this.bridge.adoptEngine(init.engine, restored);
    this.port.onHost = (m) => this.onHost(m as FromNative);
    await this.bridge.start();
  }

  /**
   * Native file dialogs (FileHost for ui/session.ts): embedded web views don't all offer
   * downloads, so exports go to a native save dialog; imports come from a native open dialog.
   */
  readonly files = {
    save: (bytes: Uint8Array, name: string): void => {
      this.port.send({ type: 'file/save', name, data: bytesToBase64(bytes) });
    },
    open: (accept: string): Promise<File | null> =>
      new Promise((resolve) => {
        const id = this.nextOpenId++;
        this.openRequests.set(id, resolve);
        this.port.send({ type: 'file/open', id, accept });
      }),
  };

  /** Wire the MIDI controller (after the UI made it): routing to native, CC moves from native. */
  attachMidi(midi: MidiController, selectedVoice: () => number | null, onVoiceTab: (fn: () => void) => void): void {
    this.midi = midi;
    this.selectedVoice = selectedVoice;
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
        this.onFileReply(m as unknown as FileReply);
        return;
    }
  }

  private onFileReply(m: FileReply): void {
    if (m.type === 'file/saved') {
      this.onFileMessage?.(m.error ? `Couldn’t save “${m.name}”: ${m.error}` : `Saved ${m.path ?? m.name}`);
    } else if (m.type === 'file/opened') {
      const resolve = this.openRequests.get(m.id);
      if (!resolve) return;
      this.openRequests.delete(m.id);
      if (m.error) this.onFileMessage?.(`Couldn’t open the file: ${m.error}`);
      resolve(typeof m.data === 'string' && m.name ? new File([base64ToBytes(m.data) as BlobPart], m.name) : null);
    }
  }

  /** Automated fields only (window / wavetable stay with the UI); not undoable, like a slider move. */
  private applyVoiceParams(id: number, raw: Partial<VoiceParams>): void {
    const v = this.model.voice(id);
    if (!v) return;
    const patch: Record<string, unknown> = {};
    // Parameters are float32: ignore differences below their precision.
    const same = (x: unknown, cur: unknown) => x === cur || (typeof x === 'number' && typeof cur === 'number' && Math.abs(x - cur) <= 1e-6 * Math.max(1, Math.abs(cur)));
    for (const [k, x] of Object.entries(raw)) {
      if (!AUTOMATED.has(k)) continue;
      const cur = (v as unknown as Record<string, unknown>)[k];
      if (!same(x, cur)) patch[k] = x;
    }
    const synth: Record<string, unknown> = {};
    const rawSynth = (raw as { synth?: Record<string, unknown> }).synth;
    if (rawSynth && typeof rawSynth === 'object') {
      for (const [k, x] of Object.entries(rawSynth)) {
        if (!SYNTH_AUTOMATED.has(k) || typeof x !== 'number' || !Number.isFinite(x)) continue;
        if (!same(x, (v.synth as unknown as Record<string, unknown>)[k])) synth[k] = x;
      }
    }
    if (Object.keys(synth).length) patch.synth = synth;
    if (Object.keys(patch).length) this.model.updateVoice(id, patch as VoicePatch);
  }

  /** `hello` → `init` (+ record chunks). Null if the native side doesn't answer in time. */
  private requestInit(): Promise<InitMessage | null> {
    return new Promise((resolve) => {
      let init: InitMessage | null = null;
      let count = 0;
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        this.port.onHost = undefined;
        if (ok && init?.meta) {
          try {
            this.session.meta = JSON.parse(init.meta) as unknown;
          } catch {
            this.session.meta = init.meta; // restore reports it as corrupt (and keeps it)
          }
        }
        resolve(ok ? init : null);
      };
      const timer = setTimeout(() => {
        console.warn('[plugin] no answer from the native side; starting fresh');
        finish(false);
      }, INIT_TIMEOUT_MS);
      this.port.onHost = (raw) => {
        const m = raw as { type: string; items?: WireRecord[] };
        if (m.type === 'init') {
          init = raw as unknown as InitMessage;
          if (typeof init.sampleRate === 'number' && init.sampleRate > 0) this.port.sampleRate = init.sampleRate;
          if (count >= init.records) finish(true);
        } else if (m.type === 'records' && Array.isArray(m.items)) {
          for (const w of m.items) {
            try {
              const r = decodeRecord(w);
              this.session.records.set(r.id, r);
            } catch (e) {
              console.warn('[plugin] bad waveform record', w.id, e);
            }
            count++;
          }
          if (init && count >= init.records) finish(true);
        }
      };
      this.port.send({ type: 'hello' });
    });
  }
}

/** Native answers to file/save and file/open. */
type FileReply =
  | { type: 'file/saved'; name: string; path?: string; error?: string }
  | { type: 'file/opened'; id: number; name?: string; data?: string | null; error?: string };

/**
 * Synth fields the plugin exposes as host parameters (plugin/source/Parameters.h SynthField):
 * the four macros, then the main sound controls.
 */
const SYNTH_AUTOMATED = new Set<string>([
  'macro1', 'macro2', 'macro3', 'macro4', 'cutoff', 'resonance', 'envAmount', 'drive', 'aLevel', 'bLevel', 'aWarpAmt', 'bWarpAmt', 'fm', 'pan', 'width', 'glide',
]);

/** Voice fields the plugin exposes as host parameters (window / wavetable stay in the UI). */
const AUTOMATED = new Set<string>([
  'position', 'positionY', 'lfoDepth', 'lfoRate', 'lfoDepthY', 'lfoRateY', 'octave', 'level', 'mute', 'attack', 'decay', 'sustain', 'release',
]);
