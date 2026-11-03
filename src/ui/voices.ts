import { MAX_VOICES } from '../app/model';
import type { VoiceParams } from '../core/voice';
import { wavetableLength } from '../core/wavetable';
import { cssColor, drawSpectrum, drawWave, fit, onThemeChange } from './canvas';
import { isOnScreen, watchVisibility, type FrameView, type UiContext } from './context';
import { h, icon, ICONS, section, slider, voiceColorVar, type Slider } from './dom';

const VIEW_H = 60;

interface Card {
  el: HTMLElement;
  sync(v: VoiceParams): void;
  draw(): void;
  dirty: boolean;
  wave: HTMLCanvasElement;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const secs = (v: number) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);

/** Slider over seconds with a quadratic taper (fine control of short times). */
function timeSlider(label: string, maxSec: number, value: number, onInput: (s: number) => void): Slider {
  const toU = (s: number) => Math.sqrt(Math.max(0, s - 0.001) / maxSec);
  const toS = (u: number) => 0.001 + maxSec * u * u;
  const s = slider({ label, min: 0, max: 1, step: 0.001, value: toU(value), format: (u) => secs(toS(u)), onInput: (u) => onInput(toS(u)) });
  return { ...s, set: (sec: number) => s.set(toU(sec)) };
}

export function buildVoices(ctx: UiContext): { el: HTMLElement; view: FrameView } {
  const { model, bridge } = ctx;
  const sec = section('sec-voices', 'Voices');
  const list = h('div', { id: 'voice-list' });
  const addBtn = h('button', { id: 'add-voice', onclick: () => addVoice() }, '+ Add voice');
  sec.body.append(list, h('div', { class: 'add-row' }, addBtn));
  const cards = new Map<number, Card>();

  const addVoice = () => {
    const v = model.addVoice();
    if (v) model.addSequence(v.id);
  };

  /** Tables + crossfade the voice is (or would be) playing, from live status when running. */
  const playing = (v: VoiceParams) => {
    const st = model.playing ? bridge.status.voices.find((s) => s.id === v.id) : undefined;
    let f = st ? st.index : v.windowStart + v.position * (v.windowEnd - v.windowStart);
    if (v.interp === 'step') f = Math.round(f);
    const i = Math.floor(f);
    const j = Math.min(i + 1, v.windowEnd);
    return {
      f,
      A: model.tableAt(v.wavetableId, i),
      B: model.tableAt(v.wavetableId, j),
      frac: f - i,
    };
  };

  const makeCard = (v0: VoiceParams): Card => {
    const id = v0.id;
    let v = v0;
    const set = (patch: Partial<VoiceParams>) => model.updateVoice(id, patch);
    const color = () => cssColor(voiceColorVar(id - 1));

    const meta = h('span', { class: 'meta' });
    const muteBtn = h('button', {
      class: 'small',
      onclick: () => set({ mute: !v.mute }),
    });
    const removeBtn = h(
      'button',
      { class: 'small', 'aria-label': `Remove ${v.name}`, onclick: () => model.removeVoice(id) },
      icon(ICONS.close),
    );
    const head = h(
      'div',
      { class: 'card-head' },
      h('span', { class: 'dot', style: `background:var(${voiceColorVar(id - 1)})` }),
      h('span', { class: 'name', style: `color:var(${voiceColorVar(id - 1)})` }, v.name),
      meta,
      muteBtn,
      removeBtn,
    );
    const wave = h('canvas', { 'aria-label': `${v.name} current waveform` });
    const spec = h('canvas', { 'aria-label': `${v.name} current spectrum` });
    watchVisibility(wave);

    const wtSel = h('select', { 'aria-label': `${v.name} wavetable` });
    const fillWt = () => {
      wtSel.replaceChildren(...model.wavetables.map((w) => h('option', { value: String(w.id) }, w.name)));
      wtSel.value = String(v.wavetableId);
    };
    fillWt();
    wtSel.addEventListener('change', () => set({ wavetableId: Number(wtSel.value) }));

    const ws = slider({ label: 'Window start', min: 0, max: 0, step: 1, value: v.windowStart, format: (x) => `#${x + 1}`, onInput: (x) => set({ windowStart: x }) });
    const we = slider({ label: 'Window end', min: 0, max: 0, step: 1, value: v.windowEnd, format: (x) => `#${x + 1}`, onInput: (x) => set({ windowEnd: x }) });
    const pos = slider({ label: 'Position', min: 0, max: 1, step: 0.01, value: v.position, format: pct, onInput: (x) => set({ position: x }) });
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
    const depth = slider({ label: 'LFO depth', min: 0, max: 1, step: 0.01, value: v.lfoDepth, format: pct, onInput: (x) => set({ lfoDepth: x }), extra: fullBtn });
    const rate = slider({ label: 'LFO rate', min: 0.02, max: 4, step: 0.01, value: v.lfoRate, format: (x) => `${x.toFixed(2)} Hz`, onInput: (x) => set({ lfoRate: x }) });
    const level = slider({ label: 'Level', min: 0, max: 1, step: 0.01, value: v.level, format: pct, onInput: (x) => set({ level: x }) });

    const octSel = h('select', { 'aria-label': `${v.name} octave` });
    for (const o of [-2, -1, 0, 1, 2]) octSel.append(h('option', { value: String(o) }, o > 0 ? `+${o}` : o < 0 ? `−${-o}` : '0'));
    octSel.addEventListener('change', () => set({ octave: Number(octSel.value) }));
    const ipSel = h('select', { 'aria-label': `${v.name} interpolation` }, h('option', { value: 'blend' }, 'Blend'), h('option', { value: 'step' }, 'Step'));
    ipSel.addEventListener('change', () => set({ interp: ipSel.value as VoiceParams['interp'] }));

    const att = timeSlider('Attack', 2, v.attack, (x) => set({ attack: x }));
    const dec = timeSlider('Decay', 4, v.decay, (x) => set({ decay: x }));
    const sus = slider({ label: 'Sustain', min: 0, max: 1, step: 0.01, value: v.sustain, format: pct, onInput: (x) => set({ sustain: x }) });
    const rel = timeSlider('Release', 4, v.release, (x) => set({ release: x }));

    const el = h(
      'div',
      { class: 'card', id: `voice-${id}` },
      head,
      h('div', { class: 'grid2' }, wave, spec),
      h(
        'div',
        { class: 'grid2' },
        h('div', { class: 'field' }, h('div', { class: 'label' }, h('span', {}, 'Wavetable')), wtSel),
        h(
          'div',
          { class: 'field' },
          h('div', { class: 'label' }, h('span', {}, 'Octave'), h('span', {}, 'Interp')),
          h('div', { style: 'display:flex;gap:6px' }, octSel, ipSel),
        ),
        ws.el,
        we.el,
        pos.el,
        depth.el,
        rate.el,
        level.el,
      ),
      h('div', { class: 'grid2 grid4' }, att.el, dec.el, sus.el, rel.el),
    );

    const card: Card = {
      el,
      wave,
      dirty: true,
      sync(nv) {
        v = nv;
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
        octSel.value = String(v.octave);
        ipSel.value = v.interp;
        if (wtSel.options.length !== model.wavetables.length) fillWt();
        wtSel.value = String(v.wavetableId);
        muteBtn.replaceChildren(icon(v.mute ? ICONS.mute : ICONS.volume));
        muteBtn.setAttribute('aria-label', `${v.mute ? 'Unmute' : 'Mute'} ${v.name}`);
        muteBtn.setAttribute('aria-pressed', String(v.mute));
        muteBtn.style.color = v.mute ? 'var(--muted)' : `var(${voiceColorVar(id - 1)})`;
        el.style.opacity = v.mute ? '0.75' : '1';
        card.dirty = true;
      },
      draw() {
        const p = playing(v);
        meta.textContent = p.A ? `#${v.interp === 'step' ? p.f + 1 : (p.f + 1).toFixed(1)}` : '—';
        const [g, w, hh] = fit(wave, VIEW_H);
        const [g2, w2, h2] = fit(spec, VIEW_H);
        if (!p.A) return;
        const B = p.B ?? p.A;
        const blend = v.interp === 'blend';
        drawWave(g, 0, 0, w, hh, p.A.data, color(), { B: blend ? B.data : undefined, frac: blend ? p.frac : 0, axis: cssColor('--border'), lineWidth: 1.75 });
        drawSpectrum(g2, w2, h2, p.A.data, color(), { B: blend ? B.data : undefined, frac: blend ? p.frac : 0 });
      },
    };
    card.sync(v);
    return card;
  };

  const sync = () => {
    const live = new Set(model.voices.map((v) => v.id));
    for (const [id, c] of cards) {
      if (!live.has(id)) {
        c.el.remove();
        cards.delete(id);
      }
    }
    for (const v of model.voices) {
      let c = cards.get(v.id);
      if (!c) {
        c = makeCard(v);
        cards.set(v.id, c);
        list.append(c.el);
      } else c.sync(v);
    }
    addBtn.disabled = model.voices.length >= MAX_VOICES;
    sec.meta.textContent = `${model.voices.length}`;
  };

  model.on('voices', sync);
  model.on('timeline', () => {
    for (const c of cards.values()) c.dirty = true;
  });
  onThemeChange(() => {
    for (const c of cards.values()) c.dirty = true;
  });
  sec.el.addEventListener('toggle', () => {
    for (const c of cards.values()) c.dirty = true;
  });
  sync();

  return {
    el: sec.el,
    view: {
      frame() {
        if (!sec.el.open) return;
        for (const c of cards.values()) {
          if ((c.dirty || model.playing) && isOnScreen(c.wave)) {
            c.dirty = false;
            c.draw();
          }
        }
      },
    },
  };
}
