/**
 * Wavetables editor (the expanded Wavetables panel, over the Generate row): the wavetable
 * list (built-in / yours, + 1D / 2D / Rows), the selected wavetable's view (1D as a strip
 * or a stack, 2D as a grid, Rows as rows) with voice windows, the write head and where the
 * next writes land, and the write-head settings. Waveforms are dragged in from the Timeline
 * (or from slots of this or another wavetable): onto a slot replaces, between slots inserts
 * (1D and Rows), between rows adds a row (Rows). Every content edit is one undo step.
 */
import type { TableId } from '../core/table';
import type { VoiceParams } from '../core/voice';
import {
  canTarget,
  cellAt,
  droppedBy1DResize,
  droppedBy2DResize,
  findSlot,
  MAX_GRID,
  MAX_SLOTS,
  moveSlot,
  previewWrites,
  shapeLabel,
  wavetableDims,
  type Cell,
  type PendingWrite,
  type SlotTarget,
  type Wavetable,
  type WavetableId,
  type WavetableShape,
  type WriteSettings,
} from '../core/wavetable';
import { Mix } from '../core/wavetablePlayback';
import { cssColor, drawWave, fit, onThemeChange } from './canvas';
import { isOnScreen, watchVisibility, type FrameView, type UiContext } from './context';
import { h, voiceColorVar } from './dom';
import { playingMix, voicePositions } from './playing';
import { addDropZone, beginDrag, consumeDragClick, DRAG_SLOP, isDragging, type DragPoint, type DragSource } from './waveDrag';

export interface EditorHost {
  current(): WavetableId;
  pick(id: WavetableId): void;
  /** The editor is showing (expanded and on screen / not collapsed). */
  isOpen(): boolean;
}

type ViewMode = 'strip' | 'stack';

/** How many upcoming writes the view marks. */
const PREVIEW_N = 4;
/** Touch: long-press (ms) on a slot picks its waveform up for dragging. */
const PICK_MS = 350;
const TOUCH_SLOP = 10;
/** Drop zones near a slot's left / right edge (px) mean "insert here". */
const EDGE = 14;
/** Spring-loading: hovering a list entry this long while dragging opens it. */
const SPRING_MS = 600;

