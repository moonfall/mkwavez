import { MAX_VOICES } from '../app/model';
import { TABLE_SIZE } from '../core/constants';
import { LFO_RATE_MAX, LFO_RATE_MIN } from '../core/midi';
import type { VoiceType } from '../core/synth';
import type { VoiceParams } from '../core/voice';
import { shapeLabel } from '../core/wavetable';
import { Mix } from '../core/wavetablePlayback';
import { cssColor, drawSpectrum, drawWave, fit, onThemeChange } from './canvas';
import { isOnScreen, watchVisibility, type FrameView, type UiContext } from './context';
import { h, icon, ICONS, panel, slider, voiceColorVar, type Slider } from './dom';
import { playingMix } from './playing';
import { SHORTCUTS } from './shortcuts';
import { buildSynthPanel } from './synthPanel';
import { createVoicePad } from './voicePad';

const OCT_MIN = -2;
const OCT_MAX = 2;

const pct = (v: number) => `${Math.round(v * 100)}%`;
const secs = (v: number) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);

/** Slider over seconds with a quadratic taper (fine control of short times). */
function timeSlider(label: string, maxSec: number, value: number, onInput: (s: number) => void): Slider {
  const toU = (s: number) => Math.sqrt(Math.max(0, s - 0.001) / maxSec);
  const toS = (u: number) => 0.001 + maxSec * u * u;
  const s = slider({ label, min: 0, max: 1, step: 0.001, value: toU(value), format: (u) => secs(toS(u)), onInput: (u) => onInput(toS(u)) });
  return { ...s, set: (sec: number) => s.set(toU(sec)) };
}

/**
 * Voice: one tab per voice (in voice colours; muted voices say so), and the selected
 * voice's controls — wavetable (its interpolation shown read-only), octave, window,
 * position, LFO, level on the left; a "now playing" scope, the ADSR envelope graph and
 * its controls on the right. On a 2D / Rows wavetable the window / position / LFO
 * controls are paired X / Y sliders and an X/Y pad (window, LFO path, position dot)
 * takes the envelope graph's place.
 * The selection lives in UiState, so the Sequence panel follows it.
 */
