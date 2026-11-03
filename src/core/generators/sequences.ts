/**
 * Number sequences: a window of `steps` values from a sequence (π / e digits, a Collatz
 * path, prime gaps, a Euclidean rhythm), held as steps across the cycle (optionally
 * smoothed). A batch advances through the sequence: the window moves by `advance` per
 * waveform (Collatz: the start number; Euclidean: the pulse count — rotating a periodic
 * pattern would only shift the cycle). Deterministic: no randomness.
 */
import { TABLE_SIZE } from '../constants';
import { shape } from '../shape';

export const SEQ_SOURCES = ['π digits', 'e digits', 'Collatz path', 'Prime gaps', 'Euclidean rhythm'] as const;

export interface SequenceParams {
  /** Index into SEQ_SOURCES. */
  source: number;
  /** Values per cycle, 2..64. */
  steps: number;
  /** 0 = held steps … 1 = cosine-interpolated. */
  smoothing: number;
  /** Start position (digits / gaps: index; Collatz: start number 27 + offset). */
  offset: number;
  /** Per batch waveform: window / start number / pulse count advance. */
  advance: number;
  /** Euclidean: pulses per cycle (1..steps−1). */
  pulses: number;
}

export const DEFAULT_SEQUENCE: SequenceParams = { source: 0, steps: 16, smoothing: 0, offset: 0, advance: 1, pulses: 5 };

/** The first 1024 decimal digits (indices wrap). */
const PI_DIGITS =
  '3141592653589793238462643383279502884197169399375105820974944592' +
  '3078164062862089986280348253421170679821480865132823066470938446' +
  '0955058223172535940812848111745028410270193852110555964462294895' +
  '4930381964428810975665933446128475648233786783165271201909145648' +
  '5669234603486104543266482133936072602491412737245870066063155881' +
  '7488152092096282925409171536436789259036001133053054882046652138' +
  '4146951941511609433057270365759591953092186117381932611793105118' +
  '5480744623799627495673518857527248912279381830119491298336733624' +
  '4065664308602139494639522473719070217986094370277053921717629317' +
  '6752384674818467669405132000568127145263560827785771342757789609' +
  '1736371787214684409012249534301465495853710507922796892589235420' +
  '1995611212902196086403441815981362977477130996051870721134999999' +
  '8372978049951059731732816096318595024459455346908302642522308253' +
  '3446850352619311881710100031378387528865875332083814206171776691' +
  '4730359825349042875546873115956286388235378759375195778185778053' +
  '2171226806613001927876611195909216420198938095257201065485863278';
const E_DIGITS =
  '2718281828459045235360287471352662497757247093699959574966967627' +
  '7240766303535475945713821785251664274274663919320030599218174135' +
  '9662904357290033429526059563073813232862794349076323382988075319' +
  '5251019011573834187930702154089149934884167509244761460668082264' +
  '8001684774118537423454424371075390777449920695517027618386062613' +
  '3138458300075204493382656029760673711320070932870912744374704723' +
  '0696977209310141692836819025515108657463772111252389784425056953' +
  '6967707854499699679468644549059879316368892300987931277361782154' +
  '2499922957635148220826989519366803318252886939849646510582093923' +
  '9829488793320362509443117301238197068416140397019837679320683282' +
  '3764648042953118023287825098194558153017567173613320698112509961' +
  '8188159304169035159888851934580727386673858942287922849989208680' +
  '5825749279610484198444363463244968487560233624827041978623209002' +
  '1609902353043699418491463140934317381436405462531520961836908887' +
  '0701676839642437814059271456354906130310720851038375051011574770' +
  '4171898610687396965521267154688957035035402123407849819334321068';

function digit(s: string, j: number): number {
  return s.charCodeAt(((j % s.length) + s.length) % s.length) - 48;
}

/** Collatz path from `start` (continuing 4, 2, 1, … once it reaches 1), as log2 values. */
function collatz(start: number, count: number): number[] {
  const out: number[] = [];
  let v = Math.max(1, Math.round(start));
  for (let j = 0; j < count; j++) {
    out.push(Math.log2(v));
    v = v % 2 ? 3 * v + 1 : v / 2;
  }
  return out;
}

/** Gaps between consecutive primes, from the `from`-th gap. */
function primeGaps(from: number, count: number): number[] {
  const primes: number[] = [];
  for (let k = 2; primes.length < from + count + 1; k++) {
    let prime = true;
    for (const p of primes) {
      if (p * p > k) break;
      if (k % p === 0) {
        prime = false;
        break;
      }
    }
    if (prime) primes.push(k);
  }
  const out: number[] = [];
  for (let j = from; j < from + count; j++) out.push(primes[j + 1] - primes[j]);
  return out;
}

/** Euclidean rhythm: k onsets spread over n steps (0 / 1). */
export function euclid(k: number, n: number): number[] {
  return Array.from({ length: n }, (_, j) => Math.floor(((j + 1) * k) / n) - Math.floor((j * k) / n));
}

/** The raw values of table `index`, before the constant-window guard. */
function rawValues(p: SequenceParams, index: number, shift: number): number[] {
  const n = Math.max(2, Math.min(64, Math.round(p.steps)));
  const off = Math.max(0, Math.round(p.offset)) + shift;
  const adv = Math.max(0, Math.round(p.advance)) * index;
  switch (Math.round(p.source)) {
    case 1:
      return Array.from({ length: n }, (_, j) => digit(E_DIGITS, off + adv + j));
    case 2:
      return collatz(27 + off + adv, n);
    case 3:
      return primeGaps(off + adv, n);
    case 4: {
      const k0 = Math.max(1, Math.min(n - 1, Math.round(p.pulses)));
      return euclid(1 + ((k0 - 1 + adv) % (n - 1)), n);
    }
    default:
      return Array.from({ length: n }, (_, j) => digit(PI_DIGITS, off + adv + j));
  }
}

/**
 * The values of table `index`. A constant window (e.g. π's "999999", prime gaps 2, 2)
 * would be silence: the window moves on, one position at a time, until it varies.
 */
export function sequenceValues(p: SequenceParams, index: number): number[] {
  let v = rawValues(p, index, 0);
  for (let shift = 1; shift < 1024 && v.every((x) => x === v[0]); shift++) v = rawValues(p, index, shift);
  return v;
}

export function sequenceTable(p: SequenceParams, index: number): Float32Array {
  const v = sequenceValues(p, index);
  const n = v.length;
  const lo = Math.min(...v);
  const span = Math.max(...v) - lo || 1;
  const y = v.map((x) => ((x - lo) / span) * 2 - 1);
  const s = Math.max(0, Math.min(1, p.smoothing));
  const x = new Float64Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i++) {
    const f = (i * n) / TABLE_SIZE;
    const j = Math.floor(f);
    const a = y[j];
    const b = y[(j + 1) % n];
    const c = a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * (f - j)));
    x[i] = (1 - s) * a + s * c;
  }
  return shape(x);
}
