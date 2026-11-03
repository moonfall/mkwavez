import { MAX_STEPS, SCALE_ROWS, SCALE_SEMITONES } from '../core/constants';
import { randomSeed } from '../core/prng';
import { emptySteps, randomSteps, toggleStep, type SequenceData } from '../core/sequence';
import { cssColor, fit, onThemeChange } from './canvas';
import { isOnScreen, watchVisibility, type FrameView, type UiContext } from './context';
import { h, icon, ICONS, panel, slider, voiceColorVar } from './dom';

/** Row-label column (note names) at the left of the grid. */
const LABEL_W = 30;
const MIN_CELL_W = 12;
const MIN_ROW_H = 12;
/** MIDI note of scale row 0 at octave 0 (SCALE_ROOT_HZ = 110 Hz = A2). */
const ROOT_MIDI = 45;
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

const noteName = (row: number, octave: number) => {
  const m = ROOT_MIDI + SCALE_SEMITONES[row] + 12 * octave;
  return `${NOTE_NAMES[m % 12]}${Math.floor(m / 12) - 1}`;
};

let clipboard: number[] | null = null;

/**
 * Sequence: the step pattern(s) of the selected voice (UiState), on the shared transport.
 * Eighth-note steps over A minor pentatonic; the grid fills the panel (row labels are the
 * voice's notes). A voice with several sequences gets a small picker; one without gets
 * an "Add sequence" button.
 */
