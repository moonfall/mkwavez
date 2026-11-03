# mkwavez

An evolving wavetable synth: single-cycle waveforms are continually generated (later:
mutated, bred, sampled) onto a growing timeline, and each voice plays a movable window
over a wavetable built from it. This browser build is the development testbed; the
`src/core/` DSP/data code is written to port to a plugin (JUCE/C++) and hardware.

See `docs/prototype-handoff.md` (original spec + prototype), `docs/ARCHITECTURE.md`
and `docs/ROADMAP.md`.

## Run

Requires Node 20+.

```sh
npm install
npm run dev        # http://localhost:5173 — press Play to start audio
npm test           # core unit tests (vitest)
npx tsc --noEmit   # typecheck
npm run build      # typecheck + production build to dist/
npm run smoke      # build, then headless-Chrome smoke test against preview and dev servers
```

The smoke test uses `/usr/bin/google-chrome` by default (`CHROME=/path` to override;
`SHOTS=dir` saves screenshots at 1440×900, 1180×820, 1920×1080 and 390×844, dark and light).

## Using it

On a laptop / tablet (≥ 900 px wide) everything is on one screen: the transport bar
(play, BPM, undo, MIDI, table count, sample rate, theme toggle), then Generate | Wavetables,
the Timeline strip, and Voice | Sequence. Panels scroll internally when their content
doesn't fit (e.g. the Mutate / Breed tabs). Narrower screens get one scrolling column
of the same panels, each collapsible. Dark theme by default; the sun / moon button
switches (the choice is remembered).

- **Generate → Seed**: pick from the library (basic waves, formula presets by
  category, Perlin noise, cellular automaton, a blank formula). Search filters by name,
  category or formula text (Enter picks the first match, ↓ moves into the list, Esc
  clears); ▲/▼ or the arrow keys step through the (filtered) list. On a phone the library
  is one row (▲ · Category › Name · ▼); tap the name for the list. Edit the formula (JS in
  `p`, `t`, `n`, `u`, `pnoise()`; "Revert to preset") or the mode's parameters. The
  large view shows one table of the batch with its spectrum; the strip below shows all N
  (click, or ←/→ when focused). The previews are exactly what gets added: "Add shown"
  adds that one table, "Add batch (+N)" all N and sets the window of every voice ticked
  under "Sets window of". Modes that use randomness show the seed (Reroll); a new seed is
  drawn after each Add batch.
- **Generate → Mutate**: mutate the table selected in the Timeline (source and live
  preview side by side). Pick a mutation and Amount; the shown seed is used by the
  preview, Apply and every table of Apply N (Linear / Log sweep or Chain). Reroll
  draws a new seed; one is drawn after each Apply. Evolve keeps mutating the newest
  table on a timer.
- **Generate → Breed**: combine 2–8 parents. Shift-click (or ⌘-click) or
  long-press tables in the Timeline, "Add selected", or "Use window" of a voice; reorder
  or remove them on their cards. Pick an operator (crossfade, spectral mix, magnitude /
  phase swaps, envelope transfer, harmonic split, genetic masks, time splice), a Bias
  (0 = parent A) and how it walks the parents (path, ring, custom weights), and a
  Mutation rate. Breed adds one child; Breed N sweeps the bias or makes a seeded
  generation of N children.
- **Timeline**: every table, in order (cap 4096), as one horizontally scrolling strip
  (a vertical mouse wheel scrolls it sideways). Click to select (the header names the
  selection); Shift-click / long-press toggles Breed parents (badged A, B, …). A table
  inside a voice's window is tinted in the voice's colour (unmuted strong, muted faint)
  with a solid edge at the window's start / end; overlapping windows split the cell into
  bands, voice 1 on top. Carets show each unmuted voice's live play position. The header
  button cycles the thumbnails: Waveform → Spectral → Waveform + Spectral. The strip keeps
  the selection in view and follows new tables when scrolled to the end.
- **Wavetables**: the auto "All" wavetable as an amplitude heat map with voice windows
  and play positions. Creating 1D / 2D wavetables is coming (the slot is reserved);
  collapsed by default on a phone.
- **Voice**: one tab per voice (V1, V2 · muted, …, + adds one, × removes the selected
  one). The selected voice's wavetable, Blend/Step, octave, window, position, LFO,
  level, mute, plus a "now playing" scope and the ADSR envelope. Only voice 1 starts
  unmuted.
- **Sequence**: follows the selected voice tab: its 8-row pentatonic step grid (rows
  labelled with the voice's notes), steps, gate, copy / paste / clear / random; shared
  tempo. "+ Seq" adds another sequence to the voice (a picker appears).
- **MIDI** (Web MIDI: Chrome, Edge, Firefox, Opera; HTTPS or localhost): pick an input
  (or All inputs) in the transport bar — the choice is remembered and reconnects on load
  and on hot-plug. The LED in the **MIDI** button blinks on activity; the button opens
  routing and the controller map (on a phone the input picker is there too). Channel N
  plays voice VN; **Omni** sends every channel to the selected voice tab. Voices stay
  monophonic: the last key wins, releasing it returns to a key still held (legato, no
  retrigger), velocity sets loudness, pitch bend is ±2 semitones, the voice's octave
  applies. Held keys take over from the voice's sequence (it keeps counting and resumes
  on its next step once all keys are up); stopping the transport doesn't cut held keys.
  All-notes-off / all-sound-off (CC 123 / 120), unplugging the device or switching input
  release held notes. CC map: Position (CC 1, mod wheel, by default), LFO depth, LFO rate,
  Level — type a CC number or press Learn and move a control; remembered. Audio starts
  when you pick an input, or on your first click if the input was remembered (browsers
  only start audio on a gesture). Unsupported browsers / denied permission show a short
  status; the rest of the app is unaffected.
- **Undo** (transport bar) covers table adds (including Apply / Apply N), window
  edits and note edits.
