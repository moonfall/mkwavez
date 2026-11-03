import type { MidiController } from '../app/midi';
import { CC_MAX_ASSIGNABLE, CC_PARAM_LABELS, CC_PARAMS, type CcParam } from '../core/midi';
import { webMidiMessage, type WebMidi } from '../browser/webMidi';
import type { UiContext } from './context';
import { h } from './dom';

const BLINK_MS = 90;
const hasPopover = typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype;

/**
 * Transport-bar MIDI controls: activity LED, input picker (Off / All inputs / each input;
 * a remembered input that is unplugged stays listed as "not connected" and reconnects on
 * hot-plug), short status, and a "MIDI" button opening a popover with the routing (channel
 * N → voice N, or Omni → the selected voice tab) and the CC map with learn.
 */
export function buildMidi(ctx: UiContext, midi: MidiController, web: WebMidi): HTMLElement {
  const { model, bridge, ui } = ctx;

  const led = h('span', { class: 'midi-led', id: 'midi-led', 'aria-hidden': 'true' });
  const select = h('select', { id: 'midi-input', 'aria-label': 'MIDI input', title: 'MIDI input' });
  const short = h('span', { class: 'midi-status', id: 'midi-status', role: 'status' });
  const open = h('button', { id: 'midi-settings', class: 'midi-open', 'aria-label': 'MIDI routing and controller map', title: 'MIDI routing and controller map', 'aria-haspopup': 'dialog' }, 'MIDI');

  // ---- popover ----
  const message = h('p', { class: 'midi-msg', id: 'midi-message' });
  const omni = h('input', { type: 'checkbox', id: 'midi-omni' });
  const omniLabel = h('span', { id: 'midi-omni-label' });
  omni.addEventListener('change', () => midi.setOmni(omni.checked));
  const routeHint = h('p', { class: 'hint midi-route-hint', id: 'midi-route-hint' });

  const ccInputs = new Map<CcParam, HTMLInputElement>();
  const learnBtns = new Map<CcParam, HTMLButtonElement>();
  const rows = CC_PARAMS.map((p) => {
    const input = h('input', {
      type: 'number',
      id: `midi-cc-${p}`,
      min: 0,
      max: CC_MAX_ASSIGNABLE,
      step: 1,
      placeholder: '—',
      'aria-label': `${CC_PARAM_LABELS[p]} controller number`,
    });
    input.addEventListener('change', () => {
      const n = input.value.trim() === '' ? -1 : Math.round(Number(input.value));
      midi.setCc(p, Number.isFinite(n) && n >= 0 && n <= CC_MAX_ASSIGNABLE ? n : -1);
    });
    const learn = h('button', {
      class: 'small midi-learn',
      id: `midi-learn-${p}`,
      'aria-pressed': 'false',
      onclick: () => midi.setLearn(midi.learn === p ? null : p),
    });
    const clear = h('button', { class: 'small', 'aria-label': `Unassign ${CC_PARAM_LABELS[p]}`, title: 'Unassign', onclick: () => midi.setCc(p, -1) }, '×');
    ccInputs.set(p, input);
    learnBtns.set(p, learn);
    return h('div', { class: 'midi-cc-row' }, h('span', { class: 'midi-cc-name' }, CC_PARAM_LABELS[p]), h('span', { class: 'midi-cc-pre' }, 'CC'), input, learn, clear);
  });
  const reset = h('button', { class: 'small', id: 'midi-cc-reset', onclick: () => midi.resetCc() }, 'Defaults');

  const pop = h(
    'div',
    { id: 'midi-pop', class: 'midi-pop', role: 'dialog', 'aria-label': 'MIDI' },
    h('div', { class: 'midi-pop-head' }, h('strong', {}, 'MIDI'), h('span', { class: 'grow' }), reset),
    message,
    h('label', { class: 'midi-omni' }, omni, omniLabel),
    routeHint,
    h('div', { class: 'midi-cc', role: 'group', 'aria-label': 'Controller map' }, ...rows),
    h(
      'p',
      { class: 'hint' },
      'Each voice is monophonic: the last key wins and releasing it returns to a key still held (no retrigger). ' +
        'Held keys take over from the voice’s sequence, which resumes once they are released. Bend ±2 semitones; velocity sets loudness.',
    ),
  );
  if (hasPopover) {
    pop.setAttribute('popover', 'auto');
    open.setAttribute('popovertarget', 'midi-pop');
    pop.addEventListener('toggle', (e) => {
      const isOpen = (e as ToggleEvent).newState === 'open';
      open.setAttribute('aria-expanded', String(isOpen));
      if (!isOpen) midi.setLearn(null);
    });
  } else {
    pop.hidden = true;
    open.addEventListener('click', () => {
      pop.hidden = !pop.hidden;
      open.setAttribute('aria-expanded', String(!pop.hidden));
      if (pop.hidden) midi.setLearn(null);
    });
  }
  open.setAttribute('aria-expanded', 'false');
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && midi.learn) {
      e.preventDefault();
      e.stopPropagation();
      midi.setLearn(null);
    }
  });

  // ---- input picker ----
  const fillSelect = () => {
    const s = midi.settings;
    const opts: [string, string][] = [
      ['off', 'MIDI off'],
      ['all', 'All MIDI inputs'],
    ];
    for (const i of web.inputs) opts.push([i.id, i.name]);
    if (s.input !== 'off' && s.input !== 'all' && !web.inputs.some((i) => i.id === s.input)) {
      opts.push([s.input, `${s.inputName || 'MIDI input'} (not connected)`]);
    }
    const sig = opts.map((o) => o.join('\u0001')).join('\u0002');
    if (select.dataset.sig !== sig) {
      select.dataset.sig = sig;
      select.replaceChildren(...opts.map(([v, l]) => h('option', { value: v }, l)));
    }
    select.value = s.input;
  };

  select.addEventListener('change', () => {
    const id = select.value;
    const name = web.inputs.find((i) => i.id === id)?.name ?? '';
    midi.setInput(id, name);
    void web.select(id);
    // A user gesture: start audio now so the first key sounds (the transport stays stopped).
    if (id !== 'off' && bridge.state === 'off') bridge.start().catch((err) => console.warn('Audio failed to start', err));
  });

  // Audio can only start on a user gesture; with MIDI on, the first click / key anywhere starts it.
  const kick = () => {
    if (midi.settings.input !== 'off' && bridge.state === 'off') bridge.start().catch((err) => console.warn('Audio failed to start', err));
  };
  document.addEventListener('pointerdown', kick, { capture: true });
  document.addEventListener('keydown', kick, { capture: true });

  // ---- status ----
  const syncStatus = () => {
    fillSelect();
    const choice = midi.settings.input;
    const st = web.state;
    const bad = st === 'unsupported' || st === 'insecure' || st === 'denied' || st === 'error';
    const m = webMidiMessage(st, web.detail);
    let long = m.long;
    let shortText = m.short;
    if (!bad && choice !== 'off' && st === 'ready') {
      const n = web.listening;
      if (n === 0) {
        shortText = 'No input';
        long = choice === 'all' ? 'No MIDI inputs connected. Plug one in; it is picked up automatically.' : `${midi.settings.inputName || 'The chosen input'} is not connected; it reconnects when plugged in.`;
      } else {
        long = `Listening to ${n === 1 ? (web.inputs.find((i) => i.id === choice)?.name ?? web.inputs[0]?.name ?? '1 input') : `${n} inputs`}.`;
        if (bridge.state !== 'running') long += ' Audio starts on your first click (a browser rule).';
      }
    } else if (choice === 'off' && !bad) {
      shortText = '';
      long = webMidiMessage('idle').long;
    }
    short.textContent = shortText;
    short.hidden = !shortText;
    short.title = long;
    message.textContent = long;
    message.classList.toggle('midi-msg-error', bad);
    led.dataset.state = bad ? 'error' : choice !== 'off' && st === 'ready' && web.listening > 0 ? 'on' : 'off';
    select.disabled = st === 'unsupported' || st === 'insecure';
    select.title = bad ? m.long : 'MIDI input';
  };

  const syncSettings = () => {
    const s = midi.settings;
    omni.checked = s.omni;
    const v = ui.voiceId === null ? undefined : model.voice(ui.voiceId);
    omniLabel.textContent = `Omni: every channel plays the selected voice${v ? ` (${v.name})` : ''}`;
    const ids = model.voices.map((x) => x.id);
    routeHint.textContent = s.omni
      ? 'Switching voice tabs moves the keyboard to that voice.'
      : `Channel N plays voice VN (${ids.map((id) => `ch ${id} → V${id}`).join(', ') || 'no voices'}).`;
    for (const p of CC_PARAMS) {
      const input = ccInputs.get(p)!;
      if (document.activeElement !== input) input.value = s.cc[p] >= 0 ? String(s.cc[p]) : '';
    }
    syncLearn();
    syncStatus();
  };

  const syncLearn = () => {
    for (const p of CC_PARAMS) {
      const b = learnBtns.get(p)!;
      const on = midi.learn === p;
      b.textContent = on ? 'Move a control…' : 'Learn';
      b.classList.toggle('seg-on', on);
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', on ? `Learning ${CC_PARAM_LABELS[p]}: move a MIDI control (click to cancel)` : `Learn ${CC_PARAM_LABELS[p]} from a MIDI control`);
    }
  };

  let blinkTimer = 0;
  midi.on('activity', () => {
    if (!blinkTimer) led.classList.add('blink');
    else clearTimeout(blinkTimer);
    blinkTimer = window.setTimeout(() => {
      blinkTimer = 0;
      led.classList.remove('blink');
    }, BLINK_MS);
  });
  midi.on('settings', syncSettings);
  midi.on('learn', syncLearn);
  model.on('voices', syncSettings);
  ui.onVoice(syncSettings);
  web.onChange = syncStatus;
  bridge.onStateChange(syncStatus);
  syncSettings();

  return h('span', { class: 'midi', id: 'midi' }, led, select, short, open, pop);
}
