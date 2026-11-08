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

const char* const synthIds[SYNTH_FIELD_COUNT] = {
    "macro1", "macro2", "macro3", "macro4", "cutoff", "resonance", "envAmount", "drive", "aLevel", "bLevel", "aWarpAmt", "bWarpAmt", "fm", "pan", "width", "glide"};

const char* const synthLabels[SYNTH_FIELD_COUNT] = {
    "Macro 1", "Macro 2", "Macro 3", "Macro 4", "Cutoff", "Resonance", "Filter env", "Drive", "Osc A level", "Osc B level", "Osc A warp", "Osc B warp",
    "FM B to A", "Pan", "Width", "Glide"};

/**
 * Start values per slot. V1 is the plugin's start voice (src/app/defaultSession.ts
 * pluginSessionState: a Synth voice, hence the Synth amp envelope); V2–V4 are as the
 * browser's start state and only apply once the page adds those voices.
 */
struct SlotDefaults {
    float position, lfoDepth, lfoRate, octave;
    bool mute, synth;
};
constexpr SlotDefaults slotDefaults[VOICE_SLOTS] = {
    {0.3f, 0.6f, 0.25f, 0, false, true},
    {0.75f, 0.3f, 0.11f, 1, true, false},
    {0.5f, 0.9f, 1.2f, -1, true, false},
    {0.5f, 0.5f, 0.25f, 0, true, false},
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

const char* fieldKey(VoiceField f) { return fieldIds[f]; }

double fieldValue(const mkwavez::VoiceParams& v, VoiceField f) {
    switch (f) {
        case position: return v.position;
        case positionY: return v.positionY;
        case lfoDepth: return v.lfoDepth;
        case lfoRate: return v.lfoRate;
        case lfoDepthY: return v.lfoDepthY;
        case lfoRateY: return v.lfoRateY;
        case octave: return v.octave;
        case level: return v.level;
        case mute: return v.mute ? 1.0 : 0.0;
        case attack: return v.attack;
        case decay: return v.decay;
        case sustain: return v.sustain;
        case release: return v.release;
        case VOICE_FIELD_COUNT: break;
    }
    return 0;
}

juce::String voiceId(int slot, VoiceField f) { return "v" + juce::String(slot + 1) + "_" + fieldIds[f]; }
juce::String synthId(int slot, SynthField f) { return "v" + juce::String(slot + 1) + "_" + synthIds[f]; }

const char* synthKey(SynthField f) { return synthIds[f]; }

double synthValue(const mkwavez::SynthParams& s, SynthField f) {
    switch (f) {
        case macro1: return s.macro1;
        case macro2: return s.macro2;
        case macro3: return s.macro3;
        case macro4: return s.macro4;
        case cutoff: return s.cutoff;
        case resonance: return s.resonance;
        case envAmount: return s.envAmount;
        case drive: return s.drive;
        case aLevel: return s.aLevel;
        case bLevel: return s.bLevel;
        case aWarpAmt: return s.aWarpAmt;
        case bWarpAmt: return s.bWarpAmt;
        case fm: return s.fm;
        case pan: return s.pan;
        case width: return s.width;
        case glide: return s.glide;
        case SYNTH_FIELD_COUNT: break;
    }
    return 0;
}

void applySynthFields(mkwavez::SynthParams& s, const std::array<float, SYNTH_FIELD_COUNT>& x) {
    s.macro1 = x[macro1];
    s.macro2 = x[macro2];
    s.macro3 = x[macro3];
    s.macro4 = x[macro4];
    s.cutoff = x[cutoff];
    s.resonance = x[resonance];
    s.envAmount = x[envAmount];
    s.drive = x[drive];
    s.aLevel = x[aLevel];
    s.bLevel = x[bLevel];
    s.aWarpAmt = x[aWarpAmt];
    s.bWarpAmt = x[bWarpAmt];
    s.fm = x[fm];
    s.pan = x[pan];
    s.width = x[width];
    s.glide = x[glide];
}
juce::String voiceLabel(VoiceField f) { return fieldLabels[f]; }

juce::AudioProcessorValueTreeState::ParameterLayout createLayout() {
    using namespace juce;
    AudioProcessorValueTreeState::ParameterLayout layout;
    const mkwavez::VoiceParams d; // engine defaults for the remaining fields

    auto group = std::make_unique<AudioProcessorParameterGroup>("global", "Global", " | ");
    group->addChild(std::make_unique<AudioParameterBool>(ParameterID{play, 1}, "Play", false));
    group->addChild(std::make_unique<AudioParameterBool>(ParameterID{hostSync, 1}, "Host sync", true));
    // Off by default: in a DAW the voices play the host's MIDI, and the internal sequences
    // run only from the page's Play (projects saved before this follow their Host sync).
    group->addChild(std::make_unique<AudioParameterBool>(ParameterID{seqFollow, 1}, "Sequencer follows host", false));
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
        const auto& amp = mkwavez::SYNTH_AMP_DEFAULTS;
        g->addChild(time(attack, 0.001f, 2, sd.synth ? amp.attack : d.attack));
        g->addChild(time(decay, 0.005f, 4, sd.synth ? amp.decay : d.decay));
        g->addChild(unit(sustain, (float) (sd.synth ? amp.sustain : d.sustain)));
        g->addChild(time(release, 0.005f, 4, sd.synth ? amp.release : d.release));
        // Synth voice params (the synth block; a Simple voice keeps them for when it becomes Synth).
        const mkwavez::SynthParams ds;
        auto sid = [&](SynthField f) { return ParameterID{synthId(s, f), 1}; };
        auto slbl = [&](SynthField f) { return name + " " + synthLabels[f]; };
        auto lin = [&](SynthField f, float lo, float hi, double def, juce::String (*fmt)(float, int)) {
            return std::make_unique<AudioParameterFloat>(sid(f), slbl(f), NormalisableRange<float>(lo, hi), (float) def,
                                                         AudioParameterFloatAttributes().withStringFromValueFunction(fmt));
        };
        g->addChild(lin(macro1, 0, 1, ds.macro1, pct));
        g->addChild(lin(macro2, 0, 1, ds.macro2, pct));
        g->addChild(lin(macro3, 0, 1, ds.macro3, pct));
        g->addChild(lin(macro4, 0, 1, ds.macro4, pct));
        g->addChild(std::make_unique<AudioParameterFloat>(sid(cutoff), slbl(cutoff), expRange((float) mkwavez::CUTOFF_MIN, (float) mkwavez::CUTOFF_MAX),
                                                          (float) ds.cutoff, AudioParameterFloatAttributes().withStringFromValueFunction(hz)));
        g->addChild(lin(resonance, 0, 1, ds.resonance, pct));
        g->addChild(lin(envAmount, -1, 1, ds.envAmount, pct));
        g->addChild(lin(drive, 0, 1, ds.drive, pct));
        g->addChild(lin(aLevel, 0, 1, ds.aLevel, pct));
        g->addChild(lin(bLevel, 0, 1, ds.bLevel, pct));
        g->addChild(lin(aWarpAmt, -1, 1, ds.aWarpAmt, pct));
        g->addChild(lin(bWarpAmt, -1, 1, ds.bWarpAmt, pct));
        g->addChild(lin(fm, 0, 1, ds.fm, pct));
        g->addChild(lin(pan, -1, 1, ds.pan, pct));
        g->addChild(lin(width, 0, 2, ds.width, pct));
        g->addChild(std::make_unique<AudioParameterFloat>(sid(glide), slbl(glide), NormalisableRange<float>(0, 5, 0, 0.35f), (float) ds.glide,
                                                          AudioParameterFloatAttributes().withStringFromValueFunction(seconds)));
        layout.add(std::move(g));
    }
    return layout;
}

Pointers::Pointers(juce::AudioProcessorValueTreeState& s) {
    for (int slot = 0; slot < VOICE_SLOTS; ++slot)
        for (int f = 0; f < VOICE_FIELD_COUNT; ++f) voice[(size_t) slot][(size_t) f] = s.getRawParameterValue(voiceId(slot, (VoiceField) f));
    for (int slot = 0; slot < VOICE_SLOTS; ++slot)
        for (int f = 0; f < SYNTH_FIELD_COUNT; ++f) synth[(size_t) slot][(size_t) f] = s.getRawParameterValue(synthId(slot, (SynthField) f));
    play = s.getRawParameterValue(params::play);
    hostSync = s.getRawParameterValue(params::hostSync);
    seqFollow = s.getRawParameterValue(params::seqFollow);
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
