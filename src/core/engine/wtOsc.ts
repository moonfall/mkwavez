/**
 * One wavetable oscillator's table mix: which tables it is crossfading (tracked by table
 * id, not wavetable index, so a re-index never changes what plays) and their weights,
 * ramped linearly across each control block. Shared by the Simple voice (its only
 * oscillator) and the Synth voice (oscillators A and B). Fixed arrays, no allocation.
 */
import { MIP_LENGTHS, MIP_OFFSETS } from '../constants';
import type { MipSet } from '../mipmap';
import type { TableId } from '../table';
import { Mix, resolveMix, type PackedWavetable } from '../wavetablePlayback';

/** Tables an oscillator can be crossfading at once: this block's mix (<= 4) plus earlier ones fading out. */
export const MAX_LIVE = 16;

export class WtOsc {
  /** Phase 0..1 of the (first) oscillator reading this mix. */
  phase = 0;
  mipLevel = 0;
  /** Interpolation of the wavetable at the last resolve. */
  step = false;
  /** Coordinates the position resolved to (for the UI). */
  index = 0;
  indexY = 0;
  /**
   * Tables being mixed. Each entry's weight ramps linearly from w0 (block start) to w1
   * (block end): a table entering the mix ramps up from 0, one leaving ramps down to 0,
   * so any window / table / position change is click-free.
   */
  n = 0;
  ids = new Int32Array(MAX_LIVE);
  tabs: (MipSet | null)[] = new Array<MipSet | null>(MAX_LIVE).fill(null);
  w0 = new Float64Array(MAX_LIVE);
  w1 = new Float64Array(MAX_LIVE);
  /** Double buffers for building the next block's entries without allocating. */
  private nIds = new Int32Array(MAX_LIVE);
  private nTabs: (MipSet | null)[] = new Array<MipSet | null>(MAX_LIVE).fill(null);
  private nW0 = new Float64Array(MAX_LIVE);
  private nW1 = new Float64Array(MAX_LIVE);
  readonly mix = new Mix();
  readonly win = { x0: 0, x1: 0, y0: 0, y1: 0 };
  /** Step mode: the held table (kept until the oscillator wraps) and the pending target. */
  heldId: TableId = -1;
  heldTable: MipSet | null = null;
  targetId: TableId = -1;

  /**
   * Take over another oscillator's whole state (the Synth voice's right-channel reader
   * starting from its left one, so the right channel starts from exactly what plays).
   */
  copyFrom(o: WtOsc): void {
    this.phase = o.phase;
    this.mipLevel = o.mipLevel;
    this.step = o.step;
    this.index = o.index;
    this.indexY = o.indexY;
    for (let k = 0; k < MAX_LIVE; k++) {
      this.ids[k] = o.ids[k];
      this.tabs[k] = o.tabs[k];
      this.w0[k] = o.w0[k];
      this.w1[k] = o.w1[k];
    }
    this.n = o.n;
    this.win.x0 = o.win.x0;
    this.win.x1 = o.win.x1;
    this.win.y0 = o.win.y0;
    this.win.y1 = o.win.y1;
    this.heldId = o.heldId;
    this.heldTable = o.heldTable;
    this.targetId = o.targetId;
  }

