# Architecture

## Module layout

```
src/
  core/                 Portable DSP + data. No DOM, no WebAudio, no globals with state.
    constants.ts        TABLE_SIZE 2048, KMAX 72, TIMELINE_CAP 4096, mip layout, scale
    prng.ts             Prng (mulberry32, uint32 state) + deriveSeed()
    fft.ts              radix-2 complex FFT on Float64Array
    shape.ts            shape(): DC removal, harmonic limit, optional Gaussian LP,
                        exact (fractional) fundamental phase alignment, peak normalise
    perlin.ts           improved Perlin noise, fBm, seeded NoiseField, loop-seamless pnoise
    generators/         basic, formula (FormulaFn interface only), Perlin, CA, presets,
                        seed.ts (Seed library entries + seedTable/seedBatch),
                        renderRecipe() to re-render a table from its recipe
                        (mutations need env.resolveTable for parent data)
    mutations.ts        prototype mutations (identity at amount 0; amount-mapping
                        hint, `seeded` flag) + sweep amounts
    mutateBatch.ts      a batch (lin, log, chain) → tables + recipes, or one table of
                        it (mutateBatchTable, for incremental previews); seeding
                        rules; renderMutateRecipe() re-renders from parent tables
    breed.ts            multi-parent breed operators, bias walks → per-parent weights,
                        breedBatch (single / sweep / gen), renderBreedRecipe()
    mipmap.ts           per-octave band-limited mip sets, packed in one Float32Array
    table.ts            WaveTable, Recipe, IdAllocator
    timeline.ts         appendWithEviction (oldest-first, pin-aware), index/window remap
    wavetable.ts        Wavetable (1D / 2D / Rows slots), built-ins, write head
                        (writeTables, previewWrites), eviction (removeTables),
                        pinnedIds(), hand edits (placeTable, moveSlot, clearSlot,
                        removeSlot, resize1D / resize2D, setWrite, setHead),
                        newWavetable / duplicateWavetable
    wavetablePlayback.ts  packed wavetable (engine form), position → tables + weights
                        (resolveMix: Blend / bilinear / row-aligned, Step, empty slots)
    voice.ts            VoiceParams (X / Y window, position, LFOs), followEdit()
    sequence.ts         SequenceData, scale → frequency, step helpers
    midi.ts             MIDI bytes → messages, MidiRouter (channel / Omni routing, held-note
                        tracking per source), velocity curve, bend scale, CC map + learn
    engine/             SynthEngine (audio-thread engine), Adsr, NoteStack (held keys)
  browser/formulaEval.ts  JS expression → FormulaFn (browser-only convenience)
  browser/webMidi.ts    Web MIDI access: permission, inputs + hot-plug, chosen input(s),
                        unsupported / insecure / denied states
  app/model.ts          AppModel: main-thread state, actions, undo, topic events
  app/midi.ts           MidiController: router → bridge (notes, bend) and → AppModel (CCs);
                        persisted settings (input, Omni, CC map), learn
  audio/                protocol.ts (messages), worklet.ts (AudioWorkletProcessor adapter),
                        bridge.ts (AudioContext owner, state → messages, mip building)
  ui/                   Plain DOM + canvas panels (no framework), styles.css tokens
                        (dark default, [data-theme=light]); dom.ts panel() = one shell
                        panel (header tools, body; collapsible on the narrow shell);
                        context.ts UiState (selected voice tab, shared by voices.ts
                        and sequences.ts); canvas.ts drawing + theme (setTheme,
                        stored in localStorage); transport.ts the top bar;
                        generate.ts hosts the tabs: seed.ts (Seed tab), mutate.ts
                        (Mutate tab) and breed.ts (Breed tab); library.ts (the
                        shared library list) and batch.ts (N stepper, voice
                        targets, card strip) are used by Seed and Mutate; timeline.ts (strip,
                        toggles Breed parents; drag source); wavetables.ts (compact
                        panel: chips, view, summary; Edit / Collapse); wavetableEditor.ts
                        (the expanded editor: list, views, header, write head settings,
                        drop zones); waveDrag.ts (pointer-event waveform drags: ghost,
                        drop zones, auto-scroll); voicePad.ts (X/Y pad of
                        a 2D / Rows voice); playing.ts (what a voice plays, as the
                        engine resolves it); midi.ts (transport MIDI picker,
                        LED, popover with routing and CC map); shortcuts.ts
                        (page-wide keys: Space, [ / ], M, Shift+←/→; one
                        capture-phase listener, skipped in text fields)
  main.ts               initial state, shell assembly, frame loop
tests/                  vitest unit tests (core + AppModel)
scripts/smoke.mjs       headless-Chrome smoke test (playwright-core)
```

