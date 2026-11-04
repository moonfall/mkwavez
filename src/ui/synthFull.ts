/**
 * The Synth voice's full view: every control at once, no page tabs, for a Voice panel with
 * room for it (synthPanel.ts decides from the panel's size, not the viewport). Groups of
 * small knobs (knob.ts) flow in columns of `--rows` cells: Osc A · Osc B (each with an
 * inline "now playing" scope or X/Y pad) · Mix · Filter · Amp / Filter / Pitch / Mod
 * envelopes · LFO 1–3 (one frame) · Output, then a side column with the presets and the mod matrix
 * (both moved here from the pages by synthPanel.ts). Every edit goes through the same
 * VoicePatch path as the pages (a drag or key press is one undo step).
 */
import type { AppModel } from '../app/model';
import type { AudioBridge } from '../audio/bridge';
import { TABLE_SIZE } from '../core/constants';
import { CUTOFF_MAX, CUTOFF_MIN, FILTER_ENV_OCTAVES, FILTER_MODE_LABELS, FILTER_MODES, FILTER_SPREAD_OCTAVES, MACRO_KEYS, MAX_POLY, MAX_UNISON, PHASE_MODE_LABELS, PHASE_MODES, WARP_LABELS, WARP_MODES, type FilterMode, type OscSource, type PhaseMode, type SynthParams } from '../core/synth';
import { isOneShot, isPeriodicShape, LFO_DIVS, LFO_RATE_MAX_HZ, LFO_RATE_MIN_HZ, LFO_SHAPE_LABELS, LFO_SHAPES, type LfoDiv, type LfoParams, type LfoShape } from '../core/modulation';
import type { VoicePatch, VoiceParams } from '../core/voice';
import { shapeLabel } from '../core/wavetable';
import { Mix } from '../core/wavetablePlayback';
import { cssColor, drawSpectrum, drawWave, fit } from './canvas';
import { isOnScreen, watchVisibility } from './context';
import { h, voiceColorVar } from './dom';
import { choiceCell, knob, linear, type Taper } from './knob';
import { oscMix, oscPositions, oscView } from './playing';
import { createVoicePad } from './voicePad';

export const pct = (v: number) => `${Math.round(v * 100)}%`;
export const secs = (v: number) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);
export const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} k` : `${Math.round(v)} Hz`);
export const signed = (v: number, digits = 0, unit = '') => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}${unit}`;
/** A pan position: C, L 40, R 100. */
export const panText = (x: number) => (Math.abs(x) < 0.01 ? 'C' : `${x < 0 ? 'L' : 'R'} ${Math.round(Math.abs(x) * 100)}`);
const kPan = (x: number) => (Math.abs(x) < 0.01 ? 'C' : `${x < 0 ? 'L' : 'R'}${Math.round(Math.abs(x) * 100)}`);
const deg = (x: number) => `${Math.round(x * 360)}°`;

export const logTaper = (min: number, max: number): Taper => ({
  toU: (v) => Math.log(Math.max(min, v) / min) / Math.log(max / min),
  toV: (u) => min * Math.pow(max / min, u),
});
/** Seconds with a quadratic taper (fine control of short times), 0..max. */
export const timeTaper = (max: number): Taper => ({ toU: (v) => Math.sqrt(Math.max(0, v) / max), toV: (u) => max * u * u });

/** Shorter value texts for the knobs' narrow cells. */
const kSecs = (v: number) => (v < 1 ? `${Math.round(v * 1000)}ms` : `${v.toFixed(v < 10 ? 2 : 1)}s`);
const kHz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)}k` : `${Math.round(v)}`);

/**
 * Draws one oscillator's picture: on a 2D / Rows wavetable its X/Y pad, on 1D a "now
 * playing" scope (waveform over its spectrum). Shared by the Osc page and the full view.
 */
export function oscDrawer(model: AppModel, bridge: AudioBridge, which: () => 'a' | 'b', pad: ReturnType<typeof createVoicePad>, scope: HTMLCanvasElement, label: HTMLElement, box: HTMLElement) {
  const mix = new Mix();
  let scopeKey = '';
  let scopeData: Float32Array | null = null;
  return (v: VoiceParams) => {
    const osc = which();
    const s = osc === 'b' ? v.synth.b : v;
    const wt = model.wavetable(s.wavetableId);
    if (!wt) return;
    const color = cssColor(voiceColorVar(v.id - 1));
    const hh = Math.max(40, box.clientHeight || 110);
    if (wt.shape !== '1d') {
      pad.draw(oscView(v, osc), wt, hh, { pos: oscPositions(model, bridge, v, osc), mix: (out) => oscMix(model, bridge, v, osc, out) });
      label.textContent = `Osc ${osc.toUpperCase()}`;
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
    label.textContent = m.n ? `Osc ${osc.toUpperCase()} · #${wt.interp === 'step' ? m.x + 1 : (m.x + 1).toFixed(1)}` : `Osc ${osc.toUpperCase()}`;
    const [g, w, H] = fit(scope, hh);
    if (!scopeData) return;
    g.save();
    g.globalAlpha = 0.3;
    drawSpectrum(g, w, H, scopeData, color);
    g.restore();
    drawWave(g, 0, 0, w, H, scopeData, color, { axis: cssColor('--border'), lineWidth: 1.5 });
  };
}

