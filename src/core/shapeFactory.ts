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

/** Phaser comb: notch spacing as a fraction of the harmonic axis (about every 8 harmonics). */
const COMB_PERIOD = 0.11;
/** A comb (0 dB peaks, −30 dB notches) over a span of 1 − COMB_PERIOD starting at x0, 64 points. */
function comb(x0: number): [number, number][] {
  const n = 64;
  const len = 1 - COMB_PERIOD;
  return Array.from({ length: n }, (_, i) => {
    const t = (i / (n - 1)) * len;
    return [x0 + t, -15 + 15 * Math.cos((2 * Math.PI * t) / COMB_PERIOD)];
  });
}

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
  // A filter cutoff opening across the batch: the limit curve goes from steep to nearly flat.
  f('lowpass-opening', {
    name: 'Low-pass opening',
    seed: 1,
    steps: [
      {
        id: 'cutoff',
        op: 'harmLimit',
        mode: 'limit',
        draw: { tool: 'free', pts: [[0, 0], [0.04, -30], [0.15, -54], [1, -60]] },
        // Just above a saw's own spectrum (−20·log10 k): the batch ends fully open, not half way.
        drawEnd: { tool: 'free', pts: [[0, 0], [0.1, -14], [0.4, -26], [1, -34]] },
      },
    ],
  }),
  // Buchla-style wavefolding: the drive into a fold rises across the batch; the top is tamed.
  f('west-coast-fold', {
    name: 'West-coast fold',
    seed: 1,
    steps: [
      { id: 'drive', op: 'gain', value: 4, amount: 0, amountEnd: 1 },
      { id: 'fold', op: 'fold', side: 'both', draw: { tool: 'line', pts: [[0, 0.5], [1, 0.5]] } },
      { id: 'tame', op: 'harmLimit', mode: 'limit', draw: { tool: 'line', pts: [[0, -6], [1, -40]] } },
    ],
  }),
  // Any source becomes a pulse: an offset slides the wave across a narrow clip, so the width sweeps.
  f('pwm-anything', {
    name: 'PWM from anything',
    seed: 1,
    steps: [
      { id: 'offset', op: 'add', draw: { tool: 'line', pts: [[0, -0.8], [1, -0.8]] }, drawEnd: { tool: 'line', pts: [[0, 0.8], [1, 0.8]] } },
      { id: 'clip', op: 'clip', side: 'both', draw: { tool: 'line', pts: [[0, 0.1], [1, 0.1]] } },
    ],
  }),
  // A vowel morph: saw-like harmonics are fitted to an "ah" formant curve that becomes "ee".
  f('talking-vowels', {
    name: 'Talking vowels',
    seed: 1,
    steps: [
      { id: 'richen', op: 'harmSet', mode: 'add', set: { kind: 'multiples', of: [1] }, fundamental: true, law: 1, amount: 0.5 },
      {
        id: 'vowel',
        op: 'harmLimit',
        mode: 'fit',
        draw: { tool: 'curve', pts: [[0, -18], [0.07, 0], [0.1, -24], [0.127, -6], [0.2, -36], [1, -50]] },
        drawEnd: { tool: 'curve', pts: [[0, -12], [0.028, 0], [0.08, -36], [0.28, -4], [0.4, -40], [1, -52]] },
      },
    ],
  }),
  // Gentle saturation, close to transparent: a good default for Shape on add.
  f('tape-warmth', {
    name: 'Tape warmth',
    seed: 1,
    steps: [
      { id: 'drive', op: 'gain', value: 1.5 },
      { id: 'sat', op: 'soft', side: 'both', knee: 0.3, draw: { tool: 'line', pts: [[0, 0.8], [1, 0.8]] } },
      { id: 'tilt', op: 'harmMod', kind: 'tilt', value: -0.5 },
    ],
  }),
  // Saw-like sources morph toward a clarinet / square tone: the even harmonics fade out across the batch.
  f('hollow-out', {
    name: 'Hollow out',
    seed: 1,
    steps: [{ id: 'hollow', op: 'harmSet', mode: 'remove', set: { kind: 'even' }, fundamental: false, amount: 0, amountEnd: 1 }],
  }),
  // Moving notches: a comb on the harmonics whose span slides by one notch spacing across the
  // batch (the same pattern at both ends, so the notches travel rather than fade).
  f('phaser-comb', {
    name: 'Phaser comb',
    seed: 1,
    steps: [{ id: 'comb', op: 'harmLimit', mode: 'scale', draw: { tool: 'free', pts: comb(0) }, drawEnd: { tool: 'free', pts: comb(COMB_PERIOD) } }],
  }),
  // One-sided saturation: adds even harmonics, edgier than Tape warmth.
  f('diode-grit', {
    name: 'Diode grit',
    seed: 1,
    steps: [
      { id: 'diode', op: 'soft', side: 'above', knee: 0.1, draw: { tool: 'line', pts: [[0, 0.4], [1, 0.4]] } },
      { id: 'tilt', op: 'harmMod', kind: 'tilt', value: -2 },
    ],
  }),
  // Bell-like: the harmonics are stretched apart, then mostly the primes are kept.
  f('metallic', {
    name: 'Metallic',
    seed: 1,
    steps: [
      { id: 'stretch', op: 'harmMod', kind: 'stretch', value: 1.35 },
      { id: 'primes', op: 'harmSet', mode: 'keep', set: { kind: 'primes' }, fundamental: true, amount: 0.7 },
    ],
  }),
  // An organ tone from anything: drawbar-like harmonics 1, 2, 3, 4, 6, 8, a little grit.
  f('drawbar-organ', {
    name: 'Drawbar organ',
    seed: 1,
    steps: [
      { id: 'bars', op: 'harmSet', mode: 'replace', set: { kind: 'list', of: [1, 2, 3, 4, 6, 8] }, fundamental: true, law: 0.5, phase: 'sine' },
      { id: 'grit', op: 'soft', side: 'both', knee: 0.15, draw: { tool: 'line', pts: [[0, 0.9], [1, 0.9]] } },
    ],
  }),
  // The same spectrum, a different shape per waveform: a voice scanning the batch moves without
  // changing tone (phase randomized, seeded, varied per waveform).
  f('phase-scatter', {
    name: 'Phase scatter',
    seed: 1,
    varySeed: true,
    steps: [{ id: 'scatter', op: 'mutation', mutation: 'phaseRandom', amount: 1 }],
  }),
  // N subtly different copies (seeded, varied per waveform): a wavetable that shimmers rather than morphs.
  f('ensemble-drift', {
    name: 'Ensemble drift',
    seed: 1,
    varySeed: true,
    steps: [
      { id: 'drift', op: 'harmMod', kind: 'randomize', value: 0.1 },
      // Caps only sources brighter than a saw (0 dB at h1: the fundamental is never touched).
      { id: 'tame', op: 'harmLimit', mode: 'limit', draw: { tool: 'line', pts: [[0, 0], [1, -36]] } },
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
