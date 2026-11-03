/**
 * Golden fixture for the native (C++) port: runs the TypeScript core on fixed inputs and
 * checks the result against plugin/core/tests/golden/core.golden.txt, which the C++ core
 * tests (plugin/core/tests) compare against too. Both implementations are held to the same
 * numbers, so a change to the TS core that alters them fails here until the fixture is
 * regenerated (and the C++ port updated to match):
 *
 *   npx vitest run -u tests/golden.test.ts
 *
 * Format (plain text, whitespace separated, one record per line):
 *   <kind> <name> <count> <count numbers…>
 * Kinds: `array` (a named number list), `mix` (one resolveMix case: query + result),
 * `op` (one timed engine command of scenario <name>: frame, opcode, args), `render`
 * (scenario <name>: sample rate, frames, chunk), `out` (its rendered samples), `status`
 * (its engine status afterwards). See plugin/core/tests/golden.cpp for the reader.
 */
import { describe, expect, it } from 'vitest';
import { Adsr } from '../src/core/engine/adsr';
import { emptyStatus, SynthEngine } from '../src/core/engine/engine';
import { cutoffG, driveSample, MultiFilter, resonanceK, softLimit } from '../src/core/engine/svf';
import { lfoWave, reflect01 } from '../src/core/modulation';
import { basicWave } from '../src/core/generators/basic';
import { midiNoteFreq, velocityGain } from '../src/core/midi';
import { buildMipSet, mipLevelFor } from '../src/core/mipmap';
import { deriveSeed, Prng } from '../src/core/prng';
import { emptySteps, STEP_LENGTHS, type StepLength } from '../src/core/sequence';
import { shape } from '../src/core/shape';
import { DEFAULT_VOICE, modulatedPosition, type VoiceParams } from '../src/core/voice';
import { DEFAULT_SYNTH, FILTER_MODES, NOISE_TYPES, PITCH_TARGETS, SUB_WAVES, type SynthParams } from '../src/core/synth';
import { LFO_DIVS, LFO_SHAPES, MOD_DESTS, MOD_SOURCES, type LfoParams, type ModSlot } from '../src/core/modulation';
import type { WavetableShape } from '../src/core/wavetable';
import { Mix, resolveMix, type PackedWavetable } from '../src/core/wavetablePlayback';

const FILE = '../plugin/core/tests/golden/core.golden.txt';
const N = 2048;

// Order matters: the C++ side refers to basic waves by index into this list.
const WAVES = ['sine', 'tri', 'saw', 'square', 'p25', 'p10'] as const;
const SHAPES: WavetableShape[] = ['1d', '2d', 'rows'];

const lines: string[] = [];
/** Doubles round-trip with 17 significant digits; float32 data needs 9. */
const num = (x: number, digits = 17) => (Number.isInteger(x) ? String(x) : x.toPrecision(digits));
function record(kind: string, name: string, values: ArrayLike<number>, digits = 17) {
  const parts = Array.from(values, (v) => num(v, digits));
  lines.push(`${kind} ${name} ${parts.length}${parts.length ? ' ' + parts.join(' ') : ''}`);
}

// ---- scalar helpers ----

function prngCases() {
  for (const seed of [0, 1, 12345, 0xdeadbeef]) {
    const r = new Prng(seed);
    record('array', `prng.${seed}`, Array.from({ length: 16 }, () => r.next()));
    record('array', `derive.${seed}`, Array.from({ length: 8 }, (_, i) => deriveSeed(seed, i)));
  }
}

/** Raw shape() inputs, defined by formula so the C++ test builds the same ones. */
function shapeInput(kind: number): Float64Array {
  const x = new Float64Array(N);
  const r = new Prng(7);
  for (let i = 0; i < N; i++) {
    const t = i / N;
    if (kind === 0) x[i] = 2 * t - 1; // naive saw: DC-free after shape, rich spectrum
    else if (kind === 1) x[i] = r.bipolar(); // white noise
    else if (kind === 2) x[i] = (t < 0.3 ? 1 : -1) + 0.5; // pulse with DC
    else x[i] = Math.cos(2 * Math.PI * 3 * t + 1) + 0.25 * Math.sin(2 * Math.PI * 7 * t); // fundamental absent
  }
  return x;
}

function shapeCases() {
  for (let k = 0; k < 4; k++) record('array', `shape.${k}`, shape(shapeInput(k)), 9);
  record('array', 'shape.1.lp12', shape(shapeInput(1), { lowpassHarmonic: 12 }), 9);
  record('array', 'shape.0.k20', shape(shapeInput(0), { kmax: 20 }), 9);
  WAVES.forEach((w, i) => record('array', `basic.${i}`, basicWave(w, 0), 9));
  record('array', 'mips.2', buildMipSet(basicWave('saw', 0)), 9);
  record('array', 'mips.4', buildMipSet(basicWave('p25', 0)), 9);
}

