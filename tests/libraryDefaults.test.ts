/**
 * Locks every Seed library entry's default output: the hashes of each entry's default
 * batch (several seeds and batch sizes) and their recipes, generated from `main` before
 * the formula waveform functions were added. A change to any library entry's default
 * waveforms, or to how a stored recipe re-renders, fails here.
 *
 * Regenerate only for an intended output change: npx vitest run -u tests/libraryDefaults.test.ts
 */
import fixtureText from './fixtures/libraryDefaults.json?raw';
import { describe, expect, it } from 'vitest';
import { compileFormula } from '../src/browser/formulaEval';
import { renderRecipe, SEED_LIBRARY, seedBatch, type SeedEntry, type SeedRequest } from '../src/core/generators';
import type { ParamValue, Recipe } from '../src/core/table';

const SEEDS = [0xdeadbeef, 1];
const COUNTS = [1, 3, 8];
/** Glyph contours come from the browser; fixed polylines stand in (as recipes store them). */
const GLYPH_INPUTS: Record<string, ParamValue>[] = [
  { glyph: 'a', contour: '0.200,0.200 0.800,0.200 0.800,0.800 0.200,0.800' },
  { glyph: 'b', contour: '0.500,0.900 0.100,0.100 0.900,0.100' },
  { glyph: 'c', contour: '0.300,0.100 0.700,0.150 0.900,0.500 0.650,0.880 0.250,0.850 0.120,0.450' },
];

/** cyrb53-style 64-bit hash of the samples' bits, as 14 hex digits. */
export function hashTable(x: Float32Array): string {
  const w = new Uint32Array(x.buffer, x.byteOffset, x.length);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < w.length; i++) {
    h1 = Math.imul(h1 ^ w[i], 2654435761);
    h2 = Math.imul(h2 ^ w[i], 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

const request = (entry: SeedEntry, seed: number, count: number, inputs?: Record<string, ParamValue>[]): SeedRequest => ({
  entry,
  expr: entry.expr ?? '',
  params: {},
  seed,
  count,
  inputs,
});

const fnFor = (r: SeedRequest) => (r.entry.mode === 'formula' ? compileFormula(r.expr) : undefined);

interface EntryFixture {
  /** `${seed}/${count}` → table hashes. */
  hashes: Record<string, string[]>;
  /** The recipes of the batch at SEEDS[0] × COUNTS.at(-1). */
  recipes: Recipe[];
}

function snapshot(): Record<string, EntryFixture> {
  const out: Record<string, EntryFixture> = {};
  const cases: [string, SeedEntry, Record<string, ParamValue>[] | undefined][] = SEED_LIBRARY.map((e) => [e.id, e, undefined]);
  const glyph = SEED_LIBRARY.find((e) => e.mode === 'glyph')!;
  cases.push([`${glyph.id}+inputs`, glyph, GLYPH_INPUTS]);
  for (const [key, entry, inputs] of cases) {
    const fx: EntryFixture = { hashes: {}, recipes: [] };
    for (const seed of SEEDS)
      for (const count of COUNTS) {
        const r = request(entry, seed, count, inputs);
        const tables = seedBatch(r, fnFor(r));
        fx.hashes[`${seed}/${count}`] = tables.map((t) => hashTable(t.data));
        if (seed === SEEDS[0] && count === COUNTS.at(-1)) fx.recipes = tables.map((t) => t.recipe);
      }
    out[key] = fx;
  }
  return out;
}

const stringify = (fx: Record<string, EntryFixture>) =>
  '{\n' +
  Object.entries(fx)
    .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(',\n') +
  '\n}\n';

describe('library defaults (fixture from main)', () => {
  it("every library entry's default batches are unchanged", async () => {
    await expect(stringify(snapshot())).toMatchFileSnapshot('./fixtures/libraryDefaults.json');
  });

  it('the stored recipes re-render to the stored hashes', () => {
    const fixture = JSON.parse(fixtureText) as Record<string, EntryFixture>;
    const keys = Object.keys(fixture);
    expect(keys.length).toBeGreaterThan(40);
    for (const k of keys) {
      const { recipes, hashes } = fixture[k];
      const want = hashes[`${SEEDS[0]}/${COUNTS.at(-1)}`];
      expect(recipes.length, k).toBe(want.length);
      recipes.forEach((r, i) => expect(hashTable(renderRecipe(r, { compileFormula })), `${k} #${i}`).toBe(want[i]));
    }
  });
});
