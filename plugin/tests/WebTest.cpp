// End to end with the real editor: the web app in the embedded web view (WebKitGTK here,
// under xvfb in CI) drives the native engine. Checks that
//  1. a fresh instance's page syncs its start state into the native document (tables,
//     all four built-in wavetables, three voices, sequences) and saves its project;
//  2. generating in the page (Seed → Add batch) reaches the engine as new tables;
//  3. host automation of a voice parameter reaches the page's model (and its saved project);
//  4. the saved state restores in a fresh instance — the page reloads the project with the
//     samples from the native state, without the tables being re-sent;
//  5. the engine plays the result (a MIDI note sounds).
// Usage: xvfb-run -a mkwavez_web_test
#include "../source/PluginProcessor.h"
#include "../source/WebEditor.h"

#include <juce_audio_processors/juce_audio_processors.h>

#include <cstdio>
#include <functional>

namespace {

int failures = 0;

void check(bool ok, const juce::String& what) {
    std::printf("%s %s\n", ok ? "ok  " : "FAIL", what.toRawUTF8());
    if (!ok) ++failures;
}

} // namespace

namespace juce::detail {
// JUCE's Linux message pump (juce_Messaging_linux.cpp). runDispatchLoop() can't be
// re-entered once stopped, so the test pumps messages itself.
bool dispatchNextMessageOnSystemQueue(bool returnIfNoPendingMessages);
} // namespace juce::detail

namespace {

/** Pump messages until `done()` or the timeout. */
bool waitFor(const std::function<bool()>& done, int timeoutMs, const juce::String& what) {
    const auto deadline = juce::Time::getMillisecondCounter() + (juce::uint32) timeoutMs;
    bool ok = false;
    while (!(ok = done()) && juce::Time::getMillisecondCounter() < deadline) {
        if (!juce::detail::dispatchNextMessageOnSystemQueue(true)) juce::Thread::sleep(2);
    }
    check(ok, what);
    return ok;
}

/** Pump messages for `ms`. */
void pump(int ms) {
    const auto deadline = juce::Time::getMillisecondCounter() + (juce::uint32) ms;
    while (juce::Time::getMillisecondCounter() < deadline)
        if (!juce::detail::dispatchNextMessageOnSystemQueue(true)) juce::Thread::sleep(2);
}

struct Instance {
    std::unique_ptr<MkwavezProcessor> proc;
    std::unique_ptr<juce::AudioProcessorEditor> editor;
    juce::AudioBuffer<float> buf{2, 512};

    Instance() : proc(dynamic_cast<MkwavezProcessor*>(createPluginFilter())) {
        proc->setPlayConfigDetails(0, 2, 48000, 512);
        proc->prepareToPlay(48000, 512);
    }
    ~Instance() {
        editor.reset();
        proc->releaseResources();
    }
    WebEditor* web() const { return dynamic_cast<WebEditor*>(editor.get()); }
    void openEditor() { editor.reset(proc->createEditorAndMakeActive()); }

    /** Render a little (the audio thread drains commands; status updates). */
    double render(int blocks, std::function<void(int, juce::MidiBuffer&)> midiAt = {}) {
        double sum = 0;
        for (int b = 0; b < blocks; ++b) {
            juce::MidiBuffer midi;
            if (midiAt) midiAt(b, midi);
            buf.clear();
            proc->processBlock(buf, midi);
            for (int i = 0; i < buf.getNumSamples(); ++i) sum += (double) buf.getSample(0, i) * buf.getSample(0, i);
        }
        return std::sqrt(sum / (blocks * 512.0));
    }

    template <typename Fn>
    auto doc(Fn&& fn) const {
        using R = decltype(fn(std::declval<const mkwavez::Document&>()));
        R r{};
        proc->host().read([&](const mkwavez::Document& d) { r = fn(d); });
        return r;
    }
};

} // namespace

#if JUCE_LINUX
// JUCE runs WebKitGTK in a child process; in an app (not a plugin) that child is this
// executable started again with this flag.
extern "C" int juce_gtkWebkitMain(int argc, const char* const* argv);
#endif

