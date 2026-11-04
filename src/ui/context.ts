import type { AppModel } from '../app/model';
import type { AudioBridge } from '../audio/bridge';

/**
 * UI-only state shared between sections: the voice whose tab is selected (the Voice and
 * Sequence panels both follow it). Kept valid as voices come and go: when the selected
 * voice is removed, the voice now at its place (or the last one) is selected.
 * `prefs` are small UI choices saved with the session (e.g. the open Generate tab); JSON
 * values only.
 */
export class UiState {
  voiceId: number | null = null;
  private prefs: Record<string, unknown> = {};
  private prefFns = new Set<() => void>();
  private fns = new Set<() => void>();
  private lastIndex = 0;

  constructor(private model: AppModel) {
    model.on('voices', () => this.validate());
    this.validate();
  }

  setVoice(id: number | null): void {
    if (id === this.voiceId) return;
    this.voiceId = id;
    if (id !== null) this.lastIndex = Math.max(0, this.model.voiceIndex(id));
    for (const fn of this.fns) fn();
  }

  onVoice(fn: () => void): void {
    this.fns.add(fn);
  }

  pref<T>(key: string, fallback: T, valid: (v: unknown) => boolean = (v) => typeof v === typeof fallback): T {
    const v = this.prefs[key];
    return v !== undefined && valid(v) ? (v as T) : fallback;
  }

  setPref(key: string, value: unknown): void {
    if (this.prefs[key] === value) return;
    this.prefs = { ...this.prefs, [key]: value };
    for (const fn of this.prefFns) fn();
  }

  onPrefs(fn: () => void): void {
    this.prefFns.add(fn);
  }

  /** What the session saves: the selected voice tab and the prefs. */
  exportPrefs(): Record<string, unknown> {
    return { ...this.prefs, voiceId: this.voiceId };
  }

  /** Restore saved prefs (the voice tab only if that voice exists). */
  loadPrefs(p: Readonly<Record<string, unknown>>): void {
    const { voiceId, ...rest } = p;
    this.prefs = { ...rest };
    if (typeof voiceId === 'number' && this.model.voice(voiceId)) this.setVoice(voiceId);
    for (const fn of this.prefFns) fn();
  }

  private validate(): void {
    const vs = this.model.voices;
    const i = this.voiceId === null ? -1 : this.model.voiceIndex(this.voiceId);
    if (i >= 0) this.lastIndex = i;
    else this.setVoice(vs[Math.min(this.lastIndex, vs.length - 1)]?.id ?? null);
  }
}

/** Shared handles passed to every UI section. */
export interface UiContext {
  model: AppModel;
  bridge: AudioBridge;
  ui: UiState;
}

/** A section that draws on animation frames. Draw only when dirty or animating, and visible. */
export interface FrameView {
  frame(now: number): void;
}

/** What a Generate tab would add now: each waveform's data (every one computed) and the shown one. */
export interface GeneratePreview {
  batch: readonly Float32Array[];
  shown: number;
}

/** A Generate tab's view: frames, plus its current preview (null while not complete). */
export interface GenerateView extends FrameView {
  preview(): GeneratePreview | null;
}

const visible = new WeakMap<Element, boolean>();
const io =
  typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver((entries) => {
        for (const e of entries) visible.set(e.target, e.isIntersecting);
      })
    : null;

/** Track on-screen visibility of an element (canvas). */
export function watchVisibility(el: Element): void {
  visible.set(el, true);
  io?.observe(el);
}

export function isOnScreen(el: Element): boolean {
  return visible.get(el) ?? true;
}