// Geometry (CSS px).
const PAD = 8;
const STRIP_W = 66;
const STRIP_G = 6;
const ROW_LBL = 80;
const ROW_W = 56;
const ROW_H = 44;
const ROW_G = 3;
const ROW_GAP = 6;
const GRID_LBL = 18;
const GRID_BOT = 14;
const GRID_G = 3;
const GRID_MIN = 18;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface SlotBox extends Rect {
  cx: number;
  cy: number;
}
interface GhostBox extends Rect {
  n: number;
}
interface Layout {
  kind: 'strip' | 'stack' | 'grid' | 'rows';
  W: number;
  H: number;
  slots: SlotBox[];
  /** Appended "new" cells of the next writes. */
  ghosts: GhostBox[];
  /** Rows: band per row (incl. a pending new row). */
  rowTop: (y: number) => number;
  /** Strip / Rows: left edge of slot x (in its row). */
  slotLeft: (x: number) => number;
  pitch: number;
  cell: { w: number; h: number };
  /** Grid origin. */
  ox: number;
  oy: number;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const GLYPH: Record<WavetableShape, string> = {
  '1d': 'M2 8 H14 M4 5 V11 M8 5 V11 M12 5 V11',
  '2d': 'M2.5 2.5 H13.5 V13.5 H2.5 Z M6.2 2.5 V13.5 M9.8 2.5 V13.5 M2.5 6.2 H13.5 M2.5 9.8 H13.5',
  rows: 'M2 4 H14 M2 8 H10 M2 12 H12',
};
function svg(d: string, size: number, view: number, cls: string, label?: string): SVGSVGElement {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', `0 0 ${view} ${view}`);
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.setAttribute('class', cls);
  if (label) {
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', label);
  } else s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  s.append(p);
  return s;
}
const LOCK = 'M3.5 5.5 V4 A2.5 2.5 0 0 1 8.5 4 V5.5 M2.5 5.5 H9.5 V10.5 H2.5 Z';
const PENCIL = 'M2 10 L2.5 7.5 L8 2 L10 4 L4.5 9.5 Z';

/** A segmented control: buttons with aria-pressed. */
function seg<T extends string>(label: string, opts: readonly (readonly [T, string, string?])[], idPrefix: string, onPick: (v: T) => void) {
  const btns = new Map<T, HTMLButtonElement>();
  const el = h('div', { class: 'seg wte-seg', role: 'group', 'aria-label': label });
  for (const [v, text, title] of opts) {
    const b = h('button', { class: 'small', id: `${idPrefix}-${v}`, title: title ?? '', onclick: () => onPick(v) }, text);
    btns.set(v, b);
    el.append(b);
  }
  return {
    el,
    set(cur: T, disabled: (v: T) => boolean = () => false) {
      for (const [v, b] of btns) {
        const on = v === cur;
        b.classList.toggle('seg-on', on);
        b.setAttribute('aria-pressed', String(on));
        b.disabled = disabled(v);
      }
    },
  };
}

export function buildWavetableEditor(ctx: UiContext, host: EditorHost): { el: HTMLElement; view: FrameView; shown(): void; focusSize(): void } {
  const { model, bridge } = ctx;
  const cur = (): Wavetable => model.wavetable(host.current()) ?? model.wavetables[0];
  const viewModes = new Map<WavetableId, ViewMode>();
  const modeOf = (wt: Wavetable): ViewMode => (wt.shape === '1d' ? (viewModes.get(wt.id) ?? 'strip') : 'strip');
  let sel: Cell | null = null;
  let selFor: WavetableId = -1;
  let dropAt: { t: SlotTarget; ok: boolean; move: boolean } | null = null;
  let dirty = true;
  const touch = () => (dirty = true);

  // ---------------- list ----------------
  const items = h('div', { class: 'wte-items', id: 'wte-list', role: 'listbox', 'aria-label': 'Wavetables' });
  let listSig = '';
  let springOver: HTMLElement | null = null;
  const renderList = () => {
    const sig = model.wavetables.map((w) => `${w.id}:${w.name}:${w.live}:${shapeLabel(w)}`).join('|') + `|${host.current()}|${springOver?.dataset.id ?? ''}`;
    if (sig === listSig) return;
    listSig = sig;
    const item = (w: Wavetable) => {
      const on = w.id === host.current();
      return h(
        'button',
        {
          class: `wte-item${springOver?.dataset.id === String(w.id) ? ' drop-over' : ''}`,
          role: 'option',
          id: `wte-item-${w.id}`,
          'data-id': String(w.id),
          'aria-selected': String(on),
          title: w.builtin ? `${w.name} (built-in, read-only)` : `${w.name} (double-click to rename)`,
          onclick: () => pick(w.id),
          ondblclick: () => {
            if (!w.builtin) startRename();
          },
        },
        svg(GLYPH[w.shape], 16, 16, 'wte-glyph'),
        h('span', { class: 'wte-item-text' }, h('span', { class: 'wte-item-name' }, w.name), h('span', { class: 'wte-item-meta' }, shapeLabel(w))),
        w.builtin ? svg(LOCK, 11, 12, 'wte-lock', 'Built-in') : null,
        h('span', { class: `wt-dot${w.live ? ' live' : ''}`, title: w.live ? 'Live' : 'Frozen' }),
      );
    };
    const builtins = model.wavetables.filter((w) => w.builtin);
    const yours = model.wavetables.filter((w) => !w.builtin);
    items.replaceChildren(
      h('div', { class: 'wte-group' }, 'Built-in'),
      ...builtins.map(item),
      h('div', { class: 'wte-group' }, 'Yours'),
      ...(yours.length ? yours.map(item) : [h('div', { class: 'wte-none' }, 'None yet: create one below, or duplicate a built-in.')]),
    );
  };
  const create = (shape: WavetableShape) => {
    const wt = model.createWavetable(shape);
    pick(wt.id);
    if (shape === '2d') focusSize();
  };
  const newRow = h(
    'div',
    { class: 'wte-new' },
    h('button', { class: 'small', id: 'wte-new-1d', title: 'New 1D wavetable (variable length, empty)', onclick: () => create('1d') }, '+ 1D'),
    h('button', { class: 'small', id: 'wte-new-2d', title: 'New 2D wavetable (8 × 8, empty; set X × Y in the header)', onclick: () => create('2d') }, '+ 2D'),
    h('button', { class: 'small', id: 'wte-new-rows', title: 'New Rows wavetable (empty; each batch a new row once Live)', onclick: () => create('rows') }, '+ Rows'),
  );
  const nav = h('nav', { class: 'wte-list', 'aria-label': 'Wavetable list' }, items, newRow);

  // ---------------- header ----------------
  const nameEl = h('b', { class: 'wte-name', id: 'wte-name' });
  const nameInput = h('input', { type: 'text', class: 'wte-name-input', id: 'wte-name-input', maxlength: 40, 'aria-label': 'Wavetable name', hidden: true });
  const renameBtn = h('button', { class: 'small icon-btn', id: 'wte-rename', 'aria-label': 'Rename', title: 'Rename', onclick: () => startRename() }, svg(PENCIL, 11, 12, 'wte-pencil'));
  let renaming = false;
  const startRename = () => {
    const wt = cur();
    if (wt.builtin) return;
    renaming = true;
    nameInput.value = wt.name;
    nameInput.hidden = false;
    nameEl.hidden = true;
    nameInput.focus();
    nameInput.select();
  };
  const endRename = (commit: boolean) => {
    if (!renaming) return;
    renaming = false;
    if (commit) model.renameWavetable(host.current(), nameInput.value);
    nameInput.hidden = true;
    nameEl.hidden = false;
    syncHeader();
  };
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') endRename(true);
    else if (e.key === 'Escape') endRename(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  nameInput.addEventListener('blur', () => endRename(true));

  const shapeEl = h('span', { class: 'wte-shape', id: 'wte-shape' });
  const sizeText = h('span', { class: 'wte-size-text', id: 'wte-size-text' });
  const sizeSeg = seg('Size', [['variable', 'Variable', 'Grows as waveforms are added'], ['fixed', 'Fixed', 'A fixed number of slots']] as const, 'wte-size', (v) => {
    const wt = cur();
    if (v === 'fixed') model.resizeWavetable1D(wt.id, true, Math.max(1, wt.rows[0].length || 8));
    else model.resizeWavetable1D(wt.id, false);
  });
  const lenInput = h('input', { type: 'number', class: 'wte-num', id: 'wte-len', min: 1, max: MAX_SLOTS, 'aria-label': 'Slots' });
  const lenBox = h('span', { class: 'wte-dim' }, lenInput, h('span', {}, 'slots'));
  lenInput.addEventListener('change', () => {
    const wt = cur();
    const n = Math.max(1, Math.min(MAX_SLOTS, Math.round(Number(lenInput.value) || 1)));
    const lost = droppedBy1DResize(wt, n);
    if (lost && !confirm(`Shrinking to ${n} slots drops ${lost} waveform${lost === 1 ? '' : 's'} from the end. Continue?`)) {
      syncHeader();
      return;
    }
    model.resizeWavetable1D(wt.id, true, n);
    syncHeader();
  });
  const wInput = h('input', { type: 'number', class: 'wte-num', id: 'wte-w', min: 1, max: MAX_GRID, 'aria-label': 'Columns (X)' });
  const hInput = h('input', { type: 'number', class: 'wte-num', id: 'wte-h', min: 1, max: MAX_GRID, 'aria-label': 'Rows (Y)' });
  const gridBox = h('span', { class: 'wte-dim' }, wInput, h('span', {}, '×'), hInput, h('span', { class: 'wte-dim-hint' }, '(X × Y)'));
  const resizeGrid = () => {
    const wt = cur();
    const clamp = (v: string) => Math.max(1, Math.min(MAX_GRID, Math.round(Number(v) || 1)));
    const W = clamp(wInput.value);
    const H = clamp(hInput.value);
    const lost = droppedBy2DResize(wt, W, H);
    if (lost && !confirm(`Resizing to ${W} × ${H} drops ${lost} waveform${lost === 1 ? '' : 's'} outside the new grid. Continue?`)) {
      syncHeader();
      return;
    }
    model.resizeWavetable2D(wt.id, W, H);
    syncHeader();
  };
  wInput.addEventListener('change', resizeGrid);
  hInput.addEventListener('change', resizeGrid);
  for (const inp of [lenInput, wInput, hInput]) inp.addEventListener('keydown', (e) => e.stopPropagation());
  const sizeBox = h('span', { class: 'wte-size', id: 'wte-size' }, sizeSeg.el, lenBox, gridBox, sizeText);

  const viewSeg = seg('1D view', [['strip', 'Strip'], ['stack', 'Stack']] as const, 'wte-view', (v) => {
    viewModes.set(host.current(), v);
    syncHeader();
    touch();
  });
  const interpSeg = seg(
    'Interpolation',
    [
      ['blend', 'Blend', 'Voices crossfade neighbouring slots (bilinear on 2D)'],
      ['step', 'Step', 'Voices switch slots on the phase wrap'],
    ] as const,
    'wte',
    (v) => model.setWavetableInterp(host.current(), v),
  );
  const dupBtn = h(
    'button',
    {
      class: 'small',
      id: 'wte-duplicate',
      onclick: () => {
        const d = model.duplicateWavetable(host.current());
        if (d) pick(d.id);
      },
    },
    'Duplicate',
  );
  const delBtn = h(
    'button',
    {
      class: 'small danger',
      id: 'wte-delete',
      onclick: () => {
        const wt = cur();
        if (wt.builtin) return;
        const vs = model.voicesOn(wt.id);
        const msg = `Delete the wavetable “${wt.name}”?${vs.length ? ` ${vs.map((v) => v.name).join(', ')} will switch to the Timeline.` : ''} (Undo brings it back.)`;
        if (!confirm(msg)) return;
        model.deleteWavetable(wt.id);
      },
    },
    'Delete',
  );
  const head = h(
    'div',
    { class: 'wte-head' },
    nameEl,
    nameInput,
    renameBtn,
    shapeEl,
    sizeBox,
    h('span', { class: 'grow' }),
    viewSeg.el,
    interpSeg.el,
    dupBtn,
    delBtn,
  );

  // ---------------- view ----------------
  const canvas = h('canvas', { id: 'wte-canvas' });
  const stage = h('div', { class: 'wte-stage' }, canvas);
  const track = h('div', { class: 'wte-track' }, stage);
  const scroller = h(
    'div',
    {
      class: 'wte-scroll',
      id: 'wte-scroll',
      tabindex: 0,
      'data-shift-arrows': '',
      role: 'grid',
      'aria-label': 'Wavetable slots: click to select, Alt-click moves the write head, Delete empties the selected slot; drag waveforms here from the Timeline',
    },
    track,
  );
  const emptyHint = h('div', { class: 'wte-empty', id: 'wte-empty', hidden: true });
  const legend = h(
    'div',
    { class: 'wte-legend', 'aria-hidden': 'true' },
    h('span', {}, h('span', { class: 'wte-key win' }), 'voice window'),
    h('span', {}, h('span', { class: 'wte-key head' }), 'write head'),
    h('span', {}, h('span', { class: 'wte-key next' }, '2'), 'next writes'),
  );
  const viewBox = h('div', { class: 'wte-view' }, scroller, emptyHint, legend);
  watchVisibility(canvas);

  // Foot: the selected slot and its actions.
  const slotInfo = h('span', { class: 'wte-slot-info', id: 'wte-slot-info' });
  const act = (id: string, label: string, title: string, fn: () => void) => h('button', { class: 'small', id, title, onclick: fn }, label);
  const headHere = act('wte-head-here', 'Write head here', 'Move the write head to this slot (or Alt-click a slot)', () => {
    if (sel) model.setWavetableHead(host.current(), sel.x, sel.y);
  });
  const useSel = act('wte-use-selected', 'Replace with selected', 'Put the waveform selected in the Timeline into this slot', () => {
    if (sel && model.selectedId !== null) model.placeInWavetable(host.current(), { kind: 'slot', x: sel.x, y: sel.y }, model.selectedId);
  });
  const insSel = act('wte-insert-selected', 'Insert selected', 'Insert the waveform selected in the Timeline before this slot', () => {
    if (sel && model.selectedId !== null) model.placeInWavetable(host.current(), { kind: 'gap', x: sel.x, y: sel.y }, model.selectedId);
  });
  const clearBtn = act('wte-clear', 'Clear', 'Empty this slot (Delete)', () => clearSel());
  const removeBtn = act('wte-remove', 'Remove slot', 'Remove this slot; the line closes up (Shift+Delete)', () => removeSel());
  const foot = h('div', { class: 'wte-foot', id: 'wte-foot' }, slotInfo, h('span', { class: 'grow' }), headHere, useSel, insSel, clearBtn, removeBtn);

  const main = h('div', { class: 'wte-main' }, head, viewBox, foot);

  // ---------------- write head settings ----------------
  const liveSeg = seg('Live or frozen', [['live', 'Live', 'New waveforms are written at the write head'], ['frozen', 'Frozen', 'Changed by hand only']] as const, 'wte', (v) =>
    model.setWavetableLive(host.current(), v === 'live'),
  );
  type Ctl = { key: keyof WriteSettings; label: string; opts: readonly (readonly [string, string, string?])[] };
  const CTLS: Ctl[] = [
    { key: 'dir', label: 'Direction', opts: [['+x', '+x', 'Along the row'], ['-x', '−x', 'Backwards along the row'], ['+y', '+y', 'Down the columns (2D)'], ['-y', '−y', 'Up the columns (2D)']] },
    { key: 'edge', label: 'At the edge', opts: [['wrap', 'Wrap'], ['stop', 'Stop'], ['grow', 'Grow']] },
    { key: 'onWrap', label: 'On wrap', opts: [['next', 'Next row / col'], ['same', 'Same line']] },
    { key: 'mode', label: 'Write', opts: [['replace', 'Replace', 'Overwrite the slot at the head'], ['insert', 'Insert', 'Insert a slot at the head (1D and Rows)']] },
    { key: 'batch', label: 'Each new batch', opts: [['continue', 'Continue'], ['newRow', 'New row', '1D: start the line afresh; 2D: next row; Rows: a new row']] },
  ];
  const valueId = (v: string) => v.replace('+', 'p').replace('-', 'n');
  const ctlSegs = CTLS.map((c) => {
    const s = seg(c.label, c.opts.map(([v, l, t]) => [valueId(v), l, t] as const), `wte-${c.key}`, (v) => {
      const raw = c.opts.find(([o]) => valueId(o) === v)![0];
      model.setWavetableWrite(host.current(), { [c.key]: raw } as Partial<WriteSettings>);
    });
    return { c, s, el: h('div', { class: 'wte-ctl' }, h('span', { class: 'wte-ctl-label' }, c.label), s.el) };
  });
  const note = h('div', { class: 'wte-note', id: 'wte-note' });
  const side = h(
    'aside',
    { class: 'wte-side', id: 'wte-side', 'aria-label': 'Write head' },
    h('div', { class: 'wte-side-head' }, h('span', { class: 'wte-side-title' }, 'Write head'), liveSeg.el),
    ...ctlSegs.map((x) => x.el),
    note,
  );

  const el = h('div', { class: 'wte', id: 'wt-editor' }, nav, main, side);

  // ---------------- sync ----------------
  const slotName = (wt: Wavetable, c: Cell) => (wt.shape === '1d' ? `slot ${c.x + 1}` : wt.shape === '2d' ? `cell ${c.x}, ${c.y}` : `slot ${c.x + 1} of row ${c.y + 1}`);
  let tlIndex = new Map<TableId, number>();
  let tlRef: unknown = null;
  const indexOf = (id: TableId) => {
    if (tlRef !== model.timeline) {
      tlRef = model.timeline;
      tlIndex = new Map(model.timeline.map((t, i) => [t.id, i]));
    }
    return tlIndex.get(id) ?? -1;
  };

  const syncHeader = () => {
    const wt = cur();
    if (!renaming) nameEl.textContent = wt.name;
    nameEl.title = wt.builtin ? 'Built-in (read-only)' : 'Double-click a list entry or use the pencil to rename';
    renameBtn.hidden = !!wt.builtin;
    shapeEl.textContent = wt.shape === '1d' ? '1D' : wt.shape === '2d' ? '2D' : 'Rows';
    const user = !wt.builtin;
    const { w, h: hh } = wavetableDims(wt);
    sizeSeg.el.hidden = !(user && wt.shape === '1d');
    lenBox.hidden = !(user && wt.shape === '1d' && wt.fixed);
    gridBox.hidden = !(user && wt.shape === '2d');
    sizeSeg.set(wt.fixed ? 'fixed' : 'variable');
    if (document.activeElement !== lenInput) lenInput.value = String(wt.rows[0]?.length ?? 0);
    if (document.activeElement !== wInput) wInput.value = String(w);
    if (document.activeElement !== hInput) hInput.value = String(hh);
    const n1 = wt.rows[0]?.length ?? 0;
    sizeText.textContent =
      wt.shape === '1d'
        ? user
          ? wt.fixed
            ? ''
            : `${n1} slot${n1 === 1 ? '' : 's'}`
          : `${wt.fixed ? 'fixed' : 'variable'} · ${n1}`
        : wt.shape === '2d'
          ? user
            ? ''
            : `fixed · ${w} × ${hh} (X × Y)`
          : `${wt.rows.length} row${wt.rows.length === 1 ? '' : 's'}${wt.rows.length ? ` · ${wt.rows.slice(0, 8).map((r) => r.length).join('/')}${wt.rows.length > 8 ? '/…' : ''}` : ''}`;
    viewSeg.el.hidden = wt.shape !== '1d';
    viewSeg.set(modeOf(wt));
    interpSeg.set(wt.interp);
    dupBtn.classList.toggle('primary', !!wt.builtin);
    dupBtn.title = wt.builtin ? 'Make an editable copy of this built-in' : 'Make a copy';
    delBtn.hidden = !!wt.builtin;
  };

  const syncSide = () => {
    const wt = cur();
    const ro = !!wt.builtin;
    liveSeg.set(wt.live ? 'live' : 'frozen', () => ro);
    const is1d = wt.shape === '1d';
    const is2d = wt.shape === '2d';
    const rowsReplaceNew = wt.shape === 'rows' && wt.write.mode === 'replace' && wt.write.batch === 'newRow';
    const off: Record<keyof WriteSettings, (v: string) => boolean> = {
      dir: (v) => !is2d && (v === '+y' || v === '-y'),
      edge: (v) => (v === 'grow' && (is2d || (is1d && wt.fixed))) || (v === 'wrap' && is1d && !wt.fixed) || (rowsReplaceNew && v !== 'grow'),
      onWrap: () => is1d,
      mode: (v) => v === 'insert' && is2d,
      batch: () => false,
    };
    for (const { c, s } of ctlSegs) {
      const raw = wt.write[c.key] as string;
      s.set(valueId(raw), (v) => {
        const o = c.opts.find(([x]) => valueId(x) === v)![0];
        return ro || off[c.key](o);
      });
    }
    note.textContent = noteText(wt);
  };

  const headText = (wt: Wavetable, writes: PendingWrite[]): string => {
    if (!writes.length) return 'The write head has stopped (end of the line): move it (Alt-click a slot) or change “At the edge”.';
    const { x, y } = wt.head;
    let at: string;
    if (wt.shape === '2d') at = `Head at x ${x}, y ${y}.`;
    else if (wt.shape === '1d') at = x >= (wt.rows[0]?.length ?? 0) ? 'Head after the last slot.' : x < 0 ? 'Head before the first slot.' : `Head at slot ${x + 1}.`;
    else at = y >= wt.rows.length ? 'Head on a new row.' : `Head on row ${y + 1}, slot ${x + 1}.`;
    return `${at} Green numbers show where the next writes land.`;
  };
  const noteText = (wt: Wavetable): string => {
    const p = previewWrites(wt, PREVIEW_N);
    if (wt.builtin) return `Built-in and read-only. Duplicate it to change its settings or edit its slots. ${headText(wt, p.writes)}`;
    if (!wt.live) return 'Frozen: new waveforms are not added. Drag waveforms from the Timeline: onto a slot replaces, between slots inserts. Switch to Live to write each new batch at the head.';
    return `${headText(wt, p.writes)} Drag from the Timeline to edit by hand.`;
  };

  const syncFoot = () => {
    const wt = cur();
    if (selFor !== wt.id) {
      sel = null;
      selFor = wt.id;
    }
    if (sel && (sel.y >= wt.rows.length || sel.x >= wt.rows[sel.y].length)) sel = null;
    const user = !wt.builtin;
    const has = !!sel;
    for (const b of [headHere, useSel, insSel, clearBtn, removeBtn]) b.hidden = !has || !user;
    if (sel) {
      const id = cellAt(wt, sel.x, sel.y);
      const idx = id === null ? -1 : indexOf(id);
      slotInfo.textContent = `${slotName(wt, sel)[0].toUpperCase()}${slotName(wt, sel).slice(1)} · ${id === null ? 'empty' : idx >= 0 ? `waveform #${idx + 1}` : 'waveform'}${user ? '' : ' · built-in, read-only'}`;
      insSel.hidden ||= wt.shape === '2d';
      removeBtn.hidden ||= wt.shape === '2d';
      clearBtn.disabled = id === null;
      useSel.disabled = insSel.disabled = model.selectedId === null;
      headHere.disabled = !wt.live;
      headHere.title = wt.live ? 'Move the write head to this slot (or Alt-click a slot)' : 'Live wavetables only';
    } else
      slotInfo.textContent = wt.builtin
        ? 'Built-in: drag its waveforms into your wavetables, or Duplicate it to edit.'
        : 'Click a slot to select it · Alt-click moves the write head · drag waveforms from the Timeline onto a slot (replace) or between slots (insert)';
    slotInfo.title = slotInfo.textContent;
  };

  const syncEmpty = () => {
    const wt = cur();
    const empty = !wt.rows.some((r) => r.length);
    emptyHint.hidden = !empty;
    emptyHint.textContent = wt.builtin
      ? 'Empty'
      : wt.shape === 'rows'
        ? 'Empty: drag waveforms here from the Timeline (each drop below the last row starts a new row).'
        : 'Empty: drag waveforms here from the Timeline.';
    legend.hidden = empty;
  };

  const syncAll = () => {
    renderList();
    syncHeader();
    syncSide();
    syncFoot();
    syncEmpty();
    canvas.dataset.wavetable = String(cur().id);
    canvas.dataset.shape = cur().shape;
    canvas.dataset.view = modeOf(cur());
    touch();
  };

  let scrollOnPick = true;
  const pick = (id: WavetableId) => {
    if (renaming) endRename(true);
    host.pick(id);
    scrollOnPick = true;
    syncAll();
  };

  // ---------------- layout + drawing ----------------
  let lay: Layout | null = null;
  let preview: { writes: PendingWrite[]; fresh: boolean } = { writes: [], fresh: false };

  const computeLayout = (wt: Wavetable, vw: number, vh: number): Layout => {
    const appends = new Map<number, number>();
    for (const w of preview.writes) if (w.kind === 'append') appends.set(w.y, (appends.get(w.y) ?? 0) + 1);
    const ghosts: GhostBox[] = [];
    const base = { slots: [] as SlotBox[], ghosts, ox: 0, oy: 0 };
    if (wt.shape === '1d') {
      const mode = modeOf(wt);
      const L = wt.rows[0].length;
      const ch = Math.max(56, vh - 2 * PAD);
      const pitch = STRIP_W + STRIP_G;
      const slotLeft = (x: number) => PAD + x * pitch;
      const slots: SlotBox[] = [];
      if (mode === 'strip')
        for (let x = 0; x < wt.rows[0].length; x++) slots.push({ x: slotLeft(x), y: PAD, w: STRIP_W, h: ch, cx: x, cy: 0 });
      let k = 0;
      for (const w of preview.writes) if (w.kind === 'append') ghosts.push({ x: slotLeft(L + k++), y: PAD, w: STRIP_W, h: ch, n: w.n });
      const n = Math.max(wt.rows[0].length, L + k) + 1;
      return { ...base, kind: mode, slots, W: mode === 'stack' ? vw : PAD * 2 + n * pitch, H: vh, rowTop: () => PAD, slotLeft, pitch, cell: { w: STRIP_W, h: ch } };
    }
    if (wt.shape === '2d') {
      const { w: W, h: H } = wavetableDims(wt);
      let ch = Math.floor((vh - 2 * PAD - GRID_BOT - (H - 1) * GRID_G) / H);
      let cw = Math.floor((vw - 2 * PAD - GRID_LBL - (W - 1) * GRID_G) / W);
      ch = Math.max(GRID_MIN, Math.min(ch, cw));
      cw = Math.max(GRID_MIN, Math.min(cw, Math.round(ch * 1.7)));
      const ox = PAD + GRID_LBL;
      const oy = PAD;
      const slots: SlotBox[] = [];
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) slots.push({ x: ox + x * (cw + GRID_G), y: oy + y * (ch + GRID_G), w: cw, h: ch, cx: x, cy: y });
      return {
        ...base,
        kind: 'grid',
        slots,
        ox,
        oy,
        W: Math.max(vw, ox + W * (cw + GRID_G) + PAD),
        H: Math.max(vh, oy + H * (ch + GRID_G) + GRID_BOT + PAD),
        rowTop: (y) => oy + y * (ch + GRID_G),
        slotLeft: (x) => ox + x * (cw + GRID_G),
        pitch: cw + GRID_G,
        cell: { w: cw, h: ch },
      };
    }
    // Rows.
    const pitch = ROW_W + ROW_G;
    const rowTop = (y: number) => PAD + y * (ROW_H + ROW_GAP);
    const slotLeft = (x: number) => PAD + ROW_LBL + x * pitch;
    const slots: SlotBox[] = [];
    let maxLen = 0;
    wt.rows.forEach((r, y) => {
      for (let x = 0; x < r.length; x++) slots.push({ x: slotLeft(x), y: rowTop(y), w: ROW_W, h: ROW_H, cx: x, cy: y });
      maxLen = Math.max(maxLen, r.length + (appends.get(y) ?? 0));
    });
    let nRows = wt.rows.length;
    const counts = new Map<number, number>();
    for (const w of preview.writes) {
      if (w.kind !== 'append') continue;
      const k = counts.get(w.y) ?? 0;
      counts.set(w.y, k + 1);
      const len = wt.rows[w.y]?.length ?? 0;
      ghosts.push({ x: slotLeft(len + k), y: rowTop(w.y), w: ROW_W, h: ROW_H, n: w.n });
      nRows = Math.max(nRows, w.y + 1);
      maxLen = Math.max(maxLen, len + k + 1);
    }
    return {
      ...base,
      kind: 'rows',
      slots,
      W: Math.max(vw, slotLeft(maxLen + 1) + PAD),
      H: Math.max(vh, rowTop(nRows + 1) + PAD),
      rowTop,
      slotLeft,
      pitch,
      cell: { w: ROW_W, h: ROW_H },
    };
  };

  /** Voices on this wavetable whose window holds (x, y). */
  const windowVoices = (wt: Wavetable, voices: VoiceParams[], x: number, y: number) =>
    voices.filter((v) => {
      const inY = wt.shape === '1d' || (y >= Math.min(v.windowStartY, v.windowEndY) && y <= Math.max(v.windowStartY, v.windowEndY));
      const inX = wt.shape === 'rows' || (x >= Math.min(v.windowStart, v.windowEnd) && x <= Math.max(v.windowStart, v.windowEnd));
      return inX && inY;
    });

  const mix = new Mix();
  const draw = () => {
    const wt = cur();
    const vw = scroller.clientWidth || 300;
    const vh = scroller.clientHeight || 200;
    preview = wt.live ? previewWrites(wt, PREVIEW_N) : { writes: [], fresh: false };
    const L = (lay = computeLayout(wt, vw, vh));
    track.style.width = `${L.W}px`;
    track.style.height = `${L.H}px`;
    stage.style.width = `${vw}px`;
    stage.style.height = `${vh}px`;
    if (scrollOnPick) {
      scrollOnPick = false;
      if (L.kind === 'rows') scroller.scrollTop = L.H;
      else if (L.kind === 'strip') {
        const hx = wt.live ? Math.max(0, Math.min(wt.rows[0].length, wt.head.x)) : 0;
        scroller.scrollLeft = Math.max(0, L.slotLeft(hx) - vw / 2);
      } else scroller.scrollLeft = scroller.scrollTop = 0;
    }
    const [g] = fit(canvas, vh);
    const sx = scroller.scrollLeft;
    const sy = scroller.scrollTop;
    g.save();
    g.translate(-sx, -sy);
    const voices = model.voicesOn(wt.id);
    const cCell = cssColor('--surface');
    const cBorder = cssColor('--border');
    const cWave = cssColor('--wave');
    const cLabel = cssColor('--text-2');
    const cNew = cssColor('--new');
    const cSel = cssColor('--accent');
    const cBg = cssColor('--bg');
    const visible = (r: Rect) => r.x + r.w >= sx && r.x <= sx + vw && r.y + r.h >= sy && r.y <= sy + vh;
    const writesAt = new Map<string, number[]>();
    const insertsAt = new Map<string, number[]>();
    for (const w of preview.writes) {
      const key = `${w.x},${w.y}`;
      if (w.kind === 'replace') writesAt.set(key, [...(writesAt.get(key) ?? []), w.n]);
      else if (w.kind === 'insert') insertsAt.set(key, [...(insertsAt.get(key) ?? []), w.n]);
    }
    const mono = '10px ui-monospace, Menlo, Consolas, monospace';
    const badge = (x: number, y: number, n: number) => {
      g.beginPath();
      g.arc(x, y, 7, 0, 2 * Math.PI);
      g.fillStyle = cBg;
      g.fill();
      g.strokeStyle = cNew;
      g.lineWidth = 1;
      g.stroke();
      g.fillStyle = cNew;
      g.font = '9px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(n), x, y + 0.5);
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
    };
    const headMark = (r: Rect) => {
      g.strokeStyle = cNew;
      g.lineWidth = 2;
      g.strokeRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
      if (L.kind === 'strip') {
        g.fillStyle = cNew;
        g.fillRect(r.x - 1, r.y - 1, r.w + 2, 4);
      }
      if (r.w >= 22) {
        g.fillStyle = cNew;
        g.font = 'bold 10px system-ui, sans-serif';
        g.fillText('W', r.x + r.w - 10, r.y + 13);
      }
    };
    const strip = L.kind === 'strip';

    if (L.kind === 'stack') drawStack(g, wt, voices, vw, vh);
    // Rows: labels.
    if (L.kind === 'rows') {
      g.font = '11px system-ui, sans-serif';
      const nShow = Math.max(wt.rows.length, ...preview.writes.filter((w) => w.kind === 'append').map((w) => w.y + 1));
      for (let y = 0; y < nShow; y++) {
        const top = L.rowTop(y);
        if (top + ROW_H < sy || top > sy + vh) continue;
        const inWin = voices.find((v) => y >= Math.min(v.windowStartY, v.windowEndY) && y <= Math.max(v.windowStartY, v.windowEndY));
        g.fillStyle = inWin ? cssColor(voiceColorVar(inWin.id - 1)) : cssColor('--text');
        const name = y >= wt.rows.length ? 'Next batch' : `${wt.builtin === 'batches' ? 'Batch' : 'Row'} ${y + 1}`;
        g.font = '600 11px system-ui, sans-serif';
        g.fillText(name, PAD, top + 18);
        g.fillStyle = cLabel;
        g.font = '11px system-ui, sans-serif';
        const n = wt.rows[y]?.length ?? 0;
        g.fillText(y >= wt.rows.length ? 'new row' : `${n} waveform${n === 1 ? '' : 's'}`, PAD, top + 33);
      }
    }
    // Grid: axis labels.
    if (L.kind === 'grid') {
      const { w: W, h: H } = wavetableDims(wt);
      g.fillStyle = cLabel;
      g.font = mono;
      for (let y = 0; y < H; y++) g.fillText(String(y), PAD, L.rowTop(y) + L.cell.h / 2 + 4);
      g.textAlign = 'center';
      for (let x = 0; x < W; x++) g.fillText(String(x), L.slotLeft(x) + L.cell.w / 2, L.oy + H * (L.cell.h + GRID_G) + 9);
      g.textAlign = 'left';
    }
    // Slots.
    const firstWrite = preview.writes[0];
    for (const b of L.slots) {
      if (!visible(b)) continue;
      const id = cellAt(wt, b.cx, b.cy);
      const vs = windowVoices(wt, voices, b.cx, b.cy);
      const fade = preview.fresh;
      if (fade) g.globalAlpha = 0.45;
      if (id === null) {
        g.setLineDash([3, 3]);
        g.strokeStyle = cBorder;
        g.lineWidth = 1;
        g.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
        g.setLineDash([]);
      } else {
        g.fillStyle = cCell;
        g.fillRect(b.x, b.y, b.w, b.h);
      }
      if (vs.length) {
        const c = cssColor(voiceColorVar(vs[0].id - 1));
        g.fillStyle = c;
        g.globalAlpha = (fade ? 0.45 : 1) * (vs[0].mute ? 0.12 : 0.26);
        g.fillRect(b.x, b.y, b.w, b.h);
        g.globalAlpha = fade ? 0.45 : 1;
        vs.forEach((v, k) => {
          g.strokeStyle = cssColor(voiceColorVar(v.id - 1));
          g.lineWidth = 1;
          g.strokeRect(b.x + 0.5 + k * 2, b.y + 0.5 + k * 2, b.w - 1 - k * 4, b.h - 1 - k * 4);
        });
      } else if (id !== null) {
        g.strokeStyle = cBorder;
        g.lineWidth = 1;
        g.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
      }
      const t = model.table(id);
      if (t) {
        const top = strip ? 18 : 3;
        const bot = strip ? 8 : 3;
        if (b.w >= 14 && b.h >= 12) drawWave(g, b.x + 4, b.y + top, b.w - 8, b.h - top - bot, t.data, cWave, { points: 40, lineWidth: strip ? 1.3 : 1.1 });
      }
      if (strip) {
        g.fillStyle = cLabel;
        g.font = mono;
        const idx = id === null ? -1 : indexOf(id);
        g.fillText(id === null ? `${b.cx + 1} · empty` : `${b.cx + 1} · #${idx + 1}`, b.x + 4, b.y + 12);
      }
      g.globalAlpha = 1;
      const ns = writesAt.get(`${b.cx},${b.cy}`);
      if (ns) {
        if (ns[0] === 1) headMark(b);
        const later = ns.find((n) => n > 1);
        if (later) badge(b.x + b.w - 9, b.y + b.h - 9, later);
      }
      if (sel && sel.x === b.cx && sel.y === b.cy) {
        g.strokeStyle = cSel;
        g.lineWidth = 2;
        g.strokeRect(b.x + 2, b.y + 2, b.w - 4, b.h - 4);
      }
    }
    // Next writes: inserts (a bar in the gap) and appended "new" cells.
    for (const [key, ns] of insertsAt) {
      const [x, y] = key.split(',').map(Number);
      const gx = L.slotLeft(x) - (L.kind === 'strip' ? STRIP_G : ROW_G) / 2;
      const top = L.rowTop(y);
      g.fillStyle = cNew;
      g.fillRect(gx - 1.5, top - 2, 3, L.cell.h + 4);
      badge(gx, top + L.cell.h / 2, ns[0]);
      if (ns.length > 1) {
        g.font = '9px system-ui, sans-serif';
        g.fillText(`…${ns[ns.length - 1]}`, gx + 8, top + L.cell.h / 2 + 3);
      }
    }
    for (const gh of L.ghosts) {
      if (!visible(gh)) continue;
      g.setLineDash([3, 3]);
      g.strokeStyle = cNew;
      g.lineWidth = 1;
      g.strokeRect(gh.x + 0.5, gh.y + 0.5, gh.w - 1, gh.h - 1);
      g.setLineDash([]);
      g.fillStyle = cNew;
      g.font = mono;
      if (strip) g.fillText('new', gh.x + 4, gh.y + 12);
      if (gh.n === 1 && firstWrite?.kind === 'append') headMark(gh);
      else badge(gh.x + gh.w - 9, gh.y + gh.h - 9, gh.n);
    }
    // Play positions.
    for (const v of voices) {
      const m = playingMix(model, bridge, v, mix);
      if (!m.n || L.kind === 'stack') continue;
      let px: number;
      let py: number;
      if (L.kind === 'rows') {
        const yi = Math.round(m.y);
        const len = Math.max(1, wt.rows[yi]?.length ?? 1);
        const p = voicePositions(model, bridge, v);
        const fx = wt.interp === 'step' ? m.x : p.x * (len - 1);
        px = L.slotLeft(0) + fx * L.pitch + L.cell.w / 2;
        py = L.rowTop(yi) + L.cell.h / 2;
      } else {
        px = L.slotLeft(0) + m.x * L.pitch + L.cell.w / 2;
        py = L.kind === 'strip' ? L.rowTop(0) + L.cell.h - 14 : L.rowTop(0) + m.y * (L.cell.h + GRID_G) + L.cell.h / 2;
      }
      g.beginPath();
      g.arc(px, py, 4, 0, 2 * Math.PI);
      g.fillStyle = cssColor(voiceColorVar(v.id - 1));
      g.fill();
      g.strokeStyle = cBg;
      g.lineWidth = 1.5;
      g.stroke();
    }
    // Drop indicator.
    if (dropAt) drawDrop(g, wt, L, dropAt);
    g.restore();
    canvas.dataset.drop = dropAt ? `${dropAt.t.kind}:${'x' in dropAt.t ? dropAt.t.x : ''},${dropAt.t.y}:${dropAt.ok ? 'ok' : 'no'}` : '';
    canvas.dataset.writes = preview.writes.map((w) => `${w.kind}:${w.x},${w.y}`).join(' ');
  };

  const drawDrop = (g: CanvasRenderingContext2D, wt: Wavetable, L: Layout, d: NonNullable<typeof dropAt>) => {
    const c = d.ok ? cssColor('--new') : cssColor('--danger');
    g.strokeStyle = c;
    g.fillStyle = c;
    const pill = (text: string, x: number, y: number) => {
      g.font = '10px system-ui, sans-serif';
      const tw = g.measureText(text).width + 8;
      g.fillStyle = c;
      g.fillRect(x - tw / 2, y - 7, tw, 14);
      g.fillStyle = cssColor('--on-accent');
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, x, y + 0.5);
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
    };
    const t = d.t;
    if (t.kind === 'slot') {
      const x = L.slotLeft(t.x);
      const y = L.rowTop(t.y);
      g.setLineDash([4, 3]);
      g.lineWidth = 2;
      g.strokeRect(x - 3, y - 3, L.cell.w + 6, L.cell.h + 6);
      g.setLineDash([]);
      if (L.cell.w >= 40) pill(d.move ? 'swap' : 'replace', x + L.cell.w / 2, y + L.cell.h / 2);
    } else if (t.kind === 'gap') {
      const gx = L.slotLeft(t.x) - (L.kind === 'strip' ? STRIP_G : ROW_G) / 2;
      const top = L.rowTop(t.y);
      g.fillRect(gx - 1.5, top - 4, 3, L.cell.h + 8);
      pill(t.x >= (wt.rows[t.y]?.length ?? 0) ? 'append' : 'insert', gx, top - 4);
    } else {
      const y = L.rowTop(t.y) - ROW_GAP / 2;
      g.fillRect(PAD, y - 1.5, Math.max(120, L.W - 2 * PAD), 3);
      pill('new row', PAD + ROW_LBL + 30, y);
    }
  };

