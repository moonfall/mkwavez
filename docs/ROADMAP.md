# Roadmap

## M1 — Foundation (done)

TypeScript + Vite + AudioWorklet; portable `src/core`; shape() pipeline, seeded
generators with recipes, per-octave mip sets, timeline (cap 4096, pin-aware
eviction), wavetable model (1D/2D types, auto "All"), multi-voice engine with ADSR,
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
- Evolve: toggle; every 0.7 s mutates the newest table with the current mutation at
  `min(A, 30%)` and a fresh seed (single add, so following windows extend).
  It pauses while the Generate section is collapsed or another tab is showing, and
  Undo stops it (otherwise the next tick would re-add what was undone).
- Recipes (`op: 'mutate'`) record mutation, amount, batch amount, mode, seed, batch
  index/count and parent id(s); `renderRecipe` reproduces every mutation × mode
  (unit-tested). Window following and batch targets behave as for seed batches;
  undo covers Apply / Apply N / each Evolve step.
- **Breed decision:** kept in Mutate as the prototype's magnitude pull, with the
  second parent clearly defined: "Mate from window of" picks a voice; the mate is
  one table from that voice's window chosen by the Apply's seed (one mate for the
  whole batch, shown in the tab and recorded as `parents[1]`). With no voice to take a
  mate from, Apply / Apply N / Evolve are disabled for Breed. The M3 Breed tab
  supersedes it with explicit multi-parent selection (done in M3: removed from Mutate).

Deferred / known gaps from M2:
- Each Evolve tick is an undo step, so a long Evolve run pushes older history out of
  the 40-deep undo stack (as in the prototype).
- Breed of a table with few harmonics (e.g. a sine) borrows the source's
  near-zero-magnitude phases, which are effectively noise — same as the prototype.
  (M3: resolved in the Breed tab; the mutation is legacy.)
- Recipes have no code-version tag yet (M5); chain re-render cost grows with the
  chain index (i+1 mutations).
- No amount-curve preview per mutation (e.g. which mutations want Log sweep) beyond
  the Steps readout.

## M3 — Breed tab (done)

- Generate → Breed: 2–8 parents in an ordered list (A first) held by the model
  (`AppModel.breedParents`). Add them with Shift/Ctrl/⌘-click or a touch long-press
  in the Timeline (cells get an A/B/… badge), "Add selected", or "Use window" of a voice
  (evenly spaced picks when the window holds more than 8). Cards show a thumbnail and
  can be reordered (‹ ›) or removed (×); parents evicted from the timeline (or removed
  by undo) drop out of the list.
- Operators (`core/breed.ts`, DOM-free, seeded, output through shape()):
  Crossfade (time domain), Spectral mix (magnitudes and phases interpolated
  separately), A mags + others' phases, A phases + others' mags, Envelope transfer
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
  child j seed derived from the Apply seed, child 0 = preview). Generation of a
  deterministic operator at 0% mutation is disabled (it would add N copies).
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
- No Evolve for breeding (e.g. keep breeding the newest table with a voice window);
  Mutate's Evolve no longer offers the old Breed.
- Parent reorder is by buttons, not drag; no "select range" in the timeline.
- Parent list isn't part of undo snapshots (undo only drops parents that vanish).
- Splice segment count, crossfade width and envelope smoothing are fixed constants,
  not controls. Spectral magnitude/phase interpolation as a voice blend mode is still
  open.
- Recipes still have no code-version tag (M5).

## M4 — Sample tab

- Mic (getUserMedia) and file input; waveform view of the recording.
- Pitch detection (YIN / autocorrelation), manual override.
- Single-cycle extraction: zero-crossing/phase-aligned cycle, resampled to 2048,
  then shape().
- Batch: N cycles spread across a recording (evenly or by onset), giving a timeline
  trajectory of the sound's evolution.

## M5 — Save/load and 2D wavetables

- Project save/load (IndexedDB + file export): tables (sample data + recipe), timeline
  order, wavetables, voices, sequences. Version tag on recipes.
- User wavetables: create from a selection / voice window, reorder, duplicate entries;
  these pin their tables against eviction (already enforced by the model).
- 2D wavetables: grid editor, voices get X/Y position + two LFOs, bilinear blend.

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
