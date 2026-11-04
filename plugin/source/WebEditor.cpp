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

/** An <input accept> list (".mkwz,application/octet-stream") → a FileChooser pattern ("*.mkwz"). */
juce::String patternFor(const juce::String& accept) {
    juce::StringArray out;
    for (auto a : juce::StringArray::fromTokens(accept, ",", "")) {
        a = a.trim();
        if (a.startsWithChar('.')) out.add("*" + a);
    }
    return out.isEmpty() ? juce::String("*") : out.joinIntoString(";");
}

juce::var obj(std::initializer_list<std::pair<const char*, juce::var>> props) {
    auto* o = new juce::DynamicObject();
    for (const auto& [k, v] : props) o->setProperty(k, v);
    return juce::var(o);
}

/** Largest file an import reads (as the session file format's limit). */
constexpr juce::int64 MAX_OPEN_BYTES = 256 * 1024 * 1024;

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
    webLink.onSaveFile = [this](const juce::String& name, const juce::MemoryBlock& data) { saveFile(name, data); };
    webLink.onOpenFile = [this](int id, const juce::String& accept) { openFile(id, accept); };
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

void WebEditor::saveFile(const juce::String& name, const juce::MemoryBlock& data) {
    const auto write = [this, name, data](const juce::File& f) {
        if (f == juce::File()) return; // cancelled
        const bool ok = f.replaceWithData(data.getData(), data.getSize());
        emit(obj({{"type", "file/saved"}, {"name", name}, {"path", f.getFullPathName()}, {"error", ok ? juce::var() : juce::var("the file couldn’t be written")}}));
    };
    // Tests: save straight into a folder, no dialog.
    if (const auto dir = juce::SystemStats::getEnvironmentVariable("MKWAVEZ_TEST_SAVE_DIR", {}); dir.isNotEmpty())
        return write(juce::File(dir).getChildFile(name));
    const auto start = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory).getChildFile(name);
    chooser = std::make_unique<juce::FileChooser>("Save " + name, start, "*" + start.getFileExtension());
    chooser->launchAsync(juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::canSelectFiles |
                             juce::FileBrowserComponent::warnAboutOverwriting,
                         [write](const juce::FileChooser& fc) { write(fc.getResult()); });
}

void WebEditor::openFile(int id, const juce::String& accept) {
    const auto read = [this, id](const juce::File& f) {
        if (f == juce::File()) return emit(obj({{"type", "file/opened"}, {"id", id}, {"data", juce::var()}}));
        juce::MemoryBlock data;
        juce::String error;
        if (!f.existsAsFile())
            error = "it doesn’t exist";
        else if (f.getSize() > MAX_OPEN_BYTES)
            error = "it is too large";
        else if (!f.loadFileAsData(data))
            error = "it couldn’t be read";
        emit(obj({{"type", "file/opened"},
                  {"id", id},
                  {"name", f.getFileName()},
                  {"data", error.isEmpty() ? juce::var(juce::Base64::toBase64(data.getData(), data.getSize())) : juce::var()},
                  {"error", error.isEmpty() ? juce::var() : juce::var(error)}}));
    };
    // Tests: open this file, no dialog.
    if (const auto path = juce::SystemStats::getEnvironmentVariable("MKWAVEZ_TEST_OPEN_FILE", {}); path.isNotEmpty())
        return read(juce::File(path));
    chooser = std::make_unique<juce::FileChooser>("Open", juce::File::getSpecialLocation(juce::File::userDocumentsDirectory), patternFor(accept));
    chooser->launchAsync(juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles,
                         [read](const juce::FileChooser& fc) { read(fc.getResult()); });
}

void WebEditor::paint(juce::Graphics& g) { g.fillAll(theme::bg); }

void WebEditor::resized() { browser->setBounds(getLocalBounds()); }
