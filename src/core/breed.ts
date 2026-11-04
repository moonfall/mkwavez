/**
 * Breeding: combine 2..MAX_PARENTS parent tables into a child (UI: ui/breed.ts).
 *
 * Every operator takes per-parent weights w (sum 1) derived from one Bias control:
 *  - walk 'path':    bias 0..1 walks A → B → C → … → last parent (pairwise crossfade);
 *  - walk 'ring':    bias 0..1 walks A → B → … → last → A;
 *  - walk 'weights': bias 0..1 moves from A alone to the user's per-parent weights.
 * At bias 0 the weights are exactly [1, 0, …], and every operator then returns
 * shape(A) (tested). Parents are shaped, so their fundamentals are phase-aligned and
 * time-domain and per-harmonic combinations are clean.
 *
 * Operators read the weights in one of two ways: as mix amounts (Crossfade, Spectral
 * mix, the swaps, Envelope) or as shares — each harmonic / band / time segment is
 * taken whole from one parent, picked by cumulative weight (Split, Genetic, Splice).
 * Seeded picks use one uniform per harmonic (or band / segment) that doesn't depend
 * on the bias, so a bias sweep with one seed hands harmonics over monotonically.
 *
 * Optional mutation: seeded Jitter at rate · min(1, 2·(1 − max w)), i.e. zero at any
 * pure parent and full at an even two-way mix.
 *
 * Batches (recipe op 'breed'):
 *   params  { breed, bias (this table's), batchBias (B), mode: single|sweep|gen,
 *             walk, weights ('' or comma-separated per-parent weights), rate }
 *   seed    the Apply's seed (gen child j uses childSeed(seed, j); child 0 = seed)
 *   parents every parent id, in order (A first)
 *   batch   { index, count }
 * Sweep table i (0-based) of N uses bias B·(i+1)/N and the Apply's seed.
 *
 * Generation children 1…N−1 also move their bias (and, for the weights walk, each
 * parent's weight) by a seeded jitter around the setting (breedChild()), so every operator
 * gives N different children — unseeded ones, and seeded ones whose picks a single parent
 * would win, made N identical children before. Child 0 stays the preview. The recipe
 * records the child's own bias / weights, so it re-renders without recomputing the jitter
 * (and recipes from before re-render exactly as they were made).
 *
 * Default bias (defaultBreedBias()): with three or more parents on the path walk, bias ½
 * is exactly a parent (B for three), where every operator returns that parent; the default
 * is the middle of the walk's middle segment instead.
 */
import { KMAX, TABLE_SIZE } from './constants';
import { fft } from './fft';
import { mutate } from './mutations';
import { deriveSeed, Prng } from './prng';
import { shape } from './shape';
import type { GeneratedTable, Recipe, TableId, WaveTable } from './table';

const N = TABLE_SIZE;
export const MAX_PARENTS = 8;

/** Splice: number of time segments and crossfade width (samples, raised cosine). */
export const SPLICE_SEGMENTS = 8;
export const SPLICE_FADE = 64;

export const BREED_OPS = [
  { group: 'Blend', id: 'mix', label: 'Crossfade', seeded: false, hint: 'Weighted sum of the parents’ samples' },
  { group: 'Blend', id: 'spectral', label: 'Spectral mix', seeded: false, hint: 'Harmonic magnitudes and phases mixed separately (no cancellation)' },
  { group: 'Swap', id: 'magsA', label: 'Magnitudes from A', seeded: false, hint: 'A’s harmonic magnitudes; phases move toward the others’' },
  { group: 'Swap', id: 'phasesA', label: 'Phases from A', seeded: false, hint: 'A’s phases; harmonic magnitudes move toward the others’' },
  { group: 'Shape', id: 'envelope', label: 'Envelope transfer', seeded: false, hint: 'A’s harmonics re-weighted toward the others’ smoothed spectral envelope' },
  { group: 'Crossover', id: 'split', label: 'Harmonic split', seeded: false, hint: 'Contiguous harmonic bands, A lowest, sized by the weights' },
  { group: 'Crossover', id: 'genetic', label: 'Genetic per harmonic', seeded: true, hint: 'Each harmonic whole from one parent, seeded pick by weight' },
  { group: 'Crossover', id: 'bands', label: 'Genetic per band', seeded: true, hint: 'Each third-octave band whole from one parent, seeded pick by weight' },
  { group: 'Time', id: 'splice', label: 'Splice', seeded: true, hint: `${SPLICE_SEGMENTS} seeded time segments, each from one parent, crossfaded` },
] as const;

