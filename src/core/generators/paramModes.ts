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
import { DEFAULT_KS, KS_MAX_PASS, karplusTable } from './karplus';
import { glyphTable } from './glyph';
import { DEFAULT_LIFE as LF, LIFE_READS, LIFE_RULES, lifeTable, type LifeParams } from './life';
import { DEFAULT_RD as RD, RD_CUSTOM, RD_PRESETS, rdTable, type RdParams } from './reactionDiffusion';
import { DEFAULT_SPLINE as SP, splineTable, type SplineParams } from './spline';
import { DEFAULT_POLYGON as PG, POLYGON_BATCHES, POLYGON_READS, polygonTable, type PolygonParams } from './polygon';
import { DEFAULT_SHAPER as SH, SHAPER_INPUTS, SHAPERS, shaperTable, type ShaperParams } from './shaper';
import { DEFAULT_FM as FMD, FM_ROUTINGS, fmTable, type FmParams } from './fm';
import { DEFAULT_PD as PDD, PD_SHAPES, pdTable, type PdParams } from './phaseDistortion';
import { DEFAULT_RESONANCE as RSD, RESONANCE_WINDOWS, resonanceTable, type ResonanceParams } from './resonance';
import { DEFAULT_SUPERFORMULA as SFD, superformulaTable, type SuperformulaParams } from './superformula';
import { DEFAULT_SEQUENCE as SQ, SEQ_SOURCES, sequenceTable, type SequenceParams } from './sequences';
import { DEFAULT_SUPERSAW as SS, SUPERSAW_MAX_VOICES, SUPERSAW_PHASES, SUPERSAW_WAVES, supersawTable, type SupersawParams } from './supersaw';

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

/**
 * A formula preset re-made as a starting point in a mode's parameter space: the library
 * entry keeps the preset's id, name, group and place, renders with the mode at these
 * values, and its defaults reproduce the preset's batch (at N = 8 where the preset steps
 * by n).
 */
export interface ModeVariant {
  /** The formula preset it replaces (its library id). */
  readonly id: string;
  /** Param values that differ from the mode's defaults. */
  readonly values: Readonly<Record<string, number>>;
}

