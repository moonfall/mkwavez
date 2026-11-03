/**
 * The Voice panel's body for a Synth voice: compact pages (Osc · Mix · Filter · Env) in the
 * panel's usual footprint. Each page is a column of compact rows (label · slider · value)
 * plus, where it helps, a picture on the right: the oscillator's X/Y pad or "now playing"
 * scope, the filter's response curve, the selected envelope. Every edit goes through
 * AppModel.updateVoice (undoable on a Synth voice; a slider drag is one step).
 */
import type { AppModel } from '../app/model';
import type { AudioBridge } from '../audio/bridge';
import { TABLE_SIZE } from '../core/constants';
import { filterResponse } from '../core/engine/svf';
import {
  CUTOFF_MAX,
  CUTOFF_MIN,
  FILTER_ENV_OCTAVES,
  FILTER_MODE_LABELS,
  FILTER_MODES,
  type FilterMode,
  type OscSource,
  type SynthParams,
} from '../core/synth';
import type { VoicePatch, VoiceParams } from '../core/voice';
import { shapeLabel } from '../core/wavetable';
import { Mix } from '../core/wavetablePlayback';
import { cssColor, drawSpectrum, drawWave, fit, onThemeChange } from './canvas';
import { isOnScreen, watchVisibility, type UiState } from './context';
import { h, voiceColorVar } from './dom';
import { oscMix, oscPositions, oscView } from './playing';
import { createVoicePad } from './voicePad';

export type SynthPage = 'osc' | 'mix' | 'filter' | 'env';
const PAGES: readonly [SynthPage, string][] = [
  ['osc', 'Osc'],
  ['mix', 'Mix'],
  ['filter', 'Filter'],
  ['env', 'Env'],
];
type EnvPage = 'amp' | 'filter' | 'pitch';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const secs = (v: number) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);
const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} k` : `${Math.round(v)} Hz`);
const signed = (v: number, digits = 0, unit = '') => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}${unit}`;

/** Value ↔ slider position (0..1) mappings. */
interface Taper {
  toU(v: number): number;
  toV(u: number): number;
}
const linear = (min: number, max: number): Taper => ({ toU: (v) => (v - min) / (max - min), toV: (u) => min + u * (max - min) });
const logTaper = (min: number, max: number): Taper => ({
  toU: (v) => Math.log(Math.max(min, v) / min) / Math.log(max / min),
  toV: (u) => min * Math.pow(max / min, u),
});
/** Seconds with a quadratic taper (fine control of short times), 0..max. */
const timeTaper = (max: number): Taper => ({ toU: (v) => Math.sqrt(Math.max(0, v) / max), toV: (u) => max * u * u });

interface Control {
  readonly el: HTMLElement;
  sync(v: VoiceParams): void;
}

export interface SynthPanel {
  readonly el: HTMLElement;
  /** Where the Voice panel puts its type select (right of the section tabs). */
  readonly typeSlot: HTMLElement;
  sync(v: VoiceParams): void;
  /** Draw the visible picture (frame loop). */
  frame(v: VoiceParams): void;
  markDirty(): void;
}

