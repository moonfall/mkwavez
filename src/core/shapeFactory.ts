/**
 * Factory Shape chains (read-only; the Shape tab's chain picker lists them before the
 * user's saved chains). Built through normalizeChain, so they are canonical.
 */
import { normalizeChain, type ShapeChain } from './shapeChain';

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