function synthUnitCases() {
  const xs = [-3, -1.2, -0.5, 0, 0.3, 0.9, 1, 1.7, 2.6];
  record('array', 'reflect01', xs.map(reflect01));
  record('array', 'softLimit', xs.map(softLimit));
  const dr: number[] = [];
  for (const d of [0, 0.25, 1]) for (const x of xs) dr.push(driveSample(x, d));
  record('array', 'drive', dr);
  record('array', 'resK', [-1, 0, 0.15, 0.5, 0.99, 1, 2].map(resonanceK));
  record('array', 'cutoffG', [1, 20, 440, 2400, 12000, 23000, 30000].flatMap((f) => [cutoffG(f, 44100), cutoffG(f, 96000)]));
  const lw: number[] = [];
  for (const sh of LFO_SHAPES) for (const ph of [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.99]) lw.push(lfoWave(sh, ph, 0.7, -0.3));
  record('array', 'lfoWave', lw);
  // Filters: an impulse + noise through each mode at a few settings (state carries across).
  const r = new Prng(11);
  const fo: number[] = [];
  for (let mode = 0; mode < 5; mode++) {
    const f = new MultiFilter();
    for (let i = 0; i < 256; i++) {
      const x = i === 0 ? 1 : r.bipolar() * 0.3;
      const g = cutoffG(200 * Math.pow(2, (i % 64) / 10), 48000);
      fo.push(f.process(x, mode, g, resonanceK((i % 7) / 6)));
    }
  }
  record('array', 'svf', fo);
}

function scalarCases() {
  const freqs = [20, 55, 110, 220, 330, 440, 880, 1760, 3000, 5000, 9000, 15000];
  record('array', 'miplevel.44100', freqs.map((f) => mipLevelFor(f, 44100)));
  record('array', 'miplevel.48000', freqs.map((f) => mipLevelFor(f, 48000)));
  record('array', 'miplevel.96000', freqs.map((f) => mipLevelFor(f, 96000)));
  const mp: number[] = [];
  for (const pos of [0, 0.3, 0.5, 0.9, 1]) for (const depth of [0, 0.5, 1]) for (const ph of [0, 1, 2.5, 4, 5.5]) mp.push(modulatedPosition(pos, depth, ph));
  record('array', 'modpos', mp);
  record('array', 'velgain', [0, 1, 32, 64, 100, 127, 200].map(velocityGain));
  record('array', 'notefreq', [0, 21, 60, 69, 127].flatMap((n) => [midiNoteFreq(n, 0), midiNoteFreq(n, -1), midiNoteFreq(n, 2)]));
  // ADSR: attack, decay, sustain, gate off, release to idle.
  const a = new Adsr();
  a.configure(0.002, 0.01, 0.4, 0.02, 48000);
  const env: number[] = [];
  a.gateOn();
  for (let i = 0; i < 1500; i++) {
    if (i === 900) a.gateOff();
    if (i === 1200) a.gateOn(); // retrigger from the current level
    env.push(a.next());
  }
  record('array', 'adsr', env);
}

// ---- resolveMix ----

/** Random packed wavetables (with empty slots / rows) and queries. */
function mixCases() {
  const r = new Prng(2024);
  const out = new Mix();
  for (let c = 0; c < 400; c++) {
    const sh = SHAPES[r.int(3)];
    const nRows = sh === '1d' ? 1 : 1 + r.int(5);
    const w2d = 1 + r.int(6);
    const lens: number[] = [];
    for (let y = 0; y < nRows; y++) lens.push(sh === '1d' ? r.int(12) : sh === '2d' ? w2d : r.int(7));
    const emptyP = r.next() < 0.3 ? 0.7 : 0.25;
    const ids: number[] = [];
    for (const L of lens) for (let x = 0; x < L; x++) ids.push(r.next() < emptyP ? -1 : 1 + r.int(9));
    const rowStart = [0];
    for (const L of lens) rowStart.push(rowStart[rowStart.length - 1] + L);
    const p: PackedWavetable = { shape: sh, interp: 'blend', rowStart: Int32Array.from(rowStart), ids: Int32Array.from(ids) };
    const maxL = Math.max(1, ...lens);
    const win = { x0: r.int(maxL + 2) - 1, x1: r.int(maxL + 2) - 1, y0: r.int(nRows + 2) - 1, y1: r.int(nRows + 2) - 1 };
    const px = r.next() < 0.15 ? r.int(2) : r.next();
    const py = r.next() < 0.15 ? r.int(2) : r.next();
    const step = r.next() < 0.35;
    resolveMix(p, win, px, py, step, out);
    const res: number[] = [out.n];
    for (let k = 0; k < out.n; k++) res.push(out.ids[k], out.w[k]);
    res.push(out.x, out.y);
    record('mix', String(c), [
      SHAPES.indexOf(sh),
      nRows,
      ...lens,
      ...ids,
      win.x0,
      win.x1,
      win.y0,
      win.y1,
      px,
      py,
      step ? 1 : 0,
      ...res,
    ]);
  }
}