## Data model

- **WaveTable** `{ id, data: Float32Array(2048), recipe }` — immutable, always shaped.
  `id` is a monotonic integer, never reused.
- **Recipe** `{ op, params, seed, parents[], batch?{index,count} }` — plain data,
  enough to re-render deterministically (`renderRecipe`; tested for every generator
  and every mutation × batch mode).
- **Seed recipes** — `op` is the generator (`basic`, `pulse`, `formula`, `perlin`, `ca`),
  `params.preset` the library entry id, plus the generator's params: `wave`;
  `width, widthEnd` (duty sweeps linearly across the batch); `expr, name, edited`
  (the expression actually used); `freq, z, zDrift, octaves, persistence`;
  `rule, cells, start, generation (= start + index)`. `seed` and `batch {index, count}`
  are always set (also for single "Add shown" tables, which keep their batch position),
  so every Seed table re-renders exactly (tested for every library entry).
- **Mutation recipe** — `op: 'mutate'`, `params { mutation, amount (this table's),
  batchAmount (A), mode: single|lin|log|chain }`, `seed` (the Apply's seed),
  `parents [sourceId]` (`[sourceId, mateId]` for Breed), `batch {index, count}`.
  The UI makes lin / log / chain batches ("Add shown" adds one table of one, keeping
  its batch position); `single` (one table at A) is older recipes' mode and equals the
  last table of a sweep. Single and sweep tables all use the Apply's seed; chain step j uses
  `chainStepSeed(seed, j)` (step 0 = seed, so the first chain table equals the
  preview). A chain table at index i re-renders as i+1 steps from the source, so it
  needs only the source (and mate), not the intermediate tables. Re-rendering needs
  the parents to still exist (or be re-renderable themselves). The `breed` mutation
  is legacy (not offered in the UI since M3) but still re-renders.
- **Breed recipe** — `op: 'breed'`, `params { breed (operator), bias (this table's),
  batchBias (B), mode: single|sweep|gen, walk: path|ring|weights, weights ('' or
  comma-separated per parent), rate }`, `seed` (the Apply's seed), `parents` (all
  parent ids, A first), `batch {index, count}`. Sweep table i uses bias `B·(i+1)/N`
  and the seed; generation child j uses `childSeed(seed, j)` (child 0 = seed = the
  preview). Weights come from `breedWeights(P, bias, walk, weights)`; bias 0 is
  always `[1, 0, …]`, so every operator returns shape(A) there.
- **Copy recipe** — Timeline "Copy to end" (`AppModel.copyToEnd`, a single add) gives
  the copy a new id and the same (shared, immutable) data; its recipe is the source's
  recipe with `params.copyOf` = the source id (`copyRecipe`), so it re-renders exactly
  like the source even after the source is evicted. A copy of a copy points at its
  immediate source; `parents` are the source's parents.
- **Breed parents** — `AppModel.breedParents`: ordered ids (≤ 8) of timeline tables,
  topic `parents`. Filtered whenever the timeline changes (eviction, undo); not part
  of undo snapshots.
- **Timeline** — ordered `WaveTable[]`, cap 4096. Eviction is oldest-first and skips
  tables referenced by a pinning wavetable (`pinnedIds`). If everything is pinned the
  timeline may exceed the cap. `AppModel.moveTable(id, ±1)` (Shift+←/→) swaps a table
  with its neighbour and the Timeline built-in's slots with it; voice windows are index
  ranges and stay put (the engine crossfades by table id as the window's contents change);
  wavetables referencing ids are untouched. Consecutive moves of one table with no other
  model event in between are one undo step.
- **Wavetable** — `{ id, name, shape: 1d|2d|rows, rows: (id|null)[][], fixed, interp:
  blend|step, live, write (head settings), head {x, y}, builtin?, pins }`. Slots
  reference timeline table ids (a table may sit in many wavetables / slots); `null` = empty.
  1D = one row (fixed or variable size); 2D = a fixed X×Y grid; Rows = rows of differing
  lengths. Plain, serializable data (persistence is M5). Built-ins (ids 0–3): Timeline
  (1D, mirrors the timeline, doesn't pin), Last batch (1D, pins), Batches (Rows, one row
  per batch, doesn't pin), Grid (2D 8×8, pins); user wavetables start at id 16 (next id =
  highest + 1, so it is derived from the list; no extra counter to persist), pin, and
  start Frozen (`newWavetable`; `duplicateWavetable` copies slots, settings and head of any
  wavetable). Growing writes / inserts stop at `MAX_SLOTS` (4096) slots per user wavetable
  (a live growing wavetable pins everything it holds).
- **Hand edits** (pure functions in `core/wavetable.ts`, each a `WavetableEdit` with the
  follow-axis map, so voice windows follow like on adds): a `SlotTarget` is a slot
  (replace), a gap before slot x of row y (insert; x = length appends) or a new row at y
  (Rows). `canTarget` validates (built-ins read-only; 2D replace only; a fixed 1D inserts
  only before an existing slot, shifting slots towards the end into the first empty slot
  at or after it, else the last drops out). `moveSlot`: onto a slot swaps, into a gap
  reorders (a fixed line keeps its size), as a row moves to a new row; Rows rows emptied
  by a move / remove are dropped. `clearSlot` empties; `removeSlot` closes up (fixed 1D
  appends an empty slot; 2D empties). `resize2D` keeps cells by (x, y), drops the rest
  (`droppedBy2DResize` counts filled ones for the confirm) and clamps the head; `resize1D`
  switches fixed / variable and pads / truncates. Every edit keeps the head on the slot /
  row it pointed at; `setWrite` / `resize1D` restart a head that can no longer write.
- **Write preview** (`previewWrites(wt, n)`): runs the real write head on a copy whose
  slots are encoded with their original coordinates, giving each of the next n writes
  (one batch) as replace (x, y) / insert before (x, y) / append to row y, so the markers
  always match `writeTables`.
- **Write head** (`writeTables`, live wavetables; every add is a batch, a single add a
  batch of one): settings `dir ±x/±y`, `edge wrap|stop|grow`, `onWrap next|same`, `mode
  replace|insert`, `batch continue|newRow`, coerced per shape by `normalizeWrite` (1D:
  ±x, fixed → wrap|stop, variable → stop|grow; 2D: replace only, wrap|stop; Rows: ±x).
  "New row": variable 1D starts its line afresh (Last batch); fixed 1D restarts at the
  line start; 2D moves to the next line's start; Rows appends a row. Wrap "next" moves
  to the next row / column (−x / −y: the previous one), cycling existing rows. A
  stopped head drops writes. Edits return an index map along the follow axis (1D slots,
  Rows rows) for voice windows. On a fixed 1D, −x insert mirrors +x (the first slot
  drops out). Stop + on-wrap "next" moves on line by line and stops at the end of the
  grid / the last row. Rows replace + wrap / stop + new row is coerced to grow (an empty
  new row can only be grown). Unit-tested for every combination.
- **Adds** (`AppModel.addTables`): write into every live wavetable, then pin, then evict
  from the timeline, then drop evicted ids from the (non-pinning) wavetables, then voice
  windows follow; one undo snapshot covers all of it (timeline, wavetables, windows).
- **VoiceParams** — wavetable id, inclusive X window (`windowStart/End`) and Y window
  (`windowStartY/EndY`), positions X / Y, LFO depth / rate / phase per axis, octave,
  level, mute, ADSR. Interpolation belongs to the wavetable. Switching wavetable selects
  all of it. Plain data shared verbatim with the engine.
- **SequenceData** — target voice, length (≤ 64), 64 steps (row or -1), gate.
- **Undo** — snapshots of the timeline array and wavetables (references), selection,
  voice windows (X and Y, restored only if the voice is still on that wavetable) and
  sequence steps; 40 deep. Covers adds, note edits, window edits (a slider drag is one
  step) and wavetable content edits (create, duplicate, rename, delete, resize, slot
  edits; `AppModel.editWavetable`); other slider moves are not undoable. Wavetable
  settings (interpolation, Live / Frozen, write settings, head moves) are not undo steps
  and are kept across undo (write settings re-normalized for the restored size). Deleting
  a wavetable moves its voices to the Timeline; that snapshot restores them
  (`restoreVoiceWavetables`).

## UI layout

- **Wide shell (≥ 900 px)**: `.app` is a 100dvh grid (8 px gutters): a 40 px transport
  bar, then `.shell` with three columns (45 / 22 / 33 fr) and three rows
  (55 fr / timeline strip 110 px (100 px under 840 px tall, 124 px on large screens) /
  45 fr): `gen gen wt` · `tl tl tl` · `voice seq seq`. No page scroll; each panel
  body scrolls if its content overflows. The Seed tab fills Generate (library column;
  formula row; wave + spectrum flex; batch row + strip), and so does Mutate (library
  column | source + parameters row; wave + spectrum flex; batch row + strip; the batch
  row wraps when the column is narrower than ~700 px, via a container query); Breed
  lays out in two columns and scrolls inside it. The shared Generate pieces use `gen-*`
  classes (`.gen-tab`, `.gen-lib`, `.gen-strip`, …).
- **Narrow shell (< 900 px)**: the same panels in the same order, one scrolling
  column, each collapsible (Wavetables starts collapsed); the transport bar is sticky.
- **Wavetables editor**: `.shell.wt-editing` hides Generate and gives Wavetables the
  whole first row (`grid-area: 1 / 1 / 2 / 4`); the panel body becomes a 200 px list |
  view | 244 px write-head grid (one column on the narrow shell: the list a scrolling
  row, the view 240 px tall). The view is a virtualized canvas like the Timeline (a
  sticky stage in a scroller sized to the content; only visible slots drawn; redrawn when
  dirty or playing), with hit boxes from the same layout used for clicks and drop
  targets (within 14 px of a slot edge = the gap, between Rows rows = a new row).
- **Drags** (`ui/waveDrag.ts`): sources call `beginDrag` once a press becomes a drag
  (Timeline: mouse > 5 px, touch: a vertical move > 10 px — `touch-action: pan-x` on the
  strip while the editor is open, so sideways still scrolls and a still press is the
  Breed long-press; editor slots: mouse > 5 px, touch: a 350 ms hold, then touchmove is
  cancelled so the page doesn't scroll). The module captures the pointer, moves a ghost,
  asks every active drop zone each frame (so zones auto-scroll near their edges; the page
  auto-scrolls on the narrow shell) and drops on release; Esc cancels; the click after a
  drop is swallowed. Zones: the editor view and its list (hover 600 ms opens an entry,
  dropping adds to it).
- Voice tabs: `UiState.voiceId` (kept valid as voices come and go: a removed voice's
  neighbour is selected). The Voice panel shows only that voice's controls; the
  Sequence panel shows its sequence(s).
- Remembered per browser (localStorage, try/catch): `mkwavez.theme` (only once
  toggled; default dark, applied before first paint by an inline script in
  index.html), `mkwavez.timelineView` (Waveform / Spectral / both) and `mkwavez.midi`
  (`{ input: 'off'|'all'|id, inputName, omni, cc: {position, positionY, lfoDepth, lfoRate, level} }`).
- MIDI popover: native `popover` (top layer, light dismiss; a `hidden` toggle where
  unsupported), fixed under the transport bar, so it never affects the shell layout.
  Below 640 px the bar keeps only the MIDI button (LED inside); the picker is in the popover.

## Threads and messages

```
UI events ──► AppModel (actions, emits topics) ──► UI sections (redraw on dirty)
                       │
                       └─► AudioBridge ──postMessage──► AudioWorklet ─► SynthEngine
                              ▲  builds mip sets in 48-table chunks,      │
                              │  transfers buffers                        │
                              └──────────── status @30 Hz ◄───────────────┘
```

- Main → worklet (`audio/protocol.ts`): `tables/add` (packed mip sets, transferred),
  `tables/remove`, `wavetable/set` (packed: shape, interp, row offsets + slot ids as
  Int32Arrays, -1 = empty; sent only for wavetables that changed), `voice/set|remove`,
  `sequence/set|remove`, `transport`, `midi` (routed note / bend events), `voice/patch`
  (a few params of one voice, from MIDI CCs).
- Worklet → main: `ready`, `status` (sequencer step, per voice: modulated positions
  pos / posY, resolved coordinates index (x) / y, env, note; table count), `error`.
- Everything the bridge queues within one task is sent as a single `batch` message,
  applied atomically between render quanta: a re-indexed wavetable (eviction) and the
  remapped voice windows always land together, and fresh tables' mip sets (built
  synchronously, up to 128) precede the wavetables that reference them (the model emits
  'timeline', 'wavetables', 'voices' in that order).
- The bridge reconciles: it tracks which table/voice/sequence ids the worklet has and
  sends adds/removes on each model topic. Undo that restores evicted tables simply
  re-sends them. Bulk backlogs (e.g. 4096 at audio start) arrive in 48-table chunks.
- The engine tracks playing tables by table id, not wavetable index: each control
  block resolves the voice's mix (≤ 4 tables + weights, `resolveMix`, the same code
  the UI uses) and every table's weight ramps linearly across the block from its
  previous weight (0 for a table entering the mix) to its new one (0 for one leaving),
  with every step slew-limited (all weights scaled together, so they keep summing to 1)
  so a jump — window / table / wavetable switch, a table replaced under the voice —
  crossfades over ~6 ms (`CROSSFADE_SEC`) while slow position moves track exactly,
  and an eviction re-index changes nothing (weights are computed relative to the
  window start). Step holds one table until the phase wraps. Tables that haven't
  arrived yet drop out of the mix (renormalised); with none, the previous mix holds.
  Switching a sounding voice's wavetable from Blend to Step keeps the mix until the
  phase wraps.
  Removed voices fade out with a 12 ms release before being freed.
- The audio thread never runs an FFT or allocates per sample. LFO/window/mip
  resolution runs every 64 samples (fixed per-voice arrays of 8 live tables).
- UI: one rAF loop, ≤ 25 fps while playing. Sections redraw only when open (not
  collapsed on the narrow shell), on screen (IntersectionObserver; this also covers
  content scrolled out of a panel) and dirty or animating. The timeline is a
  virtualized horizontal strip on one sticky canvas (only visible cells drawn; cell
  pitch 63 px, height = strip height), with voice-window tints / edges / bands drawn
  per cell and play-position carets (live `status` index while playing, static
  position when stopped) on a separate overlay canvas that redraws only when they
  move. Thumbnail spectra come from the per-data-array spectrum cache. The wavetable
  overview is a cached heat-map bitmap with overlays. Canvases that fill a flexible
  box (Seed plots, voice scope / envelope, sequence grid, heat map) are absolutely
  positioned (or explicitly sized) inside it and sized from the box when drawn, so a
  draw never feeds back into layout; ResizeObservers mark them dirty. The Mutate preview is a whole batch computed in the
  frame loop like Seed's (key: source id, mutation, amount, seed, mode, N; restarted at
  most every 50 ms; ≤ 8 ms per frame; a sweep computes the shown table first, a chain
  in order) through the same `mutateBatchTable()` as Add, which reuses the preview
  tables. Its library thumbnails (each mutation on the source at the current amount /
  seed) restart at most every 150 ms and are computed only for entries scrolled into
  view, within the same budget; old drawings stay until replaced. The Breed
  preview follows the same rules as the old single-table Mutate preview (only while
  showing and on screen, when its key changed, at most every 50 ms while dragging) (key: parent ids, operator, bias, walk, weights,
  rate, seed); parent spectra are cached per table data array. The Seed preview is a
  whole batch: on a key change (entry, formula / params, seed, N; restarted at most every
  50 ms) it is recomputed incrementally, ≤ 8 ms of main-thread work per frame, shown
  table first, through the same `seedTable()` as Add (which reuses the preview tables
  and finishes any missing ones synchronously). Formula edits restart it only after
  300 ms without typing, and any formula table over 150 ms is aborted (`abort()` hook
  polled by `formulaTable`) and stops the preview with an error. Runtime errors are
  per table: the failing card is marked, the rest still compute and can be added with
  Add shown; Add batch refuses until every table evaluates. Library thumbnails are rendered once
  (lazily, within the same budget) and redrawn only on selection / theme change; the
  previous tables stay drawn while a restarted batch computes. A planned Edit layer
  (draw / edit harmonics) slots in at `finalTable()` between the generated table and
  the preview / Add.