  /** 1D stack: overlapping waveforms, first at the back (at most 48, evenly spaced). */
  const drawStack = (g: CanvasRenderingContext2D, wt: Wavetable, voices: VoiceParams[], w: number, H: number) => {
    const row = wt.rows[0] ?? [];
    const max = 48;
    const slots = row.length <= max ? row.map((_, i) => i) : Array.from({ length: max }, (_, i) => Math.round((i * (row.length - 1)) / (max - 1)));
    const n = slots.length;
    const lw = w * 0.7;
    const dx = n > 1 ? (w - lw - 24) / (n - 1) : 0;
    const top = 24;
    const dy = n > 1 ? (H - top - 22) / (n - 1) : 0;
    const amp = Math.min(22, H * 0.12);
    const cBg = cssColor('--bg');
    const cLine = cssColor('--muted');
    const first = preview.writes[0];
    slots.forEach((x, i) => {
      const id = row[x];
      const x0 = 12 + i * dx;
      const mid = top + i * dy;
      if (id === null) return;
      const t = model.table(id);
      if (!t) return;
      const vs = windowVoices(wt, voices, x, 0);
      const pts = 40;
      const path = () => {
        g.beginPath();
        for (let k = 0; k <= pts; k++) {
          const v = t.data[Math.min(t.data.length - 1, Math.floor((k / pts) * t.data.length))];
          const px = x0 + (k / pts) * lw;
          if (k) g.lineTo(px, mid - v * amp);
          else g.moveTo(px, mid - v * amp);
        }
      };
      path();
      g.lineTo(x0 + lw, mid + amp + 4);
      g.lineTo(x0, mid + amp + 4);
      g.closePath();
      g.fillStyle = cBg;
      g.fill();
      path();
      const isHead = first?.kind === 'replace' && first.x === x;
      g.strokeStyle = isHead ? cssColor('--new') : vs.length ? cssColor(voiceColorVar(vs[0].id - 1)) : cLine;
      g.lineWidth = isHead || vs.length ? 1.5 : 0.9;
      g.stroke();
    });
    if (row.length > max) {
      g.fillStyle = cLine;
      g.font = '10px ui-monospace, monospace';
      g.fillText(`${n} of ${row.length}`, w - 70, H - 6);
    }
  };

