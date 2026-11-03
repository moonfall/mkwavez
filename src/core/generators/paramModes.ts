/**
 * Parameter-mode generators beyond the original Perlin / CA: each is a Seed library
 * entry (category, name, description, parameters) plus a pure render function of
 * (params, seed, batch index, batch count). seedTable() and renderRecipe() dispatch
 * here by mode / recipe op, so a mode's recipe is `{ op: mode, params: { ...params,
 * preset, name }, seed, batch }` and re-renders exactly.
 */
import type { ParamValue } from '../table';
import { additiveTable, DEFAULT_ADDITIVE as AD, type AdditiveParams } from './additive';
import { DEFAULT_DYN, DYN_MAP_LABELS, dynamicalTable } from './dynamical';
import { DEFAULT_KS, karplusTable } from './karplus';
import { DEFAULT_RD as RD, RD_CUSTOM, RD_PRESETS, rdTable, type RdParams } from './reactionDiffusion';
import { DEFAULT_SEQUENCE as SQ, SEQ_SOURCES, sequenceTable, type SequenceParams } from './sequences';

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

/** Every key of `defaults` read from p as a number. */
function nums<T extends object>(p: ModeParams, defaults: T): T {
  const out: Record<string, number> = {};
  for (const k of Object.keys(defaults)) out[k] = num(p, k);
  return out as T;
}

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
  {
    mode: 'karplus',
    id: 'karplus-strong',
    cat: 'Simulations',
    name: 'Karplus-Strong snapshots',
    about:
      'A plucked string: a burst circulates through an averaging filter. Waveform i is the string after ' +
      'start + i × passes round trips, so a batch scans one decaying pluck (bright → mellow).',
    params: [
      { key: 'excite', label: 'Excitation', min: 0, max: 1, step: 1, value: DEFAULT_KS.excite, options: opts(['Noise burst (seeded)', 'Pluck shape']) },
      { key: 'length', label: 'String length', min: 16, max: 512, step: 1, value: DEFAULT_KS.length },
      { key: 'damping', label: 'Damping', min: 0, max: 1, step: 0.01, value: DEFAULT_KS.damping },
      { key: 'passes', label: 'Passes per waveform', min: 1, max: 64, step: 1, value: DEFAULT_KS.passes },
      { key: 'start', label: 'Start pass', min: 0, max: 256, step: 1, value: DEFAULT_KS.start },
      { key: 'position', label: 'Pluck position', min: 0.02, max: 0.5, step: 0.01, value: DEFAULT_KS.position },
    ],
    seeded: (p) => num(p, 'excite') === 0,
    render: (p, seed, index) =>
      karplusTable(
        {
          excite: num(p, 'excite'),
          length: num(p, 'length'),
          damping: num(p, 'damping'),
          passes: num(p, 'passes'),
          start: num(p, 'start'),
          position: num(p, 'position'),
        },
        seed,
        index,
      ),
  },
  {
    mode: 'additive',
    id: 'additive-designer',
    cat: 'Builders',
    name: 'Additive designer',
    about:
      'Harmonics at k^−slope (1 = saw), odd / even balance, up to three formant peaks (gain 0 = off) and a phase mode. ' +
      'A batch sweeps the slope to “Batch → slope” and moves the formants by “Batch → formant shift” octaves.',
    params: [
      { key: 'slope', label: 'Slope', min: 0, max: 3, step: 0.05, value: AD.slope },
      { key: 'slopeEnd', label: 'Batch → slope', min: 0, max: 3, step: 0.05, value: AD.slopeEnd },
      { key: 'balance', label: 'Even ← → odd', min: -1, max: 1, step: 0.05, value: AD.balance },
      { key: 'f1', label: 'Formant 1 centre', min: 1, max: 72, step: 0.5, value: AD.f1 },
      { key: 'w1', label: 'Formant 1 width', min: 0.5, max: 16, step: 0.25, value: AD.w1 },
      { key: 'g1', label: 'Formant 1 gain', min: 0, max: 8, step: 0.1, value: AD.g1 },
      { key: 'f2', label: 'Formant 2 centre', min: 1, max: 72, step: 0.5, value: AD.f2 },
      { key: 'w2', label: 'Formant 2 width', min: 0.5, max: 16, step: 0.25, value: AD.w2 },
      { key: 'g2', label: 'Formant 2 gain', min: 0, max: 8, step: 0.1, value: AD.g2 },
      { key: 'f3', label: 'Formant 3 centre', min: 1, max: 72, step: 0.5, value: AD.f3 },
      { key: 'w3', label: 'Formant 3 width', min: 0.5, max: 16, step: 0.25, value: AD.w3 },
      { key: 'g3', label: 'Formant 3 gain', min: 0, max: 8, step: 0.1, value: AD.g3 },
      { key: 'shift', label: 'Batch → formant shift (oct)', min: -2, max: 2, step: 0.05, value: AD.shift },
      { key: 'phase', label: 'Phases', min: 0, max: 2, step: 1, value: AD.phase, options: opts(['Sine', 'Schroeder (low crest)', 'Random (seeded)']) },
    ],
    seeded: (p) => num(p, 'phase') === 2,
    render: (p, seed, index, count) => additiveTable(nums<AdditiveParams>(p, AD), seed, index, count),
  },
  {
    mode: 'numseq',
    id: 'number-sequences',
    cat: 'Builders',
    name: 'Number sequences',
    about:
      'Steps per cycle taken from a number sequence (normalised, held or smoothed). A batch advances: ' +
      'digits / gaps move along the sequence, Collatz starts from the next number, Euclidean adds pulses.',
    params: [
      { key: 'source', label: 'Source', min: 0, max: 4, step: 1, value: SQ.source, options: opts(SEQ_SOURCES) },
      { key: 'steps', label: 'Steps per cycle', min: 2, max: 64, step: 1, value: SQ.steps },
      { key: 'smoothing', label: 'Smoothing', min: 0, max: 1, step: 0.01, value: SQ.smoothing },
      { key: 'offset', label: 'Offset', min: 0, max: 255, step: 1, value: SQ.offset },
      { key: 'advance', label: 'Batch → advance', min: 0, max: 16, step: 1, value: SQ.advance },
      { key: 'pulses', label: 'Pulses (Euclidean)', min: 1, max: 63, step: 1, value: SQ.pulses },
    ],
    seeded: () => false,
    render: (p, _seed, index) => sequenceTable(nums<SequenceParams>(p, SQ), index),
  },
  {
    mode: 'rd',
    id: 'reaction-diffusion',
    cat: 'Simulations',
    name: 'Reaction-diffusion ring',
    about:
      'Gray-Scott chemistry on a ring of cells from seeded spots; the waveform is the V concentration around the ring. ' +
      'Waveform i is the ring after start + i × steps, so a batch watches the pattern evolve. Feed / kill apply to Custom.',
    params: [
      {
        key: 'preset',
        label: 'Feed / kill',
        min: 0,
        max: RD_CUSTOM,
        step: 1,
        value: RD.preset,
        options: [...RD_PRESETS.map((p, i) => [i, `${p.label} (${p.feed} / ${p.kill})`] as const), [RD_CUSTOM, 'Custom']],
      },
      { key: 'feed', label: 'Feed (custom)', min: 0.005, max: 0.08, step: 0.001, value: RD.feed },
      { key: 'kill', label: 'Kill (custom)', min: 0.03, max: 0.075, step: 0.001, value: RD.kill },
      { key: 'cells', label: 'Cells', min: 16, max: 256, step: 8, value: RD.cells },
      { key: 'steps', label: 'Steps per waveform', min: 1, max: 1000, step: 1, value: RD.steps },
      { key: 'start', label: 'Start step', min: 0, max: 5000, step: 10, value: RD.start },
      { key: 'spots', label: 'Initial spots', min: 1, max: 8, step: 1, value: RD.spots },
    ],
    seeded: () => true,
    render: (p, seed, index) => rdTable(nums<RdParams>(p, RD), seed, index),
  },
];

export function paramMode(mode: string): ParamModeDef | undefined {
  return PARAM_MODES.find((m) => m.mode === mode);
}