// ---- engine scenarios ----

/** Opcodes shared with plugin/core/tests/golden.cpp. */
const OP = {
  table: 1, // id wave
  removeTable: 2, // id
  wavetable: 3, // id shape interp nRows lens… ids…
  voice: 4, // VOICE_FIELDS
  removeVoice: 5, // id
  sequence: 6, // id voiceId(-1 = none) length gate stepLength(index into STEP_LENGTHS) steps×64
  transport: 7, // playing bpm
  noteOn: 8, // voice note velocity
  noteOff: 9, // voice note
  allNotesOff: 10, // voice (-1 = all)
  bend: 11, // voice semitones
  patch: 12, // voice mask position positionY lfoDepth lfoRate level (mask bit i = field i present)
  removeSequence: 13, // id
  removeWavetable: 14, // id
  mod: 15, // voice value (mod wheel 0..1)
  pressure: 16, // voice value (channel pressure 0..1)
} as const;

const VOICE_FIELDS = [
  'id', 'wavetableId', 'windowStart', 'windowEnd', 'windowStartY', 'windowEndY', 'position', 'positionY',
  'lfoDepth', 'lfoRate', 'lfoDepthY', 'lfoRateY', 'lfoPhase', 'lfoPhaseY', 'octave', 'level', 'mute',
  'attack', 'decay', 'sustain', 'release',
] as const;
const PATCH_FIELDS = ['position', 'positionY', 'lfoDepth', 'lfoRate', 'level'] as const;

/**
 * Synth params as numbers, in this order (plugin/core/tests/golden.cpp decodes the same):
 * the scalar fields of SYNTH_SCALARS (enums as indices into their lists, booleans 0 / 1),
 * then b (OscSource, 7), 3 LFOs × 8 (shape, rate, sync, div, retrig, phase, fade, depth),
 * 8 mod slots × 3 (src index or -1, dst index or -1, amount).
 */
const SYNTH_SCALARS = [
  'aOct', 'aCoarse', 'aFine', 'aLevel', 'bOct', 'bCoarse', 'bFine', 'bLevel', 'subWave', 'subOct', 'subLevel',
  'noiseType', 'noiseLevel', 'ringLevel', 'filterMode', 'cutoff', 'resonance', 'drive', 'keyTrack', 'envAmount',
  'velAmount', 'fAttack', 'fDecay', 'fSustain', 'fRelease', 'pAttack', 'pDecay', 'pAmount', 'pTarget', 'velAmp',
  'glide', 'glideLegato', 'bendRange', 'pan', 'mAttack', 'mDecay', 'mSustain', 'mRelease', 'mMode', 'sync', 'fm',
  'aUnison', 'aDetune', 'aSpread', 'bUnison', 'bDetune', 'bSpread', 'sat', 'width',
] as const;
const SYNTH_ENUMS: Partial<Record<(typeof SYNTH_SCALARS)[number], readonly string[]>> = {
  subWave: SUB_WAVES,
  noiseType: NOISE_TYPES,
  filterMode: FILTER_MODES,
  pTarget: PITCH_TARGETS,
  mMode: ['ad', 'adsr'],
};
const SOURCE_FIELDS = ['wavetableId', 'windowStart', 'windowEnd', 'windowStartY', 'windowEndY', 'position', 'positionY'] as const;

function encodeSynth(sp: SynthParams): number[] {
  const out: number[] = [];
  const r = sp as unknown as Record<string, unknown>;
  for (const k of SYNTH_SCALARS) {
    const v = r[k];
    out.push(SYNTH_ENUMS[k] ? SYNTH_ENUMS[k]!.indexOf(v as string) : typeof v === 'boolean' ? (v ? 1 : 0) : (v as number));
  }
  for (const k of SOURCE_FIELDS) out.push(sp.b[k]);
  for (const l of sp.lfos) out.push(LFO_SHAPES.indexOf(l.shape), l.rate, l.sync ? 1 : 0, LFO_DIVS.indexOf(l.div), l.retrig ? 1 : 0, l.phase, l.fade, l.depth);
  for (const m of sp.mods) out.push(m.src === 'none' ? -1 : MOD_SOURCES.indexOf(m.src), m.dst === 'none' ? -1 : MOD_DESTS.indexOf(m.dst), m.amt);
  return out;
}

