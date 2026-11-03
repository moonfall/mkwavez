/**
 * Web MIDI access (browser only): permission, input list with hot-plug, the chosen
 * input(s) ('off' | 'all' | an input id), and raw messages handed straight to `onMessage`
 * from the MIDI event (never through the UI frame loop). Unsupported browsers (Safari,
 * insecure origins), a denied permission and errors become a status, never an exception.
 */

export type WebMidiState =
  /** Not requested yet (input 'off' and never enabled). */
  | 'idle'
  | 'pending'
  | 'ready'
  /** No navigator.requestMIDIAccess (e.g. Safari). */
  | 'unsupported'
  /** Web MIDI needs a secure context (HTTPS or localhost). */
  | 'insecure'
  | 'denied'
  | 'error';

export interface WebMidiInput {
  id: string;
  name: string;
  /** Small integer per input, stable for the session (router source). */
  source: number;
}

/** Short status text and a longer explanation for each state. */
export function webMidiMessage(state: WebMidiState, detail = ''): { short: string; long: string } {
  switch (state) {
    case 'unsupported':
      return { short: 'No Web MIDI', long: 'This browser has no Web MIDI (e.g. Safari). Use Chrome, Edge, Firefox or Opera for MIDI input.' };
    case 'insecure':
      return { short: 'MIDI needs HTTPS', long: 'Web MIDI needs a secure page: open mkwavez over HTTPS or on localhost.' };
    case 'denied':
      return { short: 'MIDI blocked', long: 'MIDI access was denied. Allow MIDI devices in the site settings, then pick an input again.' };
    case 'error':
      return { short: 'MIDI error', long: `MIDI failed to start${detail ? `: ${detail}` : ''}.` };
    case 'pending':
      return { short: 'MIDI…', long: 'Waiting for MIDI access…' };
    case 'idle':
      return { short: '', long: 'MIDI is off. Pick an input (or All inputs) to play voices from a MIDI controller.' };
    case 'ready':
      return { short: '', long: '' };
  }
}

export class WebMidi {
  state: WebMidiState = 'idle';
  detail = '';
  /** Connected inputs, in the order the browser lists them. */
  inputs: WebMidiInput[] = [];
  onMessage?: (data: Uint8Array, source: number, timeStamp: number) => void;
  /** An input that was listening went away (unplugged or deselected): release its notes. */
  onSourceLost?: (source: number) => void;
  /** State or input list changed. */
  onChange?: () => void;

  private access: MIDIAccess | null = null;
  private request: Promise<void> | null = null;
  private choice = 'off';
  private sources = new Map<string, number>();
  /** Inputs we are listening to (id → port). */
  private open = new Map<string, MIDIInput>();

  /** Whether the browser can do Web MIDI at all (synchronous; no permission prompt). */
  static check(): WebMidiState | null {
    if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') {
      return typeof isSecureContext !== 'undefined' && !isSecureContext ? 'insecure' : 'unsupported';
    }
    return null;
  }

  /** Listen to 'off', 'all' or one input id. Requests access the first time it's needed. */
  async select(choice: string): Promise<void> {
    this.choice = choice;
    if (choice === 'off') {
      this.attach();
      return;
    }
    await this.enable();
    this.attach();
  }

  get selected(): string {
    return this.choice;
  }

  private enable(): Promise<void> {
    if (this.access) return Promise.resolve();
    if (this.request) return this.request;
    const bad = WebMidi.check();
    if (bad) {
      this.setState(bad);
      return Promise.resolve();
    }
    this.setState('pending');
    this.request = navigator
      .requestMIDIAccess({ sysex: false })
      .then((access) => {
        this.access = access;
        access.onstatechange = () => {
          this.refresh();
          this.attach();
        };
        this.refresh();
        this.state = 'ready'; // select() attaches next and notifies
      })
      .catch((err: unknown) => {
        const name = (err as { name?: string })?.name ?? '';
        this.detail = String((err as { message?: string })?.message ?? err);
        this.setState(name === 'SecurityError' || name === 'NotAllowedError' ? 'denied' : 'error');
      })
      .finally(() => {
        this.request = null;
      });
    return this.request;
  }

  /** Re-read the connected inputs (attach() follows and notifies). */
  private refresh(): void {
    const list: WebMidiInput[] = [];
    this.access?.inputs.forEach((port) => {
      if (port.state !== 'connected') return;
      let source = this.sources.get(port.id);
      if (source === undefined) this.sources.set(port.id, (source = this.sources.size + 1));
      list.push({ id: port.id, name: port.name || port.manufacturer || 'MIDI input', source });
    });
    this.inputs = list;
  }

  /** Listen to exactly the chosen, connected inputs; release notes of any we stop hearing. */
  private attach(): void {
    const want = new Map<string, MIDIInput>();
    if (this.access && this.choice !== 'off') {
      this.access.inputs.forEach((port) => {
        if (port.state === 'connected' && (this.choice === 'all' || this.choice === port.id)) want.set(port.id, port);
      });
    }
    for (const [id, port] of this.open) {
      if (want.get(id) === port) continue;
      port.onmidimessage = null;
      // Release the port: some (Windows) drivers allow one client per device.
      if (port.state === 'connected') port.close?.().catch(() => {});
      this.open.delete(id);
      this.onSourceLost?.(this.sources.get(id) ?? 0);
    }
    for (const [id, port] of want) {
      if (this.open.has(id)) continue;
      const source = this.sources.get(id) ?? 0;
      // Setting the handler opens the port implicitly.
      port.onmidimessage = (e: MIDIMessageEvent) => {
        if (e.data) this.onMessage?.(e.data, source, e.timeStamp);
      };
      this.open.set(id, port);
    }
    this.onChange?.();
  }

  /** Number of inputs currently being listened to. */
  get listening(): number {
    return this.open.size;
  }

  private setState(s: WebMidiState): void {
    this.state = s;
    this.onChange?.();
  }
}
