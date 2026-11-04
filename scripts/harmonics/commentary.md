<!-- Hand-written commentary spliced into docs/reports/harmonic-interest.md by report.ts.
     Written against the default configuration (k 8, N 8, seed 0x5eed, default weights);
     review it whenever the evaluation or the generators change. -->

<!-- @summary -->
- **Top by overall score:** *Vowel formants*, *Sinc*, *Iterated sine map*, *Rounded bell partials* and the Perlin *Zoom*: pitched spectra that keep changing across the batch. **Bottom:** the four basic waves and *Digits of π*, which are static.
- **Several generators play above the note.** Their waveforms have no fundamental, and every present harmonic is a multiple of 2 or more, so they sound an octave or more above the played pitch:
  - *Gray code* and *Euclidean pulses*;
  - *Logistic map* and *Dynamical systems* (the logistic map is symmetric about 0.5, so only even harmonics survive);
  - *Polygon* read as radius vs angle (an n-gon has only multiples of n);
  - *Superformula* (m = 6 → multiples of 6);
  - the *Chebyshev* waveshaper entry (even orders give even harmonics only).

  This is now part of the score (*pitch*). See the Gray code note in the caveats.
- **Coherent sweeps vs random walks.** Noise and automaton generators change every waveform but wander: path ≈ 45–55 dB, net ≈ 4–8 dB. The motion term now credits net displacement, so coherent sweeps have closed most of the gap: *Sync sweep* scores 72 and *Schroeder phases*, *Primes* and *Nested FM* about 67, against 68–75 for the noise generators.
- **Real defects** (each reproducible below):
  - *Superformula*'s default batch starts with a silent waveform (n2 = n3 = 2 is a circle).
  - *Digits of π* gives 8 identical waveforms (shifting by n is a rotation, which `shape()` removes).
  - The *Reverse* mutation does nothing below amount 0.5 on odd-symmetric sources (saw, square, any sum of sines) and turns them silent at 0.5.
  - Chaining *Hard sync* at amount 1 goes silent from the 4th step on.
  - Breed with 3 parents at the default bias 0.5 (path walk) returns parent B unchanged, so a Generation batch is 8 copies of it.
- **Amount mappings that waste range:**
  - *Decimate* stays under 0.5 dB up to amount 0.4.
  - *Resonant low-pass* stays under 2 dB up to 0.3.
  - *Crush* is about 1 dB at the default 0.25.
  - Four phase mutations, *Magnitudes from A* and the *Phase scatter* chain don't change the harmonic magnitudes at all. That is by design, but this evaluation can't see what they do.

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
- **Formula presets vs parameter modes.** Overall, formula presets average 63.5 and generator / parameter-mode entries 59.9. The generator figure is pulled down by the four static basic waves and by the dead corners in the random batches. On default batches alone, without the basic waves, generator entries average 68.9 (formula presets: 63.5).
- **Pitch-shifted waveforms** (see the summary list):
  - *Polygon* (radius read) starts at a triangle (multiples of 3) and adds a side per waveform, so its pitch climbs with the batch.
  - *Superformula* with m = 6 is six-fold symmetric.
  - *Logistic map* and *Dynamical systems* (logistic map) depend only on sin²(p), so they sound an octave up.

  In a wavetable these waveforms jump in apparent pitch as the position moves, which may be wanted but is rarely expected.
- **Random walks.** The noise and automaton generators (Perlin, cellular automaton, Life, reaction-diffusion, Supersaw, Bytebeat) change their whole fine structure on every waveform (mean step ≈ 6–9 dB), but straightness is only 0.1–0.16 and the centroid stays roughly flat. They still score in the 60s–70s for density and constant change.
- **Coherent sweeps** (straightness ≥ 0.8): *Sync sweep*, *Schroeder phases*, *Primes*, *Fibonacci*, *Weierstrass*, *Blancmange*. Apart from *Sync sweep* (40 dB net), these travel only 10–21 dB, so a wider sweep would make them more useful (recommendations).
- **Static or barely moving defaults:**
  - *Digits of π*: n rotates the 16 digits, and `shape()`'s phase alignment undoes a rotation, so the batch is 8 copies of one waveform. *Cellular automaton* rule 184 (a pure shift) is static for the same reason.
  - *Spline*: the default "Sweep jitter" batch travels 5 dB. The three random batches using "Add a point per waveform" score 66–75; the five using "Sweep jitter" score 18–45.
