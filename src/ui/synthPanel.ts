/**
 * The Voice panel's body for a Synth voice: compact pages (Osc · Mix · Filter · Env · Mod) in
 * the panel's usual footprint, or — when the panel has room (e.g. the Sequence panel
 * collapsed on a laptop screen) — every control at once (synthFull.ts): the choice is made
 * from the panel's size (a ResizeObserver), not the viewport. Each page is a column of compact rows (label · slider · value)
 * plus, where it helps, a picture on the right: the oscillator's X/Y pad or "now playing"
 * scope, the filter's response curve, the selected envelope. Every edit goes through
 * AppModel.updateVoice (undoable on a Synth voice; a slider drag is one step).
 */
import type { AppModel } from '../app/model';
import type { AudioBridge } from '../audio/bridge';
import { filterResponse } from '../core/engine/svf';
import {
  CUTOFF_MAX,
  CUTOFF_MIN,
  FILTER_ENV_OCTAVES,
  FILTER_MODE_LABELS,
  FILTER_MODES,
  FILTER_SPREAD_OCTAVES,
  type FilterMode,
  type OscSource,
  type SynthParams,
} from '../core/synth';
import {
  EMPTY_SLOT,
  isPeriodicShape,
  LFO_DIVS,
  LFO_RATE_MAX_HZ,
  LFO_RATE_MIN_HZ,
  LFO_SHAPE_LABELS,
  LFO_SHAPES,
  MOD_DEST_LABELS,
  MOD_DESTS,
  MOD_SLOTS,
  MOD_SOURCE_LABELS,
  MOD_SOURCES,
  type LfoDiv,
  type LfoParams,
  type LfoShape,
  type ModDest,
  type ModEnvMode,
  type ModSlot,
  type ModSource,
} from '../core/modulation';
import type { VoicePatch, VoiceParams } from '../core/voice';

import { shapeLabel } from '../core/wavetable';
import { cssColor, fit, onThemeChange } from './canvas';
import { isOnScreen, watchVisibility, type UiState } from './context';
import { h, isNarrowShell, voiceColorVar } from './dom';
import { linear, type Taper } from './knob';
import { buildPresetControls } from './presets';
import { buildSynthFull, hz, logTaper, oscDrawer, panText, pct, secs, signed, timeTaper } from './synthFull';
import { createVoicePad } from './voicePad';

export type SynthPage = 'osc' | 'mix' | 'filter' | 'env' | 'mod';
const PAGES: readonly [SynthPage, string][] = [
  ['osc', 'Osc'],
  ['mix', 'Mix'],
  ['filter', 'Filter'],
  ['env', 'Env'],
  ['mod', 'Mod'],
];
type EnvPage = 'amp' | 'filter' | 'pitch';
/** What the Mod page's left column edits: an LFO (0..2) or the mod envelope. */
type ModEdit = 0 | 1 | 2 | 'env';

