# Roadmap

## M1 — Foundation (done)

TypeScript + Vite + AudioWorklet; portable `src/core`; shape() pipeline, seeded
generators with recipes, per-octave mip sets, timeline (cap 4096, pin-aware
eviction), wavetable model (1D/2D types, auto "All"; superseded by the wavetables
milestone), multi-voice engine with ADSR,
step sequences on a shared transport, undo for adds and note edits, unit + smoke tests.

## M2 — Mutate tab (done)

- Generate → Mutate: source = the Timeline selection, source and preview side by
  side (waveform + spectrum; the preview waveform overlays the source faintly).
- All prototype mutations, grouped Morph / Waveshape / Spectral / Random; Amount 0–1;
  live preview while dragging (frame-loop, throttled to ≤ 20 recomputes/s, only when
  visible).
- One seed per Apply, shown in the tab; preview, Apply and every table of a sweep
  share it; a new seed after each Apply, or on Reroll.
- Apply (adds one table and selects it, so repeated Apply walks a lineage) and
  Apply N (adds a batch from the same source, which stays selected) with Linear
  sweep `A·i/N`, Log sweep `A·64^((i−N)/(N−1))` and Chain (each step mutates the
  previous at A; step seeds derived from the Apply seed).
- Evolve (a timer mutating the newest table): removed in the Mutate rebuild (see
  below); periodic additions will be designed separately.
- Recipes (`op: 'mutate'`) record mutation, amount, batch amount, mode, seed, batch
  index/count and parent id(s); `renderRecipe` reproduces every mutation × mode
  (unit-tested). Window following and batch targets behave as for seed batches;
  undo covers Apply / Apply N.
- **Breed decision:** kept in Mutate as the prototype's magnitude pull, with the
  second parent clearly defined: "Mate from window of" picks a voice; the mate is
  one table from that voice's window chosen by the Apply's seed (one mate for the
  whole batch, shown in the tab and recorded as `parents[1]`). With no voice to take a
  mate from, Apply / Apply N were disabled for Breed. The M3 Breed tab
  supersedes it with explicit multi-parent selection (done in M3: removed from Mutate).

Deferred / known gaps from M2:
- Breed of a table with few harmonics (e.g. a sine) borrows the source's
  near-zero-magnitude phases, which are effectively noise — same as the prototype.
  (M3: resolved in the Breed tab; the mutation is legacy.)
- Recipes have no code-version tag yet (M5); chain re-render cost grows with the
  chain index (i+1 mutations).
- No amount-curve preview per mutation (e.g. which mutations want Log sweep) beyond
  the Steps readout.

## M3 — Breed tab (done)

- Generate → Breed: 2–8 parents in an ordered list (A first) held by the model
  (`AppModel.breedParents`). Add them with Shift/⌘-click (also Ctrl-click off macOS) or a touch long-press
  in the Timeline (cells get an A/B/… badge), "Add selected", or "Use window" of a voice
  (evenly spaced picks when the window holds more than 8). Cards show a thumbnail and
  can be reordered (‹ ›) or removed (×); parents evicted from the timeline (or removed
  by undo) drop out of the list.
- Operators (`core/breed.ts`, DOM-free, seeded, output through shape()):
  Crossfade (time domain), Spectral mix (magnitudes and phases interpolated
  separately; phases as weighted shortest-arc offsets from A, so sweeps stay
  continuous through antiphase harmonics, tested), A mags + others' phases, A phases + others' mags, Envelope transfer
  (A's harmonics re-weighted toward the others' smoothed spectral envelope), Harmonic
  split (log-harmonic bands, A lowest), Genetic per harmonic and per third-octave band
  (seeded masks), Time splice (8 seeded segments, 64-sample circular raised-cosine
  crossfades).
- One Bias control mapped to per-parent weights by a walk: Path A→B→…→last, Ring
  A→…→A, or Custom weights (per-parent sliders; bias moves from A to that mix). Bias 0
  is shape(A) for every operator (tested). Mutation adds seeded Jitter at
  `rate · min(1, 2·(1 − max w))`, so pure parents stay exact.