export function buildSequences(ctx: UiContext): { el: HTMLElement; view: FrameView } {
  const { model, bridge, ui } = ctx;
  const sec = panel('sec-sequences', 'Sequence');
  /** Shown sequence per voice (when a voice has more than one). */
  const shownSeq = new Map<number, number>();

  const voiceSeqs = () => model.sequences.filter((s) => s.voiceId !== null && s.voiceId === ui.voiceId);
  const cur = (): SequenceData | undefined => {
    const list = voiceSeqs();
    const want = ui.voiceId === null ? undefined : shownSeq.get(ui.voiceId);
    return list.find((s) => s.id === want) ?? list[0];
  };
  const update = (patch: Partial<SequenceData>, undoable = false) => {
    const s = cur();
    if (s) model.updateSequence(s.id, patch, undoable);
  };
  const addSequence = () => {
    if (ui.voiceId === null) return;
    const s = model.addSequence(ui.voiceId);
    shownSeq.set(ui.voiceId, s.id);
    sync();
  };

  // ---- header: target voice, sequence picker, steps, scale ----
  const target = h('span', { class: 'seq-target', id: 'seq-target' });
  const picker = h('div', { class: 'seq-picker', role: 'group', 'aria-label': 'Sequences of this voice' });
  const lenInput = h('input', { type: 'number', id: 'seq-length', min: 1, max: MAX_STEPS, step: 1, inputmode: 'numeric', 'aria-label': 'Steps' });
  lenInput.addEventListener('change', () => {
    const v = Math.round(Number(lenInput.value));
    if (Number.isFinite(v)) update({ length: v });
    lenInput.value = String(cur()?.length ?? 16);
  });
  sec.tools.append(
    target,
    picker,
    h('span', { class: 'grow' }),
    h('label', { class: 'inline-field' }, h('span', {}, 'Steps'), lenInput),
    h('span', { class: 'inline-field seq-scale', title: 'Scale (fixed for now)' }, h('span', {}, 'Scale'), h('b', {}, 'A min pent')),
  );

  // ---- toolbar: gate, copy / paste / clear / random / remove ----
  const gate = slider({ label: 'Gate', min: 0.05, max: 1, step: 0.01, value: 0.5, format: (x) => `${Math.round(x * 100)}%`, onInput: (x) => update({ gate: x }) });
  gate.input.id = 'seq-gate';
  const copyBtn = h(
    'button',
    {
      class: 'small',
      id: 'seq-copy',
      onclick: () => {
        const s = cur();
        if (!s) return;
        clipboard = s.steps.slice();
        copyBtn.textContent = 'Copied';
        setTimeout(() => (copyBtn.textContent = 'Copy'), 900);
      },
    },
    'Copy',
  );
  const toolbar = h(
    'div',
    { class: 'seq-toolbar' },
    h('div', { class: 'vrows seq-gate' }, gate.el),
    copyBtn,
    h('button', { class: 'small', id: 'seq-paste', onclick: () => clipboard && update({ steps: clipboard }, true) }, 'Paste'),
    h('button', { class: 'small', id: 'seq-clear', onclick: () => update({ steps: emptySteps() }, true) }, 'Clear'),
    h(
      'button',
      {
        class: 'small icon-btn',
        id: 'seq-random',
        'aria-label': 'Randomize the sequence',
        title: 'Randomize',
        onclick: () => update({ steps: randomSteps(cur()?.length ?? 16, randomSeed()) }, true),
      },
      icon(ICONS.shuffle),
    ),
    h('button', { class: 'small', id: 'seq-add', title: 'Add another sequence for this voice', onclick: () => addSequence() }, '+ Seq'),
    h(
      'button',
      {
        class: 'small icon-btn',
        id: 'seq-remove',
        'aria-label': 'Remove this sequence',
        title: 'Remove this sequence',
        onclick: () => {
          const s = cur();
          if (s) model.removeSequence(s.id);
        },
      },
      icon(ICONS.close),
    ),
  );

  // ---- grid ----
  const grid = h('canvas', { class: 'seq-grid', id: 'seq-grid', 'aria-label': 'Step grid; click to toggle notes' });
  const box = h('div', { class: 'seq-box' }, grid);
  watchVisibility(grid);
  const content = h('div', { class: 'seq-content' }, toolbar, box);
  const addBtn = h('button', { id: 'add-sequence', onclick: () => addSequence() }, '+ Add sequence');
  const emptyText = h('span', {});
  const empty = h('div', { class: 'seq-empty', hidden: true }, emptyText, addBtn);
  sec.body.append(content, empty);

  let dirty = true;
  let lastStep = -2;
  let cellW = MIN_CELL_W;
  let rowH = MIN_ROW_H;

  const draw = (s: SequenceData) => {
    const v = s.voiceId === null ? undefined : model.voice(s.voiceId);
    const availW = box.clientWidth || 300;
    const availH = box.clientHeight || 8 * 20;
    cellW = Math.max(MIN_CELL_W, (availW - LABEL_W) / s.length);
    rowH = Math.max(MIN_ROW_H, Math.floor(availH / SCALE_ROWS));
    const width = LABEL_W + cellW * s.length;
    grid.style.width = `${width}px`;
    const hh = rowH * SCALE_ROWS;
    const [g] = fit(grid, hh);
    const step = model.playing && bridge.status.step >= 0 ? bridge.status.step % s.length : -1;
    lastStep = step;
    const cBeat = cssColor('--surface-2');
    const cCell = cssColor('--bg');
    const cBorder = cssColor('--border');
    const cPlay = cssColor('--accent-bg');
    const color = v ? cssColor(voiceColorVar(v.id - 1)) : cssColor('--muted');
    const muted = !v || v.mute;
    g.font = '10px ui-monospace, monospace';
    g.textBaseline = 'middle';
    g.fillStyle = cssColor('--text-2');
    for (let r = 0; r < SCALE_ROWS; r++) g.fillText(noteName(r, v?.octave ?? 0), 2, (SCALE_ROWS - 1 - r) * rowH + rowH / 2);
    const gap = cellW > 14 ? 2 : 1;
    for (let k = 0; k < s.length; k++) {
      const x = LABEL_W + k * cellW;
      const bg = k === step ? cPlay : k % 4 === 0 ? cBeat : cCell;
      for (let r = 0; r < SCALE_ROWS; r++) {
        const y = (SCALE_ROWS - 1 - r) * rowH;
        const on = s.steps[k] === r;
        g.fillStyle = on ? color : bg;
        g.globalAlpha = on && muted ? 0.45 : 1;
        g.fillRect(x + gap / 2, y + gap / 2, cellW - gap, rowH - gap);
        g.globalAlpha = 1;
        if (!on && k !== step) {
          g.strokeStyle = cBorder;
          g.lineWidth = 1;
          g.strokeRect(x + gap / 2 + 0.5, y + gap / 2 + 0.5, cellW - gap - 1, rowH - gap - 1);
        }
      }
    }
    grid.dataset.length = String(s.length);
    grid.dataset.sequence = String(s.id);
  };

  grid.addEventListener('click', (e) => {
    const s = cur();
    if (!s) return;
    const r = grid.getBoundingClientRect();
    const col = Math.floor((e.clientX - r.left - LABEL_W) / cellW);
    const row = SCALE_ROWS - 1 - Math.floor((e.clientY - r.top) / rowH);
    if (e.clientX - r.left < LABEL_W || col < 0 || col >= s.length || row < 0 || row >= SCALE_ROWS) return;
    model.updateSequence(s.id, { steps: toggleStep(s.steps, col, row) }, true);
  });

  const sync = () => {
    const v = ui.voiceId === null ? undefined : model.voice(ui.voiceId);
    const list = voiceSeqs();
    const s = cur();
    if (v && s) shownSeq.set(v.id, s.id);
    target.textContent = v ? `→ ${v.name}${v.mute ? ' · muted' : ''}` : '';
    target.style.color = v ? `var(${voiceColorVar(v.id - 1)})` : '';
    picker.replaceChildren(
      ...(list.length > 1
        ? list.map((x) =>
            h(
              'button',
              {
                class: 'small',
                'aria-pressed': String(x.id === s?.id),
                onclick: () => {
                  if (v) shownSeq.set(v.id, x.id);
                  sync();
                },
              },
              `Seq ${x.id}`,
            ),
          )
        : []),
    );
    content.hidden = !s;
    empty.hidden = !!s;
    emptyText.textContent = v ? `No sequence for ${v.name}.` : 'No voice selected.';
    addBtn.hidden = !v;
    lenInput.disabled = !s;
    sec.meta.textContent = s ? `Seq ${s.id}` : '';
    if (s) {
      if (document.activeElement !== lenInput) lenInput.value = String(s.length);
      gate.set(s.gate);
    }
    dirty = true;
  };

  model.on('sequences', sync);
  model.on('voices', sync);
  ui.onVoice(sync);
  model.on('transport', () => (dirty = true));
  onThemeChange(() => (dirty = true));
  sec.onToggle(() => (dirty = true));
  new ResizeObserver(() => (dirty = true)).observe(box);
  sync();

  return {
    el: sec.el,
    view: {
      frame() {
        const s = cur();
        if (!s || !sec.isOpen() || !isOnScreen(grid)) return;
        const step = model.playing && bridge.status.step >= 0 ? bridge.status.step % s.length : -1;
        if (dirty || step !== lastStep) {
          dirty = false;
          draw(s);
        }
      },
    },
  };
}
