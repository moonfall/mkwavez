import { describeRecipe } from '../core/table';
import type { VoiceParams } from '../core/voice';
import { ALL_WAVETABLE_ID } from '../core/wavetable';
import { cssColor, drawSpectrum, drawWave, fit, onThemeChange } from './canvas';
import { isOnScreen, watchVisibility, type FrameView, type UiContext } from './context';
import { h, section, voiceColorVar } from './dom';

const CELL_MIN_W = 56;
const CELL_H = 42;
const MAX_VIEW_H = 186;
const SEL_H = 76;
/** Touch long-press (ms) toggles a Breed parent; movement beyond LONG_PRESS_SLOP px cancels. */
const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP = 10;
/** Window bars: height and pitch (px), stacked up from the cell's bottom edge. */
const BAR_H = 2;
const BAR_PITCH = 3;

/** A voice's colour — read from the shared voice palette so palette changes flow through. */
const voiceColor = (v: VoiceParams) => cssColor(voiceColorVar(v.id - 1));

/** Static (unmodulated) play index of a voice into a wavetable of `len` tables, as the engine resolves it. */
function staticIndex(v: VoiceParams, len: number): number {
  const max = len - 1;
  let a = Math.max(0, Math.min(max, v.windowStart));
  let b = Math.max(0, Math.min(max, v.windowEnd));
  if (a > b) [a, b] = [b, a];
  const f = a + v.position * (b - a);
  return v.interp === 'step' ? Math.round(f) : f;
}

/**
 * Timeline: every table ever generated (up to the cap), as a virtualized grid of
 * thumbnails drawn on one sticky canvas — only visible rows are drawn, and only when
 * something changed. Click selects; the selection is shown larger with its spectrum.
 * Shift-click, Cmd-click (Ctrl-click off macOS, where it opens the context menu)
 * or a touch long-press toggles a table as a Breed parent
 * (badged A, B, … in the grid).
 *
 * Voice windows are bars along each cell's bottom, stacked in voice order (voice 1 on
 * top). Each unmuted voice's play position (live, LFO included, while playing; static
 * when stopped) is a caret on a transparent overlay canvas, placed proportionally
 * between neighbouring tables' cell centres. The overlay redraws on its own (≤ the
 * frame-loop rate while playing, only when the markers moved), never the grid.
 */
