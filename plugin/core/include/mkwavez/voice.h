// Ports of src/core/voice.ts (VoiceParams, modulatedPosition) and src/core/sequence.ts.
#pragma once

#include "constants.h"
#include "playback.h"
#include "synth.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

namespace mkwavez {

/** One monophonic voice (plain data, shared verbatim between model and engine). */
struct VoiceParams {
    int32_t id = 0;
    /** Simple (the original voice) or Synth (core/synth.h; amp ADSR / level / mute / octave apply to both). */
    VoiceType type = VoiceType::simple;
    /** Synth settings (kept, unused, on Simple voices). */
    SynthParams synth{};
    WavetableId wavetableId = 0;
    /** Inclusive X window (slots; unused on Rows) and Y window (rows; 2D and Rows). */
    int32_t windowStart = 0, windowEnd = 0;
    int32_t windowStartY = 0, windowEndY = 0;
    /** Position within the window, 0..1, per axis. */
    double position = 0.5, positionY = 0.5;
    /** Position LFOs: depth 0..1, rate Hz, initial phase (radians). */
    double lfoDepth = 0.5, lfoRate = 0.25;
    double lfoDepthY = 0.5, lfoRateY = 0.17;
    double lfoPhase = 0, lfoPhaseY = 0;
    double octave = 0;
    /** 0..1 */
    double level = 0.8;
    bool mute = false;
    /** ADSR: seconds, seconds, level 0..1, seconds. */
    double attack = 0.004, decay = 0.35, sustain = 0.25, release = 0.2;
};

/**
 * Controller targets (order = CC_PARAMS in src/core/midi.ts). The first five drive every
 * voice; the rest are Synth voice parameters.
 */
enum class CcParam : uint8_t {
    position, positionY, lfoDepth, lfoRate, level, cutoff, resonance, drive, filterEnv, oscMix, subLevel, noiseLevel, glide,
    lfo1Rate, lfo1Depth, lfo2Rate, lfo2Depth, lfo3Rate, lfo3Depth
};
inline constexpr int CC_PARAM_COUNT = 19;

/** Parameter changes (values already mapped from 7-bit, see ccValue), applied as src/core/midi.ts targetPatch does. */
struct VoicePatch {
    uint32_t mask = 0;
    double values[CC_PARAM_COUNT]{};

    void set(CcParam p, double v) {
        mask |= 1u << (unsigned) p;
        values[(size_t) p] = v;
    }
    bool has(CcParam p) const { return (mask >> (unsigned) p) & 1u; }
    double get(CcParam p) const { return values[(size_t) p]; }
    bool empty() const { return mask == 0; }

    void applyTo(VoiceParams& v) const {
        for (int i = 0; i < CC_PARAM_COUNT; ++i) {
            if (!((mask >> i) & 1u)) continue;
            const double x = values[i];
            SynthParams& s = v.synth;
            switch ((CcParam) i) {
                case CcParam::position: v.position = x; break;
                case CcParam::positionY: v.positionY = x; break;
                case CcParam::lfoDepth: v.lfoDepth = x; break;
                case CcParam::lfoRate: v.lfoRate = x; break;
                case CcParam::level: v.level = x; break;
                case CcParam::cutoff: s.cutoff = x; break;
                case CcParam::resonance: s.resonance = x; break;
                case CcParam::drive: s.drive = x; break;
                case CcParam::filterEnv: s.envAmount = x; break;
                case CcParam::oscMix:
                    s.aLevel = 1 - x;
                    s.bLevel = x;
                    break;
                case CcParam::subLevel: s.subLevel = x; break;
                case CcParam::noiseLevel: s.noiseLevel = x; break;
                case CcParam::glide: s.glide = x; break;
                case CcParam::lfo1Rate:
                case CcParam::lfo2Rate:
                case CcParam::lfo3Rate: {
                    // A rate move turns tempo sync off (so the knob is heard).
                    auto& l = s.lfos[(size_t) ((i - (int) CcParam::lfo1Rate) / 2)];
                    l.rate = x;
                    l.sync = false;
                    break;
                }
                case CcParam::lfo1Depth:
                case CcParam::lfo2Depth:
                case CcParam::lfo3Depth: s.lfos[(size_t) ((i - (int) CcParam::lfo1Depth) / 2)].depth = x; break;
            }
        }
    }
};

/** position + depth/2 * sin(lfoPhase), reflected back into [0, 1]. */
inline double modulatedPosition(double position, double depth, double lfoPhase) {
    double p = position + depth * 0.5 * std::sin(lfoPhase);
    p = std::abs(p);
    if (p > 1) p = 2 - p;
    return std::max(0.0, std::min(1.0, p));
}

inline constexpr int REST = -1;

/** Note value of one sequencer step (order = STEP_LENGTHS in src/core/sequence.ts). */
enum class StepLength : uint8_t { quarter, eighth, sixteenth, eighthTriplet, sixteenthTriplet };
inline constexpr int STEP_LENGTH_COUNT = 5;
/** Shared clock resolution: ticks per quarter note (every step length divides a bar). */
inline constexpr int TICKS_PER_BEAT = 12;
inline constexpr int TICKS_PER_EIGHTH = TICKS_PER_BEAT / 2;
/** Clock ticks per step: 12, 6, 3, 4, 2. */
inline constexpr std::array<int, STEP_LENGTH_COUNT> STEP_TICKS{12, 6, 3, 4, 2};
/** Step length in quarter notes (straight values are powers of two: bit-identical eighths). */
inline constexpr std::array<double, STEP_LENGTH_COUNT> STEP_BEATS{1, 0.5, 0.25, 1.0 / 3, 1.0 / 6};

/** A step sequence targeting one voice. Steps are `stepLength` notes on the shared clock. */
struct SequenceData {
    int32_t id = 0;
    /** Target voice id, or -1 (silent). */
    int32_t voiceId = -1;
    /** Active steps, 1..MAX_STEPS. */
    int32_t length = 16;
    /** Scale row 0..SCALE_ROWS-1, or REST. */
    std::array<int8_t, MAX_STEPS> steps = [] {
        std::array<int8_t, MAX_STEPS> s{};
        s.fill((int8_t) REST);
        return s;
    }();
    /** Gate length as a fraction of a step. */
    double gate = 0.5;
    StepLength stepLength = StepLength::eighth;
};

inline double noteFreq(int row, double octave) {
    return SCALE_ROOT_HZ * std::pow(2.0, SCALE_SEMITONES[(size_t) row] / 12.0 + octave);
}

/** Samples per sequencer step at `bpm` (quarter-note beats). */
inline double stepSamples(double bpm, double sampleRate, StepLength len = StepLength::eighth) {
    return ((sampleRate * 60) / bpm) * STEP_BEATS[(size_t) len];
}

} // namespace mkwavez