  /**
   * Whether this block plays exactly the same tables with the same weight ramps as `o`
   * (entries in any order): then either can stand in for the other without a step.
   */
  sameMix(o: WtOsc): boolean {
    if (this.step !== o.step) return false;
    if (this.step) return this.n === o.n && this.heldId === o.heldId && this.targetId === o.targetId && (this.n === 0 || this.tabs[0] === o.tabs[0]);
    let live = 0;
    for (let k = 0; k < this.n; k++) {
      if (this.w0[k] === 0 && this.w1[k] === 0) continue;
      live++;
      let found = false;
      for (let j = 0; j < o.n; j++) {
        if (o.ids[j] === this.ids[k]) {
          if (o.tabs[j] !== this.tabs[k] || o.w0[j] !== this.w0[k] || o.w1[j] !== this.w1[k]) return false;
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    let liveO = 0;
    for (let j = 0; j < o.n; j++) if (o.w0[j] !== 0 || o.w1[j] !== 0) liveO++;
    return live === liveO;
  }

  /** Forget the mix (nothing plays until the next resolve). */
  clear(): void {
    for (let k = 0; k < MAX_LIVE; k++) this.tabs[k] = null;
    this.n = 0;
    this.heldTable = null;
  }

  /** Keep the current mix without ramping (block start = previous block end). */
  hold(): void {
    for (let k = 0; k < this.n; k++) this.w0[k] = this.w1[k];
  }

  /**
   * This block's table mix for window (x0..x1, y0..y1) at positions (pos, posY). `slew` is
   * the largest weight change per block. Call hold() first (the previous block's end
   * weights are this block's start weights). Tables that haven't arrived drop out (the
   * rest renormalised); with none, the previous mix holds.
   */
  resolve(
    tables: ReadonlyMap<TableId, MipSet>,
    wt: PackedWavetable,
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    pos: number,
    posY: number,
    slew: number,
  ): void {
    const win = this.win;
    win.x0 = x0;
    win.x1 = x1;
    win.y0 = y0;
    win.y1 = y1;
    this.step = wt.interp === 'step';
    const mix = resolveMix(wt, win, pos, posY, this.step, this.mix);
    if (mix.n === 0) return; // nothing to address: keep whatever was playing
    this.index = mix.x;
    this.indexY = mix.y;
    if (this.step) {
      this.targetId = mix.ids[0];
      if (this.heldId < 0) {
        // Switched from Blend while sounding: keep the current mix until the phase wraps
        // (wrap() takes the target there), so the change is click-free.
        if (this.n > 0) return;
        this.heldId = this.targetId;
      }
      // Late-arriving table: pick it up; otherwise keep the previous pointer.
      const t = tables.get(this.heldId);
      if (t) this.heldTable = t;
      if (!this.heldTable) return;
      for (let k = 1; k < this.n; k++) this.tabs[k] = null;
      this.n = 1;
      this.ids[0] = this.heldId;
      this.tabs[0] = this.heldTable;
      this.w0[0] = this.w1[0] = 1;
      return;
    }
    this.heldId = this.targetId = -1;
    this.heldTable = null;
    let total = 0;
    let missing = false;
    for (let k = 0; k < mix.n; k++) {
      if (tables.has(mix.ids[k])) total += mix.w[k];
      else missing = true;
    }
    if (total <= 0) return;
    const norm = missing ? 1 / total : 1;
    const first = this.n === 0;
    let m = 0;
    // Entries already playing ramp from their weight to the new one (0 if leaving).
    for (let k = 0; k < this.n; k++) {
      const id = this.ids[k];
      let w = 0;
      for (let j = 0; j < mix.n; j++) if (mix.ids[j] === id) w = mix.w[j] * norm;
      if (w === 0 && this.w0[k] === 0) continue;
      this.nIds[m] = id;
      this.nTabs[m] = this.tabs[k];
      this.nW0[m] = this.w0[k];
      this.nW1[m] = w;
      m++;
    }
    // New entries ramp up from 0 (start at their weight on the first resolve).
    for (let j = 0; j < mix.n && m < MAX_LIVE; j++) {
      const id = mix.ids[j];
      const t = tables.get(id);
      if (!t) continue;
      let known = false;
      for (let k = 0; k < m; k++) if (this.nIds[k] === id) known = true;
      if (known) continue;
      const w = mix.w[j] * norm;
      this.nIds[m] = id;
      this.nTabs[m] = t;
      this.nW0[m] = first ? w : 0;
      this.nW1[m] = w;
      m++;
    }
    // Slew-limit: scale every entry's step by the same factor (the weights keep summing to 1).
    let maxDiff = 0;
    for (let k = 0; k < m; k++) maxDiff = Math.max(maxDiff, Math.abs(this.nW1[k] - this.nW0[k]));
    if (maxDiff > slew) {
      const f = slew / maxDiff;
      for (let k = 0; k < m; k++) this.nW1[k] = this.nW0[k] + (this.nW1[k] - this.nW0[k]) * f;
    }
    this.swap(m);
  }

  private swap(m: number): void {
    const ids = this.ids;
    const tabs = this.tabs;
    const w0 = this.w0;
    const w1 = this.w1;
    this.ids = this.nIds;
    this.tabs = this.nTabs;
    this.w0 = this.nW0;
    this.w1 = this.nW1;
    this.nIds = ids;
    this.nTabs = tabs;
    this.nW0 = w0;
    this.nW1 = w1;
    for (let k = 0; k < MAX_LIVE; k++) this.nTabs[k] = null;
    for (let k = m; k < MAX_LIVE; k++) this.tabs[k] = null;
    this.n = m;
  }

  /** The mixed sample at `phase` (0..1), `blockT` (0..1) of the way through the block. 0 if empty. */
  read(phase: number, blockT: number): number {
    const off = MIP_OFFSETS[this.mipLevel];
    const len = MIP_LENGTHS[this.mipLevel];
    const x = phase * len;
    const k = x | 0;
    const fr = x - k;
    const k1 = off + k;
    const k2 = k + 1 === len ? off : k1 + 1;
    let out = 0;
    for (let j = 0; j < this.n; j++) {
      const T = this.tabs[j]!;
      const a0 = T[k1];
      const w = this.w0[j] + (this.w1[j] - this.w0[j]) * blockT;
      out += (a0 + (T[k2] - a0) * fr) * w;
    }
    return out;
  }

  /** The oscillator's phase wrapped: in Step mode, take the pending target table (click-free). */
  wrapped(tables: ReadonlyMap<TableId, MipSet>): void {
    if (this.step && this.targetId >= 0 && this.heldId !== this.targetId) {
      const t = tables.get(this.targetId);
      if (t) {
        this.heldId = this.targetId;
        this.heldTable = t;
        for (let j = 1; j < this.n; j++) this.tabs[j] = null;
        this.n = 1;
        this.ids[0] = this.heldId;
        this.tabs[0] = t;
        this.w0[0] = this.w1[0] = 1;
      }
    }
  }
}
