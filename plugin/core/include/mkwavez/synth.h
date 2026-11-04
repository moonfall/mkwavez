// Port of src/core/synth.ts: Synth voice parameters (plain data) and their defaults.
#pragma once

#include "modulation.h"

#include <array>
#include <cstdint>

namespace mkwavez {

enum class VoiceType : uint8_t { simple, synth };
/** Order = FILTER_MODES in TS (also the SVF mode index). */
enum class FilterMode : uint8_t { lp12, lp24, hp, bp, notch };
enum class SubWave : uint8_t { sine, square };
enum class NoiseType : uint8_t { white, pink };
enum class PitchTarget : uint8_t { a, b, ab };
/** Order = WARP_MODES in TS. */
enum class WarpMode : uint8_t { none, sync, formant, bend, squeeze, quantize, fold };
/** Sync / formant warp at amount ±1: the cycle is read this many times per period. */
inline constexpr double WARP_SYNC_MAX = 8;

inline constexpr int MAX_UNISON = 8;
/** Oscillator phase at a note (order = PHASE_MODES in TS). */
enum class PhaseMode : uint8_t { free, reset, random };
/** Most notes one Synth voice plays at once. */
inline constexpr int MAX_POLY = 8;
inline constexpr double FM_DEPTH = 1.5;
inline constexpr double FILTER_ENV_OCTAVES = 6;
inline constexpr double FILTER_VEL_OCTAVES = 4;
inline constexpr double FILTER_SPREAD_OCTAVES = 2;
inline constexpr double CUTOFF_MIN = 20;
inline constexpr double CUTOFF_MAX = 20000;

/** Where an oscillator reads: wavetable, inclusive X / Y window, positions. */
struct OscSource {
    int32_t wavetableId = 0;
    int32_t windowStart = 0, windowEnd = 0, windowStartY = 0, windowEndY = 0;
    double position = 0.5, positionY = 0.5;
};

/** Defaults = DEFAULT_SYNTH (the Init patch). */
struct SynthParams {
    double aOct = 0, aCoarse = 0, aFine = 0, aLevel = 0.8;
    OscSource b{};
    double bOct = 0, bCoarse = 0, bFine = 7, bLevel = 0;
    SubWave subWave = SubWave::sine;
    double subOct = 1, subLevel = 0;
    NoiseType noiseType = NoiseType::white;
    double noiseLevel = 0;
    double ringLevel = 0;
    FilterMode filterMode = FilterMode::lp24;
    double cutoff = 2400, resonance = 0.15, drive = 0, keyTrack = 0.5, envAmount = 0.3, velAmount = 0.3;
    double fAttack = 0.004, fDecay = 0.45, fSustain = 0.35, fRelease = 0.3;
    double pAttack = 0.001, pDecay = 0.08, pAmount = 0;
    PitchTarget pTarget = PitchTarget::ab;
    double velAmp = 0.7;
    double glide = 0;
    bool glideLegato = true;
    double bendRange = 2;
    double pan = 0;
    std::array<LfoParams, LFO_COUNT> lfos = [] {
        std::array<LfoParams, LFO_COUNT> l{};
        l[0].rate = 0.25;
        l[1].rate = 5;
        l[1].fade = 0.4;
        l[2].shape = LfoShape::sh;
        l[2].sync = true;
        l[2].div = 10; // 1/8
        return l;
    }();
    double mAttack = 0.01, mDecay = 0.6, mSustain = 0, mRelease = 0.3;
    ModEnvMode mMode = ModEnvMode::ad;
    std::array<ModSlot, MOD_SLOTS> mods = [] {
        std::array<ModSlot, MOD_SLOTS> m{};
        m[0] = {SRC_LFO1, DST_POS_A, 0.3};
        return m;
    }();
    bool sync = false;
    double fm = 0;
    int aUnison = 1;
    double aDetune = 12, aSpread = 0.6;
    int bUnison = 1;
    double bDetune = 12, bSpread = 0.6;
    double sat = 0;
    double width = 1;
    /** Stereo: oscillator pans, stereo phase (cycles), stereo position, noise width, filter spread. */
    double aPan = 0, bPan = 0;
    double aPhaseSpread = 0, bPhaseSpread = 0;
    double aPosSpread = 0, bPosSpread = 0;
    double noiseWidth = 0;
    double filterSpread = 0;
    /** Polyphony 1..MAX_POLY (1 = monophonic). Saved data without it is monophonic. */
    int poly = 8;
    /** Oscillator warps and their amounts −1..1. */
    WarpMode aWarp = WarpMode::none;
    double aWarpAmt = 0;
    WarpMode bWarp = WarpMode::none;
    double bWarpAmt = 0;
    /** Macros 0..1 (matrix sources Macro 1–4). */
    double macro1 = 0, macro2 = 0, macro3 = 0, macro4 = 0;
    PhaseMode phaseMode = PhaseMode::free;
};

/** Semitone offset of an oscillator's tuning. */
inline double oscSemis(double oct, double coarse, double fine) { return oct * 12 + coarse + fine / 100; }

} // namespace mkwavez