export function buildSynthPanel(model: AppModel, bridge: AudioBridge, ui: UiState): SynthPanel {
  let voice: VoiceParams | null = null;
  const set = (patch: VoicePatch) => {
    if (voice) model.updateVoice(voice.id, patch);
  };
  const commit = () => model.endGesture();
  let page: SynthPage = ui.pref<SynthPage>('synthPage', 'osc', (x) => PAGES.some(([p]) => p === x));
  let osc: 'a' | 'b' = ui.pref<'a' | 'b'>('synthOsc', 'a', (x) => x === 'a' || x === 'b');
  let envPage: EnvPage = ui.pref<EnvPage>('synthEnv', 'amp', (x) => x === 'amp' || x === 'filter' || x === 'pitch');
  let dirty = true;

  // ---- building blocks ----

  /** Compact row: label · range · value. */
  const row = (
    id: string,
    label: string,
    get: (v: VoiceParams) => number,
    put: (x: number) => VoicePatch,
    taper: Taper,
    fmt: (x: number) => string,
    o: { step?: number; title?: string; snap?: (x: number) => number } = {},
  ): Control & { input: HTMLInputElement } => {
    const step = o.step ?? 0.001;
    const input = h('input', { type: 'range', id, min: 0, max: 1, step, value: 0, 'aria-label': label });
    const val = h('span', { class: 'crow-val' });
    const snap = o.snap ?? ((x: number) => x);
    input.addEventListener('input', () => {
      const x = snap(taper.toV(Number(input.value)));
      val.textContent = fmt(x);
      set(put(x));
    });
    input.addEventListener('change', commit);
    const el = h('div', { class: 'crow', title: o.title ?? '' }, h('label', { for: id }, label), input, val);
    return {
      el,
      input,
      sync(v) {
        const x = get(v);
        const u = Math.max(0, Math.min(1, taper.toU(x)));
        if (document.activeElement !== input || Math.abs(Number(input.value) - u) > step) input.value = String(u);
        val.textContent = fmt(x);
      },
    };
  };
  /** Integer row (raw input values, e.g. window slots, semitones). */
  const intRow = (
    id: string,
    label: string,
    get: (v: VoiceParams) => number,
    put: (x: number) => VoicePatch,
    range: (v: VoiceParams) => [number, number],
    fmt: (x: number) => string,
  ): Control => {
    const input = h('input', { type: 'range', id, min: 0, max: 1, step: 1, value: 0, 'aria-label': label });
    const val = h('span', { class: 'crow-val' });
    input.addEventListener('input', () => {
      const x = Number(input.value);
      val.textContent = fmt(x);
      set(put(x));
    });
    input.addEventListener('change', commit);
    const el = h('div', { class: 'crow' }, h('label', { for: id }, label), input, val);
    return {
      el,
      sync(v) {
        const [a, b] = range(v);
        input.min = String(a);
        input.max = String(b);
        const x = get(v);
        if (document.activeElement !== input || Number(input.value) !== x) input.value = String(x);
        val.textContent = fmt(x);
      },
    };
  };
  /** Segmented choice. */
  const seg = <T extends string | number>(
    id: string,
    label: string,
    options: readonly (readonly [T, string])[],
    get: (v: VoiceParams) => T,
    put: (x: T) => VoicePatch | null,
    cls = '',
  ): Control => {
    const btns = options.map(([value, text]) =>
      h(
        'button',
        {
          id: `${id}-${value}`,
          'data-value': String(value),
          onclick: () => {
            const p = put(value);
            if (p) set(p);
            commit();
          },
        },
        text,
      ),
    );
    const el = h('div', { class: `seg syn-seg ${cls}`, role: 'group', id, 'aria-label': label }, ...btns);
    return {
      el,
      sync(v) {
        const cur = get(v);
        options.forEach(([value], i) => {
          btns[i].classList.toggle('seg-on', value === cur);
          btns[i].setAttribute('aria-pressed', String(value === cur));
        });
      },
    };
  };
  const check = (id: string, label: string, get: (v: VoiceParams) => boolean, put: (x: boolean) => VoicePatch, title = ''): Control => {
    const input = h('input', { type: 'checkbox', id });
    input.addEventListener('change', () => {
      set(put(input.checked));
      commit();
    });
    const el = h('label', { class: 'syn-check', title }, input, label);
    return { el, sync: (v) => void (input.checked = get(v)) };
  };
  /** Paired X / Y row (2D / Rows windows and positions): label · X · Y · value. */
  const pair = (
    id: string,
    label: string,
    get: (v: VoiceParams) => [number, number],
    put: (x: number, y: number) => VoicePatch,
    max: (v: VoiceParams) => [number, number],
    step: number,
    fmt: (x: number, y: number) => string,
  ): Control & { x: HTMLInputElement } => {
    const val = h('span', { class: 'crow-val' });
    const mk = (axis: string) => h('input', { type: 'range', id: `${id}${axis.toLowerCase()}`, min: 0, max: 1, step, value: 0, 'aria-label': `${label} ${axis}` });
    const x = mk('X');
    const y = mk('Y');
    const onInput = () => {
      val.textContent = fmt(Number(x.value), Number(y.value));
      set(put(Number(x.value), Number(y.value)));
    };
    for (const i of [x, y]) {
      i.addEventListener('input', onInput);
      i.addEventListener('change', commit);
    }
    const el = h('div', { class: 'crow crow2' }, h('span', {}, label), x, y, val);
    return {
      el,
      x,
      sync(v) {
        const [mx, my] = max(v);
        x.max = String(Math.max(0, mx));
        y.max = String(Math.max(0, my));
        const [vx, vy] = get(v);
        if (document.activeElement !== x || Number(x.value) !== vx) x.value = String(vx);
        if (document.activeElement !== y || Number(y.value) !== vy) y.value = String(vy);
        val.textContent = fmt(vx, vy);
      },
    };
  };
  /** A row with a label and arbitrary content (segments). */
  const lineRow = (label: string, ...content: HTMLElement[]) => h('div', { class: 'crow crow-line' }, h('span', {}, label), h('div', { class: 'crow-line-c' }, ...content));

  // ---- page tabs ----
  const tabBtns = PAGES.map(([p, label]) =>
    h(
      'button',
      {
        role: 'tab',
        id: `syn-tab-${p}`,
        class: 'syn-tab',
        'aria-controls': `syn-page-${p}`,
        onclick: () => {
          page = p;
          ui.setPref('synthPage', p);
          sync();
        },
      },
      label,
    ),
  );
  const tabs = h('div', { class: 'syn-tabs', role: 'tablist', 'aria-label': 'Synth voice sections' }, ...tabBtns);

  // ---- Osc page ----
  const src = (v: VoiceParams): OscSource => (osc === 'b' ? v.synth.b : v);
  const putSrc = (patch: Partial<OscSource>): VoicePatch => (osc === 'b' ? { synth: { b: { ...voice!.synth.b, ...patch } } } : patch);
  const k = (name: 'Oct' | 'Coarse' | 'Fine' | 'Level') => `${osc}${name}` as 'aOct' | 'aCoarse' | 'aFine' | 'aLevel';
  const oscSel = seg<'a' | 'b'>(
    'syn-osc',
    'Oscillator',
    [
      ['a', 'A'],
      ['b', 'B'],
    ],
    () => osc,
    (x) => {
      osc = x;
      ui.setPref('synthOsc', x);
      sync();
      return null;
    },
  );
  const wtSel = h('select', { id: 'syn-wavetable', 'aria-label': 'Oscillator wavetable' });
  wtSel.addEventListener('change', () => {
    set(putSrc({ wavetableId: Number(wtSel.value) }));
    commit();
  });
  let wtSig = '';
  const fillWt = () => {
    const sig = model.wavetables.map((w) => `${w.id}:${w.name}:${shapeLabel(w)}`).join('|');
    if (sig === wtSig) return;
    wtSig = sig;
    wtSel.replaceChildren(...model.wavetables.map((w) => h('option', { value: String(w.id) }, `${w.name} · ${shapeLabel(w)}`)));
  };
  const octRow = intRow('syn-oct', 'Octave', (v) => v.synth[k('Oct')], (x) => ({ synth: { [k('Oct')]: x } }), () => [-3, 3], (x) => signed(x));
  const coarseRow = intRow('syn-coarse', 'Coarse', (v) => v.synth[k('Coarse')], (x) => ({ synth: { [k('Coarse')]: x } }), () => [-24, 24], (x) => signed(x, 0, ' st'));
  const fineRow = row('syn-fine', 'Fine', (v) => v.synth[k('Fine')], (x) => ({ synth: { [k('Fine')]: x } }), linear(-100, 100), (x) => signed(x, 0, ' ct'), { snap: Math.round });
  const levelRow = row('syn-level', 'Level', (v) => v.synth[k('Level')], (x) => ({ synth: { [k('Level')]: x } }), linear(0, 1), pct);
  const dims = (v: VoiceParams) => {
    const wt = model.wavetable(src(v).wavetableId);
    const W = wt && wt.shape !== 'rows' ? Math.max(1, wt.rows[0]?.length ?? 1) : 1;
    const H = wt && wt.shape !== '1d' ? Math.max(1, wt.rows.length) : 1;
    return { wt, W, H };
  };
  // 1D: window from / to and position, one slider each. 2D / Rows: X · Y pairs (Rows: X spans every row).
  const ws = intRow('syn-wx0', 'From', (v) => src(v).windowStart, (x) => putSrc({ windowStart: x }), (v) => [0, dims(v).W - 1], (x) => `#${x + 1}`);
  const we = intRow('syn-wx1', 'To', (v) => src(v).windowEnd, (x) => putSrc({ windowEnd: x }), (v) => [0, dims(v).W - 1], (x) => `#${x + 1}`);
  const px = row('syn-pos', 'Position', (v) => src(v).position, (x) => putSrc({ position: x }), linear(0, 1), pct);
  const pairFrom = pair('syn-w0', 'From', (v) => [src(v).windowStart, src(v).windowStartY], (x, y) => putSrc({ windowStart: x, windowStartY: y }), (v) => [dims(v).W - 1, dims(v).H - 1], 1, (x, y) => `${x + 1}, ${y + 1}`);
  const pairTo = pair('syn-w1', 'To', (v) => [src(v).windowEnd, src(v).windowEndY], (x, y) => putSrc({ windowEnd: x, windowEndY: y }), (v) => [dims(v).W - 1, dims(v).H - 1], 1, (x, y) => `${x + 1}, ${y + 1}`);
  const pairPos = pair('syn-p', 'Position', (v) => [src(v).position, src(v).positionY], (x, y) => putSrc({ position: x, positionY: y }), () => [1, 1], 0.001, (x, y) => `${x.toFixed(2)}, ${y.toFixed(2)}`);
  const oscRows = h('div', { class: 'crows' }, octRow.el, coarseRow.el, fineRow.el, levelRow.el, ws.el, we.el, px.el, pairFrom.el, pairTo.el, pairPos.el);
  const pad = createVoicePad(model, bridge, 'syn-pad');
  const scope = h('canvas', { id: 'syn-scope', role: 'img', 'aria-label': 'Now playing: waveform (spectrum behind)' });
  const scopeLabel = h('span', { class: 'plot-tag', id: 'syn-now' });
  const visOsc = h('div', { class: 'plot-box syn-vis' }, pad.canvas, scope, scopeLabel);
  watchVisibility(pad.canvas);
  watchVisibility(scope);
  const pageOsc = h(
    'div',
    { class: 'syn-page', id: 'syn-page-osc', role: 'tabpanel' },
    h('div', { class: 'syn-ctrl' }, h('div', { class: 'syn-head' }, oscSel.el, wtSel), oscRows),
    visOsc,
  );

  // ---- Mix page ----
  const sw = (key: keyof SynthParams) => (x: number) => ({ synth: { [key]: x } }) as VoicePatch;
  const mixA = row('syn-mix-a', 'Osc A', (v) => v.synth.aLevel, sw('aLevel'), linear(0, 1), pct);
  const mixB = row('syn-mix-b', 'Osc B', (v) => v.synth.bLevel, sw('bLevel'), linear(0, 1), pct);
  const mixSub = row('syn-mix-sub', 'Sub', (v) => v.synth.subLevel, sw('subLevel'), linear(0, 1), pct);
  const subWave = seg('syn-sub-wave', 'Sub waveform', [['sine', 'Sine'], ['square', 'Square']] as const, (v) => v.synth.subWave, (x) => ({ synth: { subWave: x } }));
  const subOct = seg('syn-sub-oct', 'Sub octave', [[1, '−1'], [2, '−2']] as const, (v) => v.synth.subOct, (x) => ({ synth: { subOct: x } }));
  const mixNoise = row('syn-mix-noise', 'Noise', (v) => v.synth.noiseLevel, sw('noiseLevel'), linear(0, 1), pct);
  const noiseType = seg('syn-noise-type', 'Noise colour', [['white', 'White'], ['pink', 'Pink']] as const, (v) => v.synth.noiseType, (x) => ({ synth: { noiseType: x } }));
  const mixRing = row('syn-mix-ring', 'Ring A×B', (v) => v.synth.ringLevel, sw('ringLevel'), linear(0, 1), pct);
  const glide = row('syn-glide', 'Glide', (v) => v.synth.glide, sw('glide'), timeTaper(2), (x) => (x < 0.002 ? 'off' : secs(x)));
  const legato = check('syn-legato', 'Legato only', (v) => v.synth.glideLegato, (x) => ({ synth: { glideLegato: x } }), 'Glide only between overlapping notes');
  const bend = intRow('syn-bend', 'Bend', (v) => v.synth.bendRange, sw('bendRange'), () => [0, 24], (x) => `±${x} st`);
  const pan = row('syn-pan', 'Pan', (v) => v.synth.pan, sw('pan'), linear(-1, 1), (x) => (Math.abs(x) < 0.01 ? 'C' : `${x < 0 ? 'L' : 'R'} ${Math.round(Math.abs(x) * 100)}`));
  const outLevel = row('syn-out', 'Output', (v) => v.level, (x) => ({ level: x }), linear(0, 1), pct);
  const oct = intRow('syn-voice-oct', 'Octave', (v) => v.octave, (x) => ({ octave: x }), () => [-2, 2], (x) => signed(x));
  const pageMix = h(
    'div',
    { class: 'syn-page syn-page-2col', id: 'syn-page-mix', role: 'tabpanel' },
    h('div', { class: 'crows' }, mixA.el, mixB.el, mixSub.el, lineRow('', subWave.el, subOct.el), mixNoise.el, lineRow('', noiseType.el), mixRing.el),
    h('div', { class: 'crows' }, outLevel.el, pan.el, oct.el, glide.el, lineRow('', legato.el), bend.el),
  );

  // ---- Filter page ----
  const mode = seg<FilterMode>('syn-filter-mode', 'Filter mode', FILTER_MODES.map((m) => [m, FILTER_MODE_LABELS[m]] as const), (v) => v.synth.filterMode, (x) => ({ synth: { filterMode: x } }), 'syn-modes');
  const cutoff = row('syn-cutoff', 'Cutoff', (v) => v.synth.cutoff, sw('cutoff'), logTaper(CUTOFF_MIN, CUTOFF_MAX), hz);
  const res = row('syn-res', 'Resonance', (v) => v.synth.resonance, sw('resonance'), linear(0, 1), pct);
  const drive = row('syn-drive', 'Drive', (v) => v.synth.drive, sw('drive'), linear(0, 1), pct);
  const keyTrack = row('syn-keytrack', 'Key track', (v) => v.synth.keyTrack, sw('keyTrack'), linear(0, 1), pct);
  const envAmt = row('syn-env-amt', 'Env amt',
 (v) => v.synth.envAmount, sw('envAmount'), linear(-1, 1), (x) => signed(x * FILTER_ENV_OCTAVES, 1, ' oct'));
  const velAmt = row('syn-vel-amt', 'Velocity', (v) => v.synth.velAmount, sw('velAmount'), linear(0, 1), pct, { title: 'Softer notes close the filter' });
  const resp = h('canvas', { id: 'syn-response', role: 'img', 'aria-label': 'Filter response' });
  const respLabel = h('span', { class: 'plot-tag', id: 'syn-response-label' });
  const visFilter = h('div', { class: 'plot-box syn-vis' }, resp, respLabel);
  watchVisibility(resp);
  const pageFilter = h(
    'div',
    { class: 'syn-page', id: 'syn-page-filter', role: 'tabpanel' },
    h('div', { class: 'syn-ctrl' }, h('div', { class: 'syn-head' }, mode.el), h('div', { class: 'crows' }, cutoff.el, res.el, drive.el, keyTrack.el, envAmt.el, velAmt.el)),
    visFilter,
  );

  // ---- Env page ----
  const envSel = seg<EnvPage>(
    'syn-env-sel',
    'Envelope',
    [
      ['amp', 'Amp'],
      ['filter', 'Filter'],
      ['pitch', 'Pitch'],
    ],
    () => envPage,
    (x) => {
      envPage = x;
      ui.setPref('synthEnv', x);
      sync();
      return null;
    },

  );
  const T = timeTaper(4);
  const ampRows = [
    row('syn-amp-a', 'Attack', (v) => v.attack, (x) => ({ attack: Math.max(0.001, x) }), timeTaper(2), secs),
    row('syn-amp-d', 'Decay', (v) => v.decay, (x) => ({ decay: Math.max(0.001, x) }), T, secs),
    row('syn-amp-s', 'Sustain', (v) => v.sustain, (x) => ({ sustain: x }), linear(0, 1), pct),
    row('syn-amp-r', 'Release', (v) => v.release, (x) => ({ release: Math.max(0.001, x) }), T, secs),
    row('syn-vel-amp', 'Velocity', (v) => v.synth.velAmp, sw('velAmp'), linear(0, 1), pct, { title: 'How much velocity sets the level' }),
  ];
  const fRows = [
    row('syn-f-a', 'Attack', (v) => v.synth.fAttack, sw('fAttack'), timeTaper(2), secs),
    row('syn-f-d', 'Decay', (v) => v.synth.fDecay, sw('fDecay'), T, secs),
    row('syn-f-s', 'Sustain', (v) => v.synth.fSustain, sw('fSustain'), linear(0, 1), pct),
    row('syn-f-r', 'Release', (v) => v.synth.fRelease, sw('fRelease'), T, secs),
    envAmt,
  ];
  const envAmt2 = row('syn-f-amt', 'Amount', (v) => v.synth.envAmount, sw('envAmount'), linear(-1, 1), (x) => signed(x * FILTER_ENV_OCTAVES, 1, ' oct'));
  fRows[4] = envAmt2;
  const pTarget = seg('syn-p-target', 'Pitch envelope target', [['a', 'A'], ['b', 'B'], ['ab', 'A+B']] as const, (v) => v.synth.pTarget, (x) => ({ synth: { pTarget: x } }));
  const pRows = [
    row('syn-p-a', 'Attack', (v) => v.synth.pAttack, sw('pAttack'), timeTaper(2), secs),
    row('syn-p-d', 'Decay', (v) => v.synth.pDecay, sw('pDecay'), T, secs),
    row('syn-p-amt', 'Amount', (v) => v.synth.pAmount, sw('pAmount'), linear(-24, 24), (x) => signed(x, 1, ' st'), { snap: (x) => Math.round(x * 10) / 10 }),
  ];
  const ampBox = h('div', { class: 'crows', id: 'syn-env-amp' }, ...ampRows.map((r) => r.el));
  const fBox = h('div', { class: 'crows', id: 'syn-env-filter' }, ...fRows.map((r) => r.el));
  const pBox = h('div', { class: 'crows', id: 'syn-env-pitch' }, ...pRows.map((r) => r.el), lineRow('Target', pTarget.el));
  const envCanvas = h('canvas', { id: 'syn-env', role: 'img', 'aria-label': 'Envelope' });
  const envLabel = h('span', { class: 'plot-tag', id: 'syn-env-label' });
  const visEnv = h('div', { class: 'plot-box syn-vis' }, envCanvas, envLabel);
  watchVisibility(envCanvas);
  const pageEnv = h('div', { class: 'syn-page', id: 'syn-page-env', role: 'tabpanel' }, h('div', { class: 'syn-ctrl' }, h('div', { class: 'syn-head' }, envSel.el), ampBox, fBox, pBox), visEnv);

  const pages: Record<SynthPage, HTMLElement> = { osc: pageOsc, mix: pageMix, filter: pageFilter, env: pageEnv };
  const typeSlot = h('span', { class: 'voice-type-slot' });
  const el = h(
    'div',
    { class: 'syn-body', id: 'synth-panel' },
    h('div', { class: 'syn-top' }, tabs, h('span', { class: 'grow' }), typeSlot),
    pageOsc,
    pageMix,
    pageFilter,
    pageEnv,
  );

  const controls: Control[] = [
    oscSel,
    octRow,
    coarseRow,
    fineRow,
    levelRow,
    ws,
    we,
    px,
    pairFrom,
    pairTo,
    pairPos,
    mixA,
    mixB,
    mixSub,
    subWave,
    subOct,
    mixNoise,
    noiseType,
    mixRing,
    glide,
    legato,
    bend,
    pan,
    outLevel,
    oct,
    mode,
    cutoff,
    res,
    drive,
    keyTrack,
    envAmt,
    velAmt,
    envSel,
    ...ampRows,
    ...fRows,
    pTarget,
    ...pRows,
  ];

  const sync = () => {
    const v = voice;
    if (!v) return;
    tabBtns.forEach((b, i) => {
      const on = PAGES[i][0] === page;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    for (const [p, node] of Object.entries(pages)) node.hidden = p !== page;
    fillWt();
    const s = src(v);
    wtSel.value = String(s.wavetableId);
    const { wt } = dims(v);
    const shape = wt?.shape ?? '1d';
    // 1D: X window + position; 2D: X / Y windows and positions; Rows: Y window + X / Y positions.
    ws.el.hidden = we.el.hidden = px.el.hidden = shape !== '1d';
    pairFrom.el.hidden = pairTo.el.hidden = pairPos.el.hidden = shape === '1d';
    // Rows: X spans each whole row (positions align proportionally), so no X window.
    pairFrom.x.disabled = pairTo.x.disabled = shape === 'rows';
    pad.canvas.hidden = shape === '1d';
    scope.hidden = shape !== '1d';
    pageOsc.dataset.shape = shape;
    ampBox.hidden = envPage !== 'amp';
    fBox.hidden = envPage !== 'filter';
    pBox.hidden = envPage !== 'pitch';
    for (const c of controls) c.sync(v);
    dirty = true;
  };

  // ---- pictures ----
  const mix = new Mix();
  let scopeKey = '';
  let scopeData: Float32Array | null = null;
  const drawOsc = (v: VoiceParams) => {
    const s = src(v);
    const wt = model.wavetable(s.wavetableId);
    if (!wt) return;
    const color = cssColor(voiceColorVar(v.id - 1));
    const hh = Math.max(40, visOsc.clientHeight || 110);
    if (wt.shape !== '1d') {
      pad.draw(oscView(v, osc), wt, hh, { pos: oscPositions(model, bridge, v, osc), mix: (out) => oscMix(model, bridge, v, osc, out) });
      scopeLabel.textContent = `Osc ${osc.toUpperCase()}`;
      return;
    }
    const m = oscMix(model, bridge, v, osc, mix);
    let key = `${osc}|`;
    for (let i = 0; i < m.n; i++) key += `${m.ids[i]}:${m.w[i].toFixed(3)} `;
    if (key !== scopeKey) {
      scopeKey = key;
      scopeData = null;
      if (m.n === 1) scopeData = model.table(m.ids[0])?.data ?? null;
      else if (m.n > 1) {
        const out = new Float32Array(TABLE_SIZE);
        for (let i = 0; i < m.n; i++) {
          const t = model.table(m.ids[i]);
          if (!t) continue;
          for (let j = 0; j < TABLE_SIZE; j++) out[j] += m.w[i] * t.data[j];
        }
        scopeData = out;
      }
    }
    scopeLabel.textContent = m.n ? `Osc ${osc.toUpperCase()} · #${wt.interp === 'step' ? m.x + 1 : (m.x + 1).toFixed(1)}` : `Osc ${osc.toUpperCase()}`;
    const [g, w, H] = fit(scope, hh);
    if (!scopeData) return;
    g.save();
    g.globalAlpha = 0.3;
    drawSpectrum(g, w, H, scopeData, color);
    g.restore();
    drawWave(g, 0, 0, w, H, scopeData, color, { axis: cssColor('--border'), lineWidth: 1.75 });
  };

  const drawResponse = (v: VoiceParams) => {
    const s = v.synth;
    const [g, w, H] = fit(resp, Math.max(40, visFilter.clientHeight || 110));
    const color = cssColor(voiceColorVar(v.id - 1));
    const sr = bridge.sampleRate;
    const fx = (f: number) => (Math.log(f / 20) / Math.log(1000)) * w;
    const top = 6;
    const dbTop = 24;
    const dbBot = -48;
    const fy = (db: number) => top + ((dbTop - Math.max(dbBot, Math.min(dbTop, db))) / (dbTop - dbBot)) * (H - top - 4);
    g.strokeStyle = cssColor('--border');
    g.lineWidth = 1;
    g.beginPath();
    for (const f of [100, 1000, 10000]) {
      g.moveTo(fx(f) + 0.5, 0);
      g.lineTo(fx(f) + 0.5, H);
    }
    g.moveTo(0, fy(0) + 0.5);
    g.lineTo(w, fy(0) + 0.5);
    g.stroke();
    const curve = (fc: number, alpha: number, dash: number[]) => {
      g.save();
      g.globalAlpha = alpha;
      g.setLineDash(dash);
      g.strokeStyle = color;
      g.lineWidth = 1.75;
      g.beginPath();
      for (let i = 0; i <= w; i += 2) {
        const f = 20 * Math.pow(1000, i / w);
        const db = 20 * Math.log10(filterResponse(s.filterMode, fc, s.resonance, f, sr) + 1e-9);
        if (i) g.lineTo(i, fy(db));
        else g.moveTo(i, fy(db));
      }
      g.stroke();
      g.restore();
    };
    // Where the envelope takes the cutoff at its peak (dashed), then the cutoff itself.
    if (s.envAmount !== 0) curve(Math.min(CUTOFF_MAX, s.cutoff * Math.pow(2, s.envAmount * FILTER_ENV_OCTAVES)), 0.45, [3, 3]);
    curve(s.cutoff, 1, []);
    respLabel.textContent = `${FILTER_MODE_LABELS[s.filterMode]} · ${hz(s.cutoff)}`;
  };

  const drawEnv = (v: VoiceParams) => {
    const s = v.synth;
    const [g, w, H] = fit(envCanvas, Math.max(40, visEnv.clientHeight || 110));
    const color = cssColor(voiceColorVar(v.id - 1));
    let a: number;
    let d: number;
    let sus: number;
    let r: number;
    let label: string;
    if (envPage === 'amp') {
      [a, d, sus, r] = [v.attack, v.decay, v.sustain, v.release];
      label = `A ${secs(a)} · D ${secs(d)} · S ${pct(sus)} · R ${secs(r)}`;
    } else if (envPage === 'filter') {
      [a, d, sus, r] = [s.fAttack, s.fDecay, s.fSustain, s.fRelease];
      label = `A ${secs(a)} · D ${secs(d)} · S ${pct(sus)} · R ${secs(r)}`;
    } else {
      [a, d, sus, r] = [s.pAttack, s.pDecay, 0, 0];
      label = `${signed(s.pAmount, 1, ' st')} · A ${secs(a)} · D ${secs(d)}`;
    }
    const pad = 4;
    const top = 16;
    const bottom = H - pad;
    const sa = Math.sqrt(a);
    const sd = Math.sqrt(d);
    const sr = Math.sqrt(r);
    const hold = envPage === 'pitch' ? 0.05 : (sa + sd + sr) * 0.35 + 0.05;
    const kx = (w - 2 * pad) / (sa + sd + hold + sr || 1);
    const ys = bottom - (bottom - top) * sus;
    const x1 = pad + sa * kx;
    const x2 = x1 + sd * kx;
    const x3 = x2 + hold * kx;
    const x4 = x3 + sr * kx;
    g.beginPath();
    g.moveTo(pad, bottom);
    g.lineTo(x1, top);
    g.lineTo(x2, ys);
    g.lineTo(x3, ys);
    g.lineTo(x4, bottom);
    g.save();
    g.globalAlpha = 0.16;
    g.fillStyle = color;
    g.fill();
    g.restore();
    g.strokeStyle = color;
    g.lineWidth = 1.75;
    g.lineJoin = 'round';
    g.stroke();
    envLabel.textContent = label;
  };

  onThemeChange(() => (dirty = true));
  new ResizeObserver(() => (dirty = true)).observe(el);

  return {
    el,
    typeSlot,
    sync(v) {

      voice = v;
      el.style.setProperty('--vc', `var(${voiceColorVar(v.id - 1)})`);
      sync();
    },
    markDirty() {
      dirty = true;
    },
    frame(v) {
      voice = v;
      if (page === 'osc') {
        const canvas = pad.canvas.hidden ? scope : pad.canvas;
        if (isOnScreen(canvas) && (dirty || model.playing)) {
          dirty = false;
          drawOsc(v);
        }
      } else if (page === 'filter') {
        if (dirty && isOnScreen(resp)) {
          dirty = false;
          drawResponse(v);
        }
      } else if (page === 'env') {
        if (dirty && isOnScreen(envCanvas)) {
          dirty = false;
          drawEnv(v);
        }
      }
    },
  };
}
