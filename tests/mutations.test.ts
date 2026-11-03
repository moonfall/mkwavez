import { describe, expect, it } from 'vitest';
import { generateBasic, generatePerlin, DEFAULT_PERLIN } from '../src/core/generators';
import { mutate, MUTATIONS, sweepAmounts } from '../src/core/mutations';

const src = generatePerlin(DEFAULT_PERLIN, 4242, 1)[0].data;
const pool = [generateBasic('saw', 0).data, generateBasic('square', 0).data];
const maxDiff = (a: Float32Array, b: Float32Array) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

describe('mutations (core port; UI in M2)', () => {
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

  it('sweep amounts', () => {
    expect(sweepAmounts(4, 1, 'lin')).toEqual([0.25, 0.5, 0.75, 1]);
    const log = sweepAmounts(3, 0.64, 'log');
    expect(log[2]).toBeCloseTo(0.64);
    expect(log[0]).toBeCloseTo(0.01);
  });
});
