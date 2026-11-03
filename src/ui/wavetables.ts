import { TABLE_SIZE } from '../core/constants';
import { wavetableLength, type WavetableId } from '../core/wavetable';
import { cssColor, fit, onThemeChange, parseColor } from './canvas';
import { isOnScreen, watchVisibility, type FrameView, type UiContext } from './context';
import { h, panel, voiceColorVar } from './dom';

/** Heat-map bitmap rows (phase resolution); scaled to the canvas. */
const HEAT_H = 96;
/** Window bars under the heat map: height and pitch per voice. */
const BAR_H = 3;
const BAR_PITCH = 4;

/**
 * Wavetables: ordered organisations of timeline tables. Only the auto "All" exists yet;
 * creating 1D / 2D wavetables is planned (the slot is reserved in the layout). The
 * overview is a heat map (x = table, y = phase, colour = amplitude) which scales to
 * thousands of tables, with voice windows and live play positions overlaid.
 */
export function buildWavetables(ctx: UiContext): { el: HTMLElement; view: FrameView } {
  const { model, bridge } = ctx;
  // Collapsed by default on the narrow shell: a placeholder until wavetable editing lands.
  const sec = panel('sec-wavetables', 'Wavetables', { collapsed: true });
  let current: WavetableId = model.wavetables[0].id;

  const soon = 'Planned: 1D / 2D wavetables from timeline tables';
  sec.tools.append(
    h('span', { class: 'grow' }),
    h('button', { class: 'small', disabled: true, title: soon }, '+ 1D'),
    h('button', { class: 'small', disabled: true, title: soon }, '+ 2D'),
  );

  const pick = h('div', { class: 'wt-list', role: 'group', 'aria-label': 'Wavetables' });
  const renderPick = () => {
    pick.replaceChildren(
      ...model.wavetables.map((w) => {
        const n = wavetableLength(w);
        const b = h(
          'button',
          {
            class: 'small wt-pick',
            'aria-pressed': String(w.id === current),
            onclick: () => {
              current = w.id;
              heatDirty = dirty = true;
              renderPick();
            },
          },
          `${w.name} · ${w.kind.toUpperCase()} · ${n}${w.auto ? ' · auto' : ''}`,
        );
        return b;
      }),
    );
  };
  const canvas = h('canvas', { id: 'wavetable-overview', 'aria-label': 'Wavetable overview; click to select a table' });
  const box = h('div', { class: 'wt-box' }, canvas);
  sec.body.append(
    pick,
    box,
    h('p', { class: 'hint wt-hint' }, 'x = table, y = phase, colour = amplitude. Bars: voice windows; lines: play positions.'),
    h('p', { class: 'hint wt-soon' }, 'Coming soon: build 1D and 2D wavetables from timeline tables.'),
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
    const voices = model.voices.filter((v) => v.wavetableId === current);
    const bars = voices.length * BAR_PITCH + 4;
    const [g, w, H] = fit(canvas, Math.max(48, box.clientHeight || 84));
    const heatH = Math.max(20, H - bars);
    if (heatDirty || heat.width !== Math.round(w)) {
      heatDirty = false;
      buildHeat(w);
    }
    g.imageSmoothingEnabled = false;
    g.drawImage(heat, 0, 0, w, heatH);
    const wt = model.wavetable(current);
    const len = wt ? wavetableLength(wt) : 0;
    if (!len) return;
    const cw = w / len;
    const live = new Map(bridge.status.voices.map((s) => [s.id, s]));
    voices.forEach((v, k) => {
      const col = cssColor(voiceColorVar(v.id - 1));
      g.globalAlpha = v.mute ? 0.35 : 0.9;
      g.fillStyle = col;
      g.fillRect(v.windowStart * cw, heatH + 3 + k * BAR_PITCH, (v.windowEnd - v.windowStart + 1) * cw, BAR_H);
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
      g.lineTo(x, heatH);
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
    sec.meta.textContent = `${model.wavetables.length}`;
    renderPick();
  };

  model.on('timeline', () => {
    heatDirty = dirty = true;
    updateInfo();
  });
  model.on('voices', () => (dirty = true));
  model.on('transport', () => (dirty = true));
  sec.onToggle(() => (dirty = true));
  new ResizeObserver(() => (dirty = true)).observe(box);
  onThemeChange(() => (heatDirty = dirty = true));
  updateInfo();

  return {
    el: sec.el,
    view: {
      frame() {
        if (!sec.isOpen() || !isOnScreen(canvas)) return;
        if (!dirty && !model.playing) return;
        dirty = false;
        draw();
      },
    },
  };
}
