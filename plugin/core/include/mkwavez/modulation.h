// Port of src/core/modulation.ts: LFO shapes / divisions, mod matrix sources and
// destinations, the matrix sum, reflect01. Header-only, allocation-free.
#pragma once

#include "constants.h"

#include <array>
#include <cmath>
#include <cstdint>

namespace mkwavez {

enum class LfoShape : uint8_t { sine, tri, saw, square, sh, smooth };
inline constexpr int LFO_SHAPE_COUNT = 6;

/** Tempo-synced LFO divisions (order = LFO_DIVS in TS). */
inline constexpr int LFO_DIV_COUNT = 16;
/** Beats (quarter notes) per LFO cycle: 8/1 4/1 2/1 1/1 1/2 1/2D 1/2T 1/4 1/4D 1/4T 1/8 1/8D 1/8T 1/16 1/16T 1/32. */
inline constexpr std::array<double, LFO_DIV_COUNT> LFO_DIV_BEATS{32, 16, 8, 4, 2, 3, 4.0 / 3, 1, 1.5, 2.0 / 3, 0.5, 0.75, 1.0 / 3, 0.25, 1.0 / 6, 0.125};

inline constexpr double LFO_RATE_MIN_HZ = 0.01;
inline constexpr double LFO_RATE_MAX_HZ = 40;
inline constexpr int LFO_COUNT = 3;

struct LfoParams {
    LfoShape shape = LfoShape::sine;
    /** Free rate in Hz. */
    double rate = 2;
    bool sync = false;
    /** Index into LFO_DIV_BEATS. */
    int div = 7; // 1/4
    bool retrig = false;
    double phase = 0;
    /** Stereo phase 0..0.5: the right channel's copy runs this far ahead (periodic shapes only). */
    double stereo = 0;
    double fade = 0;
    double depth = 1;
};

/** Shapes a stereo phase applies to (S&H / smooth random draw one value for both sides). */
inline bool isPeriodicShape(LfoShape s) { return s != LfoShape::sh && s != LfoShape::smooth; }

inline double lfoRateHz(const LfoParams& l, double bpm) { return l.sync ? bpm / 60 / LFO_DIV_BEATS[(size_t) l.div] : l.rate; }

enum class ModEnvMode : uint8_t { ad, adsr };

/** Sources (order = MOD_SOURCES in TS). */
enum ModSource : int8_t {
    SRC_NONE = -1, SRC_LFO1, SRC_LFO2, SRC_LFO3, SRC_FENV, SRC_PENV, SRC_MENV, SRC_VEL, SRC_WHEEL, SRC_AT, SRC_KEY, SRC_RAND,
    SRC_MACRO1, SRC_MACRO2, SRC_MACRO3, SRC_MACRO4
};
inline constexpr int N_SOURCES = 15;
/** Destinations (order = MOD_DESTS in TS). */
enum ModDest : int8_t {
    DST_NONE = -1, DST_PITCH_A, DST_PITCH_B, DST_POS_A, DST_POSY_A, DST_POS_B, DST_POSY_B, DST_LEVEL_A, DST_LEVEL_B, DST_SUB,
    DST_NOISE, DST_CUTOFF, DST_RES, DST_DRIVE, DST_AMP, DST_PAN, DST_LFO1_RATE, DST_LFO2_RATE, DST_LFO3_RATE,
    DST_PAN_A, DST_PAN_B, DST_F_SPREAD, DST_WARP_A, DST_WARP_B
};
inline constexpr int N_DESTS = 23;

inline constexpr double MOD_PITCH_SEMIS = 12;
inline constexpr double MOD_CUTOFF_OCTAVES = 6;
inline constexpr double MOD_LFO_RATE_OCTAVES = 4;

struct ModSlot {
    ModSource src = SRC_NONE;
    ModDest dst = DST_NONE;
    double amt = 0;
};
inline constexpr int MOD_SLOTS = 8;

/** dst (N_DESTS, cleared first) += amt × src for each slot. */
void applyMatrix(const std::array<ModSlot, MOD_SLOTS>& slots, const double* src, double* dst);

/** Triangle-fold a position back into [0, 1] (non-finite → 0). JS `%` semantics. */
inline double reflect01(double p) {
    if (!std::isfinite(p)) return 0;
    double x = std::fmod(std::abs(p), 2.0);
    if (x > 1) x = 2 - x;
    return x;
}

/** LFO waveform at phase 0..1; S&H / smooth random use this (cur) and the previous (prev) cycle's value. */
inline double lfoWave(LfoShape shape, double phase, double cur = 0, double prev = 0) {
    switch (shape) {
        case LfoShape::sine: return std::sin(2 * PI * phase);
        case LfoShape::tri: return phase < 0.25 ? 4 * phase : phase < 0.75 ? 2 - 4 * phase : 4 * phase - 4;
        case LfoShape::saw: return 2 * phase - 1;
        case LfoShape::square: return phase < 0.5 ? 1 : -1;
        case LfoShape::sh: return cur;
        case LfoShape::smooth: {
            const double t = 0.5 - 0.5 * std::cos(PI * phase);
            return prev + (cur - prev) * t;
        }
    }
    return 0;
}

} // namespace mkwavez
