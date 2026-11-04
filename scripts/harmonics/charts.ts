/**
 * Small static SVG charts for the report (written next to it and linked as images, since
 * Markdown renderers strip inline SVG). Each file carries its own surface and switches to
 * dark colours with prefers-color-scheme. Marks have <title> tooltips; every number is
 * also in the report's tables.
 */

const STYLE = `<style>
  .bg { fill: #fcfcfb; } .ink { fill: #0b0b0b; } .ink2 { fill: #52514e; } .muted { fill: #898781; }
  .grid { stroke: #e1e0d9; stroke-width: 1; } .axis { stroke: #c3c2b7; stroke-width: 1; }
  .s1 { stroke: #2a78d6; fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .d1 { fill: #2a78d6; } .bar { fill: #2a78d6; } .ref { stroke: #898781; stroke-width: 1; stroke-dasharray: 3 3; }
  text { font: 11px system-ui, -apple-system, "Segoe UI", sans-serif; }
  .t { font-size: 12px; font-weight: 600; } .small { font-size: 10px; }
  @media (prefers-color-scheme: dark) {
    .bg { fill: #1a1a19; } .ink { fill: #f0efec; } .ink2 { fill: #c3c2b7; }
    .grid { stroke: #2c2c2a; } .axis { stroke: #383835; }
    .s1 { stroke: #3987e5; } .d1, .bar { fill: #3987e5; }
  }
</style>`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const f1 = (v: number) => (Math.round(v * 10) / 10).toString();

export interface Trajectory {
  title: string;
  values: readonly number[];
}

/**
 * Small multiples: one panel per trajectory (y = spectral centroid, harmonic number, on a
 * scale shared by every panel; x = waveform index in the batch), in rows of `perRow`.
 */
export function trajectoryPanels(heading: string, sub: string, panels: readonly Trajectory[], perRow = 5): string {
  const pw = 150;
  const ph = 92;
  const gap = 14;
  const top = 50;
  const rows = Math.ceil(panels.length / perRow);
  const W = perRow * pw + (perRow - 1) * gap + 24;
  const H = top + rows * (ph + 30) + 10;
  const ymax = Math.max(4, ...panels.flatMap((p) => p.values)) * 1.08;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(heading)}">`,
    STYLE,
    `<rect class="bg" width="${W}" height="${H}" rx="6"/>`,
    `<text class="t ink" x="12" y="20">${esc(heading)}</text>`,
    `<text class="small muted" x="12" y="36">${esc(sub)} · y: centroid 0–${f1(ymax)} (shared scale) · x: waveform 1…N</text>`,
  ];
  panels.forEach((p, i) => {
    const r = Math.floor(i / perRow);
    const c = i % perRow;
    const x0 = 12 + c * (pw + gap);
    const y0 = top + r * (ph + 30);
    const plotTop = y0 + 18;
    const plotH = ph - 26;
    const n = p.values.length;
    const xs = (j: number) => x0 + 4 + (n > 1 ? (j * (pw - 8)) / (n - 1) : (pw - 8) / 2);
    const ys = (v: number) => plotTop + plotH - (v / ymax) * plotH;
    out.push(`<text class="small ink2" x="${x0}" y="${y0 + 10}">${esc(p.title)}</text>`);
    out.push(`<line class="grid" x1="${x0}" x2="${x0 + pw}" y1="${ys(ymax / 2)}" y2="${ys(ymax / 2)}"/>`);
    out.push(`<line class="axis" x1="${x0}" x2="${x0 + pw}" y1="${plotTop + plotH}" y2="${plotTop + plotH}"/>`);
    out.push(`<polyline class="s1" points="${p.values.map((v, j) => `${xs(j).toFixed(1)},${ys(v).toFixed(1)}`).join(' ')}"/>`);
    p.values.forEach((v, j) =>
      out.push(`<circle class="d1" cx="${xs(j).toFixed(1)}" cy="${ys(v).toFixed(1)}" r="2.5"><title>${esc(p.title)} · waveform ${j + 1}: centroid ${f1(v)}</title></circle>`),
    );
    const lo = Math.min(...p.values);
    const hi = Math.max(...p.values);
    out.push(`<text class="small muted" x="${x0}" y="${plotTop + plotH + 12}">centroid ${f1(lo)}–${f1(hi)}</text>`);
  });

  out.push('</svg>');
  return out.join('\n') + '\n';
}

export interface BarDatum {
  label: string;
  value: number;
}

/** Horizontal bars (one series), sorted as given, with a dashed reference line at `ref`. */
export function barChart(heading: string, sub: string, data: readonly BarDatum[], unit: string, ref?: { value: number; label: string }): string {
  const labelW = 150;
  const barW = 360;
  const rowH = 14;
  const top = 58;
  const W = labelW + barW + 70;
  const H = top + data.length * rowH + 16;
  const vmax = Math.max(ref?.value ?? 0, ...data.map((d) => d.value)) * 1.05 || 1;
  const xs = (v: number) => labelW + (Math.max(0, v) / vmax) * barW;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(heading)}">`,
    STYLE,
    `<rect class="bg" width="${W}" height="${H}" rx="6"/>`,
    `<text class="t ink" x="12" y="20">${esc(heading)}</text>`,
    `<text class="small muted" x="12" y="36">${esc(sub)}</text>`,
    `<line class="axis" x1="${labelW}" x2="${labelW}" y1="${top - 6}" y2="${H - 10}"/>`,
  ];
  data.forEach((d, i) => {
    const y = top + i * rowH;
    const w = Math.max(1, xs(d.value) - labelW);
    out.push(`<text class="small ink2" x="${labelW - 6}" y="${y + 9}" text-anchor="end">${esc(d.label)}</text>`);
    out.push(`<rect class="bar" x="${labelW + 1}" y="${y + 1}" width="${(w - 1).toFixed(1)}" height="${rowH - 4}" rx="2"><title>${esc(d.label)}: ${f1(d.value)} ${unit}</title></rect>`);
    const tx = Math.max(labelW + w + 4, ref && d.value < ref.value ? xs(ref.value) + 4 : 0);
    out.push(`<text class="small muted" x="${tx.toFixed(1)}" y="${y + 9}">${f1(d.value)}</text>`);
  });
  if (ref) {
    const x = xs(ref.value).toFixed(1);
    out.push(`<line class="ref" x1="${x}" x2="${x}" y1="${top - 6}" y2="${H - 10}"/>`);
    out.push(`<text class="small muted" x="${x}" y="${top - 10}" text-anchor="middle">${esc(ref.label)}</text>`);
  }
  out.push('</svg>');
  return out.join('\n') + '\n';
}