export function buildVoices(ctx: UiContext): { el: HTMLElement; view: FrameView } {
  const { model, bridge, ui } = ctx;
  const sec = panel('sec-voices', 'Voice');
  const cur = (): VoiceParams | undefined => (ui.voiceId === null ? undefined : model.voice(ui.voiceId));
  const set = (patch: Partial<VoiceParams>) => {
    if (ui.voiceId !== null) model.updateVoice(ui.voiceId, patch);
  };

  // ---- tabs ----
  const tabs = h('div', {
    class: 'voice-tabs',
    role: 'tablist',
    'aria-label': 'Voices',
    id: 'voice-tabs',
    'aria-keyshortcuts': `${SHORTCUTS.prevVoice} ${SHORTCUTS.nextVoice}`,
  });
  const addBtn = h(
    'button',
    { id: 'add-voice', class: 'small icon-btn', 'aria-label': 'Add voice', title: 'Add voice (Synth or Simple)', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
    icon(ICONS.plus),
  );
  // "+": a small menu — Synth (two oscillators, filter, envelopes) or Simple (one wavetable oscillator).
  const addMenu = h(
    'div',
    { id: 'add-voice-menu', class: 'add-voice-menu', role: 'menu', hidden: true },
    h('button', { id: 'add-voice-synth', role: 'menuitem', onclick: () => addVoice('synth') }, h('b', {}, 'Synth voice'), h('span', {}, 'Two oscillators, sub, noise, filter, envelopes')),
    h('button', { id: 'add-voice-simple', role: 'menuitem', onclick: () => addVoice('simple') }, h('b', {}, 'Simple voice'), h('span', {}, 'One wavetable oscillator with position LFOs')),
  );
  document.body.append(addMenu);
  const closeMenu = () => {
    if (addMenu.hidden) return;
    addMenu.hidden = true;
    addBtn.setAttribute('aria-expanded', 'false');
  };
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!addMenu.hidden) return closeMenu();
    const r = addBtn.getBoundingClientRect();
    addMenu.hidden = false;
    addBtn.setAttribute('aria-expanded', 'true');
    const mw = addMenu.offsetWidth;
    const mh = addMenu.offsetHeight;
    addMenu.style.left = `${Math.max(8, Math.min(innerWidth - mw - 8, r.left))}px`;
    addMenu.style.top = `${r.bottom + 4 + mh > innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4}px`;
    (addMenu.firstElementChild as HTMLElement).focus();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!addMenu.contains(e.target as Node) && e.target !== addBtn && !addBtn.contains(e.target as Node)) closeMenu();
  });
  addMenu.addEventListener('keydown', (e) => {
    const items = [...addMenu.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      closeMenu();
      addBtn.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    }
  });
  // Voice type: switching a sounding voice crossfades (click-free); undoable.
  const typeSel = h(
    'select',
    { id: 'voice-type', class: 'voice-type', 'aria-label': 'Voice type', title: 'Voice type: Synth (two oscillators, filter, envelopes) or Simple (one wavetable oscillator)' },
    h('option', { value: 'synth' }, 'Synth'),
    h('option', { value: 'simple' }, 'Simple'),
  );
  const typeSlot = h('span', { class: 'voice-type-slot' });
  typeSel.addEventListener('change', () => {

    set({ type: typeSel.value === 'synth' ? 'synth' : 'simple' });
    model.endGesture();
  });
  const muteBtn = h('button', { id: 'voice-mute', class: 'small', 'aria-keyshortcuts': SHORTCUTS.mute, onclick: () => set({ mute: !cur()?.mute }) });
  const removeBtn = h('button', {
    id: 'voice-remove',
    class: 'small icon-btn',
    onclick: () => {
      if (ui.voiceId !== null) model.removeVoice(ui.voiceId);
    },
  });
  sec.tools.append(tabs, addBtn, h('span', { class: 'grow' }), muteBtn, removeBtn);

  const addVoice = (type: VoiceType) => {
    closeMenu();
    const v = model.addVoice({ type });
    if (!v) return;
    model.addSequence(v.id);
    ui.setVoice(v.id);
  };

  let tabSig = '';
  const renderTabs = () => {
    const sig = model.voices.map((v) => `${v.id}:${v.name}:${v.mute}`).join('|') + `|${ui.voiceId}`;
    if (sig === tabSig) return;
    tabSig = sig;
    tabs.replaceChildren(
      ...model.voices.map((v) => {
        const on = v.id === ui.voiceId;
        return h(
          'button',
          {
            role: 'tab',
            id: `voice-tab-${v.id}`,
            class: `voice-tab${v.mute ? ' muted' : ''}`,
            style: `--c:var(${voiceColorVar(v.id - 1)})`,
            'aria-selected': String(on),
            'aria-controls': 'voice-panel',
            tabindex: on ? 0 : -1,
            title: `${v.name} · [ / ] previous / next voice`,
            onclick: () => ui.setVoice(v.id),
          },
          h('span', { class: 'dot' }),
          v.mute ? `${v.name} · muted` : v.name,
        );
      }),
    );
  };
  tabs.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const vs = model.voices;
    const i = vs.findIndex((v) => v.id === ui.voiceId);
    const next = vs[(i + (e.key === 'ArrowRight' ? 1 : -1) + vs.length) % vs.length];
    if (!next) return;
    e.preventDefault();
    ui.setVoice(next.id);
    document.getElementById(`voice-tab-${next.id}`)?.focus();
  });

  // ---- controls (bound to the selected voice) ----
  const wtSel = h('select', { id: 'voice-wavetable', 'aria-label': 'Wavetable' });
  wtSel.addEventListener('change', () => set({ wavetableId: Number(wtSel.value) }));
  let wtSig = '';
  const fillWt = () => {
    const sig = model.wavetables.map((w) => `${w.id}:${w.name}:${shapeLabel(w)}`).join('|');
    if (sig === wtSig) return;
    wtSig = sig;
    wtSel.replaceChildren(...model.wavetables.map((w) => h('option', { value: String(w.id) }, `${w.name} · ${shapeLabel(w)}`)));
  };
  // Interpolation lives on the wavetable (Wavetables panel); shown here read-only.
  const interpLabel = h('span', { class: 'voice-interp', id: 'voice-interp', title: 'Interpolation is set on the wavetable (Wavetables panel)' });
  const octLabel = h('span', { class: 'oct-label', id: 'voice-octave' });
  const octDown = h('button', { 'aria-label': 'Octave down', onclick: () => set({ octave: Math.max(OCT_MIN, (cur()?.octave ?? 0) - 1) }) }, '−');
  const octUp = h('button', { 'aria-label': 'Octave up', onclick: () => set({ octave: Math.min(OCT_MAX, (cur()?.octave ?? 0) + 1) }) }, '+');

  // 1D: one column of sliders.
  const ws = slider({ label: 'Window start', min: 0, max: 0, step: 1, value: 0, format: (x) => `#${x + 1}`, onInput: (x) => set({ windowStart: x }), onCommit: () => model.endGesture() });
  const we = slider({ label: 'Window end', min: 0, max: 0, step: 1, value: 0, format: (x) => `#${x + 1}`, onInput: (x) => set({ windowEnd: x }), onCommit: () => model.endGesture() });
  const pos = slider({ label: 'Position', min: 0, max: 1, step: 0.01, value: 0, format: pct, onInput: (x) => set({ position: x }) });
  const fullBtn = h(
    'button',
    {
      class: 'small',
      'aria-label': 'Sweep the whole window: position 50%, depth 100%',
      onclick: (e: Event) => {
        e.preventDefault();
        set({ position: 0.5, lfoDepth: 1 });
      },
    },
    'Full',
  );
  const depth = slider({ label: 'LFO depth', min: 0, max: 1, step: 0.01, value: 0, format: pct, onInput: (x) => set({ lfoDepth: x }), extra: fullBtn });
  const rate = slider({ label: 'LFO rate', min: LFO_RATE_MIN, max: LFO_RATE_MAX, step: 0.01, value: LFO_RATE_MIN, format: (x) => `${x.toFixed(2)} Hz`, onInput: (x) => set({ lfoRate: x }) });
  const level = slider({ label: 'Level', min: 0, max: 1, step: 0.01, value: 0, format: pct, onInput: (x) => set({ level: x }) });
  const att = timeSlider('Attack', 2, 0.01, (x) => set({ attack: x }));
  const dec = timeSlider('Decay', 4, 0.2, (x) => set({ decay: x }));
  const sus = slider({ label: 'Sustain', min: 0, max: 1, step: 0.01, value: 0, format: pct, onInput: (x) => set({ sustain: x }) });
  const rel = timeSlider('Release', 4, 0.3, (x) => set({ release: x }));
  ws.input.id = 'voice-window-start';
  we.input.id = 'voice-window-end';
  pos.input.id = 'voice-position';
  depth.input.id = 'voice-lfo-depth';
  rate.input.id = 'voice-lfo-rate';
  level.input.id = 'voice-level';
  const rows1d = h('div', { class: 'vrows', id: 'voice-1d' }, ws.el, we.el, pos.el, depth.el, rate.el);

  // 2D / Rows: paired X / Y sliders.
  const pairs = [
    pairRow('Window from', 'voice-wx0', 'voice-wy0', 1, (x) => set({ windowStart: x }), (y) => set({ windowStartY: y }), () => model.endGesture(), (x, y) => `${x}, ${y}`),
    pairRow('Window to', 'voice-wx1', 'voice-wy1', 1, (x) => set({ windowEnd: x }), (y) => set({ windowEndY: y }), () => model.endGesture(), (x, y) => `${x}, ${y}`),
    pairRow('Position', 'voice-px', 'voice-py', 0.01, (x) => set({ position: x }), (y) => set({ positionY: y }), null, (x, y) => `${x.toFixed(2)}, ${y.toFixed(2)}`),
    pairRow('LFO depth', 'voice-dx', 'voice-dy', 0.01, (x) => set({ lfoDepth: x }), (y) => set({ lfoDepthY: y }), null, (x, y) => `${x.toFixed(2)}, ${y.toFixed(2)}`),
    pairRow('LFO rate', 'voice-rx', 'voice-ry', 0.01, (x) => set({ lfoRate: x }), (y) => set({ lfoRateY: y }), null, (x, y) => `${x.toFixed(2)}, ${y.toFixed(2)}`),
  ];
  const [pWinFrom, pWinTo, pPos, pDepth, pRate] = pairs;
  for (const p of [pPos, pDepth]) p.setRange(0, 1, 0, 1);
  pRate.setRange(LFO_RATE_MIN, LFO_RATE_MAX, LFO_RATE_MIN, LFO_RATE_MAX);
  const rows2d = h(
    'div',
    { class: 'vpairs', id: 'voice-2d' },
    h('span', {}),
    h('span', { class: 'vpair-axis' }, 'X →'),
    h('span', { class: 'vpair-axis' }, 'Y ↓'),
    h('span', {}),
    ...pairs.flatMap((p) => p.cells),
  );

  const scope = h('canvas', { id: 'voice-scope', role: 'img', 'aria-label': 'Now playing: waveform (spectrum behind)' });
  const scopeLabel = h('span', { class: 'plot-tag', id: 'voice-now' });
  const env = h('canvas', { id: 'voice-env', role: 'img', 'aria-label': 'Amplitude envelope' });
  const envLabel = h('span', { class: 'plot-tag', id: 'voice-env-label' });
  const scopeBox = h('div', { class: 'plot-box voice-scope' }, scope, scopeLabel);
  const envBox = h('div', { class: 'plot-box voice-env' }, env, envLabel);
  const pad = createVoicePad(model, bridge);
  const padBox = h('div', { class: 'plot-box voice-pad', hidden: true }, pad.canvas);
  watchVisibility(scope);
  watchVisibility(pad.canvas);

  const synthPanel = buildSynthPanel(model, bridge, ui);
  synthPanel.el.hidden = true;
  const empty = h('p', { class: 'hint voice-empty', hidden: true }, 'No voices. Add one with +.');
  const body = h(
    'div',
    { class: 'voice-cols', id: 'voice-panel', role: 'tabpanel' },
    h(
      'div',
      { class: 'voice-main' },
      h(
        'div',
        { class: 'voice-top' },
        h('label', { class: 'inline-field' }, h('span', {}, 'Wavetable'), wtSel),
        interpLabel,
        h('div', { class: 'seg stepper', role: 'group', 'aria-label': 'Octave' }, octDown, octLabel, octUp),
      ),
      rows1d,
      rows2d,
      h('div', { class: 'vrows' }, level.el),
    ),
    h('div', { class: 'voice-side' }, h('div', { class: 'voice-type-row' }, h('span', { class: 'voice-type-label' }, 'Voice type'), typeSlot), padBox, scopeBox, envBox, h('div', { class: 'vrows vrows-adsr' }, att.el, dec.el, sus.el, rel.el)),
  );
  sec.body.append(empty, body, synthPanel.el);

  let dirtyScope = true;
  let dirtyEnv = true;
  let dirtyPad = true;
  const mix = new Mix();
  /** The mixed waveform shown by the scope (rebuilt only when the mix changes). */
  let scopeKey = '';
  let scopeData: Float32Array | null = null;

  const is2d = (v: VoiceParams) => model.wavetable(v.wavetableId)?.shape !== '1d';

  const sync = () => {
    renderTabs();
    addBtn.disabled = model.voices.length >= MAX_VOICES;
    sec.meta.textContent = `${model.voices.length} / ${MAX_VOICES}`;
    const v = cur();
    const synth = v?.type === 'synth';
    body.hidden = !v || synth;
    synthPanel.el.hidden = !v || !synth;
    empty.hidden = !!v;
    muteBtn.hidden = removeBtn.hidden = typeSel.hidden = !v;
    if (!v) return;
    typeSel.value = v.type;
    // The type select sits in the Simple body's top row, or in the Synth body's section tabs.
    const slot = synth ? synthPanel.typeSlot : typeSlot;
    if (typeSel.parentElement !== slot) slot.append(typeSel);
    sec.el.dataset.voiceType = v.type;
    muteBtn.textContent = v.mute ? 'Unmute' : 'Mute';
    muteBtn.setAttribute('aria-pressed', String(v.mute));
    muteBtn.setAttribute('aria-label', `${v.mute ? 'Unmute' : 'Mute'} ${v.name}`);
    muteBtn.title = `${v.mute ? 'Unmute' : 'Mute'} ${v.name} (M)`;
    removeBtn.replaceChildren(icon(ICONS.close));
    removeBtn.setAttribute('aria-label', `Remove ${v.name}`);
    removeBtn.title = `Remove ${v.name}`;
    if (synth) {
      synthPanel.el.setAttribute('aria-labelledby', `voice-tab-${v.id}`);
      synthPanel.sync(v);
      return;
    }
    const color = `var(${voiceColorVar(v.id - 1)})`;
    body.style.setProperty('--vc', color);
    body.setAttribute('aria-labelledby', `voice-tab-${v.id}`);
    fillWt();
    wtSel.value = String(v.wavetableId);
    const wt = model.wavetable(v.wavetableId);
    const two = !!wt && wt.shape !== '1d';
    const isRows = wt?.shape === 'rows';
    body.dataset.shape = wt?.shape ?? '';
    rows1d.hidden = two;
    rows2d.hidden = !two;
    padBox.hidden = !two;
    envBox.hidden = two;
    interpLabel.textContent = `${wt?.interp === 'step' ? 'Step' : 'Blend'} · set on wavetable`;
    if (two && wt) {
      const W = Math.max(1, wt.rows[0]?.length ?? 1);
      const H = Math.max(1, wt.rows.length);
      // Rows: X spans each whole row (positions align proportionally), so no X window.
      for (const p of [pWinFrom, pWinTo]) {
        p.setRange(0, isRows ? 0 : W - 1, 0, H - 1);
        p.x.disabled = isRows;
      }
      pWinFrom.set(v.windowStart, v.windowStartY);
      pWinTo.set(v.windowEnd, v.windowEndY);
      pPos.set(v.position, v.positionY);
      pDepth.set(v.lfoDepth, v.lfoDepthY);
      pRate.set(v.lfoRate, v.lfoRateY);
      pad.canvas.title = isRows ? 'Rows: X is the same fraction of every row' : '';
    } else {
      const max = Math.max(0, (wt?.rows[0]?.length ?? 0) - 1);
      ws.setRange(0, max);
      we.setRange(0, max);
      ws.set(v.windowStart);
      we.set(v.windowEnd);
      pos.set(v.position);
      depth.set(v.lfoDepth);
      rate.set(v.lfoRate);
    }
    level.set(v.level);
    att.set(v.attack);
    dec.set(v.decay);
    sus.set(v.sustain);
    rel.set(v.release);
    octLabel.textContent = `Oct ${v.octave > 0 ? '+' : v.octave < 0 ? '−' : ''}${Math.abs(v.octave)}`;
    octDown.disabled = v.octave <= OCT_MIN;
    octUp.disabled = v.octave >= OCT_MAX;
    envLabel.textContent = `A ${secs(v.attack)} · D ${secs(v.decay)} · S ${pct(v.sustain)} · R ${secs(v.release)}`;
    dirtyScope = dirtyEnv = dirtyPad = true;
  };

  const drawScope = (v: VoiceParams) => {
    const wt = model.wavetable(v.wavetableId);
    const m = playingMix(model, bridge, v, mix);
    let key = '';
    for (let k = 0; k < m.n; k++) key += `${m.ids[k]}:${m.w[k].toFixed(3)} `;
    if (key !== scopeKey) {
      scopeKey = key;
      scopeData = null;
      if (m.n === 1) scopeData = model.table(m.ids[0])?.data ?? null;
      else if (m.n > 1) {
        const out = new Float32Array(TABLE_SIZE);
        for (let k = 0; k < m.n; k++) {
          const t = model.table(m.ids[k]);
          if (!t) continue;
          const w = m.w[k];
          for (let i = 0; i < TABLE_SIZE; i++) out[i] += w * t.data[i];
        }
        scopeData = out;
      }
    }
    const step = wt?.interp === 'step';
    let where = '—';
    if (m.n && wt) {
      if (wt.shape === '1d') where = `#${step ? m.x + 1 : (m.x + 1).toFixed(1)}`;
      else if (wt.shape === '2d') where = step ? `${m.x}, ${m.y}` : `${m.x.toFixed(1)}, ${m.y.toFixed(1)}`;
      else where = `row ${step ? m.y + 1 : (m.y + 1).toFixed(1)}`;
    }
    scopeLabel.textContent = `Now playing ${where}`;
    const [g, w, hh] = fit(scope, Math.max(30, scopeBox.clientHeight || 70));
    if (!scopeData) return;
    const color = cssColor(voiceColorVar(v.id - 1));
    g.save();
    g.globalAlpha = 0.3;
    drawSpectrum(g, w, hh, scopeData, color);
    g.restore();
    drawWave(g, 0, 0, w, hh, scopeData, color, { axis: cssColor('--border'), lineWidth: 1.75 });
  };

  /** ADSR graph: attack / decay / release widths ∝ √time, a fixed sustain plateau. */
  const drawEnv = (v: VoiceParams) => {
    const [g, w, hh] = fit(env, Math.max(30, envBox.clientHeight || 60));
    const color = cssColor(voiceColorVar(v.id - 1));
    const pad = 4;
    const top = 16;
    const bottom = hh - pad;
    const a = Math.sqrt(v.attack);
    const d = Math.sqrt(v.decay);
    const r = Math.sqrt(v.release);
    const hold = (a + d + r) * 0.35 + 0.05;
    const k = (w - 2 * pad) / (a + d + hold + r);
    const ys = bottom - (bottom - top) * v.sustain;
    const x1 = pad + a * k;
    const x2 = x1 + d * k;
    const x3 = x2 + hold * k;
    const x4 = x3 + r * k;
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
  };

  model.on('voices', sync);
  model.on('timeline', () => {
    sync();
    dirtyScope = dirtyPad = true;
  });
  model.on('wavetables', () => {
    sync();
    dirtyScope = dirtyPad = true;
  });
  ui.onVoice(sync);
  onThemeChange(() => (dirtyScope = dirtyEnv = dirtyPad = true));
  sec.onToggle(() => {
    dirtyScope = dirtyEnv = dirtyPad = true;
    synthPanel.markDirty();
  });

  new ResizeObserver(() => (dirtyScope = dirtyEnv = dirtyPad = true)).observe(body);
  sync();

  return {
    el: sec.el,
    view: {
      frame() {
        const v = cur();
        if (!v || !sec.isOpen()) return;
        if (v.type === 'synth') return synthPanel.frame(v);
        if (isOnScreen(scope) && (dirtyScope || model.playing)) {
          dirtyScope = false;
          drawScope(v);
        }
        if (is2d(v)) {
          const wt = model.wavetable(v.wavetableId);
          if (wt && isOnScreen(pad.canvas) && (dirtyPad || model.playing)) {
            dirtyPad = false;
            pad.draw(v, wt, Math.max(40, padBox.clientHeight || 110));
          }
        } else if (dirtyEnv && isOnScreen(scope)) {
          dirtyEnv = false;
          drawEnv(v);
        }
      },
    },
  };
}