- **Silent waveform.** *Superformula* with m = 6, n1 = 2, n2 = n3 = 2 is a circle, so waveform 1 of the default batch is silent. The original formula preset had the same problem at u = 0.
- **Dead corners in random batches.**
  - *Karplus-Strong*: default 74, random mean 38. With the "Pluck shape" excitation, passes beyond about 500 are a sine.
  - *Polygon*: Trace reading of a convex 15–16-gon is a near-sine.
  - *Weierstrass* / *Blancmange* with terms = 1.
  - *Life*: the Maze rule freezes.
  - *Number sequences* with advance 0 (static by definition).
  - *Waveshaper* entries: hard clip with a low input level and a far-off bias saturates.
  - *CZ resonance*: high ratios leave the fundamental 40+ dB down.

<!-- @mutate -->
- **Large effects at the default amount.** Spectral *Stretch*, *Window impose*, *Hard sync*, *Fold* / *Fold + smooth*, *Window & repeat*, *Harmonic shift* and *Smooth* change every reference by 5–18 dB at 0.25, and their sweeps are the best batches in this section.
- **Source-dependent mutations.** Many waveshapers (*Self phase mod*, *Noise warp*, *Phase warp*, *Chebyshev mix*, *Rectify*, *Logistic shaper*, *Ring mod*, *Palindrome*) change the formant wave by 9–25 dB but a saw by ≤ 1 dB at 0.25. A likely reason: smearing energy between neighbouring harmonics barely changes a dense, smooth 1/k spectrum in dB, while it fills the valleys of a formant spectrum.
- **Near no-ops at 0.25.**
  - *Decimate*: under 0.5 dB up to amount 0.4. 2048 / 2^(7a) hold steps leave harmonics ≤ 72 alone until the step count nears 144.
  - *Resonant low-pass*: under 2 dB up to 0.3. The cutoff 1.5·500^(1−a) is above harmonic 72 until a ≈ 0.38.
  - *Crush*: 28 levels at 0.25, about 1 dB.
  - *Blur*, *Comb*, *Jitter* and *Spread up*: 1–3 dB.
  In all, 23 of the 48 mutations change a saw by ≤ 2 dB at 0.25.
- **Reverse is degenerate on odd-symmetric waveforms.** Saw, square, triangle and any additive sum of sines are odd once phase-aligned, so reverse(x) = −x. The blend (1−a)·x + a·(−x) = (1−2a)·x is the source itself until a = 0.5, where it is **silent**. Above 0.5 the inverted copy is phase-aligned straight back to the source. Reproduce: Reverse, lin, amount 0.5 or 1, on a saw: waveform 4 of 8 is all zeros.
- **Chain collapse.** *Hard sync* chained at amount 1 compounds the read ratio to 4^(j+1). From the 4th step on, the cycle repeats every 2048 / 256 = 8 samples, so all of its energy is above harmonic 72 and the band-limited result is silent (5 of 8 waveforms). *Toward sine*, *Smooth* and *Spectral contrast* chained at 1 collapse to ≤ 3 harmonics within a few steps, which is expected.
- **Phase-only by design.** *Zero phase*, *Schroeder phase*, *Phase randomize* and *Scramble* leave every magnitude untouched (0.0 dB), and *Half-cycle swap* at amount 1 is −x(t+½), with the same magnitudes. These change the cycle's shape (RMS difference 0.2–1.3) and matter before a nonlinear step, not on their own.
- **Lin vs log.** Lin batches generally score higher than log batches. Log crowds 7 of 8 waveforms into small amounts, which for most mutations means near-duplicates.

<!-- @breed -->
- **Crossover operators move the most.** *Genetic per harmonic* is best by a clear margin (per-harmonic picks change on every child and with every seed), followed by *Genetic per band*. *Harmonic split* and *Crossfade* sweeps are good (62–73), but their Generation batches are not. *Splice* sweeps are half duplicates: the seeded segment picks change in discrete jumps as the bias moves. Its Generation batches are strong (65).
- **Generation mode with unseeded operators.** *Crossfade*, *Spectral mix*, *Phases from A*, *Envelope transfer*, *Harmonic split* and *Magnitudes from A* give 8 near-identical children. Only the 0.05 jitter differs, and scores are 20–25.
- **3 parents at bias 0.5 (path walk) lands exactly on parent B.** The weights are [0, 1, 0], so at a pure parent the jitter amount is 0. Every child is then B itself (path 0, 100% duplicates), for every operator, seeded or not. With 2 parents, bias 0.5 is the midpoint as intended.
- **Magnitudes from A** is phase-only by design (≈ 0.2 dB from A). **Envelope transfer** with a sine as A stays a sine.

