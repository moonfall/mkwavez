// The editor: the web app (Generate / Timeline / Wavetables / Voice / Sequence — the same
// UI as the browser build) in an embedded system web view (WebView2 / WKWebView /
// WebKitGTK), served from the plugin binary. No external browser, no network.
// Set MKWAVEZ_WEB_DEV_URL (e.g. http://localhost:5173) to load a Vite dev server instead.
#pragma once

#include "PluginProcessor.h"
#include "WebLink.h"

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_extra/juce_gui_extra.h>

class WebEditor final : public juce::AudioProcessorEditor, private juce::Timer {
public:
    explicit WebEditor(MkwavezProcessor&);
    ~WebEditor() override;

    void paint(juce::Graphics&) override;
    void resized() override;

    /** For tests: the protocol end (handled message count, connected). */
    const WebLink& link() const { return webLink; }
    /** For tests: run a script in the page. */
    void evaluate(const juce::String& script, juce::WebBrowserComponent::EvaluationCallback cb = nullptr) {
        browser->evaluateJavascript(script, std::move(cb));
    }

private:
    void timerCallback() override;
    void load();
    void emit(const juce::var& message);
    void saveFile(const juce::String& name, const juce::MemoryBlock& data);
    void openFile(int id, const juce::String& accept);

    MkwavezProcessor& proc;
    WebLink webLink;
    std::unique_ptr<juce::WebBrowserComponent> browser;
    std::unique_ptr<juce::FileChooser> chooser;
    int generation;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(WebEditor)
};

/** The built web app (dist/, zipped into the binary), by URL path ("/" = index.html). */
std::optional<juce::WebBrowserComponent::Resource> webResource(const juce::String& path);
