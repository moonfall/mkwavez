import type { UiContext } from './context';
import { h, icon, ICONS, slider } from './dom';

/** Sticky transport bar: play/stop, tempo, undo, audio status. */
export function buildTransport(ctx: UiContext): HTMLElement {
  const { model, bridge } = ctx;
  const play = h('button', { class: 'play primary', id: 'play', 'aria-label': 'Play' }, icon(ICONS.play));
  const undoCount = h('span', { style: 'font-size:12px;color:var(--text-2);margin-left:4px' }, '0');
  const undo = h(
    'button',
    { class: 'undo', id: 'undo', 'aria-label': 'Undo', onclick: () => model.undo() },
    icon(ICONS.undo),
    undoCount,
  );
  const tempo = slider({
    label: 'Tempo',
    min: 40,
    max: 240,
    step: 1,
    value: model.bpm,
    format: (v) => `${v} bpm`,
    onInput: (v) => model.setTransport({ bpm: v }),
  });
  tempo.el.classList.add('tempo');
  const status = h('span', { class: 'status', id: 'audio-status' }, 'audio off');

  play.addEventListener('click', async () => {
    if (!model.playing) {
      try {
        await bridge.start();
      } catch (err) {
        console.error('Audio failed to start', err);
        return;
      }
      model.setTransport({ playing: true });
    } else {
      model.setTransport({ playing: false });
    }
  });

  const syncPlay = () => {
    play.replaceChildren(icon(model.playing ? ICONS.stop : ICONS.play));
    play.setAttribute('aria-label', model.playing ? 'Stop' : 'Play');
    tempo.set(model.bpm);
  };
  const syncUndo = () => {
    undoCount.textContent = String(model.undoDepth);
    undo.disabled = model.undoDepth === 0;
    undo.setAttribute('aria-label', `Undo, ${model.undoDepth} steps available`);
  };
  bridge.onState = (s) => {
    status.textContent = s === 'error' ? 'audio error' : `audio ${s}`;
    status.title = bridge.error;
    document.body.dataset.audio = s;
  };
  model.on('transport', syncPlay);
  model.on('undo', syncUndo);
  syncPlay();
  syncUndo();

  return h(
    'header',
    { class: 'transport' },
    h('span', { class: 'title' }, 'mkwavez'),
    play,
    undo,
    tempo.el,
    status,
  );
}
