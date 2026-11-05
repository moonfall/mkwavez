import type { AppModel } from '../app/model';
import type { AudioBridge } from '../audio/bridge';
import { reflect01 } from '../core/modulation';
import { modulatedPosition, type VoiceParams } from '../core/voice';
import type { Wavetable } from '../core/wavetable';
import { Mix } from '../core/wavetablePlayback';
import { cssColor, fit } from './canvas';
import { voiceColorVar } from './dom';
import { playingMix, voicePositions } from './playing';

/** At most this many rows of a Rows wavetable are drawn (a window around the voice's rows). */
const MAX_PAD_ROWS = 16;
const WAVE_PTS = 20;

/** Which rows of a wavetable the pad shows: all, or a span covering the voice's row window. */
function rowSpan(wt: Wavetable, v: VoiceParams): [number, number] {
  const n = wt.rows.length;
  if (wt.shape !== 'rows' || n <= MAX_PAD_ROWS) return [0, n - 1];
  const a = Math.min(v.windowStartY, v.windowEndY);
  const b = Math.max(v.windowStartY, v.windowEndY);
  if (b - a + 1 >= MAX_PAD_ROWS) return [a, b];
  const pad = Math.floor((MAX_PAD_ROWS - (b - a + 1)) / 2);
  const s = Math.max(0, Math.min(n - MAX_PAD_ROWS, a - pad));
  return [s, s + MAX_PAD_ROWS - 1];
}

/**
 * The X/Y pad of a voice on a 2D or Rows wavetable: the cells (mini waveforms, empty slots
 * dashed), the voice's window rectangle, the LFO path (dashed) and the position dot (live
 * while playing). X runs right, Y down. Rows are drawn with proportional cells, so the
 * dot's X is the same fraction of every row (how the engine aligns rows). The cell layer is
 * cached and rebuilt only when the wavetable, size, visible rows or theme change.
 */
