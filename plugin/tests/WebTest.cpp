// End to end with the real editor: the web app in the embedded web view (WebKitGTK here,
// under xvfb in CI) drives the native engine. Checks that
//  1. a fresh instance's page syncs its start state into the native document (tables,
//     all four built-in wavetables, three voices, sequences) and saves its project;
//  2. generating in the page (Seed → Add batch) reaches the engine as new tables;
//  3. host automation of a voice parameter reaches the page's model (and its saved project);
//  4. the saved state restores in a fresh instance — the page reloads the project with the
//     samples from the native state, without the tables being re-sent;
//  5. the engine plays the result (a MIDI note sounds; the page's Hold button holds one).
// Usage: xvfb-run -a mkwavez_web_test
#include "../source/PluginProcessor.h"
#include "../source/State.h"
#include "../source/WebEditor.h"

#include <juce_audio_processors/juce_audio_processors.h>

#include <cstdio>
#include <cstdlib>
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
    if (what.isNotEmpty() || !ok) check(ok, what.isNotEmpty() ? what : juce::String("(wait)"));
    return ok;
}

/** Pump messages for `ms`. */
void pump(int ms) {
    const auto deadline = juce::Time::getMillisecondCounter() + (juce::uint32) ms;
    while (juce::Time::getMillisecondCounter() < deadline)
        if (!juce::detail::dispatchNextMessageOnSystemQueue(true)) juce::Thread::sleep(2);
}

