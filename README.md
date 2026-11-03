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

## GitHub Pages

`.github/workflows/pages.yml` runs `npm ci`, `npm test` and `npm run build` on every push
to `main` (or by hand: Actions → Deploy to GitHub Pages → Run workflow) and deploys
`dist/` to `https://<owner>.github.io/<repo>/`, e.g. https://moonfall.github.io/mkwavez/.

- One-time setup: the repo's **Settings → Pages → Source: GitHub Actions**. On free plans
  Pages needs a public repository.
- The build uses `base: './'` (vite.config.ts), so the scripts, stylesheet and the
  AudioWorklet module all resolve relative to the page and work under the `/<repo>/`
  sub-path without configuration.
- github.io is served over HTTPS, so audio (AudioWorklet) and Web MIDI work there
  (both need a secure context: HTTPS or localhost).

## Using it

On a laptop / tablet (≥ 900 px wide) everything is on one screen: the transport bar
(play, BPM, undo, MIDI, waveform count, sample rate, theme toggle), then Generate | Wavetables,
the Timeline strip, and Voice | Sequence. Panels scroll internally when their content
doesn't fit (e.g. the Breed tab). Narrower screens get one scrolling column
of the same panels, each collapsible. Dark theme by default; the sun / moon button
switches (the choice is remembered).

- **Generate → Seed**: pick from the library (basic waves, formula presets by
  category, Perlin noise, cellular automaton, a blank formula). Search filters by name,
  category or formula text (Enter picks the first match, ↓ moves into the list, Esc
  clears); ▲/▼ or the arrow keys step through the (filtered) list. On a phone the library
  is one row (▲ · Category › Name · ▼); tap the name for the list. Edit the formula (JS in
  `p`, `t`, `n`, `u`, `pnoise()`; "Revert to preset") or the mode's parameters. The
  large view shows one waveform of the batch with its spectrum; the strip below shows all N
  (click, or ←/→ when focused). The previews are exactly what gets added: "Add shown"
  adds that one waveform, "Add batch (+N)" all N (a voice on the built-in **Last batch**
  wavetable — V1 at start — then plays exactly those waveforms). Modes that use randomness
  show the seed (Reroll); a new seed is drawn after each Add batch.
- **Generate → Mutate**: mutate the waveform selected in the Timeline (the Source chip).
  The library works like Seed's (search by name, group or amount mapping; ▲/▼ or the
  arrow keys); each entry's thumbnail is that mutation applied to the source at the
  current amount (faint = source), and `rnd` marks mutations that use the seed. The
  header names the mutation and how Amount maps onto it ("0% = unchanged"); Seed /
  Reroll appear only for seeded mutations. The large view shows one waveform of the batch
  (solid) over the source (dashed) with both spectra (grey = source). Batch: Linear
  (`A·i/N`), Log (`A·64^((i−N)/(N−1))`) or Chain (each waveform mutates the previous one
  at A); the strip shows all N (click, or ←/→ when focused), the last one by default
  (= a single mutation at A). "Add shown" adds that waveform and selects it (so it becomes
  the next source); "Add +N" adds the batch (it becomes the Last batch) and selects the
  last waveform added (likewise the next source; Undo restores the selection).
  The previews are exactly what gets added; a seeded mutation draws a new seed after
  each Add.
- **Generate → Breed**: combine 2–8 parents. Shift-click (or ⌘-click) or
  long-press waveforms in the Timeline, "Add selected", or "Use window" of a voice; reorder
  or remove them on their cards. Pick an operator (crossfade, spectral mix, magnitude /
  phase swaps, envelope transfer, harmonic split, genetic masks, time splice), a Bias
  (0 = parent A) and how it walks the parents (path, ring, custom weights), and a
  Mutation rate. Breed adds one child; Breed N sweeps the bias or makes a seeded
  generation of N children.
