import { describe, expect, it } from 'vitest';
import { compileFormula } from '../src/browser/formulaEval';
import { KMAX, TABLE_SIZE } from '../src/core/constants';
import { harmonicMagnitudes } from '../src/core/fft';
import { seedBatch, seedEntry, type SeedRequest } from '../src/core/generators';
import { apparentPitch, pitchExplain, pitchLabel } from '../src/core/pitch';
import { shape } from '../src/core/shape';

const sum = (terms: [number, number][]) =>
  shape(Float64Array.from({ length: TABLE_SIZE }, (_, i) => terms.reduce((s, [k, a]) => s + a * Math.sin((2 * Math.PI * k * i) / TABLE_SIZE), 0)));
const pitchOf = (x: Float32Array) => apparentPitch(harmonicMagnitudes(x, KMAX));

describe('apparent pitch', () => {
  it('a waveform with a fundamental plays its note: no label', () => {
    const p = pitchOf(sum([[1, 1], [2, 0.5], [3, 0.3]]));
    expect(p).toMatchObject({ divisor: 1, weak: false, semitones: 0 });
    expect(pitchLabel(p)).toBe('');
    expect(pitchExplain(p)).toBe('');
  });

  it('a common divisor sounds that many times higher', () => {
    const oct = pitchOf(sum([[2, 1], [4, 0.5], [6, 0.2]]));
    expect(oct?.divisor).toBe(2);
    expect(pitchLabel(oct)).toBe('sounds +1 oct');
    const fifth = pitchOf(sum([[3, 1], [6, 0.4], [9, 0.1]]));
    expect(fifth?.divisor).toBe(3);
    expect(pitchLabel(fifth)).toBe('sounds +19 st');
    expect(pitchExplain(fifth)).toMatch(/multiple of 3.*19 semitones/);
    expect(pitchLabel(pitchOf(sum([[4, 1], [8, 0.5]])))).toBe('sounds +2 oct');
  });

  it('harmonics below −40 dB do not count; a weak fundamental without a divisor is flagged as weak', () => {
    // h1 at −50 dB: the divisor of the present harmonics (2, 3) is 1, but the fundamental is weak.
    const p = pitchOf(sum([[1, 10 ** (-50 / 20)], [2, 1], [3, 1]]));
    expect(p?.divisor).toBe(1);
    expect(p?.weak).toBe(true);
    expect(pitchLabel(p)).toBe('weak fundamental');
    // A faint odd harmonic at −60 dB doesn't hide an octave-up waveform.
    expect(pitchOf(sum([[2, 1], [4, 0.3], [5, 1e-3]]))?.divisor).toBe(2);
  });

  it('silence has no pitch', () => {
    expect(apparentPitch(new Float64Array(KMAX + 1))).toBeNull();
    expect(pitchLabel(null)).toBe('');
  });
});

describe('retuned Seed entries keep their fundamental (default batches, N = 8)', () => {
  const batch = (id: string, params: Record<string, number> = {}, seed = 24301) => {
    const entry = seedEntry(id)!;
    const req: SeedRequest = { entry, expr: entry.expr ?? '', params, seed, count: 8 };
    return seedBatch(req, entry.mode === 'formula' ? compileFormula(req.expr) : undefined).map((t) => t.data);
  };

  for (const id of ['logistic-map', 'dynamical-systems', 'polygon', 'superformula', 'chebyshev'])
    it(`${id}: every waveform plays its note`, () => {
      for (const seed of [24301, 1])
        batch(id, {}, seed).forEach((x, i) => {
          const p = pitchOf(x)!;
          expect(p.divisor, `${id} #${i}`).toBe(1);
          expect(p.h1Db, `${id} #${i}`).toBeGreaterThan(-40);
        });
    });

  it('the original readings are still there (and still sound above the note)', () => {
    // Polygon / Superformula read from the centre; Dynamical systems from the symmetric start.
    expect(batch('polygon', { offset: 0 }).map((x) => pitchOf(x)!.divisor)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(batch('superformula', { offset: 0, n2: 3, n3: 3 }).every((x) => pitchOf(x)!.divisor === 6)).toBe(true);
    expect(batch('dynamical-systems', { start: 0 }).every((x) => pitchOf(x)!.divisor === 2)).toBe(true);
    // Trace reading ignores the offset.
    const trace = (offset: number) => batch('polygon', { read: 1, offset });
    trace(0).forEach((x, i) => expect(Array.from(x)).toEqual(Array.from(trace(0.5)[i])));
  });
});
