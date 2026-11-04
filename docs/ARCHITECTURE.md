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
                        paramModes.ts (further parameter modes: library entry + pure
                        render(params, seed, index, count); dynamical.ts, …; each
                        generator also exposes its raw cycle before shape(), e.g.
                        caRawGenerations, karplusRaw, rdRaw),
                        waveFunctions.ts (the formulas' waveform functions sine() …
                        glyph(): raw cycles sampled at a phase, per-render memo),
                        asFormula.ts ("Edit as formula": a library entry's params →
                        the equivalent formula; basic presets' source expressions),
                        seed.ts (Seed library entries + seedTable/seedBatch),
                        renderRecipe() to re-render a table from its recipe
                        (mutations need env.resolveTable for parent data)
    mutations.ts        prototype mutations (identity at amount 0; amount-mapping
                        hint, `seeded` flag) + sweep amounts
    mutateBatch.ts      a batch (lin, log, chain) → tables + recipes, or one table of
                        it (mutateBatchTable, for incremental previews); seeding
                        rules; renderMutateRecipe() re-renders from parent tables
    breed.ts            multi-parent breed operators (group, hint, seeded flag), bias
                        walks → per-parent weights, breedBatch (single / sweep / gen) or
                        one child of it (breedBatchTable, for incremental previews),
                        renderBreedRecipe()
    drawing.ts          Shape drawings: line / curve (Catmull-Rom) / freehand points, span
                        and edge fade, stroke resampling, normalisation
    shapeSteps.ts       Shape chain steps (draw: clip / soft / fold / replace / push /
                        pull / add / multiply; harmonics: set / modify / limit to curve;
                        whole wave: any mutation, gain, invert, reverse, rotate):
                        defaults, normalizeStep, applyStep
    shapeChain.ts       Shape chains: normalizeChain (canonical JSON), per-step seeds and
                        amount sweeps, chainStages / applyChain, 'shape' recipes
    shapeFactory.ts     factory chains, saved chains, the chains export file
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
    voice.ts            VoiceParams (type, synth block, X / Y window, position, LFOs),
                        VoicePatch / applyVoicePatch (synth fields merge), followEdit()
                        (osc A and B), rehomeVoice
    synth.ts            SynthParams (Synth voice settings), defaults (Init), ranges,
                        normalizeSynth (untrusted data → valid params)
    modulation.ts       LFO shapes / sync divisions, mod sources / destinations, matrix
                        arithmetic (applyMatrix)
    presets.ts          voice presets (PresetSound), the factory set, export file format
    sequence.ts         SequenceData, step lengths / clock ticks / bars, scale → frequency
    midi.ts             MIDI bytes → messages, MidiRouter (channel / Omni routing, held-note
                        tracking per source), velocity curve, bend scale, CC map + learn
    session.ts          session schema (meta + per-waveform records), encode / decode,
                        migrations, the .mkwz file container
    engine/             SynthEngine (audio-thread engine), Adsr, NoteStack (held keys),
                        WtOsc (one oscillator's table mix: Simple voice and Synth osc A / B),
                        synthVoice.ts (the Synth voice path), svf.ts (ZDF multimode filter,
                        drive, limiter, response curve)
  browser/formulaEval.ts  JS expression → FormulaFn (browser-only convenience; binds the
                        waveform functions the expression names)
  browser/glyphTrace.ts character → canvas → outer contour polyline (Glyph contour mode)
  browser/webMidi.ts    Web MIDI access: permission, inputs + hot-plug, chosen input(s),
                        unsupported / insecure / denied states
  browser/sessionStore.ts  IndexedDB store for the autosaved session (meta + waveforms)
  app/model.ts          AppModel: main-thread state, actions, undo, topic events
  app/midi.ts           MidiController: router → bridge (notes, bend) and → AppModel (CCs);
                        persisted settings (input, Omni, CC map), learn
  app/autosave.ts       Autosaver: debounced, incremental, chunked session saves (backend
                        and scheduler injected)
  app/defaultSession.ts the fresh session (5 basic waveforms, 3 voices, 3 sequences)
  audio/                protocol.ts (messages), worklet.ts (AudioWorkletProcessor adapter),
                        bridge.ts (AudioContext owner, state → messages, mip building)
  ui/                   Plain DOM + canvas panels (no framework), styles.css tokens
                        (dark default, [data-theme=light]); dom.ts panel() = one shell
                        panel (header: collapse, tools, maximize; collapsed strip / bar
                        with a status; body); layout.ts the shell layout state (collapsed /
                        maximized panels per layout, saved as UI prefs);
                        context.ts UiState (selected voice tab, shared by voices.ts
                        and sequences.ts); canvas.ts drawing + theme (setTheme,
                        stored in localStorage); transport.ts the top bar;
                        generate.ts hosts the tabs: seed.ts (Seed tab), mutate.ts
                        (Mutate tab), breed.ts (Breed tab) and shapeTab.ts (Shape
                        tab: chain column, step settings, the drawable plot, Apply
                        to, Write back); shapeOnAdd.ts (the Shape chip in Seed /
                        Mutate / Breed batch rows); library.ts (the
                        shared library list) and batch.ts (N stepper, card strip)
                        are used by Seed, Mutate and Breed; timeline.ts (strip,
                        toggles Breed parents; drag source); wavetables.ts (compact
                        panel: chips, view, summary; Edit / Collapse); wavetableEditor.ts
                        (the expanded editor: list, views, header, write head settings,
                        drop zones); waveDrag.ts (pointer-event waveform drags: ghost,
                        drop zones, auto-scroll); voicePad.ts (X/Y pad of
                        a 2D / Rows voice or Synth oscillator); synthPanel.ts (the
                        Synth voice's Osc · Mix · Filter · Env · Mod pages, or the full
                        view when the panel has room); synthFull.ts (the full view: every
                        control as knob groups); knob.ts (small rotary control,
                        role=slider, and choice cells); presets.ts
                        (preset picker, ⋯ menu, voice copy / paste); playing.ts (what a voice plays, as the
                        engine resolves it); midi.ts (transport MIDI picker,
                        LED, popover with routing and CC map); shortcuts.ts
                        (page-wide keys: Space, [ / ], M, Shift+←/→; one
                        capture-phase listener, skipped in text fields); session.ts
                        (Session menu: autosave status, New / Export / Import;
                        notices)
  main.ts               session restore (before the first render), shell assembly,
                        autosave wiring, frame loop
tests/                  vitest unit tests (core + AppModel)
scripts/smoke.mjs       headless-Chrome smoke test (playwright-core)
```

## Data model

- **WaveTable** `{ id, data: Float32Array(2048), recipe }` — immutable, always shaped.
  `id` is a monotonic integer, never reused.
- **Recipe** `{ op, params, seed, parents[], batch?{index,count}, shape? }` — plain data,
  enough to re-render deterministically (`renderRecipe`; tested for every generator
  and every mutation × batch mode). `shape` (optional) is a Shape chain's canonical JSON
  applied after the op at the recipe's batch position: set on tables added from Seed,
  Mutate or Breed with their Shape chip on; `describeRecipe` appends "· shaped: name".
- **Seed recipes** — `op` is the generator (`basic`, `pulse`, `formula`, `perlin`, `ca`),
  `params.preset` the library entry id, plus the generator's params: `wave`;
  `width, widthEnd` (duty sweeps linearly across the batch); `expr, name, edited`
  (the expression actually used); `freq, z, zDrift, octaves, persistence`;
  `rule, cells, start, generation (= start + index)`. Parameter modes from
  `PARAM_MODES` (`dynamical`, `karplus`, `additive`, `numseq`, `rd`, `life`, `spline`,
  `glyph`) record `op` = the mode, every param plus `name`, and re-render through the
  mode's `render(params, seed, index, count)` (missing params take the mode's defaults).
  Data only the host can make arrives as per-table `SeedRequest.inputs` merged into the
  params and recorded: Glyph contour's `contour` (the outer contour polyline traced by
  `browser/glyphTrace.ts` from an offscreen canvas, "x,y x,y …") and `glyph` (the
  character) — the recipe carries the polyline, never the font. Basic presets (Sine …
  Square, Pulse) have an expression source (`SeedRequest.source`): an unedited **Built-in
  function** renders through the generator (`basic` / `pulse` recipes, as before); the
  **Formula** source or an edited expression renders as a formula (`op: 'formula'`, `expr`,
  `name` = the preset's, `edited` vs that source's expression, `preset` = its id;
  `seedFormulaExpr()` says which). `seed` and `batch {index, count}`
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
  and the seed; generation child j uses `childSeed(seed, j)` (child 0 = seed). The UI
  makes sweep / gen batches; "Add shown" adds one child of one, keeping its batch
  position (so it re-renders exactly); `single` (one child at B) is older recipes' mode
  and equals the last child of a sweep. Weights come from `breedWeights(P, bias, walk, weights)`; bias 0 is
  always `[1, 0, …]`, so every operator returns shape(A) there.
- **Shape recipe** — `op: 'shape'`, `params { name, steps (enabled count), chain
  (canonical JSON) }`, `seed` (the chain's), `parents [sourceId]`, `batch {index,
  count}`. `renderShapeRecipe` = `applyChain(parent data, chain, batch)`.
- **Shape chain** (core/shapeChain.ts) — `{ v: 1, name, seed, varySeed, realign, steps }`,
  each step `{ id, op, on, amount, amountEnd?, …its settings }`. The engine: each enabled
  step at its amount (`amountEnd` set = swept across a batch, u = index / (count − 1)) on
  the working cycle, band-limited to KMAX after every step, levels carried (no normalising
  between steps, so Gain drives a clip), then `shape()` (phase realign only if `realign`).
  Amount 0 skips the step. A step's seed is `deriveSeed(chain seed, hash(step id))` (stable
  when other steps change), per batch index too when `varySeed`. Mutation steps align the
  cycle, mutate and rotate back, so the chain keeps its phase. `normalizeChain` clamps
  untrusted data and writes fields in a fixed order (canonical JSON; idempotent). The Shape
  tab's chain is `AppModel.shapeChain` (topic 'shape'; every edit an undo step, a slider
  drag or drawn stroke one); saved chains are `AppModel.shapeChains` `{ id: 'chain-N',
  chain }` (not undoable). Both are saved in the session meta (`shapeChain`,
  `shapeChains`, optional: older sessions get the default chain and none saved); export
  file `{ format: 'mkwavez-shapes', version: 1, chains }`.
- **Copy recipe** — Timeline "Copy to end" (`AppModel.copyToEnd`, a single add) gives
  the copy a new id and the same (shared, immutable) data; its recipe is the source's
  recipe with `params.copyOf` = the source id (`copyRecipe`), so it re-renders exactly
  like the source even after the source is evicted. A copy of a copy points at its
  immediate source; `parents` are the source's parents.
- **Breed parents** — `AppModel.breedParents`: ordered ids (≤ 8) of timeline tables,
  topic `parents`. Filtered whenever the timeline changes (eviction, undo); not part
  of undo snapshots.
- **Timeline** — ordered `WaveTable[]`, cap 4096. Eviction is oldest-first and skips
  tables referenced by a pinning wavetable (`pinnedIds`). The timeline never exceeds the
  cap: an add that would have to evict one of its own new waveforms (too few unpinned
  ones left) is refused (`roomFor(n)`, cached per state, is the same check; Add buttons
  are disabled with the reason as their tooltip) and the model emits a 'notice'
  (`fullMessage()`: "Timeline full: all N waveforms are used by wavetables — remove some
  from …"), shown as a toast. So live wavetables only ever reference waveforms that were
  added. `AppModel.moveTable(id, ±1)` (Shift+←/→) swaps a table
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
  per batch, doesn't pin), Grid (2D 8×8, pins); user wavetables get ids from
  `AppModel.nextWavetableId` (from 16, monotonic, never reused — not even after an undone
  create or a delete; plain data to persist alongside the wavetables), pin, and start Frozen (`newWavetable`; `duplicateWavetable` copies slots, settings and head of any
  wavetable). Growing writes / inserts stop at `MAX_USER_SLOTS` (1024) slots per user
  wavetable (a Live write past it stops the head, as "stop at the edge", while the add
  itself still goes into the Timeline; `isFull` marks it "full" in the list, chips and
  editor), so a growing wavetable never blocks generation. A voice whose wavetable disappears (delete, undone create / duplicate) moves
  to the Timeline (whole window).
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
- **VoiceParams** — `type` ('simple' | 'synth'), wavetable id, inclusive X window (`windowStart/End`) and Y window
  (`windowStartY/EndY`), positions X / Y, LFO depth / rate / phase per axis, octave,
  level, mute, ADSR, and `synth` (SynthParams; every voice carries one, so switching type
  keeps it). Interpolation belongs to the wavetable. Switching wavetable selects
  all of it. Plain data shared verbatim with the engine. A Synth voice's osc A is the
  voice's own wavetable / window / position; osc B's is `synth.b` (an OscSource: the same
  fields), which follows wavetable edits, eviction and deletes exactly like A's (followEdit,
  rehomeVoice, clampOscB). The Simple voice's position LFOs are not used by Synth voices
  (their motion comes from the mod matrix). Patches (`VoicePatch`: MIDI CCs, sliders)
  merge `synth` fields into the voice's block.
- **SynthParams** (core/synth.ts) — osc A / B tuning (octave, coarse, fine) and level, osc B
  source, sub (wave, octave, level), noise (type, level), ring, FM, hard sync, unison per
  osc (copies, detune, spread), filter (mode, cutoff Hz, resonance, drive, key track, env /
  velocity amounts), saturation, filter ADSR, pitch envelope (A, D, ± semitones, target),
  velocity → amp, glide (+ legato only), bend range, pan, width, three LFOs, the mod
  envelope (AD / ADSR) and 8 matrix slots (source, destination, amount −1..1). Ranges in
  SYNTH_RANGES; `normalizeSynth` validates untrusted data (missing fields → the Init
  patch's, so new fields need no schema bump; unknown fields kept).
- **Voice presets** (core/presets.ts) — `{ id, name, sound }`, sound = synth block + osc A
  source + amp ADSR + octave + level, plus `aRef` / `bRef` wavetable references (a
  built-in by kind; your wavetable by name + shape — ids are per session and only a hint).
  `resolvePresetWavetable` finds them on apply; one that isn't in the session falls back to
  Last batch with a notice (and an import warns how many presets that affects). Factory
  presets reference built-ins with "whole wavetable" windows (clamped on apply). User presets live in
  `AppModel.voicePresets` (topic 'presets'), saved in the session meta (`voicePresets`,
  optional: older sessions have none) and exported as `{ format: 'mkwavez-presets',
  version: 1, presets }` JSON. Applying = one `updateVoice` (undoable).
- **SequenceData** — target voice, length (≤ 64), 64 steps (row or -1), gate, step
  length (`'1/4' | '1/8' | '1/16' | '1/8T' | '1/16T'`, default `'1/8'`). Timing helpers
  live in `core/sequence.ts`: `STEP_TICKS` (clock ticks per step: 12 / 6 / 3 / 4 / 2 at
  `TICKS_PER_BEAT` = 12 per quarter note, 48 per 4/4 bar), `stepSeconds` =
  (60 / BPM) × (4 × fraction), `stepSamples`, `stepAtTick`, `stepBarBeat`
  (pattern-relative), `tickBarBeat` (the transport bar clock), `isShadedStep` /
  `isBarStep` (grid, pattern-relative; shading is per beat, per half bar at 1/4),
  `lengthInBars`, `sequenceSummary`.
- **Session** (`core/session.ts`, M5 part 1) — what is saved: the timeline (ids in order
  plus one record per waveform), the id allocators (`nextTableId`, `nextWavetableId` —
  monotonic, a deleted wavetable's id is never reused after a restore — `nextVoiceId`,
  `nextSeqId`), selection and Breed parents, every wavetable (built-ins' contents / heads /
  interpolation and user wavetables, stored verbatim so new fields round-trip without
  schema changes; decode validates known fields and keeps unknown ones), voices (all
  params; unknown keys kept, bad values → defaults), sequences, BPM, and UI prefs
  (`UiState.exportPrefs()`: the selected voice tab, the Generate tab, the shell layout —
  `layoutWide` / `layoutNarrow`: `{ collapsed: PanelKey[], max, restore }` —, the Breed operator, bias, walk, mutation and batch mode, each tab's Shape chip choice `shapeOnAdd.<tab>`; Breed parents are model state). Not saved: undo
  history, transport play state. Theme, timeline view and MIDI settings stay per browser
  in localStorage.
  - Two parts: **meta** (`SessionMeta`, small, JSON-safe, `format` + `version`), rewritten
    on every save, and **waveform records** (`WaveformRecord`, one per id, written once:
    waveforms are immutable). A record is `samples` (Float32, the default), `recipe`
    (only `basic` / `pulse`, which re-render cheaply and exactly — and only if the
    re-render matches bit for bit when encoded; a sample hash flags a later code change)
    or `ref` (same samples as another record: copies share data, so a copy costs a few
    bytes). Formula, Perlin, CA, mutate and breed waveforms always store samples (no user
    JS is evaluated at load; parents may be gone).
  - Versioned: `migrateMeta` runs `MIGRATIONS[v]` (v → v+1) up to `SESSION_VERSION`;
    a newer or unmigratable version is a `SessionError` ('incompatible'). Version 2
    added `nextWavetableId` (1 → 2: the highest wavetable id + 1); version 3 added each
    sequence's `stepLength` (2 → 3: `'1/8'`, what every earlier sequence played; decode
    also maps a missing / unknown value to `'1/8'`); version 4 added voice `type` and
    `synth` (3 → 4: every voice 'simple'; decode fills `synth` with the Init patch, osc B on
    osc A's wavetable / window, validates it, and moves osc B to the Timeline if its
    wavetable is gone).
  - User wavetables (editor) are stored like the built-ins: every field, write head and
    Live state; "full" (`isFull`, MAX_USER_SLOTS) is derived, so it round-trips. Decoding
    keeps them within the editor's limits (≤ MAX_USER_SLOTS slots, keeping the newest as
    Duplicate does; 2D sides ≤ MAX_GRID); a voice whose wavetable is missing moves to the
    Timeline (whole window). The decoded Timeline never exceeds its cap (oldest unpinned
    first, then the oldest).
  - Decoding never trusts input: missing / malformed / non-finite waveform records are
    dropped (with warnings; wavetables drop the slots the way eviction does, voices are
    clamped); if no waveform survives, or the meta is unusable, it throws and the app
    starts fresh.
  - **.mkwz file** (Export / Import): `'MKWZ'`, u32 container version, u32 JSON length,
    JSON `{ meta, waveforms }` (sample records carry `offset` / `length` in floats), padding
    to 4 bytes, little-endian Float32 sample block. Exports store samples (no recipe-only
    records), so files don't depend on re-render determinism.
- **Autosave** (`app/autosave.ts`, `app/restore.ts`, `browser/sessionStore.ts`,
  `browser/tabLock.ts`): IndexedDB database `mkwavez` with stores `meta` (key
  `session`), `waveforms` (keyPath `id`), `kept` (one small entry per session that
  couldn't be restored: meta, error, max id, count; several may accumulate) and
  `keptWaveforms` (their records, key `[kept key, id]`). Any model topic or UI pref
  change marks the session dirty; the save runs 1.5 s after the last change (at most 6 s
  after the first), writes new waveform records in chunks of ≤ 64 / ≤ 4 ms with idle-time
  yields, then the meta and the deletion of unreferenced records (evicted waveforms; a
  `ref`'s target is kept while referenced) in one transaction — so the stored meta never
  references a missing record. Page hidden / `pagehide`: `flushNow()` issues one
  transaction synchronously (meta + every unwritten waveform + deletions); a chunked save
  in progress is superseded (it never commits its older meta).
  - Restore: only records the restored meta reaches count as saved; any other record
    (from a save whose meta never landed) is deleted, and new ids are allocated above
    every stored id (`AppModel.reserveTableIds`), so a stale record can't stand in for a
    new waveform. A tab that doesn't own autosave deletes nothing (the owner may be
    mid-save: its new records are "orphans" only until its meta lands).
  - Quota: if a write fails with QuotaExceededError, the current meta is committed
    together with the deletion of records it doesn't reference (so no saved meta points
    at a deleted record; until the rest is written that meta lacks some new waveforms,
    which a restore would drop with a warning) and the write is retried once; still
    full → error status and a notice (Export).
    Other write errors set an error status and retry on the next change.
  - Tabs: one tab owns autosave (Web Locks, `mkwavez-autosave`). A tab that can't take
    the lock at startup renders at once with autosave paused and waits ≤ 1.5 s in the
    background (a reload's previous document releasing it); then `becomeOwner`: if the
    store still holds the save it restored, it carries on incrementally (`init`), else
    rewrites everything. Otherwise it shows a notice + Session menu "Use autosave
    here…"; taking over steals the lock (the old owner pauses) and rewrites every
    waveform, the meta and the deletions in one transaction (`adopt`), so an interruption
    never pairs the old meta with overwritten records. Without Web Locks every tab saves
    (last writer wins).
  - Startup (`restoreSession`, before the UI is built; the page shows "Loading…"):
    storage unavailable → fresh session, autosave off, a notice; unrestorable save
    (corrupt, or a newer version) → moved to `kept` intact in one transaction, fresh
    session (new ids above the kept ones), a notice offering Export / Discard (also in the
    Session menu, for the latest; earlier kept sessions stay); if it can't be moved, it is
    left untouched (autosave off); if another tab owns the store, it is set aside when
    this tab becomes the owner (unless replaced meanwhile).
  - New session / Import replace the model (`AppModel.loadState`, undo cleared), clear
    the store and save everything. Imports are capped (256 MB, 4×4096 records, exactly
    2048 samples per waveform) and the timeline is cut to the cap like an add (oldest
    unpinned first).
- **Undo** — snapshots of the timeline array and wavetables (references), selection,
  voice windows with their wavetable (X and Y, osc A and osc B; switching a voice's wavetable is an undo
  step, so undo puts voices back), the sound of the one voice a Synth edit touched (type,
  synth block, and on a Synth voice its amp ADSR / level / octave / position: other
  voices' sounds are never restored, so live MIDI-controller changes survive) and sequence steps; 40 deep.
  Synth voice edits (any synth field, amp ADSR, level, octave, position; presets, paste)
  and type switches are undo steps, coalesced per gesture (`endGesture` on slider release);
  MIDI CC moves pass `undo: false`. Simple voices' slider moves stay non-undoable. Covers adds, note edits, window edits (a slider drag is one
  step) and wavetable content edits (create, duplicate, rename, delete, resize, slot
  edits; `AppModel.editWavetable`); other slider moves are not undoable. Wavetable
  settings (interpolation, Live / Frozen, write settings, head moves) are not undo steps
  and are kept across undo (write settings re-normalized for the restored size). Deleting
  a wavetable moves its voices to the Timeline; undoing the delete puts them back.

## UI layout

- **Wide shell (≥ 900 px)**: `.app` is a 100dvh grid (8 px gutters; one `minmax(0, 1fr)`
  column, so content never widens it): a 40 px transport bar, then `.shell`, a flex column
  of three rows — `#shell-top` (Generate 67 | Wavetables 33, flex 55), the Timeline strip
  (110 px; 100 px under 840 px tall, 124 px on large screens) and `#shell-bottom` (Voice 45
  | Sequence 55, flex 45). `.shell-row` is `display: contents` in the phone column, so the
  panels keep one order there. No page scroll; each panel body scrolls if its content
  overflows.
- **Collapsing** (`ui/layout.ts`): one controller holds, per layout (wide / narrow), the
  collapsed panels and the maximized one with the arrangement to restore; it is saved with
  the session (UI prefs `layoutWide` / `layoutNarrow`; pure helpers `toggled`,
  `maximized`, `wideShapes`, `parseLayoutState` are unit-tested). It only writes classes,
  never reads layout: `.panel.collapsed` + `data-shape` = `strip` (collapsed beside an open
  sibling: `flex: 0 0 32px`, a vertical `writing-mode` button with the title and status)
  or `bar` (its whole row collapsed, or the Timeline: the row / strip becomes `flex: 0 0
  34px`, the button horizontal), and on `.shell` `top-collapsed` / `tl-collapsed` /
  `bottom-collapsed` (both outer rows collapsed: the Timeline grows) and `data-max`.
  `flex-grow` / `flex-basis` transition in 160 ms (none with reduced motion); canvases
  follow through their ResizeObservers. A collapsed panel's `isOpen()` is false, so its
  views don't draw; `onToggle` marks them dirty on expand. Each panel gives a status
  function (`Panel.setStatus`), polled ≤ 5 / s from the frame loop only while collapsed.
  Maximize (header button or double-click on the header's empty parts) collapses all the
  others; any manual collapse / expand ends it (the restore point is dropped). The
  Wavetables editor (`wt-editing`, Generate hidden) counts Wavetables as alone in its row,
  and opening it expands Wavetables in both layouts.
- **Timeline lanes**: when the strip is taller than two cells (≥ 193 px, e.g. maximized)
  the waveforms run in lanes, column by column (index = column × lanes + lane), one lane per
  96 px; hit testing, carets and scrolling to the selection use the same mapping
  (`#timeline-grid[data-lanes]`). At its usual height it is one lane, as before.
- **Synth voice, full view** (`ui/synthFull.ts`): the Synth panel shows either its pages or
  every control at once. A ResizeObserver on the Voice panel body (border box, so the
  panel's own content can't feed back), debounced 90 ms (a collapse transition settles
  first), and a change of the oscillators' wavetable shapes trigger `decide()`: below
  860 × 180 px of body (or on the narrow shell) the pages; otherwise it tries the full view
  roomy (46 px cells, values under the knobs) then dense (35 px cells, the value replaces
  the label on hover / focus / drag), with as many rows of cells per column as the height
  allows (`--rows`, 5–9), and keeps the first that doesn't overflow (scroll sizes of the
  view, its two parts and the body). The groups are CSS grids flowing in columns of
  `--rows` cells (`grid-auto-flow: column`; labels and selects have no intrinsic width,
  so a group is exactly its columns wide) and share the spare width; the envelopes are one
  group with a column each. The presets, the type select and the mod matrix are the
  pages' own elements, moved into the side column while the full view shows (so their ids
  and handlers stay). Knobs (`ui/knob.ts`): `role="slider"` with `aria-valuenow` / `-min` /
  `-max` / `-valuetext`, arrow / Page / Home / End keys (each press one undo step; Shift+←/→
  stays the page-wide waveform move), pointer drag with capture (`touch-action: none`;
  160 px for the full range, Shift ×4 finer; release = one undo step), double-click resets
  tuning, unison, pan and ± amounts (`reset`); the arc is an SVG path with `pathLength` 100 and a dash array. At 1440×900
  and 1180×820 with only Sequence collapsed it fits (roomy at 1440, dense at 1180, also
  with both oscillators on 2D wavetables); the Synth panel body has 6 / 8 px padding. The Seed tab fills Generate (library column;
  formula row; wave + spectrum flex; batch row + strip), and so does Mutate (library
  column | source + parameters row; wave + spectrum flex; batch row + strip; the batch
  row wraps when the column is narrower than ~700 px, via a container query), and so
  does Breed (library column | parent chips row with a compact Add selected / Use window
  group; one controls row (bias, walk, mutation, seed); wave + spectrum flex, ≥ 100 px,
  with the operator / shown child / weights / legend in the row under the waveform;
  batch row + strip, cards without their spectrum below 860 px tall; it fits the panel at
  1440×900 and 1180×820 without scrolling, the chip row scrolls sideways when there are
  more parents than fit). Shape: chain column (steps, + Add step) | head (source, step,
  amount, ↦ Sweep), the step's settings (wrap), the plot of the selected step (input
  dashed, output solid, drawing in `--v2`) beside the other view, the Apply to row and the
  result cards; it fits at 1440×900 and 1180×820. Wide batch rows wrap rather than
  overflow; the Shape chip shows only its label in narrow Mutate / Breed panels (Breed also
  drops its "Batch" heading there) so Breed's row stays one line. The shared Generate pieces use `gen-*`
  classes (`.gen-tab`, `.gen-lib`, `.gen-strip`, …).