- **Timeline**: every waveform, in order (cap 4096), as one horizontally scrolling strip
  (a vertical mouse wheel scrolls it sideways). Click to select (the header names the
  selection); Shift-click / long-press toggles Breed parents (badged A, B, …). A waveform
  inside a voice's window is tinted in the voice's colour (unmuted strong, muted faint)
  with a solid edge where a run of window waveforms starts / ends; overlapping windows split
  the cell into bands, voice 1 on top. Voices on other wavetables (Last batch, Grid, …)
  tint the Timeline waveforms their window references. Carets show each unmuted voice's live
  play position (for voices on other wavetables: on the waveform they play most of). The header
  button cycles the thumbnails: Waveform → Spectral → Waveform + Spectral. **Copy to end**
  (or Ctrl/⌘+D while the strip has focus, e.g. after clicking a waveform) appends a copy of
  the selected waveform and selects it (like a single add: following windows extend; undoable).
  **Shift+← / →** moves the selected waveform one place earlier / later (it swaps with its
  neighbour; the Timeline wavetable follows, voice windows on it keep their positions and
  play what is now inside them; other wavetables are unaffected; repeated moves of the same
  waveform are one undo step). The strip keeps the selection in view and follows new
  waveforms when scrolled to the end.
- **Wavetables**: named sets of slots referencing Timeline waveforms (no copies). Four
  read-only built-ins, all live: **Timeline** (1D, everything), **Last batch** (1D,
  replaced by each batch or single add), **Batches** (Rows: one row per batch / single
  add) and **Grid** (2D 8×8, filled in order, wrapping and overwriting). Chips pick one
  (green dot = live); the view shows it (1D as a stack of waveforms, 2D as a grid, Rows as
  rows) with voice windows in voice colours, the write head in green and play positions;
  click a slot to select its waveform. The summary line gives the shape, the interpolation
  (**Blend** / **Step**, switchable here; it applies to every voice on that wavetable),
  Live / Frozen and which voices use it. Waveforms in the Grid or Last batch are never evicted.
  Creating / editing wavetables (the Edit button) is phase 2. Collapsed by default on a phone.
- **Voice**: one tab per voice (V1, V2 · muted, …, + adds one, × removes the selected
  one). The selected voice's wavetable (any wavetable; switching selects all of it) and
  its interpolation (read-only), octave, window, position, LFO, level, mute, plus a "now
  playing" scope and the ADSR envelope. On a 2D or Rows wavetable the window / position /
  LFO depth / LFO rate become paired X / Y sliders and an X/Y pad shows the window, the
  LFO path and the play position (Blend is bilinear over four cells; on Rows, X is the
  same fraction of every row and Y crossfades between rows). V1 starts on Last batch,
  V2 / V3 on the Timeline; only voice 1 starts unmuted.
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
  release held notes. CC map: Position X (CC 1, mod wheel, by default), Position Y (2D /
  Rows wavetables; unassigned until learned, e.g. CC 2), LFO depth, LFO rate,
  Level — type a CC number or press Learn and move a control (bank select / RPN / NRPN
  are ignored while learning); remembered. A held pitch bend follows Omni to a newly
  selected voice; CC 121 recentres it. Audio starts
  when you pick an input, or on your first click if the input was remembered (browsers
  only start audio on a gesture). Unsupported browsers / denied permission show a short
  status; the rest of the app is unaffected.
- **Undo** (transport bar) covers waveform adds (including Mutate / Breed adds, Copy to end),
  Timeline moves, window edits and note edits.

## Keyboard shortcuts

Shortcuts are ignored while typing in a text field, text area, select or editable text, and
when other modifier keys are held. Controls show theirs in tooltips (and `aria-keyshortcuts`).

| Key | Action |
| --- | --- |
| Space | Play / stop (also while a button has focus; a focused checkbox still toggles) |
| `[` / `]` | Previous / next voice tab (wraps) |
| M | Mute / unmute the selected voice |
| Shift+← / Shift+→ | Move the selected waveform one place earlier / later in the Timeline |
| Ctrl/⌘+D | Copy the selected waveform to the end (while the Timeline strip has focus) |
| ← / → | Batch strips (Seed, Mutate): show the previous / next waveform; Home / End: first / last |
| ↑ / ↓ | Seed / Mutate libraries: previous / next entry (↓ from the search moves into the list; Enter picks the first match, Esc clears) |
| ← / → | Voice tabs (when a tab has focus): previous / next voice |
| Esc | MIDI popover: cancel Learn |