function decodeSynth(a: number[]): SynthParams {
  const o: Record<string, unknown> = {};
  let i = 0;
  for (const k of SYNTH_SCALARS) {
    const v = a[i++];
    const def = (DEFAULT_SYNTH as unknown as Record<string, unknown>)[k];
    o[k] = SYNTH_ENUMS[k] ? SYNTH_ENUMS[k]![v] : typeof def === 'boolean' ? v !== 0 : v;
  }
  const b: Record<string, number> = {};
  for (const k of SOURCE_FIELDS) b[k] = a[i++];
  o.b = b;
  const lfos: LfoParams[] = [];
  for (let n = 0; n < 3; n++) {
    lfos.push({ shape: LFO_SHAPES[a[i]], rate: a[i + 1], sync: a[i + 2] !== 0, div: LFO_DIVS[a[i + 3]], retrig: a[i + 4] !== 0, phase: a[i + 5], fade: a[i + 6], depth: a[i + 7] });
    i += 8;
  }
  o.lfos = lfos;
  const mods: ModSlot[] = [];
  for (let n = 0; n < 8; n++) {
    mods.push({ src: a[i] < 0 ? 'none' : MOD_SOURCES[a[i]], dst: a[i + 1] < 0 ? 'none' : MOD_DESTS[a[i + 1]], amt: a[i + 2] });
    i += 3;
  }
  o.mods = mods;
  return o as unknown as SynthParams;
}

type SynthOverrides = Partial<Omit<SynthParams, 'b' | 'lfos' | 'mods'>> & {
  b?: Partial<SynthParams['b']>;
  lfos?: Partial<LfoParams>[];
  mods?: ModSlot[];
};

/** DEFAULT_SYNTH with overrides (LFOs merge per index; mods replace from slot 0). */
function synth(o: SynthOverrides = {}): SynthParams {
  const lfos = DEFAULT_SYNTH.lfos.map((l, i) => ({ ...l, ...(o.lfos?.[i] ?? {}) }));
  const mods = DEFAULT_SYNTH.mods.map((m, i) => o.mods?.[i] ?? (o.mods ? { src: 'none', dst: 'none', amt: 0 } as ModSlot : m));
  return { ...DEFAULT_SYNTH, ...o, b: { ...DEFAULT_SYNTH.b, ...(o.b ?? {}) }, lfos, mods } as SynthParams;
}

type Op = [frame: number, code: number, ...args: number[]];

/** voice op: VOICE_FIELDS, type (0 simple, 1 synth), encodeSynth(synth). */
function voiceOp(frame: number, v: Partial<VoiceParams> & { id: number }): Op {
  const p = { ...DEFAULT_VOICE, name: '', ...v } as VoiceParams;
  return [frame, OP.voice, ...VOICE_FIELDS.map((f) => (f === 'mute' ? (p.mute ? 1 : 0) : (p[f] as number))), p.type === 'synth' ? 1 : 0, ...encodeSynth(p.synth)];
}
function wavetableOp(frame: number, id: number, sh: WavetableShape, interp: 'blend' | 'step', rows: number[][]): Op {
  return [frame, OP.wavetable, id, SHAPES.indexOf(sh), interp === 'step' ? 1 : 0, rows.length, ...rows.map((x) => x.length), ...rows.flat()];
}
function sequenceOp(frame: number, id: number, voiceId: number | null, steps: number[], gate: number, len: StepLength = '1/8'): Op {
  const s = emptySteps();
  steps.forEach((x, i) => (s[i] = x));
  return [frame, OP.sequence, id, voiceId ?? -1, steps.length, gate, STEP_LENGTHS.indexOf(len), ...s];
}
function patchOp(frame: number, voice: number, patch: Partial<Record<(typeof PATCH_FIELDS)[number], number>>): Op {
  let mask = 0;
  const vals = PATCH_FIELDS.map((f, i) => {
    if (patch[f] === undefined) return 0;
    mask |= 1 << i;
    return patch[f]!;
  });
  return [frame, OP.patch, voice, mask, ...vals];
}

