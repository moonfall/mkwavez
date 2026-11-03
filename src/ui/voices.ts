import { MAX_VOICES } from '../app/model';
import type { VoiceParams } from '../core/voice';
import { wavetableLength } from '../core/wavetable';
import { cssColor, drawSpectrum, drawWave, fit, onThemeChange } from './canvas';
import { isOnScreen, watchVisibility, type FrameView, type UiContext } from './context';
import { h, icon, ICONS, panel, slider, voiceColorVar, type Slider } from './dom';

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
 * voice's controls — wavetable, Blend / Step, octave, window, position, LFO, level on the
 * left; a "now playing" scope, the ADSR envelope graph and its controls on the right.
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
  const tabs = h('div', { class: 'voice-tabs', role: 'tablist', 'aria-label': 'Voices', id: 'voice-tabs' });
  const addBtn = h('button', { id: 'add-voice', class: 'small icon-btn', 'aria-label': 'Add voice', title: 'Add voice', onclick: () => addVoice() }, icon(ICONS.plus));
  const muteBtn = h('button', { id: 'voice-mute', class: 'small', onclick: () => set({ mute: !cur()?.mute }) });
  const removeBtn = h('button', {
    id: 'voice-remove',
    class: 'small icon-btn',
    onclick: () => {
      if (ui.voiceId !== null) model.removeVoice(ui.voiceId);
    },
  });
  sec.tools.append(tabs, addBtn, h('span', { class: 'grow' }), muteBtn, removeBtn);

  const addVoice = () => {
    const v = model.addVoice();
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
  const fillWt = () => {
    wtSel.replaceChildren(...model.wavetables.map((w) => h('option', { value: String(w.id) }, `${w.name} (${wavetableLength(w)})`)));
  };
  const blendBtn = h('button', { id: 'voice-blend', onclick: () => set({ interp: 'blend' }) }, 'Blend');
  const stepBtn = h('button', { id: 'voice-step', onclick: () => set({ interp: 'step' }) }, 'Step');
  const octLabel = h('span', { class: 'oct-label', id: 'voice-octave' });
  const octDown = h('button', { 'aria-label': 'Octave down', onclick: () => set({ octave: Math.max(OCT_MIN, (cur()?.octave ?? 0) - 1) }) }, '−');
  const octUp = h('button', { 'aria-label': 'Octave up', onclick: () => set({ octave: Math.min(OCT_MAX, (cur()?.octave ?? 0) + 1) }) }, '+');

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
  const rate = slider({ label: 'LFO rate', min: 0.02, max: 4, step: 0.01, value: 0.02, format: (x) => `${x.toFixed(2)} Hz`, onInput: (x) => set({ lfoRate: x }) });
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

  const scope = h('canvas', { id: 'voice-scope', role: 'img', 'aria-label': 'Now playing: waveform (spectrum behind)' });
  const scopeLabel = h('span', { class: 'plot-tag', id: 'voice-now' });
  const env = h('canvas', { id: 'voice-env', role: 'img', 'aria-label': 'Amplitude envelope' });
  const envLabel = h('span', { class: 'plot-tag', id: 'voice-env-label' });
  const scopeBox = h('div', { class: 'plot-box voice-scope' }, scope, scopeLabel);
  const envBox = h('div', { class: 'plot-box voice-env' }, env, envLabel);
  watchVisibility(scope);

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
        h('label', { class: 'inline-field' }, h('span', {}, 'Table'), wtSel),
        h('div', { class: 'seg', role: 'group', 'aria-label': 'Interpolation' }, blendBtn, stepBtn),
        h('div', { class: 'seg stepper', role: 'group', 'aria-label': 'Octave' }, octDown, octLabel, octUp),
      ),
      h('div', { class: 'vrows' }, ws.el, we.el, pos.el, depth.el, rate.el, level.el),
    ),
    h('div', { class: 'voice-side' }, scopeBox, envBox, h('div', { class: 'vrows vrows-adsr' }, att.el, dec.el, sus.el, rel.el)),
  );
  sec.body.append(empty, body);

  let dirtyScope = true;
  let dirtyEnv = true;

  /** Tables + crossfade the voice is (or would be) playing, from live status when running. */
  const playing = (v: VoiceParams) => {
    const st = model.playing ? bridge.status.voices.find((s) => s.id === v.id) : undefined;
    let f = st ? st.index : v.windowStart + v.position * (v.windowEnd - v.windowStart);
    if (v.interp === 'step') f = Math.round(f);
    const i = Math.floor(f);
    const j = Math.min(i + 1, v.windowEnd);
    return { f, A: model.tableAt(v.wavetableId, i), B: model.tableAt(v.wavetableId, j), frac: f - i };
  };

  const sync = () => {
    renderTabs();
    addBtn.disabled = model.voices.length >= MAX_VOICES;
    sec.meta.textContent = `${model.voices.length} / ${MAX_VOICES}`;
    const v = cur();
    body.hidden = !v;
    empty.hidden = !!v;
    muteBtn.hidden = removeBtn.hidden = !v;
    if (!v) return;
    const color = `var(${voiceColorVar(v.id - 1)})`;
    body.style.setProperty('--vc', color);
    body.setAttribute('aria-labelledby', `voice-tab-${v.id}`);
    if (wtSel.options.length !== model.wavetables.length) fillWt();
    else for (const [i, w] of model.wavetables.entries()) wtSel.options[i].textContent = `${w.name} (${wavetableLength(w)})`;
    wtSel.value = String(v.wavetableId);
    const wt = model.wavetable(v.wavetableId);
    const max = Math.max(0, (wt ? wavetableLength(wt) : 0) - 1);
    ws.setRange(0, max);
    we.setRange(0, max);
    ws.set(v.windowStart);
    we.set(v.windowEnd);
    pos.set(v.position);
    depth.set(v.lfoDepth);
    rate.set(v.lfoRate);
    level.set(v.level);
    att.set(v.attack);
    dec.set(v.decay);
    sus.set(v.sustain);
    rel.set(v.release);
    for (const [b, on] of [
      [blendBtn, v.interp === 'blend'],
      [stepBtn, v.interp === 'step'],
    ] as const) {
      b.classList.toggle('seg-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    octLabel.textContent = `Oct ${v.octave > 0 ? '+' : v.octave < 0 ? '−' : ''}${Math.abs(v.octave)}`;
    octDown.disabled = v.octave <= OCT_MIN;
    octUp.disabled = v.octave >= OCT_MAX;
    muteBtn.textContent = v.mute ? 'Unmute' : 'Mute';
    muteBtn.setAttribute('aria-pressed', String(v.mute));
    muteBtn.setAttribute('aria-label', `${v.mute ? 'Unmute' : 'Mute'} ${v.name}`);
    removeBtn.replaceChildren(icon(ICONS.close));
    removeBtn.setAttribute('aria-label', `Remove ${v.name}`);
    removeBtn.title = `Remove ${v.name}`;
    envLabel.textContent = `A ${secs(v.attack)} · D ${secs(v.decay)} · S ${pct(v.sustain)} · R ${secs(v.release)}`;
    dirtyScope = dirtyEnv = true;
  };

  const drawScope = (v: VoiceParams) => {
    const p = playing(v);
    scopeLabel.textContent = p.A ? `Now playing #${v.interp === 'step' ? p.f + 1 : (p.f + 1).toFixed(1)}` : 'Now playing —';
    const [g, w, hh] = fit(scope, Math.max(30, scopeBox.clientHeight || 70));
    if (!p.A) return;
    const B = p.B ?? p.A;
    const blend = v.interp === 'blend';
    const color = cssColor(voiceColorVar(v.id - 1));
    g.save();
    g.globalAlpha = 0.3;
    drawSpectrum(g, w, hh, p.A.data, color, { B: blend ? B.data : undefined, frac: blend ? p.frac : 0 });
    g.restore();
    drawWave(g, 0, 0, w, hh, p.A.data, color, { B: blend ? B.data : undefined, frac: blend ? p.frac : 0, axis: cssColor('--border'), lineWidth: 1.75 });
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
    dirtyScope = true;
  });
  ui.onVoice(sync);
  onThemeChange(() => (dirtyScope = dirtyEnv = true));
  sec.onToggle(() => (dirtyScope = dirtyEnv = true));
  new ResizeObserver(() => (dirtyScope = dirtyEnv = true)).observe(body);
  fillWt();
  sync();

  return {
    el: sec.el,
    view: {
      frame() {
        const v = cur();
        if (!v || !sec.isOpen() || !isOnScreen(scope)) return;
        if (dirtyScope || model.playing) {
          dirtyScope = false;
          drawScope(v);
        }
        if (dirtyEnv) {
          dirtyEnv = false;
          drawEnv(v);
        }
      },
    },
  };
}