## MIDI

```
MIDIInput.onmidimessage ─► MidiController.handle ─► parseMidi ─► MidiRouter.route
   (browser/webMidi.ts)        (app/midi.ts)                         │
        notes, bend, all-notes-off ─► bridge.sendMidi ─► 'midi' op ─► SynthEngine.applyMidi
        CCs ─► ccPatch(CC map) ─► bridge.patchVoice ─► 'voice/patch' ─► SynthEngine.patchVoice
               └─► pending per voice ─► (≤ 16 ms timer) model.updateVoice ─► 'voices' ─► voice/set, sliders
```

- Straight from the MIDI event handler, never through the UI frame loop; events join that
  task's batch (one postMessage) and apply at the next render quantum (≤ 128 samples
  ≈ 2.7 ms of jitter). Event timestamps are not used for sub-quantum scheduling: mapping
  `performance.now()` to the render clock isn't reliable across browsers. A plugin port
  would apply events at their host sample offsets instead.
- Routing: channel N → voice id N (the "VN" tab), or Omni → the selected tab. The router
  remembers where each (source, channel, note) went, so a note-off always reaches the
  voice its note-on went to, even if Omni / the selected tab changed meanwhile.
  CC 120 / 123 release the channel's notes; losing an input (unplug, input switch, Off)
  releases that source's notes and recentres the bend it applied. Bend is tracked per
  (source, channel): when the channel's target changes (Omni toggled, another tab, a
  voice removed) the old voice is recentred and the new one gets the held bend. CC 121
  (reset all controllers) recentres the channel's bend; mapped CCs are stored params, so
  they are not reset. Deselected / lost inputs are `close()`d (exclusive drivers).