- **Narrow shell (< 900 px)**: the same panels in the same order, one scrolling
  column, each collapsible (Wavetables starts collapsed); the transport bar is sticky.
- **Wavetables editor**: `.shell.wt-editing` hides Generate, so Wavetables takes the
  whole first row; the panel body becomes a 200 px list |
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
  Sequence panel shows its sequence(s). Its playhead is `stepAtTick(status.tick, …)` of
  the shown sequence; `#seq-pos` is `tickBarBeat(status.tick)`, the transport bar.beat
  (not the pattern's). The grid canvas carries `data-step-length`, `data-beats` (shaded
  steps), `data-bars`, `data-whole-bars`, `data-step` and `data-tick` for tests. A crowded
  header (muted target, several sequences, a long length) wraps to a second line on the
  wide shell; the grid gives up the height.
- Session menu: a native popover like the MIDI one (`#session-pop`); notices are one
  fixed element at the bottom centre (`#session-notice`, `role=status`), hidden after 9 s
  unless they carry an action.
- Remembered per browser (localStorage, try/catch): `mkwavez.theme` (only once
  toggled; default dark, applied before first paint by an inline script in
  index.html), `mkwavez.timelineView` (Waveform / Spectral / both) and `mkwavez.midi`
  (`{ input: 'off'|'all'|id, inputName, omni, cc: {position, positionY, lfoDepth, lfoRate, level, cutoff, …, lfo3Depth} }`; every CC_PARAMS target, missing ones unassigned).
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
- Worklet → main: `ready`, `status` (sequencer clock tick, per voice: modulated positions
  pos / posY, resolved coordinates index (x) / y, env, note; table count), `error`.
