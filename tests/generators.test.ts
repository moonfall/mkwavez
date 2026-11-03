import { describe, expect, it } from 'vitest';
import { compileFormula } from '../src/browser/formulaEval';
import { TABLE_SIZE } from '../src/core/constants';
import {
  BASIC_WAVES,
  DEFAULT_PERLIN,
  FORMULA_PRESETS,
  generateBasic,
  generateCa,
  generateFormula,
  generatePerlin,
  renderRecipe,
} from '../src/core/generators';
import { deriveSeed, Prng } from '../src/core/prng';

const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((v, i) => v === b[i]);

describe('Prng', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = new Prng(42);
    const b = new Prng(42);
    const c = new Prng(43);
    const sa = Array.from({ length: 100 }, () => a.next());
    const sb = Array.from({ length: 100 }, () => b.next());
    const sc = Array.from({ length: 100 }, () => c.next());
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
    expect(sa.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it('matches the prototype rng() reference values', () => {
    // Reference: the prototype's closure-based rng(1) first three outputs.
    function rng(seed: number) {
      let s = seed >>> 0;
      return () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const ref = rng(1);
    const p = new Prng(1);
    for (let i = 0; i < 10; i++) expect(p.next()).toBe(ref());
  });

  it('can be resumed from persisted state', () => {
    const a = new Prng(9);
    a.next();
    a.next();
    const b = new Prng(0);
    b.state = a.state;
    expect(b.next()).toBe(a.next());
  });

  it('derives distinct seeds', () => {
    const s = new Set(Array.from({ length: 1000 }, (_, i) => deriveSeed(5, i)));
    expect(s.size).toBe(1000);
  });
});

describe('generators', () => {
  it('basic waves are shaped tables; noise depends only on the seed', () => {
    for (const w of BASIC_WAVES) {
      const g = generateBasic(w, 123);
      expect(g.data.length).toBe(TABLE_SIZE);
      expect(Math.max(...g.data.map(Math.abs))).toBeCloseTo(1, 5);
      expect(same(g.data, generateBasic(w, 123).data)).toBe(true);
    }
    expect(same(generateBasic('noise', 1).data, generateBasic('noise', 2).data)).toBe(false);
  });

  it('perlin batches are deterministic and re-render from their recipes', () => {
    const a = generatePerlin(DEFAULT_PERLIN, 777, 4);
    const b = generatePerlin(DEFAULT_PERLIN, 777, 4);
    a.forEach((t, i) => {
      expect(same(t.data, b[i].data)).toBe(true);
      expect(same(t.data, renderRecipe(t.recipe))).toBe(true);
    });
    expect(same(a[0].data, a[3].data)).toBe(false);
  });

  it('CA generations are deterministic and individually re-renderable', () => {
    const a = generateCa({ rule: 110, cells: 32 }, 55, 6);
    const b = generateCa({ rule: 110, cells: 32 }, 55, 6);
    a.forEach((t, i) => {
      expect(same(t.data, b[i].data)).toBe(true);
      expect(same(t.data, renderRecipe(t.recipe))).toBe(true);
    });
    const c = generateCa({ rule: 110, cells: 32 }, 56, 6);
    expect(same(a[0].data, c[0].data)).toBe(false);
  });

  it('every formula preset compiles, evaluates and is deterministic', () => {
    for (const p of FORMULA_PRESETS) {
      const fn = compileFormula(p.expr);
      const a = generateFormula(fn, p.expr, p.name, 1001, 3);
      const b = generateFormula(fn, p.expr, p.name, 1001, 3);
      a.forEach((t, i) => {
        expect(t.data.every(Number.isFinite), p.name).toBe(true);
        expect(same(t.data, b[i].data), p.name).toBe(true);
        expect(same(t.data, renderRecipe(t.recipe, { compileFormula })), p.name).toBe(true);
      });
    }
  });

  it('formula compile errors throw', () => {
    expect(() => compileFormula('sin(p')).toThrow();
    expect(() => generateFormula(compileFormula('1/0'), '1/0', 'x', 1, 1)).toThrow();
  });
});
