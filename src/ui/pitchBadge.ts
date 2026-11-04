import { apparentPitch, pitchExplain, pitchLabel } from '../core/pitch';
import { spectrum } from './canvas';
import { h } from './dom';

/**
 * A small badge over a spectrum plot, shown when the shown waveform doesn't play its note:
 * its present harmonics share a common divisor ("sounds +1 oct", "sounds +19 st") or its
 * fundamental is weak. Computed from the cached spectrum (core/pitch.ts); the tooltip says why.
 */
export function pitchBadge(id: string): { el: HTMLElement; show(data: Float32Array | Float64Array | undefined): void } {
  const el = h('span', { class: 'pitch-badge', id, role: 'note', tabindex: 0, hidden: true });
  let last: Float32Array | Float64Array | undefined;
  return {
    el,
    show(data) {
      if (data === last) return;
      last = data;
      const p = data ? apparentPitch(spectrum(data)) : null;
      const label = pitchLabel(p);
      el.hidden = !label;
      el.textContent = label;
      el.title = pitchExplain(p);
      el.classList.toggle('pitch-weak', !!p && p.divisor <= 1);
      if (label) el.setAttribute('aria-label', `${label}: ${el.title}`);
      else el.removeAttribute('aria-label');
    },
  };
}
