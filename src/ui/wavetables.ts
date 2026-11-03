import type { VoiceParams } from '../core/voice';
import { shapeLabel, type Wavetable, type WavetableId } from '../core/wavetable';
import { Mix } from '../core/wavetablePlayback';
import { cssColor, fit, onThemeChange } from './canvas';
import { isOnScreen, watchVisibility, type FrameView, type UiContext } from './context';
import { h, isNarrowShell, panel, voiceColorVar } from './dom';
import { playingMix, voicePositions } from './playing';
import { buildWavetableEditor } from './wavetableEditor';

/** 12×12 stroke icon (expand / collapse). */
function svgIcon(d: string): SVGSVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 12 12');
  s.setAttribute('width', '11');
  s.setAttribute('height', '11');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', 'wt-expand-icon');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  s.append(p);
  return s;
}

/** 1D stack: at most this many lines (evenly spaced over longer wavetables). */
const STACK_LINES = 24;
const WAVE_PTS = 28;
/** Rows view: minimum row height; the newest rows that fit are shown. */
const ROW_MIN_H = 14;

/** Slot indices a 1D stack shows. */
function stackSlots(len: number): number[] {
  if (len <= STACK_LINES) return Array.from({ length: len }, (_, i) => i);
  return Array.from({ length: STACK_LINES }, (_, i) => Math.round((i * (len - 1)) / (STACK_LINES - 1)));
}

/** Most recently written slot of a live 1D / Rows wavetable (just behind the write head). */
function lastWritten(wt: Wavetable): { x: number; y: number } | null {
  if (!wt.live) return null;
  const d = wt.write.dir === '-x' ? 1 : -1;
  const y = wt.shape === 'rows' ? Math.min(wt.head.y, wt.rows.length - 1) : 0;
  const row = wt.rows[y];
  if (!row?.length) return null;
  const x = wt.shape === 'rows' && wt.head.y >= wt.rows.length ? (d < 0 ? row.length - 1 : 0) : wt.head.x + d;
  return x >= 0 && x < row.length ? { x, y } : null;
}

/**
 * Wavetables (compact panel): chips pick a wavetable (a dot marks live ones); the view
 * shows it — 1D as a stack of waveforms, 2D as a small grid, Rows as rows of cells — with
 * voice windows tinted in voice colours (V1 …), the write head of live wavetables in green
 * and the voices' play positions. The summary line gives shape, interpolation (Blend /
 * Step, switchable), Live / Frozen and which voices use it. Click a slot to select its
 * waveform in the Timeline. Edit expands the editor (wavetableEditor.ts) over the Generate
 * row (Generate is hidden meanwhile); + creates a 1D wavetable and opens it there.
 */