juce::String metaOf(MkwavezProcessor& p) {
    return p.withSession([](const MkwavezProcessor::Session& s) { return s.meta; });
}
int recordsOf(MkwavezProcessor& p) {
    return p.withSession([](const MkwavezProcessor::Session& s) { return (int) s.records.size(); });
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

    /** Render; returns the largest |L − R| (stereo spread / pan) and the left RMS. */
    std::pair<double, double> renderStereo(int blocks, std::function<void(int, juce::MidiBuffer&)> midiAt) {
        double maxDiff = 0, sum = 0;
        for (int b = 0; b < blocks; ++b) {
            juce::MidiBuffer midi;
            midiAt(b, midi);
            buf.clear();
            proc->processBlock(buf, midi);
            for (int i = 0; i < buf.getNumSamples(); ++i) {
                maxDiff = std::max(maxDiff, (double) std::abs(buf.getSample(0, i) - buf.getSample(1, i)));
                sum += (double) buf.getSample(0, i) * buf.getSample(0, i);
            }
        }
        return {maxDiff, std::sqrt(sum / (blocks * 512.0))};
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
    // Native save dialogs write straight into a folder in this test (see WebEditor::saveFile).
    ::setenv("MKWAVEZ_TEST_SAVE_DIR", juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("mkwavez-webtest-save").getFullPathName().toRawUTF8(), 1);
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
        // Projects saved before "Sequencer follows host" existed take it from their Host sync
        // (on = the sequencer ran with the host, as it did then); current ones keep their own.
        const auto restoredFollow = [](bool dropIt, bool hostSync) {
            std::unique_ptr<MkwavezProcessor> src(dynamic_cast<MkwavezProcessor*>(createPluginFilter()));
            juce::MemoryBlock st;
            src->getStateInformation(st);
            auto root = juce::ValueTree::readFromData(st.getData(), st.getSize());
            for (auto ch : root) {
                const auto follow = ch.getChildWithProperty("id", params::seqFollow);
                if (!follow.isValid()) continue;
                if (dropIt) ch.removeChild(follow, nullptr);
                ch.getChildWithProperty("id", params::hostSync).setProperty("value", hostSync ? 1.0 : 0.0, nullptr);
            }
            juce::MemoryBlock edited;
            {
                juce::MemoryOutputStream os(edited, false);
                root.writeToStream(os);
            }
            std::unique_ptr<MkwavezProcessor> dst(dynamic_cast<MkwavezProcessor*>(createPluginFilter()));
            dst->setStateInformation(edited.getData(), (int) edited.getSize());
            return dst->parameters().getRawParameterValue(params::seqFollow)->load() >= 0.5f;
        };
        check(restoredFollow(true, true), "a project saved before \"Sequencer follows host\", with Host sync on, follows the host");
        check(!restoredFollow(true, false), "one with Host sync off doesn't");
        check(!restoredFollow(false, true), "a current project keeps its own setting (off, with Host sync on)");
    }

    {
        Instance a;
        a.openEditor();
        check(a.web() != nullptr, "editor is the web view editor");
        if (!a.web()) return 1;
        a.editor->setVisible(true);
        a.editor->addToDesktop(0);

        // 1. The page connects and syncs its start state.
        waitFor([&] { return a.web()->link().connected() && metaOf(*a.proc).isNotEmpty(); }, 30000, "page connected and autosaved its session");
        // Timeline, Last batch, Batches, Grid, Selection, Preview, Preview batch.
        waitFor([&] { a.render(2); return a.doc([](const auto& d) { return d.wavetables.size() == 7 && d.voices.size() == 1; }); }, 10000,
                "native document has the page's 7 built-in wavetables and its one voice");
        check(a.doc([](const auto& d) { return d.voices[0].type == mkwavez::VoiceType::synth && !d.voices[0].mute; }), "the plugin starts with one (unmuted) Synth voice");
        check(a.doc([](const auto& d) { return (int) d.tables.size(); }) == 5, "5 start tables");
        check(a.doc([](const auto& d) { return (int) d.sequences.size(); }) == 1, "its sequence (for the page's Play)");
        const auto meta = juce::JSON::parse(metaOf(*a.proc));
        check(meta.getProperty("format", {}).toString() == "mkwavez-session", "session meta saved");
        check(recordsOf(*a.proc) == 5, "5 waveform records saved (" + juce::String(recordsOf(*a.proc)) + ")");
        // The Voice panel starts maximized, showing the Synth's full view.
        {
            juce::String view;
            waitFor([&] {
                view = "<pending>";
                a.web()->evaluate("(document.getElementById('synth-panel') || {dataset: {}}).dataset.view || 'none'",
                                  [&](juce::WebBrowserComponent::EvaluationResult r) { view = r.getResult() ? r.getResult()->toString() : juce::String("<error>"); });
                waitFor([&] { return view != "<pending>"; }, 5000, {});
                return view == "full";
            }, 10000, "the Voice panel opens the Synth voice in its full view");
            std::printf("     synth panel view: %s\n", view.toRawUTF8());
            // Restore (as the panel's button): the other panels come back for the steps below.
            a.web()->evaluate("mkwavez.layout.maximize('voice')");
            waitFor([&] {
                view = "<pending>";
                a.web()->evaluate("document.querySelector('section.panel[data-panel=gen]').classList.contains('collapsed') ? 'collapsed' : 'open'",
                                  [&](juce::WebBrowserComponent::EvaluationResult r) { view = r.getResult() ? r.getResult()->toString() : juce::String("<error>"); });
                waitFor([&] { return view != "<pending>"; }, 5000, {});
                return view == "open";
            }, 5000, "Restore brings the Generate panel back");
        }

        // 2. Generate in the page: Seed → Add batch (default N).
        a.web()->evaluate("document.getElementById('seed-add-batch').click()");
        waitFor([&] { a.render(1); return a.doc([](const auto& d) { return d.tables.size() > 5; }); }, 20000, "Add batch in the page adds tables to the engine");
        const int afterBatch = a.doc([](const auto& d) { return (int) d.tables.size(); });
        std::printf("     tables after Add batch: %d\n", afterBatch);
        waitFor([&] { a.render(1); return recordsOf(*a.proc) == afterBatch; }, 10000, "the batch is autosaved (records for every waveform)");

        // 3. Host automation → the page's model → its saved project.
        auto* pos = a.proc->parameters().getParameter(params::voiceId(0, params::position));
        pos->setValueNotifyingHost(0.875f);
        waitFor([&] {
            a.render(1);
            const auto p = juce::JSON::parse(metaOf(*a.proc));
            const auto* voices = p.getProperty("voices", {}).getArray();
            return voices && !voices->isEmpty() && std::abs((double) (*voices)[0].getProperty("position", 0) - 0.875) < 1e-4;
        }, 10000, "automated V1 position reaches the page and its saved session");

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

        // 6. A Synth voice set up in the page plays in the native engine (stereo: unison spread, pan).
        a.render(40, [](int b, juce::MidiBuffer& m) {
            if (b == 0) m.addEvent(juce::MidiMessage::allNotesOff(1), 0);
        });
        // Matrix slot 1: MPE Slide → cutoff (the newest source: names are decoded by SynthJson).
        a.web()->evaluate("const s1 = mkwavez.model.voice(1).synth; mkwavez.model.updateVoice(1, { type: 'synth', synth: { ...s1, aUnison: 3, aSpread: 1, pan: 0.4, cutoff: 3000, "
                          "mods: s1.mods.map((m, i) => (i === 0 ? { src: 'slide', dst: 'cutoff', amt: 0.5 } : m)) } })");
        waitFor([&] {
            a.render(1);
            return a.doc([](const auto& d) { return !d.voices.empty() && d.voices[0].type == mkwavez::VoiceType::synth && d.voices[0].synth.aUnison == 3; });
        }, 10000, "a Synth voice set in the page reaches the engine document");
        check(a.doc([](const auto& d) { return d.voices[0].synth.mods[0].src == mkwavez::SRC_SLIDE && d.voices[0].synth.mods[0].dst == mkwavez::DST_CUTOFF; }),
              "its matrix route (MPE Slide → cutoff) reaches the engine");
        const auto [lr, synthRms] = a.renderStereo(60, [](int b, juce::MidiBuffer& m) {
            if (b == 0) m.addEvent(juce::MidiMessage::noteOn(1, 52, (juce::uint8) 110), 0);
        });
        check(synthRms > 0.005 && lr > 1e-3, "the Synth voice sounds, in stereo (rms " + juce::String(synthRms, 4) + ", max |L-R| " + juce::String(lr, 4) + ")");
        a.render(40, [](int b, juce::MidiBuffer& m) {
            if (b == 0) m.addEvent(juce::MidiMessage::allNotesOff(1), 0);
        });
        waitFor([&] { a.render(1); return metaOf(*a.proc).contains("\"type\":\"synth\""); }, 10000, "the Synth voice is in the saved session");

        // 6b. A voice on Preview batch plays Generate's unadded waveforms: the page ships them
        //     (ids from PREVIEW_ID_BASE) only while a voice plays them, and they're never saved.
        const auto previewTables = [&] {
            return a.doc([](const auto& d) {
                int n = 0;
                for (const auto& t : d.tables) n += mkwavez::isPreviewId(t.id) ? 1 : 0;
                return n;
            });
        };
        check(previewTables() == 0, "no preview tables in the engine while no voice plays them");
        a.web()->evaluate("mkwavez.model.updateVoice(1, { wavetableId: 6 })");
        waitFor([&] {
            a.render(1);
            return previewTables() > 0 && a.doc([](const auto& d) { return !d.voices.empty() && d.voices[0].wavetableId == 6; });
        }, 10000, "V1 on Preview batch: the page ships Generate's preview tables to the engine");
        std::printf("     preview tables in the engine: %d\n", previewTables());
        const double previewRms = a.render(40, [](int b, juce::MidiBuffer& m) {
            if (b == 0) m.addEvent(juce::MidiMessage::noteOn(1, 52, (juce::uint8) 110), 0);
        });
        check(previewRms > 0.005, "the unadded batch sounds (rms " + juce::String(previewRms, 4) + ")");
        a.render(40, [](int b, juce::MidiBuffer& m) {
            if (b == 0) m.addEvent(juce::MidiMessage::allNotesOff(1), 0);
        });
        const auto savedTree = a.doc([](const auto& d) { return state::toValueTree(d); });
        const int engineTables = a.doc([](const auto& d) { return (int) d.tables.size(); });
        check(savedTree.getChildWithName("tables").getNumChildren() == engineTables - previewTables(), "preview tables are left out of the saved state");
        a.web()->evaluate("mkwavez.model.undo()");
        waitFor([&] {
            a.render(1);
            return previewTables() == 0 && a.doc([](const auto& d) { return !d.voices.empty() && d.voices[0].wavetableId != 6; });
        }, 10000, "undo puts V1 back, and the preview tables leave the engine");

        // 6c. The transport bar's Hold plays and sustains a note without MIDI; pressing it
        //     again releases the note.
        a.render(40);
        a.web()->evaluate("document.getElementById('hold-key').click()");
        waitFor([&] { return a.render(4) > 0.005; }, 10000, "Hold in the page sustains a note in the engine (no MIDI)");
        check(a.render(40) > 0.005, "the held note keeps sounding");
        a.web()->evaluate("document.getElementById('hold-key').click()");
        waitFor([&] { return a.render(4) < 1e-4; }, 10000, "pressing Hold again releases it");

        // 7. Browser features the plugin replaces: in-page confirm / prompt (embedded web views
        //    don't all have them), native save (session export) and open (session import).
        juce::String evalResult;
        const auto evalInto = [&](const juce::String& js) {
            evalResult = "<pending>";
            a.web()->evaluate(js, [&](juce::WebBrowserComponent::EvaluationResult r) {
                evalResult = r.getResult() ? r.getResult()->toString() : juce::String("<error>");
            });
            waitFor([&] { return evalResult != "<pending>"; }, 5000, {});
        };
        a.web()->evaluate("window.__dlg = 'waiting'; mkwavez.ask.prompt('Chain name', 'abc').then((v) => { window.__dlg = v; })");
        waitFor([&] {
            evalInto("document.getElementById('app-dialog-input') ? document.getElementById('app-dialog-input').value : ''");
            return evalResult == "abc";
        }, 5000, "prompt() shows an in-page dialog with the default value");
        a.web()->evaluate("document.getElementById('app-dialog-input').value = 'My chain'; document.getElementById('app-dialog-ok').click()");
        waitFor([&] { evalInto("String(window.__dlg)"); return evalResult == "My chain"; }, 5000, "the dialog returns the typed name");
        a.web()->evaluate("window.__dlg = 'waiting'; mkwavez.ask.confirm('Delete?').then((v) => { window.__dlg = String(v); }); "
                          "setTimeout(() => document.getElementById('app-dialog-cancel').click(), 50)");
        waitFor([&] { evalInto("String(window.__dlg)"); return evalResult == "false"; }, 5000, "confirm() cancel answers false");

        const auto saveDir = juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("mkwavez-webtest-save");
        saveDir.deleteRecursively();
        saveDir.createDirectory();
        a.web()->evaluate("document.getElementById('session-export').click()");
        juce::File exported;
        waitFor([&] {
            pump(20);
            const auto files = saveDir.findChildFiles(juce::File::findFiles, false, "*.mkwz");
            if (!files.isEmpty()) exported = files[0];
            return exported.existsAsFile() && exported.getSize() > 1000;
        }, 10000, "Session → Export writes a .mkwz through the native save path");

        // Import it back (after a change, so the import is observable): the same 13 tables + 1.
        a.web()->evaluate("document.getElementById('seed-add-shown').click()");
        waitFor([&] { a.render(1); return a.doc([](const auto& d) { return (int) d.tables.size(); }) == afterBatch + 1; }, 10000, "one more table");
        ::setenv("MKWAVEZ_TEST_OPEN_FILE", exported.getFullPathName().toRawUTF8(), 1);
        a.web()->evaluate("document.getElementById('session-import').click()");
        // The import asks first (in-page confirm): accept it.
        waitFor([&] {
            evalInto("document.getElementById('app-dialog-ok') ? (document.getElementById('app-dialog-ok').click(), 'ok') : 'no'");
            return evalResult == "ok";
        }, 10000, "Session → Import opens the file natively and asks (in-page) before replacing");
        waitFor([&] { a.render(1); return a.doc([](const auto& d) { return (int) d.tables.size(); }) == afterBatch; }, 10000,
                "the imported session replaces the current one");
        ::unsetenv("MKWAVEZ_TEST_OPEN_FILE");
        saveDir.deleteRecursively();

        a.proc->getStateInformation(saved);
        savedProject = metaOf(*a.proc);
        check(saved.getSize() > (size_t) afterBatch * 2048 * 4, "state holds every table (" + juce::String((int) saved.getSize()) + " bytes)");
    }

    {
        // 4. Restore into a fresh instance; the page reloads the project.
        Instance b;
        b.proc->setStateInformation(saved.getData(), (int) saved.getSize());
        const int tables = b.doc([](const auto& d) { return (int) d.tables.size(); });
        check(b.doc([](const auto& d) { return !d.voices.empty() && d.voices[0].type == mkwavez::VoiceType::synth && d.voices[0].synth.aUnison == 3; }),
              "the restored engine (before the editor opens) has the Synth voice");
        check(b.doc([](const auto& d) { return !d.voices.empty() && d.voices[0].synth.mods[0].src == mkwavez::SRC_SLIDE; }),
              "and its MPE Slide matrix route (saved natively by name)");
        const auto [lr0, rms0] = b.renderStereo(60, [](int blk, juce::MidiBuffer& m) {
            if (blk == 0) m.addEvent(juce::MidiMessage::noteOn(1, 52, (juce::uint8) 110), 0);
        });
        check(rms0 > 0.005 && lr0 > 1e-3, "it plays in stereo without the editor (rms " + juce::String(rms0, 4) + ")");
        b.render(40, [](int blk, juce::MidiBuffer& m) {
            if (blk == 0) m.addEvent(juce::MidiMessage::allNotesOff(1), 0);
        });
        b.render(2);
        b.openEditor();
        b.editor->setVisible(true);
        b.editor->addToDesktop(0);
        waitFor([&] { return b.web()->link().connected() && b.web()->link().handled() >= 3; }, 30000, "restored page connected");
        // The restored page's first sync reaches the engine (its model = the saved session).
        waitFor([&] { b.render(1); return b.web()->link().handled() >= 2 && b.doc([](const auto& d) { return d.voices.size() == 1; }); }, 10000,
                "restored page synced");
        b.render(4);
        const auto p0 = juce::JSON::parse(savedProject);
        const auto* t0 = p0.getProperty("timeline", {}).getArray();
        check(t0 && t0->size() == tables, "saved timeline = engine tables (" + juce::String(t0 ? t0->size() : -1) + ")");
        check(b.doc([](const auto& d) { return (int) d.tables.size(); }) == tables, "no tables lost");
        check(b.web()->link().tablesReceived() == 0, "no tables re-sent (" + juce::String(b.web()->link().tablesReceived()) + ")");
        const double pos = b.doc([](const auto& d) { return d.voices.empty() ? -1.0 : d.voices[0].position; });
        check(std::abs(pos - 0.875) < 1e-4, "voice parameters restored (" + juce::String(pos) + ")");
        // An edit in the restored page is saved again.
        b.web()->evaluate("document.getElementById('seed-add-shown').click()");
        waitFor([&] { b.render(1); return recordsOf(*b.proc) == tables + 1 && b.web()->link().tablesReceived() == 1; }, 10000,
                "an add in the restored page reaches the engine and the saved session");
    }

    std::printf("%s\n", failures ? "FAILED" : "all web view checks passed");
    return failures ? 1 : 0;
}