export type BreedOpId = (typeof BREED_OPS)[number]['id'];
export type BiasWalk = 'path' | 'ring' | 'weights';
export type BreedMode = 'single' | 'sweep' | 'gen';

export interface BreedParams {
  op: BreedOpId;
  /** 0 = parent A exactly. */
  bias: number;
  walk: BiasWalk;
  /** Per-parent weights for walk 'weights' (missing entries count as 1). */
  weights?: readonly number[];
  /** Mutation (Jitter) rate, 0..1. */
  rate: number;
  seed: number;
}

/** Envelope: Gaussian smoothing width (harmonics) and floor relative to the envelope peak. */
const ENV_SIGMA = 2;
const ENV_FLOOR = 1e-3;
/** A harmonic below this fraction of its table's strongest has no meaningful phase. */
const PHASE_EPS = 1e-4;
/** Stream index for the mutation seed (independent of the mask draws). */
const MUTATION_STREAM = 0x6a17;

export const isSeededOp = (op: BreedOpId): boolean => BREED_OPS.find((o) => o.id === op)?.seeded ?? false;

/** Segments of a bias walk: path P−1, ring P, weights 1 (A → the custom mix). */
const walkSegments = (count: number, walk: BiasWalk) => (walk === 'weights' ? 1 : Math.max(1, walk === 'ring' ? count : count - 1));

/**
 * The default bias for `count` parents: the middle of the walk's middle segment (between
 * two parents, never on one). Two parents on the path: ½; three: ¾ (between B and C);
 * four: ½ (between B and C). Weights walk: ½.
 */
export function defaultBreedBias(count: number, walk: BiasWalk): number {
  if (walk === 'weights' || count < 2) return 0.5;
  const segs = walkSegments(count, walk);
  return (Math.floor(segs / 2) + 0.5) / segs;
}

/**
 * Generation jitter: the bias moves by GEN_BIAS_JITTER_MIN … GEN_BIAS_JITTER of a walk
 * segment, either way (at least a little, so no child repeats the preview); weights ×
 * 2^±GEN_WEIGHT_JITTER.
 */
export const GEN_BIAS_JITTER = 0.25;
export const GEN_BIAS_JITTER_MIN = 0.1;
export const GEN_WEIGHT_JITTER = 1;
/** Stream index for the generation jitter draws. */
const GEN_STREAM = 0x6e7a;

/** v folded back into [0, 1] (no clamping: a jittered bias near 0 doesn't stick to parent A). */
const reflect01 = (v: number) => {
  const m = ((v % 2) + 2) % 2;
  return m > 1 ? 2 - m : m;
};

/** Per-parent weights (sum 1) for a bias walk. Bias 0 is always [1, 0, …]. */
export function breedWeights(count: number, bias: number, walk: BiasWalk, custom?: readonly number[]): number[] {
  const w = new Array<number>(count).fill(0);
  if (count <= 0) return w;
  const t = Math.max(0, Math.min(1, bias));
  if (count === 1) {
    w[0] = 1;
    return w;
  }
  if (walk === 'weights') {
    const c = Array.from({ length: count }, (_, i) => Math.max(0, custom?.[i] ?? 1));
    const sum = c.reduce((a, b) => a + b, 0);
    for (let i = 0; i < count; i++) w[i] = t * (sum > 0 ? c[i] / sum : 1 / count);
    w[0] += 1 - t;
    return w;
  }
  const segs = walk === 'ring' ? count : count - 1;
  const s = t * segs;
  const i = Math.min(Math.floor(s), segs - 1);
  const f = s - i;
  w[i % count] += 1 - f;
  w[(i + 1) % count] += f;
  return w;
}

