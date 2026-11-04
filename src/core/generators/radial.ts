/**
 * Radius-vs-angle reading of closed outlines from an off-centre point. Read from the
 * centre, a shape with n-fold symmetry (an n-gon, a superformula with symmetry m) repeats
 * n times per cycle, so its waveform has only every n-th harmonic and sounds above its
 * note; read from a point off the centre, the cycle goes round once and keeps the
 * fundamental, with the outline's detail on top.
 */
import { TABLE_SIZE } from '../constants';

const TAU = 2 * Math.PI;

/**
 * The farthest crossing of the outlines (closed polylines, first point repeated last) along
 * each of TABLE_SIZE rays from (ox, oy), ray i at angle 2πi/N. One sweep over the
 * segments: each covers the rays between its end points' angles (O(segments + rays)).
 * Rays no segment covers (none, for an outline around the point) take their neighbour's.
 */
export function radiusFrom(outlines: readonly (readonly (readonly [number, number])[])[], ox: number, oy: number): Float64Array {
  const N = TABLE_SIZE;
  const out = new Float64Array(N).fill(-1);
  const k = N / TAU;
  for (const L of outlines)
    for (let s = 0; s + 1 < L.length; s++) {
      const ax = L[s][0] - ox;
      const ay = L[s][1] - oy;
      const bx = L[s + 1][0] - ox;
      const by = L[s + 1][1] - oy;
      const a0 = Math.atan2(ay, ax);
      let d = Math.atan2(by, bx) - a0;
      if (d > Math.PI) d -= TAU;
      else if (d <= -Math.PI) d += TAU;
      const lo = Math.ceil((d >= 0 ? a0 : a0 + d) * k - 1e-9);
      const hi = Math.floor((d >= 0 ? a0 + d : a0) * k + 1e-9);
      const ex = bx - ax;
      const ey = by - ay;
      for (let j = lo; j <= hi; j++) {
        const c = Math.cos(j / k);
        const sn = Math.sin(j / k);
        const den = c * ey - sn * ex;
        if (Math.abs(den) < 1e-15) continue;
        const t = (ax * ey - ay * ex) / den;
        const i = ((j % N) + N) % N;
        if (t > out[i]) out[i] = t;
      }
    }
  let last = 0;
  for (let i = 0; i < N; i++) if (out[i] >= 0) last = out[i];
  for (let i = 0; i < N; i++) {
    if (out[i] < 0) out[i] = last;
    last = out[i];
  }
  return out;
}

/** Smallest value (the inner radius of a centre reading). */
export function minOf(x: ArrayLike<number>): number {
  let m = Infinity;
  for (let i = 0; i < x.length; i++) m = Math.min(m, x[i]);
  return m;
}