  // ---------------- hit testing ----------------
  const contentPoint = (clientX: number, clientY: number) => {
    const r = scroller.getBoundingClientRect();
    return { x: clientX - r.left - scroller.clientLeft + scroller.scrollLeft, y: clientY - r.top - scroller.clientTop + scroller.scrollTop, r };
  };
  const slotAt = (px: number, py: number): Cell | null => {
    if (!lay) return null;
    for (const b of lay.slots) if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return { x: b.cx, y: b.cy };
    return null;
  };
  /** Where a drop at (px, py) would land (before validity checks). */
  const dropTarget = (wt: Wavetable, px: number, py: number): SlotTarget | null => {
    const L = lay;
    if (!L || L.kind === 'stack') return null;
    if (L.kind === 'grid') {
      const s = slotAt(px, py);
      return s ? { kind: 'slot', ...s } : null;
    }
    let y = 0;
    if (L.kind === 'rows') {
      const band = ROW_H + ROW_GAP;
      const r = Math.floor((py - PAD + ROW_GAP / 2) / band);
      if (r >= wt.rows.length || r < 0) return { kind: 'row', y: Math.max(0, Math.min(wt.rows.length, r)) };
      const ly = py - L.rowTop(r);
      if (ly < 6) return { kind: 'row', y: r };
      if (ly > ROW_H - 6) return { kind: 'row', y: r + 1 };
      y = r;
      if (px < L.slotLeft(0)) return { kind: 'gap', x: wt.rows[r].length, y };
    }
    const len = wt.rows[y]?.length ?? 0;
    const i = Math.floor((px - L.slotLeft(0) + (L.pitch - L.cell.w) / 2) / L.pitch);
    // Past the end: append (a fixed line can't: nothing there).
    if (i >= len && wt.fixed) return null;
    if (i >= len || i < 0) return { kind: 'gap', x: i < 0 ? 0 : len, y };
    const lx = px - L.slotLeft(i);
    let t: SlotTarget = lx < EDGE ? { kind: 'gap', x: i, y } : lx > L.cell.w - EDGE ? { kind: 'gap', x: i + 1, y } : { kind: 'slot', x: i, y };
    // A fixed line takes no insert at its end: fall back to the slot.
    if (t.kind === 'gap' && !canTarget(wt, t, false)) t = { kind: 'slot', x: Math.min(i, len - 1), y };
    return t;
  };

