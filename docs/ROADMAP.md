# Roadmap

## M1 — Foundation (this milestone)

TypeScript + Vite + AudioWorklet; portable `src/core`; shape() pipeline, seeded
generators with recipes, per-octave mip sets, timeline (cap 4096, pin-aware
eviction), wavetable model (1D/2D types, auto "All"), multi-voice engine with ADSR,
step sequences on a shared transport, undo for adds and note edits, unit + smoke tests.

## M2 — Mutate tab

- UI for every prototype mutation (already ported and identity-tested in
  `core/mutations.ts`): Morph, Waveshape, Spectral, Random groups.
- Source = selected table; live preview (waveform + spectrum) with the same seed as
  Apply; Reroll.
- Apply / Apply N with Linear sweep, Log sweep (64:1) and Chain; seeded per batch;
  recipes record `op: 'mutate'`, mutation id, amount, seed, parent id.
- Evolve (timed auto-mutation of the newest table).
- Breed-mutation pool from a chosen voice window.

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