/** Jitter amount for these weights: 0 at a pure parent, full at an even two-way mix. */
export function mutationAmount(rate: number, w: readonly number[]): number {
  return Math.max(0, rate) * Math.min(1, 2 * (1 - Math.max(...w)));
}

// ---- spectra ----

interface Spec {
  re: Float64Array;
  im: Float64Array;
  mag: Float64Array;
  maxMag: number;
}

const specCache = new WeakMap<Float32Array, Spec>();

/** Harmonics 1..KMAX of a (shaped) table; cached per data array (tables are immutable). */
function spec(x: Float32Array): Spec {
  let s = specCache.get(x);
  if (s) return s;
  const R = Float64Array.from(x);
  const I = new Float64Array(N);
  fft(R, I, false);
  const re = new Float64Array(KMAX + 1);
  const im = new Float64Array(KMAX + 1);
  const mag = new Float64Array(KMAX + 1);
  let maxMag = 0;
  for (let k = 1; k <= KMAX; k++) {
    re[k] = R[k];
    im[k] = I[k];
    mag[k] = Math.hypot(R[k], I[k]);
    maxMag = Math.max(maxMag, mag[k]);
  }
  s = { re, im, mag, maxMag };
  specCache.set(x, s);
  return s;
}

/** Harmonics 1..KMAX → time domain → shape(). */
function fromHarmonics(re: Float64Array, im: Float64Array): Float32Array {
  const R = new Float64Array(N);
  const I = new Float64Array(N);
  for (let k = 1; k <= KMAX; k++) {
    R[k] = re[k];
    I[k] = im[k];
    R[N - k] = re[k];
    I[N - k] = -im[k];
  }
  fft(R, I, true);
  return shape(R);
}

/** Index of the parent whose cumulative-weight interval contains u (0 <= u < 1). */
function pickByShare(w: readonly number[], u: number): number {
  let c = 0;
  for (let p = 0; p < w.length; p++) {
    c += w[p];
    if (u < c) return p;
  }
  // Rounding: fall back to the last parent with weight.
  for (let p = w.length - 1; p >= 0; p--) if (w[p] > 0) return p;
  return 0;
}

const hasPhase = (s: Spec, k: number) => s.mag[k] > s.maxMag * PHASE_EPS;

/** Wrap an angle to (−π, π]. */
const wrapPi = (x: number) => x - 2 * Math.PI * Math.ceil((x - Math.PI) / (2 * Math.PI));

/**
 * Weighted phase interpolation at harmonic k, continuous in the weights: each parent's
 * phase is a fixed shortest-arc offset from a reference parent (the first with a
 * defined phase, normally A), and the offsets are averaged linearly. (A unit-phasor
 * mean jumps by π where two parents are in antiphase at an even mix.) Parents without
 * a defined phase at k count as offset 0. A pure parent gets its own phase.
 */
function interpPhase(S: readonly Spec[], w: readonly number[], k: number, fallback: number): number {
  let ref = -1;
  for (let p = 0; p < S.length && ref < 0; p++) if (hasPhase(S[p], k)) ref = p;
  if (ref < 0) return fallback;
  const pr = Math.atan2(S[ref].im[k], S[ref].re[k]);
  let acc = 0;
  let ws = 0;
  for (let p = 0; p < S.length; p++) {
    if (!w[p]) continue;
    ws += w[p];
    if (hasPhase(S[p], k)) acc += w[p] * wrapPi(Math.atan2(S[p].im[k], S[p].re[k]) - pr);
  }
  return ws > 0 ? pr + acc / ws : fallback;
}