- Breed adds one child and selects it; Breed N = Sweep (bias B·i/N, one seed; seeded
  masks hand harmonics over monotonically) or Generation (N children at the same bias,
  child j seed derived from the Apply seed, child 0 = preview). Breed N is disabled when it would only add
  copies: Sweep at bias 0, or a Generation with no effective mutation (rate 0, or one
  parent holding all the weight) and a deterministic operator or a single winning
  parent.
- Recipes (`op: 'breed'`) record operator, bias, batch bias, mode, walk, weights,
  rate, seed, batch index and all parent ids; re-rendering reproduces every operator ×
  walk × mode exactly (unit-tested). Preview, seeds, window following, batch window
  targets and undo work as in Mutate.
- **Mutate's Breed decision:** removed from the Mutate picker. The Breed tab subsumes
  it ("A phases + others' mags" with two parents is the old magnitude pull, minus the
  noisy borrowed phases: harmonics a parent lacks take a donor's phase). The mutation
  stays in `core/mutations.ts` (`legacy`) so older `mutate`/`breed` recipes still
  re-render.

Deferred / known gaps from M3:
- Parent reorder is by buttons, not drag; no "select range" in the timeline.
- Parent list isn't part of undo snapshots (undo only drops parents that vanish).
- Splice segment count, crossfade width and envelope smoothing are fixed constants,
  not controls. Spectral magnitude/phase interpolation as a voice blend mode is still
  open.
- Recipes still have no code-version tag (M5).

## Mutate tab rebuild (done)

- Same hierarchy as the rebuilt Seed tab, sharing its components (`ui/library.ts`,
  `ui/batch.ts`): mutation library (search by name, group or amount-mapping hint; ▲/▼
  and arrow keys; grouped Morph / Waveshape / Spectral / Random; `rnd` tag on seeded
  mutations; each thumbnail is that mutation applied to the current source at the
  current amount / seed over a faint source, recomputed throttled and only for
  visible entries); source chip + "Group › Name" with the amount mapping, Amount,
  Seed / Reroll only when seeded; the shown table over the source (wave dashed /
  solid, spectrum grey / accent); batch row (Linear / Log / Chain with formula
  tooltips, N, voice targets, Add shown, Add +N) and the card strip (←/→; last card
  shown by default).
- The preview is the whole batch, computed incrementally through
  `mutateBatchTable()`, so Add shown / Add +N append exactly what is shown (tested);
  recipes unchanged (old `single` recipes still re-render).
- Evolve removed (button, timer, the `undone` model topic it used, docs, smoke).

Deferred: no Edit layer yet (the `finalTable()` slot is there, as in Seed); the
amount slider has no per-mutation curve (e.g. suggesting Log for small-amount
mutations).

## M4 — Sample tab

- Mic (getUserMedia) and file input; waveform view of the recording.
- Pitch detection (YIN / autocorrelation), manual override.
- Single-cycle extraction: zero-crossing/phase-aligned cycle, resampled to 2048,
  then shape().
- Batch: N cycles spread across a recording (evenly or by onset), giving a timeline
  trajectory of the sound's evolution.

## Wavetables — phase 1 (done)

- Model (`core/wavetable.ts`): named slot sets referencing timeline ids; shapes 1D (fixed /
  variable), 2D (X×Y grid), Rows (differing row lengths); empty slots; per-wavetable
  interpolation (Blend / Step, moved from the voice); Live / Frozen with a write head
  (direction, edge, on-wrap, replace / insert, new row per batch), unit-tested for every
  setting combination; pinning (built-ins that mirror the timeline don't pin).
- Built-ins: Timeline, Last batch, Batches (Rows), Grid (2D 8×8). Undo of an add reverts
  their updates too.
- Voices on any wavetable: 1D window + position as before; 2D / Rows X / Y windows,
  positions and independent X / Y LFOs. Engine: bilinear / row-aligned Blend over
  mip-mapped tables, Step on wrap, per-table weight ramps (click-free switches), packed
  wavetables shipped in the existing atomic batches.
- UI: compact Wavetables panel (chips, 1D stack / 2D grid / Rows view, window tints,
  write head, summary with Blend / Step); Voice panel wavetable select, read-only
  interpolation, X/Y pad + paired sliders on 2D / Rows; Timeline tints for voices on any
  wavetable. MIDI: Position Y CC target (unassigned by default).
- "Sets window of" checkboxes removed from Seed / Mutate / Breed: a voice that should
  follow batches plays the built-in Last batch (V1 does at start).

Deviations / known gaps:
- Interpolation can be switched on built-ins (in the panel's summary line): there are no
  user wavetables yet, so it would otherwise be impossible to choose Step.
- Rows: direction ±x only (±y is coerced); wrap cycles existing rows, new rows come only
  from "new row" batches. The voice's X window is unused on Rows (X spans each whole row).
- The pad shows at most 16 rows of a Rows wavetable (around the voice's row window);
  the panel's 1D stack shows at most 24 slots (evenly spaced).
- Window following: a batch now also extends Timeline windows that end on the newest
  table (previously only single adds did).

## Wavetables — phase 2

- Expanded editor over the Generate row (see the mocks): wavetable list (built-in /
  yours), strip / stack / grid / rows views, write-head settings, next-write markers.
- User wavetables: + 1D / 2D / Rows, Duplicate (a built-in → an editable copy), rename,
  Live / Frozen, interpolation, write-head settings; drag from the Timeline onto a slot
  (replace) or between slots (insert); remove / reorder slots. These pin their tables.

## Native plugin (in progress)

JUCE 9 plugin + standalone app in `plugin/`, aiming at parity with the web app; plan,
build and verification in `docs/PLUGIN.md`.

- P0 (done): C++ port of the audio core (DSP, playback, engine, MIDI routing) checked
  against the TS core by a golden fixture (`tests/golden.test.ts` →
  `plugin/core/tests/golden/core.golden.txt`); VST3 / AU / CLAP / LV2 / Standalone;
  lock-free command queue + pointer retirement; sample-accurate MIDI; host tempo / play;
  4 voice slots of automatable parameters; state save / load; minimal editor; VST3 host
  test; CI on Linux / macOS / Windows.
- P1 (done): the web app is the editor, bundled into the plugin and shown in the system
  web view (no browser), driving the native engine through the same bridge protocol;
  project save / load (`src/app/project.ts`) saved with the plugin state; host
  automation / transport / MIDI settings in sync; end-to-end web view test.
- Next: P2 hardening (pluginval, DAWs, per-host web view quirks, project files, presets),
  P3 release (signing, installers, licence).

## M5 — Save/load

- Project save/load (IndexedDB + file export): tables (sample data + recipe), timeline
  order, wavetables (already plain data), voices, sequences. Version tag on recipes.

## Deferred from M1 / known gaps

- Undo does not cover slider moves, voice add/remove or sequence add/remove (by
  design for now). Undoing past an eviction restores the evicted tables (the bridge
  rebuilds and re-sends their mip sets).
- Mip sets are built on the main thread (chunked); move to a Worker if 4096-table
  catch-up (~1 s) becomes noticeable.
- Worklet memory: ~16 KB per table (≈ 64 MB at the 4096 cap). Consider only sending
  tables inside some voice window, or dropping level 0 for distant tables.
- Blend crossfade and LFO are block-rate (64 samples) with ramped crossfade; gain is
  smoothed. No per-voice filter yet; polyphony / MIDI input not started.
- Sequencer: no swing, velocity, per-step probability, or scale choice; multiple
  sequences on one voice just retrigger it (monophonic, last note wins).
- Formula language is JS (browser-only); a portable expression parser is needed for
  native targets.
- No draw-a-waveform / image-contour generators yet (discussed in the prototype).
- No E2E audio-content assertion in the browser (engine output is unit-tested in node).