export function createVoicePad(model: AppModel, bridge: AudioBridge, id = 'voice-pad') {
  const canvas = document.createElement('canvas');
  canvas.id = id;
  canvas.setAttribute('role', 'img');
  const base = document.createElement('canvas');
  let baseKey = '';
  let baseRows: unknown = null;
  const mix = new Mix();

  const drawBase = (wt: Wavetable, w: number, hh: number, rows: [number, number], dpr: number) => {
    base.width = Math.max(1, Math.round(w * dpr));
    base.height = Math.max(1, Math.round(hh * dpr));
    const g = base.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hh);
    const nRows = rows[1] - rows[0] + 1;
    const ch = hh / Math.max(1, nRows);
    const cBorder = cssColor('--border');
    const cWave = cssColor('--text-2');
    const cCell = cssColor('--surface');
    g.lineWidth = 1;
    for (let r = rows[0]; r <= rows[1]; r++) {
      const row = wt.rows[r] ?? [];
      const L = wt.shape === '2d' ? (wt.rows[0]?.length ?? 1) : Math.max(1, row.length);
      const cw = w / L;
      const y = (r - rows[0]) * ch;
      const waves = cw >= 10 && ch >= 10;
      for (let x = 0; x < row.length; x++) {
        const id = row[x];
        const x0 = x * cw;
        const gap = cw > 6 && ch > 6 ? 1.5 : 0.5;
        if (id === null) {
          g.setLineDash([2, 2]);
          g.strokeStyle = cBorder;
          g.strokeRect(x0 + gap, y + gap, cw - 2 * gap, ch - 2 * gap);
          g.setLineDash([]);
          continue;
        }
        g.fillStyle = cCell;
        g.fillRect(x0 + gap, y + gap, cw - 2 * gap, ch - 2 * gap);
        g.strokeStyle = cBorder;
        g.strokeRect(x0 + gap, y + gap, cw - 2 * gap, ch - 2 * gap);
        const t = model.table(id);
        if (!t || !waves) continue;
        g.strokeStyle = cWave;
        g.beginPath();
        const mid = y + ch / 2;
        const amp = ch * 0.32;
        for (let i = 0; i <= WAVE_PTS; i++) {
          const v = t.data[Math.min(t.data.length - 1, Math.floor((i / WAVE_PTS) * t.data.length))];
          const px = x0 + cw * 0.1 + (i / WAVE_PTS) * cw * 0.8;
          if (i) g.lineTo(px, mid - v * amp);
          else g.moveTo(px, mid - v * amp);
        }
        g.stroke();
      }
    }
  };

  /**
   * Draw for voice v on wavetable wt (2D or Rows) at CSS height hh. `o.pos` / `o.mix`
   * override where the dot comes from (a Synth voice's osc B: pass a voice-shaped view of
   * its source with no LFO, its live position and its mix).
   */
  const draw = (
    v: VoiceParams,
    wt: Wavetable,
    hh: number,
    o: { pos?: { x: number; y: number; live: boolean }; mix?: (out: Mix) => Mix; path?: { span: number; at(t: number): [number, number] } | null } = {},
  ) => {
    const [g, w, H] = fit(canvas, hh);
    const rows = rowSpan(wt, v);
    const dpr = window.devicePixelRatio || 1;
    const key = `${w}|${H}|${rows}|${dpr}|${document.documentElement.dataset.theme}`;
    if (key !== baseKey || wt.rows !== baseRows) {
      drawBase(wt, w, H, rows, dpr);
      baseRows = wt.rows;
      baseKey = key;
    }
    g.drawImage(base, 0, 0, w, H);
    const nRows = rows[1] - rows[0] + 1;
    const ch = H / Math.max(1, nRows);
    const isRows = wt.shape === 'rows';
    const W = isRows ? 1 : Math.max(1, wt.rows[0]?.length ?? 1);
    const cw = w / W;
    const color = cssColor(voiceColorVar(v.id - 1));
    const x0 = isRows ? 0 : Math.min(v.windowStart, v.windowEnd);
    const x1 = isRows ? 0 : Math.max(v.windowStart, v.windowEnd);
    const y0 = Math.min(v.windowStartY, v.windowEndY);
    const y1 = Math.max(v.windowStartY, v.windowEndY);
    // Positions → pad pixels at cell centres. Rows: the engine plays slot u·(L − 1) of the
    // nearest row (L = its length), drawn as L proportional cells.
    const rowLen = (uy: number) => Math.max(1, wt.rows[Math.round(y0 + uy * (y1 - y0))]?.length ?? 1);
    const px = (u: number, uy: number) => {
      if (!isRows) return (x0 + u * (x1 - x0) + 0.5) * cw;
      const L = rowLen(uy);
      return ((u * (L - 1) + 0.5) / L) * w;
    };
    const py = (u: number) => (y0 + u * (y1 - y0) + 0.5 - rows[0]) * ch;
    // Window.
    g.fillStyle = color;
    g.globalAlpha = 0.16;
    const rx = isRows ? 0 : x0 * cw;
    const rw = isRows ? w : (x1 - x0 + 1) * cw;
    const ry = (y0 - rows[0]) * ch;
    const rh = (y1 - y0 + 1) * ch;
    g.fillRect(rx, ry, rw, rh);
    g.globalAlpha = 1;
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.strokeRect(rx + 1, ry + 1, rw - 2, rh - 2);
    // LFO path: a Synth oscillator's routed LFOs (`o.path`; null = none), else the Simple
    // voice's two LFOs over one period of the slower one (at most 20 s).
    if (o.path !== null) {
      const path = o.path;
      const span = path ? path.span : Math.min(20, 1 / Math.max(0.02, Math.min(v.lfoRate, v.lfoRateY)));
      g.setLineDash([3, 3]);
      g.lineWidth = 1;
      g.globalAlpha = 0.8;
      g.beginPath();
      const N = path ? 480 : 240;
      for (let i = 0; i <= N; i++) {
        const t = (i / N) * span;
        let ux: number;
        let uy: number;
        if (path) {
          const [ox, oy] = path.at(t);
          ux = reflect01(v.position + ox);
          uy = reflect01(v.positionY + oy);
        } else {
          ux = modulatedPosition(v.position, v.lfoDepth, v.lfoPhase + 2 * Math.PI * v.lfoRate * t);
          uy = modulatedPosition(v.positionY, v.lfoDepthY, v.lfoPhaseY + 2 * Math.PI * v.lfoRateY * t);
        }
        if (i) g.lineTo(px(ux, uy), py(uy));
        else g.moveTo(px(ux, uy), py(uy));
      }
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
    }
    // Dot: the played position (the chosen cell in Step).
    const pos = o.pos ?? voicePositions(model, bridge, v);
    let dx = px(pos.x, pos.y);
    let dy = py(pos.y);
    if (wt.interp === 'step') {
      const m = o.mix ? o.mix(mix) : playingMix(model, bridge, v, mix);

      if (m.n) {
        const L = isRows ? Math.max(1, wt.rows[m.y]?.length ?? 1) : W;
        dx = isRows ? ((m.x + 0.5) / L) * w : (m.x + 0.5) * cw;
        dy = (m.y + 0.5 - rows[0]) * ch;
      }
    }
    g.beginPath();
    g.arc(dx, dy, 5, 0, 2 * Math.PI);
    g.fillStyle = color;
    g.fill();
    g.strokeStyle = cssColor('--bg');
    g.lineWidth = 2;
    g.stroke();
    canvas.dataset.dot = `${dx.toFixed(1)},${dy.toFixed(1)}`;
    canvas.dataset.shape = wt.shape;
    canvas.setAttribute('aria-label', `${wt.name}: window and X/Y position${pos.live ? ' (live)' : ''}`);
  };

  return { canvas, draw };
}
