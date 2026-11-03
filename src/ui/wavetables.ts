import { TABLE_SIZE } from '../core/constants';
import { wavetableLength, type WavetableId } from '../core/wavetable';
import { cssColor, fit, onThemeChange, parseColor } from './canvas';
import { isOnScreen, watchVisibility, type FrameView, type UiContext } from './context';
import { h, section, selectField, voiceColorVar } from './dom';

const VIEW_H = 84;
const HEAT_H = 64;

/**
 * Wavetables: ordered organisations of timeline tables. M1 has only the auto "All".
 * The overview is a heat map (x = table, y = phase, colour = amplitude) which scales
 * to thousands of tables, with voice windows and live play positions overlaid.
 */
export function buildWavetables(ctx: UiContext): { el: HTMLElement; view: FrameView } {
  const { model, bridge } = ctx;
  // Starts collapsed: a placeholder until wavetable editing lands.
  const sec = section('sec-wavetables', 'Wavetables', false);
  let current: WavetableId = model.wavetables[0].id;

  const pick = selectField(
    'Wavetable',
    model.wavetables.map((w) => [String(w.id), w.name]),
    String(current),
    (v) => {
      current = Number(v);
      heatDirty = dirty = true;
    },
  );
  const info = h('div', { class: 'hint', style: 'margin:0' });
  const canvas = h('canvas', { id: 'wavetable-overview', 'aria-label': 'Wavetable overview; click to select a table' });
  sec.body.append(
    h('div', { class: 'grid2' }, pick.el, h('div', { class: 'field', style: 'align-self:end' }, info)),
    canvas,
    h(
      'p',
      { class: 'hint', style: 'margin-top:6px' },
      'x = table, y = phase, colour = amplitude. Bars show voice windows; lines show play positions.',
    ),
  );
  watchVisibility(canvas);

  const heat = document.createElement('canvas');
  let heatDirty = true;
  let dirty = true;

  const buildHeat = (w: number) => {
    const wt = model.wavetable(current);
    const len = wt ? wavetableLength(wt) : 0;
    heat.width = Math.max(1, Math.round(w));
    heat.height = HEAT_H;
    const g = heat.getContext('2d')!;
    const img = g.createImageData(heat.width, HEAT_H);
    const lo = parseColor(cssColor('--heat-lo'));
    const mid = parseColor(cssColor('--heat-mid'));
    const hi = parseColor(cssColor('--heat-hi'));
    const d = img.data;
    for (let x = 0; x < heat.width; x++) {
      const t = len ? model.tableAt(current, Math.min(len - 1, Math.floor((x / heat.width) * len))) : undefined;
      for (let y = 0; y < HEAT_H; y++) {
        const o = (y * heat.width + x) * 4;
        const v = t ? t.data[Math.floor((y / HEAT_H) * TABLE_SIZE)] : 0;
        const a = Math.min(1, Math.abs(v));
        const c = v < 0 ? lo : hi;
        d[o] = mid[0] + (c[0] - mid[0]) * a;
        d[o + 1] = mid[1] + (c[1] - mid[1]) * a;
        d[o + 2] = mid[2] + (c[2] - mid[2]) * a;
        d[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  };

  const draw = () => {
    const [g, w] = fit(canvas, VIEW_H);
    if (heatDirty || heat.width !== Math.round(w)) {
      heatDirty = false;
      buildHeat(w);
    }
    g.imageSmoothingEnabled = false;
    g.drawImage(heat, 0, 0, w, HEAT_H);
    const wt = model.wavetable(current);
    const len = wt ? wavetableLength(wt) : 0;
    if (!len) return;
    const cw = w / len;
    const voices = model.voices.filter((v) => v.wavetableId === current);
    const live = new Map(bridge.status.voices.map((s) => [s.id, s]));
    voices.forEach((v, k) => {
      const col = cssColor(voiceColorVar(v.id - 1));
      g.globalAlpha = v.mute ? 0.35 : 0.9;
      g.fillStyle = col;
      g.fillRect(v.windowStart * cw, HEAT_H + 4 + k * 4, (v.windowEnd - v.windowStart + 1) * cw, 3);
      const st = model.playing ? live.get(v.id) : undefined;
      let f: number;
      if (st) f = st.index;
      else {
        f = v.windowStart + v.position * (v.windowEnd - v.windowStart);
        if (v.interp === 'step') f = Math.round(f);
      }
      const x = (f + 0.5) * cw;
      g.strokeStyle = col;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, HEAT_H);
      g.stroke();
      g.globalAlpha = 1;
    });
  };

  canvas.addEventListener('click', (e) => {
    const wt = model.wavetable(current);
    if (!wt) return;
    const len = wavetableLength(wt);
    const r = canvas.getBoundingClientRect();
    const idx = Math.floor(((e.clientX - r.left) / r.width) * len);
    const t = model.tableAt(current, idx);
    if (t) model.select(t.id);
  });

  const updateInfo = () => {
    const wt = model.wavetable(current);
    const n = wt ? wavetableLength(wt) : 0;
    info.textContent = wt ? `${wt.kind.toUpperCase()} · ${n} tables${wt.auto ? ' · auto' : ''}` : '';
    sec.meta.textContent = `${model.wavetables.length}`;
  };

  model.on('timeline', () => {
    heatDirty = dirty = true;
    updateInfo();
  });
  model.on('voices', () => (dirty = true));
  model.on('transport', () => (dirty = true));
  sec.el.addEventListener('toggle', () => (dirty = true));
  new ResizeObserver(() => (dirty = true)).observe(canvas);
  onThemeChange(() => (heatDirty = dirty = true));
  updateInfo();

  return {
    el: sec.el,
    view: {
      frame() {
        if (!sec.el.open || !isOnScreen(canvas)) return;
        if (!dirty && !model.playing) return;
        dirty = false;
        draw();
      },
    },
  };
}