- Everything the bridge queues within one task is sent as a single `batch` message,
  applied atomically between render quanta: a re-indexed wavetable (eviction) and the
  remapped voice windows always land together, and fresh tables' mip sets (built
  synchronously, up to 128) precede the wavetables that reference them (the model emits
  'timeline', 'wavetables', 'voices' in that order).
- The bridge reconciles: it tracks which table/voice/sequence ids the worklet has (tables
  with the data array sent, so a restored / imported session that reuses an id with other
  data is re-sent) and sends adds/removes on each model topic. Undo that restores evicted tables simply
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
  collapsed, on either shell), on screen (IntersectionObserver; this also covers
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
  preview is a whole batch computed the same way (key: parent ids, operator, bias, walk,
  weights, rate, seed, mode, N; restarted at most every 50 ms; ≤ 8 ms per frame, shown
  child first) through `breedBatchTable()`, which Add reuses; its library thumbnails (each
  operator on the parents at the current bias / walk / mutation / seed) follow Mutate's
  rules (150 ms, in view, budgeted). Parent spectra are cached per table data array. The Seed preview is a
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
- Mod wheel (CC 1, besides whatever the CC map does with it) and channel pressure (0xDn,
  parsed by parseMidi) are routed as `mod` / `pressure` events: per-voice values the
  Synth voice's matrix reads. Synth voices scale the (±2 st) bend by their own bend range.
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

- Sequencer clock (`SynthEngine.process`): a fractional sample accumulator per eighth
  note (`stepSamples(bpm, sr, '1/8')`, exactly the arithmetic of the original
  eighth-note sequencer), split into 6 ticks by thresholds inside the eighth, so 12
  ticks per quarter note. A sequence steps on ticks that are multiples of its
  `STEP_TICKS`, step index `(tick / STEP_TICKS) % length`, all counted from the
  transport start: every step length divides a bar, so bar lines (and every shared
  boundary) fire on the same sample for every sequence, and nothing drifts. 1/8
  sequences fire on exactly the samples they did before step lengths (tests compare the
  render with a frozen copy of the old engine, `tests/fixtures/legacyEngine.ts`). A step
  length change takes effect on the next boundary of the new grid (the sounding note
  keeps its gate: no cut, no click); a tempo change on the next eighth. Gate =
  `stepSamples(bpm, sr, stepLength) × gate`.

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

## Synth voice (engine)

- `SynthEngine.process(out, frames, outR?)` renders stereo (without `outR`: the mono sum
  (L + R) / 2). Simple voices are added to both channels unchanged, so a session of Simple
  voices renders sample-identically to the engine before Synth voices
  (`tests/simpleVoice.test.ts` against the frozen `tests/fixtures/mainEngine.ts`).
- Note handling, gate, amp ADSR (the voice's attack / decay / sustain / release), bend
  smoothing and the sequencer are shared; a Synth voice's `SynthVoice` (allocated on the
  command thread when it first becomes Synth) adds the rest. Switching type crossfades the
  two paths over 10 ms; every switch into Synth re-syncs the path (pitch snapped to the
  current note, envelopes per the gate, filter cleared if silent).
- Control block (64 samples): glide (one-pole on the pitch, ~98% after the glide time),
  pitch envelope and mod envelope (stepped per block), LFOs, the matrix (sources →
  destinations, `applyMatrix`), then block-end phase increments (pitch + bend × range / 2
  + tuning + pitch env + matrix), unison copy weights / detune ratios / stereo gains, mip
  levels (ring mod: one level fewer harmonics on both oscillators; FM: A's level keeps
  every harmonic plus the Carson sidebands, (2π·1.5·fm + 1)·f_B, under the limit), both table mixes
  (WtOsc.resolve: the same crossfaded, id-tracked mixes as the Simple voice), the block
  part of the log cutoff (knob + key tracking + velocity + matrix; one-pole smoothed),
  resonance, levels, pan and gain targets. Per sample everything is ramped linearly
  across the block; the filter envelope runs per sample and the cutoff (tan) is
  recomputed every sample.
- Per sample: osc B copies (FM source: B's first copy), osc A copies at phase + FM, mixer
  (A, B, ring A × B, sub with polyBLEP square, seeded white / pink noise), drive, filter
  (two ZDF SVF cores; LP24 = Butterworth first stage + resonant second), saturation, amp,
  width (mid / side), soft limiter (linear to ±1, < ±2). While unison copies are spread the
  voice is stereo (a second filter, which starts from the first one's state; back to mono
  once the copies are gone and both filters agree). Unison places are symmetric for every
  count (1: centre; 2: ±½ detune, hard left / right; 3: centre, ±1; 4: ±⅓, ±1 — detune
  and spread alike); when the count changes, copies glide to their new places (~30 ms) and
  fade in / out over 10 ms (weights towards 1/√n). The pitch reference is a virtual centre
  copy per oscillator (ratio 1, its own phase): its wraps drive Step-mode table switches
  and hard sync (B's centre restarts A's copies at the fraction of the sample past its
  wrap; A isn't advanced again that sample), and B's centre is the FM source. With one copy
  audible the centre phase is locked to it.
  Tempo-synced LFOs that don't retrigger steer into lock with the transport position
  (cycles from beat 0) while it plays, at up to ±½ of their own speed — so Play never makes
  them jump (a slow division can take up to about a cycle to lock; only forward wraps start
  a new S&H cycle); LFO-rate modulation multiplies their speed (unlocked while it is non-zero,
  then they glide back into lock). Denormal-range filter / pink state is flushed per block.
- CPU guard: per control block the engine counts the unison copies of Synth voices holding
  a note (release tails don't count); over `UNISON_BUDGET` (32) it limits — each voice's
  copies are scaled by budget / count (floor, ≥ 1 per oscillator: 8 voices at 4 + 4 →
  2 + 2; they fade, never cut) until the count falls to ¾ of the budget (hysteresis) — and
  `status.unisonLimited` is set. Bench (`npm run bench`, node, this machine): 8 Synth
  voices ≈ 0.24 ms per 128-sample quantum (9% of real time at 48 kHz); the worst case
  (unison 4 + 4 on all 8, FM, sync, spread; guarded to 2 + 2) ≈ 0.44 ms (17%).


- Determinism: noise and modulation randomness (S&H, smooth random, per-note random) come
  from per-voice PRNGs seeded from the voice id.

## Porting notes

The native port is underway in `plugin/` (see `docs/PLUGIN.md`): `plugin/core` mirrors
`src/core` file by file, and `tests/golden.test.ts` pins the core's outputs in a fixture
the C++ tests compare against, so a change here that alters those numbers fails
`npm test` until the fixture is regenerated (and the port updated).

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
  need a `sum(k, n, expr)` builtin or similar) plus the waveform functions of
  `core/generators/waveFunctions.ts` (pure core code: each calls a generator's raw-cycle
  function, so the C++ generators can back them; "Edit as formula" output and the glyph
  contour literals are plain strings, numbers and arrays). Formula recipes store the
  expression text, so tables still carry provenance.
- **Formula waveform functions** (`waveFunctions(seed, memo)`, passed to every FormulaFn
  as its 7th argument, built per table by `formulaTable`): each returns its generator's
  cycle *before* shape() at phase x — on the 2048-sample grid (x·2048/2π within 1e-9 of an
  integer) the generator's own sample, so `saw(p)` or the formula "Edit as formula" writes
  for a mode renders bit-identically (tested for every mode, random params, seeds and batch
  sizes); between grid points the basic waves sum their 72 harmonics in closed form, pulse
  is the naive pulse, perlin is evaluated directly and the rest interpolate (Catmull-Rom).
  Raw rather than normalised values because shape() of an already-shaped float64 cycle
  differs from the original in a few near-zero samples (≈1e-15), which would break the
  bit-identity. Whole-cycle generators are memoised per render (`CycleMemo`, LRU 32, plus a
  last-arguments fast path); loop-bound arguments (CA / Life generation, RD step, sequence
  position) are range-checked so a formula can't hang the page. "Edit as formula" writes
  batch sweeps in the generators' own arithmetic (`a+(b-a)*u`, `start+k*n`,
  `pow(|b−a|+1,u)-1` for Karplus passes) and numbers that read back exactly; Glyph contours
  become compact string literals (2 base64url characters per coordinate k/1000, exact
  because traced contours have 3 decimals).
- Cross-version determinism of re-rendering is not guaranteed (no recipe/version tag), so
  sessions store samples except for `basic` / `pulse` waveforms verified bit-exact at save
  time (with a hash checked at load); exported files always carry samples.
