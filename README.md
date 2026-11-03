# mkwavez

An evolving wavetable synth: single-cycle waveforms are continually generated (later:
mutated, bred, sampled) onto a growing timeline, and each voice plays a movable window
over a wavetable built from it. This browser build is the development testbed; the
`src/core/` DSP/data code is written to port to a plugin (JUCE/C++) and hardware.

See `docs/prototype-handoff.md` (original spec + prototype), `docs/ARCHITECTURE.md`
and `docs/ROADMAP.md`. The plugin (VST3 / AU / CLAP / LV2 / Standalone, JUCE) lives in
`plugin/`: a native C++ engine with this web app as its editor, embedded in the system
web view; see `docs/PLUGIN.md`.

## Run

Requires Node 20+.

```sh
npm install
npm run dev        # http://localhost:5173 — press Play to start audio
npm test           # core unit tests (vitest)
npx tsc --noEmit   # typecheck
npm run build      # typecheck + production build to dist/
npm run smoke      # build, then headless-Chrome smoke test against preview and dev servers
npm run bench      # CPU benchmark: 8 Synth voices at 48 kHz (time per render quantum)
```

`npm test` includes `tests/golden.test.ts`, which pins the core's numbers for the C++
port (`plugin/`). If you change the core's output on purpose, regenerate the fixture
(`npx vitest run -u tests/golden.test.ts`) and update the port (see `docs/PLUGIN.md`).

The smoke test uses `/usr/bin/google-chrome` by default (`CHROME=/path` to override;
`SHOTS=dir` saves screenshots at 1440×900, 1180×820, 1920×1080 and 390×844, dark and light,
plus `collapse-*.png`: the default layout, Sequence collapsed with a Synth voice at both laptop
sizes, Generate + Sequence collapsed and the maximized Timeline).

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
(play, BPM, undo, Session menu, MIDI, waveform count, sample rate, theme toggle), then Generate | Wavetables,
the Timeline strip, and Voice | Sequence. Panels scroll internally when their content
doesn't fit. Narrower screens get one scrolling column
of the same panels, each collapsible. Dark theme by default; the sun / moon button
switches (the choice is remembered).

- **Collapsing panels** (≥ 900 px): the chevron at the left of each panel header collapses
  it. Next to an open neighbour it becomes a slim vertical strip, which takes the width
  back for the neighbour (e.g. Sequence collapsed: the Voice panel spans the row); when
  its whole row is collapsed (or it is the Timeline) it becomes a header-height bar and
  the other rows take the height. Strips and bars keep a one-line status — Generate: the
  tab (“Seed · batch of 8”), Wavetables: the shown wavetable, Timeline: the count and
  selection, Voice: the voice and its type, Sequence: “→ V1 · 16 steps · 1.3” (the bar.beat
  position while playing) — and a click expands them. **Maximize** (the button at the right
  of a header, or double-click the header) gives that panel the whole content area (the
  others collapse); click it again to restore the arrangement from before. A maximized
  Timeline shows its waveforms in lanes (column by column, top to bottom). The arrangement
  is saved with the session; the phone column keeps its own (there the chevrons collapse
  sections as before; Wavetables starts collapsed).
- **Synth voice, full view**: when the Voice panel has room for it (e.g. Sequence collapsed
  at 1440×900 or 1180×820, or other rows collapsed), a Synth voice shows every control at
  once instead of the section tabs: Osc A and Osc B (wavetable, octave / semitones / fine,
  unison copies / detune / spread, level, window and position — X / Y on 2D / Rows — with a
  small scope or X/Y pad each), Mix (sub level / waveform / octave, noise and its colour,
  ring, FM, sync), Filter (mode, cutoff, resonance, drive, saturate, key tracking, envelope
  amount, velocity), the Amp / Filter / Pitch / Mod envelopes, LFO 1–3, Output (level, pan,
  width, octave, glide / legato, bend range), the presets and the mod matrix. Controls are
  small knobs: drag up / down (Shift: fine), or focus one and use the arrow keys (PageUp /
  PageDown: bigger steps, Home / End); double-click resets tuning, unison, pan and ± amounts. The
  value shows under each knob, or — when height is tight — in place of its label while you
  hover, focus or drag it. The choice follows the panel's size, not the window's; when the
  full view doesn't fit, the tabbed pages return.

