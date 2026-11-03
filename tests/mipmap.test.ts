import { describe, expect, it } from 'vitest';
import {
  MIP_HARMONICS,
  MIP_LENGTHS,
  MIP_NYQUIST_FRACTION,
  MIP_TOTAL,
  SCALE_ROOT_HZ,
  SCALE_SEMITONES,
} from '../src/core/constants';
import { realFft } from '../src/core/fft';
import { generateBasic } from '../src/core/generators';
import { buildMipSet, MIP_LEVELS, mipLevel, mipLevelFor } from '../src/core/mipmap';

describe('mip sets', () => {
  const saw = generateBasic('saw', 0).data;
  const mips = buildMipSet(saw);

  it('packs all levels into one buffer; level 0 equals the source table', () => {
    expect(mips.length).toBe(MIP_TOTAL);
    const l0 = mipLevel(mips, 0);
    for (let i = 0; i < l0.length; i++) expect(Math.abs(l0[i] - saw[i])).toBeLessThan(1e-5);
  });

  it('each level keeps harmonics 1..K at the source amplitude and nothing above', () => {
    const src = realFft(saw);
    const srcMag = (k: number) => (2 * Math.hypot(src.re[k], src.im[k])) / saw.length;
    for (let l = 0; l < MIP_LEVELS; l++) {
      const lv = mipLevel(mips, l);
      expect(lv.length).toBe(MIP_LENGTHS[l]);
      const { re, im } = realFft(lv);
      const n = lv.length;
      const mag = (k: number) => (2 * Math.hypot(re[k], im[k])) / n;
      const K = MIP_HARMONICS[l];
      for (let k = 1; k <= K; k++) expect(mag(k)).toBeCloseTo(srcMag(k), 4);
      for (let k = K + 1; k <= n / 2; k++) expect(mag(k)).toBeLessThan(1e-5);
    }
  });

  it('level choice keeps the top harmonic under the Nyquist margin', () => {
    for (const sr of [44100, 48000, 96000]) {
      for (let oct = -2; oct <= 2; oct++) {
        for (const semi of SCALE_SEMITONES) {
          const f = SCALE_ROOT_HZ * 2 ** (semi / 12 + oct);
          const l = mipLevelFor(f, sr);
          expect(f * MIP_HARMONICS[l]).toBeLessThan(MIP_NYQUIST_FRACTION * sr);
          if (l > 0) expect(f * MIP_HARMONICS[l - 1]).toBeGreaterThanOrEqual(MIP_NYQUIST_FRACTION * sr);
        }
      }
    }
  });
});