  const describe = (wt: Wavetable, t: SlotTarget, move: boolean, copy: boolean): string => {
    const pre = copy ? 'Copy: ' : move ? 'Move: ' : '';
    if (t.kind === 'row') return `${pre}new row ${t.y + 1}`;
    if (t.kind === 'gap') {
      const len = wt.rows[t.y]?.length ?? 0;
      return t.x >= len ? `${pre}append${wt.shape === 'rows' ? ` to row ${t.y + 1}` : ''}` : `${pre}insert before ${slotName(wt, t)}`;
    }
    const filled = cellAt(wt, t.x, t.y) !== null;
    if (move) return `${filled ? 'Swap with' : 'Move to'} ${slotName(wt, t)}`;
    return `${pre}${filled ? 'replace' : 'fill'} ${slotName(wt, t)}`;
  };

  // ---------------- drop zone: the view ----------------
  const edgeScroll = (p: DragPoint, r: DOMRect) => {
    const e = 28;
    if (p.clientX < r.left + e) scroller.scrollLeft -= 12;
    else if (p.clientX > r.right - e) scroller.scrollLeft += 12;
    if (p.clientY < r.top + e) scroller.scrollTop -= 8;
    else if (p.clientY > r.bottom - e) scroller.scrollTop += 8;
  };
  const resolveDrop = (p: DragPoint, src: DragSource) => {
    const wt = cur();
    const { x, y, r } = contentPoint(p.clientX, p.clientY);
    if (p.clientX < r.left || p.clientX > r.right || p.clientY < r.top || p.clientY > r.bottom) return null;
    const t = dropTarget(wt, x, y);
    const move = !!src.from && src.from.wtId === wt.id && !p.copy;
    const copy = !!src.from && src.from.wtId === wt.id && p.copy;
    // The slot it came from, re-found by waveform: the wavetable may have changed under the
    // drag (a live insert shifts slots); gone = nothing to move.
    const from = move ? findSlot(wt, src.tableId, src.from!) : null;
    if (wt.builtin) return { wt, t, move, from, ok: false, label: `${wt.name} is built-in (read-only): Duplicate it to edit` };
    if (!t) return { wt, t, move, from, ok: false, label: modeOf(wt) === 'stack' ? 'Switch to Strip to drop here' : 'Drop on a slot' };
    if (move && !from) return { wt, t, move, from, ok: false, label: 'That waveform is no longer in this wavetable' };
    const ok = move ? moveSlot(wt, from!, t).wt !== wt : canTarget(wt, t);
    return { wt, t, move, from, ok, label: ok ? describe(wt, t, move, copy) : t.kind === 'slot' || move ? 'No change here' : 'Full (no room for more slots)' };
  };
  addDropZone({
    active: () => host.isOpen(),
    over(p, src) {
      const r = resolveDrop(p, src);
      if (!r) {
        if (dropAt) {
          dropAt = null;
          touch();
        }
        return null;
      }
      edgeScroll(p, scroller.getBoundingClientRect());
      const next = r.t ? { t: r.t, ok: r.ok, move: r.move } : null;
      if (JSON.stringify(next) !== JSON.stringify(dropAt)) {
        dropAt = next;
        touch();
      }
      return { label: r.label, ok: r.ok };
    },
    drop(p, src) {
      const r = resolveDrop(p, src);
      if (!r?.t || !r.ok) return;
      const wt = r.wt;
      const t = r.t;
      const from = r.from;
      if (r.move && from) model.moveInWavetable(wt.id, from, t);
      else model.placeInWavetable(wt.id, t, src.tableId);
      // Select where it landed: near the target, found by waveform (a move may have shifted
      // slots, or removed the emptied source row above it).
      const near = t.kind === 'row' ? { x: 0, y: t.y } : { x: t.kind === 'gap' && from && from.y === t.y && t.x > from.x ? t.x - 1 : t.x, y: t.y };
      const after = cur();
      sel = findSlot(after, src.tableId, near) ?? findSlot(after, src.tableId, { x: near.x, y: near.y - 1 }) ?? near;
      selFor = wt.id;
      scroller.focus({ preventScroll: true });
      syncFoot();
    },
    leave() {
      if (dropAt) {
        dropAt = null;
        touch();
      }
    },
  });

