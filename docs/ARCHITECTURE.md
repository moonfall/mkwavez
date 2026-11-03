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
    mutations.ts        prototype mutations (identity at amount 0) + sweep amounts
    mutateBatch.ts      Apply / Apply N (lin, log, chain) → tables + recipes; seeding
                        rules; renderMutateRecipe() re-renders from parent tables
    breed.ts            multi-parent breed operators, bias walks → per-parent weights,
                        breedBatch (single / sweep / gen), renderBreedRecipe()
    mipmap.ts           per-octave band-limited mip sets, packed in one Float32Array
    table.ts            WaveTable, Recipe, IdAllocator
    timeline.ts         appendWithEviction (oldest-first, pin-aware), index/window remap
    wavetable.ts        Wavetable1D / Wavetable2D, "All", pinnedIds()
    voice.ts            VoiceParams, LFO position, window following (followAppend)
    sequence.ts         SequenceData, scale → frequency, step helpers
    engine/             SynthEngine (audio-thread engine) + Adsr
  browser/formulaEval.ts  JS expression → FormulaFn (browser-only convenience)
  app/model.ts          AppModel: main-thread state, actions, undo, topic events
  audio/                protocol.ts (messages), worklet.ts (AudioWorkletProcessor adapter),
                        bridge.ts (AudioContext owner, state → messages, mip building)
  ui/                   Plain DOM + canvas panels (no framework), styles.css tokens
                        (dark default, [data-theme=light]); dom.ts panel() = one shell
                        panel (header tools, body; collapsible on the narrow shell);
                        context.ts UiState (selected voice tab, shared by voices.ts
                        and sequences.ts); canvas.ts drawing + theme (setTheme,
                        stored in localStorage); transport.ts the top bar;
                        generate.ts hosts the tabs: seed.ts (Seed tab), mutate.ts
                        (Mutate tab) and breed.ts (Breed tab); timeline.ts (strip,
                        toggles Breed parents); wavetables.ts (overview; the slot for
                        1D / 2D wavetable editing)
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
  Single and sweep tables all use the Apply's seed; chain step j uses
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
- **Breed parents** — `AppModel.breedParents`: ordered ids (≤ 8) of timeline tables,
  topic `parents`. Filtered whenever the timeline changes (eviction, undo); not part
  of undo snapshots.
- **Timeline** — ordered `WaveTable[]`, cap 4096. Eviction is oldest-first and skips
  tables referenced by any non-auto wavetable (`pinnedIds`). If everything is pinned
  the timeline may exceed the cap.
- **Wavetable** — `1d { ids[] }` or `2d { width, height, ids[] (row-major, null=empty) }`.
  M1 has only the auto 1D "All" (id 0) mirroring the timeline. Voices address
  positions in a wavetable, not timeline indices.
- **VoiceParams** — wavetable id, inclusive window, position, LFO depth/rate/phase,
  interp (`blend` | `step`), octave, level, mute, ADSR. Plain data shared verbatim
  with the engine.
- **SequenceData** — target voice, length (≤ 64), 64 steps (row or -1), gate.
- **Undo** — snapshots of the timeline array (references), selection, voice windows
  and sequence steps; 40 deep. Covers adds, note edits and window edits (a slider
  drag is one step); other slider moves are not undoable.

## UI layout

- **Wide shell (≥ 900 px)**: `.app` is a 100dvh grid (8 px gutters): a 40 px transport
  bar, then `.shell` with three columns (45 / 22 / 33 fr) and three rows
  (55 fr / timeline strip 110 px (100 px under 840 px tall, 124 px on large screens) /
  45 fr): `gen gen wt` · `tl tl tl` · `voice seq seq`. No page scroll; each panel
  body scrolls if its content overflows. The Seed tab fills Generate (library column;
  formula row; wave + spectrum flex; batch row + strip); Mutate / Breed lay out in two
  columns and scroll inside it.
- **Narrow shell (< 900 px)**: the same panels in the same order, one scrolling
  column, each collapsible (Wavetables starts collapsed); the transport bar is sticky.
- Voice tabs: `UiState.voiceId` (kept valid as voices come and go: a removed voice's
  neighbour is selected). The Voice panel shows only that voice's controls; the
  Sequence panel shows its sequence(s).
- Remembered per browser (localStorage, try/catch): `mkwavez.theme` (only once
  toggled; default dark, applied before first paint by an inline script in
  index.html) and `mkwavez.timelineView` (Waveform / Spectral / both).

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
  `tables/remove`, `wavetable/set` (Int32Array of ids), `voice/set|remove`,
  `sequence/set|remove`, `transport`.
- Worklet → main: `ready`, `status` (sequencer step, per-voice position/index/env,
  table count), `error`.
- Everything the bridge queues within one task is sent as a single `batch` message,
  applied atomically between render quanta: a re-indexed wavetable (eviction) and the
  remapped voice windows always land together, and fresh tables' mip sets (built
  synchronously, up to 128) precede the wavetable that references them.
- The bridge reconciles: it tracks which table/voice/sequence ids the worklet has and
  sends adds/removes on each model topic. Undo that restores evicted tables simply
  re-sends them. Bulk backlogs (e.g. 4096 at audio start) arrive in 48-table chunks.
- The engine tracks playing tables by table id, not wavetable index: Step holds its
  table pointer until the phase wraps; Blend ramps only while the id pair is
  unchanged; a table that hasn't arrived yet keeps the previous pointer. Removed
  voices fade out with a 12 ms release before being freed.
- The audio thread never runs an FFT or allocates per sample. LFO/window/mip
  resolution runs every 64 samples; the Blend crossfade is ramped across the block.
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
  draw never feeds back into layout; ResizeObservers mark them dirty. The Mutate preview is computed in the frame loop,
  not in input handlers: only while the tab is showing and on screen, only when its
  key (source id, mutation, amount, seed) changed, and at most every 50 ms while a
  control is dragged. Apply reuses the preview table when the key matches. The Breed
  preview follows the same rules (key: parent ids, operator, bias, walk, weights,
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

## Playback semantics

- Position = `position + depth/2 · sin(lfoPhase)`, reflected into [0,1], mapped onto
  the window. **Blend** crossfades the two neighbouring tables; **Step** holds one
  table and switches only on the oscillator's phase wrap (click-free).
- Mip level per note: the richest level whose top harmonic `f·K < 0.45·sr`.
  Levels keep 72/36/18/9/4/2/1 harmonics at 2048…64 samples (~28 samples/harmonic).
- Window following: a single add extends windows ending on the newest table; a batch
  sets windows of the ticked voices to exactly the batch; eviction remaps windows so
  they keep pointing at the same tables.

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
