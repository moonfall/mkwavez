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
- Recipes (`op: 'mutate'`) record mutation, amount, batch amount, mode, seed, batch
  index/count and parent id(s); `renderRecipe` reproduces every mutation × mode
  (unit-tested). Window following and batch targets behave as for seed batches;
  undo covers Apply / Apply N / each Evolve step.
- **Breed decision:** kept in Mutate as the prototype's magnitude pull, with the
  second parent clearly defined: "Mate from window of" picks a voice; the mate is
  one table from that voice's window chosen by the Apply's seed (one mate for the
  whole batch, shown in the tab and recorded as `parents[1]`). The M3 Breed tab
  supersedes it with explicit multi-parent selection.

Deferred / known gaps from M2:
- Each Evolve tick is an undo step, so a long Evolve run pushes older history out of
  the 40-deep undo stack (as in the prototype).
- Evolve keeps running with the Generate section collapsed or another tab showing;
  only the button shows its state.
- Breed of a table with few harmonics (e.g. a sine) borrows the source's
  near-zero-magnitude phases, which are effectively noise — same as the prototype;
  M3's spectral crossover should take phases from a parent explicitly.
- Recipes have no code-version tag yet (M5); chain re-render cost grows with the
  chain index (i+1 mutations).
- No amount-curve preview per mutation (e.g. which mutations want Log sweep) beyond
  the Steps readout.

## M3 — Breed tab

Combine two or more parents (multi-select in the timeline):
- time-domain crossfade (N-step morph between parents);
- spectral crossover: magnitudes from A with phases from B, and vice versa;
- per-harmonic genetic crossover with seeded masks (uniform, single/two-point,
  band-wise), plus seeded mutation rate;
- magnitude/phase interpolation (also a candidate third voice blend mode);
- batches of N children; recipes list all parent ids.

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