function applyOp(e: SynthEngine, op: Op): void {
  const [, code, ...a] = op;
  switch (code) {
    case OP.table:
      return e.addTable(a[0], buildMipSet(basicWave(WAVES[a[1]], 0)));
    case OP.removeTable:
      return e.removeTables([a[0]]);
    case OP.wavetable: {
      const [id, sh, interp, nRows] = a;
      const lens = a.slice(4, 4 + nRows);
      const ids = a.slice(4 + nRows);
      const rowStart = [0];
      for (const L of lens) rowStart.push(rowStart[rowStart.length - 1] + L);
      return e.setWavetable(id, {
        shape: SHAPES[sh],
        interp: interp ? 'step' : 'blend',
        rowStart: Int32Array.from(rowStart),
        ids: Int32Array.from(ids),
      });
    }
    case OP.voice: {
      const v: Record<string, unknown> = { name: '' };
      VOICE_FIELDS.forEach((f, i) => (v[f] = f === 'mute' ? a[i] !== 0 : a[i]));
      v.type = a[VOICE_FIELDS.length] ? 'synth' : 'simple';
      v.synth = decodeSynth(a.slice(VOICE_FIELDS.length + 1));
      return e.setVoice(v as unknown as VoiceParams);
    }
    case OP.mod:
      return e.applyMidi({ type: 'mod', voiceId: a[0], value: a[1] });
    case OP.pressure:
      return e.applyMidi({ type: 'pressure', voiceId: a[0], value: a[1] });
    case OP.removeVoice:
      return e.removeVoice(a[0]);
    case OP.sequence:
      return e.setSequence({ id: a[0], voiceId: a[1] < 0 ? null : a[1], length: a[2], gate: a[3], stepLength: STEP_LENGTHS[a[4]], steps: a.slice(5) });
    case OP.transport:
      return e.setTransport(a[0] !== 0, a[1]);
    case OP.noteOn:
      return e.midiNoteOn(a[0], a[1], a[2]);
    case OP.noteOff:
      return e.midiNoteOff(a[0], a[1]);
    case OP.allNotesOff:
      return e.midiAllNotesOff(a[0]);
    case OP.bend:
      return e.setPitchBend(a[0], a[1]);
    case OP.patch: {
      const patch: Record<string, number> = {};
      PATCH_FIELDS.forEach((f, i) => {
        if (a[1] & (1 << i)) patch[f] = a[2 + i];
      });
      return e.patchVoice(a[0], patch);
    }
    case OP.removeSequence:
      return e.removeSequence(a[0]);
    case OP.removeWavetable:
      return e.removeWavetable(a[0]);
  }
  throw new Error(`unknown op ${code}`);
}

interface Scenario {
  name: string;
  sampleRate: number;
  frames: number;
  ops: Op[];
}

const DEMO = [0, -1, 3, -1, 4, 4, -1, 2, 0, -1, 5, 4, -1, 3, 2, -1];

