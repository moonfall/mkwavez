/**
 * Locks every Seed library entry's default output: the hashes of each entry's default
 * batch (several seeds and batch sizes), of random-parameter batches of every parameter
 * entry, and their recipes, pinned to `main`'s output from before the formula waveform
 * functions were added. A change to any library entry's default waveforms, or to how a
 * stored recipe re-renders, fails here.
 *
 * The hashes are of the samples rounded to a 2^-20 grid (≈ 1e-6, −120 dB), not of their
 * exact bits: V8's Math.sin / Math.pow & co. differ in the last bit between Node versions
 * (Node 22 vs 24 moved a few near-zero samples by ~3e-17), which an exact hash would turn
 * into a failure. A sample moving by 2^-20 or more always changes its rounded value (so
 * its table's hash); a smaller move only when it crosses a rounding boundary, which noise
 * of ~1e-16 does with probability ~1e-10 per sample.
 *
 * Regenerate only for an intended output change: npx vitest run -u tests/libraryDefaults.test.ts
 *
 * fixtures/libraryLegacy.json keeps, for every entry whose default output was deliberately
 * changed since (retuned defaults, new params), its entry as `main` had it: stored recipes
 * must keep re-rendering exactly as they were made, so those old recipes are checked too.
 * Add an entry's old record there whenever its record here changes.
 */
import fixtureText from './fixtures/libraryDefaults.json?raw';
import legacyText from './fixtures/libraryLegacy.json?raw';
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

/** Hash grid: samples are rounded to multiples of 1 / HASH_GRID before hashing. */
export const HASH_GRID = 2 ** 20;

/**
 * cyrb53-style 64-bit hash of the samples rounded to the 1 / HASH_GRID grid, as 14 hex
 * digits. Last-bit float differences (other Node versions) round to the same values;
 * -0 and 0 hash alike, and non-finite samples hash apart from every finite one.
 */
export function hashTable(x: Float32Array): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    let lo: number;
    let hi: number;
    if (Number.isFinite(v)) {
      const q = Math.round(v * HASH_GRID);
      lo = q | 0; // q's two 32-bit halves (|samples| ≤ 1 in practice, so hi is 0 or -1)
      hi = Math.floor(q / 4294967296) | 0;
    } else {
      lo = v > 0 ? 1 : v < 0 ? -1 : 2; // +∞, −∞, NaN
      hi = 0x7ff00000;
    }
    h1 = Math.imul(Math.imul(h1 ^ lo, 2654435761) ^ hi, 2654435761);
    h2 = Math.imul(Math.imul(h2 ^ lo, 1597334677) ^ hi, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

const request = (
  entry: SeedEntry,
  seed: number,
  count: number,
  inputs?: Record<string, ParamValue>[],
  params: Record<string, number> = {},
): SeedRequest => ({
  entry,
  expr: entry.expr ?? '',
  params,
  seed,
  count,
  inputs,
});

const fnFor = (r: SeedRequest) => (r.entry.mode === 'formula' ? compileFormula(r.expr) : undefined);

interface EntryFixture {
  /** Random-parameter cases: the params used. */
  params?: Record<string, number>;
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
  for (const [key, entry, inputs] of cases) out[key] = entryFixture(entry, {}, inputs, SEEDS, COUNTS);
  // Non-default settings: RANDOM_SETS random parameter sets per parameter entry.
  for (const entry of SEED_LIBRARY.filter((e) => e.params?.length)) {
    const rnd = lcg(hashString(entry.id));
    for (let k = 0; k < RANDOM_SETS; k++) {
      const params = randomParams(entry, rnd);
      const inputs = entry.mode === 'glyph' ? GLYPH_INPUTS : undefined;
      out[`${entry.id}~${k}`] = { params, ...entryFixture(entry, params, inputs, [RANDOM_SEEDS[k % RANDOM_SEEDS.length]], [1, 6]) };
    }
  }
  return out;
}

const RANDOM_SETS = 4;
const RANDOM_SEEDS = [7, 0x9e3779b9, 123456];

/** Deterministic PRNG (an LCG) for the random parameter sets. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Random values on each parameter's slider grid (or one of its options). */
function randomParams(entry: SeedEntry, rnd: () => number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of entry.params ?? []) {
    if (p.options) out[p.key] = p.options[Math.floor(rnd() * p.options.length)][0];
    else out[p.key] = Number(Math.min(p.max, p.min + Math.round((rnd() * (p.max - p.min)) / p.step) * p.step).toFixed(6));
  }
  return out;
}

function entryFixture(
  entry: SeedEntry,
  params: Record<string, number>,
  inputs: Record<string, ParamValue>[] | undefined,
  seeds: readonly number[],
  counts: readonly number[],
): EntryFixture {
  const fx: EntryFixture = { hashes: {}, recipes: [] };
  for (const seed of seeds)
    for (const count of counts) {
      const r = request(entry, seed, count, inputs, params);
      const tables = seedBatch(r, fnFor(r));
      fx.hashes[`${seed}/${count}`] = tables.map((t) => hashTable(t.data));
      if (seed === seeds[0] && count === counts.at(-1)) fx.recipes = tables.map((t) => t.recipe);
    }
  return fx;
}

const stringify = (fx: Record<string, EntryFixture>) =>
  '{\n' +
  Object.entries(fx)
    .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(',\n') +
  '\n}\n';

// Renders every library entry's batches: ~4.5 s / ~2.5 s on a fast machine, so the 5 s
// default is too tight once the other test files run alongside on a CI runner.
const RENDER_ALL_MS = 60_000;

describe('library defaults (pinned to main, within 2^-20)', () => {
  it("every library entry's default batches are unchanged", async () => {
    await expect(stringify(snapshot())).toMatchFileSnapshot('./fixtures/libraryDefaults.json');
  }, RENDER_ALL_MS);

  const rerender = (text: string, min: number) => {
    const fixture = JSON.parse(text) as Record<string, EntryFixture>;
    const keys = Object.keys(fixture);
    expect(keys.length).toBeGreaterThan(min);
    for (const k of keys) {
      const { recipes, hashes } = fixture[k];
      // The recipes are those of the first seed's largest batch.
      const want = hashes[`${recipes[0].seed}/${recipes.length}`];
      expect(recipes.length, k).toBe(want.length);
      recipes.forEach((r, i) => expect(hashTable(renderRecipe(r, { compileFormula })), `${k} #${i}`).toBe(want[i]));
    }
  };

  it('the stored recipes re-render to the stored hashes', () => rerender(fixtureText, 40), RENDER_ALL_MS);

  it('recipes made before a deliberate default change still re-render as they were made', () => {
    rerender(legacyText, 0);
    // Every legacy record is of a current entry, and differs from its current record.
    const now = JSON.parse(fixtureText) as Record<string, EntryFixture>;
    for (const [k, old] of Object.entries(JSON.parse(legacyText) as Record<string, EntryFixture>)) {
      expect(now[k], k).toBeDefined();
      expect(JSON.stringify(now[k]), k).not.toBe(JSON.stringify(old));
    }
  }, RENDER_ALL_MS);
});
