import { describeRecipe } from '../core/table';
import type { VoiceParams } from '../core/voice';
import { ALL_WAVETABLE_ID } from '../core/wavetable';
import { cssColor, drawSpectrum, drawWave, fit, onThemeChange } from './canvas';
import { isOnScreen, watchVisibility, type FrameView, type UiContext } from './context';
import { h, icon, ICONS, panel, voiceColorVar } from './dom';

/** Cell width and the gap between cells (px); one cell per table, in one row. */
const CELL_W = 62;
const GAP = 1;
const PITCH = CELL_W + GAP;
/** Touch long-press (ms) toggles a Breed parent; movement beyond LONG_PRESS_SLOP px cancels. */
const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP = 10;
/** Window tints: unmuted voices strong, muted faint. Edge = window start / end. */
const TINT_ON = 0.38;
const TINT_MUTED = 0.14;
const EDGE_W = 2;
const SPEC_BINS = 24;

/** Thumbnail views, cycled by the header button; the choice is remembered. */
export const TIMELINE_VIEWS = ['Waveform', 'Spectral', 'Waveform + Spectral'] as const;
const VIEW_KEY = 'mkwavez.timelineView';

function loadView(): number {
  try {
    const v = Number(localStorage.getItem(VIEW_KEY));
    return Number.isInteger(v) && v >= 0 && v < TIMELINE_VIEWS.length ? v : 0;
  } catch {
    return 0;
  }
}

function saveView(v: number): void {
  try {
    localStorage.setItem(VIEW_KEY, String(v));
  } catch {
    /* storage blocked: remembered for this page only */
  }
}

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
 * Timeline: every table ever generated (up to the cap) as a slim horizontal strip of
 * thumbnails, virtualized on one sticky canvas — only the visible cells are drawn, and
 * only when something changed. Click selects; Shift-click, Cmd-click (Ctrl-click off
 * macOS) or a touch long-press toggles a Breed parent (badged A, B, …).
 *
 * Voice windows tint the cell background in the voice colour (unmuted strong, muted
 * faint) with a solid edge at the window's start / end; where windows overlap the cell
 * is split into horizontal bands, one per voice in voice order (top to bottom). Each
 * unmuted voice's play position (live, LFO included, while playing; static when
 * stopped) is a caret on a transparent overlay canvas that redraws on its own (≤ the
 * frame-loop rate while playing, only when the markers moved), never the strip.
 */
