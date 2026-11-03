import type { UiState } from './context';

/**
 * Shell layout: which panels are collapsed, per layout (the wide one-screen shell and the
 * narrow phone column keep separate states), and the wide shell's "maximize" (one panel
 * gets the whole content area, the others collapse; maximizing again restores the previous
 * arrangement). Saved with the session as UI prefs (`layoutWide`, `layoutNarrow`).
 *
 * The controller only writes classes (no layout reads): on the wide shell a collapsed
 * panel is a narrow vertical strip when a sibling in its row stays open (the siblings take
 * the width), or a header-height bar when its whole row is collapsed (the other rows take
 * the height). See styles.css "shell layout".
 */

/** Below this width the shell is one scrolling column of collapsible panels. */
export const NARROW_SHELL = '(max-width: 899px)';
const narrowShell = typeof matchMedia !== 'undefined' ? matchMedia(NARROW_SHELL) : null;
export const isNarrowShell = (): boolean => !!narrowShell?.matches;

export type PanelKey = 'gen' | 'wt' | 'tl' | 'voice' | 'seq';
export const PANEL_KEYS: readonly PanelKey[] = ['gen', 'wt', 'tl', 'voice', 'seq'];
/** The wide shell's rows (top to bottom). */
const ROWS: readonly (readonly PanelKey[])[] = [['gen', 'wt'], ['tl'], ['voice', 'seq']];
const ROW_CLASS = ['top-collapsed', 'tl-collapsed', 'bottom-collapsed'];

export type LayoutMode = 'wide' | 'narrow';
export type PanelShape = 'open' | 'strip' | 'bar';

/** One layout's saved state. */
export interface LayoutState {
  collapsed: PanelKey[];
  /** The maximized panel (wide only) and the arrangement to restore. */
  max: PanelKey | null;
  restore: PanelKey[] | null;
}

const PREF: Record<LayoutMode, string> = { wide: 'layoutWide', narrow: 'layoutNarrow' };
const DEFAULTS: Record<LayoutMode, LayoutState> = {
  wide: { collapsed: [], max: null, restore: null },
  // Wavetables starts collapsed in the phone column.
  narrow: { collapsed: ['wt'], max: null, restore: null },
};

const isKey = (x: unknown): x is PanelKey => typeof x === 'string' && (PANEL_KEYS as readonly string[]).includes(x);
const keyList = (x: unknown): PanelKey[] | null => (Array.isArray(x) ? PANEL_KEYS.filter((k) => x.includes(k)) : null);

/** Parse a saved layout state (bad / missing fields → defaults). Exported for tests. */
export function parseLayoutState(x: unknown, mode: LayoutMode): LayoutState {
  const d = DEFAULTS[mode];
  if (!x || typeof x !== 'object') return { ...d, collapsed: [...d.collapsed] };
  const o = x as Record<string, unknown>;
  const collapsed = keyList(o.collapsed) ?? [...d.collapsed];
  const max = mode === 'wide' && isKey(o.max) && !collapsed.includes(o.max) ? o.max : null;
  return { collapsed, max, restore: max ? (keyList(o.restore) ?? []) : null };
}

/** Collapse / expand one panel (a manual change ends a maximize). */
export function toggled(s: LayoutState, key: PanelKey, collapse: boolean): LayoutState {
  const has = s.collapsed.includes(key);
  if (has === collapse) return s;
  const collapsed = collapse ? PANEL_KEYS.filter((k) => k === key || s.collapsed.includes(k)) : s.collapsed.filter((k) => k !== key);
  return { collapsed, max: null, restore: null };
}

/** Maximize `key` (everything else collapses), or restore the arrangement from before. */
export function maximized(s: LayoutState, key: PanelKey): LayoutState {
  if (s.max === key) return { collapsed: [...(s.restore ?? [])], max: null, restore: null };
  return { collapsed: PANEL_KEYS.filter((k) => k !== key), max: key, restore: s.max ? (s.restore ?? []) : [...s.collapsed] };
}

/**
 * How each panel shows on the wide shell: open; a vertical strip (collapsed next to an open
 * sibling); a bar (collapsed, its whole row collapsed). `hidden` panels (Generate while the
 * Wavetables editor covers its row) don't count as siblings. Exported for tests.
 */
export function wideShapes(collapsed: readonly PanelKey[], hidden: readonly PanelKey[] = []): { shapes: Record<PanelKey, PanelShape>; rows: boolean[] } {
  const shapes = {} as Record<PanelKey, PanelShape>;
  const rows = ROWS.map((row) => {
    const shown = row.filter((k) => !hidden.includes(k));
    const all = shown.length > 0 && shown.every((k) => collapsed.includes(k));
    for (const k of row) shapes[k] = !collapsed.includes(k) ? 'open' : all ? 'bar' : 'strip';
    return all;
  });
  return { shapes, rows };
}

interface Registered {
  el: HTMLElement;
  title: string;
  fns: (() => void)[];
  status: () => string;
  statusEl: HTMLElement;
  stripBtn: HTMLElement;
  collapseBtn: HTMLElement;
  maxBtn: HTMLElement;
  lastStatus: string;
  open: boolean;
}

class ShellLayout {
  private ui: UiState | null = null;
  private panels = new Map<PanelKey, Registered>();
  private states: Record<LayoutMode, LayoutState> = {
    wide: parseLayoutState(null, 'wide'),
    narrow: parseLayoutState(null, 'narrow'),
  };
  private lastStatusAt = -1e9;

  constructor() {
    narrowShell?.addEventListener('change', () => this.apply(true));
  }

  /** Bind to the session's UI prefs (call before building the panels). */
  init(ui: UiState): void {
    this.ui = ui;
    this.load();
    ui.onPrefs(() => {
      if (this.load()) this.apply();
    });
  }

