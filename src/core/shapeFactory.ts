/**
 * Factory Shape chains (read-only; the Shape tab's chain picker lists them before the
 * user's saved chains). Built through normalizeChain, so they are canonical.
 */
import { MAX_CHAIN_NAME, normalizeChain, type ShapeChain } from './shapeChain';

export interface FactoryChain {
  readonly id: string;
  readonly chain: ShapeChain;
}

const f = (id: string, raw: unknown): FactoryChain => ({ id, chain: normalizeChain(raw) });

export const FACTORY_CHAINS: readonly FactoryChain[] = [
  f('warm-fold-organ', {
    name: 'Warm fold organ',
    seed: 1,
    steps: [
      { id: 'fold', op: 'fold', side: 'both', draw: { tool: 'line', pts: [[0, 0.45], [1, 0.45]] } },
      { id: 'soft', op: 'soft', side: 'both', knee: 0.1, amount: 0.9, draw: { tool: 'curve', pts: [[0, 0.5], [0.5, 0.2], [1, 0.5]] } },
      { id: 'organ', op: 'harmSet', mode: 'keep', set: { kind: 'multiples', of: [2, 3] }, fundamental: true, amount: 0.85 },
      { id: 'limit', op: 'harmLimit', mode: 'limit', draw: { tool: 'line', pts: [[0, -4], [1, -38]] } },
    ],
  }),
  f('soft-clip', {
    name: 'Soft clip',
    seed: 1,
    steps: [
      { id: 'drive', op: 'gain', value: 2 },
      { id: 'soft', op: 'soft', side: 'both', knee: 0.15, draw: { tool: 'line', pts: [[0, 0.7], [1, 0.7]] } },
    ],
  }),
  f('clip-ramp', {
    name: 'Clip ramp (sweep)',
    seed: 1,
    steps: [
      { id: 'drive', op: 'gain', value: 2.5 },
      { id: 'clip', op: 'clip', side: 'both', amount: 0, amountEnd: 1, draw: { tool: 'line', pts: [[0, 0.9], [1, 0.25]] } },
    ],
  }),
  f('odd-darker', {
    name: 'Odd only, darker',
    seed: 1,
    steps: [
      { id: 'odd', op: 'harmSet', mode: 'keep', set: { kind: 'odd' }, fundamental: true },
      { id: 'tilt', op: 'harmMod', kind: 'tilt', value: -4.5 },
      { id: 'pull', op: 'pull', radius: 0.5, amount: 0.7, draw: { tool: 'curve', pts: [[0.1, 0.3], [0.25, 0.95], [0.4, 0.3]] } },
    ],
  }),
  f('bright-limit', {
    name: 'Bright, limited',
    seed: 1,
    steps: [
      { id: 'floor', op: 'harmLimit', mode: 'floor', draw: { tool: 'line', pts: [[0, -6], [1, -30]] } },
      { id: 'limit', op: 'harmLimit', mode: 'limit', draw: { tool: 'curve', pts: [[0, 0], [0.4, -12], [1, -24]] } },
    ],
  }),
];

/** The chain a new session starts with. */
export const DEFAULT_CHAIN: ShapeChain = FACTORY_CHAINS[0].chain;

// ---------------- saved chains (the user's) ----------------

/** A chain the user saved (session state; exported / imported as a small JSON file). */
export interface SavedChain {
  readonly id: string;
  readonly chain: ShapeChain;
}

export const MAX_SAVED_CHAINS = 64;
export const CHAINS_FILE_FORMAT = 'mkwavez-shapes';

/** Saved chains from untrusted data: valid chains, unique ids ('chain-N') and names, at most MAX_SAVED_CHAINS. */
export function normalizeSavedChains(raw: unknown): SavedChain[] {
  const out: SavedChain[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  let n = 0;
  for (const r of Array.isArray(raw) ? raw : []) {
    if (out.length >= MAX_SAVED_CHAINS) break;
    if (!r || typeof r !== 'object') continue;
    const o = r as { id?: unknown; chain?: unknown };
    // An entry without a chain is dropped (not turned into an empty one).
    if (!o.chain || typeof o.chain !== 'object') continue;
    const chain = normalizeChain(o.chain);
    let id = typeof o.id === 'string' && /^chain-[a-z0-9]{1,24}$/.test(o.id) ? o.id : '';
    while (!id || ids.has(id)) id = `chain-${++n}`;
    ids.add(id);
    out.push({ id, chain: { ...chain, name: uniqueName(chain.name, names) } });
    names.add(out[out.length - 1].chain.name);
  }
  return out;
}

/** `base`, or `base 2`, `base 3`, … — the first not in `used`, kept within MAX_CHAIN_NAME characters. */
export function uniqueName(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const tail = ` ${i}`;
    const name = `${base.slice(0, MAX_CHAIN_NAME - tail.length)}${tail}`;
    if (!used.has(name)) return name;
  }
}

/** The export file for a list of chains. */
export function chainsFile(chains: readonly ShapeChain[]): string {
  return JSON.stringify({ format: CHAINS_FILE_FORMAT, version: 1, chains: chains.map((c) => normalizeChain(c)) }, null, 1);
}

/** Chains from an export file (normalised); throws if it isn't one. */
export function parseChainsFile(text: string): ShapeChain[] {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    throw new Error('not a chains file (invalid JSON)');
  }
  if (!o || typeof o !== 'object' || (o as { format?: unknown }).format !== CHAINS_FILE_FORMAT) throw new Error('not an mkwavez chains file');
  const list = (o as { chains?: unknown }).chains;
  return (Array.isArray(list) ? list : []).slice(0, MAX_SAVED_CHAINS).map((c) => normalizeChain(c));
}