/** Gaussian-smoothed magnitude envelope, normalised to peak 1, floored, as log. */
function logEnvelope(s: Spec): Float64Array {
  const e = new Float64Array(KMAX + 1);
  const r = Math.ceil(3 * ENV_SIGMA);
  let peak = 0;
  for (let k = 1; k <= KMAX; k++) {
    let a = 0;
    let ws = 0;
    for (let j = Math.max(1, k - r); j <= Math.min(KMAX, k + r); j++) {
      const g = Math.exp(-0.5 * ((j - k) / ENV_SIGMA) ** 2);
      a += g * s.mag[j];
      ws += g;
    }
    e[k] = a / ws;
    peak = Math.max(peak, e[k]);
  }
  for (let k = 1; k <= KMAX; k++) e[k] = Math.log(peak > 0 ? Math.max(e[k] / peak, ENV_FLOOR) : 1);
  return e;
}

/** Third-octave band of harmonic k (k=1 → 0 … k=72 → 18). */
const bandOf = (k: number) => Math.floor(3 * Math.log2(k));

function circularGates(assign: Int32Array, parents: number): Float64Array[] {
  // Raised-cosine kernel, normalised; gates sum to 1 because the indicators do.
  const W = SPLICE_FADE;
  const ker = new Float64Array(W + 1);
  let ks = 0;
  for (let j = 0; j <= W; j++) {
    ker[j] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (j + 0.5)) / (W + 1));
    ks += ker[j];
  }
  const gates: Float64Array[] = [];
  for (let p = 0; p < parents; p++) {
    const g = new Float64Array(N);
    let any = false;
    for (let i = 0; i < N; i++) if (assign[i] === p) any = true;
    if (any) {
      for (let i = 0; i < N; i++) {
        let a = 0;
        for (let j = 0; j <= W; j++) if (assign[(i + j - W / 2 + N) % N] === p) a += ker[j];
        g[i] = a / ks;
      }
    }
    gates.push(g);
  }
  return gates;
}

/** One child from parent data (A first). Deterministic in (op, weights, rate, seed). */
export function breed(parents: readonly Float32Array[], params: BreedParams): Float32Array {
  if (!parents.length) throw new Error('breed: no parents');
  const P = parents.length;
  const w = breedWeights(P, params.bias, params.walk, params.weights);
  const seed = params.seed >>> 0;
  let y = breedRaw(params.op, parents, w, seed);
  const amt = mutationAmount(params.rate, w);
  if (amt > 0) y = mutate('jitter', y, amt, deriveSeed(seed, MUTATION_STREAM));
  return y;
}

