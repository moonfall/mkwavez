import { describeRecipe } from '../core/table';
import type { VoiceParams } from '../core/voice';
import { TIMELINE_WAVETABLE_ID } from '../core/wavetable';
import { Mix } from '../core/wavetablePlayback';
import { cssColor, drawSpectrum, drawWave, fit, onThemeChange } from './canvas';
import { isOnScreen, watchVisibility, type FrameView, type UiContext } from './context';
import { h, icon, ICONS, isNarrowShell, panel, voiceColorVar } from './dom';
import { dominantId, playingMix } from './playing';
import { SHORTCUTS } from './shortcuts';
import { beginDrag, consumeDragClick, DRAG_SLOP, dropTargetsActive, isDragging } from './waveDrag';

/** Cell width and the gap between cells (px); one cell per table, in one row. */
const CELL_W = 62;
const GAP = 1;
const PITCH = CELL_W + GAP;
/**
 * A tall strip (e.g. the Timeline maximized) shows the waveforms in lanes: column by column,
 * top to bottom, one lane per LANE_MIN_H px of height (the usual ~110 px strip is one lane).
 */
const LANE_MIN_H = 96;
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
  const sec = panel('sec-timeline', 'Timeline', 'tl');

  let view = loadView();
  const viewBtn = h('button', { id: 'timeline-view', class: 'small tl-view-btn' });
  const viewDots = h('span', { class: 'tl-dots', 'aria-hidden': 'true' });
  const selLabel = h('span', { class: 'sel-label', id: 'timeline-selected' });
  const legend = h('span', { class: 'tl-legend', id: 'timeline-legend' });
  // Touch devices get the Breed-parent hint visibly (mouse users have the tooltip).
  const hint = h('span', { class: 'tl-hint', id: 'timeline-hint' }, 'Long-press: Breed parent');
  const copyTitle = 'Copy the selected waveform to the end of the Timeline (Ctrl/⌘+D in the strip)';
  const copyBtn = h(
    'button',
    {
      id: 'timeline-copy',
      class: 'small tl-copy-btn',
      title: copyTitle,
      'aria-keyshortcuts': 'Control+D Meta+D',
      onclick: () => model.copyToEnd(model.selectedId),
    },
    'Copy to end',
  );
  sec.tools.append(viewBtn, viewDots, copyBtn, selLabel, hint, legend);

  const grid = h('canvas', { 'aria-label': 'Timeline of all waveforms; click to select', id: 'timeline-grid' });
  const overlay = h('canvas', { class: 'tl-overlay', id: 'timeline-markers', 'aria-hidden': 'true' });
  const stage = h('div', { class: 'tl-stage' }, grid, overlay);
  const track = h('div', { class: 'tl-track' }, stage);
  // Focusable (a click on the strip focuses it) so Ctrl/⌘+D can copy the selection.
  const scroller = h(
    'div',
    {
      class: 'tl-scroll',
      id: 'timeline-scroll',
      tabindex: 0,
      'aria-label': 'Timeline waveforms',
      'aria-keyshortcuts': `${SHORTCUTS.moveLeft} ${SHORTCUTS.moveRight} Control+D Meta+D`,
    },
    track,
  );
  sec.body.append(scroller);
  sec.body.title =
    'Shift-click (or ⌘-click) or long-press a waveform to add or remove it as a Breed parent. ' +
    'Shift+← / → moves the selected waveform; Ctrl/⌘+D copies it to the end.';
  watchVisibility(grid);

  let dirtyGrid = true;
  let dirtyMarkers = true;
  let markerKey = '';
  let viewW = 300;
  /** Stage height; with `lanes` > 1 each lane (a cell's height) is `laneH`. */
  let cellH = 60;
  let lanes = 1;
  let laneH = 60;
  const colOf = (idx: number) => Math.floor(idx / lanes);
  const laneY = (idx: number) => (idx % lanes) * (laneH + GAP);

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
    lanes = Math.max(1, Math.floor((cellH + GAP) / (LANE_MIN_H + GAP)));
    laneH = (cellH - (lanes - 1) * GAP) / lanes;
    grid.dataset.lanes = String(lanes);
    track.style.width = `${Math.max(viewW, Math.ceil(model.timeline.length / lanes) * PITCH - GAP)}px`;
    stage.style.width = `${viewW}px`;
    stage.style.height = `${cellH}px`;
  };

  const atEnd = () => scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - PITCH;

  /** Scroll (the strip only) so cell idx is in view. */
  const scrollToIndex = (idx: number) => {
    if (idx < 0) return;
    layout();
    const left = colOf(idx) * PITCH;
    if (left < scroller.scrollLeft) scroller.scrollLeft = Math.max(0, left - PITCH / 2);
    else if (left + CELL_W > scroller.scrollLeft + viewW) scroller.scrollLeft = left + CELL_W - viewW + PITCH / 2;
  };
  const scrollToEnd = () => {
    layout();
    scroller.scrollLeft = scroller.scrollWidth;
  };

  const drawGrid = () => {
    layout();
    const [g] = fit(grid, lanes * laneH + (lanes - 1) * GAP);
    const n = model.timeline.length;
    const left = scroller.scrollLeft;
    const first = Math.max(0, Math.floor(left / PITCH) * lanes);
    const last = Math.min(n - 1, (Math.floor((left + viewW) / PITCH) + 1) * lanes - 1);
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
    // Every voice tints the tables inside its window: Timeline voices by index range, voices
    // on other wavetables by the table ids their window references (the tables they play).
    const voices = model.voices;
    const vColors = voices.map(voiceColor);
    const members = voices.map((v) => (v.wavetableId === TIMELINE_WAVETABLE_ID ? null : new Set(model.windowTables(v).map((t) => t.id))));
    const inWin = (k: number, idx: number): boolean => {
      if (idx < 0 || idx >= n) return false;
      const set = members[k];
      if (set) return set.has(model.timeline[idx].id);
      const v = voices[k];
      return idx >= v.windowStart && idx <= v.windowEnd;
    };
    const showWave = view !== 1;
    const showSpec = view !== 0;
    grid.dataset.bandOrder = voices.map((v) => v.id).join(',');
    grid.dataset.view = String(view);
    g.font = '9px ui-monospace, monospace';
    g.textBaseline = 'top';
    const top = 12;
    const plotH = laneH - top - 3;
    const cellH = laneH;
    for (let idx = first; idx <= last; idx++) {
      const t = model.timeline[idx];
      const x = colOf(idx) * PITCH - left;
      const ly = laneY(idx);
      if (ly) g.translate(0, ly);
      g.fillStyle = cCell;
      g.fillRect(x, 0, CELL_W, cellH);
      // Window tints: one band per voice whose window holds this table, voice order top→bottom.
      const inside: number[] = [];
      voices.forEach((_v, k) => {
        if (inWin(k, idx)) inside.push(k);
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
        // Solid edges where a run of window tables starts / ends.
        if (!inWin(k, idx - 1)) g.fillRect(x, y0, EDGE_W, y1 - y0);
        if (!inWin(k, idx + 1)) g.fillRect(x + CELL_W - EDGE_W, y0, EDGE_W, y1 - y0);
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
      if (ly) g.translate(0, -ly);
    }
  };

  /**
   * Play-position carets on the overlay. For a voice on the Timeline wavetable the index f
   * (fractional, timeline order) maps to the centre of cell round(f) offset by the fraction,
   * so f = i + 0.5 sits on the boundary between tables i and i + 1. A voice on another
   * wavetable gets a caret on the table it currently plays most of. Only visible carets
   * are drawn; skipped entirely when nothing moved.
   */
  const mix = new Mix();
  const drawMarkers = () => {
    const n = model.timeline.length;
    const left = scroller.scrollLeft;
    const live = model.playing ? new Map(bridge.status.voices.map((s) => [s.id, s.index])) : null;
    const marks: { v: VoiceParams; f: number; x: number; y: number }[] = [];
    if (n) {
      for (const v of model.voices) {
        if (v.mute) continue;
        let f: number;
        if (v.wavetableId === TIMELINE_WAVETABLE_ID) {
          const m = playingMix(model, bridge, v, mix);
          f = live?.get(v.id) ?? (m.n ? m.x : 0);
        } else {
          const id = dominantId(playingMix(model, bridge, v, mix));
          f = model.indexOf(id);
          if (f < 0) continue;
        }
        f = Math.max(0, Math.min(n - 1, f));
        // The caret sits in cell round(f), offset by the fraction (f = i + 0.5: between i and i + 1).
        const i = Math.min(n - 1, Math.round(f));
        const x = (colOf(i) + 0.5 + f - i) * PITCH - GAP / 2 - left;
        if (x < -6 || x > viewW + 6) continue;
        marks.push({ v, f, x, y: laneY(i) });
      }
    }
    const key = `${viewW}|${cellH}|${marks.map((m) => `${m.v.id}:${m.x.toFixed(1)}:${m.y}`).join(' ')}`;
    if (key === markerKey) return;
    markerKey = key;
    const [g] = fit(overlay, cellH);
    const cEdge = cssColor('--surface');
    for (const { v, x, y } of marks) {
      const col = voiceColor(v);
      g.globalAlpha = 0.85;
      g.fillStyle = cEdge;
      g.fillRect(x - 2, y, 4, laneH);
      g.globalAlpha = 1;
      g.fillStyle = col;
      g.fillRect(x - 1, y, 2, laneH);
      g.beginPath();
      g.moveTo(x - 5, y);
      g.lineTo(x + 5, y);
      g.lineTo(x, y + 7);
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
    const room = model.roomFor(1);
    copyBtn.disabled = !t || !room;
    copyBtn.title = room ? copyTitle : model.fullMessage();
  };

  const updateLegend = () => {
    legend.replaceChildren(
      ...model.voices.map((v) =>
        h(
          'span',
          {
            class: `tl-key${v.mute ? ' muted' : ''}`,
            style: `--c:var(${voiceColorVar(v.id - 1)})`,
            title: `${v.name} plays ${model.wavetable(v.wavetableId)?.name ?? '—'}`,
          },
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
      // Only on the wide shell: in the phone column the wheel must keep scrolling the page.
      if (isNarrowShell() || Math.abs(e.deltaY) <= Math.abs(e.deltaX) || e.ctrlKey) return;
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
  const cellAt = (clientX: number, clientY: number) => {
    const r = grid.getBoundingClientRect();
    const x = clientX - r.left + scroller.scrollLeft;
    const lane = Math.max(0, Math.min(lanes - 1, Math.floor((clientY - r.top) / (laneH + GAP))));
    const idx = Math.floor(x / PITCH) * lanes + lane;
    return x >= 0 && idx < model.timeline.length ? model.timeline[idx] : undefined;
  };
  // Touch long-press toggles a Breed parent and swallows the click that follows.
  let press: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null;
  let swallowClick = false;
  const cancelPress = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };
  // While the wavetable editor is open, a table can be dragged into it: with the mouse
  // after a small movement, on touch by moving up / down (sideways scrolls the strip;
  // holding still is still the Breed long-press).
  let pending: { x: number; y: number; id: number } | null = null;
  grid.addEventListener('pointerdown', (e) => {
    pending = null;
    if (e.button === 0 && dropTargetsActive()) {
      const t = cellAt(e.clientX, e.clientY);
      if (t) pending = { x: e.clientX, y: e.clientY, id: t.id };
    }
  });
  grid.addEventListener('pointermove', (e) => {
    if (!pending || isDragging()) return;
    const dx = e.clientX - pending.x;
    const dy = e.clientY - pending.y;
    const go = e.pointerType === 'mouse' ? Math.hypot(dx, dy) > DRAG_SLOP : Math.abs(dy) > LONG_PRESS_SLOP && Math.abs(dy) > Math.abs(dx);
    if (!go) return;
    const id = pending.id;
    pending = null;
    cancelPress();
    beginDrag({ tableId: id }, e, model.table(id)?.data, grid);
  });
  for (const ev of ['pointerup', 'pointercancel'] as const) grid.addEventListener(ev, () => (pending = null));
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
        pending = null; // the long-press is the Breed toggle: a following move doesn't drag
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
    if (consumeDragClick()) return;
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    const t = cellAt(e.clientX, e.clientY);
    if (!t) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey) model.toggleBreedParent(t.id);
    else model.select(t.id);
  });
  // Ctrl/⌘+D duplicates the selection only while focus is in the Timeline (not page-wide).
  sec.el.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'd') return;
    e.preventDefault();
    if (!e.repeat) model.copyToEnd(model.selectedId); // holding the keys copies once
  });
  const invalidate = () => {
    dirtyGrid = dirtyMarkers = true;
    markerKey = '';
  };
  new ResizeObserver(invalidate).observe(scroller);
  sec.onToggle(invalidate);
  sec.setStatus(() => {
    const idx = model.indexOf(model.selectedId);
    return `${model.timeline.length} waveforms · ${idx >= 0 ? `#${idx + 1} selected` : 'nothing selected'}`;
  });
  onThemeChange(invalidate);

  // Scrolling: a changed (or moved) selection is brought into view; otherwise, if the
  // strip was at its end when waveforms were added, it follows the newest one.
  let lastSel = model.selectedId;
  let lastMoves = model.moves;
  let follow = false;
  let scrollPending = false;
  const scheduleScroll = () => {
    if (scrollPending) return;
    scrollPending = true;
    // Defer so layout reflects every change from the same action.
    requestAnimationFrame(() => {
      scrollPending = false;
      // A move (moveTable) reveals the moved waveform; an eviction shifting its index doesn't.
      const moved = model.moves !== lastMoves;
      const selChanged = model.selectedId !== lastSel || moved;
      lastSel = model.selectedId;
      lastMoves = model.moves;
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
  model.on('wavetables', () => {
    dirtyGrid = dirtyMarkers = true;
    updateLabels();
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
