import { describe, expect, it } from 'vitest';
import { KMAX, TABLE_SIZE } from '../src/core/constants';
import { realFft } from '../src/core/fft';
import { Prng } from '../src/core/prng';
import { shape } from '../src/core/shape';

const N = TABLE_SIZE;

function randomCycle(seed: number): Float64Array {
  const r = new Prng(seed);
  const x = new Float64Array(N);
  for (let i = 0; i < N; i++) x[i] = r.bipolar() * 3 + 0.7; // broadband + DC offset
  return x;
}

function checkInvariants(y: Float32Array) {
  const { re, im } = realFft(y);
  // DC removed
  let mean = 0;
  for (const v of y) mean += v;
  expect(Math.abs(mean / N)).toBeLessThan(1e-6);
  // Nothing above KMAX
  let peakMag = 0;
  for (let k = 1; k < N / 2; k++) peakMag = Math.max(peakMag, Math.hypot(re[k], im[k]));
  for (let k = KMAX + 1; k <= N / 2; k++) {
    expect(Math.hypot(re[k], im[k]) / peakMag).toBeLessThan(1e-5);
  }
  // Peak normalised
  let pk = 0;
  for (const v of y) pk = Math.max(pk, Math.abs(v));
  expect(pk).toBeCloseTo(1, 6);
  return { re, im };
}

describe('shape()', () => {
  it('removes DC, limits harmonics, normalises peak and aligns fundamental phase', () => {
    for (const seed of [1, 2, 3, 99]) {
      const y = shape(randomCycle(seed));
      const { re, im } = checkInvariants(y);
      expect(Math.atan2(im[1], re[1])).toBeCloseTo(-Math.PI / 2, 4);
    }
  });

  it('turns a shifted cosine into a sine', () => {
    const x = new Float64Array(N);
    for (let i = 0; i < N; i++) x[i] = 5 * Math.cos((2 * Math.PI * i) / N + 1.234) + 2;
    const y = shape(x);
    for (let i = 0; i < N; i += 37) expect(y[i]).toBeCloseTo(Math.sin((2 * Math.PI * i) / N), 4);
  });

  it('is idempotent on an already-shaped table', () => {
    const y = shape(randomCycle(7));
    const z = shape(y);
    for (let i = 0; i < N; i++) expect(Math.abs(z[i] - y[i])).toBeLessThan(1e-5);
  });

  it('aligns the lowest present harmonic when the fundamental is absent', () => {
    const x = new Float64Array(N);
    for (let i = 0; i < N; i++) x[i] = Math.cos((2 * 2 * Math.PI * i) / N + 0.4);
    const { re, im } = checkInvariants(shape(x));
    expect(Math.hypot(re[1], im[1])).toBeLessThan(1e-6);
    expect(Math.atan2(im[2], re[2])).toBeCloseTo(-Math.PI / 2, 4);
  });

  it('applies the optional Gaussian low-pass', () => {
    const x = randomCycle(5);
    const a = realFft(shape(x));
    const b = realFft(shape(x, { lowpassHarmonic: 4 }));
    const ratio = (s: { re: Float64Array; im: Float64Array }, k: number) =>
      Math.hypot(s.re[k], s.im[k]) / Math.hypot(s.re[1], s.im[1]);
    expect(ratio(b, 20)).toBeLessThan(ratio(a, 20) * 1e-6);
  });

  it('returns silence for silence and sanitises non-finite input', () => {
    expect(shape(new Float64Array(N)).every((v) => v === 0)).toBe(true);
    const x = randomCycle(3);
    x[10] = NaN;
    x[11] = Infinity;
    expect(shape(x).every(Number.isFinite)).toBe(true);
  });
});
