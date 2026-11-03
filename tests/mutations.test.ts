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

  it('sweep amounts', () => {
    expect(sweepAmounts(4, 1, 'lin')).toEqual([0.25, 0.5, 0.75, 1]);
    const log = sweepAmounts(3, 0.64, 'log');
    expect(log[2]).toBeCloseTo(0.64);
    expect(log[0]).toBeCloseTo(0.01);
  });
});
