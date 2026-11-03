import { MAX_STEPS, SCALE_ROWS } from '../core/constants';
import { randomSeed } from '../core/prng';
import { emptySteps, randomSteps, REST, toggleStep, type SequenceData } from '../core/sequence';
import { cssColor, fit, onThemeChange } from './canvas';
import { isOnScreen, watchVisibility, type FrameView, type UiContext } from './context';
import { cardCollapse, h, icon, ICONS, section, slider, voiceColorVar } from './dom';

const ROW_H = 12;
const MIN_CELL_W = 16;

interface Card {
  el: HTMLElement;
  grid: HTMLCanvasElement;
  dirty: boolean;
  lastStep: number;
  collapsed(): boolean;
  sync(s: SequenceData): void;
  draw(): void;
}

let clipboard: number[] | null = null;

/** Sequences: dev/test step patterns, each targeting a voice, on the shared transport. */
export function buildSequences(ctx: UiContext): { el: HTMLElement; view: FrameView } {
  const { model, bridge } = ctx;
  const sec = section('sec-sequences', 'Sequences');
  const list = h('div', { id: 'sequence-list' });
  const addBtn = h(
    'button',
    { id: 'add-sequence', onclick: () => model.addSequence(model.voices[0]?.id ?? null) },
    '+ Add sequence',
  );
  sec.body.append(
    h('p', { class: 'hint' }, 'Eighth-note steps over A minor pentatonic (rows, low to high). Click to toggle.'),
    list,
    h('div', { class: 'add-row' }, addBtn),
  );
  const cards = new Map<number, Card>();

  const makeCard = (s0: SequenceData): Card => {
    const id = s0.id;
    let s = s0;
    const voiceIdx = () => (s.voiceId === null ? -1 : model.voiceIndex(s.voiceId));
    const color = () => (s.voiceId === null ? cssColor('--muted') : cssColor(voiceColorVar(s.voiceId - 1)));

    const title = h('span', { class: 'name' }, `Seq ${id}`);
    const target = h('select', { 'aria-label': `Sequence ${id} target voice`, style: 'flex:0 1 auto' });
    const fillTargets = () => {
      target.replaceChildren(
        h('option', { value: '' }, '— none —'),
        ...model.voices.map((v) => h('option', { value: String(v.id) }, `→ ${v.name}`)),
      );
      target.value = s.voiceId === null ? '' : String(s.voiceId);
    };
    target.addEventListener('change', () =>
      model.updateSequence(id, { voiceId: target.value === '' ? null : Number(target.value) }),
    );
    const removeBtn = h(
      'button',
      { class: 'small', 'aria-label': `Remove sequence ${id}`, onclick: () => model.removeSequence(id) },
      icon(ICONS.close),
    );
    const body = h('div', { class: 'card-body' });
    const el = h('div', { class: 'card', id: `sequence-${id}` });
    const collapse = cardCollapse(`sequence ${id}`, el, body, (c) => {
      if (!c) card.dirty = true;
    });
    const meta = h('span', { class: 'meta' });
    const head = h('div', { class: 'card-head' }, collapse.button, title, target, meta, removeBtn);

    const len = slider({ label: 'Length', min: 1, max: MAX_STEPS, step: 1, value: s.length, onInput: (x) => model.updateSequence(id, { length: x }) });
    const gate = slider({
      label: 'Gate',
      min: 0.05,
      max: 1,
      step: 0.01,
      value: s.gate,
      format: (x) => `${Math.round(x * 100)}%`,
      onInput: (x) => model.updateSequence(id, { gate: x }),
    });

    const copyBtn = h('button', {
      class: 'grow',
      onclick: () => {
        clipboard = s.steps.slice();
        copyBtn.textContent = 'Copied';
        setTimeout(() => (copyBtn.textContent = 'Copy'), 900);
      },
    }, 'Copy');
    const buttons = h(
      'div',
      { class: 'row' },
      copyBtn,
      h('button', { class: 'grow', onclick: () => clipboard && model.updateSequence(id, { steps: clipboard }, true) }, 'Paste'),
      h('button', { class: 'grow', onclick: () => model.updateSequence(id, { steps: emptySteps() }, true) }, 'Clear'),
      h(
        'button',
        {
          style: 'flex:0 0 44px',
          'aria-label': `Randomize sequence ${id}`,
          onclick: () => model.updateSequence(id, { steps: randomSteps(s.length, randomSeed()) }, true),
        },
        icon(ICONS.shuffle),
      ),
    );

    const grid = h('canvas', { 'aria-label': `Sequence ${id} step grid; click to toggle notes`, class: 'seq-grid' });
    watchVisibility(grid);
    const cellW = () => Math.max(MIN_CELL_W, (wrap.clientWidth || 300) / s.length);
    const wrap = h('div', { class: 'grid-wrap' }, grid);
    grid.addEventListener('click', (e) => {
      const r = grid.getBoundingClientRect();
      const col = Math.floor((e.clientX - r.left) / cellW());
      const row = SCALE_ROWS - 1 - Math.floor((e.clientY - r.top) / ROW_H);
      if (col < 0 || col >= s.length || row < 0 || row >= SCALE_ROWS) return;
      model.updateSequence(id, { steps: toggleStep(s.steps, col, row) }, true);
    });

    body.append(h('div', { class: 'grid2' }, len.el, gate.el), buttons, wrap);
    el.append(head, body);

    const card: Card = {
      el,
      grid,
      dirty: true,
      lastStep: -2,
      collapsed: collapse.collapsed,
      sync(ns) {
        s = ns;
        len.set(s.length);
        gate.set(s.gate);
        fillTargets();
        title.style.color = s.voiceId === null ? 'var(--muted)' : `var(${voiceColorVar(s.voiceId - 1)})`;
        const vi = voiceIdx();
        meta.textContent = vi >= 0 && model.voices[vi].mute ? 'muted' : '';
        card.dirty = true;
      },
      draw() {
        const cw = cellW();
        const width = cw * s.length;
        grid.style.width = `${width}px`;
        const hh = ROW_H * SCALE_ROWS;
        const [g] = fit(grid, hh);
        const step = model.playing && bridge.status.step >= 0 ? bridge.status.step % s.length : -1;
        card.lastStep = step;
        if (step >= 0) {
          g.fillStyle = cssColor('--accent-bg');
          g.fillRect(step * cw, 0, cw, hh);
        }
        g.lineWidth = 1;
        for (let k = 1; k < s.length; k++) {
          g.strokeStyle = k % 4 ? cssColor('--border') : cssColor('--border-strong');
          g.beginPath();
          g.moveTo(Math.round(k * cw) + 0.5, 0);
          g.lineTo(Math.round(k * cw) + 0.5, hh);
          g.stroke();
        }
        const muted = voiceIdx() >= 0 && model.voices[voiceIdx()].mute;
        g.fillStyle = color();
        g.globalAlpha = muted || s.voiceId === null ? 0.4 : 1;
        for (let k = 0; k < s.length; k++) {
          const r = s.steps[k];
          if (r !== REST) g.fillRect(k * cw + 2, (SCALE_ROWS - 1 - r) * ROW_H + 1.5, cw - 4, ROW_H - 3);
        }
        g.globalAlpha = 1;
      },
    };
    card.sync(s);
    return card;
  };

  const sync = () => {
    const live = new Set(model.sequences.map((s) => s.id));
    for (const [id, c] of cards) {
      if (!live.has(id)) {
        c.el.remove();
        cards.delete(id);
      }
    }
    for (const s of model.sequences) {
      let c = cards.get(s.id);
      if (!c) {
        c = makeCard(s);
        cards.set(s.id, c);
        list.append(c.el);
      } else c.sync(s);
    }
    sec.meta.textContent = `${model.sequences.length}`;
  };

  model.on('sequences', sync);
  model.on('voices', () => {
    for (const s of model.sequences) cards.get(s.id)?.sync(s);
  });
  model.on('transport', () => {
    for (const c of cards.values()) c.dirty = true;
  });
  onThemeChange(() => {
    for (const c of cards.values()) c.dirty = true;
  });
  sec.el.addEventListener('toggle', () => {
    for (const c of cards.values()) c.dirty = true;
  });
  new ResizeObserver(() => {
    for (const c of cards.values()) c.dirty = true;
  }).observe(list);
  sync();

  return {
    el: sec.el,
    view: {
      frame() {
        if (!sec.el.open) return;
        for (const [id, c] of cards) {
          if (c.collapsed() || !isOnScreen(c.grid)) continue;
          const s = model.sequences.find((x) => x.id === id);
          const step = s && model.playing && bridge.status.step >= 0 ? bridge.status.step % s.length : -1;
          if (c.dirty || step !== c.lastStep) {
            c.dirty = false;
            c.draw();
          }
        }
      },
    },
  };
}