  get mode(): LayoutMode {
    return isNarrowShell() ? 'narrow' : 'wide';
  }

  state(mode = this.mode): LayoutState {
    return this.states[mode];
  }

  register(key: PanelKey, r: Omit<Registered, 'lastStatus' | 'open' | 'fns' | 'status'>): { onToggle(fn: () => void): void; setStatus(fn: () => string): void } {
    const reg: Registered = { ...r, fns: [], status: () => '', lastStatus: '', open: true };
    this.panels.set(key, reg);
    this.applyOne(key, reg, this.shapes());
    reg.open = !this.isCollapsed(key);
    return {
      onToggle: (fn) => reg.fns.push(fn),
      setStatus: (fn) => {
        reg.status = fn;
        reg.lastStatus = '';
      },
    };
  }

  isCollapsed(key: PanelKey): boolean {
    return this.state().collapsed.includes(key);
  }

  setCollapsed(key: PanelKey, collapse: boolean): void {
    this.set(toggled(this.state(), key, collapse));
  }

  toggle(key: PanelKey): void {
    this.setCollapsed(key, !this.isCollapsed(key));
  }

  /** Expand `key` in both layouts (the Wavetables editor opening: it shows on either shell). */
  expandEverywhere(key: PanelKey): void {
    const other: LayoutMode = this.mode === 'wide' ? 'narrow' : 'wide';
    this.set(toggled(this.state(other), key, false), other, false);
    this.set(toggled(this.state(), key, false));
  }

  /** Wide shell: give `key` the whole content area, or restore (if it is the maximized one). */
  maximize(key: PanelKey): void {
    if (this.mode !== 'wide') return;
    this.set(maximized(this.state(), key));
  }

  /** Re-apply (e.g. the Wavetables editor opened or closed over the Generate row). */
  refresh(): void {
    this.apply();
  }

  /** Frame loop: refresh the one-line status of collapsed panels (≤ 5 per second). */
  tick(now: number): void {
    if (now - this.lastStatusAt < 200) return;
    this.lastStatusAt = now;
    for (const reg of this.panels.values()) {
      if (reg.open) continue;
      const s = reg.status();
      if (s === reg.lastStatus && reg.statusEl.textContent === s) continue;
      reg.lastStatus = s;
      reg.statusEl.textContent = s;
      reg.stripBtn.title = `Expand ${reg.title}${s ? ` (${s})` : ''}`;
    }
  }

  private set(s: LayoutState, mode = this.mode, apply = true): void {
    if (JSON.stringify(s) === JSON.stringify(this.states[mode])) return;
    this.states[mode] = s;
    this.ui?.setPref(PREF[mode], { collapsed: [...s.collapsed], max: s.max, restore: s.restore ? [...s.restore] : null });
    if (apply) this.apply();
  }

  /** Read both states from the prefs; true if either changed. */
  private load(): boolean {
    if (!this.ui) return false;
    let changed = false;
    for (const mode of ['wide', 'narrow'] as const) {
      const s = parseLayoutState(this.ui.pref<unknown>(PREF[mode], null, () => true), mode);
      if (JSON.stringify(s) !== JSON.stringify(this.states[mode])) {
        this.states[mode] = s;
        changed = true;
      }
    }
    return changed;
  }

  private shapes() {
    const shell = document.querySelector('.shell');
    const hidden: PanelKey[] = shell?.classList.contains('wt-editing') ? ['gen'] : [];
    return wideShapes(this.state('wide').collapsed, hidden);
  }

  private applyOne(key: PanelKey, reg: Registered, { shapes }: ReturnType<ShellLayout['shapes']>): void {
    const st = this.state();
    const wide = this.mode === 'wide';
    const collapsed = st.collapsed.includes(key);
    const shape: PanelShape = !collapsed ? 'open' : wide ? shapes[key] : 'bar';
    reg.el.classList.toggle('collapsed', collapsed);
    reg.el.dataset.shape = shape;
    const isMax = wide && st.max === key;
    reg.el.classList.toggle('maximized', isMax);
    reg.collapseBtn.setAttribute('aria-expanded', String(!collapsed));
    reg.collapseBtn.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${reg.title}`);
    reg.collapseBtn.title = `${collapsed ? 'Expand' : 'Collapse'} ${reg.title}`;
    reg.maxBtn.setAttribute('aria-pressed', String(isMax));
    reg.maxBtn.setAttribute('aria-label', isMax ? 'Restore the previous layout' : `Maximize ${reg.title}`);
    reg.maxBtn.title = isMax ? 'Restore the previous layout (or double-click the header)' : `Maximize ${reg.title}: the other panels collapse (or double-click the header)`;
    reg.stripBtn.setAttribute('aria-label', `Expand ${reg.title}`);
  }

  private apply(modeChanged = false): void {
    const sh = this.shapes();
    const shell = document.querySelector('.shell');
    if (shell) {
      const wide = this.mode === 'wide';
      ROW_CLASS.forEach((c, i) => shell.classList.toggle(c, wide && sh.rows[i]));
      const max = wide ? this.state().max : null;
      if (max) (shell as HTMLElement).dataset.max = max;
      else delete (shell as HTMLElement).dataset.max;
    }
    for (const [key, reg] of this.panels) {
      this.applyOne(key, reg, sh);
      const open = !this.isCollapsed(key);
      if (open !== reg.open || modeChanged) {
        reg.open = open;
        reg.lastStatus = '';
        if (!open) {
          reg.lastStatus = reg.status();
          reg.statusEl.textContent = reg.lastStatus;
        }
        for (const fn of reg.fns) fn();
      }
    }
  }
}

/** The one shell layout (panels register as they are built). */
export const layout = new ShellLayout();
