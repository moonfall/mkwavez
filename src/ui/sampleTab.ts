/**
 * Generate → Sample: waveforms from recorded or rendered audio.
 *
 * Sources (left column): an input device and a shared tab's / the system's audio (browser
 * only: browser/audioCapture.ts, with Grab = the last 10 s), mkwavez's own output
 * (resample: a voice rendered offline holding a note, app/resample.ts — browser and
 * plugin) and audio files (open or drop; the plugin opens them through its native
 * dialog). Takes are kept until the page reloads.
 *
 * Modes (core/sample): Single cycle (a fixed repeating waveform at the cursor; the strip
 * shows the next cycle groups to pick the cleanest, N = the shared batch size), Series
 * (frames across the selection to scan as a wavetable; its own frame count; optionally
 * made into a 1D wavetable on Add) and Harmonic snapshot (cycles rebuilt from measured
 * partials across the selection). Click the take to set the cursor, drag to select,
 * double-click for the whole take.
 */
import { resampleVoice, RESAMPLE_MAX_SEC } from '../app/resample';
import {
  ALIGNS,
  cycleCandidates,
  detectPitch,
  measurePartials,
  noteName,
  OFF_HARMONIC,
  PHASE_MODES,
  SAMPLE_MODES,
  sampleRecipe,
  SEAMS,
  seriesFrames,
  snapshotSeries,
  SPACINGS,
  type Cycle,
  type Take,
} from '../core/sample';
import type { GeneratedTable } from '../core/table';
import { AUDIO_ACCEPT, canCaptureInput, canCaptureTab, decodeAudioFile, inputDevices, LiveCapture, type LiveKind } from '../browser/audioCapture';
import { buildStepper, buildStrip, drawCard, flasher, SPEC_BINS } from './batch';
import { cssColor, drawSpectrum, drawWave, fit, onThemeChange } from './canvas';
import { isOnScreen, watchVisibility, type GenerateView, type UiContext } from './context';
import { h, selectField, slider } from './dom';
import { pickFile } from './session';
import { buildShapeOnAdd, previewOf } from './shapeOnAdd';

export interface SamplePanelOpts {
  /** Shared batch size N (Single cycle's candidates). */
  count(): number;
  setCount(n: number): void;
  onCount(fn: (n: number) => void): void;
  active(): boolean;
}

/** Series / Harmonic snapshot frame count: its own, up to this many. */
export const SAMPLE_FRAMES_MAX = 256;
const FRAMES_DEFAULT = 16;
/** Parameter edits recompute this long after the last change. */
const COMPUTE_MS = 60;

type Source = 'input' | 'tab' | 'output' | 'file';

interface TakeState {
  take: Take;
  /** Cursor and selection (seconds). */
  cursor: number;
  a: number;
  b: number;
  /** Detected pitch at the take's middle (for the head line). */
  note: string;
}

const fmtS = (s: number) => `${s.toFixed(2)} s`;
const fmtHz = (f: number) => `${noteName(f).name} ${f.toFixed(1)} Hz`;

