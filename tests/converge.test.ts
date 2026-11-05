import { describe, expect, it } from 'vitest';
import { convergePitch, convergeTones, convergeVoices, DEFAULT_CONVERGE, renderRecipe, seedBatch, seedEntry, seedParams } from '../src/core/generators';
import { fft } from '../src/core/fft';

const P = DEFAULT_CONVERGE;

/** Magnitude per harmonic 1..K of a table. */
function harmonics(x: Float32Array, K = 72): number[] {
  const re = Float64Array.from(x);
  const im = new Float64Array(x.length);
  fft(re, im, false);
  return Array.from({ length: K }, (_, i) => Math.hypot(re[i + 1], im[i + 1]));
}
/** Spectral centroid (in harmonics). */
const centroid = (m: number[]) => m.reduce((s, v, i) => s + v * (i + 1), 0) / m.reduce((s, v) => s + v, 0);

describe('Converge', () => {
  it('chord tones are harmonics within the span', () => {
    expect(convergeTones(0, 5)).toEqual([1, 2, 3, 4, 6, 8, 12, 16, 24, 32]);
    expect(convergeTones(1, 2)).toEqual([1, 2, 3, 4]);
    expect(convergeTones(2, 1)).toEqual([5, 10]);
    expect(convergeTones(4, 6)).toEqual([1, 2, 4, 8, 16, 32, 64]);
  });

  it('starts as a cluster in the band and ends exactly on the chord tones', () => {
    const vs = convergeVoices(P, 1234);
    expect(vs.length).toBe(P.voices);
    const tones = convergeTones(P.chord, P.span);
    const semis = 2 ** (P.wobble / 12);
    for (const v of vs) {
      const h0 = convergePitch(v, 0, P.wobble);
      expect(h0).toBeGreaterThanOrEqual(P.low / semis - 1e-9);
      expect(h0).toBeLessThanOrEqual(P.high * semis + 1e-9);
      expect(tones).toContain(convergePitch(v, 1, P.wobble));
    }
    // Every chord tone is taken; the lowest voices take the lowest tones.
    expect(new Set(vs.map((v) => v.to))).toEqual(new Set(tones));
    const byStart = [...vs].sort((a, b) => a.from - b.from);
    for (let i = 1; i < byStart.length; i++) expect(byStart[i].to).toBeGreaterThanOrEqual(byStart[i - 1].to);
  });

  it('voices hold, then glide within their windows; a voice does not depend on the count', () => {
    const vs = convergeVoices(P, 99);
    for (const v of vs) {
      expect(v.depart).toBeGreaterThanOrEqual(P.hold);
      expect(v.land).toBeLessThanOrEqual(P.arrive);
      expect(v.land).toBeGreaterThan(v.depart);
    }
    const fewer = convergeVoices({ ...P, voices: 5 }, 99);
    fewer.forEach((v, j) => expect([v.from, v.depart, v.phase]).toEqual([vs[j].from, vs[j].depart, vs[j].phase]));
  });

  it('the batch is the arc: the cluster sits in its band, the end spreads down to the chord root', () => {
    const e = seedEntry('converge')!;
    const b = seedBatch({ entry: e, params: seedParams(e), seed: 7, count: 16, fn: null } as never);
    const first = harmonics(b[0].data);
    const last = harmonics(b[15].data);
    // Start: nothing below the band; end: the root (harmonic 1) and the chord's low tones sound.
    expect(first.slice(0, 3).every((v) => v < 0.02 * Math.max(...first))).toBe(true);
    expect(last[0]).toBeGreaterThan(0.1 * Math.max(...last));
    expect(centroid(last)).toBeLessThan(centroid(first));
    for (const t of b) expect(renderRecipe(t.recipe)).toEqual(t.data);
  });

  it('is seeded: another seed gives another cluster', () => {
    const e = seedEntry('converge')!;
    const a = seedBatch({ entry: e, params: seedParams(e), seed: 1, count: 3, fn: null } as never);
    const b = seedBatch({ entry: e, params: seedParams(e), seed: 2, count: 3, fn: null } as never);
    expect(a[0].data).not.toEqual(b[0].data);
  });
});
