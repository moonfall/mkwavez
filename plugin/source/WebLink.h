// The native end of the web UI protocol (see src/plugin/host.ts and src/audio/nativePort.ts):
// decodes the page's messages into document edits, parameter and MIDI-routing changes,
// and produces what the page should hear back (init + saved tables, status, host
// transport, parameter automation, controller moves). No WebView code here, so it can be
// driven by tests; WebEditor connects it to a WebBrowserComponent.
#pragma once

#include "PluginProcessor.h"

#include <juce_core/juce_core.h>

#include <functional>

class WebLink {
public:
    using Emit = std::function<void(const juce::var&)>;

    explicit WebLink(MkwavezProcessor& p);

    /** One message from the page (message thread). Replies go to `emit`. */
    void handle(const juce::var& message, const Emit& emit);
    /** Periodic (≈30 Hz): status, host transport / automation changes, controller moves. */
    void poll(const Emit& emit);

    /** Native file dialogs (set by the editor): save `data` as `name`; open a file for request `id`. */
    std::function<void(const juce::String& name, const juce::MemoryBlock& data)> onSaveFile;
    std::function<void(int id, const juce::String& accept)> onOpenFile;

    /** Messages handled / session commits received (diagnostics / tests). */
    int handled() const { return handledCount; }
    int commitsReceived() const { return commitCount; }
    /** Tables the page sent (tables/addData items). */
    int tablesReceived() const { return tablesIn; }
    /** Whether the page has said hello since the last state load. */
    bool connected() const { return helloGen == proc.stateGeneration(); }

private:
    void sendInit(const Emit& emit);
    void applyBatch(const juce::var& ops);
    void setVoiceParams(const mkwavez::VoiceParams& v);
    void setParam(const juce::String& id, float value);
    juce::var transportMessage(bool playing, double bpm) const;

    MkwavezProcessor& proc;
    int handledCount = 0;
    int commitCount = 0;
    int tablesIn = 0;
    int helloGen = -1;
    /** What the page last heard (or said) per voice slot field / transport, to send only changes. */
    std::array<std::array<float, params::VOICE_FIELD_COUNT>, params::VOICE_SLOTS> sentVoice{};
    bool sentPlaying = false;
    double sentBpm = 0;
};