function breedRaw(op: BreedOpId, X: readonly Float32Array[], w: readonly number[], seed: number): Float32Array {
  const P = X.length;
  const rand = new Prng(seed);
  const re = new Float64Array(KMAX + 1);
  const im = new Float64Array(KMAX + 1);
  switch (op) {
    case 'mix': {
      const y = new Float64Array(N);
      for (let p = 0; p < P; p++) {
        if (!w[p]) continue;
        const x = X[p];
        for (let i = 0; i < N; i++) y[i] += w[p] * x[i];
      }
      return shape(y);
    }
    case 'spectral': {
      // Magnitudes and phases interpolated separately: no cancellation.
      const S = X.map(spec);
      for (let k = 1; k <= KMAX; k++) {
        let m = 0;
        for (let p = 0; p < P; p++) m += w[p] * S[p].mag[k];
        const ph = interpPhase(S, w, k, Math.atan2(S[0].im[k], S[0].re[k]));
        re[k] = m * Math.cos(ph);
        im[k] = m * Math.sin(ph);
      }
      return fromHarmonics(re, im);
    }
    case 'magsA': {
      // A's magnitudes; phases walk toward the others' (A's where a donor has none).
      const S = X.map(spec);
      for (let k = 1; k <= KMAX; k++) {
        const ph = interpPhase(S, w, k, Math.atan2(S[0].im[k], S[0].re[k]));
        re[k] = S[0].mag[k] * Math.cos(ph);
        im[k] = S[0].mag[k] * Math.sin(ph);
      }
      return fromHarmonics(re, im);
    }
    case 'phasesA': {
      // A's phases; magnitudes walk toward the others' (where A has no phase, the donors').
      const S = X.map(spec);
      const donors = w.map((v, p) => (p === 0 ? 0 : v));
      for (let k = 1; k <= KMAX; k++) {
        let m = 0;
        for (let p = 0; p < P; p++) m += w[p] * S[p].mag[k];
        const pa = Math.atan2(S[0].im[k], S[0].re[k]);
        const ph = hasPhase(S[0], k) ? pa : interpPhase(S, donors, k, pa);
        re[k] = m * Math.cos(ph);
        im[k] = m * Math.sin(ph);
      }
      return fromHarmonics(re, im);
    }
    case 'envelope': {
      // A's harmonics, re-weighted from A's smoothed envelope toward the weighted
      // (geometric) mix of all parents' envelopes. A's phases.
      const S = X.map(spec);
      const E = X.map((_, p) => (w[p] || p === 0 ? logEnvelope(S[p]) : null));
      for (let k = 1; k <= KMAX; k++) {
        let le = 0;
        for (let p = 0; p < P; p++) if (w[p]) le += w[p] * E[p]![k];
        const g = Math.exp(le - E[0]![k]);
        re[k] = S[0].re[k] * g;
        im[k] = S[0].im[k] * g;
      }
      return fromHarmonics(re, im);
    }
    case 'split': {
      // Contiguous bands on a log-harmonic axis, A lowest, sized by the weights.
      const S = X.map(spec);
      const L = Math.log(KMAX + 1);
      for (let k = 1; k <= KMAX; k++) {
        const p = pickByShare(w, Math.log(k) / L);
        re[k] = S[p].re[k];
        im[k] = S[p].im[k];
      }
      return fromHarmonics(re, im);
    }
    case 'genetic':
    case 'bands': {
      const S = X.map(spec);
      const nu = op === 'bands' ? bandOf(KMAX) + 1 : KMAX + 1;
      const u = new Float64Array(nu);
      for (let j = 0; j < nu; j++) u[j] = rand.next();
      for (let k = 1; k <= KMAX; k++) {
        const p = pickByShare(w, u[op === 'bands' ? bandOf(k) : k]);
        re[k] = S[p].re[k];
        im[k] = S[p].im[k];
      }
      return fromHarmonics(re, im);
    }
    case 'splice': {
      // Seeded segment boundaries (stratified), each segment from one parent, joined
      // by circular raised-cosine crossfades (no seams, including at the loop point).
      const Sg = SPLICE_SEGMENTS;
      const b: number[] = [];
      for (let j = 0; j < Sg; j++) b.push(Math.floor(((j + 0.15 + 0.7 * rand.next()) / Sg) * N));
      const pick: number[] = [];
      for (let j = 0; j < Sg; j++) pick.push(pickByShare(w, rand.next()));
      const assign = new Int32Array(N);
      for (let j = 0; j < Sg; j++) {
        const end = j + 1 < Sg ? b[j + 1] : b[0] + N;
        for (let i = b[j]; i < end; i++) assign[i % N] = pick[j];
      }
      const gates = circularGates(assign, P);
      const y = new Float64Array(N);
      for (let p = 0; p < P; p++) {
        const g = gates[p];
        const x = X[p];
        for (let i = 0; i < N; i++) if (g[i]) y[i] += g[i] * x[i];
      }
      return shape(y);
    }
  }
}

// ---- batches and recipes ----

export interface BreedRequest extends BreedParams {
  mode: BreedMode;
  /** Number of children (forced to 1 for 'single'). */
  count: number;
}

/** Seed for generation child j (0-based); child 0 uses the Apply's seed, so it equals the preview. */
export function childSeed(seed: number, j: number): number {
  return j === 0 ? seed >>> 0 : deriveSeed(seed, j);
}

/** Sweep biases B·(i+1)/N, i = 0..N−1 (ends at B, excludes 0 = parent A). */
export function sweepBiases(n: number, bias: number): number[] {
  return Array.from({ length: n }, (_, i) => (bias * (i + 1)) / n);
}

const weightsParam = (walk: BiasWalk, weights?: readonly number[]) =>
  walk === 'weights' && weights ? weights.join(',') : '';