/** Full view densities: values under the knobs, or (dense) only while hovered / focused / dragged. */
type Density = 'roomy' | 'dense';
/** Below this panel size the full view isn't tried (the pages fit anywhere). */
const FULL_MIN_W = 860;
const FULL_MIN_H = 180;
/** Full view cell heights per density, a group's header + padding, and the most rows used. */
const CELL_H: Record<Density, number> = { roomy: 46, dense: 35 };
const FULL_CHROME_H = 24;
const FULL_MAX_ROWS = 9;

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
  /** 'full' when every control shows at once (no page tabs). */
  readonly view: 'pages' | 'full';
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
  let modEdit: ModEdit = ui.pref<ModEdit>('synthMod', 0, (x) => x === 0 || x === 1 || x === 2 || x === 'env');
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
  /** A <select> bound to a value. */
  const select = <T extends string>(id: string, label: string, options: readonly (readonly [T, string])[], get: (v: VoiceParams) => T, put: (x: T) => VoicePatch): Control & { el: HTMLSelectElement } => {
    const el = h('select', { id, 'aria-label': label }, ...options.map(([value, text]) => h('option', { value }, text)));
    el.addEventListener('change', () => {
      set(put(el.value as T));
      commit();
    });
    return { el, sync: (v) => void (el.value = get(v)) };
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
    o: { min?: [number, number]; ids?: [string, string]; labels?: [string, string] } = {},
  ): Control & { x: HTMLInputElement } => {
    const val = h('span', { class: 'crow-val' });
    const mk = (axis: string, i: number) =>
      h('input', { type: 'range', id: o.ids?.[i] ?? `${id}${axis.toLowerCase()}`, min: o.min?.[i] ?? 0, max: 1, step, value: 0, 'aria-label': o.labels?.[i] ?? `${label} ${axis}` });
    const x = mk('X', 0);
    const y = mk('Y', 1);
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
  /** Three sliders on one row, each with its own range [min, max, step]. */
  const trio = (
    id: string,
    label: string,
    get: (v: VoiceParams) => readonly [number, number, number],
    put: (x: readonly [number, number, number]) => VoicePatch,
    ranges: readonly (readonly [number, number, number])[],
    fmt: (x: readonly [number, number, number]) => string,
    o: { ids: readonly [string, string, string]; labels: readonly [string, string, string]; title?: string },
  ): Control => {
    const val = h('span', { class: 'crow-val' });
    const ins = ranges.map(([min, max, step], i) => h('input', { type: 'range', id: o.ids[i], min, max, step, value: 0, 'aria-label': o.labels[i] }));
    const read = () => [Number(ins[0].value), Number(ins[1].value), Number(ins[2].value)] as const;
    for (const i of ins) {
      i.addEventListener('input', () => {
        val.textContent = fmt(read());
        set(put(read()));
      });
      i.addEventListener('change', commit);
    }
    const el = h('div', { class: 'crow crow3', id, title: o.title ?? '' }, h('span', {}, label), ...ins, val);
    return {
      el,
      sync(v) {
        const x = get(v);
        ins.forEach((i, k) => {
          if (document.activeElement !== i || Number(i.value) !== x[k]) i.value = String(x[k]);
        });
        val.textContent = fmt(x);
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
  // Octave · coarse · fine on one row.
  const tuneRow = trio(
    'syn-tune',
    'Tune',
    (v) => [v.synth[k('Oct')], v.synth[k('Coarse')], v.synth[k('Fine')]],
    ([x, y, z]) => ({ synth: { [k('Oct')]: x, [k('Coarse')]: y, [k('Fine')]: z } }),
    [
      [-3, 3, 1],
      [-24, 24, 1],
      [-100, 100, 1],
    ],
    ([x, y, z]) => `${signed(x)} ${signed(y)} ${signed(z)}c`,
    { ids: ['syn-oct', 'syn-coarse', 'syn-fine'], labels: ['Octave', 'Coarse (semitones)', 'Fine (cents)'], title: 'Octave · semitones · cents' },
  );
  const sk = (name: 'Unison' | 'Detune' | 'Spread') => `${osc}${name}` as 'aUnison' | 'aDetune' | 'aSpread';
  const unison = seg<number>('syn-unison', 'Unison copies', [[1, '1'], [2, '2'], [3, '3'], [4, '4']] as const, (v) => v.synth[sk('Unison')], (x) => ({ synth: { [sk('Unison')]: x } }));
  const guardNote = h('span', { class: 'syn-guard', id: 'syn-unison-guard', hidden: true, title: 'Too many unison copies sound at once: the CPU guard plays fewer' }, 'CPU guard: reduced');
  const detuneSpread = pair(
    'syn-uni',
    'Detune',
    (v) => [v.synth[sk('Detune')], v.synth[sk('Spread')]],
    (x, y) => ({ synth: { [sk('Detune')]: x, [sk('Spread')]: y } }),
    () => [50, 1],
    0.01,
    (x, y) => `${Math.round(x)}ct ${Math.round(y * 100)}%`,
    { ids: ['syn-detune', 'syn-spread'], labels: ['Unison detune (cents)', 'Unison stereo spread'] },
  );
  const ok = (name: 'Pan' | 'PhaseSpread' | 'PosSpread') => `${osc}${name}` as 'aPan' | 'aPhaseSpread' | 'aPosSpread';
  // Level · stereo pan of the oscillator (before the filter).
  const levelRow = pair(
    'syn-level',
    'Level',
    (v) => [v.synth[k('Level')], v.synth[ok('Pan')]],
    (x, y) => ({ synth: { [k('Level')]: x, [ok('Pan')]: y } }),
    () => [1, 1],
    0.001,
    (x, y) => `${pct(x)} ${panText(y)}`,
    { min: [0, -1], ids: ['syn-level', 'syn-osc-pan'], labels: ['Level', 'Oscillator pan'] },
  );
  // Stereo phase (right channel ahead, 0..½ cycle) · stereo position spread.
  const stereoRow = pair(
    'syn-stereo',
    'Stereo',
    (v) => [v.synth[ok('PhaseSpread')], v.synth[ok('PosSpread')]],
    (x, y) => ({ synth: { [ok('PhaseSpread')]: x, [ok('PosSpread')]: y } }),
    () => [0.5, 1],
    0.001,
    (x, y) => `${Math.round(x * 360)}° ${pct(y)}`,
    { ids: ['syn-phase-spread', 'syn-pos-spread'], labels: ['Stereo phase (the right channel reads ahead)', 'Stereo position (left and right read the window apart)'] },
  );
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
  const oscRows = h(
    'div',
    { class: 'crows' },
    tuneRow.el,
    levelRow.el,
    lineRow('Unison', unison.el, guardNote),
    detuneSpread.el,
    stereoRow.el,
    ws.el,
    we.el,
    px.el,
    pairFrom.el,
    pairTo.el,
    pairPos.el,
  );
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
  const mixNoise = pair(
    'syn-mix-noise',
    'Noise',
    (v) => [v.synth.noiseLevel, v.synth.noiseWidth],
    (x, y) => ({ synth: { noiseLevel: x, noiseWidth: y } }),
    () => [1, 1],
    0.001,
    (x, y) => `${pct(x)} ↔${pct(y)}`,
    { ids: ['syn-mix-noise', 'syn-noise-width'], labels: ['Noise level', 'Noise stereo width'] },
  );
  const noiseType = seg('syn-noise-type', 'Noise colour', [['white', 'White'], ['pink', 'Pink']] as const, (v) => v.synth.noiseType, (x) => ({ synth: { noiseType: x } }));
  const mixRing = row('syn-mix-ring', 'Ring A×B', (v) => v.synth.ringLevel, sw('ringLevel'), linear(0, 1), pct);
  const glide = row('syn-glide', 'Glide', (v) => v.synth.glide, sw('glide'), timeTaper(2), (x) => (x < 0.002 ? 'off' : secs(x)));
  const legato = check('syn-legato', 'Legato only', (v) => v.synth.glideLegato, (x) => ({ synth: { glideLegato: x } }), 'Glide only between overlapping notes');
  const bend = intRow('syn-bend', 'Bend', (v) => v.synth.bendRange, sw('bendRange'), () => [0, 24], (x) => `±${x} st`);
  const pan = row('syn-pan', 'Pan', (v) => v.synth.pan, sw('pan'), linear(-1, 1), panText);
  const outLevel = row('syn-out', 'Output', (v) => v.level, (x) => ({ level: x }), linear(0, 1), pct);
  const oct = intRow('syn-voice-oct', 'Octave', (v) => v.octave, (x) => ({ octave: x }), () => [-2, 2], (x) => signed(x));
  const syncChk = check('syn-sync', 'Sync B', (v) => v.synth.sync, (x) => ({ synth: { sync: x } }), 'Hard sync: each cycle of osc B restarts osc A');
  const fmRow = row('syn-fm', 'FM B→A', (v) => v.synth.fm, sw('fm'), linear(0, 1), pct, { title: 'Osc B modulates osc A’s phase' });
  const width = row('syn-width', 'Width', (v) => v.synth.width, sw('width'), linear(0, 2), pct, { title: 'Stereo width (0 = mono)' });
  const pageMix = h(
    'div',
    { class: 'syn-page syn-page-2col', id: 'syn-page-mix', role: 'tabpanel' },
    h('div', { class: 'crows' }, mixA.el, mixB.el, mixSub.el, lineRow('', subWave.el, subOct.el), mixNoise.el, lineRow('', noiseType.el, syncChk.el), mixRing.el, fmRow.el),
    h('div', { class: 'crows' }, outLevel.el, pan.el, width.el, oct.el, glide.el, lineRow('', legato.el), bend.el),
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
  const fSpread = row('syn-filter-spread', 'Spread', (v) => v.synth.filterSpread, sw('filterSpread'), linear(-1, 1), (x) => signed((x * FILTER_SPREAD_OCTAVES) / 2, 1, ' oct'), {
    title: 'Stereo filter spread: the left cutoff moves down, the right up (± octaves per side)',
  });
  const satRow = row('syn-sat', 'Saturate', (v) => v.synth.sat, sw('sat'), linear(0, 1), pct, { title: 'Saturation after the filter' });
  const resp = h('canvas', { id: 'syn-response', role: 'img', 'aria-label': 'Filter response' });
  const respLabel = h('span', { class: 'plot-tag', id: 'syn-response-label' });
  const visFilter = h('div', { class: 'plot-box syn-vis' }, resp, respLabel);
  watchVisibility(resp);
  const pageFilter = h(
    'div',
    { class: 'syn-page', id: 'syn-page-filter', role: 'tabpanel' },
    h('div', { class: 'syn-ctrl' }, h('div', { class: 'syn-head' }, mode.el), h('div', { class: 'crows' }, cutoff.el, fSpread.el, res.el, drive.el, satRow.el, keyTrack.el, envAmt.el, velAmt.el)),
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

  // ---- Mod page: LFOs / mod envelope (left), the matrix (right) ----
  const modSel = seg<ModEdit>(
    'syn-mod-sel',
    'Edit',
    [
      [0, 'LFO 1'],
      [1, 'LFO 2'],
      [2, 'LFO 3'],
      ['env', 'Env'],
    ],
    () => modEdit,
    (x) => {
      modEdit = x;
      ui.setPref('synthMod', x);
      sync();
      return null;
    },
  );
  const lfoN = () => (modEdit === 'env' ? 0 : modEdit);
  const lfo = (v: VoiceParams) => v.synth.lfos[lfoN()];
  const putLfo = (patch: Partial<LfoParams>): VoicePatch => ({ synth: { lfos: voice!.synth.lfos.map((l, i) => (i === lfoN() ? { ...l, ...patch } : l)) } });
  const lfoShape = select<LfoShape>('syn-lfo-shape', 'LFO shape', LFO_SHAPES.map((s) => [s, LFO_SHAPE_LABELS[s]] as const), (v) => lfo(v).shape, (x) => putLfo({ shape: x }));
  const lfoRate = row('syn-lfo-rate', 'Rate', (v) => lfo(v).rate, (x) => putLfo({ rate: x }), logTaper(LFO_RATE_MIN_HZ, LFO_RATE_MAX_HZ), (x) => (x < 10 ? `${x.toFixed(2)} Hz` : `${x.toFixed(1)} Hz`));
  const lfoDiv = select<LfoDiv>('syn-lfo-div', 'LFO division', LFO_DIVS.map((d) => [d, d] as const), (v) => lfo(v).div, (x) => putLfo({ div: x }));
  const lfoSync = check('syn-lfo-sync', 'Sync', (v) => lfo(v).sync, (x) => putLfo({ sync: x }), 'Tempo sync: one cycle per division at the transport tempo');
  const lfoRetrig = check('syn-lfo-retrig', 'Retrig', (v) => lfo(v).retrig, (x) => putLfo({ retrig: x }), 'Restart at the start phase on every note (otherwise free-running)');
  const lfoDepth = row('syn-lfo-depth', 'Depth', (v) => lfo(v).depth, (x) => putLfo({ depth: x }), linear(0, 1), pct);
  const lfoFade = row('syn-lfo-fade', 'Fade in', (v) => lfo(v).fade, (x) => putLfo({ fade: x }), timeTaper(5), (x) => (x < 0.002 ? 'off' : secs(x)));
  const lfoPhase = row('syn-lfo-phase', 'Phase', (v) => lfo(v).phase, (x) => putLfo({ phase: x }), linear(0, 1), (x) => `${Math.round(x * 360)}°`);
  const lfoStereo = row('syn-lfo-stereo', 'Stereo', (v) => lfo(v).stereo, (x) => putLfo({ stereo: x }), linear(0, 0.5), (x) => `${Math.round(x * 360)}°`, {
    title: 'Stereo phase: the right channel’s LFO runs ahead (positions, levels, cutoff, amp); periodic shapes only',
  });
  const divRow = h('div', { class: 'crow crow-line' }, h('span', {}, 'Division'), h('div', { class: 'crow-line-c' }, lfoDiv.el));
  const lfoBox = h(
    'div',
    { class: 'crows', id: 'syn-lfo' },
    lineRow('Shape', lfoShape.el),
    lfoRate.el,
    divRow,
    lineRow('', lfoSync.el, lfoRetrig.el),
    lfoDepth.el,
    lfoFade.el,
    lfoPhase.el,
    lfoStereo.el,
  );
  const mMode = seg<ModEnvMode>('syn-menv-mode', 'Mod envelope mode', [['ad', 'AD'], ['adsr', 'ADSR']] as const, (v) => v.synth.mMode, (x) => ({ synth: { mMode: x } }));
  const mRows = [
    row('syn-m-a', 'Attack', (v) => v.synth.mAttack, sw('mAttack'), timeTaper(2), secs),
    row('syn-m-d', 'Decay', (v) => v.synth.mDecay, sw('mDecay'), T, secs),
    row('syn-m-s', 'Sustain', (v) => v.synth.mSustain, sw('mSustain'), linear(0, 1), pct),
    row('syn-m-r', 'Release', (v) => v.synth.mRelease, sw('mRelease'), T, secs),
  ];
  const menvBox = h('div', { class: 'crows', id: 'syn-menv' }, lineRow('Mode', mMode.el), ...mRows.map((r) => r.el));
  // Matrix: MOD_SLOTS rows of source → destination · amount.
  const slots = Array.from({ length: MOD_SLOTS }, (_, i) => {
    const slot = (v: VoiceParams) => v.synth.mods[i] ?? EMPTY_SLOT;
    const putSlot = (patch: Partial<ModSlot>): VoicePatch => ({ synth: { mods: voice!.synth.mods.map((m, j) => (j === i ? { ...m, ...patch } : m)) } });
    const src = select<ModSource | 'none'>(`syn-mod-src-${i}`, `Slot ${i + 1} source`, [['none', '—'], ...MOD_SOURCES.map((s) => [s, MOD_SOURCE_LABELS[s]] as const)], (v) => slot(v).src, (x) => putSlot({ src: x }));
    const dst = select<ModDest | 'none'>(`syn-mod-dst-${i}`, `Slot ${i + 1} destination`, [['none', '—'], ...MOD_DESTS.map((d) => [d, MOD_DEST_LABELS[d]] as const)], (v) => slot(v).dst, (x) => putSlot({ dst: x }));
    const amt = h('input', { type: 'range', id: `syn-mod-amt-${i}`, min: -1, max: 1, step: 0.005, value: 0, 'aria-label': `Slot ${i + 1} amount` });
    const val = h('span', { class: 'crow-val' });
    const fmt = (x: number) => signed(x * 100, 0);
    amt.addEventListener('input', () => {
      const x = Number(amt.value);
      val.textContent = fmt(x);
      set(putSlot({ amt: x }));
    });
    amt.addEventListener('change', commit);
    // Double-click: back to 0.
    amt.addEventListener('dblclick', () => {
      set(putSlot({ amt: 0 }));
      commit();
    });
    const el = h('div', { class: 'mod-slot' }, src.el, h('span', { class: 'mod-arrow', 'aria-hidden': 'true' }, '→'), dst.el, amt, val);
    return {
      el,
      sync(v: VoiceParams) {
        src.sync(v);
        dst.sync(v);
        const s = slot(v);
        if (document.activeElement !== amt || Number(amt.value) !== s.amt) amt.value = String(s.amt);
        val.textContent = fmt(s.amt);
        el.classList.toggle('mod-off', s.src === 'none' || s.dst === 'none' || s.amt === 0);
      },
    } as Control;
  });
  const matrix = h('div', { class: 'mod-matrix', id: 'syn-matrix', role: 'group', 'aria-label': 'Mod matrix' }, ...slots.map((s) => s.el));
  const pageMod = h(
    'div',
    { class: 'syn-page syn-page-mod', id: 'syn-page-mod', role: 'tabpanel' },
    h('div', { class: 'syn-ctrl' }, h('div', { class: 'syn-head' }, modSel.el), lfoBox, menvBox),
    matrix,
  );

  const pages: Record<SynthPage, HTMLElement> = { osc: pageOsc, mix: pageMix, filter: pageFilter, env: pageEnv, mod: pageMod };
  const typeSlot = h('span', { class: 'voice-type-slot' });
  const presets = buildPresetControls(model, () => voice ?? undefined, (msg) => model.setNotice(msg));
  const el = h(
    'div',
    { class: 'syn-body', id: 'synth-panel' },
    h('div', { class: 'syn-top' }, tabs, h('span', { class: 'grow' }), presets.pick, presets.menuBtn, presets.file, typeSlot),
    pageOsc,
    pageMix,
    pageFilter,
    pageEnv,
    pageMod,
  );

  const controls: Control[] = [
    oscSel,
    tuneRow,
    unison,
    detuneSpread,
    syncChk,
    fmRow,
    width,
    satRow,

    levelRow,
    stereoRow,
    fSpread,
    lfoStereo,
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
    modSel,
    lfoShape,
    lfoRate,
    lfoDiv,
    lfoSync,
    lfoRetrig,
    lfoDepth,
    lfoFade,
    lfoPhase,
    mMode,
    ...mRows,
    ...slots,
  ];

  const sync = () => {
    const v = voice;
    if (!v) return;
    const key = shapesOf(v);
    if (key !== shapeKey) {
      shapeKey = key;
      scheduleDecide(0);
    }
    // Shown again after a resize we couldn't measure (e.g. Sequence expanded while a Simple
    // voice was showing): decide now, before this view paints clipped.
    if (skipped && !el.hidden) decide();
    if (view === 'full') {
      full.sync(v);
      dirty = true;
      return;
    }
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
    lfoBox.hidden = modEdit === 'env';
    menvBox.hidden = modEdit !== 'env';
    const synced = lfo(v).sync;
    lfoRate.el.hidden = synced;
    lfoStereo.input.disabled = !isPeriodicShape(lfo(v).shape);
    divRow.hidden = !synced;
    mRows[2].el.hidden = mRows[3].el.hidden = v.synth.mMode === 'ad';
    ampBox.hidden = envPage !== 'amp';
    fBox.hidden = envPage !== 'filter';
    pBox.hidden = envPage !== 'pitch';
    for (const c of controls) c.sync(v);
    dirty = true;
  };

  // ---- pictures ----
  const drawOsc = oscDrawer(model, bridge, () => osc, pad, scope, scopeLabel, visOsc);

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

  // ---- full view (every control at once) ----
  const full = buildSynthFull(model, bridge, set, commit, () => voice);
  full.el.hidden = true;
  el.append(full.el);
  const top = el.querySelector('.syn-top') as HTMLElement;
  let view: 'pages' | 'full' = 'pages';
  el.dataset.view = view;
  let density: Density = 'roomy';
  /** Show the pages or the full view: the presets, type select and matrix move along. */
  const setView = (next: 'pages' | 'full', d: Density) => {
    density = d;
    el.dataset.density = d;
    full.el.classList.toggle('knobs-dense', d === 'dense');
    if (next === view) return;
    view = next;
    el.dataset.view = next;
    full.el.hidden = next !== 'full';
    if (next === 'full') {
      full.sideTop.append(presets.pick, presets.menuBtn, presets.file, typeSlot);
      full.side.append(matrix);
    } else {
      top.append(presets.pick, presets.menuBtn, presets.file, typeSlot);
      pageMod.append(matrix);
    }
    dirty = true;
    if (voice) sync();
  };
  /**
   * Decide between the pages and the full view from the space the panel body offers: try
   * the full view (roomy, then dense) and keep it only if nothing overflows. Layout reads
   * happen here only (after a resize settles, or the oscillators' shapes change).
   */
  const decide = () => {
    const host = el.parentElement;
    if (!voice || el.hidden || !host || host.clientHeight === 0) {
      // Not measurable now (a Simple voice shown, the panel collapsed): decide when shown again.
      skipped = true;
      return;
    }
    skipped = false;
    const cs = getComputedStyle(host);
    const w = host.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const hh = host.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (isNarrowShell() || w < FULL_MIN_W || hh < FULL_MIN_H) return setView('pages', density);
    const fits = (e: Element) => e.scrollWidth <= e.clientWidth + 1 && e.scrollHeight <= e.clientHeight + 1;
    for (const d of ['roomy', 'dense'] as const) {
      // As many rows of cells as the height allows (at least 5: the envelopes' columns).
      const rows = Math.min(FULL_MAX_ROWS, Math.floor((hh - FULL_CHROME_H) / CELL_H[d]));
      if (rows < 5) continue;
      full.el.style.setProperty('--rows', String(rows));
      full.el.style.setProperty('--cell-h', `${CELL_H[d]}px`);
      setView('full', d);
      if (fits(full.el) && [...full.el.children].every(fits) && fits(host)) return;
    }
    setView('pages', 'roomy');
  };
  let decideTimer: ReturnType<typeof setTimeout> | undefined;
  /** A decision was skipped while hidden: the next sync (shown again) decides at once. */
  let skipped = false;
  /** Decide once a resize (e.g. a panel collapsing: a short transition) has settled. */
  const scheduleDecide = (ms = 90) => {
    clearTimeout(decideTimer);
    decideTimer = setTimeout(decide, ms);
  };
  let shapeKey = '';
  const shapesOf = (v: VoiceParams) => `${v.id}|${model.wavetable(v.wavetableId)?.shape}|${model.wavetable(v.synth.b.wavetableId)?.shape}`;

  onThemeChange(() => (dirty = true));
  new ResizeObserver(() => (dirty = true)).observe(el);
  queueMicrotask(() => {
    // The panel body: its size comes from the shell layout, never from this content.
    if (el.parentElement) new ResizeObserver(() => scheduleDecide()).observe(el.parentElement, { box: 'border-box' });
  });

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
    get view() {
      return view;
    },
    frame(v) {
      voice = v;
      const limited = !!bridge.status.unisonLimited && model.playing;
      if (guardNote.hidden === limited) guardNote.hidden = !limited;
      if (full.guard.hidden === limited) full.guard.hidden = !limited;
      if (view === 'full') {
        if (full.frame(v, dirty, model.playing)) dirty = false;
        return;
      }
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