- Engine, per voice: a `NoteStack` (16 keys, fixed arrays, refcounted so the same note
  held from two channels in Omni stays held until both release). Note-on pushes and retriggers
  the envelope (from its current level); releasing the sounding key returns to the most
  recent held key without retrigger (legato, at that key's velocity); releasing the last
  key releases the envelope. Frequency = `440·2^((n−69)/12 + octave)`. Velocity gain
  `0.01 + 0.99·(v/127)²` multiplies the level (through the existing gain smoother).
  Bend: ±2 st target, one-pole smoothed per control block (4 ms) and ramped linearly
  within the block; mip level uses the higher of the block's ratios.
- MIDI vs sequence: while a voice has held keys, its sequence's steps are skipped (the
  sequencer keeps counting); once all keys are up, the next step plays as usual.
  Transport stop releases only voices without held keys. Muted voices stay silent.
- CCs change voice params (so the UI follows and they persist like a slider move; not
  undoable): position / LFO depth / level linear 0..1, LFO rate exponential 0.02–4 Hz.
  Each move goes straight to the engine as a light `voice/patch`; the model update is
  coalesced per voice and applied at most once per ~16 ms tick (a knob sweep = one
  'voices' event per frame, not per message). Any other model voice change first folds
  the pending values in, so a full voice/set never carries stale CC values.
  A controller drives one parameter (assigning moves it); 120–127 can't be assigned.
  Learn assigns the next controller move (and applies it); it ignores bank select (0/32),
  data entry (6/38) and (N)RPN (96–101), which can still be typed in.

