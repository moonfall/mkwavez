// Port of src/core/constants.ts. Keep the two in sync (tests/golden.test.ts guards the
// shared numbers).
#pragma once

#include <array>
#include <cstddef>

namespace mkwavez {

/** Samples per single-cycle table. Power of two (FFT). */
inline constexpr int TABLE_SIZE = 2048;

/** Highest harmonic kept by shape(). */
inline constexpr int KMAX = 72;

/** Default timeline capacity. */
inline constexpr int TIMELINE_CAP = 4096;

/**
 * First id of a preview table (src/core/wavetable.ts PREVIEW_ID_BASE): a waveform the web
 * app's Generate tab shows but hasn't added. The page ships them to the engine only while a
 * voice plays the Preview / Preview batch wavetable; they're never saved.
 */
inline constexpr int PREVIEW_ID_BASE = 1 << 30;
inline constexpr bool isPreviewId(int id) { return id >= PREVIEW_ID_BASE; }

/**
 * Per-octave mip levels. Level l keeps harmonics 1..MIP_HARMONICS[l], stored with
 * MIP_LENGTHS[l] samples; level 0 is the full shaped table. All levels of one table are
 * packed in one buffer of MIP_TOTAL floats.
 */
inline constexpr int MIP_LEVELS = 7;
inline constexpr std::array<int, MIP_LEVELS> MIP_HARMONICS{72, 36, 18, 9, 4, 2, 1};
inline constexpr std::array<int, MIP_LEVELS> MIP_LENGTHS{2048, 1024, 512, 256, 128, 64, 64};
inline constexpr std::array<int, MIP_LEVELS> MIP_OFFSETS = [] {
    std::array<int, MIP_LEVELS> o{};
    int n = 0;
    for (int i = 0; i < MIP_LEVELS; ++i) {
        o[(size_t) i] = n;
        n += MIP_LENGTHS[(size_t) i];
    }
    return o;
}();
inline constexpr int MIP_TOTAL = MIP_OFFSETS[MIP_LEVELS - 1] + MIP_LENGTHS[MIP_LEVELS - 1];

/** Fraction of the sample rate the highest played harmonic must stay under. */
inline constexpr double MIP_NYQUIST_FRACTION = 0.45;

/** Sequencer note rows: A minor pentatonic from A2. */
inline constexpr double SCALE_ROOT_HZ = 110.0;
inline constexpr std::array<int, 8> SCALE_SEMITONES{0, 3, 5, 7, 10, 12, 15, 17};
inline constexpr int SCALE_ROWS = (int) SCALE_SEMITONES.size();

/** Maximum sequence length in steps. */
inline constexpr int MAX_STEPS = 64;

/** Engine block size for control-rate (LFO / window / mip) updates. */
inline constexpr int CONTROL_BLOCK = 64;

inline constexpr double PI = 3.14159265358979323846;

} // namespace mkwavez
