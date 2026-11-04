# mkwavez — overview

mkwavez is a wavetable synth whose wavetables are never finished. Single-cycle waveforms
are generated, mutated, bred and reshaped onto a growing **Timeline**; **wavetables** are
arrangements of those waveforms; **voices** scan windows of a wavetable while it keeps
changing underneath them. It runs in the browser (development testbed, GitHub Pages) and
as a native plugin (VST3 / AU / CLAP / LV2 / Standalone) whose editor is the same web app.

## What makes it different

- **Wavetables as the orbit of a process.** Every Generate operation can produce a batch
  (+N) that sweeps a parameter, so a batch is a trajectory of related waveforms: a filter
  opening, a chaotic map bifurcating, a plucked string decaying, a reaction-diffusion
  pattern evolving. Voices play windows over those trajectories.
- **Live wavetables with write heads.** A wavetable can be Live: each new waveform is
  written at a write head that moves by rules (±x/±y or any x/y step, wrap / stop /
  grow, next row on wrap, replace / insert, new row per batch). Voices pointing at it hear
  it change as you work.
- **Three shapes of wavetable.** 1D (strip or stacked view), 2D (X × Y grid, bilinear
  blend), Rows (rows of different lengths, blended proportionally) — all referencing
  Timeline waveforms by id, with no copies. Waveforms held by your own wavetables (and the
  Last batch and Grid built-ins) are pinned, so the Timeline never evicts them.
  Interpolation (Blend, or click-free Step) is set per wavetable.
- **Everything is a recipe.** Each waveform records how it was made (generator / mutation /
  breed / shape, parameters, seed, parents), so it can be re-rendered exactly; randomness
  is always seeded, and previews are exactly what gets added.
- **Every waveform is crossfade-safe.** One pipeline band-limits, removes DC, aligns the
  fundamental's phase and normalizes every waveform, so any two can be blended without
  comb-filtering; playback uses per-octave band-limited copies.

## Making waveforms (Generate)

- **Seed** — a searchable library: band-limited basic waves; ~37 formula presets (Perlin,
  shapers, phase distortion, spectral series, fractals, chaos, vowels, bit tricks);
  parameter modes: Perlin noise, 1D and Life-like cellular automata, dynamical systems
  (logistic / sine / circle / Hénon / tent), Karplus-Strong snapshots, additive designer,
  number sequences (π, e, Collatz, prime gaps, Euclidean), reaction-diffusion, splines and
  **glyph contours** (type a character, hear its outline). A formula language over phase
  `p`, `t`, batch index `n` and batch position `u`, with built-in functions for every wave
  and mode (`saw(2*p)`, `0.5*ks(p) + perlin(p, …)`), and Edit as formula on any preset.
- **Mutate** — ~45 mutations (morph, waveshaping, spectral, phase, time, nonlinear,
  granular, filters), each leaving the waveform unchanged at 0%, with every mutation's
  effect previewed as a thumbnail; linear / log / chain batch sweeps.
- **Breed** — combine 2–8 parents (crossfade, spectral mix, magnitude/phase swaps, envelope
  transfer, harmonic crossover, genetic, time splice) along a bias walk or as a seeded
  generation of children.
- **Shape** — a chain of editing steps: draw on the waveform (clip, fold, push, pull,
  replace) or on its harmonics (set, shift, stretch, tilt, limit to a drawn curve), apply
  any mutation, sweep any step across a batch; apply to a selection, batch or whole
  wavetable, or attach a chain to Seed / Mutate / Breed adds.

## Playing (Voices, Sequences, MIDI)

Voices are monophonic (last-note priority, legato), one per tab.

- **Simple voice** — window + position (1D) or rectangle + X/Y (2D and Rows) over a
  wavetable, position LFO, ADSR.
- **Synth voice** — two wavetable oscillators (each with its own wavetable window, tuning
  and unison 1–4; B can hard-sync and FM A), sub, noise, ring; multimode ZDF filter with drive and key
  tracking; amp / filter / pitch / mod envelopes; three LFOs (tempo-syncable) and an 8-slot
  mod matrix; glide; presets; a full knob view when the panel has room.
- **Preview and Selection wavetables** — voices can play the Timeline selection, or the
  waveform / whole batch Generate is showing, before anything is added.
- **Sequences** — per-voice step grids with musical step lengths (1/4 … 1/16T) on a shared
  bar clock; **Web MIDI** with channel routing, Omni, CC learn, pitch bend, mod wheel and
  aftertouch.

## Working environment

- One-screen layout (Generate + Wavetables / Timeline strip / Voice + Sequence) with
  collapsible and maximizable panels; dark theme by default; keyboard shortcuts.
- Timeline of up to 4096 waveforms with voice windows drawn as tints and live play
  carets; drag waveforms into wavetables to replace or insert.
- Undo; autosave (in the browser: IndexedDB, one owning tab; in the plugin: with the
  plugin state) with session export / import; saved Shape chains and voice presets.
- Portable core: `src/core/` is DOM-free and allocation-free in the audio path. The plugin
  runs the audio engine (playback, voices, MIDI) as native C++, checked by golden tests
  against the TypeScript engine; generation stays in TypeScript in the embedded web view.

See `README.md` for usage details, `docs/ARCHITECTURE.md` for the code, `docs/PLUGIN.md`
for the plugin and `docs/ROADMAP.md` for what's next (Sample tab, more save/load).