- **Generate → Seed**: pick from the library (basic waves, formula presets by
  category, Perlin noise, cellular automaton, simulations — dynamical systems,
  Karplus-Strong, reaction-diffusion, Life-like automata — and builders — additive
  designer, number sequences, spline, glyph contour (type text; each character's outline
  becomes a waveform) — and a blank formula). Search filters by name,
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
- **Generate → Breed**: combine 2–8 parents. The operator library (Blend: Crossfade,
  Spectral mix; Swap: Magnitudes / Phases from A; Shape: Envelope transfer; Crossover:
  Harmonic split, Genetic per harmonic / per band; Time: Splice) works like Mutate's
  (search by name, group or hint; ▲/▼ or the arrow keys); each thumbnail is that operator
  applied to the parents at the current bias (faint = parent A), `rnd` marks seeded
  operators. Parents are chips (A, B, …: thumbnail + waveform number): Shift-click (or
  ⌘-click) or long-press waveforms in the Timeline, "Add selected" (+), or "Use window of"
  ([ ]) the chosen voice;
  drag a chip (or focus it and press ←/→) to reorder, × or Delete removes, Clear removes
  all. Then Bias (0 = parent A), how the bias walks the parents
  (Path, Ring, or Custom weights: a small slider on each chip), Mutation (seeded jitter,
  strongest between parents) and the seed (Reroll; shown when the result uses it). The
  large view shows one child (solid) over the parents (faint, in their chip colours) with
  its spectrum (grey = A); the row under it names the operator (its hint in the tooltip,
  as on the library entries), the shown child and the parents' weights. Batch: Sweep (child i of N at bias `B·i/N`) or Generation (N
  children at B, each with its own seed); the strip shows all N (click, or ←/→ when
  focused), the last by default. "Add shown" / "Add +N" add exactly the previews and
  select the last waveform added (undo restores the selection); Add +N refuses batches of
  copies (a sweep at bias 0; a generation with nothing seeded or one parent holding all
  the weight) and both need two parents.
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
  **+** makes a new 1D wavetable and opens the editor. Collapsed by default on a phone.
