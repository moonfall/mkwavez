/**
 * Voice presets and copy / paste in the Voice panel: a preset picker (factory presets, then
 * the session's own) and a "⋯" menu — save the voice as a preset, delete the chosen user
 * preset, copy this voice, paste a copied voice onto it, export / import the user presets
 * (a small JSON file). Presets are applied through AppModel (one undo step each).
 */
import type { AppModel } from '../app/model';
import { FACTORY_PRESETS, parsePresetsFile, presetsFile, type VoicePreset } from '../core/presets';
import type { VoiceParams } from '../core/voice';
import { h } from './dom';
import { downloadBytes, pickFile } from './session';
import { ask } from './dialogs';

/** The copied voice (shared by every voice tab; per page load). */
let clip: VoiceParams | null = null;
const clipFns = new Set<() => void>();
export function voiceClip(): VoiceParams | null {
  return clip;
}
export function setVoiceClip(v: VoiceParams | null): void {
  clip = v;
  for (const fn of clipFns) fn();
}
export function onVoiceClip(fn: () => void): void {
  clipFns.add(fn);
}

/** A fixed popup menu under (or above) a button; closes on outside press, Esc or a pick. */
export function popupMenu(id: string, button: HTMLButtonElement, items: () => (HTMLButtonElement | null)[]): { close(): void } {
  const menu = h('div', { id, class: 'add-voice-menu', role: 'menu', hidden: true });
  document.body.append(menu);
  const close = () => {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!menu.hidden) return close();
    menu.replaceChildren(...items().filter((b): b is HTMLButtonElement => !!b));
    for (const b of menu.querySelectorAll('button')) b.addEventListener('click', close);
    const r = button.getBoundingClientRect();
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(innerWidth - mw - 8, r.right - mw))}px`;
    menu.style.top = `${r.bottom + 4 + mh > innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4}px`;
    (menu.querySelector('button:not(:disabled)') as HTMLElement | null)?.focus();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.contains(e.target as Node) && !button.contains(e.target as Node)) close();
  });
  menu.addEventListener('keydown', (e) => {
    const list = [...menu.querySelectorAll('button:not(:disabled)')] as HTMLElement[];
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      close();
      button.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
    }
  });
  return { close };
}

const item = (id: string, label: string, onclick: () => void, disabled = false) =>
  h('button', { id, role: 'menuitem', class: 'menu-item', onclick, disabled }, h('b', {}, label));

/**
 * The preset picker + menu for the selected (Synth) voice. `voice()` = the voice it acts on.
 * Returns the elements to place and a sync() for model changes.
 */
export function buildPresetControls(model: AppModel, voice: () => VoiceParams | undefined, notify: (msg: string) => void) {
  const pick = h('select', { id: 'syn-preset', class: 'syn-preset', 'aria-label': 'Preset', title: 'Apply a preset (undoable)' });
  let sig: string | null = null;
  let chosen = ''; // the user preset last applied / saved (for Delete)
  const fill = () => {
    const s = model.voicePresets.map((p) => `${p.id}:${p.name}`).join('|');
    if (s === sig) return;
    sig = s;
    pick.replaceChildren(
      h('option', { value: '' }, 'Preset…'),
      h('optgroup', { label: 'Factory' }, ...FACTORY_PRESETS.map((p) => h('option', { value: `f:${p.id}` }, p.name))),
      ...(model.voicePresets.length ? [h('optgroup', { label: 'Yours' }, ...model.voicePresets.map((p) => h('option', { value: `u:${p.id}` }, p.name)))] : []),
    );
  };
  const find = (value: string): VoicePreset | undefined =>
    value.startsWith('f:') ? FACTORY_PRESETS.find((p) => `f:${p.id}` === value) : model.voicePresets.find((p) => `u:${p.id}` === value);
  pick.addEventListener('change', () => {
    const v = voice();
    const p = find(pick.value);
    if (v && p) {
      const notice = model.notice;
      model.applyPreset(v.id, p.sound, p.name);
      chosen = pick.value.startsWith('u:') ? p.id : '';
      // applyPreset may have explained a missing wavetable; don't cover that.
      if (model.notice === notice) notify(`${v.name}: ${p.name}`);
    }
    pick.value = '';
  });

  const file = h('input', { type: 'file', id: 'syn-preset-file', accept: '.json,application/json', hidden: true });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    try {
      const list = parsePresetsFile(await f.text());
      const missing = model.presetsMissingWavetables(list);
      const n = model.importPresets(list);
      const warn = missing ? ` — ${missing} use${missing === 1 ? 's' : ''} wavetables this session doesn't have (they'll play Last batch)` : '';
      notify(n ? `Imported ${n} preset${n === 1 ? '' : 's'}${warn}` : 'No presets imported (the list is full or the file is empty)');

    } catch (e) {
      notify(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  const menuBtn = h('button', { id: 'syn-preset-menu', class: 'small icon-btn', 'aria-label': 'Preset and voice actions', title: 'Save / delete / export / import presets; copy / paste voices' }, '⋯');
  popupMenu('syn-preset-actions', menuBtn, () => {
    const v = voice();
    const user = model.voicePresets.find((p) => p.id === chosen);
    return [
      item('syn-preset-save', 'Save as preset…', async () => {
        if (!v) return;
        const name = await ask.prompt('Preset name', user?.name ?? `${v.name} sound`);
        if (name === null) return;
        const p = model.savePreset(v.id, name);
        if (p) {
          chosen = p.id;
          notify(`Saved preset “${p.name}”`);
        }
      }),
      item(
        'syn-preset-delete',
        user ? `Delete “${user.name}”` : 'Delete preset',
        async () => {
          if (user && (await ask.confirm(`Delete the preset “${user.name}”?`))) {
            model.deletePreset(user.id);
            chosen = '';
          }
        },
        !user,
      ),
      item('syn-voice-copy', v ? `Copy ${v.name}` : 'Copy voice', () => v && setVoiceClip(v), !v),
      item(
        'syn-voice-paste',
        clip && v ? `Paste ${clip.name} onto ${v.name}` : 'Paste voice',
        () => {
          if (clip && v) model.pasteVoice(v.id, clip);
        },
        !clip || !v || clip.id === v.id,
      ),
      item(
        'syn-preset-export',
        'Export presets…',
        () => downloadBytes(new TextEncoder().encode(presetsFile(model.voicePresets)), 'mkwavez-presets.json'),
        !model.voicePresets.length,
      ),
      item('syn-preset-import', 'Import presets…', () => pickFile(file)),
    ];
  });
  model.on('presets', fill);
  fill();
  return { pick, menuBtn, file, sync: fill };
}

/** Copy / Paste buttons for the Simple panel (the copied voice is shared with the Synth panel's menu). */
export function buildCopyPaste(model: AppModel, voice: () => VoiceParams | undefined) {
  const copy = h('button', { id: 'voice-copy', class: 'small', title: 'Copy this voice (to paste onto another voice tab)', onclick: () => voice() && setVoiceClip(voice()!) }, 'Copy');
  const paste = h('button', {
    id: 'voice-paste',
    class: 'small',
    onclick: () => {
      const v = voice();
      if (clip && v) model.pasteVoice(v.id, clip);
    },
  }, 'Paste');
  const sync = () => {
    const v = voice();
    paste.disabled = !clip || !v || clip.id === v.id;
    paste.title = clip ? `Paste ${clip.name}’s settings onto this voice` : 'Copy a voice first';
  };
  onVoiceClip(sync);
  return { copy, paste, sync };
}