export function buildTimeline(ctx: UiContext): { el: HTMLElement; view: FrameView } {
  const { model, bridge } = ctx;
  const sec = panel('sec-timeline', 'Timeline');

  let view = loadView();
  const viewBtn = h('button', { id: 'timeline-view', class: 'small tl-view-btn' });
  const viewDots = h('span', { class: 'tl-dots', 'aria-hidden': 'true' });
  const selLabel = h('span', { class: 'sel-label', id: 'timeline-selected' });
  const legend = h('span', { class: 'tl-legend', id: 'timeline-legend' });
  sec.tools.append(viewBtn, viewDots, selLabel, legend);

  const grid = h('canvas', { 'aria-label': 'Timeline of all tables; click to select', id: 'timeline-grid' });
  const overlay = h('canvas', { class: 'tl-overlay', id: 'timeline-markers', 'aria-hidden': 'true' });
  const stage = h('div', { class: 'tl-stage' }, grid, overlay);
  const track = h('div', { class: 'tl-track' }, stage);
  const scroller = h('div', { class: 'tl-scroll', id: 'timeline-scroll' }, track);
  sec.body.append(scroller);
  sec.body.title = 'Shift-click (or ⌘-click) or long-press a table to add or remove it as a Breed parent.';
  watchVisibility(grid);

  let dirtyGrid = true;
  let dirtyMarkers = true;
  let markerKey = '';
  let viewW = 300;
  let cellH = 60;

  const syncView = () => {
    const name = TIMELINE_VIEWS[view];
    viewBtn.replaceChildren(icon(ICONS.cycle), h('span', {}, name));
    viewBtn.setAttribute('aria-label', `Thumbnail view: ${name}. Click for ${TIMELINE_VIEWS[(view + 1) % TIMELINE_VIEWS.length]}`);
    viewBtn.dataset.view = String(view);
    viewDots.replaceChildren(...TIMELINE_VIEWS.map((_, k) => h('span', { class: k === view ? 'on' : '' })));
  };
  viewBtn.addEventListener('click', () => {
    view = (view + 1) % TIMELINE_VIEWS.length;
    saveView(view);
    syncView();
    dirtyGrid = true;
  });
  syncView();

  /** Size the stage to the scroller's viewport and the track to every cell. */
  const layout = () => {
    viewW = scroller.clientWidth || 300;
    cellH = Math.max(24, scroller.clientHeight || 60);
    track.style.width = `${Math.max(viewW, model.timeline.length * PITCH - GAP)}px`;
    stage.style.width = `${viewW}px`;
    stage.style.height = `${cellH}px`;
  };

  const atEnd = () => scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - PITCH;

  /** Scroll (the strip only) so cell idx is in view. */
  const scrollToIndex = (idx: number) => {
    if (idx < 0) return;
    layout();
    const left = idx * PITCH;
    if (left < scroller.scrollLeft) scroller.scrollLeft = Math.max(0, left - PITCH / 2);
    else if (left + CELL_W > scroller.scrollLeft + viewW) scroller.scrollLeft = left + CELL_W - viewW + PITCH / 2;
  };
  const scrollToEnd = () => {
    layout();
    scroller.scrollLeft = scroller.scrollWidth;
  };

  const drawGrid = () => {
    layout();
    const [g] = fit(grid, cellH);
    const n = model.timeline.length;
    const left = scroller.scrollLeft;
    const first = Math.max(0, Math.floor(left / PITCH));
    const last = Math.min(n - 1, Math.floor((left + viewW) / PITCH));
    const selIdx = model.indexOf(model.selectedId);
    const newest = n - 1;
    const cWave = cssColor('--wave');
    const cMuted = cssColor('--text-2');
    const cNew = cssColor('--new');
    const cCell = cssColor('--bg');
    const cBorder = cssColor('--border');
    const cLabel = cssColor('--muted');
    const cSel = cssColor('--accent');
    const cSpec = cssColor('--accent');
    const cParentText = cssColor('--surface');
    const parentIdx = new Map(model.breedParents.map((id, i) => [id, i]));
    const voices = model.voices.filter((v) => v.wavetableId === ALL_WAVETABLE_ID);
    const vColors = voices.map(voiceColor);
    const showWave = view !== 1;
    const showSpec = view !== 0;
    grid.dataset.bandOrder = voices.map((v) => v.id).join(',');
    grid.dataset.view = String(view);
    g.font = '9px ui-monospace, monospace';
    g.textBaseline = 'top';
    const top = 12;
    const plotH = cellH - top - 3;
    for (let idx = first; idx <= last; idx++) {
      const t = model.timeline[idx];
      const x = idx * PITCH - left;
      g.fillStyle = cCell;
      g.fillRect(x, 0, CELL_W, cellH);
      // Window tints: one band per voice whose window holds this table, voice order top→bottom.
      const inside: number[] = [];
      voices.forEach((v, k) => {
        if (idx >= v.windowStart && idx <= v.windowEnd) inside.push(k);
      });
      const bandH = cellH / (inside.length || 1);
      inside.forEach((k, b) => {
        const v = voices[k];
        const y0 = Math.round(b * bandH);
        const y1 = Math.round((b + 1) * bandH);
        g.fillStyle = vColors[k];
        g.globalAlpha = v.mute ? TINT_MUTED : TINT_ON;
        g.fillRect(x, y0, CELL_W, y1 - y0);
        g.globalAlpha = v.mute ? 0.45 : 1;
        if (idx === v.windowStart) g.fillRect(x, y0, EDGE_W, y1 - y0);
        if (idx === v.windowEnd) g.fillRect(x + CELL_W - EDGE_W, y0, EDGE_W, y1 - y0);
      });
      g.globalAlpha = 1;
      if (showSpec) {
        g.save();
        g.translate(x + 3, top);
        g.globalAlpha = showWave ? 0.45 : 1;
        drawSpectrum(g, CELL_W - 6, plotH, t.data, cSpec, { bins: SPEC_BINS });
        g.restore();
      }
      if (showWave) {
        const hot = idx === selIdx || idx === newest;
        drawWave(g, x + 3, top, CELL_W - 6, plotH, t.data, idx === newest ? cNew : idx === selIdx ? cWave : cMuted, {
          points: 32,
          lineWidth: hot ? 1.6 : 1.1,
        });
      }
      g.fillStyle = idx === newest ? cNew : cLabel;
      g.fillText(String(idx + 1), x + 4, 2);
      const sel = idx === selIdx;
      g.strokeStyle = sel ? cSel : cBorder;
      g.lineWidth = sel ? 2 : 1;
      if (sel) g.strokeRect(x + 1, 1, CELL_W - 2, cellH - 2);
      else g.strokeRect(x + 0.5, 0.5, CELL_W - 1, cellH - 1);
      const pi = parentIdx.get(t.id);
      if (pi !== undefined) {
        if (!sel) {
          g.strokeStyle = cSel;
          g.setLineDash([3, 2]);
          g.lineWidth = 1.5;
          g.strokeRect(x + 1.5, 1.5, CELL_W - 3, cellH - 3);
          g.setLineDash([]);
        }
        g.fillStyle = cSel;
        g.fillRect(x + CELL_W - 14, 2, 12, 12);
        g.fillStyle = cParentText;
        g.fillText(String.fromCharCode(65 + pi), x + CELL_W - 10.5, 3.5);
      }
    }
  };

  /**
   * Play-position carets on the overlay. Index f (fractional, into the "All" wavetable =
   * timeline order) maps to the centre of cell round(f) offset by the fraction, so
   * f = i + 0.5 sits on the boundary between tables i and i + 1. Only visible carets are
   * drawn; skipped entirely when nothing moved.
   */
  const drawMarkers = () => {
    const n = model.timeline.length;
    const left = scroller.scrollLeft;
    const live = model.playing ? new Map(bridge.status.voices.map((s) => [s.id, s.index])) : null;
    const marks: { v: VoiceParams; f: number; x: number }[] = [];
    if (n) {
      for (const v of model.voices) {
        if (v.mute || v.wavetableId !== ALL_WAVETABLE_ID) continue;
        const f = Math.max(0, Math.min(n - 1, live?.get(v.id) ?? staticIndex(v, n)));
        const x = (f + 0.5) * PITCH - GAP / 2 - left;
        if (x < -6 || x > viewW + 6) continue;
        marks.push({ v, f, x });
      }
    }
    const key = `${viewW}|${cellH}|${marks.map((m) => `${m.v.id}:${m.x.toFixed(1)}`).join(' ')}`;
    if (key === markerKey) return;
    markerKey = key;
    const [g] = fit(overlay, cellH);
    const cEdge = cssColor('--surface');
    for (const { v, x } of marks) {
      const col = voiceColor(v);
      g.globalAlpha = 0.85;
      g.fillStyle = cEdge;
      g.fillRect(x - 2, 0, 4, cellH);
      g.globalAlpha = 1;
      g.fillStyle = col;
      g.fillRect(x - 1, 0, 2, cellH);
      g.beginPath();
      g.moveTo(x - 5, 0);
      g.lineTo(x + 5, 0);
      g.lineTo(x, 7);
      g.closePath();
      g.strokeStyle = cEdge;
      g.lineWidth = 1;
      g.stroke();
      g.fill();
    }
    overlay.dataset.markers = marks.map((m) => `${m.v.id}:${m.f.toFixed(3)}`).join(' ');
  };

  const updateLabels = () => {
    sec.meta.textContent = `${model.timeline.length} / ${model.cap}`;
    const t = model.table(model.selectedId);
    const idx = model.indexOf(model.selectedId);
    selLabel.textContent = t ? `#${idx + 1} · id ${t.id} · ${describeRecipe(t.recipe)}` : 'Nothing selected';
    selLabel.title = selLabel.textContent;
  };

  const updateLegend = () => {
    legend.replaceChildren(
      ...model.voices
        .filter((v) => v.wavetableId === ALL_WAVETABLE_ID)
        .map((v) =>
          h(
            'span',
            { class: `tl-key${v.mute ? ' muted' : ''}`, style: `--c:var(${voiceColorVar(v.id - 1)})` },
            h('span', { class: 'sw' }),
            v.mute ? `${v.name} · muted` : v.name,
          ),
        ),
    );
  };

  scroller.addEventListener('scroll', () => (dirtyGrid = dirtyMarkers = true), { passive: true });
  // A vertical wheel scrolls the strip sideways (mouse users have no horizontal wheel).
  scroller.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || e.ctrlKey) return;
      const max = scroller.scrollWidth - scroller.clientWidth;
      if (max <= 0) return;
      const d = e.deltaMode === 1 ? e.deltaY * PITCH : e.deltaY;
      const next = Math.max(0, Math.min(max, scroller.scrollLeft + d));
      if (next === scroller.scrollLeft) return;
      e.preventDefault();
      scroller.scrollLeft = next;
    },
    { passive: false },
  );
  const cellAt = (clientX: number) => {
    const r = grid.getBoundingClientRect();
    const x = clientX - r.left + scroller.scrollLeft;
    const idx = Math.floor(x / PITCH);
    return x >= 0 && idx < model.timeline.length ? model.timeline[idx] : undefined;
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
        const t = cellAt(x);
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
    const t = cellAt(e.clientX);
    if (!t) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey) model.toggleBreedParent(t.id);
    else model.select(t.id);
  });
  const invalidate = () => {
    dirtyGrid = dirtyMarkers = true;
    markerKey = '';
  };
  new ResizeObserver(invalidate).observe(scroller);
  sec.onToggle(invalidate);
  onThemeChange(invalidate);

  // Scrolling: a changed selection is brought into view; otherwise, if the strip was
  // at its end when tables were added, it follows the newest table.
  let lastSel = model.selectedId;
  let follow = false;
  let scrollPending = false;
  const scheduleScroll = () => {
    if (scrollPending) return;
    scrollPending = true;
    // Defer so layout reflects every change from the same action.
    requestAnimationFrame(() => {
      scrollPending = false;
      const selChanged = model.selectedId !== lastSel;
      lastSel = model.selectedId;
      if (selChanged) scrollToIndex(model.indexOf(model.selectedId));
      else if (follow) scrollToEnd();
      follow = false;
      dirtyGrid = dirtyMarkers = true;
    });
  };
  model.on('timeline', () => {
    if (atEnd()) follow = true;
    dirtyGrid = dirtyMarkers = true;
    updateLabels();
    scheduleScroll();
  });
  model.on('selection', () => {
    dirtyGrid = true;
    updateLabels();
    scheduleScroll();
  });
  model.on('voices', () => {
    dirtyGrid = dirtyMarkers = true;
    updateLegend();
  });
  model.on('transport', () => (dirtyMarkers = true));
  model.on('parents', () => (dirtyGrid = true));
  updateLabels();
  updateLegend();

  return {
    el: sec.el,
    view: {
      frame() {
        if (!sec.isOpen() || !isOnScreen(grid)) return;
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
