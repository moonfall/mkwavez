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
                        renderRecipe() to re-render a table from its recipe
    mutations.ts        prototype mutations + sweep amounts (UI lands in M2)
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
  ui/                   Plain DOM + canvas sections (no framework), styles.css tokens
  main.ts               initial state, section assembly, frame loop
tests/                  vitest unit tests (core + AppModel)
scripts/smoke.mjs       headless-Chrome smoke test (playwright-core)
```

## Data model

- **WaveTable** `{ id, data: Float32Array(2048), recipe }` — immutable, always shaped.
  `id` is a monotonic integer, never reused.
- **Recipe** `{ op, params, seed, parents[], batch?{index,count} }` — plain data,
  enough to re-render deterministically (`renderRecipe`; tested for every generator).
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
- UI: one rAF loop, ≤ 25 fps while playing. Sections redraw only when open, on screen
  (IntersectionObserver) and dirty or animating. The timeline is a virtualized grid on
  one sticky canvas (only visible rows drawn); the wavetable overview is a cached
  heat-map bitmap with overlays.

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
