// Host-automatable parameters: per voice slot (V1..V4 = voice ids 1..4) the playable voice
// params, plus global sequencer / MIDI / output settings.
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

/** "v1_position", … */
juce::String voiceId(int slot, VoiceField f);
juce::String voiceLabel(VoiceField f);

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
    std::atomic<float>* play = nullptr;
    std::atomic<float>* hostSync = nullptr;
    std::atomic<float>* bpm = nullptr;
    std::atomic<float>* omni = nullptr;
    std::atomic<float>* midiVoice = nullptr;
    std::atomic<float>* gain = nullptr;

    explicit Pointers(juce::AudioProcessorValueTreeState& s);
};

/** Overwrite the parameter-driven fields of a voice from slot values. */
void applyVoiceFields(mkwavez::VoiceParams& v, const std::array<float, VOICE_FIELD_COUNT>& values);

} // namespace params
