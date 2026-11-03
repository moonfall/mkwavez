#include "Parameters.h"

#include "mkwavez/midi.h"

namespace params {

namespace {

const char* const fieldIds[VOICE_FIELD_COUNT] = {
    "position", "positionY", "lfoDepth", "lfoRate", "lfoDepthY", "lfoRateY", "octave", "level", "mute",
    "attack", "decay", "sustain", "release"};

const char* const fieldLabels[VOICE_FIELD_COUNT] = {
    "Position X", "Position Y", "LFO depth X", "LFO rate X", "LFO depth Y", "LFO rate Y", "Octave", "Level", "Mute",
    "Attack", "Decay", "Sustain", "Release"};

/** Start values per slot, as the web app's start state (src/main.ts); V4 is extra (muted). */
struct SlotDefaults {
    float position, lfoDepth, lfoRate, octave;
    bool mute;
};
constexpr SlotDefaults slotDefaults[VOICE_SLOTS] = {
    {0.3f, 0.6f, 0.25f, 0, false},
    {0.75f, 0.3f, 0.11f, 1, true},
    {0.5f, 0.9f, 1.2f, -1, true},
    {0.5f, 0.5f, 0.25f, 0, true},
};

/** Exponential mapping (rates, times): skew so the slider centre is the geometric mean. */
juce::NormalisableRange<float> expRange(float lo, float hi) {
    return {lo, hi,
            [](float a, float b, float t) { return a * std::pow(b / a, t); },
            [](float a, float b, float v) { return std::log(v / a) / std::log(b / a); },
            [](float, float, float v) { return v; }};
}

juce::String seconds(float v, int) { return v < 1 ? juce::String(juce::roundToInt(v * 1000)) + " ms" : juce::String(v, 2) + " s"; }
juce::String hz(float v, int) { return juce::String(v, v < 1 ? 3 : 2) + " Hz"; }
juce::String pct(float v, int) { return juce::String(juce::roundToInt(v * 100)) + "%"; }

} // namespace

juce::String voiceId(int slot, VoiceField f) { return "v" + juce::String(slot + 1) + "_" + fieldIds[f]; }
juce::String voiceLabel(VoiceField f) { return fieldLabels[f]; }

juce::AudioProcessorValueTreeState::ParameterLayout createLayout() {
    using namespace juce;
    AudioProcessorValueTreeState::ParameterLayout layout;
    const mkwavez::VoiceParams d; // engine defaults for the remaining fields

    auto group = std::make_unique<AudioProcessorParameterGroup>("global", "Global", " | ");
    group->addChild(std::make_unique<AudioParameterBool>(ParameterID{play, 1}, "Play", false));
    group->addChild(std::make_unique<AudioParameterBool>(ParameterID{hostSync, 1}, "Host sync", true));
    group->addChild(std::make_unique<AudioParameterFloat>(ParameterID{bpm, 1}, "BPM", NormalisableRange<float>(20, 400, 0.1f), 132.0f));
    group->addChild(std::make_unique<AudioParameterBool>(ParameterID{omni, 1}, "MIDI omni", true));
    group->addChild(std::make_unique<AudioParameterInt>(ParameterID{midiVoice, 1}, "MIDI voice", 1, VOICE_SLOTS, 1));
    group->addChild(std::make_unique<AudioParameterFloat>(ParameterID{gain, 1}, "Output gain", NormalisableRange<float>(-36, 12, 0.1f), 0.0f,
                                                          AudioParameterFloatAttributes().withLabel("dB")));
    layout.add(std::move(group));

    for (int s = 0; s < VOICE_SLOTS; ++s) {
        const SlotDefaults& sd = slotDefaults[s];
        const String name = "V" + String(s + 1);
        auto g = std::make_unique<AudioProcessorParameterGroup>(name, name, " ");
        auto id = [&](VoiceField f) { return ParameterID{voiceId(s, f), 1}; };
        auto lbl = [&](VoiceField f) { return name + " " + fieldLabels[f]; };
        auto unit = [&](VoiceField f, float def) {
            return std::make_unique<AudioParameterFloat>(id(f), lbl(f), NormalisableRange<float>(0, 1), def,
                                                         AudioParameterFloatAttributes().withStringFromValueFunction(pct));
        };
        auto rate = [&](VoiceField f, float def) {
            return std::make_unique<AudioParameterFloat>(id(f), lbl(f), expRange((float) mkwavez::LFO_RATE_MIN, (float) mkwavez::LFO_RATE_MAX), def,
                                                         AudioParameterFloatAttributes().withStringFromValueFunction(hz));
        };
        auto time = [&](VoiceField f, float lo, float hi, double def) {
            return std::make_unique<AudioParameterFloat>(id(f), lbl(f), expRange(lo, hi), (float) def,
                                                         AudioParameterFloatAttributes().withStringFromValueFunction(seconds));
        };
        g->addChild(unit(position, sd.position));
        g->addChild(unit(positionY, (float) d.positionY));
        g->addChild(unit(lfoDepth, sd.lfoDepth));
        g->addChild(rate(lfoRate, sd.lfoRate));
        g->addChild(unit(lfoDepthY, (float) d.lfoDepthY));
        g->addChild(rate(lfoRateY, (float) d.lfoRateY));
        g->addChild(std::make_unique<AudioParameterInt>(id(octave), lbl(octave), -3, 3, (int) sd.octave));
        g->addChild(unit(level, (float) d.level));
        g->addChild(std::make_unique<AudioParameterBool>(id(mute), lbl(mute), sd.mute));
        g->addChild(time(attack, 0.001f, 2, d.attack));
        g->addChild(time(decay, 0.005f, 4, d.decay));
        g->addChild(unit(sustain, (float) d.sustain));
        g->addChild(time(release, 0.005f, 4, d.release));
        layout.add(std::move(g));
    }
    return layout;
}

Pointers::Pointers(juce::AudioProcessorValueTreeState& s) {
    for (int slot = 0; slot < VOICE_SLOTS; ++slot)
        for (int f = 0; f < VOICE_FIELD_COUNT; ++f) voice[(size_t) slot][(size_t) f] = s.getRawParameterValue(voiceId(slot, (VoiceField) f));
    play = s.getRawParameterValue(params::play);
    hostSync = s.getRawParameterValue(params::hostSync);
    bpm = s.getRawParameterValue(params::bpm);
    omni = s.getRawParameterValue(params::omni);
    midiVoice = s.getRawParameterValue(params::midiVoice);
    gain = s.getRawParameterValue(params::gain);
}

void applyVoiceFields(mkwavez::VoiceParams& v, const std::array<float, VOICE_FIELD_COUNT>& x) {
    v.position = x[position];
    v.positionY = x[positionY];
    v.lfoDepth = x[lfoDepth];
    v.lfoRate = x[lfoRate];
    v.lfoDepthY = x[lfoDepthY];
    v.lfoRateY = x[lfoRateY];
    v.octave = x[octave];
    v.level = x[level];
    v.mute = x[mute] >= 0.5f;
    v.attack = x[attack];
    v.decay = x[decay];
    v.sustain = x[sustain];
    v.release = x[release];
}

} // namespace params
