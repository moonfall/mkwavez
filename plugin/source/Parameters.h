// Host-automatable parameters: per voice slot (V1..V4 = voice ids 1..4) the playable voice
// params and the main Synth voice params (the four macros first), plus global sequencer /
// MIDI / output settings.
#pragma once

#include "mkwavez/voice.h"

#include <juce_audio_processors/juce_audio_processors.h>

#include <array>
#include <atomic>

namespace params {

inline constexpr int VOICE_SLOTS = 4;

enum VoiceField {
    position, positionY, lfoDepth, lfoRate, lfoDepthY, lfoRateY, octave, level, mute, attack, decay, sustain, release,
    VOICE_FIELD_COUNT
};

/** Synth voice params exposed to the host (the voice's synth block; order = SYNTH_FIELDS in src/plugin/host.ts). */
enum SynthField {
    macro1, macro2, macro3, macro4, cutoff, resonance, envAmount, drive, aLevel, bLevel, aWarpAmt, bWarpAmt, fm, pan, width, glide,
    SYNTH_FIELD_COUNT
};

/** "v1_position", … */
juce::String voiceId(int slot, VoiceField f);
juce::String voiceLabel(VoiceField f);
/** "v1_macro1", "v1_cutoff", … */
juce::String synthId(int slot, SynthField f);

// Global parameter ids.
inline const juce::String play = "play";          // run the sequencer (standalone / without host transport)
inline const juce::String hostSync = "hostSync";  // follow the host's play state and tempo
inline const juce::String bpm = "bpm";            // tempo when not synced (or the host has none)
inline const juce::String omni = "omni";          // MIDI: every channel → midiVoice; off: channel N → voice N
inline const juce::String midiVoice = "midiVoice";// 1..VOICE_SLOTS
inline const juce::String gain = "gain";          // output gain, dB

juce::AudioProcessorValueTreeState::ParameterLayout createLayout();

/** Raw value pointers for the audio thread. */
struct Pointers {
    std::array<std::array<std::atomic<float>*, VOICE_FIELD_COUNT>, VOICE_SLOTS> voice{};
    std::array<std::array<std::atomic<float>*, SYNTH_FIELD_COUNT>, VOICE_SLOTS> synth{};
    std::atomic<float>* play = nullptr;
    std::atomic<float>* hostSync = nullptr;
    std::atomic<float>* bpm = nullptr;
    std::atomic<float>* omni = nullptr;
    std::atomic<float>* midiVoice = nullptr;
    std::atomic<float>* gain = nullptr;

    explicit Pointers(juce::AudioProcessorValueTreeState& s);
};

/** The VoiceParams / JSON key of a field ("position", …; same names as the TS VoiceParams). */
const char* fieldKey(VoiceField f);
/** A voice's value for a field (mute: 0 / 1). */
double fieldValue(const mkwavez::VoiceParams& v, VoiceField f);

/** Overwrite the parameter-driven fields of a voice from slot values. */
void applyVoiceFields(mkwavez::VoiceParams& v, const std::array<float, VOICE_FIELD_COUNT>& values);

/** The SynthParams / JSON key of a synth field ("macro1", "cutoff", …). */
const char* synthKey(SynthField f);
double synthValue(const mkwavez::SynthParams& s, SynthField f);
/** Overwrite the parameter-driven synth fields from slot values. */
void applySynthFields(mkwavez::SynthParams& s, const std::array<float, SYNTH_FIELD_COUNT>& values);

} // namespace params