export function buildTimeline(ctx: UiContext): { el: HTMLElement; view: FrameView } {
  const { model, bridge } = ctx;
  const sec = section('sec-timeline', 'Timeline');

  const selLabel = h('div', { class: 'sel-label', id: 'timeline-selected' });
  const selWave = h('canvas', { 'aria-label': 'Selected table waveform' });
  const selSpec = h('canvas', { 'aria-label': 'Selected table spectrum' });
  const grid = h('canvas', { 'aria-label': 'Timeline of all tables; click to select', id: 'timeline-grid' });
  const overlay = h('canvas', { class: 'tl-overlay', id: 'timeline-markers', 'aria-hidden': 'true' });
  const spacer = h('div');
  const scroller = h('div', { class: 'tl-scroll' }, h('div', { class: 'tl-stage' }, grid, overlay), spacer);
  sec.body.append(
    h('div', { class: 'row', style: 'margin-bottom:4px' }, selLabel),
    h('div', { class: 'sel-view' }, selWave, selSpec),
    scroller,
    h('p', { class: 'hint', style: 'margin:6px 0 0' }, 'Shift-click (or ⌘-click) or long-press a table to add or remove it as a Breed parent.'),
  );
  watchVisibility(grid);
  watchVisibility(selWave);

  let dirtyGrid = true;
  let dirtySel = true;
  let dirtyMarkers = true;
  let markerKey = '';
  let cols = 1;
  let cellW = CELL_MIN_W;
  let viewH = CELL_H;

  const layout = () => {
    const w = scroller.clientWidth || 300;
    cols = Math.max(4, Math.floor(w / CELL_MIN_W));
    cellW = w / cols;
    const rows = Math.ceil(model.timeline.length / cols) || 1;
    const total = rows * CELL_H;
    const view = Math.min(total, MAX_VIEW_H);
    scroller.style.height = `${view + 2}px`;
    spacer.style.height = `${total - view}px`;
    viewH = view;
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
    const cParent = cssColor('--accent');
    const cParentText = cssColor('--surface');
    const parentIdx = new Map(model.breedParents.map((id, i) => [id, i]));
    // Bars in voice order, voice 1 topmost: slot k sits (m-1-k) pitches above the bottom.
    const voices = model.voices.filter((v) => v.wavetableId === ALL_WAVETABLE_ID);
    const vColors = voices.map(voiceColor);
    const barY = voices.map((_, k) => CELL_H - 1 - BAR_H - (voices.length - 1 - k) * BAR_PITCH);
    const order = voices.map((v) => v.id).join(',');
    if (grid.dataset.barOrder !== order) grid.dataset.barOrder = order;
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
        const pi = parentIdx.get(t.id);
        if (pi !== undefined) {
          g.strokeStyle = cParent;
          g.lineWidth = 2;
          g.strokeRect(x + 1.5, y + 1.5, cellW - 3, CELL_H - 3);
          g.fillStyle = cParent;
          g.fillRect(x + cellW - 13, y + 2, 11, 11);
          g.fillStyle = cParentText;
          g.fillText(String.fromCharCode(65 + pi), x + cellW - 10.5, y + 3.5);
        }
        voices.forEach((v, k) => {
          if (idx >= v.windowStart && idx <= v.windowEnd) {
            g.fillStyle = vColors[k];
            g.globalAlpha = v.mute ? 0.35 : 0.9;
            g.fillRect(x + 1, y + barY[k], cellW - 2, BAR_H);
            g.globalAlpha = 1;
          }
        });
      }
    }
  };

  /**
   * Play-position markers on the overlay. Index f (fractional, into the "All"
   * wavetable = timeline order) maps to the centre of cell round(f) offset by the
   * fraction, so f = i + 0.5 sits on the boundary between tables i and i + 1.
   * Only markers in visible rows are drawn; skipped entirely when nothing moved.
   */
  const drawMarkers = () => {
    const n = model.timeline.length;
    const top = scroller.scrollTop;
    const live = model.playing ? new Map(bridge.status.voices.map((s) => [s.id, s.index])) : null;
    const marks: { v: VoiceParams; f: number; x: number; y: number }[] = [];
    if (n) {
      for (const v of model.voices) {
        if (v.mute || v.wavetableId !== ALL_WAVETABLE_ID) continue;
        const f = Math.max(0, Math.min(n - 1, live?.get(v.id) ?? staticIndex(v, n)));
        const j = Math.min(n - 1, Math.floor(f + 0.5));
        const y = Math.floor(j / cols) * CELL_H - top;
        if (y + CELL_H <= 0 || y >= viewH) continue;
        marks.push({ v, f, x: (j % cols) * cellW + (f - j + 0.5) * cellW, y });
      }
    }
    const key = `${viewH}|${cellW}|${marks.map((m) => `${m.v.id}:${m.x.toFixed(1)}:${m.y}`).join(' ')}`;
    if (key === markerKey) return;
    markerKey = key;
    const [g] = fit(overlay, viewH);
    const cEdge = cssColor('--surface');
    for (const { v, x, y } of marks) {
      const col = voiceColor(v);
      g.globalAlpha = 0.85;
      g.fillStyle = cEdge;
      g.fillRect(x - 2, y + 1, 4, CELL_H - 2);
      g.globalAlpha = 1;
      g.fillStyle = col;
      g.fillRect(x - 1, y + 1, 2, CELL_H - 2);
      g.beginPath();
      g.moveTo(x - 4.5, y + 1);
      g.lineTo(x + 4.5, y + 1);
      g.lineTo(x, y + 7);
      g.closePath();
      g.strokeStyle = cEdge;
      g.lineWidth = 1;
      g.stroke();
      g.fill();
    }
    overlay.dataset.markers = marks.map((m) => `${m.v.id}:${m.f.toFixed(3)}`).join(' ');
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

  scroller.addEventListener('scroll', () => (dirtyGrid = dirtyMarkers = true), { passive: true });
  const cellAt = (clientX: number, clientY: number) => {
    const r = grid.getBoundingClientRect();
    const c = Math.floor((clientX - r.left) / cellW);
    const row = Math.floor((clientY - r.top + scroller.scrollTop) / CELL_H);
    const idx = row * cols + c;
    return c >= 0 && c < cols && idx >= 0 && idx < model.timeline.length ? model.timeline[idx] : undefined;
  };
  // Touch long-press toggles a Breed parent and swallows the click that follows.
  let press: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null;
  let swallowClick = false;
  const cancelPress = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };
  grid.addEventListener('pointerdown', (e) => {
    cancelPress();
    swallowClick = false;
    if (e.pointerType === 'mouse') return;
    const { clientX: x, clientY: y } = e;
    press = {
      x,
      y,
      timer: setTimeout(() => {
        press = null;
        const t = cellAt(x, y);
        if (!t) return;
        swallowClick = true;
        model.toggleBreedParent(t.id);
        navigator.vibrate?.(15);
      }, LONG_PRESS_MS),
    };
  });
  grid.addEventListener('pointermove', (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > LONG_PRESS_SLOP) cancelPress();
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave'] as const) grid.addEventListener(ev, cancelPress);
  // The long-press would otherwise open the context menu on touch devices.
  grid.addEventListener('contextmenu', (e) => {
    if (swallowClick || press) e.preventDefault();
  });
  grid.addEventListener('click', (e) => {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    const t = cellAt(e.clientX, e.clientY);
    if (!t) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey) model.toggleBreedParent(t.id);
    else model.select(t.id);
  });
  const invalidateMarkers = () => {
    dirtyMarkers = true;
    markerKey = '';
  };
  new ResizeObserver(() => {
    dirtyGrid = dirtySel = true;
    invalidateMarkers();
  }).observe(scroller);
  sec.el.addEventListener('toggle', () => {
    dirtyGrid = dirtySel = true;
    invalidateMarkers();
  });
  onThemeChange(() => {
    dirtyGrid = dirtySel = true;
    invalidateMarkers();
  });

  model.on('timeline', () => {
    dirtyGrid = dirtySel = dirtyMarkers = true;
    updateMeta();
  });
  model.on('selection', () => {
    dirtyGrid = dirtySel = true;
    // Defer so layout reflects any timeline change from the same action.
    requestAnimationFrame(() => scrollToIndex(model.indexOf(model.selectedId)));
  });
  model.on('voices', () => (dirtyGrid = dirtyMarkers = true));
  model.on('transport', () => (dirtyMarkers = true));
  model.on('parents', () => (dirtyGrid = true));
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
        if (!isOnScreen(grid)) return;
        if (dirtyGrid) {
          dirtyGrid = false;
          drawGrid();
        }
        // Markers follow live positions while playing (the loop caps that at ~25 fps).
        if (dirtyMarkers || model.playing) {
          dirtyMarkers = false;
          drawMarkers();
        }
      },
    },
  };
}
