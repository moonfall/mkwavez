/**
 * In-place iterative radix-2 complex FFT. `re`/`im` length must be a power of two.
 * Forward uses e^{-i}, inverse uses e^{+i} and divides by n.
 */
export function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const u = i + k;
        const v = u + half;
        const tr = re[v] * cr - im[v] * ci;
        const ti = re[v] * ci + im[v] * cr;
        re[v] = re[u] - tr;
        im[v] = im[u] - ti;
        re[u] += tr;
        im[u] += ti;
        const nc = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nc;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** Forward FFT of a real signal. Returns new re/im arrays of the same length. */
export function realFft(x: ArrayLike<number>): { re: Float64Array; im: Float64Array } {
  const re = Float64Array.from(x);
  const im = new Float64Array(re.length);
  fft(re, im, false);
  return { re, im };
}

/** Make bins N-k the conjugates of bins k (so the inverse is real). Clears DC-imag and Nyquist-imag. */
export function enforceHermitian(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let k = 1; k < n / 2; k++) {
    re[n - k] = re[k];
    im[n - k] = -im[k];
  }
  im[0] = 0;
  im[n / 2] = 0;
}

/** Harmonic magnitudes 1..kmax of a real single-cycle table, normalised so a unit sine has magnitude 1. */
export function harmonicMagnitudes(x: ArrayLike<number>, kmax: number): Float64Array {
  const { re, im } = realFft(x);
  const n = re.length;
  const out = new Float64Array(kmax + 1);
  for (let k = 1; k <= kmax && k < n / 2; k++) out[k] = (2 * Math.hypot(re[k], im[k])) / n;
  return out;
}
