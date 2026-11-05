import type { AudioBridge } from '../audio/bridge';
import type { MidiVoiceEvent } from '../core/midi';
import type { UiContext } from './context';
import { h } from './dom';
import { SHORTCUTS } from './shortcuts';

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
/** The note picker's range (MIDI notes; 60 = C4 = middle C). */
export const HOLD_NOTE_MIN = 24;
export const HOLD_NOTE_MAX = 96;
export const HOLD_NOTE_DEFAULT = 48;
const HOLD_VELOCITY = 100;
const PREF = 'holdNote';

export const midiNoteName = (n: number) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

/**
 * Hold keys without a MIDI keyboard: per voice, at most one held note (`voiceId → note`).
 * Pressing sends a note-on to the engine (starting audio if it isn't running: a user
 * gesture) and the note sustains until released; changing the note while held moves it.
 * Notes go to the engine like routed MIDI (they take over from the voice's sequence, and
 * the transport may stay stopped). Holds are dropped when audio stops or a voice goes.
 */
export class NoteHolder {
  private held = new Map<number, number>();
  private fns: (() => void)[] = [];

  constructor(private bridge: Pick<AudioBridge, 'state' | 'start' | 'sendMidi' | 'onStateChange'>) {
    bridge.onStateChange((s) => {
      // 'starting' is on the way to running (the first press starts audio): keep the hold.
      if ((s === 'off' || s === 'error') && this.held.size) {
        this.held.clear();
        this.emit();
      }
    });
  }

  onChange(fn: () => void): void {
    this.fns.push(fn);
  }

  private emit(): void {
    for (const fn of this.fns) fn();
  }

  heldNote(voiceId: number): number | undefined {
    return this.held.get(voiceId);
  }

  private async send(events: MidiVoiceEvent[]): Promise<void> {
    if (this.bridge.state !== 'running') await this.bridge.start();
    this.bridge.sendMidi(events);
  }

  /** Hold `note` on the voice (moving its held note if it has another). */
  hold(voiceId: number, note: number): Promise<void> {
    const old = this.held.get(voiceId);
    if (old === note) return Promise.resolve();
    const evs: MidiVoiceEvent[] = [];
    if (old !== undefined) evs.push({ type: 'noteOff', voiceId, note: old });
    evs.push({ type: 'noteOn', voiceId, note, velocity: HOLD_VELOCITY });
    this.held.set(voiceId, note);
    this.emit();
    return this.send(evs).catch((err) => {
      console.warn('Audio failed to start', err);
      if (this.held.get(voiceId) === note) this.held.delete(voiceId);
      this.emit();
    });
  }

  release(voiceId: number): void {
    const note = this.held.get(voiceId);
    if (note === undefined) return;
    this.held.delete(voiceId);
    if (this.bridge.state === 'running') this.bridge.sendMidi([{ type: 'noteOff', voiceId, note }]);
    this.emit();
  }

  toggle(voiceId: number, note: number): void {
    if (this.held.has(voiceId)) this.release(voiceId);
    else void this.hold(voiceId, note);
  }

  /** Forget holds on voices that no longer exist (the engine dropped their notes with them). */
  keepOnly(ids: Iterable<number>): void {
    const keep = new Set(ids);
    let changed = false;
    for (const id of [...this.held.keys()]) {
      if (!keep.has(id)) {
        this.held.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit();
  }
}

/**
 * The transport bar's note picker and Hold button (H): the selected voice plays the note
 * and sustains it until Hold is pressed again.
 */
export function buildHoldNote(ctx: UiContext): { el: HTMLElement; toggle(): void; sync(): void } {
  const { model, bridge, ui } = ctx;
  const holder = new NoteHolder(bridge);
  const validNote = (v: unknown) => Number.isInteger(v) && (v as number) >= HOLD_NOTE_MIN && (v as number) <= HOLD_NOTE_MAX;
  let note = ui.pref(PREF, HOLD_NOTE_DEFAULT, validNote);

  const select = h(
    'select',
    { id: 'hold-note', class: 'hold-note', 'aria-label': 'Note to hold', title: 'Note the Hold button plays' },
    ...Array.from({ length: HOLD_NOTE_MAX - HOLD_NOTE_MIN + 1 }, (_, i) => h('option', { value: String(HOLD_NOTE_MIN + i) }, midiNoteName(HOLD_NOTE_MIN + i))),
  );
  const btn = h('button', { id: 'hold-key', class: 'hold-key', 'aria-pressed': 'false', 'aria-keyshortcuts': SHORTCUTS.hold }, 'Hold');

  const toggle = () => {
    if (ui.voiceId !== null && model.voice(ui.voiceId)) holder.toggle(ui.voiceId, note);
  };
  btn.addEventListener('click', toggle);
  select.addEventListener('change', () => {
    note = Number(select.value);
    ui.setPref(PREF, note);
    // A held note follows the picker (audition the wavetable up and down the keyboard).
    if (ui.voiceId !== null && holder.heldNote(ui.voiceId) !== undefined) void holder.hold(ui.voiceId, note);
  });

  const sync = () => {
    holder.keepOnly(model.voices.map((v) => v.id));
    const v = ui.voiceId === null ? undefined : model.voice(ui.voiceId);
    const held = v ? holder.heldNote(v.id) : undefined;
    el.hidden = !v;
    if (!v) return;
    const shown = held ?? note;
    if (document.activeElement !== select) select.value = String(shown);
    btn.setAttribute('aria-pressed', String(held !== undefined));
    btn.title =
      held !== undefined ? `Release ${midiNoteName(held)} on ${v.name} (${SHORTCUTS.hold})` : `Play and sustain ${midiNoteName(note)} on ${v.name} until pressed again (${SHORTCUTS.hold})`;
    btn.setAttribute('aria-label', held !== undefined ? `Release held ${midiNoteName(held)}` : `Hold ${midiNoteName(note)}`);
  };

  const el = h('span', { class: 'hold', id: 'hold' }, select, btn);
  holder.onChange(sync);
  model.on('voices', sync);
  ui.onVoice(sync);
  sync();
  return { el, toggle, sync };
}