export function parseWeights(s: unknown): number[] | undefined {
  if (typeof s !== 'string' || !s) return undefined;
  return s.split(',').map(Number);
}

/** Number of children an Apply makes (1 for 'single'). */
export const breedCount = (req: BreedRequest): number => (req.mode === 'single' ? 1 : Math.max(1, Math.round(req.count)));

/** Bias of child i (0-based) of an Apply: B·(i+1)/N for a sweep, B otherwise (before a generation's jitter: breedChild()). */
export function breedBiasAt(req: BreedRequest, i: number): number {
  return req.mode === 'sweep' ? (req.bias * (i + 1)) / breedCount(req) : req.bias;
}

/**
 * Bias and custom weights (walk 'weights') of child i of an Apply with `count` parents:
 * breedBiasAt(), and for generation children after the first a seeded jitter around them —
 * the bias by GEN_BIAS_JITTER_MIN…GEN_BIAS_JITTER of a walk segment either way (folded back into [0, 1]), each
 * weight by a factor up to 2^±GEN_WEIGHT_JITTER.
 */
export function breedChild(req: BreedRequest, count: number, i: number): { bias: number; weights?: number[] } {
  const bias = breedBiasAt(req, i);
  const weights = req.walk === 'weights' ? Array.from({ length: count }, (_, p) => req.weights?.[p] ?? 1) : undefined;
  if (req.mode !== 'gen' || i === 0) return { bias, weights };
  const r = new Prng(deriveSeed(childSeed(req.seed, i), GEN_STREAM));
  const u = r.bipolar();
  const nudge = Math.sign(u || 1) * (GEN_BIAS_JITTER_MIN + (GEN_BIAS_JITTER - GEN_BIAS_JITTER_MIN) * Math.abs(u));
  const b = reflect01(bias + nudge / walkSegments(count, req.walk));
  return { bias: b, weights: weights?.map((w) => w * Math.pow(2, GEN_WEIGHT_JITTER * r.bipolar())) };
}

/**
 * Child i of an Apply, exactly as breedBatch() returns it (lets a preview compute the
 * batch incrementally, shown child first). Parents in order, A first (>= 1).
 */
export function breedBatchTable(req: BreedRequest, parents: readonly WaveTable[], i: number): GeneratedTable {
  const count = breedCount(req);
  const seed = req.seed >>> 0;
  const { bias, weights } = breedChild(req, parents.length, i);
  const recipe: Recipe = {
    op: 'breed',
    params: {
      breed: req.op,
      bias,
      batchBias: req.bias,
      mode: req.mode,
      walk: req.walk,
      weights: weightsParam(req.walk, weights),
      rate: req.rate,
    },
    seed,
    parents: parents.map((p) => p.id),
    batch: { index: i, count },
  };
  const s = req.mode === 'gen' ? childSeed(seed, i) : seed;
  const data = breed(
    parents.map((p) => p.data),
    { op: req.op, bias, walk: req.walk, weights, rate: req.rate, seed: s },
  );
  return { data, recipe };
}

/** Generate the children for one Apply. Parents in order, A first (>= 1). */
export function breedBatch(req: BreedRequest, parents: readonly WaveTable[]): GeneratedTable[] {
  return Array.from({ length: breedCount(req) }, (_, i) => breedBatchTable(req, parents, i));
}

/** Re-render a 'breed' recipe; `resolve` supplies parent data by id. */
export function renderBreedRecipe(r: Recipe, resolve: (id: TableId) => Float32Array | undefined): Float32Array {
  const data = r.parents.map((id) => {
    const d = resolve(id);
    if (!d) throw new Error(`renderBreedRecipe: parent ${id} unavailable`);
    return d;
  });
  const p = r.params;
  const index = r.batch?.index ?? 0;
  return breed(data, {
    op: p.breed as BreedOpId,
    bias: Number(p.bias),
    walk: p.walk as BiasWalk,
    weights: parseWeights(p.weights),
    rate: Number(p.rate),
    seed: p.mode === 'gen' ? childSeed(r.seed, index) : r.seed,
  });
}
