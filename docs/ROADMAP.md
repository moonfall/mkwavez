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
  masks hand harmonics over monotonically) or Generation (N children around bias B,
  child j seed derived from the Apply seed, child 0 = preview; children after the first
  nudge the bias by 0.1–0.25 of a walk segment, and custom weights by up to 2×, so every
  operator gives N different children; recipes record each child's own bias / weights).
  Breed N is disabled when it would only add copies: Sweep at bias 0. The default bias
  sits between two parents (½ of two, ¾ of three on the path) until the slider is moved;
  double-click returns to it.
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

## Shape tab (done)

Generate → Shape edits waveforms with a chain of steps (design reviewed before building).

- Steps: draw on the waveform (hard / soft clip, fold — above, below or both ± —,
  replace, push, pull with a radius, add, multiply) with Line, Curve or Free drawings that
  act over the span drawn; harmonics (set: keep / remove / add / replace multiples, a list,
  odd, even, primes, Fibonacci or painted bars, with a 1/kᵖ law and a phase for new
  harmonics; modify: shift, stretch, tilt, mirror, randomize over a harmonic range; limit
  to a drawn curve: limit / floor / fit / scale); whole wave (any Mutate mutation, gain,
  invert, reverse, rotate). Amount per step, ↦ Sweep across a batch, seed / Vary.
- The tab: chain column (toggle, reorder by drag or Alt+↑/↓, + Add step, step menu), the
  plot of the selected step in the Waveform or Harmonics view, Apply to the selection,
  Last batch, a voice window or a wavetable (Write back into a Frozen wavetable of yours,
  one undo step), result cards, Add / Add +N. Results are new waveforms ('shape' recipes);
  the source stays selected.
- Chains: in the model with undo; factory chains (Warm fold organ, Soft clip, Clip ramp,
  Odd only darker, Bright limited, Low-pass opening, West-coast fold, PWM from anything,
  Talking vowels, Tape warmth, Ensemble drift, Hollow out, Phaser comb, Diode grit,
  Metallic, Drawbar organ, Phase scatter); save / rename / delete, New, Load the
  selection's chain (from its recipe), export / import; realign phase option; saved with
  the session.
- Shape on add: a Shape chip in Seed, Mutate and Breed batch rows shapes previews and adds
  (`Recipe.shape`). Seed's "Edit · planned" toggle is gone.

Known gaps: draw steps (clip / fold) run at 2048 samples without oversampling, so very
hard folding can alias below h72; a drawing can sweep (start → end drawing) but other settings (knee, radius, harmonic numbers) can't;
no symmetry tool or grid snapping yet. On phones the chain list sits above the plot (it
doesn't collapse like the libraries).

## M4 — Sample tab (done)

- Sources: input device and tab / system audio (browser: recorder worklet, takes up to
  60 s, start on sound / stop on silence, Grab = the last 10 s), mkwavez output (a voice
  rendered offline through the TS engine — browser and plugin), audio files (open / drop;
  the plugin's native dialog). Takes kept until reload.
- Pitch detection (YIN through an FFT autocorrelation), manual override, fine tune.
- Single cycle: zero-crossing cut, cycles averaged, seam crossfade, aligned or as cut;
  candidates = the next cycle groups.
- Series: frames across a selection (even, onsets, timbre change), tracked or fixed pitch,
  smoothing; its own frame count; Add batch can make a 1D wavetable.
- Harmonic snapshot: partials measured over a window (fold / drop off-harmonic energy,
  floor), resynthesised with measured / zero / Schroeder phases.
- Not yet: live input in the plugin (needs an audio input / sidechain bus and capture in
  the native engine); a take's waveform zoom; saving takes with the session.

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

## Wavetables — phase 2 (done)

- Expanded editor over the Generate row (Edit / Collapse; Generate hidden, the Timeline
  below is the drag source): wavetable list (built-in / yours, + 1D / 2D / Rows), 1D strip /
  stack, 2D grid, Rows views with voice windows, write head and next-write markers
  (`previewWrites`, the real write head on a copy), header (rename, size, Blend / Step,
  Duplicate, Delete), Live / Frozen + write-head settings (inapplicable options disabled;
  built-ins read-only), head moves (Alt-click / “Write head here”).
- User wavetables: create, duplicate (built-ins into editable copies), rename, delete
  (voices fall back to the Timeline), 1D fixed / variable + length and 2D X × Y resize
  (confirm before dropping waveforms); pointer-event drags from the Timeline or slots:
  replace, insert, new row, move / swap / copy, plus clear / remove; hovering a list
  entry opens it, dropping on it adds there. Live user wavetables write every add. All
  content edits undoable; pins follow every edit (unit-tested), smoke-tested end to end.

Deviations / known gaps:
- New wavetables and duplicates start Frozen (a duplicate is a snapshot; a live copy of
  the Timeline would pin everything). A user wavetable holds at most 1024 slots (MAX_USER_SLOTS: a Live one that fills stops its head, shown as "full"; adds still go into the Timeline); the Timeline never exceeds
  its cap — when every waveform is pinned, adds are refused with a notice.
- Interpolation stays switchable on built-ins (the mock disables it) so voices on the
  Timeline etc. can still use Step. Write-head settings can be changed while Frozen (to
  prepare before going Live); next-write markers show only when Live.
- The Stack view takes no drops (switch to Strip); confirmations use the browser's
  `confirm()`; no context menu: the selected slot's actions (and Delete / Shift+Delete)
  cover it, also on touch. On a phone the editor sits above the Timeline: dragging up
  auto-scrolls the page.
- The view marks the next 4 writes (as one batch).

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
  the session (src/core/session.ts, via the regular autosave / restore and a plugin
  session backend) saved with the plugin state; host automation / transport / MIDI
  settings in sync; end-to-end web view test.
- Synth voice (done): `plugin/core` has the Synth voice path (oscillators with unison,
  sub, noise, ring, FM, hard sync, ZDF filter, envelopes, LFOs, mod matrix, CPU guard,
  stereo), matched sample for sample against the TS engine by golden scenarios.
- Next: P2 hardening (pluginval, DAWs, per-host web view quirks, project files, presets),
  P3 release (signing, installers, licence).


## M5 — Save/load (partly done: autosave / restore, export / import)

Done:
- The session survives reloads and browser restarts: autosaved to IndexedDB (debounced,
  incremental: each waveform written once, chunked at idle time; flushed when the page
  is hidden) and restored before the first render. Saved: timeline (samples, or the
  recipe for exact cheap basic / pulse waveforms, or a reference for copies), id
  allocators (incl. the monotonic wavetable id), selection, Breed parents, all wavetables
  (built-ins' state, user wavetables from the editor with write heads and Live state;
  stored generically), voices (incl. 2D / Rows), sequences,
  BPM, voice tab and Generate tab. Theme, timeline view and MIDI settings stay in
  localStorage.
- Versioned schema (`SESSION_VERSION`, `MIGRATIONS`); corrupt / incompatible saves fall
  back to a fresh session (bad save kept for debugging, notice offers to discard it);
  missing waveforms are dropped with a warning. No storage (private mode, blocked) →
  runs normally with autosave off and a notice.
- Session menu in the transport bar: New session (confirm; clears the autosave), Export
  / Import one `.mkwz` file (JSON + Float32 samples).
- One tab autosaves at a time (Web Locks); others are paused and can take over. Orphan
  records from an interrupted save are never reused; an unrestorable save is set aside
  intact (exportable); at the storage quota unreferenced records are deleted first.

Open:
- Undo history isn't saved (it starts empty after a reload / import).
- Named projects (several saves, a list, rename / delete), save-as; import without
  replacing (merge into the current timeline).
- Seed / Mutate / Breed panel settings (entry, formula edits, amounts) aren't saved.
- Recipes still have no code-version tag (re-render determinism across versions is only
  checked by a hash for recipe-only waveforms). Example: the Mutate spectral pipeline's
  relative-silence gate (results keeping < 1e-3 of the source's strongest harmonic are
  silence, residue below 1e-6 dropped) changes the re-render of a few old mutate
  recipes — Toward sine / Odd only at ≥ ~0.97 or Formant at 1 on sources without a
  fundamental now give silence instead of normalised residue. Saved sessions are
  unaffected (only basic / pulse waveforms are stored as recipes).

## Synth voice (done)

- Per-voice type Simple | Synth. Simple is the original voice, unchanged (tested
  sample-identical to the engine before Synth voices); existing / migrated voices (session
  v3 → v4) are Simple. "+" offers Synth or Simple; a type switch crossfades (10 ms) and is
  undoable. Voices were monophonic (note stack, legato, sequences, MIDI routing shared);
  Synth voices are polyphonic since stage 5.
- Stage 1: osc A (the voice's wavetable / window / position) and osc B (own source) with
  octave / coarse / fine / level, sub (sine / square, −1 / −2 oct), seeded white / pink
  noise, ring A × B; ZDF SVF LP12 / HP / BP / notch + LP24 (cascaded), cutoff, resonance to
  Q 100, drive, key tracking, env and velocity amounts; amp / filter ADSR, pitch envelope
  (A / D, ± 24 st, target); velocity → amp; glide (legato only); bend range; pan; stereo
  output. Compact Osc · Mix · Filter · Env pages; CC targets; schema v4; undo.
- Stage 2: 3 LFOs (6 shapes, Hz or tempo-synced, retrigger / free, phase, fade-in, depth),
  mod envelope (AD / ADSR), 8-slot matrix (11 sources incl. mod wheel and channel
  pressure, 18 destinations), block-rate into the existing ramps; Mod page; aftertouch in
  core/midi; CC targets for LFO rate / depth.
- Stage 3: hard sync B → A, FM (B → A phase), unison 1–4 per oscillator (detune, stereo
  spread) with a CPU guard (32 copies across voices), post-filter saturation, stereo width;
  presets (Init + Sub bass, Pluck, Evolving pad, Sync lead, Brass, Noise sweep on the
  built-in wavetables; user presets saved with the session, exported / imported as JSON);
  copy / paste a voice between tabs.
- Stage 4 (stereo voice): the path runs on two channels whenever something makes them
  differ, and back on one otherwise (unchanged output for patches without stereo
  settings). Per-oscillator pan, stereo phase and stereo position (a second table mix per
  oscillator for the right channel), noise width, filter cutoff spread, a stereo phase per
  LFO driving per-channel destinations (positions, levels, cutoff, amp); new matrix
  destinations A pan, B pan, filter spread; width applies to every stereo source; the CPU
  guard counts double-read copies twice. No change to the wavetables.
- Stage 5 (polyphony): `synth.poly` 1–8 (Init 8; saved voices without it stay mono, as
  are the Sub bass and Sync lead presets). Poly 1 is the monophonic path, unchanged. A
  polyphonic voice's own path plays one note; the rest come from a pool of 24 notes shared
  by all voices (also the CPU cap). Same key → its note; else a silent note; else steal
  the quietest released, then the oldest. Poly glide from the last note's pitch; sequencer
  steps get a note each (tails overlap). Simple voices stay monophonic. Mix page "Voices",
  full view Output "Voices".
- Stage 6 (warps): per oscillator sync, formant, bend, squeeze, quantize, fold, amount
  −1..1 (matrix A warp / B warp); mip levels follow each warp's speed-up. No oversampling
  yet: hard sync, fold, quantize and drive still alias at high notes.

Decisions / deviations:
- New voices from "+" are offered as Synth (first in the menu) or Simple; both start on
  the Timeline as before. A new Synth voice gets the Init patch: LP24 at 2.4 kHz and
  LFO 1 → osc A position X (+30%), so a wavetable evolves out of the box.
- Synth voices don't use the Simple voice's position LFOs; their motion comes from the
  matrix. The amp ADSR, level, octave and mute are shared fields (so they survive a type
  switch).
- Pan is a balance law (centre = unity on both channels), so a centred Synth voice is as
  loud as before in each channel.
- LFO rate CC moves turn the LFO's tempo sync off (so the knob is heard).
- Presets and synth parameters needed no further schema bump: `normalizeSynth` fills
  missing fields with the Init patch's — except the matrix: saved data without one gets
  all-empty slots (an existing voice keeps sounding as saved; the LFO 1 → position route
  is only for new voices and the Init preset). `voicePresets` is an optional meta field.
- Presets reference wavetables robustly (built-in kind, or your wavetable's name + shape);
  a missing one plays Last batch, with a notice.
- On a Synth voice CC 1 is the mod wheel (a matrix source) only: the default CC 1 →
  Position X mapping applies to Simple voices. Wheel and pressure reset with CC 121, input
  loss and routing changes (moving to the new target voice, like the bend).
- Undo restores only the sound of the voice the undone edit changed (live MIDI CC moves on
  other voices survive).

Known gaps:
- Osc B's window is not drawn in the Timeline / Wavetables views (only osc A's), and the
  Wavetables panel's "used by" lists voices by osc A.
- No oversampling: hard sync and drive / saturation alias somewhat at high notes (ring mod
  drops one mip level; FM drops harmonics by its sideband width).
- Unison places are symmetric for every count; a count change glides the copies to their
  new places (~30 ms, heard as a brief detune move). Hard sync, Step-mode switches and FM
  follow a virtual centre copy, so they don't depend on the count.
- The CPU guard reduces every limited voice's copies alike (budget / count), not by
  per-voice priority.
- Tempo-synced, non-retriggering LFOs glide into lock with the transport (no jump at Play);
  LFO-rate modulation unlocks them while it is non-zero. Steering at ±½ speed, a slow
  division can take up to about a cycle to lock (e.g. 8 bars).


- Presets don't include the voice's sequence or the Simple-voice LFOs; "copy voice" copies
  everything but id, name and mute (undoable when the target is a Synth voice).
- No per-step velocity in sequences, so the velocity source is 1 for sequencer notes.

## Deferred from M1 / known gaps


- Undo does not cover slider moves, voice add/remove or sequence add/remove (by
  design for now). Undoing past an eviction restores the evicted tables (the bridge
  rebuilds and re-sends their mip sets).
- Mip sets are built on the main thread (chunked); move to a Worker if 4096-table
  catch-up (~1 s) becomes noticeable.
- Worklet memory: ~16 KB per table (≈ 64 MB at the 4096 cap). Consider only sending
  tables inside some voice window, or dropping level 0 for distant tables.
- Blend crossfade and LFO are block-rate (64 samples) with ramped crossfade; gain is
  smoothed. (Synth voices now have a filter; MIDI input is done; Synth voices are polyphonic.)
- Sequencer: no swing, velocity, per-step probability, or scale choice; multiple
  sequences on a monophonic voice just retrigger it (last note wins).
- Formula language is JS (browser-only); a portable expression parser is needed for
  native targets.
- No draw-a-waveform generator yet (Glyph contour covers text outlines; arbitrary
  image contours could reuse its polyline path).
- No E2E audio-content assertion in the browser (engine output is unit-tested in node).
