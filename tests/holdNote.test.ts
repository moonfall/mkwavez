import { describe, expect, it } from 'vitest';
import type { AudioState } from '../src/audio/bridge';
import type { MidiVoiceEvent } from '../src/core/midi';
import { midiNoteName, NoteHolder } from '../src/ui/holdNote';

function fakeBridge(state: AudioState = 'running') {
  const sent: MidiVoiceEvent[][] = [];
  const fns: ((s: AudioState) => void)[] = [];
  const b = {
    state,
    starts: 0,
    sent,
    async start() {
      b.starts++;
      b.setState('starting');
      await Promise.resolve();
      b.setState('running');
    },
    sendMidi(evs: readonly MidiVoiceEvent[]) {
      if (b.state === 'running') sent.push([...evs]);
    },
    onStateChange(fn: (s: AudioState) => void) {
      fns.push(fn);
    },
    setState(s: AudioState) {
      b.state = s;
      for (const fn of fns) fn(s);
    },
  };
  return b;
}

describe('Hold (play a note without a keyboard)', () => {
  it('names notes with middle C = C4', () => {
    expect([midiNoteName(60), midiNoteName(50), midiNoteName(24), midiNoteName(61)]).toEqual(['C4', 'D3', 'C1', 'C♯4']);
  });

  it('toggles a held note per voice, and moves it to a new note', async () => {
    const b = fakeBridge();
    const h = new NoteHolder(b);
    h.toggle(1, 50);
    await Promise.resolve();
    expect(h.heldNote(1)).toBe(50);
    expect(b.sent.at(-1)).toEqual([{ type: 'noteOn', voiceId: 1, note: 50, velocity: 100 }]);
    await h.hold(1, 55);
    expect(b.sent.at(-1)).toEqual([
      { type: 'noteOff', voiceId: 1, note: 50 },
      { type: 'noteOn', voiceId: 1, note: 55, velocity: 100 },
    ]);
    await h.hold(2, 40);
    h.toggle(1, 55);
    expect(b.sent.at(-1)).toEqual([{ type: 'noteOff', voiceId: 1, note: 55 }]);
    expect([h.heldNote(1), h.heldNote(2)]).toEqual([undefined, 40]);
  });

  it('starts audio first (a user gesture), so the note sounds', async () => {
    const b = fakeBridge('off');
    const h = new NoteHolder(b);
    await h.hold(3, 48);
    expect(b.starts).toBe(1);
    expect(h.heldNote(3)).toBe(48);
    expect(b.sent).toEqual([[{ type: 'noteOn', voiceId: 3, note: 48, velocity: 100 }]]);
  });

  it('forgets holds when audio stops or the voice is removed', async () => {
    const b = fakeBridge();
    const h = new NoteHolder(b);
    let changes = 0;
    h.onChange(() => changes++);
    await h.hold(1, 48);
    await h.hold(2, 48);
    h.keepOnly([2]);
    expect([h.heldNote(1), h.heldNote(2)]).toEqual([undefined, 48]);
    b.setState('off');
    expect(h.heldNote(2)).toBeUndefined();
    expect(changes).toBe(4);
  });
});