export function buildSamplePanel(ctx: UiContext, opts: SamplePanelOpts): { el: HTMLElement; view: GenerateView } {
  const { model } = ctx;
  const inPlugin = () => document.documentElement.dataset.host === 'plugin';

  // ---------------- state ----------------
  const takes: TakeState[] = [];
  let cur = -1;
  let source: Source = 'file';
  let mode = 0;
  let frames = FRAMES_DEFAULT;
  const p = { pitchMode: 0, hz: 220, cents: 0, cycles: 4, align: 0, seam: 0, spacing: 0, cpf: 2, smooth: 0.2, window: 4, harmonics: 64, phases: 0, off: 0, floor: -60 };
  let levelDb = -Infinity;
  let busy = '';

  const take = () => takes[cur] ?? null;

  // Dirty flags (frame loop).
  let computeKey = '';
  let lastEdit = 0;
  let viewDirty = true;
  let cardsDirty = true;
  let uiDirty = true;

  /** Results: the waveforms (recipes) and where each came from. */
  let tables: GeneratedTable[] = [];
  let made: (Cycle & { at?: number })[] = [];

  const touch = () => {
    lastEdit = performance.now();
    uiDirty = true;
  };

  // ---------------- live capture (browser) ----------------
  const live = new LiveCapture({
    level: (db) => (levelDb = db),
    started: () => (uiDirty = true),
    stopped: (t) => {
      if (t) addTake(t);
      else flash('Nothing was recorded (silence)');
      uiDirty = true;
    },
  });

  // ---------------- source column ----------------
  const srcName = 'smp-source';
  const srcRadios = new Map<Source, HTMLInputElement>();
  const srcRow = (s: Source, label: string, small: string) => {
    const input = h('input', { type: 'radio', name: srcName, id: `smp-src-${s}`, value: s });
    input.addEventListener('change', () => void setSource(s));
    srcRadios.set(s, input);
    return h('label', { class: 'smp-opt', id: `smp-src-${s}-row` }, input, h('span', {}, label), h('small', {}, small));
  };
  const srcList = h(
    'div',
    { class: 'smp-opts', role: 'radiogroup', 'aria-label': 'Source' },
    srcRow('input', 'Input', 'mic / line'),
    srcRow('output', 'mkwavez output', 'resample'),
    srcRow('tab', 'Tab / system audio', ''),
    srcRow('file', 'Audio file…', 'or drop'),
  );

  // Live sources (input / tab).
  const deviceSel = h('select', { id: 'smp-device', class: 'smp-sel', 'aria-label': 'Input device' });
  deviceSel.addEventListener('change', () => void openLive('input'));
  const sharedLabel = h('div', { class: 'smp-shared', id: 'smp-shared' });
  const meterFill = h('i');
  const meterDb = h('span', { class: 'smp-db' }, '—');
  const meter = h('div', { class: 'smp-meter', id: 'smp-meter' }, h('div', { class: 'smp-bar' }, meterFill), meterDb);
  const recBtn = h('button', { class: 'small smp-rec', id: 'smp-record', onclick: () => void toggleRecord() }, '● Record');
  const grabBtn = h('button', { class: 'small', id: 'smp-grab', title: 'The last 10 s of the source are always kept', onclick: () => grab() }, 'Grab last 10 s');
  const autoChk = h('input', { type: 'checkbox', id: 'smp-auto' });
  autoChk.addEventListener('change', () => (live.auto = autoChk.checked));
  const liveBox = h(
    'div',
    { class: 'smp-srcbox', id: 'smp-live' },
    deviceSel,
    sharedLabel,
    meter,
    h('div', { class: 'smp-row' }, recBtn, grabBtn),
    h('label', { class: 'smp-chk' }, autoChk, 'Start on sound, stop on silence'),
  );

  // Resample (mkwavez output).
  const voiceSel = h('select', { id: 'smp-voice', class: 'smp-sel', 'aria-label': 'Voice to resample' });
  const noteSel = h('select', { id: 'smp-note', class: 'smp-sel', 'aria-label': 'Note to hold' });
  for (let n = 24; n <= 96; n++) noteSel.append(h('option', { value: String(n) }, noteName(440 * Math.pow(2, (n - 69) / 12)).name));
  noteSel.value = '48';
  const lenIn = h('input', { type: 'number', id: 'smp-len', class: 'smp-num', min: 0.2, max: RESAMPLE_MAX_SEC, step: 0.1, value: 2, 'aria-label': 'Seconds to hold the note' });
  const renderBtn = h(
    'button',
    { class: 'small smp-rec', id: 'smp-render', title: 'Renders the voice holding the note, through its own filter, unison and envelopes', onclick: () => renderOutput() },
    '● Render take',
  );
  const outBox = h('div', { class: 'smp-srcbox', id: 'smp-out' }, voiceSel, h('div', { class: 'smp-row' }, noteSel, lenIn, h('span', { class: 'smp-unit' }, 's')), renderBtn);

  // File.
  const fileInput = h('input', { type: 'file', id: 'smp-file', accept: AUDIO_ACCEPT, hidden: true });
  fileInput.addEventListener('change', () => {
    const fs = [...(fileInput.files ?? [])];
    fileInput.value = '';
    void loadFiles(fs);
  });
  const openBtn = h('button', { class: 'small', id: 'smp-open', onclick: () => pickFile(fileInput) }, 'Open audio file…');
  const fileBox = h('div', { class: 'smp-srcbox', id: 'smp-filebox', title: 'WAV, AIFF, MP3, AAC, Ogg, FLAC (what the browser decodes)' }, openBtn, fileInput, h('p', { class: 'smp-note' }, 'Or drop files on this tab.'));

  const takeList = h('div', { class: 'smp-takes', id: 'smp-takes', role: 'listbox', 'aria-label': 'Takes' });
  const srcCol = h(
    'div',
    { class: 'smp-src gen-box' },
    h('span', { class: 'smp-h' }, 'Source'),
    srcList,
    liveBox,
    outBox,
    fileBox,
    h('span', { class: 'smp-h' }, 'Takes'),
    takeList,
  );

  // ---------------- main: head, take view, params ----------------
  const headName = h('b', { id: 'smp-take-name' }, 'No take');
  const headMeta = h('span', { class: 'smp-meta', id: 'smp-take-meta' }, '');
  const playBtn = h('button', { class: 'small', id: 'smp-play', onclick: () => play(false) }, '▶ Play');
  const playSelBtn = h('button', { class: 'small', id: 'smp-play-sel', title: 'Play the selection', onclick: () => play(true) }, '▶ Sel.');
  const MODE_SHORT = ['Single cycle', 'Series', 'Harmonic'];
  const modeBtns = SAMPLE_MODES.map((m, i) =>
    h('button', { id: `smp-mode-${i}`, title: m, 'aria-pressed': String(i === mode), onclick: () => setMode(i) }, MODE_SHORT[i]),
  );
  const head = h('div', { class: 'smp-head' }, headName, headMeta, playBtn, playSelBtn, h('span', { class: 'grow' }), h('div', { class: 'seg smp-modes', role: 'group', 'aria-label': 'What to make' }, ...modeBtns));

  const takeC = h('canvas', { id: 'smp-take', tabindex: 0, 'aria-label': 'The take: click to set the cursor, drag to select, double-click for all; ←/→ move the cursor' });
  const takeTag = h('span', { class: 'smp-tag', id: 'smp-tag' });
  const takeBox = h('div', { class: 'smp-takebox' }, takeC, takeTag);

  // Parameters (compact rows, as Seed's), shown per mode.
  type Field = { el: HTMLElement; modes: number[]; sync?: () => void };
  const fields: Field[] = [];
  const sl = (key: keyof typeof p, label: string, min: number, max: number, step: number, modes: number[], fmt: (v: number) => string) => {
    const s = slider({ label, min, max, step, value: p[key], format: fmt, onInput: (v) => ((p[key] = v), touch()) });
    s.input.id = `smp-${key}`;
    s.el.title = label;
    fields.push({ el: s.el, modes, sync: () => s.set(p[key]) });
  };
  const sel = (key: keyof typeof p, label: string, options: readonly string[], modes: number[]) => {
    const f = selectField(label, options.map((o, i) => [String(i), o]), String(p[key]), (v) => ((p[key] = Number(v)), touch()));
    f.select.id = `smp-${key}`;
    f.el.title = label;
    fields.push({ el: f.el, modes, sync: () => (f.select.value = String(p[key])) });
    return f;
  };
  // Pitch: Auto / Track, or Manual Hz.
  const pitchSel = h('select', { id: 'smp-pitch', 'aria-label': 'Pitch' });
  const pitchHz = h('input', { type: 'number', id: 'smp-hz', class: 'smp-num', min: 20, max: 4000, step: 0.01, value: p.hz, 'aria-label': 'Manual pitch (Hz)' });
  pitchSel.addEventListener('change', () => {
    p.pitchMode = Number(pitchSel.value);
    if (p.pitchMode === 1) {
      const t = take();
      const d = t && detectPitch(t.take.data, t.take.sampleRate, t.cursor * t.take.sampleRate);
      if (d) pitchHz.value = d.freq.toFixed(2);
      p.hz = Number(pitchHz.value);
    }
    touch();
  });
  pitchHz.addEventListener('input', () => {
    const v = Number(pitchHz.value);
    if (v >= 20 && v <= 4000) {
      p.hz = v;
      touch();
    }
  });
  const pitchField = h('div', { class: 'field smp-pitch', title: 'Pitch' }, h('div', { class: 'label' }, h('span', {}, 'Pitch')), pitchSel, pitchHz);
  fields.push({ el: pitchField, modes: [0, 1, 2] });
  sl('cents', 'Fine tune', -100, 100, 1, [0], (v) => `${Math.round(v)} ct`);
  sl('cycles', 'Cycles averaged', 1, 32, 1, [0], (v) => String(Math.round(v)));
  sel('spacing', 'Spacing', SPACINGS, [1]);
  sl('cpf', 'Cycles per frame', 1, 16, 1, [1], (v) => String(Math.round(v)));
  sl('smooth', 'Smooth across frames', 0, 1, 0.01, [1], (v) => v.toFixed(2));
  sl('window', 'Window (cycles)', 1, 16, 1, [2], (v) => String(Math.round(v)));
  sl('harmonics', 'Harmonics', 1, 72, 1, [2], (v) => String(Math.round(v)));
  sel('phases', 'Phases', PHASE_MODES, [2]);
  sel('off', 'Off-harmonic energy', OFF_HARMONIC, [2]);
  sl('floor', 'Noise floor', -100, -20, 1, [2], (v) => `${Math.round(v)} dB`);
  sel('align', 'Align', ALIGNS, [0, 1]);
  sel('seam', 'Seam', SEAMS, [0, 1]);
  const params = h('div', { class: 'seed-params smp-params', id: 'smp-params' }, ...fields.map((f) => f.el));

  // ---------------- viewer ----------------
  const waveC = h('canvas', { id: 'smp-wave', role: 'img', 'aria-label': 'Shown waveform' });
  const specC = h('canvas', { id: 'smp-spec', role: 'img', 'aria-label': 'Harmonic spectrum of the shown waveform' });
  const basisC = h('canvas', { id: 'smp-basis', role: 'img', 'aria-label': 'Where the shown waveform comes from' });
  const shownLabel = h('span', { class: 'mono-label', id: 'smp-shown' });
  const waveBox = h('div', { class: 'gen-plot-box' }, waveC, h('div', { class: 'gen-plot-tags' }, shownLabel));
  const specBox = h('div', { class: 'gen-plot-box' }, specC);
  const basisBox = h('div', { class: 'gen-plot-box' }, basisC);
  const axis = (...l: string[]) => h('div', { class: 'gen-axis' }, ...l.map((x) => h('span', {}, x)));
  const basisAxis = axis('', 'cut from the take', '');
  const viewer = h(
    'div',
    { class: 'gen-viewer' },
    h(
      'div',
      { class: 'gen-views' },
      h('div', { class: 'gen-plot gen-plot-wave' }, waveBox, axis('0', 'π', '2π')),
      h('div', { class: 'gen-plot gen-plot-spec' }, specBox, axis('h1', 'dB (−60…0)', `h${SPEC_BINS}`)),
      h('div', { class: 'gen-plot gen-plot-basis' }, basisBox, basisAxis),
    ),
  );

  // ---------------- batch ----------------
  const stepper = buildStepper('smp', opts);
  const frameStepper = buildStepper('smp-frames', {
    count: () => frames,
    setCount: (n) => {
      frames = Math.max(1, Math.min(SAMPLE_FRAMES_MAX, Math.round(n)));
      frameStepper.sync(frames);
      touch();
    },
    max: SAMPLE_FRAMES_MAX,
    label: 'Frames (series and snapshots)',
  });
  const shapeOn = buildShapeOnAdd(ctx, 'smp', () => {
    for (const c of strip.cards) c.drawn = null;
    cardsDirty = viewDirty = true;
  });
  const wtChk = h('input', { type: 'checkbox', id: 'smp-make-wt', checked: true });
  const wtLabel = h('label', { class: 'smp-chk', id: 'smp-make-wt-row', title: 'Add batch also makes a 1D wavetable of the frames, named after the take' }, wtChk, 'Wavetable');
  const status = h('div', { class: 'gen-status', id: 'smp-status', role: 'status' });
  const flash = flasher(status);
  const addShownBtn = h('button', { id: 'smp-add-shown', onclick: () => addShown() }, 'Add shown');
  const addBatchBtn = h('button', { id: 'smp-add-batch', class: 'primary', onclick: () => addBatch() }, 'Add batch');
  const strip = buildStrip('smp-strip', { onShow: () => (viewDirty = uiDirty = true) });
  const batchBox = h(
    'div',
    { class: 'gen-box gen-batch' },
    h('div', { class: 'gen-batch-head' }, h('span', { class: 'gen-h' }, 'Batch'), stepper.el, frameStepper.el, shapeOn.el, wtLabel, status, h('div', { class: 'gen-adds' }, addShownBtn, addBatchBtn)),
    strip.el,
  );

  const emptyHint = h('p', { class: 'smp-empty', id: 'smp-empty' }, 'Record, grab, render a voice or open an audio file to make waveforms from it.');
  const main = h('div', { class: 'gen-main' }, head, takeBox, params, emptyHint, viewer, batchBox);
  const el = h('div', { role: 'tabpanel', id: 'panel-sample', class: 'gen-tab smp-tab' }, srcCol, main);
  watchVisibility(el);

  // Drop files anywhere on the tab.
  el.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      el.classList.add('smp-drop');
    }
  });
  el.addEventListener('dragleave', () => el.classList.remove('smp-drop'));
  el.addEventListener('drop', (e) => {
    el.classList.remove('smp-drop');
    const fs = [...(e.dataTransfer?.files ?? [])];
    if (!fs.length) return;
    e.preventDefault();
    void loadFiles(fs);
  });

  // ---------------- actions ----------------
  function addTake(t: Take): void {
    if (!(t.data.length > 0)) return;
    const dur = t.data.length / t.sampleRate;
    const d = detectPitch(t.data, t.sampleRate, t.data.length / 2);
    takes.push({ take: t, cursor: Math.min(dur * 0.3, Math.max(0, dur - 0.05)), a: dur * 0.05, b: dur * 0.95, note: d ? `${noteName(d.freq).name} detected` : 'no clear pitch' });
    cur = takes.length - 1;
    strip.setShown(0);
    touch();
    viewDirty = cardsDirty = true;
  }

  async function loadFiles(fs: File[]): Promise<void> {
    for (const f of fs) {
      try {
        busy = `Decoding ${f.name}…`;
        uiDirty = true;
        addTake(await decodeAudioFile(f));
        flash(`Added take “${takes[cur].take.name}”`);
      } catch (e) {
        flash(`Couldn’t decode ${f.name}: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
    busy = '';
    uiDirty = true;
  }

  async function openLive(kind: LiveKind): Promise<boolean> {
    try {
      busy = kind === 'tab' ? 'Choose a tab (tick “Share tab audio”)…' : 'Opening the input…';
      uiDirty = true;
      await live.start(kind, kind === 'input' ? deviceSel.value || undefined : undefined);
      live.auto = autoChk.checked;
      if (kind === 'input') await fillDevices();
      return true;
    } catch (e) {
      flash(`${kind === 'tab' ? 'Tab audio' : 'Input'} unavailable: ${e instanceof Error ? e.message : String(e)}`, true);
      return false;
    } finally {
      busy = '';
      uiDirty = true;
    }
  }

  async function fillDevices(): Promise<void> {
    const ds = await inputDevices();
    const keep = deviceSel.value;
    deviceSel.replaceChildren(...ds.map((d, i) => h('option', { value: d.deviceId }, d.label || `Input ${i + 1}`)));
    if (ds.some((d) => d.deviceId === keep)) deviceSel.value = keep;
  }

  async function setSource(s: Source): Promise<void> {
    source = s;
    for (const [k, r] of srcRadios) r.checked = k === s;
    if (s === 'input' || s === 'tab') {
      if (live.kind !== s) await openLive(s);
    } else live.close();
    uiDirty = true;
  }

  async function toggleRecord(): Promise<void> {
    if (live.recording || live.armed) {
      live.stop();
      uiDirty = true;
      return;
    }
    if (!live.open && (source === 'input' || source === 'tab') && !(await openLive(source))) return;
    live.record();
    uiDirty = true;
  }

  function grab(): void {
    const t = live.grab();
    if (t) {
      addTake(t);
      flash(`Grabbed the last ${(t.data.length / t.sampleRate).toFixed(1)} s`);
    } else flash('Nothing to grab yet (silence)');
  }

  function renderOutput(): void {
    const id = Number(voiceSel.value);
    const v = model.voice(id);
    if (!v) return;
    const note = Number(noteSel.value);
    const secs = Math.max(0.2, Math.min(RESAMPLE_MAX_SEC, Number(lenIn.value) || 2));
    const t = resampleVoice(model, { voiceId: id, note, seconds: secs }, `${v.name} ${noteName(440 * Math.pow(2, (note - 69) / 12)).name}`);
    if (!t) return;
    if (!t.data.some((x) => Math.abs(x) > 1e-5)) {
      flash(`${v.name} is silent (check its level and wavetable)`, true);
      return;
    }
    addTake(t);
    flash(`Rendered ${v.name} holding ${noteSel.selectedOptions[0]?.textContent ?? ''} for ${secs} s`);
  }

  function setMode(i: number): void {
    mode = i;
    strip.setShown(0);
    touch();
  }

  let player: AudioContext | null = null;
  let playing: AudioBufferSourceNode | null = null;
  function play(selection: boolean): void {
    const t = take();
    if (!t) return;
    playing?.stop();
    player ??= new AudioContext();
    void player.resume();
    const sr = t.take.sampleRate;
    const a = selection ? Math.floor(Math.min(t.a, t.b) * sr) : 0;
    const b = selection ? Math.ceil(Math.max(t.a, t.b) * sr) : t.take.data.length;
    const buf = player.createBuffer(1, Math.max(1, b - a), sr);
    buf.getChannelData(0).set(t.take.data.subarray(a, b));
    const node = player.createBufferSource();
    node.buffer = buf;
    node.connect(player.destination);
    node.start();
    playing = node;
  }

  function removeTake(i: number): void {
    takes.splice(i, 1);
    if (cur >= takes.length) cur = takes.length - 1;
    touch();
    viewDirty = cardsDirty = true;
  }

  const finalTable = (i: number): GeneratedTable | undefined => {
    const t = tables[i];
    return t && shapeOn.apply(t, { index: i, count: tables.length });
  };

  function addShown(): void {
    const i = strip.shown();
    const t = finalTable(i);
    if (!t) return;
    if (!model.addTables([t], true).length) return;
    flash(`Added #${i + 1} to the Timeline`);
  }

  function addBatch(): void {
    if (!tables.length) return;
    const all = tables.map((_, i) => finalTable(i)!);
    const name = take()?.take.name ?? 'Sample';
    if (mode !== 0 && wtChk.checked) {
      const wt = model.addAsWavetable(all, name);
      if (wt) flash(`Added ${all.length} waveforms · new wavetable “${wt.name}”`);
      return;
    }
    if (model.addTables(all, true).length) flash(`Added ${all.length} waveforms to the Timeline`);
  }

  // ---------------- compute ----------------
  const keyNow = () => {
    const t = take();
    if (!t) return '';
    const count = mode === 0 ? opts.count() : frames;
    return JSON.stringify([cur, t.take.data.length, mode, t.cursor, t.a, t.b, p, count]);
  };

  function compute(): void {
    const t = take();
    tables = [];
    made = [];
    if (t) {
      const freq = p.pitchMode === 1 ? p.hz : null;
      const a = Math.min(t.a, t.b);
      const b = Math.max(t.a, t.b);
      const name = t.take.name;
      if (mode === 0) made = cycleCandidates(t.take, { at: t.cursor, freq, cents: p.cents, cycles: p.cycles, align: p.align, seam: p.seam }, opts.count());
      else if (mode === 1)
        made = seriesFrames(t.take, { a, b, frames, spacing: p.spacing, cyclesPerFrame: p.cpf, track: p.pitchMode === 0, freq, align: p.align, seam: p.seam, smooth: p.smooth });
      else
        made = snapshotSeries(t.take, { a, b, frames, spacing: 0, track: p.pitchMode === 0, freq, windowCycles: p.window, harmonics: p.harmonics, phases: p.phases, off: p.off, floorDb: p.floor });
      const n = made.length;
      tables = made.map((c, i) => ({ data: c.data, recipe: sampleRecipe(name, mode, c.at ?? c.start, c.freq, i, n) }));
    }
    strip.resize(tables.length, (i) => `#${i + 1} · ${fmtS(made[i].at ?? made[i].start)}`);
    uiDirty = true;
    for (const c of strip.cards) c.drawn = null;
    viewDirty = cardsDirty = uiDirty = true;
  }

  // ---------------- take view interaction ----------------
  let drag: { x0: number; t0: number; moved: boolean } | null = null;
  const timeAt = (clientX: number) => {
    const t = take();
    const r = takeC.getBoundingClientRect();
    if (!t || !r.width) return 0;
    const dur = t.take.data.length / t.take.sampleRate;
    return Math.max(0, Math.min(dur, ((clientX - r.left) / r.width) * dur));
  };
  takeC.addEventListener('pointerdown', (e) => {
    if (!take()) return;
    takeC.setPointerCapture(e.pointerId);
    drag = { x0: e.clientX, t0: timeAt(e.clientX), moved: false };
  });
  takeC.addEventListener('pointermove', (e) => {
    const t = take();
    if (!drag || !t) return;
    if (Math.abs(e.clientX - drag.x0) > 3) drag.moved = true;
    if (!drag.moved) return;
    const t1 = timeAt(e.clientX);
    t.a = Math.min(drag.t0, t1);
    t.b = Math.max(drag.t0, t1);
    viewDirty = true;
    touch();
  });
  takeC.addEventListener('pointerup', (e) => {
    const t = take();
    if (drag && t && !drag.moved) {
      t.cursor = timeAt(e.clientX);
      touch();
    }
    drag = null;
    viewDirty = true;
  });
  takeC.addEventListener('dblclick', () => {
    const t = take();
    if (!t) return;
    t.a = 0;
    t.b = t.take.data.length / t.take.sampleRate;
    touch();
  });
  takeC.addEventListener('keydown', (e) => {
    const t = take();
    if (!t || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    const dur = t.take.data.length / t.take.sampleRate;
    t.cursor = Math.max(0, Math.min(dur, t.cursor + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 0.1 : 0.01)));
    touch();
  });

  // ---------------- drawing ----------------
  function syncUi(): void {
    uiDirty = false;
    const plugin = inPlugin();
    for (const s of ['input', 'tab'] as const) {
      const row = srcRadios.get(s)!.parentElement!;
      row.hidden = plugin || (s === 'input' ? !canCaptureInput() : !canCaptureTab());
    }
    for (const [k, r] of srcRadios) r.checked = k === source;
    const isLive = source === 'input' || source === 'tab';
    liveBox.hidden = !isLive;
    outBox.hidden = source !== 'output';
    fileBox.hidden = source !== 'file';
    deviceSel.hidden = source !== 'input';
    sharedLabel.hidden = source !== 'tab';
    sharedLabel.textContent = live.kind === 'tab' ? `Sharing ${live.label || 'audio'}` : 'Not sharing: Record asks for a tab';
    recBtn.textContent = live.recording ? `■ Stop · ${live.recordedSec.toFixed(1)} s` : live.armed ? '■ Waiting for sound…' : '● Record';
    recBtn.classList.toggle('on', live.recording || live.armed);
    grabBtn.disabled = !live.open;
    // Voices for resampling.
    const keep = voiceSel.value;
    voiceSel.replaceChildren(...model.voices.map((v) => h('option', { value: String(v.id) }, `${v.name} · ${v.type === 'synth' ? 'Synth' : 'Simple'}`)));
    if (model.voices.some((v) => String(v.id) === keep)) voiceSel.value = keep;
    // Takes.
    takeList.replaceChildren(
      ...takes.map((t, i) =>
        h(
          'div',
          { class: `smp-take${i === cur ? ' on' : ''}`, role: 'option', 'aria-selected': String(i === cur) },
          h('button', { class: 'smp-take-pick', id: `smp-take-${i}`, onclick: () => ((cur = i), strip.setShown(0), touch(), (viewDirty = cardsDirty = true)) }, t.take.name, h('small', {}, fmtS(t.take.data.length / t.take.sampleRate))),
          h('button', { class: 'smp-take-x', 'aria-label': `Remove ${t.take.name}`, onclick: () => removeTake(i) }, '×'),
        ),
      ),
    );
    // Head.
    const t = take();
    headName.textContent = live.recording ? '● Recording' : t ? t.take.name : 'No take';
    headMeta.textContent = busy || (live.recording ? `${live.recordedSec.toFixed(1)} s` : t ? `${fmtS(t.take.data.length / t.take.sampleRate)} · ${(t.take.sampleRate / 1000).toFixed(1)} kHz · ${t.note}` : '');
    // Auto / Track: the box shows the pitch in use (of the shown waveform).
    const shownC = made[Math.min(strip.shown(), made.length - 1)];
    if (p.pitchMode === 0 && document.activeElement !== pitchHz) pitchHz.value = shownC ? shownC.freq.toFixed(1) : '';
    playBtn.disabled = playSelBtn.disabled = !t;
    modeBtns.forEach((b, i) => {
      b.classList.toggle('seg-on', i === mode);
      b.setAttribute('aria-pressed', String(i === mode));
    });
    pitchSel.replaceChildren(h('option', { value: '0' }, mode === 0 ? 'Auto (detected)' : 'Track (follows the pitch)'), h('option', { value: '1' }, 'Manual (Hz)'));
    pitchSel.value = String(p.pitchMode);
    pitchHz.disabled = p.pitchMode !== 1;
    for (const f of fields) f.el.hidden = !f.modes.includes(mode);
    // Batch row.
    stepper.el.hidden = mode !== 0;
    frameStepper.el.hidden = mode === 0;
    wtLabel.hidden = mode === 0;
    const n = tables.length;
    addBatchBtn.textContent = `Add batch (+${n})`;
    addBatchBtn.title = mode !== 0 && wtChk.checked ? 'Adds the frames and makes them a new 1D wavetable named after the take' : '';
    addShownBtn.disabled = addBatchBtn.disabled = !n || !model.roomFor(Math.max(1, n));
    emptyHint.hidden = !!t;
    el.classList.toggle('smp-none', !t);
  }

  function drawTake(): void {
    const t = take();
    const [g, w, hh] = fit(takeC, Math.max(30, takeBox.clientHeight || 52));
    const cBg = cssColor('--muted');
    if (!t) {
      takeTag.textContent = '';
      return;
    }
    const x = t.take.data;
    const sr = t.take.sampleRate;
    const dur = x.length / sr;
    const X = (s: number) => (s / dur) * w;
    // Selection (Series / Harmonic) shaded; Single cycle shades its cuts.
    g.fillStyle = cssColor('--accent');
    g.globalAlpha = 0.12;
    if (mode !== 0) g.fillRect(X(Math.min(t.a, t.b)), 0, Math.max(1, X(Math.abs(t.b - t.a))), hh);
    g.globalAlpha = 1;
    // Peaks per pixel column.
    g.strokeStyle = cBg;
    g.lineWidth = 1;
    g.beginPath();
    const mid = hh / 2;
    const per = x.length / w;
    for (let px = 0; px < w; px++) {
      let lo = 0;
      let hi = 0;
      const s0 = Math.floor(px * per);
      const s1 = Math.min(x.length, Math.floor((px + 1) * per) + 1);
      for (let i = s0; i < s1; i++) {
        if (x[i] < lo) lo = x[i];
        if (x[i] > hi) hi = x[i];
      }
      g.moveTo(px + 0.5, mid - hi * (mid - 1));
      g.lineTo(px + 0.5, mid - lo * (mid - 1) + 0.5);
    }
    g.stroke();
    // Where the waveforms come from.
    const shown = strip.shown();
    const accent = cssColor('--accent');
    made.forEach((c, i) => {
      g.fillStyle = accent;
      if (mode === 0) {
        g.globalAlpha = i === shown ? 0.4 : 0.15;
        g.fillRect(X(c.start), 2, Math.max(2, X(c.span)), hh - 4);
      } else {
        g.globalAlpha = i === shown ? 1 : 0.55;
        g.fillRect(Math.round(X(c.at ?? c.start)) - (i === shown ? 1 : 0), 0, i === shown ? 2 : 1, hh);
      }
    });
    g.globalAlpha = 1;
    if (mode === 0) {
      g.fillStyle = accent;
      g.fillRect(Math.round(X(t.cursor)) - 1, 0, 2, hh);
    }
    const c = made[shown];
    takeTag.textContent = c ? `${fmtS(c.at ?? c.start)} · ${fmtHz(c.freq)}${mode === 0 ? ` · ${p.cycles} cycle${p.cycles > 1 ? 's' : ''}` : ` · frame ${shown + 1} of ${made.length}`}` : '';
    takeTag.style.left = `${Math.min(w - 220, Math.max(4, X(c ? (c.at ?? c.start) : t.cursor) + 8))}px`;
    // Time labels in the view's bottom corners and centre (no separate axis row: height is scarce).
    g.font = '10px ui-monospace, monospace';
    g.fillStyle = cssColor('--text-2');
    g.textBaseline = 'bottom';
    g.fillText('0 s', 4, hh - 2);
    const mid2 = mode === 0 ? `cursor ${fmtS(t.cursor)}` : `selection ${fmtS(Math.min(t.a, t.b))} → ${fmtS(Math.max(t.a, t.b))}`;
    g.textAlign = 'center';
    g.fillText(mid2, w / 2, hh - 2);
    g.textAlign = 'right';
    g.fillText(fmtS(dur), w - 4, hh - 2);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
  }

  function drawViewer(): void {
    const i = Math.min(strip.shown(), tables.length - 1);
    const d = tables.length ? finalTable(i)?.data : undefined;
    const c = made[i];
    shownLabel.textContent = c ? `#${i + 1} of ${tables.length} · ${fmtS(c.at ?? c.start)} · ${c.freq.toFixed(1)} Hz` : '';
    const grid = cssColor('--surface-2');
    const [g, w, hh] = fit(waveC, Math.max(40, waveBox.clientHeight || 120));
    g.strokeStyle = grid;
    g.beginPath();
    for (const f of [0.25, 0.5, 0.75]) {
      g.moveTo(Math.round(w * f) + 0.5, 0);
      g.lineTo(Math.round(w * f) + 0.5, hh);
    }
    g.stroke();
    if (d) drawWave(g, 0, 0, w, hh, d, cssColor('--wave'), { axis: cssColor('--border'), lineWidth: 2 });
    const [gs, sw, sh] = fit(specC, Math.max(30, specBox.clientHeight || 90));
    if (d) drawSpectrum(gs, sw, sh, d, cssColor('--accent'), { bins: SPEC_BINS });
    drawBasis(i);
  }

  function drawBasis(i: number): void {
    const [g, w, hh] = fit(basisC, Math.max(30, basisBox.clientHeight || 90));
    const t = take();
    const c = made[i];
    const labels = basisAxis.children;
    if (!t || !c) return;
    const accent = cssColor('--accent');
    const line = cssColor('--text-2');
    const muted = cssColor('--muted');
    if (mode === 0) {
      // The take around the cut: a span either side, the cut shaded.
      labels[1].textContent = 'cut from the take';
      const sr = t.take.sampleRate;
      const s0 = (c.start - c.span) * sr;
      const s1 = (c.start + 2 * c.span) * sr;
      g.fillStyle = accent;
      g.globalAlpha = 0.14;
      g.fillRect(w / 3, 0, w / 3, hh);
      g.globalAlpha = 1;
      let m = 1e-9;
      for (let s = Math.max(0, Math.floor(s0)); s < Math.min(t.take.data.length, s1); s++) m = Math.max(m, Math.abs(t.take.data[s]));
      g.strokeStyle = line;
      g.lineWidth = 1.2;
      g.beginPath();
      for (let px = 0; px <= w; px++) {
        const s = Math.round(s0 + ((s1 - s0) * px) / w);
        const v = t.take.data[s] ?? 0;
        const y = hh / 2 - (v / m) * (hh / 2 - 3);
        if (px) g.lineTo(px, y);
        else g.moveTo(px, y);
      }
      g.stroke();
    } else if (mode === 1) {
      // The frames as a 1D stack, the shown one highlighted.
      labels[1].textContent = 'frames as a 1D stack';
      const n = Math.min(made.length, 24);
      const step = made.length / n;
      const lw = w * 0.72;
      const dx = n > 1 ? (w - lw - 8) / (n - 1) : 0;
      const dy = n > 1 ? (hh - 18) / (n - 1) : 0;
      for (let k = 0; k < n; k++) {
        const fi = Math.min(made.length - 1, Math.round(k * step));
        const on = Math.abs(fi - i) < step / 2 || fi === i;
        drawWave(g, 4 + k * dx, 2 + k * dy, lw, 14, made[fi].data, on ? accent : muted, { lineWidth: on ? 1.8 : 0.9, points: 96 });
      }
    } else {
      // The measured partials (dB) and the floor.
      labels[1].textContent = 'measured partials · floor';
      const sr = t.take.sampleRate;
      const pt = measurePartials(t.take.data, sr, (c.at ?? c.start) * sr, c.freq, { windowCycles: p.window, harmonics: p.harmonics, phases: p.phases, off: p.off, floorDb: -100 });
      const H = pt.amp.length - 1;
      const top = Math.max(1e-30, ...pt.amp);
      const yOf = (db: number) => hh - 2 - ((Math.max(-80, db) + 80) / 80) * (hh - 6);
      g.lineWidth = Math.max(1, Math.min(3, (w / H) * 0.5));
      for (let k = 1; k <= H; k++) {
        const db = 20 * Math.log10(pt.amp[k] / top + 1e-12);
        g.strokeStyle = db >= p.floor ? cssColor('--new') : muted;
        const x = 2 + ((k - 1) / Math.max(1, H - 1)) * (w - 4);
        g.beginPath();
        g.moveTo(x, hh - 2);
        g.lineTo(x, yOf(db));
        g.stroke();
      }
      g.strokeStyle = cssColor('--heat-hi');
      g.setLineDash([3, 3]);
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, yOf(p.floor));
      g.lineTo(w, yOf(p.floor));
      g.stroke();
      g.setLineDash([]);
    }
  }

  function drawCards(): void {
    cardsDirty = false;
    strip.cards.forEach((card, i) => {
      const t = finalTable(i);
      if (card.drawn === t) return;
      card.drawn = t;
      drawCard(card, t?.data);
    });
  }

  function updateMeter(): void {
    const db = live.open ? levelDb : -Infinity;
    const frac = Number.isFinite(db) ? Math.max(0, Math.min(1, (db + 60) / 60)) : 0;
    meterFill.style.width = `${(frac * 100).toFixed(0)}%`;
    meterDb.textContent = Number.isFinite(db) ? `${Math.round(db)} dB` : '—';
    if (live.recording) uiDirty = true;
  }

  // ---------------- wiring ----------------
  opts.onCount((n) => {
    stepper.sync(n);
    touch();
  });
  model.on('voices', () => (uiDirty = true));
  model.on('timeline', () => (uiDirty = true));
  onThemeChange(() => {
    for (const c of strip.cards) c.drawn = null;
    viewDirty = cardsDirty = true;
  });
  new ResizeObserver(() => (viewDirty = true)).observe(viewer);
  new ResizeObserver(() => (viewDirty = true)).observe(takeBox);
  void setSource('file');

  return {
    el,
    view: {
      preview() {
        return tables.length ? previewOf(tables, shapeOn, strip.shown()) : null;
      },
      batch() {
        if (!tables.length) return { error: 'No take yet' };
        return { tables: tables.map((_, i) => finalTable(i)!) };
      },
      frame(now) {
        if (!opts.active() || !isOnScreen(el)) return;
        updateMeter();
        const key = keyNow();
        if (key !== computeKey && now - lastEdit >= COMPUTE_MS) {
          computeKey = key;
          compute();
        }
        if (uiDirty) syncUi();
        if (viewDirty) {
          viewDirty = false;
          drawTake();
          drawViewer();
        }
        if (cardsDirty) drawCards();
      },
    },
  };
}