## Playback semantics

- Position (per axis) = `position + depth/2 · sin(lfoPhase)`, reflected into [0,1],
  mapped onto the window. **Blend** (set on the wavetable): 1D crossfades the two
  neighbouring slots; 2D is bilinear over the 4 surrounding cells; Rows blends within
  each row at the same fraction u of the row (rows of different lengths align
  proportionally) and between the two neighbouring rows. **Step** holds one table (the
  nearest cell) and switches only on the oscillator's phase wrap (click-free).
- Empty slots never silence: Blend crossfades the nearest filled slots on either side
  (rows without filled slots are skipped the same way); Step takes the nearest filled
  slot; a window with nothing filled plays the nearest filled slot outside it.
- Mip level per note: the richest level whose top harmonic `f·K < 0.45·sr`.
  Levels keep 72/36/18/9/4/2/1 harmonics at 2048…64 samples (~28 samples/harmonic).
- Window following (`followEdit`): a window ending at the end of a growing axis (1D
  slots, Rows rows) extends when tables are added (single add or batch); removals /
  insertions remap windows so they keep pointing at the same tables; Last batch keeps
  indices (clamped) and its end follows, so a voice on it plays each new batch in full.
  2D windows are fixed.

## Porting notes

- `src/core` uses only typed arrays, plain objects and explicit seeds; it maps
  directly to C++ (structs + `std::vector<float>`/fixed arrays). `Prng` state is one
  uint32; mulberry32 is trivial to reproduce bit-exactly (`Math.imul` = 32-bit mul).
- `SynthEngine` is the audio-thread contract: the command methods correspond 1:1 to
  messages (in a plugin: a lock-free FIFO from the message thread). Its Maps/arrays
  would become fixed pools; mip sets are single contiguous buffers to hand over by
  pointer swap.
- shape()/mip building use Float64 internally; a port can use double FFT (or any FFT
  library) — tests define the invariants, not bit-exactness.
- Formulas are JS expressions compiled by `browser/formulaEval.ts`. A native build
  needs an expression parser for the same small language (Math functions, `pnoise`,
  ternaries; some presets use JS array idioms like `[...Array(n)].reduce`, which would
  need a `sum(k, n, expr)` builtin or similar). Formula recipes store the expression
  text, so tables still carry provenance.
- Cross-version determinism of re-rendering is not guaranteed yet (no recipe/version
  tag); M5 save/load should store sample data alongside recipes.
