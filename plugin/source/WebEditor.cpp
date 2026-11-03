#include "WebEditor.h"

#include "Theme.h"

#include <BinaryData.h>

namespace {

const juce::Identifier EVENT{"mkwavez"};

const char* mimeFor(const juce::String& path) {
    const auto ext = path.fromLastOccurrenceOf(".", false, false).toLowerCase();
    if (ext == "html") return "text/html";
    if (ext == "js" || ext == "mjs") return "text/javascript";
    if (ext == "css") return "text/css";
    if (ext == "json") return "application/json";
    if (ext == "svg") return "image/svg+xml";
    if (ext == "png") return "image/png";
    if (ext == "woff2") return "font/woff2";
    if (ext == "wasm") return "application/wasm";
    return "application/octet-stream";
}

juce::ZipFile& webZip() {
    static juce::MemoryInputStream stream(MkwavezWeb::web_zip, (size_t) MkwavezWeb::web_zipSize, false);
    static juce::ZipFile zip(stream);
    return zip;
}

juce::String devUrl() { return juce::SystemStats::getEnvironmentVariable("MKWAVEZ_WEB_DEV_URL", {}); }

} // namespace

std::optional<juce::WebBrowserComponent::Resource> webResource(const juce::String& rawPath) {
    auto path = rawPath.upToFirstOccurrenceOf("?", false, false).upToFirstOccurrenceOf("#", false, false).trimCharactersAtStart("/");
    if (path.isEmpty()) path = "index.html";
    static juce::CriticalSection lock;
    const juce::ScopedLock sl(lock);
    auto& zip = webZip();
    const int index = zip.getIndexOfFileName(path);
    if (index < 0) return std::nullopt;
    std::unique_ptr<juce::InputStream> in(zip.createStreamForEntry(index));
    if (!in) return std::nullopt;
    juce::MemoryBlock block;
    in->readIntoMemoryBlock(block);
    std::vector<std::byte> data(block.getSize());
    std::memcpy(data.data(), block.getData(), block.getSize());
    return juce::WebBrowserComponent::Resource{std::move(data), mimeFor(path)};
}

WebEditor::WebEditor(MkwavezProcessor& p) : AudioProcessorEditor(&p), proc(p), webLink(p), generation(p.stateGeneration()) {
    auto options = juce::WebBrowserComponent::Options{}
                       .withBackend(juce::WebBrowserComponent::Options::Backend::webview2)
                       .withWinWebView2Options(juce::WebBrowserComponent::Options::WinWebView2{}
                                                   .withUserDataFolder(juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("mkwavez-webview"))
                                                   .withBackgroundColour(theme::bg))
                       .withNativeIntegrationEnabled()
                       .withKeepPageLoadedWhenBrowserIsHidden()
                       .withEventListener(EVENT, [this](const juce::var& m) { webLink.handle(m, [this](const juce::var& r) { emit(r); }); })
                       .withResourceProvider([](const juce::String& path) { return webResource(path); });
    browser = std::make_unique<juce::WebBrowserComponent>(options);
    addAndMakeVisible(*browser);
    load();

    setResizable(true, true);
    setResizeLimits(640, 480, 2880, 1800);
    setSize(1200, 780);
    startTimerHz(30);
}

WebEditor::~WebEditor() { stopTimer(); }

void WebEditor::load() {
    const auto dev = devUrl();
    browser->goToURL(dev.isNotEmpty() ? dev : juce::WebBrowserComponent::getResourceProviderRoot());
}

void WebEditor::emit(const juce::var& message) {
    static const bool trace = juce::SystemStats::getEnvironmentVariable("MKWAVEZ_WEB_DEBUG", {}) == "2";
    if (trace && message.getProperty("type", {}).toString() != "status")
        std::fprintf(stderr, "[mkwavez web] -> %s (showing %d)\n", juce::JSON::toString(message, true).substring(0, 200).toRawUTF8(), (int) browser->isShowing());
    browser->emitEventIfBrowserIsVisible(EVENT, message);
}

void WebEditor::timerCallback() {
    // The host loaded another state (preset, session): the page restarts from it.
    if (generation != proc.stateGeneration()) {
        generation = proc.stateGeneration();
        load();
        return;
    }
    if (webLink.connected()) webLink.poll([this](const juce::var& m) { emit(m); });
}

void WebEditor::paint(juce::Graphics& g) { g.fillAll(theme::bg); }

void WebEditor::resized() { browser->setBounds(getLocalBounds()); }