const SCENARIOS: Scenario[] = [
  {
    // The web app's start state, sped-up LFO, Blend → Step → Blend and a window change.
    name: 'sequence',
    sampleRate: 48000,
    frames: 12000,
    ops: [
      ...WAVES.slice(0, 5).map((_, i): Op => [0, OP.table, i + 1, i]),
      wavetableOp(0, 0, '1d', 'blend', [[1, 2, 3, 4, 5]]),
      voiceOp(0, { id: 1, windowStart: 0, windowEnd: 4, position: 0.3, lfoDepth: 0.6, lfoRate: 2.5 }),
      voiceOp(0, { id: 2, windowStart: 1, windowEnd: 4, position: 0.75, lfoDepth: 0.3, lfoRate: 0.11, lfoPhase: 1.5, octave: 1, level: 0.5 }),
      sequenceOp(0, 1, 1, DEMO, 0.5),
      sequenceOp(0, 2, 2, [-1, -1, 7, -1, -1, 5, -1, -1], 0.8),
      [0, OP.transport, 1, 400],
      wavetableOp(3000, 0, '1d', 'step', [[1, 2, 3, 4, 5]]),
      wavetableOp(6000, 0, '1d', 'blend', [[1, 2, 3, 4, 5]]),
      voiceOp(6500, { id: 1, windowStart: 1, windowEnd: 3, position: 0.8, lfoDepth: 0.2, lfoRate: 2.5, attack: 0.01, release: 0.05 }),
      [9000, OP.transport, 1, 300],
    ],
  },
  {
    // MIDI on a 2D wavetable with empty cells: retrigger, legato return, bend, CC patch, removal.
    name: 'midi2d',
    sampleRate: 44100,
    frames: 12000,
    ops: [
      ...WAVES.map((_, i): Op => [0, OP.table, i + 1, i]),
      wavetableOp(0, 1, '2d', 'blend', [
        [1, -1, 3],
        [-1, 5, -1],
        [6, 2, -1],
      ]),
      voiceOp(0, { id: 2, wavetableId: 1, windowStart: 0, windowEnd: 2, windowStartY: 0, windowEndY: 2, lfoRate: 3, lfoRateY: 1.7, lfoDepthY: 0.8, sustain: 0.6 }),
      [10, OP.noteOn, 2, 60, 100],
      [1000, OP.bend, 2, 1.5],
      [3000, OP.noteOn, 2, 64, 40],
      [4000, OP.bend, 2, -2],
      [5000, OP.noteOff, 2, 64],
      patchOp(6000, 2, { position: 0.1, lfoDepth: 0, level: 0.4 }),
      [8000, OP.noteOff, 2, 60],
      [8500, OP.noteOn, 2, 72, 127],
      [9000, OP.allNotesOff, -1],
      [9500, OP.noteOn, 2, 48, 90],
      [10000, OP.removeVoice, 2],
    ],
  },
  {
    // Step lengths on the shared clock: 1/16, 1/8T, 1/4 and 1/16T sequences on three voices,
    // a tempo change mid-eighth, a step-length change, and a restart.
    name: 'steplen',
    sampleRate: 48000,
    frames: 16000,
    ops: [
      ...WAVES.slice(0, 4).map((_, i): Op => [0, OP.table, i + 1, i]),
      wavetableOp(0, 0, '1d', 'blend', [[1, 2, 3, 4]]),
      voiceOp(0, { id: 1, windowEnd: 3, attack: 0.001, decay: 0.05, sustain: 0.3, release: 0.02 }),
      voiceOp(0, { id: 2, windowEnd: 3, position: 0.8, octave: 1, attack: 0.001, decay: 0.03, sustain: 0.5, release: 0.01, level: 0.6 }),
      voiceOp(0, { id: 3, windowEnd: 3, position: 0.1, octave: -1, attack: 0.002, release: 0.05, level: 0.7 }),
      sequenceOp(0, 1, 1, [0, 2, 4, -1, 3], 0.4, '1/16'),
      sequenceOp(0, 2, 2, [5, -1, 7], 0.7, '1/8T'),
      sequenceOp(0, 3, 3, [0, 3], 0.9, '1/4'),
      [0, OP.transport, 1, 300],
      [5000, OP.transport, 1, 377],
      sequenceOp(9000, 2, 2, [5, 6, 7, 1], 0.5, '1/16T'),
      [12000, OP.transport, 0, 377],
      [12500, OP.transport, 1, 240],
    ],
  },
  {
    // A Synth voice with most of the path in use: osc B on a 2D wavetable, sub (square),
    // pink noise, ring, FM, LP24 with drive / resonance / key tracking / envelopes, pitch
    // envelope on B, glide, unison with spread (stereo) and width, saturation, three LFOs
    // (one tempo-synced S&H locked to the transport) and a full mod matrix; MIDI notes
    // (legato and not), bend, mod wheel, aftertouch; a Simple voice sequenced alongside.
    name: 'synth',
    sampleRate: 48000,
    frames: 16000,
    ops: [
      ...WAVES.map((_, i): Op => [0, OP.table, i + 1, i]),
      wavetableOp(0, 0, '1d', 'blend', [[1, 2, 3, 4, 5, 6]]),
      wavetableOp(0, 1, '2d', 'blend', [
        [3, 4],
        [6, 2],
      ]),
      voiceOp(0, {
        id: 1,
        type: 'synth',
        windowEnd: 5,
        position: 0.2,
        attack: 0.003,
        decay: 0.2,
        sustain: 0.6,
        release: 0.08,
        synth: synth({
          b: { wavetableId: 1, windowEnd: 1, windowEndY: 1, position: 0.4, positionY: 0.6 },
          bLevel: 0.5,
          bCoarse: 7,
          subWave: 'square',
          subOct: 2,
          subLevel: 0.3,
          noiseType: 'pink',
          noiseLevel: 0.1,
          ringLevel: 0.2,
          fm: 0.2,
          filterMode: 'lp24',
          cutoff: 900,
          resonance: 0.7,
          drive: 0.4,
          keyTrack: 1,
          envAmount: 0.5,
          pAmount: 7,
          pTarget: 'b',
          glide: 0.05,
          glideLegato: false,
          aUnison: 3,
          aDetune: 20,
          aSpread: 0.8,
          bUnison: 2,
          sat: 0.3,
          width: 1.5,
          pan: -0.2,
          mMode: 'ad',
          lfos: [{ shape: 'sine', rate: 3 }, { shape: 'tri', rate: 1.3, fade: 0.05 }, { shape: 'sh', sync: true, div: '1/16' }],
          mods: [
            { src: 'lfo1', dst: 'posA', amt: 0.4 },
            { src: 'lfo2', dst: 'cutoff', amt: 0.3 },
            { src: 'lfo3', dst: 'pitchB', amt: 0.1 },
            { src: 'menv', dst: 'levelB', amt: 0.5 },
            { src: 'wheel', dst: 'res', amt: 0.2 },
            { src: 'at', dst: 'pan', amt: 0.5 },
            { src: 'key', dst: 'drive', amt: 0.3 },
            { src: 'rand', dst: 'posB', amt: 0.2 },
          ],
        }),
      }),
      voiceOp(0, { id: 2, windowEnd: 5, octave: 1, level: 0.4 }),
      sequenceOp(0, 1, 2, [0, 3, -1, 5], 0.5, '1/16'),
      [0, OP.transport, 1, 150],
      [20, OP.noteOn, 1, 48, 100],
      [2000, OP.noteOn, 1, 55, 70],
      [2500, OP.bend, 1, 1.5],
      [3000, OP.mod, 1, 0.8],
      [4000, OP.pressure, 1, 0.6],
      [5000, OP.noteOff, 1, 55],
      [7000, OP.noteOff, 1, 48],
      [7600, OP.noteOn, 1, 60, 127],
      [9000, OP.pressure, 1, 0],
      [12000, OP.noteOff, 1, 60],
    ],
  },
  {
    // Synth voice edits while sounding: filter modes (HP / BP / notch / LP12), hard sync,
    // stronger FM, unison 4 → 1 → 2 (copies fade, places glide), ADSR mod envelope, retriggered
    // LFOs with phase and fade, legato glide; and a Simple ↔ Synth type switch on a held note.
    name: 'synthEdit',
    sampleRate: 44100,
    frames: 16000,
    ops: [
      ...WAVES.slice(0, 5).map((_, i): Op => [0, OP.table, i + 1, i]),
      wavetableOp(0, 0, '1d', 'step', [[1, 2, 3, 4, 5]]),
      ...(['hp', 'bp', 'notch', 'lp12'] as const).map((mode, k): Op =>
        voiceOp(k * 3000, {
          id: 1,
          type: 'synth',
          windowEnd: 4,
          sustain: 0.8,
          synth: synth({
            b: { windowEnd: 4, position: 0.9 },
            bLevel: 0.4,
            sync: k >= 1,
            fm: k >= 2 ? 0.6 : 0,
            filterMode: mode,
            cutoff: 1500 + k * 700,
            resonance: 0.3 + k * 0.2,
            aUnison: [4, 4, 1, 2][k],
            aSpread: 0.5,
            bUnison: [1, 3, 3, 1][k],
            bSpread: 0.9,
            glide: 0.03,
            glideLegato: true,
            mMode: 'adsr',
            mSustain: 0.5,
            lfos: [{ shape: 'saw', rate: 2, retrig: true, phase: 0.25, fade: 0.02 }, { shape: 'square', rate: 4 }, { shape: 'smooth', rate: 6 }],
            mods: [
              { src: 'lfo1', dst: 'posA', amt: -0.3 },
              { src: 'lfo2', dst: 'lfo3Rate', amt: 0.5 },
              { src: 'lfo3', dst: 'cutoff', amt: 0.4 },
              { src: 'menv', dst: 'amp', amt: -0.2 },
              { src: 'fenv', dst: 'sub', amt: 0.6 },
              { src: 'penv', dst: 'noise', amt: 0.3 },
              { src: 'vel', dst: 'lfo1Rate', amt: 0.4 },
              { src: 'lfo1', dst: 'pitchA', amt: 0.05 },
            ],
            pAmount: -5,
          }),
        }),
      ),
      voiceOp(0, { id: 2, windowEnd: 4, position: 0.6, level: 0.5 }),
      [10, OP.noteOn, 1, 50, 90],
      [10, OP.noteOn, 2, 62, 90],
      [1500, OP.noteOn, 1, 57, 60],
      [4500, OP.noteOff, 1, 57],
      voiceOp(5000, { id: 2, type: 'synth', windowEnd: 4, position: 0.6, level: 0.5, synth: synth({ cutoff: 600, aUnison: 2, aSpread: 1 }) }),
      voiceOp(9000, { id: 2, type: 'simple', windowEnd: 4, position: 0.6, level: 0.5, synth: synth({ cutoff: 600, aUnison: 2, aSpread: 1 }) }),
      [11000, OP.allNotesOff, -1],
      [11500, OP.noteOn, 1, 45, 127],
      [14000, OP.removeVoice, 1],
    ],
  },
  {
    // The CPU guard: six Synth voices with unison 4 + 4 holding notes (64 copies > 32).
    name: 'synthGuard',
    sampleRate: 48000,
    frames: 6000,
    ops: [
      ...WAVES.slice(0, 3).map((_, i): Op => [0, OP.table, i + 1, i]),
      wavetableOp(0, 0, '1d', 'blend', [[1, 2, 3]]),
      ...[1, 2, 3, 4, 5, 6].map((id): Op =>
        voiceOp(0, { id, type: 'synth', windowEnd: 2, level: 0.3, synth: synth({ bLevel: 0.3, aUnison: 4, bUnison: 4, aSpread: 0.7, bSpread: 0.7 }) }),
      ),
      ...[1, 2, 3, 4, 5, 6].map((id): Op => [100 + id * 300, OP.noteOn, id, 40 + id * 3, 100]),
      ...[1, 2, 3, 4].map((id): Op => [4000 + id * 200, OP.noteOff, id, 40 + id * 3]),
    ],
  },
  {
    // Rows + Step with tables that arrive late and are removed; sequence on an octave; stop.
    name: 'rows',
    sampleRate: 48000,
    frames: 12000,
    ops: [
      [0, OP.table, 1, 0],
      [0, OP.table, 2, 2],
      wavetableOp(0, 3, 'rows', 'step', [[1, 7], [], [8, -1, 2]]),
      voiceOp(0, { id: 1, wavetableId: 3, windowStartY: 0, windowEndY: 2, lfoRate: 4, lfoRateY: 2, lfoDepthY: 1, octave: -1 }),
      sequenceOp(0, 1, 1, [0, 3, 5, 7], 0.9),
      [0, OP.transport, 1, 240],
      [4000, OP.table, 7, 3],
      [4000, OP.table, 8, 5],
      wavetableOp(5000, 3, 'rows', 'blend', [[1, 7], [], [8, -1, 2]]),
      [7000, OP.removeTable, 1],
      [7000, OP.removeTable, 8],
      [9000, OP.transport, 0, 240],
      [10000, OP.removeSequence, 1],
    ],
  },
];

