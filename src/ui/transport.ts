import { currentTheme, setTheme } from './canvas';
import type { UiContext } from './context';
import { h, icon, ICONS } from './dom';
import { buildHoldNote } from './holdNote';
import { SHORTCUTS } from './shortcuts';

/** Start (audio first, on the first press) or stop the transport. */
export async function togglePlay(ctx: UiContext): Promise<void> {
  const { model, bridge } = ctx;
  if (model.playing) {
    model.setTransport({ playing: false });
    return;
  }
  try {
    await bridge.start();
  } catch (err) {
    console.error('Audio failed to start', err);
    return;
  }
  model.setTransport({ playing: true });
}

/**
 * Transport bar: name, play/stop, tempo, undo, `extra` (the MIDI controls), status (waveforms,
 * sample rate, audio), theme.
 */
export function buildTransport(ctx: UiContext, extra: Node | null = null): HTMLElement {
  const { model, bridge } = ctx;
  const play = h('button', { class: 'play primary', id: 'play', 'aria-label': 'Play', 'aria-keyshortcuts': SHORTCUTS.play }, icon(ICONS.play));
  const undoCount = h('span', { class: 'undo-count' }, '0');
  const undo = h(
    'button',
    { class: 'undo', id: 'undo', 'aria-label': 'Undo', onclick: () => model.undo() },
    icon(ICONS.undo),
    h('span', { class: 'undo-label' }, 'Undo'),
    undoCount,
  );

  // Tempo: compact range + readout.
  const bpmVal = h('span', { class: 'bpm-val', id: 'bpm-val' }, String(model.bpm));
  const bpm = h('input', { type: 'range', id: 'bpm', min: 40, max: 240, step: 1, value: model.bpm, 'aria-label': 'Tempo (BPM)' });
  bpm.addEventListener('input', () => {
    bpmVal.textContent = bpm.value;
    model.setTransport({ bpm: Number(bpm.value) });
  });
  const tempo = h('label', { class: 'tempo' }, h('span', { class: 'bpm-label' }, 'BPM'), bpm, bpmVal);

  const tables = h('span', { id: 'tables-status', title: 'Waveforms in the Timeline / cap' });
  const rate = h('span', { id: 'rate-status' });
  const audio = h('span', { id: 'audio-status' }, 'audio off');
  const status = h('span', { class: 'status' }, tables, h('span', { class: 'sep' }, ' · '), rate, h('span', { class: 'sep' }, ' · '), audio);

  const theme = h('button', { id: 'theme-toggle', class: 'theme' });
  const syncTheme = () => {
    const dark = currentTheme() === 'dark';
    theme.replaceChildren(icon(dark ? ICONS.sun : ICONS.moon));
    theme.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    theme.title = theme.getAttribute('aria-label')!;
  };
  theme.addEventListener('click', () => {
    setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
    syncTheme();
  });
  syncTheme();

  play.addEventListener('click', () => void togglePlay(ctx));

  const syncPlay = () => {
    play.replaceChildren(icon(model.playing ? ICONS.stop : ICONS.play));
    play.setAttribute('aria-label', model.playing ? 'Stop' : 'Play');
    play.title = `${model.playing ? 'Stop' : 'Play'} (Space)`;
    if (document.activeElement !== bpm) bpm.value = String(model.bpm);
    bpmVal.textContent = String(model.bpm);
  };
  const syncUndo = () => {
    undoCount.textContent = String(model.undoDepth);
    undo.disabled = model.undoDepth === 0;
    undo.setAttribute('aria-label', `Undo, ${model.undoDepth} steps available`);
  };
  const syncTables = () => {
    tables.textContent = `${model.timeline.length} / ${model.cap} waveforms`;
  };
  const syncRate = () => {
    rate.textContent = `${+(bridge.sampleRate / 1000).toFixed(1)} kHz`;
  };
  bridge.onState = (s) => {
    audio.textContent = s === 'error' ? 'audio error' : `audio ${s}`;
    audio.title = bridge.error;
    document.body.dataset.audio = s;
    syncRate();
  };
  model.on('transport', syncPlay);
  model.on('undo', syncUndo);
  model.on('timeline', syncTables);
  syncPlay();
  syncUndo();
  syncTables();
  // The bridge may already be running (inside the plugin it starts before the UI is built).
  bridge.onState(bridge.state);

  return h(
    'header',
    { class: 'transport' },
    h('span', { class: 'title' }, 'mkwavez'),
    play,
    tempo,
    // Play and sustain a note on the selected voice (no MIDI keyboard needed).
    buildHoldNote(ctx).el,
    undo,
    h('span', { class: 'grow' }),
    extra,
    status,
    theme,
  );
}