- **Wavetables editor** (**Edit** in the Wavetables header; **Collapse** returns): it
  takes over the whole Generate row (Generate is hidden meanwhile) and the Timeline stays
  below as the source for drags. Left: the list (built-ins with a lock, yours below; green
  dot = Live) and **+ 1D** (variable, empty), **+ 2D** (8×8, empty; set X × Y in the
  header) and **+ Rows** (empty). New wavetables start Frozen. Centre: the header (name —
  pencil or double-click a list entry to rename; shape; size: 1D Variable / Fixed + slot
  count, 2D X × Y, asking before slots with waveforms would be dropped; Strip / Stack for
  1D; Blend / Step; **Duplicate** — the way to edit a built-in: it makes an editable,
  frozen copy; **Delete**, asking first: voices on it switch to the Timeline), then the
  view with voice windows, the write head (green, “W”) and green numbers where the next
  writes land, then the selected slot's actions. Right: Live / Frozen and the write head
  settings (direction, at the edge, on wrap, replace / insert, each new batch; options a
  shape can't use are disabled; built-ins are read-only). A Live wavetable gets every new
  waveform (Seed / Mutate / Breed adds, Copy to end) at its write head.
  - **Drag** a waveform from the Timeline (mouse: press and move; touch: move up out of
    the strip — sideways still scrolls it, holding still is still the Breed long-press) or
    from a slot (touch: hold first): onto a slot **replaces** it, between slots
    **inserts** (1D and Rows; a fixed 1D shifts its slots into the next empty one),
    between rows or below the last adds a **row** (Rows). Within a wavetable a drag moves
    the slot (onto another slot: swaps; hold Alt / Ctrl / ⌘ to copy). Hovering a list
    entry while dragging opens it; dropping on it adds the waveform there. Esc cancels.
    The ghost says what a drop will do.
  - Click a slot to select it (and its waveform in the Timeline); ←/→ (↑/↓ on 2D / Rows)
    move the selection, **Delete** empties the slot, **Shift+Delete** removes it (the line
    closes up). The slot actions do the same, plus “Replace with selected” / “Insert
    selected” (the Timeline selection; handy on touch) and “Write head here” (or Alt-click
    a slot). Every edit is undoable.
  - Waveforms in your wavetables are never evicted from the Timeline; once no wavetable
    holds them they can be again. A wavetable of yours holds at most 1024 slots: a Live one that fills up is marked **full** and stops taking new waveforms (they still go into the Timeline). The Timeline
    never holds more than 4096 waveforms: when all of them are used by wavetables, adds
    are refused (the Add buttons are disabled; a notice says which wavetables to clear).
- **Voice**: one tab per voice (V1, V2 · muted, …, **+** adds a **Synth** or **Simple**
  voice, × removes the selected one). Each voice is Simple or Synth (the type select: in
  the Simple panel's right column, right of the Synth panel's section tabs; switching a
  sounding voice crossfades, and is undoable). Sessions saved before Synth voices existed
  load every voice as Simple, sounding exactly as before.
  **Simple voice**: the selected voice's wavetable (any wavetable; switching selects all of it) and
  its interpolation (read-only), octave, window, position, LFO, level, mute, plus a "now
  playing" scope and the ADSR envelope. On a 2D or Rows wavetable the window / position /
  LFO depth / LFO rate become paired X / Y sliders and an X/Y pad shows the window, the
  LFO path and the play position (Blend is bilinear over four cells; on Rows, X is the
  same fraction of every row and Y crossfades between rows). V1 starts on Last batch,
  V2 / V3 on the Timeline; only voice 1 starts unmuted. Copy / Paste copy a voice's
  settings onto another voice tab.
  **Synth voice**: compact pages in the same panel —
  - **Osc**: A / B picks the oscillator. Each has its own wavetable, window and position
    (paired X / Y sliders and the X/Y pad on 2D / Rows wavetables, a "now playing" scope
    on 1D), octave ±3 · semitones ±24, fine ±100 cents, level, and **unison** 1–4 copies
    with detune and stereo spread. When many copies sound at once (more than 32 across
    all voices) a CPU guard plays fewer and says "CPU guard: reduced".
  - **Mix**: levels of A, B, the sub oscillator (sine / square, 1 or 2 octaves below A),
    noise (white / pink), ring modulation A × B, FM (B modulates A's phase) and **Sync B**
    (osc B's cycle restarts A); output level, pan, stereo width, octave, glide (with
    legato only) and the pitch-bend range.
  - **Filter**: LP12 / LP24 / HP / BP / Notch, cutoff, resonance (up to near
    self-oscillation), drive (before the filter), saturate (after it), key tracking, filter
    envelope amount (± 6 octaves) and velocity; the response curve shows the cutoff and
    (dashed) where the envelope takes it.
  - **Env**: Amp / Filter (ADSR) / Pitch (attack, decay, ± 24 semitones; target A, B or
    both) envelopes, with a graph; velocity → level.
  - **Mod**: LFO 1–3 (sine, triangle, saw, square, S&H, smooth random; rate in Hz or
    synced to the tempo in divisions from 8 bars to 1/32, dotted and triplets; retrigger or
    free-running, start phase, fade-in, depth) and the mod envelope (AD or ADSR), plus an
    8-slot **matrix**: source (LFOs, filter / pitch / mod envelope, velocity, mod wheel,
    aftertouch, key, per-note random) → destination (A / B pitch, position X / Y, level,
    sub / noise level, cutoff, resonance, drive, amp, pan, LFO rates) × a bipolar amount
    (double-click resets it).
  - **Presets** (the picker next to the section tabs): Init and six factory sounds (Sub
    bass, Pluck, Evolving pad, Sync lead, Brass, Noise sweep) that play the built-in
    wavetables, then yours. The ⋯ menu saves the voice as a preset, deletes the chosen one,
    copies / pastes voices and exports / imports your presets (a `.json` file). Your
    presets are saved with the session. Applying one is undoable.
- **Sequence**: follows the selected voice tab: its 8-row pentatonic step grid (rows
  labelled with the voice's notes), steps, gate, copy / paste / clear / random; shared
  tempo. "+ Seq" adds another sequence to the voice (a picker appears).
  - **Step length** ("Steps [16] of [1/8]"): each sequence's steps are 1/4, 1/8
    (default), 1/16, 1/8T or 1/16T notes; BPM counts quarter notes, so a step lasts
    (60 / BPM) × (4 × the fraction) seconds — 16 steps of 1/8 are 2 bars of 4/4. The
    header shows the length in bars ("16 steps · 1/8 · 2 bars", "12 steps · 1/8 · 1.5
    bars") and the transport position as bar.beat since Play ("5.3"), which keeps
    counting across loops. The grid shades the first step of each beat (beats 1 and 3
    at 1/4) and draws a line at each bar, counted from the pattern start: a pattern
    that isn't a whole number of bars loops off the bar line, and the header says so.
  - All sequences run on one clock from the moment Play is pressed, so different step
    lengths (and pattern lengths) stay bar-aligned; changing the step length while
    playing picks up at the next step of the new grid. Sessions saved before step
    lengths existed load as 1/8 and sound exactly as before.
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
  Level, and for Synth voices Cutoff, Resonance, Drive, Filter env amount, Osc A / B mix,
  Sub / Noise level, Glide and LFO 1–3 rate / depth — type a CC number or press Learn and
  move a control (bank select / RPN / NRPN are ignored while learning); remembered. The mod
  wheel and channel pressure (aftertouch) are Synth voice matrix sources (on a Synth voice CC 1
  is only the mod wheel, it doesn't also move Position X); a Synth
  voice's bend range is its own (default 2). A held pitch bend follows Omni to a newly
  selected voice (so do the wheel and pressure); CC 121 recentres it and zeroes them. Audio starts
  when you pick an input, or on your first click if the input was remembered (browsers
  only start audio on a gesture). Unsupported browsers / denied permission show a short
  status; the rest of the app is unaffected.
- **Session** (transport bar): your work is saved in the browser automatically (IndexedDB,
  a second or two after each change and when the tab is hidden) and restored on reload —
  waveforms, wavetables, voices (Synth settings included), your voice presets, sequences, tempo, the selected voice tab and Generate
  tab, collapsed / maximized panels (wide and phone layouts separately), Breed parents and the Breed operator / bias / walk / mutation / batch mode; not
  undo history. The menu shows the autosave status and has **New session**
  (asks first; clears the autosaved copy), **Export…** (one `.mkwz` file) and
  **Import…** (asks first; replaces the current session). If the browser blocks storage
  (e.g. some private windows) the app runs as usual with autosave off and a notice; a
  save that can't be restored (damaged, or from a newer version) starts a fresh session
  and is kept aside, with Export / Discard. With mkwavez open in several tabs only one
  autosaves; the others say so and offer "Use autosave here…".
- **Undo** (transport bar) covers waveform adds (including Mutate / Breed adds, Copy to end),
  Timeline moves, window edits, a voice's wavetable switch, note edits and wavetable edits (create, duplicate, rename,
  delete, resize, slot edits), Synth voice edits (a slider drag is one step; presets,
  paste, type switches) — undo restores only the voice the undone edit changed, so MIDI
  controller moves elsewhere stay. Wavetable settings (Live / Frozen, write head, interpolation)
  are kept across undo.


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
| ← / → (↑ / ↓) | Wavetables editor view (when it has focus): select the previous / next slot (row) |
| Shift+← / Shift+→ | Wavetables editor view (when it has focus): move the selected slot (instead of the Timeline move) |
| Delete / Shift+Delete | Wavetables editor: empty / remove the selected slot |
| Alt / Ctrl / ⌘ (while dragging) | Copy instead of move within a wavetable |
| Esc | MIDI popover: cancel Learn; while dragging a waveform: cancel the drag (no other shortcut acts during a drag) |
| ↑ / ↓ (← / →) | Synth full view knob (when focused): step the value; PageUp / PageDown or Shift+↑ / ↓: bigger steps; Home / End: minimum / maximum |