int main(int argc, const char* argv[]) {
#if JUCE_LINUX
    if (argc >= 2 && juce::String(argv[1]) == "--juce-gtkwebkitfork-child") return juce_gtkWebkitMain(argc, argv);
    // Mark this as an app so JUCE starts that child by re-running this executable.
    juce::JUCEApplicationBase::createInstance = []() -> juce::JUCEApplicationBase* { return nullptr; };
#else
    juce::ignoreUnused(argc, argv);
#endif
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    juce::ScopedJuceInitialiser_GUI init;
    juce::MemoryBlock saved;
    juce::String savedProject;

    {
        Instance a;
        a.openEditor();
        check(a.web() != nullptr, "editor is the web view editor");
        if (!a.web()) return 1;
        a.editor->setVisible(true);
        a.editor->addToDesktop(0);

        // 1. The page connects and syncs its start state.
        waitFor([&] { return a.web()->link().connected() && a.proc->projectJson().isNotEmpty(); }, 30000, "page connected and saved its project");
        waitFor([&] { a.render(2); return a.doc([](const auto& d) { return d.wavetables.size() == 4 && d.voices.size() == 3; }); }, 10000,
                "native document has the page's 4 built-in wavetables and 3 voices");
        check(a.doc([](const auto& d) { return (int) d.tables.size(); }) == 5, "5 start tables");
        check(a.doc([](const auto& d) { return (int) d.sequences.size(); }) == 3, "3 sequences");
        const auto project = juce::JSON::parse(a.proc->projectJson());
        check(project.getProperty("format", {}).toString() == "mkwavez-project", "project JSON saved");

        // 2. Generate in the page: Seed → Add batch (default N).
        a.web()->evaluate("document.getElementById('seed-add-batch').click()");
        waitFor([&] { a.render(1); return a.doc([](const auto& d) { return d.tables.size() > 5; }); }, 20000, "Add batch in the page adds tables to the engine");
        const int afterBatch = a.doc([](const auto& d) { return (int) d.tables.size(); });
        std::printf("     tables after Add batch: %d\n", afterBatch);

        // 3. Host automation → the page's model → its saved project.
        auto* pos = a.proc->parameters().getParameter(params::voiceId(0, params::position));
        pos->setValueNotifyingHost(0.875f);
        waitFor([&] {
            a.render(1);
            const auto p = juce::JSON::parse(a.proc->projectJson());
            const auto* voices = p.getProperty("voices", {}).getArray();
            return voices && !voices->isEmpty() && std::abs((double) (*voices)[0].getProperty("position", 0) - 0.875) < 1e-4;
        }, 10000, "automated V1 position reaches the page and its project");

        // 5. It plays.
        a.render(10);
        const double rms = a.render(40, [](int b, juce::MidiBuffer& m) {
            if (b == 0) m.addEvent(juce::MidiMessage::noteOn(1, 57, (juce::uint8) 110), 0);
        });
        check(rms > 0.005, "a MIDI note sounds (rms " + juce::String(rms, 4) + ")");
        check(a.web()->link().tablesReceived() == afterBatch, "fresh page sent every table once (" + juce::String(a.web()->link().tablesReceived()) + ")");

        // MKWAVEZ_SCREENSHOT_PAUSE=ms keeps the window up for an external screenshot.
        if (const int pause = juce::SystemStats::getEnvironmentVariable("MKWAVEZ_SCREENSHOT_PAUSE", "0").getIntValue(); pause > 0)
            pump(pause);

        a.proc->getStateInformation(saved);
        savedProject = a.proc->projectJson();
        check(saved.getSize() > (size_t) afterBatch * 2048 * 4, "state holds every table (" + juce::String((int) saved.getSize()) + " bytes)");
    }

    {
        // 4. Restore into a fresh instance; the page reloads the project.
        Instance b;
        b.proc->setStateInformation(saved.getData(), (int) saved.getSize());
        const int tables = b.doc([](const auto& d) { return (int) d.tables.size(); });
        b.render(2);
        b.openEditor();
        b.editor->setVisible(true);
        b.editor->addToDesktop(0);
        waitFor([&] { return b.web()->link().connected() && b.web()->link().handled() >= 3; }, 30000, "restored page connected");
        // The restored page saves its (restored) project once it is up.
        waitFor([&] { b.render(1); return b.web()->link().projectsReceived() >= 1; }, 10000, "restored page saved its project");
        const juce::String latest = b.proc->projectJson();
        const auto p0 = juce::JSON::parse(savedProject), p1 = juce::JSON::parse(latest);
        const auto* t0 = p0.getProperty("tables", {}).getArray();
        const auto* t1 = p1.getProperty("tables", {}).getArray();
        check(t0 && t1 && t0->size() == t1->size(), "same timeline after restore (" + juce::String(t1 ? t1->size() : -1) + " tables)");
        check(b.doc([](const auto& d) { return (int) d.tables.size(); }) == tables, "no tables lost");
        check(b.web()->link().tablesReceived() == 0, "no tables re-sent (" + juce::String(b.web()->link().tablesReceived()) + ")");
        const auto* v1 = p1.getProperty("voices", {}).getArray();
        check(v1 && std::abs((double) (*v1)[0].getProperty("position", 0) - 0.875) < 1e-4, "voice parameters restored");
    }

    std::printf("%s\n", failures ? "FAILED" : "all web view checks passed");
    return failures ? 1 : 0;
}
