/**
 * Parameter-mode generators beyond the original Perlin / CA: each is a Seed library
 * entry (category, name, description, parameters) plus a pure render function of
 * (params, seed, batch index, batch count). seedTable() and renderRecipe() dispatch
 * here by mode / recipe op, so a mode's recipe is `{ op: mode, params: { ...params,
 * preset, name }, seed, batch }` and re-renders exactly.
 */
import type { ParamValue } from '../table';
import { DEFAULT_DYN, DYN_MAP_LABELS, dynamicalTable } from './dynamical';

export interface SeedParam {
  readonly key: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** Default value. */
  readonly value: number;
  /** Discrete choices (value, label) — shown as a dropdown instead of a slider. */
  readonly options?: readonly (readonly [number, string])[];
}

export type ModeParams = Readonly<Record<string, ParamValue>>;

export interface ParamModeDef {
  /** Recipe op and SeedEntry mode. */
  readonly mode: string;
  /** Library entry id. */
  readonly id: string;
  readonly cat: string;
  readonly name: string;
  /** One-line description shown under the parameters. */
  readonly about: string;
  readonly params: readonly SeedParam[];
  /** True when the seed changes the result for these params. */
  seeded(p: ModeParams): boolean;
  render(p: ModeParams, seed: number, index: number, count: number): Float32Array;
}

/** A recipe / request param as a number (missing → NaN; callers merge defaults first). */
export const num = (p: ModeParams, k: string): number => Number(p[k]);

const opts = (labels: readonly string[]) => labels.map((l, i) => [i, l] as const);

export const PARAM_MODES: readonly ParamModeDef[] = [
  {
    mode: 'dynamical',
    id: 'dynamical-systems',
    cat: 'Simulations',
    name: 'Dynamical systems',
    about:
      'Each sample iterates a chaotic map from an initial condition that follows the phase (so the cycle loops). ' +
      'A batch sweeps the control from start to end: a walk through the bifurcation diagram.',
    params: [
      { key: 'map', label: 'Map', min: 0, max: 4, step: 1, value: DEFAULT_DYN.map, options: opts(DYN_MAP_LABELS) },
      { key: 'control', label: 'Control start', min: 0, max: 1, step: 0.005, value: DEFAULT_DYN.control },
      { key: 'controlEnd', label: 'Batch → control', min: 0, max: 1, step: 0.005, value: DEFAULT_DYN.controlEnd },
      { key: 'iterations', label: 'Iterations', min: 1, max: 64, step: 1, value: DEFAULT_DYN.iterations },
      { key: 'spread', label: 'Initial spread', min: 0.05, max: 1, step: 0.01, value: DEFAULT_DYN.spread },
      { key: 'output', label: 'Output', min: 0, max: 1, step: 1, value: DEFAULT_DYN.output, options: opts(['Linear', 'Soft clip']) },
    ],
    seeded: () => false,
    render: (p, _seed, index, count) =>
      dynamicalTable(
        {
          map: num(p, 'map'),
          control: num(p, 'control'),
          controlEnd: num(p, 'controlEnd'),
          iterations: num(p, 'iterations'),
          spread: num(p, 'spread'),
          output: num(p, 'output'),
        },
        index,
        count,
      ),
  },
];

export function paramMode(mode: string): ParamModeDef | undefined {
  return PARAM_MODES.find((m) => m.mode === mode);
}
