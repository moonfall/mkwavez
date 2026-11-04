import { describe, expect, it } from 'vitest';
import { generateBasic, generatePerlin, DEFAULT_PERLIN } from '../src/core/generators';
import { harmonicMagnitudes } from '../src/core/fft';
import { mutate, MUTATION_CHOICES, MUTATIONS, mutationUsesSeed, sweepAmounts } from '../src/core/mutations';

const src = generatePerlin(DEFAULT_PERLIN, 4242, 1)[0].data;
const pool = [generateBasic('saw', 0).data, generateBasic('square', 0).data];
const maxDiff = (a: Float32Array, b: Float32Array) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

describe('mutations (core port)', () => {
  for (const m of MUTATIONS) {
    it(`${m.id}: amount 0 is identity, nonzero changes, seeded`, () => {
      const z = mutate(m.id, src, 0, 1, { breedPool: pool });
      expect(maxDiff(z, src)).toBeLessThan(2e-3);
      const a = mutate(m.id, src, 0.6, 7, { breedPool: pool });
      const b = mutate(m.id, src, 0.6, 7, { breedPool: pool });
      expect(maxDiff(a, b)).toBe(0);
      expect(maxDiff(a, src)).toBeGreaterThan(1e-3);
    });
  }

  it('`seeded` is exactly the offered mutations whose result depends on the seed', () => {
    for (const m of MUTATION_CHOICES) {
      const ref = mutate(m.id, src, 0.6, 1, { breedPool: pool });
      const differs = [2, 3, 4, 5, 6].some((s) => maxDiff(mutate(m.id, src, 0.6, s, { breedPool: pool }), ref) > 1e-6);
      expect(differs, m.id).toBe(mutationUsesSeed(m.id));
    }
  });

  it('every offered mutation has an amount hint; legacy Breed is not offered', () => {
    for (const m of MUTATION_CHOICES) expect(m.hint.length, m.id).toBeGreaterThan(8);
    expect(MUTATION_CHOICES.some((m) => m.id === 'breed')).toBe(false);
  });

  it('spectral: shift, mirror, contrast and sieves move / weight the right harmonics', () => {
    const saw = generateBasic('saw', 0).data;
    const mags = (x: Float32Array) => harmonicMagnitudes(x, 72);
    // Shift at a = 1: 16 harmonics up; h2 moves to h18, h1 stays, h2..h17 empty.
    const sh = mags(mutate('hshift', saw, 1, 0));
    expect(sh[1]).toBeGreaterThan(0.1);
    expect(sh[5]).toBeLessThan(1e-6);
    expect(sh[18] / sh[1]).toBeCloseTo(0.5, 2);
    // Mirror at a = 1: saw magnitudes reversed over h2…h72 (h72 gets h2's 1/2).
    const mi = mags(mutate('mirror', saw, 1, 0));
    expect(mi[72] / mi[1]).toBeCloseTo(0.5, 2);
    expect(mi[2] / mi[1]).toBeCloseTo(1 / 72, 3);
    // Contrast at a = 1: γ = 3, so h2 / h1 = (1/2)³.
    const c = mags(mutate('contrast', saw, 1, 0));
    expect(c[2] / c[1]).toBeCloseTo(1 / 8, 3);
    const fl = mags(mutate('flatten', saw, 1, 0));
    expect(fl[2] / fl[1]).toBeCloseTo(Math.pow(0.5, 0.15), 3);
    // Sieves at a = 1 remove the excluded harmonics.
    const pr = mags(mutate('primes', saw, 1, 0));
    expect(pr[4]).toBeLessThan(1e-6);
    expect(pr[7]).toBeGreaterThan(1e-3);
    const fib = mags(mutate('fibsieve', saw, 1, 0));
    expect(fib[4]).toBeLessThan(1e-6);
    expect(fib[8]).toBeGreaterThan(1e-3);
  });

  it('phase: zero phase is symmetric; Schroeder lowers the crest factor; magnitudes kept', () => {
    const saw = generateBasic('saw', 0).data;
    const z = mutate('zeroPhase', saw, 1, 0);
    // Symmetric about some point: the autocorrelation of z with its reverse peaks at 1.
    const n = z.length;
    let best = 0;
    for (let s = 0; s < n; s++) {
      let c = 0;
      for (let i = 0; i < n; i++) c += z[i] * z[(s - i + n) % n];
      best = Math.max(best, c);
    }
    const energy = z.reduce((e, v) => e + v * v, 0);
    expect(best / energy).toBeCloseTo(1, 3);
    const crest = (x: Float32Array) => 1 / Math.sqrt(x.reduce((e, v) => e + v * v, 0) / x.length);
    const flat = generateBasic('saw', 0).data;
    expect(crest(mutate('schroeder', mutate('flatten', flat, 1, 0), 1, 0))).toBeLessThan(crest(mutate('zeroPhase', mutate('flatten', flat, 1, 0), 1, 0)));
    for (const id of ['zeroPhase', 'schroeder', 'phaseRandom'] as const) {
      const m = harmonicMagnitudes(mutate(id, saw, 0.8, 3), 72);
      const s0 = harmonicMagnitudes(saw, 72);
      for (const k of [2, 5, 9]) expect(m[k] / m[1], id).toBeCloseTo(s0[k] / s0[1], 3);
    }
  });

  it('time: repeat, half swap, reverse, slew', () => {
    const saw = generateBasic('saw', 0).data;
    const mags = (x: Float32Array) => harmonicMagnitudes(x, 72);
    // Window & repeat at a = 1: the first 1/8 eight times → only multiples of 8.
    const rp = mags(mutate('repeat', src, 1, 0));
    expect(rp[3] + rp[5] + rp[7]).toBeLessThan(1e-6);
    expect(rp[8]).toBeGreaterThan(1e-3);
    // Half-cycle swap at a = 1: same magnitudes; at ½ the even harmonics cancel.
    const hs = mags(mutate('halfSwap', saw, 0.5, 0));
    expect(hs[2] / hs[1]).toBeLessThan(1e-6);
    const rv = mags(mutate('reverse', src, 1, 0));
    const s0 = mags(src);
    for (const k of [1, 2, 3, 7]) expect(rv[k] / rv[1]).toBeCloseTo(s0[k] / s0[1], 4);
    // Reverse morphs the phases: magnitudes kept at every amount, never silent (even on a
    // sine-phase saw, where the old blend cancelled at ½), the reversed cycle at 1.
    for (const x of [src, saw])
      for (const a of [0.1, 0.25, 0.5, 0.75]) {
        const m = mags(mutate('reverse', x, a, 0));
        const m0 = mags(x);
        for (const k of [1, 2, 5, 11]) expect(m[k] / m[1], `a ${a} h${k}`).toBeCloseTo(m0[k] / m0[1], 4);
      }
    const reversed = Float32Array.from(src, (_, i) => src[(src.length - i) % src.length]);
    expect(maxDiff(mutate('reverse', src, 1, 0), mutate('reverse', reversed, 0, 0))).toBeLessThan(1e-4);
    // The waveform moves away from the source from the start, continuously (no jumps).
    for (let a = 0.05; a <= 1; a += 0.05) {
      expect(maxDiff(mutate('reverse', src, a, 0), src), `a ${a}`).toBeGreaterThan(1e-2);
      expect(maxDiff(mutate('reverse', src, a, 0), mutate('reverse', src, a - 0.01, 0)), `a ${a}`).toBeLessThan(0.1);
    }
    // Revision 1 (stored recipes): the old blend.
    expect(mutate('reverse', saw, 0.5, 0, {}, 1).every((v) => v === 0)).toBe(true);
    // Slew limit at a = 1 removes the saw's jump: much less high-harmonic energy.
    const sl = mags(mutate('slew', saw, 1, 0));
    expect(sl[20] / sl[1]).toBeLessThan(0.5 * (1 / 20));
  });

  it('nonlinear: asymmetric saturation adds even harmonics to a sine; Chebyshev adds T_n', () => {
    const sine = generateBasic('sine', 0).data;
    const mags = (x: Float32Array) => harmonicMagnitudes(x, 72);
    expect(mags(mutate('asym', sine, 0.8, 0))[2]).toBeGreaterThan(0.01);
    expect(mags(mutate('sineShape', sine, 0.8, 0))[2]).toBeLessThan(1e-6); // odd shaper: odd harmonics only
    const ch = mags(mutate('cheby', sine, 1, 5));
    const top = ch.indexOf(Math.max(...ch.slice(1)));
    expect(top).toBeGreaterThanOrEqual(2);
    expect(top).toBeLessThanOrEqual(8);
  });

  it('a sieve that keeps nothing gives silence, not amplified float residue', () => {
    const h2 = generateBasic('sine', 0).data.map((_, i, a) => a[(2 * i) % a.length]); // sin(2p)
    const out = mutate('multiples', h2, 1, 0); // m is 2–5: h2 survives only for m = 2
    const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak === 0 || peak > 0.99).toBe(true);
    const odd = mutate('odd', h2, 1, 0);
    expect(odd.every((v) => v === 0)).toBe(true);
    const h4h6 = h2.map((_, i) => Math.sin((2 * Math.PI * 4 * i) / h2.length) + Math.sin((2 * Math.PI * 6 * i) / h2.length));
    expect(mutate('primes', h4h6, 1, 0).every((v) => v === 0)).toBe(true);
    expect(mutate('primes', h4h6, 0.9999, 0).every((v) => v === 0)).toBe(true);
  });

  it('self-convolution squares magnitudes; resonant low-pass peaks at the cutoff', () => {
    const saw = generateBasic('saw', 0).data;
    const mags = (x: Float32Array) => harmonicMagnitudes(x, 72);
    const sc = mags(mutate('selfConv', saw, 1, 0));
    expect(sc[3] / sc[1]).toBeCloseTo(1 / 9, 3);
    // a = 0.5: cutoff 1.5·√96 ≈ 14.7; the band near it is boosted, far above cut.
    const lp = mags(mutate('reslp', saw, 0.5, 0));
    expect((lp[15] * 15) / (lp[1] * 1)).toBeGreaterThan(2);
    expect((lp[50] * 50) / lp[1]).toBeLessThan(0.5);
    // Revision 1 (stored recipes): cutoff 1.5·√500 ≈ 33.5 at a = 0.5.
    const lp1 = mags(mutate('reslp', saw, 0.5, 0, {}, 1));
    expect((lp1[33] * 33) / (lp1[1] * 1)).toBeGreaterThan(2);
    expect((lp1[70] * 70) / lp1[1]).toBeLessThan(0.5);
  });

  it('Hard sync: revision 1 wherever the read keeps real content in the band; never silence or scaled-up residue', () => {
    const N = 2048;
    const sineAt = (k: number) => Float32Array.from({ length: N }, (_, i) => Math.sin((2 * Math.PI * k * i) / N));
    const saw = generateBasic('saw', 0).data;
    const peakOf = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    // The read's strongest harmonic ≤ 72, relative to the source's (what the gate looks at).
    const bandRel = (x: Float32Array, a: number) => {
      const r = 1 + 3 * a;
      const y = Float32Array.from({ length: N }, (_, i) => {
        const f = (i * r) % N;
        const j = Math.floor(f);
        return x[j] + (x[(j + 1) % N] - x[j]) * (f - j);
      });
      return Math.max(...harmonicMagnitudes(y, 72)) / Math.max(...harmonicMagnitudes(x, 72));
    };
    let gated = 0;
    for (const x of [saw, src, sineAt(10), sineAt(20), sineAt(40), sineAt(64)])
      for (let a = 0; a <= 1.0001; a += 0.05) {
        const v1 = mutate('sync', x, a, 0, {}, 1);
        const v2 = mutate('sync', x, a, 0);
        if (bandRel(x, a) >= 2e-3) expect(maxDiff(v1, v2), `a ${a.toFixed(2)}`).toBe(0);
        else if (bandRel(x, a) < 5e-4) {
          gated++;
          // Not revision 1's (silence or residue at full scale): the fallback, which has real content.
          expect(peakOf(v2), `a ${a.toFixed(2)}`).toBeGreaterThan(0.5);
          const lead = harmonicMagnitudes(v2, 72);
          expect(Math.max(...lead), `a ${a.toFixed(2)}: real harmonics, not residue`).toBeGreaterThan(0.05);
        }
      }
    expect(gated).toBeGreaterThan(5);
    // sin(40p): the knob acts while the read stays in the band; beyond, it holds the fallback (h71.5).
    expect(maxDiff(mutate('sync', sineAt(40), 0.25, 0), sineAt(40))).toBeGreaterThan(0.1);
    expect(maxDiff(mutate('sync', sineAt(40), 0.5, 0), mutate('sync', sineAt(40), 1, 0))).toBe(0);
    // Ordinary sources: revision 1 over the whole range.
    for (let a = 0; a <= 1.0001; a += 0.05) expect(maxDiff(mutate('sync', saw, a, 0), mutate('sync', saw, a, 0, {}, 1))).toBe(0);
  });

  it('Decimate and Resonant low-pass act at the default amount (0.25), with the same ends as revision 1', () => {
    const saw = generateBasic('saw', 0).data;
    const formant = generateBasic('square', 0).data;
    const dB = (x: Float32Array, y: Float32Array) => {
      // RMS dB difference over harmonics 1–72, floored at −40 dB re each one's strongest.
      const rel = (v: Float32Array) => {
        const m = harmonicMagnitudes(v, 72);
        const mx = Math.max(...m);
        return Array.from(m.slice(1), (q) => Math.max(-40, 20 * Math.log10(q / mx + 1e-12)));
      };
      const a = rel(x);
      const b = rel(y);
      return Math.sqrt(a.reduce((s, v, k) => s + (v - b[k]) ** 2, 0) / a.length);
    };
    for (const id of ['decimate', 'reslp'] as const) {
      for (const x of [saw, formant]) {
        expect(dB(x, mutate(id, x, 0.25, 0)), `${id} @ 0.25`).toBeGreaterThan(dB(x, mutate(id, x, 0.25, 0, {}, 1)) + 0.5);
        expect(maxDiff(mutate(id, x, 1, 0), mutate(id, x, 1, 0, {}, 1)), `${id} @ 1`).toBeLessThan(1e-6);
      }
      expect(dB(saw, mutate(id, saw, 0.25, 0)), `${id} on a saw @ 0.25`).toBeGreaterThan(1);
    }
  });

  it('shapers keep the fundamental at full amount; slew acts early on a sine', () => {
    const sine = generateBasic('sine', 0).data;
    const mags = (x: Float32Array) => harmonicMagnitudes(x, 72);
    for (const id of ['logisticShape', 'cheby'] as const) {
      const m = mags(mutate(id, sine, 1, 5));
      expect(m[1] / Math.max(...m.slice(1)), id).toBeGreaterThan(0.2);
    }
    expect(maxDiff(mutate('slew', sine, 0.25, 0), sine)).toBeGreaterThan(0.02);
  });

  it('sweep amounts', () => {
    expect(sweepAmounts(4, 1, 'lin')).toEqual([0.25, 0.5, 0.75, 1]);
    const log = sweepAmounts(3, 0.64, 'log');
    expect(log[2]).toBeCloseTo(0.64);
    expect(log[0]).toBeCloseTo(0.01);
  });
});
