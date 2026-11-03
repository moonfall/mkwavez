import { describe, expect, it } from 'vitest';
import { generateBasic, generatePerlin, DEFAULT_PERLIN } from '../src/core/generators';
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

  it('sweep amounts', () => {
    expect(sweepAmounts(4, 1, 'lin')).toEqual([0.25, 0.5, 0.75, 1]);
    const log = sweepAmounts(3, 0.64, 'log');
    expect(log[2]).toBeCloseTo(0.64);
    expect(log[0]).toBeCloseTo(0.01);
  });
});