interface Synced {
  sync(v: VoiceParams): void;
}

export interface SynthFull {
  readonly el: HTMLElement;
  /** The side column's top row and matrix slot (synthPanel moves the presets / matrix here). */
  readonly sideTop: HTMLElement;
  readonly side: HTMLElement;
  /** The macro sliders (a strip under the mod matrix). */
  readonly macros: HTMLElement;
  readonly guard: HTMLElement;
  sync(v: VoiceParams): void;
  frame(v: VoiceParams, dirty: boolean, playing: boolean): boolean;
}

export function buildSynthFull(model: AppModel, bridge: AudioBridge, set: (p: VoicePatch) => void, commit: () => void, voice: () => VoiceParams | null): SynthFull {
  const synced: Synced[] = [];
  const sw = (key: keyof SynthParams) => (x: number) => ({ synth: { [key]: x } }) as VoicePatch;

  /** A knob bound to a voice value. */
  const K = (
    id: string,
    label: string,
    get: (v: VoiceParams) => number,
    put: (x: number) => VoicePatch,
    taper: Taper,
    fmt: (x: number) => string,
    o: { name?: string; int?: boolean; bipolar?: boolean; snap?: (x: number) => number; title?: string; reset?: number; range?: (v: VoiceParams) => [number, number]; off?: (v: VoiceParams) => boolean } = {},
  ) => {
    const k = knob({ id, label, name: o.name, taper, fmt, int: o.int, bipolar: o.bipolar, snap: o.snap, title: o.title, reset: o.reset, onInput: (x) => set(put(x)), onCommit: commit });
    synced.push({
      sync(v) {
        if (o.range) {
          const [a, b] = o.range(v);
          k.setTaper(linear(a, Math.max(a + 1, b)));
          k.setDisabled(b <= a || !!o.off?.(v));
        } else if (o.off) k.setDisabled(o.off(v));
        k.set(get(v));
      },
    });
    return k;
  };
  /** A choice cell bound to a voice value. */
  const C = <T>(id: string, label: string, options: readonly (readonly [T, string])[], get: (v: VoiceParams) => T, put: (x: T) => VoicePatch, o: { name?: string; title?: string; pressed?: (x: T) => boolean; off?: (v: VoiceParams) => boolean } = {}) => {
    const c = choiceCell<T>({
      id,
      label,
      name: o.name,
      options,
      title: o.title,
      pressed: o.pressed,
      onPick: (x) => {
        set(put(x));
        commit();
      },
    });
    synced.push({
      sync(v) {
        c.set(get(v));
        if (o.off) c.setDisabled(o.off(v));
      },
    });
    return c;
  };
  const OFF_ON = [
    [false, 'Off'],
    [true, 'On'],
  ] as const;
  /** A titled group of cells; `head` goes next to the title. */
  const group = (id: string, title: string, cells: HTMLElement[], head: HTMLElement[] = [], cls = 'synf-group') =>
    h('section', { class: cls, id, 'aria-label': title }, h('div', { class: 'synf-head' }, h('h3', {}, title), ...head), h('div', { class: 'synf-cells' }, ...cells));
  const sel = <T extends string>(id: string, label: string, options: readonly (readonly [T, string])[], get: (v: VoiceParams) => T, put: (x: T) => VoicePatch, cls = '') => {
    const el = h('select', { id, class: cls, 'aria-label': label, title: label }, ...options.map(([value, text]) => h('option', { value }, text)));
    el.addEventListener('change', () => {
      set(put(el.value as T));
      commit();
    });
    synced.push({ sync: (v) => void (el.value = get(v)) });
    return el;
  };
  /** A cell holding a compact <select> (its label below). */
  const selCell = <T extends string>(id: string, label: string, name: string, options: readonly (readonly [T, string])[], get: (v: VoiceParams) => T, put: (x: T) => VoicePatch) =>
    h('div', { class: 'knob knob-cell-choice', title: name }, sel(id, name, options, get, put, 'knob-select'), h('span', { class: 'knob-label' }, label));
  /** One sub-column of a group (the envelopes: one column each, titled in the group's header). */
  const col = (...cells: HTMLElement[]) => h('div', { class: 'synf-col' }, ...cells);

  // ---- oscillators ----
  const T2 = timeTaper(2);
  const T4 = timeTaper(4);
  const draws: { draw: (v: VoiceParams) => void; canvas: () => HTMLCanvasElement }[] = [];
  const osc = (o: 'a' | 'b') => {
    const O = o.toUpperCase();
    const src = (v: VoiceParams): OscSource => (o === 'b' ? v.synth.b : v);
    const putSrc = (patch: Partial<OscSource>): VoicePatch => (o === 'b' ? { synth: { b: { ...voice()!.synth.b, ...patch } } } : patch);
    const key = <N extends string>(n: N) => `${o}${n}` as keyof SynthParams;
    const dims = (v: VoiceParams) => {
      const wt = model.wavetable(src(v).wavetableId);
      const W = wt && wt.shape !== 'rows' ? Math.max(1, wt.rows[0]?.length ?? 1) : 1;
      const H = wt && wt.shape !== '1d' ? Math.max(1, wt.rows.length) : 1;
      return { shape: wt?.shape ?? '1d', W, H };
    };
    const wtSel = h('select', { id: `synf-${o}-wt`, 'aria-label': `Osc ${O} wavetable` });
    wtSel.addEventListener('change', () => {
      set(putSrc({ wavetableId: Number(wtSel.value) }));
      commit();
    });
    let wtSig = '';
    synced.push({
      sync(v) {
        const sig = model.wavetables.map((w) => `${w.id}:${w.name}:${shapeLabel(w)}`).join('|');
        if (sig !== wtSig) {
          wtSig = sig;
          wtSel.replaceChildren(...model.wavetables.map((w) => h('option', { value: String(w.id) }, `${w.name} · ${shapeLabel(w)}`)));
        }
        wtSel.value = String(src(v).wavetableId);
        wtSel.title = `Osc ${O} wavetable: ${wtSel.selectedOptions[0]?.textContent ?? ''}`;
      },
    });
    const N = (x: string) => `Osc ${O} ${x}`;
    const is1d = (v: VoiceParams) => dims(v).shape === '1d';
    const tune = [
      K(`synf-${o}-oct`, 'Oct', (v) => v.synth[key('Oct')] as number, (x) => ({ synth: { [key('Oct')]: x } }), linear(-3, 3), (x) => signed(x), { int: true, name: N('octave'), reset: 0 }),
      K(`synf-${o}-semi`, 'Semi', (v) => v.synth[key('Coarse')] as number, (x) => ({ synth: { [key('Coarse')]: x } }), linear(-24, 24), (x) => signed(x), { int: true, bipolar: true, name: N('semitones'), reset: 0 }),
      K(`synf-${o}-fine`, 'Fine', (v) => v.synth[key('Fine')] as number, (x) => ({ synth: { [key('Fine')]: x } }), linear(-100, 100), (x) => signed(x, 0, 'ct'), { bipolar: true, snap: Math.round, name: N('fine tune (cents)'), reset: 0 }),
      K(`synf-${o}-uni`, 'Unison', (v) => v.synth[key('Unison')] as number, (x) => ({ synth: { [key('Unison')]: x } }), linear(1, MAX_UNISON), (x) => `×${x}`, { int: true, name: N('unison copies'), reset: 1 }),
      K(`synf-${o}-detune`, 'Detune', (v) => v.synth[key('Detune')] as number, (x) => ({ synth: { [key('Detune')]: x } }), linear(0, 50), (x) => `${Math.round(x)}ct`, { name: N('unison detune (cents)'), off: (v) => (v.synth[key('Unison')] as number) < 2 }),
      K(`synf-${o}-spread`, 'Spread', (v) => v.synth[key('Spread')] as number, (x) => ({ synth: { [key('Spread')]: x } }), linear(0, 1), pct, { name: N('unison stereo spread'), off: (v) => (v.synth[key('Unison')] as number) < 2 }),
    ];
    const level = K(`synf-${o}-level`, 'Level', (v) => v.synth[key('Level')] as number, (x) => ({ synth: { [key('Level')]: x } }), linear(0, 1), pct, { name: N('level') });
    const pan = K(`synf-${o}-pan`, 'Pan', (v) => v.synth[key('Pan')] as number, (x) => ({ synth: { [key('Pan')]: x } }), linear(-1, 1), kPan, { bipolar: true, name: N('pan'), reset: 0 });
    // Window / position: 1D From · To · Pos; 2D From X/Y · To X/Y · Pos X/Y; Rows: no X window.
    const from = K(`synf-${o}-from`, 'From', (v) => src(v).windowStart, (x) => putSrc({ windowStart: x }), linear(0, 1), (x) => `#${x + 1}`, { int: true, name: N('window from'), range: (v) => [0, dims(v).W - 1] });
    const to = K(`synf-${o}-to`, 'To', (v) => src(v).windowEnd, (x) => putSrc({ windowEnd: x }), linear(0, 1), (x) => `#${x + 1}`, { int: true, name: N('window to'), range: (v) => [0, dims(v).W - 1] });
    const fromY = K(`synf-${o}-from-y`, 'From Y', (v) => src(v).windowStartY, (x) => putSrc({ windowStartY: x }), linear(0, 1), (x) => `${x + 1}`, { int: true, name: N('window from Y'), range: (v) => [0, dims(v).H - 1] });
    const toY = K(`synf-${o}-to-y`, 'To Y', (v) => src(v).windowEndY, (x) => putSrc({ windowEndY: x }), linear(0, 1), (x) => `${x + 1}`, { int: true, name: N('window to Y'), range: (v) => [0, dims(v).H - 1] });
    const pos = K(`synf-${o}-pos`, 'Pos', (v) => src(v).position, (x) => putSrc({ position: x }), linear(0, 1), pct, { name: N('position') });
    const posY = K(`synf-${o}-pos-y`, 'Pos Y', (v) => src(v).positionY, (x) => putSrc({ positionY: x }), linear(0, 1), pct, { name: N('position Y') });
    synced.push({
      sync(v) {
        const shape = dims(v).shape;
        from.el.hidden = to.el.hidden = shape === 'rows';
        fromY.el.hidden = toY.el.hidden = posY.el.hidden = shape === '1d';
        from.el.querySelector('.knob-label')!.textContent = shape === '1d' ? 'From' : 'From X';
        to.el.querySelector('.knob-label')!.textContent = shape === '1d' ? 'To' : 'To X';
        pos.el.querySelector('.knob-label')!.textContent = shape === '1d' ? 'Pos' : 'Pos X';
      },
    });
    const pad = createVoicePad(model, bridge, `synf-${o}-pad`);
    const scope = h('canvas', { id: `synf-${o}-scope`, role: 'img', 'aria-label': `Osc ${O} now playing: waveform (spectrum behind)` });
    const tag = h('span', { class: 'plot-tag' });
    const vis = h('div', { class: 'plot-box synf-vis' }, pad.canvas, scope, tag);
    watchVisibility(pad.canvas);
    watchVisibility(scope);
    synced.push({
      sync(v) {
        const d = is1d(v);
        pad.canvas.hidden = d;
        scope.hidden = !d;
      },
    });
    draws.push({ draw: oscDrawer(model, bridge, () => o, pad, scope, tag, vis), canvas: () => (pad.canvas.hidden ? scope : pad.canvas) });
    return group(`synf-osc-${o}`, `Osc ${O}`, [vis, ...tune.map((c) => c.el), level.el, pan.el, from.el, fromY.el, to.el, toY.el, pos.el, posY.el], [wtSel], 'synf-group synf-osc');
  };

  // ---- mix ----
  /** An oscillator's warp: the amount knob with the mode select as its label (one cell). */
  const warpCell = (o: 'a' | 'b') => {
    const O = o.toUpperCase();
    const m = `${o}Warp` as const;
    const a = `${o}WarpAmt` as const;
    const k = K(`synf-${o}-warp`, `${O} warp`, (v) => v.synth[a], sw(a), linear(-1, 1), (x) => signed(x * 100, 0), {
      bipolar: true,
      name: `Osc ${O} warp amount (bend and squeeze use the sign)`,
      reset: 0,
      off: (v) => v.synth[m] === 'none',
    });
    const mode = sel(`synf-${o}-warp-mode`, `Osc ${O} warp`, WARP_MODES.map((w) => [w, w === 'none' ? `${O} warp` : `${O} ${WARP_LABELS[w].toLowerCase()}`] as const), (v) => v.synth[m], (x) => ({ synth: { [m]: x } }), 'knob-mode');
    k.el.querySelector('.knob-label')!.replaceWith(mode);
    k.el.classList.add('knob-moded');
    return k.el;
  };
  const mix = group('synf-mix', 'Mix', [
    K('synf-sub', 'Sub', (v) => v.synth.subLevel, sw('subLevel'), linear(0, 1), pct, { name: 'Sub level' }).el,
    C('synf-sub-wave', 'Wave', [['sine', 'Sine'], ['square', 'Sqr']] as const, (v) => v.synth.subWave, (x) => ({ synth: { subWave: x } }), { name: 'Sub waveform' }).el,
    C('synf-sub-oct', 'Oct', [[1, '−1'], [2, '−2']] as const, (v) => v.synth.subOct, (x) => ({ synth: { subOct: x } }), { name: 'Sub octave' }).el,
    K('synf-noise', 'Noise', (v) => v.synth.noiseLevel, sw('noiseLevel'), linear(0, 1), pct, { name: 'Noise level' }).el,
    C('synf-noise-type', 'Colour', [['white', 'White'], ['pink', 'Pink']] as const, (v) => v.synth.noiseType, (x) => ({ synth: { noiseType: x } }), { name: 'Noise colour' }).el,
    K('synf-noise-width', 'N width', (v) => v.synth.noiseWidth, sw('noiseWidth'), linear(0, 1), pct, { name: 'Noise stereo width (0 = the same on both sides)', reset: 0 }).el,
    K('synf-ring', 'Ring', (v) => v.synth.ringLevel, sw('ringLevel'), linear(0, 1), pct, { name: 'Ring modulation A × B' }).el,
    K('synf-fm', 'FM', (v) => v.synth.fm, sw('fm'), linear(0, 1), pct, { name: 'FM: osc B modulates osc A’s phase' }).el,
    C('synf-sync', 'Sync B', OFF_ON, (v) => v.synth.sync, (x) => ({ synth: { sync: x } }), { name: 'Hard sync: each cycle of osc B restarts osc A', pressed: (x) => x }).el,
    warpCell('a'),
    warpCell('b'),
    selCell<PhaseMode>('synf-phase-mode', 'Phase', 'Oscillator phase at each note (legato notes keep it)', PHASE_MODES.map((m) => [m, PHASE_MODE_LABELS[m]] as const), (v) => v.synth.phaseMode, (x) => ({ synth: { phaseMode: x } })),
  ]);

  // ---- filter ----
  const filter = group(
    'synf-filter',
    'Filter',
    [
      selCell<FilterMode>('synf-filter-mode', 'Mode', 'Filter mode', FILTER_MODES.map((m) => [m, FILTER_MODE_LABELS[m]] as const), (v) => v.synth.filterMode, (x) => ({ synth: { filterMode: x } })),
      K('synf-cutoff', 'Cutoff', (v) => v.synth.cutoff, sw('cutoff'), logTaper(CUTOFF_MIN, CUTOFF_MAX), kHz, { name: 'Cutoff (Hz)' }).el,
      K('synf-fspread', 'Spread', (v) => v.synth.filterSpread, sw('filterSpread'), linear(-1, 1), (x) => signed((x * FILTER_SPREAD_OCTAVES) / 2, 1), {
        bipolar: true,
        name: 'Stereo filter spread (octaves per side: left down, right up)',
        reset: 0,
      }).el,
      K('synf-res', 'Res', (v) => v.synth.resonance, sw('resonance'), linear(0, 1), pct, { name: 'Resonance' }).el,
      K('synf-drive', 'Drive', (v) => v.synth.drive, sw('drive'), linear(0, 1), pct, { name: 'Drive (before the filter)' }).el,
      K('synf-sat', 'Sat', (v) => v.synth.sat, sw('sat'), linear(0, 1), pct, { name: 'Saturation (after the filter)' }).el,
      K('synf-key', 'Key', (v) => v.synth.keyTrack, sw('keyTrack'), linear(0, 1), pct, { name: 'Key tracking' }).el,
      K('synf-env-amt', 'Env', (v) => v.synth.envAmount, sw('envAmount'), linear(-1, 1), (x) => signed(x * FILTER_ENV_OCTAVES, 1), { bipolar: true, name: 'Filter envelope amount (octaves)', reset: 0 }).el,
      K('synf-vel-amt', 'Vel', (v) => v.synth.velAmount, sw('velAmount'), linear(0, 1), pct, { name: 'Velocity → cutoff (softer notes close the filter)' }).el,
    ],
  );

  // ---- envelopes ----
  const amp = col(
    K('synf-amp-a', 'Atk', (v) => v.attack, (x) => ({ attack: Math.max(0.001, x) }), T2, kSecs, { name: 'Amp attack' }).el,
    K('synf-amp-d', 'Dec', (v) => v.decay, (x) => ({ decay: Math.max(0.001, x) }), T4, kSecs, { name: 'Amp decay' }).el,
    K('synf-amp-s', 'Sus', (v) => v.sustain, (x) => ({ sustain: x }), linear(0, 1), pct, { name: 'Amp sustain' }).el,
    K('synf-amp-r', 'Rel', (v) => v.release, (x) => ({ release: Math.max(0.001, x) }), T4, kSecs, { name: 'Amp release' }).el,
    K('synf-vel-amp', 'Vel', (v) => v.synth.velAmp, sw('velAmp'), linear(0, 1), pct, { name: 'Velocity → level' }).el,
  );
  const fenv = col(
    K('synf-f-a', 'Atk', (v) => v.synth.fAttack, sw('fAttack'), T2, kSecs, { name: 'Filter envelope attack' }).el,
    K('synf-f-d', 'Dec', (v) => v.synth.fDecay, sw('fDecay'), T4, kSecs, { name: 'Filter envelope decay' }).el,
    K('synf-f-s', 'Sus', (v) => v.synth.fSustain, sw('fSustain'), linear(0, 1), pct, { name: 'Filter envelope sustain' }).el,
    K('synf-f-r', 'Rel', (v) => v.synth.fRelease, sw('fRelease'), T4, kSecs, { name: 'Filter envelope release' }).el,
  );
  const penv = col(
    K('synf-p-a', 'Atk', (v) => v.synth.pAttack, sw('pAttack'), T2, kSecs, { name: 'Pitch envelope attack' }).el,
    K('synf-p-d', 'Dec', (v) => v.synth.pDecay, sw('pDecay'), T4, kSecs, { name: 'Pitch envelope decay' }).el,
    K('synf-p-amt', 'Amt', (v) => v.synth.pAmount, sw('pAmount'), linear(-24, 24), (x) => signed(x, 1), { bipolar: true, snap: (x) => Math.round(x * 10) / 10, name: 'Pitch envelope amount (semitones)', reset: 0 }).el,
    C('synf-p-target', 'Target', [['a', 'A'], ['b', 'B'], ['ab', 'A+B']] as const, (v) => v.synth.pTarget, (x) => ({ synth: { pTarget: x } }), { name: 'Pitch envelope target' }).el,
  );
  const adsrOff = (v: VoiceParams) => v.synth.mMode === 'ad';
  const menv = col(
    C('synf-m-mode', 'Mode', [['ad', 'AD'], ['adsr', 'ADSR']] as const, (v) => v.synth.mMode, (x) => ({ synth: { mMode: x } }), { name: 'Mod envelope mode' }).el,
    K('synf-m-a', 'Atk', (v) => v.synth.mAttack, sw('mAttack'), T2, kSecs, { name: 'Mod envelope attack' }).el,
    K('synf-m-d', 'Dec', (v) => v.synth.mDecay, sw('mDecay'), T4, kSecs, { name: 'Mod envelope decay' }).el,
    K('synf-m-s', 'Sus', (v) => v.synth.mSustain, sw('mSustain'), linear(0, 1), pct, { name: 'Mod envelope sustain', off: adsrOff }).el,
    K('synf-m-r', 'Rel', (v) => v.synth.mRelease, sw('mRelease'), T4, kSecs, { name: 'Mod envelope release', off: adsrOff }).el,
  );
  const envs = h(
    'section',
    { class: 'synf-group synf-envs', id: 'synf-env', 'aria-label': 'Envelopes: amp, filter, pitch, mod' },
    h('div', { class: 'synf-head' }, ...['Amp', 'Filter', 'Pitch', 'Mod'].map((t) => h('h3', { title: `${t} envelope` }, t))),
    h('div', { class: 'synf-cols' }, amp, fenv, penv, menv),
  );

  // ---- LFOs ----
  const lfo = (n: number) => {
    const L = `LFO ${n + 1}`;
    const get = (v: VoiceParams) => v.synth.lfos[n];
    const putLfo = (patch: Partial<LfoParams>): VoicePatch => ({ synth: { lfos: voice()!.synth.lfos.map((l, i) => (i === n ? { ...l, ...patch } : l)) } });
    const shape = selCell<LfoShape>(`synf-lfo${n}-shape`, 'Shape', `${L} shape`, LFO_SHAPES.map((s) => [s, LFO_SHAPE_LABELS[s]] as const), (v) => get(v).shape, (x) => putLfo({ shape: x }));
    const rate = K(`synf-lfo${n}-rate`, 'Rate', (v) => get(v).rate, (x) => putLfo({ rate: x }), logTaper(LFO_RATE_MIN_HZ, LFO_RATE_MAX_HZ), (x) => (x < 10 ? x.toFixed(2) : x.toFixed(1)), { name: `${L} rate (Hz)` });
    const divCell = selCell<LfoDiv>(`synf-lfo${n}-div`, 'Division', `${L} division (tempo sync)`, LFO_DIVS.map((d) => [d, d] as const), (v) => get(v).div, (x) => putLfo({ div: x }));
    const flag = (key: 'sync' | 'retrig', text: string, title: string) => {
      const b = h('button', {
        class: 'knob-flag',
        id: `synf-lfo${n}-${key}`,
        title: `${L}: ${title}`,
        onclick: () => {
          set(putLfo({ [key]: !voice()!.synth.lfos[n][key] }));
          commit();
        },
      }, text);
      synced.push({
        sync(v) {
          b.setAttribute('aria-pressed', String(get(v)[key]));
          // One-shot shapes always restart on a note.
          if (key === 'retrig') b.disabled = isOneShot(get(v).shape);
        },
      });
      return b;
    };
    const flags = h(
      'div',
      { class: 'knob knob-flags' },
      flag('sync', 'Sync', 'tempo sync (one cycle per division at the transport tempo)'),
      flag('retrig', 'Retrig', 'restart at the start phase on every note (otherwise free-running)'),
    );
    synced.push({
      sync(v) {
        rate.el.hidden = get(v).sync;
        divCell.hidden = !get(v).sync;
      },
    });
    return group(
      `synf-lfo${n}`,
      L,
      [
        shape,
        rate.el,
        divCell,
        K(`synf-lfo${n}-depth`, 'Depth', (v) => get(v).depth, (x) => putLfo({ depth: x }), linear(0, 1), pct, { name: `${L} depth` }).el,
        K(`synf-lfo${n}-fade`, 'Fade in', (v) => get(v).fade, (x) => putLfo({ fade: x }), timeTaper(5), (x) => (x < 0.002 ? 'off' : kSecs(x)), { name: `${L} fade in` }).el,
        K(`synf-lfo${n}-phase`, 'Phase', (v) => get(v).phase, (x) => putLfo({ phase: x }), linear(0, 1), (x) => `${Math.round(x * 360)}°`, { name: `${L} start phase` }).el,
        flags,
      ],
      [],
      'synf-sub',
    );
  };
  // The three LFOs share one frame (a titled sub-column each), like the envelopes.
  const lfos = h('div', { class: 'synf-group synf-lfos', role: 'group', 'aria-label': 'LFOs 1–3' }, lfo(0), lfo(1), lfo(2));

  // ---- stereo controls of the Output group ----
  const oscStereo = (o: 'a' | 'b') => {
    const O = o.toUpperCase();
    const ph = `${o}PhaseSpread` as const;
    const ps = `${o}PosSpread` as const;
    return [
      K(`synf-${o}-phase`, `${O} phase`, (v) => v.synth[ph], sw(ph), linear(0, 0.5), deg, { name: `Osc ${O} stereo phase (the right channel reads ahead)`, reset: 0 }).el,
      K(`synf-${o}-pspread`, `${O} pos ↔`, (v) => v.synth[ps], sw(ps), linear(0, 1), pct, { name: `Osc ${O} stereo position (left and right read the window apart)`, reset: 0 }).el,
    ];
  };
  const lfoStereo = (n: number) => {
    const get = (v: VoiceParams) => v.synth.lfos[n];
    return K(`synf-lfo${n}-stereo`, `LFO ${n + 1} ↔`, (v) => get(v).stereo, (x) => ({ synth: { lfos: voice()!.synth.lfos.map((l, i) => (i === n ? { ...l, stereo: x } : l)) } }), linear(0, 0.5), deg, {
      name: `LFO ${n + 1} stereo phase (the right channel runs ahead on positions, levels, cutoff, amp; periodic shapes only)`,
      off: (v) => !isPeriodicShape(get(v).shape),
      reset: 0,
    }).el;
  };
  // ---- output: level, octave, glide, bend, then the stereo image (pan, width, stereo phase /
  // position per oscillator, the LFOs' stereo phases) ----
  const out = group('synf-out', 'Output', [
    K('synf-out-level', 'Level', (v) => v.level, (x) => ({ level: x }), linear(0, 1), pct, { name: 'Output level' }).el,
    K('synf-poly', 'Voices', (v) => v.synth.poly, sw('poly'), linear(1, MAX_POLY), (x) => (x === 1 ? 'mono' : `${x}`), { int: true, name: 'Notes the voice plays at once (1 = monophonic)', reset: 8 }).el,
    K('synf-oct', 'Octave', (v) => v.octave, (x) => ({ octave: x }), linear(-2, 2), (x) => signed(x), { int: true, name: 'Voice octave', reset: 0 }).el,
    K('synf-glide', 'Glide', (v) => v.synth.glide, sw('glide'), timeTaper(2), (x) => (x < 0.002 ? 'off' : kSecs(x)), { name: 'Glide' }).el,
    C('synf-legato', 'Legato', OFF_ON, (v) => v.synth.glideLegato, (x) => ({ synth: { glideLegato: x } }), { name: 'Glide only between overlapping notes', pressed: (x) => x }).el,
    K('synf-bend', 'Bend', (v) => v.synth.bendRange, sw('bendRange'), linear(0, 24), (x) => `±${x}`, { int: true, name: 'Pitch-bend range (semitones)' }).el,
    K('synf-pan', 'Pan', (v) => v.synth.pan, sw('pan'), linear(-1, 1), kPan, { bipolar: true, name: 'Pan', reset: 0 }).el,
    K('synf-width', 'Width', (v) => v.synth.width, sw('width'), linear(0, 2), pct, { name: 'Stereo width (0 = mono)' }).el,
    ...oscStereo('a'),
    ...oscStereo('b'),
    lfoStereo(0),
    lfoStereo(1),
    lfoStereo(2),
  ]);

  // ---- macros: one slider each, under the mod matrix ----
  const macros = h(
    'div',
    { class: 'synf-macros', role: 'group', 'aria-label': 'Macros' },
    ...MACRO_KEYS.map((key, i) => {
      const name = `Macro ${i + 1}`;
      const input = h('input', { type: 'range', id: `synf-macro-${i}`, min: 0, max: 1, step: 0.001, value: 0, 'aria-label': name });
      input.addEventListener('input', () => set({ synth: { [key]: Number(input.value) } }));
      input.addEventListener('change', commit);
      const cell = h('label', { class: 'synf-macro' }, h('span', {}, `M${i + 1}`), input);
      synced.push({
        sync(v) {
          const x = v.synth[key];
          if (document.activeElement !== input || Number(input.value) !== x) input.value = String(x);
          cell.title = `${name}: ${pct(x)} (a matrix source)`;
        },
      });
      return cell;
    }),
  );

  const guard = h('span', { class: 'syn-guard', id: 'synf-guard', hidden: true, title: 'Too many unison copies sound at once: the CPU guard plays fewer' }, 'CPU guard: reduced');
  const sideTop = h('div', { class: 'synf-side-top' });
  const side = h('section', { class: 'synf-side', 'aria-label': 'Presets and mod matrix' }, sideTop, h('div', { class: 'synf-head synf-matrix-head' }, h('h3', {}, 'Mod matrix'), guard));
  const groups = h('div', { class: 'synf-groups' }, osc('a'), osc('b'), mix, filter, envs, lfos, out);
  const el = h('div', { class: 'synf', id: 'synth-full', role: 'group', 'aria-label': 'All Synth voice controls' }, groups, side);

  return {
    el,
    sideTop,
    side,
    macros,
    guard,
    sync(v) {
      for (const s of synced) s.sync(v);
    },
    /** Draw the oscillator pictures; returns whether anything was drawn. */
    frame(v, dirty, playing) {
      let drew = false;
      for (const d of draws) {
        if (!isOnScreen(d.canvas()) || !(dirty || playing)) continue;
        d.draw(v);
        drew = true;
      }
      return drew;
    },
  };
}