  // ---------------- drop zone: the list (open by hovering; drop adds) ----------------
  let spring: { id: string; since: number } | null = null;
  /** Where "add to this wavetable" puts a waveform: append / new row / first empty slot. */
  const addTarget = (wt: Wavetable): SlotTarget | null => {
    if (wt.shape === 'rows') return { kind: 'row', y: wt.rows.length };
    if (wt.shape === '1d' && !wt.fixed) return { kind: 'gap', x: wt.rows[0].length, y: 0 };
    for (let y = 0; y < wt.rows.length; y++) {
      const x = wt.rows[y].indexOf(null);
      if (x >= 0) return { kind: 'slot', x, y };
    }
    return null;
  };
  const listItemAt = (p: DragPoint): HTMLElement | null => {
    const r = items.getBoundingClientRect();
    if (p.clientX < r.left || p.clientX > r.right || p.clientY < r.top || p.clientY > r.bottom) return null;
    for (const b of items.querySelectorAll<HTMLElement>('.wte-item')) {
      const q = b.getBoundingClientRect();
      if (p.clientY >= q.top && p.clientY <= q.bottom) return b;
    }
    return null;
  };
  const setSpringOver = (b: HTMLElement | null) => {
    if (springOver === b) return;
    springOver?.classList.remove('drop-over');
    springOver = b;
    b?.classList.add('drop-over');
  };
  addDropZone({
    active: () => host.isOpen(),
    over(p) {
      const b = listItemAt(p);
      setSpringOver(b);
      if (!b) {
        spring = null;
        return null;
      }
      const id = Number(b.dataset.id);
      const wt = model.wavetable(id);
      if (!wt) return null;
      const now = performance.now();
      if (!spring || spring.id !== b.dataset.id) spring = { id: b.dataset.id!, since: now };
      else if (id !== host.current() && now - spring.since > SPRING_MS) pick(id);
      if (wt.builtin) return { label: `Open ${wt.name} (built-in, read-only)`, ok: false };
      const t = addTarget(wt);
      return t && canTarget(wt, t) ? { label: `Add to ${wt.name} (hold to open it)`, ok: true } : { label: `${wt.name} is full`, ok: false };
    },
    drop(p, src) {
      const b = listItemAt(p);
      const wt = b ? model.wavetable(Number(b.dataset.id)) : undefined;
      const t = wt && addTarget(wt);
      if (wt && t) model.placeInWavetable(wt.id, t, src.tableId);
    },
    leave() {
      spring = null;
      setSpringOver(null);
    },
  });

