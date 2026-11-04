<!-- Hand-written commentary spliced into docs/reports/harmonic-interest.md by report.ts.
     Written against the default configuration (k 8, N 8, seed 0x5eed, default weights);
     review it whenever the evaluation or the generators change. -->

<!-- @summary -->
- **Top by overall score:** *Vowel formants*, *Sinc*, *Iterated sine map*, *Digits of π* and *Logistic map*: pitched spectra that keep changing across the batch. **Bottom:** *Harmonics* (one sine per waveform, by design) and the four basic waves, which are a single waveform.
- **Every finding of the first run is resolved** (see *Fixes since first run* for the before / after numbers):
  - *Logistic map*, *Dynamical systems*, *Polygon*, *Superformula* and *Chebyshev* keep their fundamental: every waveform of their default batches has divisor 1 and h1 above −40 dB (they were 2–6.5 and −64 … −120 dB). The app also badges any shown waveform that sounds above its note ("sounds +1 oct").
  - *Superformula*'s default batch has no silent waveform; *Digits of π* gives 8 different waveforms (it was 8 copies); *Spline*'s default batch travels 23 dB (5).
  - *Reverse* never goes silent, *Hard sync* chains stay audible, and *Decimate* / *Resonant low-pass* act at the default amount (4–6 dB on a saw at 0.25, from ≤ 0.8).
  - Breed's default bias with three parents sits between B and C instead of on B, and Generation batches differ for every operator (unseeded operators: 54–70, from 20–25).
- **Still pitch-shifted by design** (the badge flags them): *Gray code* and *Euclidean pulses* (masks and pulse counts that repeat within the cycle), *Harmonics* (sin((n+1)p)), and Polygon's Trace of a star (the pen goes round k times). *CZ resonance (sine window)* has a weak fundamental (−57 dB) at high ratios.
- **Coherent sweeps vs random walks.** Noise and automaton generators change every waveform but wander: path ≈ 45–55 dB, net ≈ 4–8 dB. The motion term credits net displacement, so coherent sweeps have closed most of the gap: *Sync sweep* scores 72 and *Schroeder phases*, *Primes* and *Nested FM* about 67, against 68–75 for the noise generators.
- **What this evaluation can't see:** four phase mutations, *Reverse* (now a phase morph: reversing a waveform never changes its magnitudes), *Magnitudes from A* and the *Phase scatter* chain leave the harmonic magnitudes alone. That is by design, so they score as duplicates here.

<!-- @fixes -->
The first run of this report (main 2821b1b) found the problems below; each is fixed on this branch. *Before* numbers are from that run, *after* from this one (same configuration). Stored recipes still re-render exactly as they were made: retuned Seed defaults only change new batches, new Seed params declare the value that reproduces the old output, and changed mutations are versioned (mutation revision 2; recipes and Shape steps without a revision use the old behaviour).

