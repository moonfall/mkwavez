// Table DSP: FFT, shape(), basic waveforms and mip sets (ports of src/core/fft.ts,
// shape.ts, generators/basic.ts and mipmap.ts). Not for the audio thread (FFT +
// allocation), except mipLevelFor().
#pragma once

#include "constants.h"

#include <array>
#include <vector>

namespace mkwavez {

/** One shaped single-cycle table. */
using Table = std::array<float, TABLE_SIZE>;
/** A table's packed mip set: level l at [MIP_OFFSETS[l], +MIP_LENGTHS[l]). */
using MipSet = std::array<float, MIP_TOTAL>;

/** In-place iterative radix-2 complex FFT; size must be a power of two. Inverse divides by n. */
void fft(double* re, double* im, int n, bool inverse);

struct ShapeOptions {
    /** Gaussian low-pass cutoff in harmonics (0 = none). */
    double lowpassHarmonic = 0;
    /** Highest harmonic kept. */
    int kmax = KMAX;
};

/**
 * The table pipeline every new table goes through: remove DC, band-limit to kmax (plus
 * optional low-pass), rotate so the lowest present harmonic has sine phase, peak-normalise.
 * Non-finite input samples count as 0.
 */
Table shape(const double* x, ShapeOptions opts = {});

enum class BasicWave { sine, tri, saw, square, p25, p10 };
inline constexpr int BASIC_WAVE_COUNT = 6;
const char* basicWaveName(BasicWave w);

/** A basic waveform, shaped (the TS 'noise' wave needs the Perlin port: not yet). */
Table basicWave(BasicWave w);

/** Per-octave band-limited mip set of a shaped table. */
MipSet buildMipSet(const Table& table);

/** Richest level whose top harmonic stays under MIP_NYQUIST_FRACTION * sampleRate. Audio-thread safe. */
int mipLevelFor(double freq, double sampleRate);

} // namespace mkwavez