/**
 * One row of paired X / Y range inputs (label · X · Y · "x, y"): the cells go straight
 * into the `.vpairs` grid. `onCommit` ends a coalesced (undoable) drag.
 */
function pairRow(
  label: string,
  idX: string,
  idY: string,
  step: number,
  onX: (v: number) => void,
  onY: (v: number) => void,
  onCommit: (() => void) | null,
  fmt: (x: number, y: number) => string,
) {
  const mk = (id: string, axis: string, on: (v: number) => void) => {
    const input = h('input', { type: 'range', id, min: 0, max: 1, step, value: 0, 'aria-label': `${label} ${axis}` });
    input.addEventListener('input', () => {
      on(Number(input.value));
      val.textContent = fmt(Number(x.value), Number(y.value));
    });
    if (onCommit) input.addEventListener('change', onCommit);
    return input;
  };
  const val = h('span', { class: 'val vpair-val' });
  const x = mk(idX, 'X', onX);
  const y = mk(idY, 'Y', onY);
  const set1 = (el: HTMLInputElement, v: number) => {
    if (document.activeElement !== el || Number(el.value) !== v) el.value = String(v);
  };
  return {
    x,
    y,
    cells: [h('span', { class: 'vpair-label' }, label), x, y, val] as HTMLElement[],
    set(vx: number, vy: number) {
      set1(x, vx);
      set1(y, vy);
      val.textContent = fmt(vx, vy);
    },
    setRange(x0: number, x1: number, y0: number, y1: number) {
      x.min = String(x0);
      x.max = String(x1);
      y.min = String(y0);
      y.max = String(y1);
    },
  };
}
