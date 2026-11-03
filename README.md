# mkwavez

An evolving wavetable synth: single-cycle waveforms are continually generated (later:
mutated, bred, sampled) onto a growing timeline, and each voice plays a movable window
over a wavetable built from it. This browser build is the development testbed; the
`src/core/` DSP/data code is written to port to a plugin (JUCE/C++) and hardware.

See `docs/prototype-handoff.md` (original spec + prototype), `docs/ARCHITECTURE.md`
and `docs/ROADMAP.md`.

## Run

Requires Node 20+.

```sh
npm install
npm run dev        # http://localhost:5173 — press Play to start audio
npm test           # core unit tests (vitest)
npx tsc --noEmit   # typecheck
npm run build      # typecheck + production build to dist/
npm run smoke      # build, then headless-Chrome smoke test against preview and dev servers
```

The smoke test uses `/usr/bin/google-chrome` by default (`CHROME=/path` to override;
`SHOTS=dir` saves screenshots).

## Using it

- **Generate → Seed**: add basic waves, formula tables (presets or your own JS
  expression in `p`, `t`, `n`, `u`, `pnoise()`), Perlin noise or cellular-automaton
  tables, one at a time (`+1`) or as a batch of N (`+N`). A batch sets the window of
  every voice ticked under "Batch sets window of".
- **Generate → Mutate**: mutate the table selected in the Timeline (source and live
  preview side by side). Pick a mutation and Amount; the shown seed is used by the
  preview, Apply and every table of Apply N (Linear / Log sweep or Chain). Reroll
  draws a new seed; one is drawn after each Apply. Evolve keeps mutating the newest
  table on a timer.
- **Generate → Breed**: combine 2–8 parents. Shift-click (or Ctrl/⌘-click) or
  long-press tables in the Timeline, "Add selected", or "Use window" of a voice; reorder
  or remove them on their cards. Pick an operator (crossfade, spectral mix, magnitude /
  phase swaps, envelope transfer, harmonic split, genetic masks, time splice), a Bias
  (0 = parent A) and how it walks the parents (path, ring, custom weights), and a
  Mutation rate. Breed adds one child; Breed N sweeps the bias or makes a seeded
  generation of N children.
- **Timeline**: every table, in order (cap 4096). Click to select and inspect;
  Shift-click / long-press toggles Breed parents (badged A, B, …).
- **Wavetables**: the auto "All" wavetable as an amplitude heat map with voice windows.
- **Voices**: window, position, LFO, Blend/Step, octave, level, ADSR per voice.
- **Sequences**: 8-row pentatonic step grids, one per voice by default; shared tempo.
- **Undo** (transport bar) covers table adds (including Apply / Apply N), window
  edits and note edits.