| Finding | Fix | Before | After |
| --- | --- | --- | --- |
| *Logistic map* sounds an octave up (symmetric about ½) | asymmetric start 0.5 + 0.4·(sin p + 0.2 sin 2p)/1.1 | h1 −120 dB, divisor 2, overall 59.7 (#38) | h1 −7 dB, divisor 1, overall 77.8 (#5) |
| *Dynamical systems* (logistic / sine / tent) an octave up | "Initial condition" param, asymmetric by default | h1 −120 dB, divisor 2, default 59.9 | h1 −10 dB, divisor 1, default 76.5 |
| *Polygon* radius read: only multiples of n | "Off-centre" reading point, 0.25 of the inner radius by default | h1 −113 dB, divisor 6.5, default 49.8 | h1 −0.3 dB, divisor 1, default 67.5 |
| *Superformula*: multiples of 6, first waveform silent | off-centre read (0.25); n2 = n3 sweep from 3 (2 is a circle) | silent waveform, h1 −120 dB, divisor 6, default 36.5 | none silent, h1 −3 dB, divisor 1, default 65.7 |
| *Chebyshev*: even orders give even harmonics only | sweeps odd orders 3…17 | h1 −64 dB, divisor 1.5, default 66.4 | h1 −11 dB, divisor 1, default 74.7 |
| *Digits of π*: 8 identical waveforms (n only rotated the digits) | a new 16-digit window per waveform: `seq(p, 0, 16, 0, 16*n)` | static, path 0 dB, 100% duplicates, 18.6 | path 57 dB, 0% duplicates, 77.9 |
| *Spline* default batch barely moves | default batch adds a point per waveform | travel 5.2 dB (path 6), default 44.2 | travel 23 dB (path 42), default 71.6 |
| *Reverse* no-op below 0.5, silent at 0.5 | phases morph toward the reversed cycle's, magnitudes kept | silent waveforms in 8 batches | none (now phase-only, by nature) |
| *Hard sync* chained at 1 silent from step 4 | where revision 1 is silent, the ratio drops to keep the lowest harmonic at h71.5 (single applications otherwise unchanged) | silent in 3 chain batches, chain score 57.7 | none, chain score 69.5 |
| *Decimate* near no-op at 0.25 | hold 2^(7·a^0.35) samples (same ends) | 0.1 / 0.0 / 0.1 dB at 0.25, score 28.7 | 4.6 / 1.6 / 4.2 dB, score 47.1 |
| *Resonant low-pass* near no-op at 0.25 | cutoff 1.5·96^(1−a) (h144 → h1.5) | 0.8 / 0.1 / 0.8 dB at 0.25, score 40.7 | 5.6 / 0.9 / 5.6 dB, score 54.3 |
| Breed, 3 parents at bias 0.5 = parent B: every child is B | default bias between two parents (¾ for three) | 100% duplicates, path 0 | Crossfade path 29 dB, Genetic 60 dB, 0% duplicates |
| Breed Generation: unseeded operators give 8 near-copies | children after the first nudge bias (and custom weights) | Gen scores 20–25 | Crossfade 60, Spectral mix 63, Phases from A 61, Envelope 54, Split 70 |

Effects are saw / formant / noisy at amount 0.25 (lin). Not changed in this round: *Crush* (about 1 dB on a saw at 0.25), listed with the weak mappings.

<!-- @caveats -->
**Caveats.**
- The score is a sorting heuristic, not a measure of taste. It rewards dense, pitched spectra and batches that get somewhere, and punishes silence, duplicates, pure sines and flat or noise-jagged spectra. A static Sine is a perfectly good waveform; it just has nothing to evaluate here.
- **The Gray code lesson.** The first version of this report ranked *Gray code* first. Its waveforms have no fundamental at all (h1 ≈ −120 dB), and their harmonics share a common divisor (octave-shifted combs). Its "motion" came largely from faint harmonics appearing out of a −60 dB floor, each counted as a step of up to 60 dB. Three fixes followed:
  - distances now use a −40 dB floor;
  - the score has a *pitch* term (weak or missing fundamental, common divisor);
  - motion credits net displacement over wandering.

  Gray code now ranks mid-table.
- The evaluation sees magnitudes only. Phase-only changes, which matter once a waveform is waveshaped, count as duplicates.
- LSD counts a harmonic crossing the −40 dB floor as a step of up to 40 dB, so sparse spectra (a handful of harmonics, e.g. *Harmonics*, *Chebyshev*, *Rounded bell partials*) still move a lot per step.
- *Divisor* uses harmonics above −40 dB. A waveform whose fundamental sits at −50 dB is still counted as pitch-shifted, even though a careful listener may hear the low note.
- Random-parameter batches sample every slider uniformly, so they land in corners nobody would choose: very long Karplus-Strong decays, one-term fractals, frozen Life rules, resonance ratios of 20. Their mean measures how forgiving a parameter space is, not how good it is.
- The irregularity penalty also catches structured but jagged spectra (*Blancmange*: 10.8 dB), not only noise.
- Glyph contour uses a Node stand-in tracer (a stroke font), not system-ui. Its default text "mkwavez" has 7 characters, so waveform 8 repeats waveform 1 and its net displacement is 0.
- Shape chains that don't sweep make identical batches by design. The Shape chains section reports how much they change the source instead.

<!-- @seed -->
- **Formula presets vs parameter modes.** Overall, formula presets average 68.6 and generator / parameter-mode entries 61.6. The generator figure is pulled down by the four static basic waves and by the dead corners in the random batches. On default batches alone, without the basic waves, generator entries average 71.7.
- **Pitch.** The retuned entries keep their fundamental by default; the original readings stay one setting away (Polygon / Superformula Off-centre 0, Dynamical systems' symmetric start) and are badged in the app. Random batches still land on pitch-shifted settings now and then: Dynamical systems with the symmetric start, Polygon traced as a star (the pen goes round k times per cycle).
- **Random walks.** The noise and automaton generators (Perlin, cellular automaton, Life, reaction-diffusion, Supersaw, Bytebeat) change their whole fine structure on every waveform (mean step ≈ 6–9 dB), but straightness is only 0.1–0.16 and the centroid stays roughly flat. They still score in the 60s–70s for density and constant change. *Digits of π* and *Logistic map* now join them (new digits / new chaos on every waveform).
- **Coherent sweeps** (straightness ≥ 0.8): *Sync sweep*, *Schroeder phases*, *Primes*, *Fibonacci*, *Weierstrass*, *Blancmange*. Apart from *Sync sweep* (40 dB net), these travel only 10–21 dB, so a wider sweep would make them more useful (recommendations).
- **Static batches.** None among the defaults except the four basic waves (single waveforms by design). *Cellular automaton* rule 184 (a pure shift) is still static in random batches, for the reason Digits of π was: `shape()`'s phase alignment undoes a rotation.
- **Dead corners in random batches.**
  - *Karplus-Strong*: default 74, random mean 38. With the "Pluck shape" excitation, passes beyond about 500 are a sine.
  - *Polygon*: Trace reading of a convex polygon with many sides is a near-sine; sweeping roundness or rotation of some stars does little.
  - *Spline*: random batches that sweep the jitter (no longer the default batch) still barely move.
  - *Weierstrass* / *Blancmange* with terms = 1.
  - *Life*: the Maze rule freezes.
  - *Number sequences* with advance 0 (static by definition).
  - *Waveshaper* entries: hard clip with a low input level and a far-off bias saturates.
  - *CZ resonance*: high ratios leave the fundamental 40+ dB down.

<!-- @mutate -->
- **Large effects at the default amount.** Spectral *Stretch*, *Window impose*, *Hard sync*, *Fold* / *Fold + smooth*, *Window & repeat*, *Harmonic shift* and *Smooth* change every reference by 5–18 dB at 0.25, and their sweeps are the best batches in this section.
- **Source-dependent mutations.** Many waveshapers (*Self phase mod*, *Noise warp*, *Phase warp*, *Chebyshev mix*, *Rectify*, *Logistic shaper*, *Ring mod*, *Palindrome*) change the formant wave by 9–25 dB but a saw by ≤ 1 dB at 0.25. A likely reason: smearing energy between neighbouring harmonics barely changes a dense, smooth 1/k spectrum in dB, while it fills the valleys of a formant spectrum.
- **Weak at 0.25.** *Decimate* and *Resonant low-pass* now act from small amounts (4.6 and 5.6 dB on a saw at 0.25). Still weak: *Crush* (28 levels at 0.25, about 1 dB), *Blur*, *Comb*, *Jitter* and *Spread up* (1–3 dB). In all, 21 of the 48 mutations change a saw by ≤ 2 dB at 0.25 (23 before).
- **Reverse is a phase morph.** Each harmonic's phase moves toward the reversed cycle's, magnitudes kept, so it is phase-only here (0.0 dB) and never silent. On a sine-phase waveform (saw, square, any sum of sines) the reversed cycle is the same sound; on others the waveform changes shape, which matters before a nonlinear step.
- **Chains.** *Hard sync* chained at amount 1 no longer collapses: where revision 1 would be silent the read ratio drops so the source's lowest harmonic lands at h71.5, and that non-integer ratio leaves a sync edge that brings the low harmonics back for the next step; single applications are otherwise unchanged. *Toward sine*, *Smooth* and *Spectral contrast* chained at 1 collapse to ≤ 3 harmonics within a few steps, which is expected.
- **Phase-only by design.** *Zero phase*, *Schroeder phase*, *Phase randomize*, *Scramble* and *Reverse* leave every magnitude untouched (0.0 dB), and *Half-cycle swap* at amount 1 is −x(t+½), with the same magnitudes. These change the cycle's shape and matter before a nonlinear step, not on their own.
- **Lin vs log.** Lin batches generally score higher than log batches. Log crowds 7 of 8 waveforms into small amounts, which for most mutations means near-duplicates.

<!-- @breed -->
- **Generation batches are now the strongest.** Every child after the first nudges the bias by 0.1–0.25 of a walk segment (and custom weights by up to 2×), so unseeded operators make 8 different children too: *Harmonic split* 70, *Spectral mix* 63, *Phases from A* 61, *Crossfade* 60, *Envelope transfer* 54 (all 20–25 before). Seeded operators gain as well (*Genetic per band* 77, *Splice* 77, *Genetic per harmonic* 75).
- **Default bias.** With three parents the default bias is ¾ (between B and C), so the default sweep walks A → B → halfway to C instead of stopping on B, and no child is a copy of a parent.
- **Crossover operators move the most in sweeps.** *Genetic per harmonic* and *Harmonic split* sweep well (67–73). *Splice* sweeps are still half duplicates: the seeded segment picks change in discrete jumps as the bias moves.
- **Magnitudes from A** is phase-only by design (≈ 0.2 dB from A). **Envelope transfer** with a sine as A stays a sine.

<!-- @shape -->
- **Sweeping chains make the strongest batches** on any source: *Talking vowels* (85), *West-coast fold* and *PWM from anything*. *Low-pass opening*, *Phaser comb* and *Hollow out* do nothing to a sine (it has nothing to filter).
- **Non-sweeping chains.** These are fixed timbre transforms (identical batches by construction) and change the source by 2–25 dB. *Drawbar organ* and *Warm fold organ* cut a saw to 30–44 harmonics, *Odd only, darker* to 35. *Soft clip* and *Tape warmth* are gentle on a saw (≈ 4–5 dB), and *Clip ramp* only reaches 5.5 dB on a saw by its last waveform.
- **Near no-op seed-per-waveform chains.** *Ensemble drift* moves about 0.6 dB per waveform, which is barely audible as motion. *Phase scatter* is phase-only.

<!-- @grid -->
Mutate rows move a little less per step than the columns do (fold at 0.25: 2.5–4.3 dB per row). The *Low-pass opening* chain makes columns converge where the filter is closed: 59% duplicates along X for the Additive designer columns.

<!-- @recommendations -->
Done since the first run: pitch-shifted generators (badge and retuned defaults), Superformula's silent start, Digits of π, Spline's default batch, the Decimate / Resonant low-pass mappings, Reverse, the Hard sync chain and the Breed defaults (see *Fixes since first run*). Remaining:

1. **Pitch-shifted presets by design:** *Gray code* and *Euclidean pulses* could avoid masks and pulse counts that repeat within the cycle; *Harmonics* is one sine per waveform on purpose. The badge flags them in the app.
2. **Crush amount mapping:** fewer levels at low amounts (about 1 dB on a saw at the default 0.25).
3. **Parameter ranges with large dead zones:**
   - Karplus-Strong: cap or rescale passes against damping and length; most of 0…4096 is already a sine for the Pluck shape.
   - Weierstrass / Blancmange: minimum terms 2.
   - Polygon: hint that Trace + convex + many sides is a sine, and that Trace of a star sounds k× up.
   - Spline: the jitter sweep (now the second batch mode) could move the points further.
4. **Coherent but short sweeps** (*Fibonacci*, *Blancmange*, *Primes*, *Weierstrass*, *Schroeder phases*): widen the default ranges (e.g. rolloff 1.5 → 0, decay 0.3 → 0.9). They travel in one direction but only 10–21 dB.
5. **Mutate default amount:** at 0.25, 21 of the 48 mutations change a saw by ≤ 2 dB, though most do much more to the formant wave. Per-mutation default amounts (or an amount mapping that equalises the perceived effect) would make the library thumbnails more telling.
6. **Cellular automaton rule 184** (a pure shift) is static: as with Digits of π before, `shape()` undoes a rotation.
