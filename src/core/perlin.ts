import { TABLE_SIZE } from './constants';
import { Prng } from './prng';

/** Fixed permutation table (same as the prototype: shuffled with seed 1234), doubled to 512. */
const PERM: Uint8Array = (() => {
  const r = new Prng(1234);
  const p = new Uint8Array(512);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r.next() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 256; i++) p[256 + i] = p[i];
  return p;
})();

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function grad(h: number, x: number, y: number, z: number): number {
  const g = h & 15;
  const u = g < 8 ? x : y;
  const v = g < 4 ? y : g === 12 || g === 14 ? x : z;
  return ((g & 1) ? -u : u) + ((g & 2) ? -v : v);
}

function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a);
}

/** Classic improved Perlin noise in 3D. Roughly in [-1, 1]. */
export function noise3(x: number, y: number, z: number): number {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const fz = Math.floor(z);
  const X = fx & 255;
  const Y = fy & 255;
  const Z = fz & 255;
  x -= fx;
  y -= fy;
  z -= fz;
  const u = fade(x);
  const v = fade(y);
  const w = fade(z);
  const A = PERM[X] + Y;
  const AA = PERM[A] + Z;
  const AB = PERM[A + 1] + Z;
  const B = PERM[X + 1] + Y;
  const BA = PERM[B] + Z;
  const BB = PERM[B + 1] + Z;
  return lerp(
    lerp(
      lerp(grad(PERM[AA], x, y, z), grad(PERM[BA], x - 1, y, z), u),
      lerp(grad(PERM[AB], x, y - 1, z), grad(PERM[BB], x - 1, y - 1, z), u),
      v,
    ),
    lerp(
      lerp(grad(PERM[AA + 1], x, y, z - 1), grad(PERM[BA + 1], x - 1, y, z - 1), u),
      lerp(grad(PERM[AB + 1], x, y - 1, z - 1), grad(PERM[BB + 1], x - 1, y - 1, z - 1), u),
      v,
    ),
    w,
  );
}

/** Fractal Brownian motion over noise3; octaves clamped to 1..10, normalised by total amplitude. */
export function fbm(x: number, y: number, z: number, octaves: number, persistence: number): number {
  const oct = Math.max(1, Math.min(10, Math.round(octaves)));
  let s = 0;
  let a = 1;
  let f = 1;
  let norm = 0;
  for (let o = 0; o < oct; o++) {
    s += a * noise3(x * f, y * f, z * f);
    norm += a;
    a *= persistence;
    f *= 2;
  }
  return s / norm;
}

/**
 * A seeded region of noise space. The seed picks an offset so different seeds give
 * unrelated noise; a batch shares one field so `z` drift gives related tables.
 */
export interface NoiseField {
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
}

export function noiseField(seed: number): NoiseField {
  const r = new Prng(seed);
  return { ox: r.next() * 200, oy: r.next() * 200, oz: r.next() * 200 };
}

/**
 * Loop-seamless noise: samples fBm on a circle of radius `freq` at angle `phase` (0..2pi).
 * `z` moves through the noise perpendicular to the circle.
 */
export function pnoiseAt(
  field: NoiseField,
  phase: number,
  freq = 2,
  z = 0,
  octaves = 4,
  persistence = 0.5,
): number {
  return fbm(
    Math.cos(phase) * freq + field.ox,
    Math.sin(phase) * freq + field.oy,
    z + field.oz,
    octaves,
    persistence,
  );
}

/** Raw (un-shaped) noise cycle. */
export function noiseCycle(
  field: NoiseField,
  freq: number,
  z: number,
  octaves: number,
  persistence: number,
): Float64Array {
  const x = new Float64Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i++) {
    x[i] = pnoiseAt(field, (2 * Math.PI * i) / TABLE_SIZE, freq, z, octaves, persistence);
  }
  return x;
}
