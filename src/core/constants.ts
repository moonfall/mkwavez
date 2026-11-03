/** Samples per single-cycle table. Power of two (FFT). */
export const TABLE_SIZE = 2048;

/** Highest harmonic kept by shape(). Keeps the prototype's top note under Nyquist at 48 kHz. */
export const KMAX = 72;

/** Default timeline capacity (tables kept before oldest-first eviction). */
export const TIMELINE_CAP = 4096;

/** Undo history depth. */
export const UNDO_DEPTH = 40;

/**
 * Per-octave mip levels. Level l keeps harmonics 1..MIP_HARMONICS[l] and is stored
 * with MIP_LENGTHS[l] samples (~28 samples per harmonic, so linear interpolation
 * quality is the same at every level). Level 0 is the full shaped table.
 */
export const MIP_HARMONICS: readonly number[] = [72, 36, 18, 9, 4, 2, 1];
export const MIP_LENGTHS: readonly number[] = [2048, 1024, 512, 256, 128, 64, 64];
export const MIP_OFFSETS: readonly number[] = MIP_LENGTHS.map((_, i) =>
  MIP_LENGTHS.slice(0, i).reduce((a, b) => a + b, 0),
);
export const MIP_TOTAL = MIP_LENGTHS.reduce((a, b) => a + b, 0);

/** Fraction of the sample rate the highest played harmonic must stay under. */
export const MIP_NYQUIST_FRACTION = 0.45;

/** Sequencer note rows: A minor pentatonic from A2 (semitones above SCALE_ROOT_HZ). */
export const SCALE_ROOT_HZ = 110;
export const SCALE_SEMITONES: readonly number[] = [0, 3, 5, 7, 10, 12, 15, 17];
export const SCALE_ROWS = SCALE_SEMITONES.length;

/** Maximum sequence length in steps. */
export const MAX_STEPS = 64;

/** Engine block size for control-rate (LFO / window / mip) updates. */
export const CONTROL_BLOCK = 64;