export interface ParamModeDef {
  /** Recipe op and SeedEntry mode. */
  readonly mode: string;
  /** Library entry id. */
  readonly id: string;
  readonly cat: string;
  readonly name: string;
  /** One-line description shown under the parameters. */
  readonly about: string;
  /** Library placement: the id of the entry this one follows (default: with the other modes). */
  readonly after?: string;
  /** Formula presets re-made in this mode; a mode with variants is listed only through them. */
  readonly variants?: readonly ModeVariant[];
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

export const PARAM_MODES = [
  {
    mode: 'superformula',
    id: 'superformula-shape',
    cat: 'Shapers',
    name: 'Superformula',
    about:
      'Gielis’ superformula read as radius vs angle: m sets the symmetry, n1 how pinched the shape is, n2 and n3 its ' +
      'sides. The batch sweeps n2 and n3.',
    params: [
      { key: 'm', label: 'Symmetry m', min: 1, max: 24, step: 1, value: SFD.m },
      { key: 'n1', label: 'n1 (pinch)', min: 0.1, max: 12, step: 0.05, value: SFD.n1 },
      { key: 'n2', label: 'n2', min: 0.1, max: 20, step: 0.05, value: SFD.n2 },
      { key: 'n2End', label: 'Batch → n2', min: 0.1, max: 20, step: 0.05, value: SFD.n2End },
      { key: 'n3', label: 'n3', min: 0.1, max: 20, step: 0.05, value: SFD.n3 },
      { key: 'n3End', label: 'Batch → n3', min: 0.1, max: 20, step: 0.05, value: SFD.n3End },
    ],
    variants: [{ id: 'superformula', values: {} }],
    seeded: () => false,
    render: (p, _seed, index, count) => superformulaTable(nums<SuperformulaParams>(p, SFD), index, count),
  },
  {
    mode: 'resonance',
    id: 'resonance',
    cat: 'Voice',
    name: 'Resonance',
    about:
      'A sine at Ratio times the cycle’s frequency under a window that restarts every cycle (the CZ’s resonant waves); ' +
      'a non-integer ratio leaves a step at the restart. The batch sweeps the ratio.',
    params: [
      { key: 'window', label: 'Window', min: 0, max: RESONANCE_WINDOWS.length - 1, step: 1, value: RSD.window, options: opts(RESONANCE_WINDOWS) },
      { key: 'ratio', label: 'Ratio', min: 1, max: 24, step: 0.05, value: RSD.ratio },
      { key: 'ratioEnd', label: 'Batch → ratio', min: 1, max: 24, step: 0.05, value: RSD.ratioEnd },
    ],
    variants: [
      { id: 'cz-resonance-sine-window', values: {} },
      { id: 'cz-resonance-saw-window', values: { window: 1 } },
    ],
    seeded: () => false,
    render: (p, _seed, index, count) => resonanceTable(nums<ResonanceParams>(p, RSD), index, count),
  },
  {
    mode: 'pd',
    id: 'phase-distortion',
    cat: 'Phase',
    name: 'Phase distortion',
    about:
      'A sine read through a bent phase (Casio CZ style): Saw bends it at a knee, Square holds the peak and the trough, ' +
      'Half square the peak only. Amount 0 is the plain sine; the batch sweeps it.',
    params: [
      { key: 'shape', label: 'Shape', min: 0, max: PD_SHAPES.length - 1, step: 1, value: PDD.shape, options: opts(PD_SHAPES) },
      { key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, value: PDD.amount },
      { key: 'amountEnd', label: 'Batch → amount', min: 0, max: 1, step: 0.01, value: PDD.amountEnd },
    ],
    variants: [{ id: 'cz-phase-dist', values: {} }],
    seeded: () => false,
    render: (p, _seed, index, count) => pdTable(nums<PdParams>(p, PDD), index, count),
  },
  {
    mode: 'fm',
    id: 'fm-pm',
    cat: 'Phase',
    name: 'FM / PM',
    about:
      'A sine carrier phase-modulated by a sine modulator (integer ratios keep the cycle periodic); a second modulator ' +
      'goes into the modulator, multiplies it or goes into the carrier. The batch sweeps the index.',
    params: [
      { key: 'carrier', label: 'Carrier ratio', min: 1, max: 8, step: 1, value: FMD.carrier },
      { key: 'ratio', label: 'Modulator ratio', min: 1, max: 8, step: 1, value: FMD.ratio },
      { key: 'index', label: 'Index', min: 0, max: 12, step: 0.05, value: FMD.index },
      { key: 'indexEnd', label: 'Batch → index', min: 0, max: 12, step: 0.05, value: FMD.indexEnd },
      { key: 'ratio2', label: 'Second modulator ratio', min: 1, max: 8, step: 1, value: FMD.ratio2 },
      { key: 'amount2', label: 'Second modulator amount', min: 0, max: 4, step: 0.05, value: FMD.amount2 },
      { key: 'routing', label: 'Second modulator', min: 0, max: 2, step: 1, value: FMD.routing, options: opts(FM_ROUTINGS) },
    ],
    variants: [
      { id: 'nested-fm', values: { index: 0.5, indexEnd: 2.5, amount2: 2 } },
      { id: 'cross-pm', values: { ratio: 1, index: 0, indexEnd: 2, amount2: 1, routing: 1 } },
      { id: 'fm-sweep', values: {} },
    ],
    seeded: () => false,
    render: (p, _seed, index, count) => fmTable(nums<FmParams>(p, FMD), index, count),
  },
  {
    mode: 'shaper',
    id: 'waveshaper',
    cat: 'Shapers',
    name: 'Waveshaper',
    about:
      'An input wave (at a level, plus a bias) through a transfer curve; Amount is the curve’s drive, Chebyshev order, power ' +
      'exponent, clip gain or fold depth. The batch sweeps the amount and the bias.',
    params: [
      { key: 'shaper', label: 'Curve', min: 0, max: SHAPERS.length - 1, step: 1, value: SH.shaper, options: opts(SHAPERS) },
      { key: 'input', label: 'Input', min: 0, max: SHAPER_INPUTS.length - 1, step: 1, value: SH.input, options: opts(SHAPER_INPUTS) },
      { key: 'level', label: 'Input level', min: 0.05, max: 1, step: 0.01, value: SH.level },
      { key: 'amount', label: 'Amount', min: 0.05, max: 24, step: 0.05, value: SH.amount },
      { key: 'amountEnd', label: 'Batch → amount', min: 0.05, max: 24, step: 0.05, value: SH.amountEnd },
      { key: 'bias', label: 'Bias', min: -1, max: 1, step: 0.01, value: SH.bias },
      { key: 'biasEnd', label: 'Batch → bias', min: -1, max: 1, step: 0.01, value: SH.biasEnd },
    ],
    variants: [
      { id: 'soft-clip', values: { shaper: 0, amount: 1, amountEnd: 6 } },
      { id: 'chebyshev', values: { shaper: 1, level: 0.95, amount: 2, amountEnd: 9 } },
      { id: 'superellipse', values: { shaper: 2, amount: 0.05, amountEnd: 1 } },
      { id: 'shaped-pwm', values: { shaper: 0, amount: 3, amountEnd: 23, bias: -0.8, biasEnd: 0.8 } },
    ],
    seeded: () => false,
    render: (p, _seed, index, count) => shaperTable(nums<ShaperParams>(p, SH), index, count),
  },
  {
    mode: 'supersaw',
    id: 'supersaw',
    cat: 'Basic',
    name: 'Supersaw',
    after: 'pulse',
    about:
      'Detuned copies of one band-limited wave, centre loudest. Each waveform is one moment of the stack; the outer voices ' +
      'drift Detune cycles across the batch, so the wavetable beats.',
    params: [
      { key: 'voices', label: 'Voices', min: 1, max: SUPERSAW_MAX_VOICES, step: 1, value: SS.voices },
      { key: 'detune', label: 'Detune (cycles over the batch)', min: 0, max: 16, step: 0.05, value: SS.detune },
      { key: 'outer', label: 'Outer voices level', min: 0, max: 1, step: 0.01, value: SS.outer },
      { key: 'wave', label: 'Wave', min: 0, max: SUPERSAW_WAVES.length - 1, step: 1, value: SS.wave, options: opts(SUPERSAW_WAVES) },
      { key: 'phases', label: 'Start phases', min: 0, max: SUPERSAW_PHASES.length - 1, step: 1, value: SS.phases, options: opts(SUPERSAW_PHASES) },
    ],
    seeded: (p) => Math.round(num(p, 'phases')) === 0,
    render: (p, seed, index, count) => supersawTable(nums<SupersawParams>(p, SS), seed, index, count),
  },
  {
    mode: 'polygon',
    id: 'polygon',
    cat: 'Geometry',
    name: 'Polygon',
    after: 'blancmange',
    about:
      'A regular polygon or star {n/k} (a step sharing a factor with n draws a compound, e.g. {6/2}), read as its radius ' +
      'around the centre or traced at constant speed (the pen’s x; rotation matters there). Roundness rounds the corners.',
    params: [
      { key: 'read', label: 'Read', min: 0, max: 1, step: 1, value: PG.read, options: opts(POLYGON_READS) },
      { key: 'sides', label: 'Sides', min: 3, max: 16, step: 1, value: PG.sides },
      { key: 'star', label: 'Star step (1 = convex)', min: 1, max: 7, step: 1, value: PG.star },
      { key: 'roundness', label: 'Roundness', min: 0, max: 0.95, step: 0.01, value: PG.roundness },
      { key: 'rotation', label: 'Rotation (turns)', min: 0, max: 1, step: 0.01, value: PG.rotation },
      { key: 'batch', label: 'Batch', min: 0, max: 2, step: 1, value: PG.batch, options: opts(POLYGON_BATCHES) },
      { key: 'roundnessEnd', label: 'Batch → roundness', min: 0, max: 0.95, step: 0.01, value: PG.roundnessEnd },
      { key: 'rotationEnd', label: 'Batch → rotation', min: 0, max: 1, step: 0.01, value: PG.rotationEnd },
    ],
    seeded: () => false,
    render: (p, _seed, index, count) => polygonTable(nums<PolygonParams>(p, PG), index, count),
  },
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
      'A plucked string: a burst circulates through an averaging filter. A batch scans one decaying pluck ' +
      '(bright → mellow), from Start pass to “Batch → pass” round trips, log-spaced (early snapshots close together).',
    params: [
      { key: 'excite', label: 'Excitation', min: 0, max: 1, step: 1, value: DEFAULT_KS.excite, options: opts(['Noise burst (seeded)', 'Pluck shape']) },
      { key: 'length', label: 'String length', min: 16, max: 512, step: 1, value: DEFAULT_KS.length },
      { key: 'damping', label: 'Damping', min: 0, max: 1, step: 0.01, value: DEFAULT_KS.damping },
      { key: 'start', label: 'Start pass', min: 0, max: KS_MAX_PASS, step: 1, value: DEFAULT_KS.start },
      { key: 'end', label: 'Batch → pass', min: 0, max: KS_MAX_PASS, step: 1, value: DEFAULT_KS.end },
      { key: 'position', label: 'Pluck position', min: 0.02, max: 0.5, step: 0.01, value: DEFAULT_KS.position },
    ],
    seeded: (p) => num(p, 'excite') === 0,
    render: (p, seed, index, count) =>
      karplusTable(
        {
          excite: num(p, 'excite'),
          length: num(p, 'length'),
          damping: num(p, 'damping'),
          start: num(p, 'start'),
          end: num(p, 'end'),
          position: num(p, 'position'),
        },
        seed,
        index,
        count,
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
        key: 'system',
        label: 'Feed / kill',
        min: 0,
        max: RD_CUSTOM,
        step: 1,
        value: RD.system,
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
  {
    mode: 'life',
    id: 'life-like-ca',
    cat: 'Simulations',
    name: 'Life-like automaton',
    about:
      'A 2D cellular automaton (B/S rule) on a small torus from a seeded random fill. Each waveform reads one line ' +
      'of the board, or live cells per column / row, as steps; a batch is consecutive generations.',
    params: [
      { key: 'rule', label: 'Rule', min: 0, max: LIFE_RULES.length - 1, step: 1, value: LF.rule, options: LIFE_RULES.map((r, i) => [i, `${r.label} · ${r.rule}`] as const) },
      { key: 'read', label: 'Read', min: 0, max: LIFE_READS.length - 1, step: 1, value: LF.read, options: opts(LIFE_READS) },
      { key: 'size', label: 'Board size', min: 8, max: 64, step: 1, value: LF.size },
      { key: 'density', label: 'Initial density', min: 0.05, max: 0.95, step: 0.01, value: LF.density },
      { key: 'start', label: 'Start generation', min: 0, max: 256, step: 1, value: LF.start },
      { key: 'step', label: 'Generations per waveform', min: 1, max: 16, step: 1, value: LF.step },
    ],
    seeded: () => true,
    render: (p, seed, index) => lifeTable(nums<LifeParams>(p, LF), seed, index),
  },
  {
    mode: 'spline',
    id: 'spline',
    cat: 'Builders',
    name: 'Spline',
    about:
      'Seeded control points evenly spaced around the cycle, joined by a smooth periodic spline. A batch sweeps ' +
      'the jitter (each point moves along its own seeded direction) or adds a point per waveform.',
    params: [
      { key: 'points', label: 'Points', min: 3, max: 32, step: 1, value: SP.points },
      { key: 'kind', label: 'Curve', min: 0, max: 1, step: 1, value: SP.kind, options: opts(['Catmull-Rom (cardinal)', 'B-spline']) },
      { key: 'tension', label: 'Tension', min: 0, max: 1, step: 0.01, value: SP.tension },
      { key: 'jitter', label: 'Jitter', min: 0, max: 1, step: 0.01, value: SP.jitter },
      { key: 'jitterEnd', label: 'Batch → jitter', min: 0, max: 1, step: 0.01, value: SP.jitterEnd },
      { key: 'batch', label: 'Batch', min: 0, max: 1, step: 1, value: SP.batch, options: opts(['Sweep jitter', 'Add a point per waveform']) },
    ],
    seeded: () => true,
    render: (p, seed, index, count) => splineTable(nums<SplineParams>(p, SP), seed, index, count),
  },
  {
    mode: 'glyph',
    id: 'glyph-contour',
    cat: 'Builders',
    name: 'Glyph contour',
    about:
      'The outer contour of a character, read as radius vs angle around its centre. A batch takes the next ' +
      'characters of the text, sweeps the font weight (and the skew, as fonts have few weights), or sweeps the skew. ' +
      'Waveforms store the traced contour, not the font.',
    params: [
      { key: 'batch', label: 'Batch', min: 0, max: 2, step: 1, value: 0, options: opts(['Next characters', 'Sweep weight', 'Sweep skew']) },
      { key: 'weight', label: 'Weight', min: 100, max: 900, step: 100, value: 700 },
      { key: 'weightEnd', label: 'Batch → weight', min: 100, max: 900, step: 100, value: 200 },
      { key: 'skew', label: 'Skew', min: -1, max: 1, step: 0.01, value: 0 },
      { key: 'skewEnd', label: 'Batch → skew', min: -1, max: 1, step: 0.01, value: 0.6 },
    ],
    seeded: () => false,
    // `contour` (and `glyph`, the character) come per table from the host: SeedRequest.inputs.
    render: (p, _seed, index, count) =>
      glyphTable(
        { contour: String(p.contour ?? ''), skew: num(p, 'skew'), skewEnd: num(p, num(p, 'batch') === 0 ? 'skew' : 'skewEnd') },
        index,
        count,
      ),
  },
] as const satisfies readonly ParamModeDef[];

/** A parameter mode's recipe op / SeedEntry mode. */
export type ParamModeId = (typeof PARAM_MODES)[number]['mode'];

/** Recipe param keys a mode's params may not use (seedTable sets them). */
export const RESERVED_PARAM_KEYS: readonly string[] = ['preset', 'name'];

/** Recipe ops that are not parameter modes (a mode may not reuse one). */
export const RESERVED_OPS: readonly string[] = ['basic', 'pulse', 'formula', 'perlin', 'ca', 'mutate', 'breed', 'shape'];

{
  const seen = new Set<string>(RESERVED_OPS);
  for (const m of PARAM_MODES) {
    if (seen.has(m.mode)) throw new Error(`PARAM_MODES: mode '${m.mode}' collides with another op`);
    seen.add(m.mode);
    for (const p of m.params as readonly SeedParam[])
      if (RESERVED_PARAM_KEYS.includes(p.key)) throw new Error(`PARAM_MODES: ${m.mode} param '${p.key}' is reserved`);
  }
}

export function paramMode(mode: string): ParamModeDef | undefined {
  return (PARAM_MODES as readonly ParamModeDef[]).find((m) => m.mode === mode);
}

/** The mode's default params. */
export function paramDefaults(pm: ParamModeDef): Record<string, number> {
  return Object.fromEntries(pm.params.map((p) => [p.key, p.value]));
}

/**
 * Render with the mode's defaults under `p`, so a recipe saved before a param existed
 * re-renders with that param's default instead of NaN.
 */
export function renderParamMode(pm: ParamModeDef, p: ModeParams, seed: number, index: number, count: number): Float32Array {
  return pm.render({ ...paramDefaults(pm), ...p }, seed, index, count);
}
