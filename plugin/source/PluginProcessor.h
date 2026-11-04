#pragma once

#include "EngineHost.h"
#include "Parameters.h"

#include "mkwavez/spsc_queue.h"

#include <map>

#include <juce_audio_processors/juce_audio_processors.h>

#include <array>
#include <atomic>

/** What the editor shows of the audio thread (written per block, read at frame rate). */
struct LiveStatus {
    struct Voice {
        std::atomic<int> id{0};
        std::atomic<float> pos{0}, posY{0}, index{0}, y{0}, env{0};
        std::atomic<int> note{-1};
    };
    /** Sequencer clock tick (see SynthEngine; -1 before the first). */
    std::atomic<int64_t> tick{-1};
    std::atomic<bool> playing{false};
    std::atomic<int> voiceCount{0};
    std::array<Voice, mkwavez::EngineStatus::MAX> voices;
    /** Effective transport (host or Play / BPM), as the engine runs it. */
    std::atomic<bool> transportPlaying{false};
    std::atomic<double> transportBpm{132};
    std::atomic<double> sampleRate{48000};
};

/** MIDI routing the web UI sets (it owns those settings; see plugin/host.ts). Read on the audio thread. */
struct WebMidiSettings {
    std::atomic<bool> enabled{true};
    /** Voice Omni plays (the selected tab), or -1 = the `midiVoice` parameter. */
    std::atomic<int> omniVoice{-1};
    /** MPE: channels 2–16 carry per-note bend / pressure / slide. */
    std::atomic<bool> mpe{false};
    std::array<std::atomic<int>, mkwavez::CC_PARAM_COUNT> cc{};
    WebMidiSettings() {
        const mkwavez::CcMap d;
        for (size_t i = 0; i < cc.size(); ++i) cc[i] = d.cc[i];
    }
};

/** A raw 3-byte controller message (forwarded to the web UI for learn and its sliders). */
using CcMessage = std::array<uint8_t, 3>;

class MkwavezProcessor final : public juce::AudioProcessor, private juce::Timer {
public:
    MkwavezProcessor();
    ~MkwavezProcessor() override;

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    using AudioProcessor::processBlock;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return JucePlugin_Name; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 4.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    juce::AudioProcessorValueTreeState& parameters() { return apvts; }
    mkwavez::EngineHost& host() { return engineHost; }
    const LiveStatus& liveStatus() const { return status; }

    /** Reset the project to the start state (keeps parameter values). */
    void resetDocument();

    // ---- web UI support (message thread) ----
    WebMidiSettings& webMidi() { return midiSettings; }
    mkwavez::SpscQueue<CcMessage>& ccMessages() { return ccQueue; }
    /**
     * The web UI's saved session (src/core/session.ts: meta JSON + waveform records as JSON,
     * keyed by id), written by its autosave through WebLink and saved with the plugin state.
     */
    struct Session {
        juce::String meta;
        std::map<int, juce::String> records;
        /** Plugin-only page settings (MIDI routing), JSON. */
        juce::String settings;
    };
    template <typename Fn>
    auto withSession(Fn&& fn) {
        const juce::ScopedLock lock(sessionLock);
        return fn(session);
    }
    /** Bumped whenever the host loads a state (an open web UI must reload). */
    int stateGeneration() const { return stateGen.load(); }

private:
    void timerCallback() override;
    void applyParameters(mkwavez::SynthEngine& e, bool force);
    void applyTransport(mkwavez::SynthEngine& e);
    void handleMidi(mkwavez::SynthEngine& e, const juce::MidiMessage& m);
    void publishStatus(const mkwavez::SynthEngine& e);

    juce::AudioProcessorValueTreeState apvts;
    params::Pointers ptr;
    mkwavez::EngineHost engineHost;
    mkwavez::MidiRouter router;
    mkwavez::MidiRouting routing;
    mkwavez::CcMap ccMap;
    LiveStatus status;
    WebMidiSettings midiSettings;
    mkwavez::SpscQueue<CcMessage> ccQueue{1024};
    juce::CriticalSection sessionLock;
    Session session;
    std::atomic<int> stateGen{0};

    // Audio-thread caches.
    std::array<std::array<float, params::VOICE_FIELD_COUNT>, params::VOICE_SLOTS> lastVoice{};
    std::array<std::array<float, params::SYNTH_FIELD_COUNT>, params::VOICE_SLOTS> lastSynth{};
    bool lastPlaying = false;
    double lastBpm = 0;
    juce::SmoothedValue<float> outGain{1.0f};
    mkwavez::EngineStatus scratchStatus;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MkwavezProcessor)
};