  // ---------------- pointer + keyboard on the view ----------------
  let pending: { x: number; y: number; cell: Cell; id: TableId; timer: ReturnType<typeof setTimeout> | null } | null = null;
  const cancelPending = () => {
    if (pending?.timer) clearTimeout(pending.timer);
    pending = null;
  };
  const startSlotDrag = (e: PointerEvent) => {
    if (!pending) return;
    const { cell, id } = pending;
    cancelPending();
    beginDrag({ tableId: id, from: { wtId: host.current(), x: cell.x, y: cell.y } }, e, model.table(id)?.data, scroller);
  };
  scroller.addEventListener('pointerdown', (e) => {
    cancelPending();
    if (e.button !== 0) return;
    const { x, y } = contentPoint(e.clientX, e.clientY);
    const cell = slotAt(x, y);
    const id = cell ? cellAt(cur(), cell.x, cell.y) : null;
    if (!cell || id === null) return;
    pending = { x: e.clientX, y: e.clientY, cell, id, timer: null };
    if (e.pointerType !== 'mouse') {
      // Touch / pen: hold to pick the waveform up (moving first scrolls the view).
      pending.timer = setTimeout(() => {
        if (!pending) return;
        pending.timer = null;
        navigator.vibrate?.(15);
        startSlotDrag(e);
      }, PICK_MS);
    }
  });
  scroller.addEventListener('pointermove', (e) => {
    if (!pending || isDragging()) return;
    const d = Math.hypot(e.clientX - pending.x, e.clientY - pending.y);
    if (e.pointerType === 'mouse') {
      if (d > DRAG_SLOP) startSlotDrag(e);
    } else if (d > TOUCH_SLOP) cancelPending();
  });
  for (const ev of ['pointerup', 'pointercancel'] as const) scroller.addEventListener(ev, cancelPending);
  scroller.addEventListener('contextmenu', (e) => {
    if (pending) e.preventDefault();
  });
  scroller.addEventListener('click', (e) => {
    if (consumeDragClick()) return;
    const wt = cur();
    const { x, y } = contentPoint(e.clientX, e.clientY);
    const cell = slotAt(x, y);
    if (e.altKey && !wt.builtin) {
      // Alt-click: move the write head (past the end of a 1D strip = append there).
      if (cell) model.setWavetableHead(wt.id, cell.x, cell.y);
      else if (lay?.kind === 'strip') model.setWavetableHead(wt.id, wt.rows[0].length, 0);
      return;
    }
    if (!cell) return;
    sel = cell;
    selFor = wt.id;
    const id = cellAt(wt, cell.x, cell.y);
    if (id !== null) model.select(id);
    syncFoot();
    touch();
  });
  const clearSel = () => {
    if (sel) model.clearWavetableSlot(host.current(), sel.x, sel.y);
  };
  const removeSel = () => {
    if (!sel) return;
    const wt = cur();
    model.removeWavetableSlot(wt.id, sel.x, sel.y);
    const w2 = cur();
    if (sel && (sel.y >= w2.rows.length || sel.x >= (w2.rows[sel.y]?.length ?? 0))) sel = w2.rows[sel.y]?.length ? { x: w2.rows[sel.y].length - 1, y: sel.y } : null;
    syncFoot();
  };
  scroller.addEventListener('keydown', (e) => {
    const wt = cur();
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    let handled = true;
    const move = (dx: number, dy: number) => {
      const { w, h: H } = wavetableDims(wt);
      if (!w && !H) return;
      const s = sel ?? { x: 0, y: 0 };
      const y = Math.max(0, Math.min(Math.max(0, H - 1), s.y + dy));
      const len = wt.rows[y]?.length ?? 0;
      if (!len) return;
      sel = { x: Math.max(0, Math.min(len - 1, s.x + dx)), y };
      selFor = wt.id;
      const id = cellAt(wt, sel.x, sel.y);
      if (id !== null) model.select(id);
      // Keep it in view.
      if (lay) {
        const bx = lay.slotLeft(sel.x);
        const by = lay.rowTop(sel.y);
        if (bx < scroller.scrollLeft) scroller.scrollLeft = bx - PAD;
        else if (bx + lay.cell.w > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = bx + lay.cell.w - scroller.clientWidth + PAD;
        if (by < scroller.scrollTop) scroller.scrollTop = by - PAD;
        else if (by + lay.cell.h > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = by + lay.cell.h - scroller.clientHeight + PAD;
      }
      syncFoot();
      touch();
    };
    // Shift+←/→ moves the selected slot along its line (the global Shift+←/→ moves in the
    // Timeline; this view opts out with data-shift-arrows).
    const shiftSlot = (d: number) => {
      if (!sel || wt.builtin) return;
      const s = sel;
      const len = wt.rows[s.y]?.length ?? 0;
      const to = s.x + d;
      if (to < 0 || to >= len) return;
      const t: SlotTarget = wt.shape === '2d' ? { kind: 'slot', x: to, y: s.y } : { kind: 'gap', x: d < 0 ? to : to + 1, y: s.y };
      if (model.moveInWavetable(wt.id, s, t)) {
        sel = { x: to, y: s.y };
        syncFoot();
        touch();
      }
    };
    if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) shiftSlot(e.key === 'ArrowLeft' ? -1 : 1);
    else if (e.key === 'ArrowLeft') move(-1, 0);
    else if (e.key === 'ArrowRight') move(1, 0);
    else if (e.key === 'ArrowUp' && wt.shape !== '1d') move(0, -1);
    else if (e.key === 'ArrowDown' && wt.shape !== '1d') move(0, 1);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel && !wt.builtin) {
      if (e.shiftKey) removeSel();
      else clearSel();
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  scroller.addEventListener('scroll', touch, { passive: true });

  // ---------------- wiring ----------------
  const refresh = () => {
    if (!el.isConnected) return;
    syncAll();
  };
  model.on('wavetables', refresh);
  model.on('timeline', refresh);
  model.on('voices', refresh);
  model.on('selection', () => {
    syncFoot();
    touch();
  });
  model.on('transport', touch);
  new ResizeObserver(touch).observe(scroller);
  onThemeChange(touch);

  const focusSize = () => {
    requestAnimationFrame(() => {
      wInput.focus();
      wInput.select();
    });
  };

  return {
    el,
    shown() {
      scrollOnPick = true;
      syncAll();
    },
    focusSize,
    view: {
      frame() {
        if (!host.isOpen() || !isOnScreen(canvas)) return;
        if (!dirty && !model.playing) return;
        dirty = false;
        draw();
      },
    },
  };
}