<!-- @shape -->
- **Sweeping chains make the strongest batches** on any source: *Talking vowels* (85), *West-coast fold* and *PWM from anything*. *Low-pass opening*, *Phaser comb* and *Hollow out* do nothing to a sine (it has nothing to filter).
- **Non-sweeping chains.** These are fixed timbre transforms (identical batches by construction) and change the source by 2–25 dB. *Drawbar organ* and *Warm fold organ* cut a saw to 30–44 harmonics, *Odd only, darker* to 35. *Soft clip* and *Tape warmth* are gentle on a saw (≈ 4–5 dB), and *Clip ramp* only reaches 5.5 dB on a saw by its last waveform.
- **Near no-op seed-per-waveform chains.** *Ensemble drift* moves about 0.6 dB per waveform, which is barely audible as motion. *Phase scatter* is phase-only.

<!-- @grid -->
Mutate rows move a little less per step than the columns do (fold at 0.25: 2.5–4.3 dB per row). The *Low-pass opening* chain makes columns converge where the filter is closed: 59% duplicates along X for the Additive designer columns.

<!-- @recommendations -->
1. **Pitch-shifted generators:** decide whether "sounds an octave (or n×) up" is intended. If not:
   - Polygon (radius read): offer a fundamental, e.g. an off-centre reading point or a mix with the plain cycle.
   - Superformula: same; or note it in the entry's description.
   - Logistic map / Dynamical systems (logistic): an asymmetric initial condition, e.g. 0.5 + 0.4·sin(p) + 0.1·sin(2p), breaks the sin² symmetry.
   - Gray code / Euclidean pulses: avoid masks and pulse counts that repeat within the cycle.

   At least flag such waveforms in the UI.
2. **Superformula default:** n2 = n3 = 2 makes the radius constant (a circle), so waveform 1 is silent. Start at e.g. n2 = n3 = 3 → 8. Do the same in the formula preset (`2+u*6` → `3+u*5`).
3. **Digits of π:** make n change something other than a rotation of the same 16 digits, so the batch isn't 8 copies. For example, take a longer digit list and read a 16-digit window of it, or change the step count per waveform.
4. **Spline:** make "Add a point per waveform" the default batch, or let jitter move points much further. The default batch travels 5 dB; point-adding batches move 29–40 dB along their path.
5. **Decimate / Resonant low-pass / Crush amount mapping:** remap so the useful range starts near amount 0.
   - Decimate: steps = 144 · 2^(−6a), from just above the band limit down to 2.25.
   - Resonant low-pass: cutoff = 72 · (1.5 / 72)^a.
   - Crush: fewer levels at low amounts.
   As mapped now, the default 0.25 is a no-op for the first two and about 1 dB for Crush.
6. **Reverse:** blend against the reversed cycle with a phase offset, or offer reverse only at a = 1 (as a flip). The blend is degenerate on every odd-symmetric source and silent at a = 0.5. At minimum, guard against a silent result.
7. **Hard sync chain:** keep the compounded read ratio non-integer (or cap it), so chaining at amount 1 can't collapse to silence.
8. **Breed defaults:** for P > 2 parents with the path walk, default the bias to land between parents (e.g. 0.5 / (P−1), halfway from A to B), or apply the jitter even at a pure parent. In Generation mode, disable or hint the unseeded operators, or raise the default rate, since their 8 children are near-identical.
9. **Parameter ranges with large dead zones:**
   - Karplus-Strong: cap or rescale passes against damping and length; most of 0…4096 is already a sine for the Pluck shape.
   - Weierstrass / Blancmange: minimum terms 2.
   - Polygon: hint that Trace + convex + many sides is a sine.
10. **Coherent but short sweeps** (*Fibonacci*, *Blancmange*, *Primes*, *Weierstrass*, *Schroeder phases*): widen the default ranges (e.g. rolloff 1.5 → 0, decay 0.3 → 0.9). They travel in one direction but only 10–21 dB.
11. **Mutate default amount:** at 0.25, nearly half of the mutations change a saw by ≤ 2 dB, though most do much more to the formant wave. Per-mutation default amounts (or an amount mapping that equalises the perceived effect) would make the library thumbnails more telling.