function scenarioCases() {
  for (const s of SCENARIOS) {
    const e = new SynthEngine(s.sampleRate);
    const out = new Float32Array(s.frames);
    const outR = new Float32Array(s.frames);
    const CHUNK = 128;
    let next = 0;
    for (let f = 0; f < s.frames; ) {
      while (next < s.ops.length && s.ops[next][0] <= f) applyOp(e, s.ops[next++]);
      // Render up to the next op or the chunk end, whichever comes first.
      const until = Math.min(s.frames, f + CHUNK, next < s.ops.length ? s.ops[next][0] : Infinity);
      e.process(out.subarray(f, until), until - f, outR.subarray(f, until));
      f = until;
    }
    for (const op of s.ops) record('op', s.name, op);
    record('render', s.name, [s.sampleRate, s.frames, CHUNK]);
    record('out', s.name, out, 9);
    // Right channel only where it differs (Synth voices with spread / pan); else equal to out.
    if (outR.some((x, i) => x !== out[i])) record('outR', s.name, outR, 9);
    const st = e.status(emptyStatus());
    record('status', s.name, [
      st.tick,
      st.playing ? 1 : 0,
      st.unisonLimited ? 1 : 0,
      st.voices.length,
      ...st.voices.flatMap((v) => [v.id, v.pos, v.posY, v.index, v.y, v.env, v.note, v.posB, v.posYB, v.indexB, v.yB]),
    ]);
  }
}

function build(): string {
  lines.length = 0;
  lines.push('# Generated by tests/golden.test.ts — do not edit. Regenerate: npx vitest run -u tests/golden.test.ts');
  prngCases();
  scalarCases();
  synthUnitCases();
  shapeCases();
  mixCases();
  scenarioCases();
  return lines.join('\n') + '\n';
}

describe('golden fixture for the native port', () => {
  // A changed record means the TS core's output changed: regenerate with `-u` (see the
  // top of this file) and bring the C++ port (plugin/core) in line.
  it('matches plugin/core/tests/golden/core.golden.txt', async () => {
    await expect(build()).toMatchFileSnapshot(FILE);
  });
});
