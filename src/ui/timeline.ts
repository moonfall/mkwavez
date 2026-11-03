import { describeRecipe } from '../core/table';
import { ALL_WAVETABLE_ID } from '../core/wavetable';
import { cssColor, drawSpectrum, drawWave, fit, onThemeChange } from './canvas';
import { isOnScreen, watchVisibility, type FrameView, type UiContext } from './context';
import { h, section, voiceColorVar } from './dom';

const CELL_MIN_W = 56;
const CELL_H = 42;
const MAX_VIEW_H = 186;
const SEL_H = 76;

/**
 * Timeline: every table ever generated (up to the cap), as a virtualized grid of
 * thumbnails drawn on one sticky canvas — only visible rows are drawn, and only when
 * something changed. Click selects; the selection is shown larger with its spectrum.
 */
export function buildTimeline(ctx: UiContext): { el: HTMLElement; view: FrameView } {
  const { model } = ctx;
  const sec = section('sec-timeline', 'Timeline');

  const selLabel = h('div', { class: 'sel-label', id: 'timeline-selected' });
  const selWave = h('canvas', { 'aria-label': 'Selected table waveform' });
  const selSpec = h('canvas', { 'aria-label': 'Selected table spectrum' });
  const grid = h('canvas', { 'aria-label': 'Timeline of all tables; click to select', id: 'timeline-grid' });
  const spacer = h('div');
  const scroller = h('div', { class: 'tl-scroll' }, grid, spacer);
  sec.body.append(
    h('div', { class: 'row', style: 'margin-bottom:4px' }, selLabel),
    h('div', { class: 'sel-view' }, selWave, selSpec),
    scroller,
  );
  watchVisibility(grid);
  watchVisibility(selWave);

  let dirtyGrid = true;
  let dirtySel = true;
  let cols = 1;
  let cellW = CELL_MIN_W;

  const layout = () => {
    const w = scroller.clientWidth || 300;
    cols = Math.max(4, Math.floor(w / CELL_MIN_W));
    cellW = w / cols;
    const rows = Math.ceil(model.timeline.length / cols) || 1;
    const total = rows * CELL_H;
    const view = Math.min(total, MAX_VIEW_H);
    scroller.style.height = `${view + 2}px`;
    spacer.style.height = `${total - view}px`;
    return view;
  };

  const scrollToIndex = (idx: number, force = false) => {
    if (idx < 0) return;
    layout();
    const row = Math.floor(idx / cols);
    const top = row * CELL_H;
    const view = scroller.clientHeight;
    if (force || top < scroller.scrollTop || top + CELL_H > scroller.scrollTop + view) {
      scroller.scrollTop = Math.max(0, top - view + CELL_H + 4);
    }
  };

  const drawGrid = () => {
    const viewH = layout();
    const [g] = fit(grid, viewH);
    const n = model.timeline.length;
    const top = scroller.scrollTop;
    const firstRow = Math.floor(top / CELL_H);
    const yOff = -(top % CELL_H);
    const selIdx = model.indexOf(model.selectedId);
    const newest = n - 1;
    const cText = cssColor('--text');
    const cMuted = cssColor('--text-2');
    const cNew = cssColor('--new');
    const cSelBg = cssColor('--accent-bg');
    const cBorder = cssColor('--border');
    const cLabel = cssColor('--muted');
    const voices = model.voices.filter((v) => v.wavetableId === ALL_WAVETABLE_ID);
    const vColors = voices.map((v) => cssColor(voiceColorVar(v.id - 1)));
    g.font = '9px ui-monospace, monospace';
    g.textBaseline = 'top';
    for (let r = 0; r * CELL_H + yOff < viewH; r++) {
      const row = firstRow + r;
      const y = r * CELL_H + yOff;
      for (let c = 0; c < cols; c++) {
        const idx = row * cols + c;
        if (idx >= n) break;
        const t = model.timeline[idx];
        const x = c * cellW;
        if (idx === selIdx) {
          g.fillStyle = cSelBg;
          g.fillRect(x, y, cellW, CELL_H);
        }
        g.strokeStyle = cBorder;
        g.lineWidth = 1;
        g.strokeRect(x + 0.5, y + 0.5, cellW - 1, CELL_H - 1);
        drawWave(g, x + 3, y + 3, cellW - 6, CELL_H - 12, t.data, idx === selIdx ? cText : idx === newest ? cNew : cMuted, {
          points: 28,
          lineWidth: idx === selIdx || idx === newest ? 1.6 : 1,
        });
        g.fillStyle = cLabel;
        g.fillText(String(idx + 1), x + 3, y + 2);
        voices.forEach((v, k) => {
          if (idx >= v.windowStart && idx <= v.windowEnd) {
            g.fillStyle = vColors[k];
            g.globalAlpha = v.mute ? 0.35 : 0.9;
            g.fillRect(x + 1, y + CELL_H - 3 - k * 3, cellW - 2, 2);
            g.globalAlpha = 1;
          }
        });
      }
    }
  };

  const drawSelection = () => {
    const t = model.table(model.selectedId);
    const idx = model.indexOf(model.selectedId);
    selLabel.textContent = t ? `#${idx + 1} · id ${t.id} · ${describeRecipe(t.recipe)}` : 'Nothing selected';
    const [g, w, hh] = fit(selWave, SEL_H);
    const [g2, w2, h2] = fit(selSpec, SEL_H);
    if (!t) return;
    drawWave(g, 0, 0, w, hh, t.data, cssColor('--text'), { axis: cssColor('--border'), lineWidth: 1.75 });
    drawSpectrum(g2, w2, h2, t.data, cssColor('--accent'));
  };

  const updateMeta = () => {
    sec.meta.textContent = `${model.timeline.length} / ${model.cap}`;
  };

  scroller.addEventListener('scroll', () => (dirtyGrid = true), { passive: true });
  grid.addEventListener('click', (e) => {
    const r = grid.getBoundingClientRect();
    const c = Math.floor((e.clientX - r.left) / cellW);
    const row = Math.floor((e.clientY - r.top + scroller.scrollTop) / CELL_H);
    const idx = row * cols + c;
    if (c >= 0 && c < cols && idx >= 0 && idx < model.timeline.length) model.select(model.timeline[idx].id);
  });
  new ResizeObserver(() => {
    dirtyGrid = dirtySel = true;
  }).observe(scroller);
  sec.el.addEventListener('toggle', () => {
    dirtyGrid = dirtySel = true;
  });
  onThemeChange(() => (dirtyGrid = dirtySel = true));

  model.on('timeline', () => {
    dirtyGrid = dirtySel = true;
    updateMeta();
  });
  model.on('selection', () => {
    dirtyGrid = dirtySel = true;
    // Defer so layout reflects any timeline change from the same action.
    requestAnimationFrame(() => scrollToIndex(model.indexOf(model.selectedId)));
  });
  model.on('voices', () => (dirtyGrid = true));
  updateMeta();

  return {
    el: sec.el,
    view: {
      frame() {
        if (!sec.el.open) return;
        if (dirtySel && isOnScreen(selWave)) {
          dirtySel = false;
          drawSelection();
        }
        if (dirtyGrid && isOnScreen(grid)) {
          dirtyGrid = false;
          drawGrid();
        }
      },
    },
  };
}
