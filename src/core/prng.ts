/**
 * Seeded PRNG (mulberry32 variant, same as the prototype's rng()).
 * State is a single uint32, so it ports directly to C++ and can be persisted.
 */
export class Prng {
  state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [-1, 1). */
  bipolar(): number {
    return this.next() * 2 - 1;
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}

/** Mix a seed with an integer stream index (splitmix-style hash) to derive independent seeds. */
export function deriveSeed(seed: number, index: number): number {
  let z = (seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

/** A fresh non-deterministic seed (UI layer use only; core functions always take seeds). */
export function randomSeed(): number {
  return (Math.random() * 4294967296) >>> 0;
}