export function buildWavetables(ctx: UiContext): { el: HTMLElement; view: FrameView } {
  const { model, bridge } = ctx;
  // Collapsed by default on the narrow shell.
  const sec = panel('sec-wavetables', 'Wavetables', { collapsed: true });
  let current: WavetableId = model.wavetables[0].id;
  const cur = () => model.wavetable(current) ?? model.wavetables[0];

  // ---- expanded editor (over the Generate row; the Timeline below stays the drag source) ----
  let expanded = false;
  const editor = buildWavetableEditor(ctx, {
    current: () => current,
    pick: (id) => pick(id),
    isOpen: () => expanded && sec.isOpen(),
  });
  editor.el.hidden = true;
  const setExpanded = (on: boolean) => {
    if (on === expanded) return;
    expanded = on;
    document.querySelector('.shell')?.classList.toggle('wt-editing', on);
    sec.el.classList.toggle('expanded', on);
    if (on) sec.open();
    for (const e of [chips, box, summary, newBtn, editBtn]) e.hidden = on;
    editor.el.hidden = !on;
    collapseBtn.hidden = editHint.hidden = !on;
    if (on) {
      editor.shown();
      (isNarrowShell() ? sec.el : null)?.scrollIntoView({ block: 'start' });
    } else {
      dirty = true;
      editBtn.focus({ preventScroll: true });
    }
  };
  const newBtn = h(
    'button',
    {
      class: 'small icon-btn',
      id: 'wt-new',
      'aria-label': 'New wavetable',
      title: 'New 1D wavetable (opens the editor)',
      onclick: () => {
        pick(model.createWavetable('1d').id);
        setExpanded(true);
      },
    },
    '+',
  );
  const editBtn = h(
    'button',
    { class: 'small wt-expand', id: 'wt-edit', 'aria-label': 'Expand to edit', title: 'Edit wavetables (expands over the Generate row)', onclick: () => setExpanded(true) },
    svgIcon('M7 1 H11 V5 M5 11 H1 V7 M11 1 L7 5 M1 11 L5 7'),
    'Edit',
  );
  const collapseBtn = h(
    'button',
    { class: 'small wt-expand', id: 'wt-collapse', 'aria-label': 'Collapse editor', hidden: true, onclick: () => setExpanded(false) },
    svgIcon('M1 5 H5 V1 M11 7 H7 V11'),
    'Collapse',
  );
  const editHint = h('span', { class: 'wt-edit-hint', hidden: true }, 'Drag waveforms up from the Timeline: onto a slot replaces, between slots inserts');
  sec.tools.append(editHint, h('span', { class: 'grow' }), newBtn, editBtn, collapseBtn);

  const chips = h('div', { class: 'wt-chips', role: 'listbox', 'aria-label': 'Wavetables', id: 'wt-chips' });
  let chipSig = '';
  const renderChips = () => {
    const sig = model.wavetables.map((w) => `${w.id}:${w.name}:${w.live}`).join('|') + `|${current}`;
    if (sig === chipSig) return;
    chipSig = sig;
    chips.replaceChildren(
      ...model.wavetables.map((w) =>
        h(
          'button',
          {
            class: 'small wt-chip',
            role: 'option',
            id: `wt-chip-${w.id}`,
            'aria-selected': String(w.id === current),
            title: `${w.name} · ${shapeLabel(w)} · ${w.live ? 'Live' : 'Frozen'}`,
            onclick: () => pick(w.id),
          },
          h('span', { class: `wt-dot${w.live ? ' live' : ''}` }),
          w.name,
        ),
      ),
    );
  };
  const pick = (id: WavetableId) => {
    current = id;
    renderChips();
    syncSummary();
    dirty = true;
  };

  const canvas = h('canvas', { id: 'wavetable-overview', 'aria-label': 'Wavetable view; click a slot to select its waveform' });
  const box = h('div', { class: 'wt-box' }, canvas);
  const sumName = h('b', { id: 'wt-name' });
  const sumShape = h('span', { id: 'wt-shape' });
  const blendBtn = h('button', { class: 'small', id: 'wt-blend', onclick: () => model.setWavetableInterp(current, 'blend') }, 'Blend');
  const stepBtn = h('button', { class: 'small', id: 'wt-step', onclick: () => model.setWavetableInterp(current, 'step') }, 'Step');
  const liveDot = h('span', { class: 'wt-dot' });
  const liveLabel = h('span', { id: 'wt-live' });
  const usedBy = h('span', { class: 'wt-used', id: 'wt-used' });
  const summary = h(
    'div',
    { class: 'wt-summary', id: 'wt-summary' },
    sumName,
    sumShape,
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Interpolation', title: 'How voices move between slots: Blend crossfades (bilinear on 2D); Step switches on the phase wrap' }, blendBtn, stepBtn),
    h('span', { class: 'wt-live' }, liveDot, liveLabel),
    h('span', { class: 'grow' }),
    usedBy,
  );
  sec.body.append(chips, box, summary, editor.el);
  watchVisibility(canvas);

  const syncSummary = () => {
    const wt = cur();
    sumName.textContent = wt.name;
    sumName.title = wt.builtin ? 'Built-in (read-only)' : '';
    sumShape.textContent = shapeLabel(wt);
    for (const [b, on] of [
      [blendBtn, wt.interp === 'blend'],
      [stepBtn, wt.interp === 'step'],
    ] as const) {
      b.classList.toggle('seg-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    liveDot.classList.toggle('live', wt.live);
    liveLabel.textContent = wt.live ? 'Live' : 'Frozen';
    const vs = model.voicesOn(wt.id);
    usedBy.replaceChildren(
      ...(vs.length
        ? [h('span', {}, 'used by '), ...vs.map((v) => h('b', { style: `color:var(${voiceColorVar(v.id - 1)})` }, `${v.name} `))]
        : [h('span', {}, 'not used')]),
    );
    usedBy.dataset.voices = vs.map((v) => v.id).join(',');
    sec.meta.textContent = `${model.wavetables.length}`;
    canvas.dataset.wavetable = String(wt.id);
    canvas.dataset.shape = wt.shape;
  };

  // ---- drawing ----
  let dirty = true;
  /** Slot hit boxes of the last draw (for clicks). */
  let hits: { x: number; y: number; w: number; h: number; id: number }[] = [];
  const mix = new Mix();

  const wave = (g: CanvasRenderingContext2D, data: Float32Array, x0: number, mid: number, w: number, amp: number) => {
    g.beginPath();
    for (let i = 0; i <= WAVE_PTS; i++) {
      const v = data[Math.min(data.length - 1, Math.floor((i / WAVE_PTS) * data.length))];
      const px = x0 + (i / WAVE_PTS) * w;
      if (i) g.lineTo(px, mid - v * amp);
      else g.moveTo(px, mid - v * amp);
    }
  };

  /** Voices on this wavetable whose window holds slot (x, y), in voice order. */
  const windowVoices = (wt: Wavetable, voices: VoiceParams[], x: number, y: number) =>
    voices.filter((v) => {
      const inY = wt.shape === '1d' || (y >= Math.min(v.windowStartY, v.windowEndY) && y <= Math.max(v.windowStartY, v.windowEndY));
      const inX = wt.shape === 'rows' || (x >= Math.min(v.windowStart, v.windowEnd) && x <= Math.max(v.windowStart, v.windowEnd));
      return inX && inY;
    });

  const drawStack = (g: CanvasRenderingContext2D, wt: Wavetable, voices: VoiceParams[], w: number, H: number) => {
    const row = wt.rows[0] ?? [];
    const slots = stackSlots(row.length);
    const n = slots.length;
    const lw = w * 0.78;
    const dx = n > 1 ? (w - lw - 12) / (n - 1) : 0;
    const top = 16;
    const dy = n > 1 ? (H - top - 14) / (n - 1) : 0;
    const amp = Math.min(16, H * 0.12);
    const cBg = cssColor('--bg');
    const cLine = cssColor('--muted');
    const cNew = cssColor('--new');
    const head = lastWritten(wt);
    slots.forEach((x, i) => {
      const id = row[x];
      const x0 = 6 + i * dx;
      const mid = top + i * dy;
      if (id === null) {
        g.setLineDash([2, 3]);
        g.strokeStyle = cLine;
        g.beginPath();
        g.moveTo(x0, mid);
        g.lineTo(x0 + lw, mid);
        g.stroke();
        g.setLineDash([]);
        return;
      }
      const t = model.table(id);
      if (!t) return;
      const vs = windowVoices(wt, voices, x, 0);
      const isHead = head?.x === x;
      wave(g, t.data, x0, mid, lw, amp);
      g.lineTo(x0 + lw, mid + amp + 4);
      g.lineTo(x0, mid + amp + 4);
      g.closePath();
      g.fillStyle = cBg;
      g.fill();
      wave(g, t.data, x0, mid, lw, amp);
      g.strokeStyle = isHead ? cNew : vs.length ? cssColor(voiceColorVar(vs[0].id - 1)) : cLine;
      g.lineWidth = isHead || vs.length ? 1.5 : 0.9;
      g.stroke();
      hits.push({ x: x0, y: mid - amp, w: lw, h: Math.max(dy, 4), id });
    });
    // Play positions: a caret at the left of the line nearest each voice's position.
    for (const v of voices) {
      const m = playingMix(model, bridge, v, mix);
      if (!m.n) continue;
      let best = 0;
      slots.forEach((x, i) => {
        if (Math.abs(x - m.x) < Math.abs(slots[best] - m.x)) best = i;
      });
      const y = top + best * dy;
      const x0 = 6 + best * dx;
      g.fillStyle = cssColor(voiceColorVar(v.id - 1));
      g.beginPath();
      g.moveTo(x0 - 6, y - 4);
      g.lineTo(x0 - 1, y);
      g.lineTo(x0 - 6, y + 4);
      g.fill();
    }
    if (row.length > STACK_LINES) {
      g.fillStyle = cLine;
      g.font = '10px ui-monospace, monospace';
      g.fillText(`${n} of ${row.length}`, w - 64, H - 4);
    }
  };

  /** Cells of a 2D grid or Rows wavetable. */
  const drawCells = (g: CanvasRenderingContext2D, wt: Wavetable, voices: VoiceParams[], w: number, H: number) => {
    const isRows = wt.shape === 'rows';
    const nRows = wt.rows.length;
    const shown = isRows ? Math.max(1, Math.min(nRows, Math.floor((H - 8) / ROW_MIN_H))) : nRows;
    const first = Math.max(0, nRows - shown);
    const W = isRows ? Math.max(1, ...wt.rows.slice(first).map((r) => r.length)) : Math.max(1, wt.rows[0]?.length ?? 1);
    const pad = 4;
    let cw = (w - 2 * pad) / W;
    let ch = (H - 2 * pad) / Math.max(1, shown);
    if (!isRows) {
      // Keep grid cells roughly 1.3 : 1.
      cw = Math.min(cw, ch * 1.6);
      ch = Math.min(ch, cw / 1.1);
    } else cw = Math.min(cw, 28);
    const ox = isRows ? pad : (w - cw * W) / 2;
    const oy = isRows ? H - pad - ch * shown : (H - ch * nRows) / 2;
    const cBorder = cssColor('--border');
    const cCell = cssColor('--surface');
    const cWave = cssColor('--text-2');
    const cNew = cssColor('--new');
    const head = wt.shape === '2d' ? (wt.live ? wt.head : null) : lastWritten(wt);
    const gap = cw > 6 && ch > 6 ? 1 : 0.25;
    for (let y = first; y < nRows; y++) {
      const row = wt.rows[y];
      for (let x = 0; x < row.length; x++) {
        const cx = ox + x * cw;
        const cy = oy + (y - first) * ch;
        const id = row[x];
        const vs = windowVoices(wt, voices, x, y);
        if (id === null) {
          g.setLineDash([2, 2]);
          g.strokeStyle = cBorder;
          g.strokeRect(cx + gap + 0.5, cy + gap + 0.5, cw - 2 * gap - 1, ch - 2 * gap - 1);
          g.setLineDash([]);
        } else {
          g.fillStyle = cCell;
          g.fillRect(cx + gap, cy + gap, cw - 2 * gap, ch - 2 * gap);
          const t = model.table(id);
          if (t && cw >= 10 && ch >= 9) {
            wave(g, t.data, cx + cw * 0.1, cy + ch / 2, cw * 0.8, ch * 0.32);
            g.strokeStyle = cWave;
            g.lineWidth = 1;
            g.stroke();
          }
          hits.push({ x: cx, y: cy, w: cw, h: ch, id });
        }
        if (vs.length && id !== null) {
          // Tint in the first voice's colour; every voice whose window holds it outlines it.
          g.fillStyle = cssColor(voiceColorVar(vs[0].id - 1));
          g.globalAlpha = vs[0].mute ? 0.12 : 0.25;
          g.fillRect(cx + gap, cy + gap, cw - 2 * gap, ch - 2 * gap);
          g.globalAlpha = 1;
          vs.forEach((v, k) => {
            g.strokeStyle = cssColor(voiceColorVar(v.id - 1));
            g.lineWidth = 1;
            g.strokeRect(cx + gap + 0.5 + k * 1.5, cy + gap + 0.5 + k * 1.5, cw - 2 * gap - 1 - k * 3, ch - 2 * gap - 1 - k * 3);
          });
        } else if (id !== null) {
          g.strokeStyle = cBorder;
          g.lineWidth = 1;
          g.strokeRect(cx + gap + 0.5, cy + gap + 0.5, cw - 2 * gap - 1, ch - 2 * gap - 1);
        }
        if (head && head.x === x && head.y === y) {
          g.strokeStyle = cNew;
          g.lineWidth = 2;
          g.strokeRect(cx + gap + 1, cy + gap + 1, cw - 2 * gap - 2, ch - 2 * gap - 2);
        }
      }
    }
    // Play positions.
    for (const v of voices) {
      const m = playingMix(model, bridge, v, mix);
      if (!m.n) continue;
      const p = voicePositions(model, bridge, v);
      let px: number;
      if (isRows) {
        // As the engine: slot u·(L − 1) of the nearest row (Step: the chosen slot).
        const L = Math.max(1, wt.rows[Math.round(m.y)]?.length ?? 1);
        px = ox + ((wt.interp === 'step' ? m.x : p.x * (L - 1)) + 0.5) * cw;
      } else px = ox + (m.x + 0.5) * cw;
      const py = oy + (m.y + 0.5 - first) * ch;
      if (py < 0 || py > H) continue;
      g.beginPath();
      g.arc(px, py, 3.5, 0, 2 * Math.PI);
      g.fillStyle = cssColor(voiceColorVar(v.id - 1));
      g.fill();
      g.strokeStyle = cssColor('--bg');
      g.lineWidth = 1.5;
      g.stroke();
    }
  };

  const draw = () => {
    const wt = cur();
    const [g, w, H] = fit(canvas, Math.max(60, box.clientHeight || 140));
    hits = [];
    const voices = model.voicesOn(wt.id);
    if (!wt.rows.some((r) => r.length)) {
      g.fillStyle = cssColor('--muted');
      g.font = '12px system-ui, sans-serif';
      g.fillText('Empty', 10, 20);
      return;
    }
    if (wt.shape === '1d') drawStack(g, wt, voices, w, H);
    else drawCells(g, wt, voices, w, H);
  };

  canvas.addEventListener('click', (e) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    // Last drawn first (stack lines overlap: the front one wins).
    for (let i = hits.length - 1; i >= 0; i--) {
      const b = hits[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        model.select(b.id);
        return;
      }
    }
  });

  const refresh = () => {
    if (!model.wavetable(current)) current = model.wavetables[0].id;
    renderChips();
    syncSummary();
    dirty = true;
  };
  model.on('timeline', refresh);
  model.on('wavetables', refresh);
  model.on('voices', refresh);
  model.on('transport', () => (dirty = true));
  sec.onToggle(() => (dirty = true));
  new ResizeObserver(() => (dirty = true)).observe(box);
  onThemeChange(() => (dirty = true));
  refresh();

  return {
    el: sec.el,
    view: {
      frame(now) {
        if (expanded) {
          editor.view.frame(now);
          return;
        }
        if (!sec.isOpen() || !isOnScreen(canvas)) return;
        if (!dirty && !model.playing) return;
        dirty = false;
        draw();
      },
    },
  };
}
