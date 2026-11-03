// Loads the built VST3 the way a DAW does (JUCE's VST3 host) and checks the basics a
// validator would: it instantiates as a MIDI synth, MIDI notes sound and release, the
// output is finite at any block size / sample rate, state round-trips (a restored
// instance renders the same samples) and the editor opens when a display is available.
// Usage: mkwavez_host_test [path/to/mkwavez.vst3]
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_events/juce_events.h>

#include <cmath>
#include <cstdio>

namespace {

int failures = 0;

void check(bool ok, const juce::String& what) {
    std::printf("%s %s\n", ok ? "ok  " : "FAIL", what.toRawUTF8());
    if (!ok) ++failures;
}

struct Render {
    juce::AudioBuffer<float> audio;
    double rms = 0;
    bool finite = true;
};

/** Render `frames` in blocks of `block`, with MIDI events at absolute sample positions. */
Render render(juce::AudioPluginInstance& p, int frames, int block, const std::vector<std::pair<int, juce::MidiMessage>>& events) {
    Render r;
    r.audio.setSize(2, frames);
    r.audio.clear();
    juce::AudioBuffer<float> buf(2, block);
    double sum = 0;
    for (int f = 0; f < frames; f += block) {
        const int n = std::min(block, frames - f);
        buf.setSize(2, n, false, false, true);
        buf.clear();
        juce::MidiBuffer midi;
        for (const auto& [at, m] : events)
            if (at >= f && at < f + n) midi.addEvent(m, at - f);
        p.processBlock(buf, midi);
        for (int c = 0; c < 2; ++c) r.audio.copyFrom(c, f, buf, c, 0, n);
        for (int i = 0; i < n; ++i) {
            const float v = buf.getSample(0, i);
            r.finite = r.finite && std::isfinite(v) && std::abs(v) <= 4;
            sum += (double) v * v;
        }
    }
    r.rms = std::sqrt(sum / std::max(1, frames));
    return r;
}

double rmsOf(const juce::AudioBuffer<float>& b, int from, int to) {
    double s = 0;
    for (int i = from; i < to; ++i) s += (double) b.getSample(0, i) * b.getSample(0, i);
    return std::sqrt(s / std::max(1, to - from));
}

std::unique_ptr<juce::AudioPluginInstance> load(juce::AudioPluginFormatManager& fm, const juce::PluginDescription& d, double sr, int block) {
    juce::String err;
    auto p = fm.createPluginInstance(d, sr, block, err);
    if (!p) std::printf("load error: %s\n", err.toRawUTF8());
    return p;
}

} // namespace

int main(int argc, char** argv) {
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    juce::ScopedJuceInitialiser_GUI init;
    const juce::String path = argc > 1 ? juce::String(argv[1]) : juce::String(MKWAVEZ_VST3_PATH);

    juce::AudioPluginFormatManager fm;
    fm.addFormat(std::make_unique<juce::VST3PluginFormat>());
    juce::OwnedArray<juce::PluginDescription> found;
    juce::VST3PluginFormat vst3;
    vst3.findAllTypesForFile(found, path);
    check(found.size() == 1, "one plugin type in " + path);
    if (found.isEmpty()) return 1;
    const auto& desc = *found[0];
    check(desc.name == "mkwavez", "name is mkwavez (" + desc.name + ")");
    check(desc.isInstrument, "is an instrument");

    constexpr double SR = 48000;
    auto p = load(fm, desc, SR, 512);
    check(p != nullptr, "instantiates");
    if (!p) return 1;
    check(p->acceptsMidi(), "accepts MIDI");
    check(p->getTotalNumOutputChannels() == 2 && p->getTotalNumInputChannels() == 0, "no inputs, stereo out");
    check(p->getParameters().size() >= 50, "exposes parameters (" + juce::String(p->getParameters().size()) + ")");

    // Hosts may pass any block size up to the prepared maximum (never more).
    constexpr int MAX_BLOCK = 4096;
    p->setPlayConfigDetails(0, 2, SR, MAX_BLOCK);
    p->prepareToPlay(SR, MAX_BLOCK);

    // Silent until played (the sequencer runs only with Play / host transport).
    const auto quiet = render(*p, 9600, 512, {});
    check(quiet.finite && quiet.rms < 1e-6, "silent without notes");

    // A held note sounds; after note-off the release dies away.
    const auto note = render(*p, 48000, 512,
                             {{100, juce::MidiMessage::noteOn(1, 57, (juce::uint8) 110)}, {24000, juce::MidiMessage::noteOff(1, 57)}});
    check(note.finite, "note: output finite and bounded");
    check(rmsOf(note.audio, 2000, 20000) > 0.01, "note: sounds while held (rms " + juce::String(rmsOf(note.audio, 2000, 20000), 4) + ")");
    check(rmsOf(note.audio, 46000, 48000) < 1e-4, "note: silent after release");
    bool stereo = true;
    for (int i = 0; i < 48000; ++i) stereo = stereo && std::abs(note.audio.getSample(0, i) - note.audio.getSample(1, i)) < 1e-9f;
    check(stereo, "both channels carry the voice");

    // Sample-accurate MIDI: the note starts at its offset inside a block, not at the block start.
    p->reset();
    const auto offset = render(*p, 2048, 2048, {{1500, juce::MidiMessage::noteOn(1, 69, (juce::uint8) 127)}});
    check(rmsOf(offset.audio, 0, 1500) < 1e-7 && rmsOf(offset.audio, 1510, 2048) > 1e-4, "note-on lands at its sample offset");
    render(*p, 24000, 512, {{0, juce::MidiMessage::allNotesOff(1)}});

    // Odd block sizes and sample-rate changes.
    for (int block : {1, 17, 333, MAX_BLOCK}) {
        const auto r = render(*p, 8192, block, {{10, juce::MidiMessage::noteOn(1, 40 + block % 40, (juce::uint8) 90)}, {7000, juce::MidiMessage::allNotesOff(1)}});
        check(r.finite && r.rms > 1e-3, "block size " + juce::String(block));
    }
    p->releaseResources();
    for (double sr : {44100.0, 96000.0, 22050.0}) {
        p->setPlayConfigDetails(0, 2, sr, 256);
        p->prepareToPlay(sr, 256);
        const auto r = render(*p, (int) sr / 4, 256, {{0, juce::MidiMessage::noteOn(1, 96, (juce::uint8) 127)}});
        check(r.finite && r.rms > 1e-3, "sample rate " + juce::String(sr));
        p->releaseResources();
    }

    // Parameters change the sound: mute V1.
    p->setPlayConfigDetails(0, 2, SR, 512);
    p->prepareToPlay(SR, 512);
    juce::AudioProcessorParameter* muteV1 = nullptr;
    for (auto* prm : p->getParameters())
        if (prm->getName(64) == "V1 Mute") muteV1 = prm;
    check(muteV1 != nullptr, "V1 Mute parameter");
    if (muteV1) {
        muteV1->setValueNotifyingHost(1.0f);
        const auto r = render(*p, 24000, 512, {{0, juce::MidiMessage::noteOn(1, 60, (juce::uint8) 100)}});
        check(rmsOf(r.audio, 12000, 24000) < 1e-4, "muted voice is silent");
        muteV1->setValueNotifyingHost(0.0f);
        render(*p, 12000, 512, {{0, juce::MidiMessage::allNotesOff(1)}});
    }

    // State round-trip: change a parameter, save, restore into a fresh instance, compare output.
    for (auto* prm : p->getParameters())
        if (prm->getName(64) == "V1 Position X") prm->setValueNotifyingHost(0.9f);
    juce::MemoryBlock state;
    p->getStateInformation(state);
    check(state.getSize() > 5 * 2048 * 4, "state holds the tables (" + juce::String((int) state.getSize()) + " bytes)");
    auto q = load(fm, desc, SR, 512);
    check(q != nullptr, "second instance");
    if (q) {
        q->setStateInformation(state.getData(), (int) state.getSize());
        q->setPlayConfigDetails(0, 2, SR, 512);
        q->prepareToPlay(SR, 512);
        p->releaseResources();
        p->prepareToPlay(SR, 512); // same starting point for both
        const std::vector<std::pair<int, juce::MidiMessage>> ev{{0, juce::MidiMessage::noteOn(1, 52, (juce::uint8) 100)}};
        const auto a = render(*p, 12000, 512, ev);
        const auto b = render(*q, 12000, 512, ev);
        double diff = 0;
        for (int i = 0; i < 12000; ++i) diff = std::max(diff, (double) std::abs(a.audio.getSample(0, i) - b.audio.getSample(0, i)));
        check(a.rms > 1e-3 && diff < 1e-6, "restored instance renders identically (max diff " + juce::String(diff) + ")");
        float qpos = -1;
        for (auto* prm : q->getParameters())
            if (prm->getName(64) == "V1 Position X") qpos = prm->getValue();
        check(std::abs(qpos - 0.9f) < 1e-4f, "parameter restored");
        // Garbage state is ignored.
        const char junk[] = "not a state";
        q->setStateInformation(junk, sizeof junk);
        check(render(*q, 4800, 512, ev).finite, "survives garbage state");
        q->releaseResources();
    }

    // Editor (needs a display; CI runs this under xvfb).
    if (juce::Desktop::getInstance().getDisplays().getPrimaryDisplay() != nullptr && p->hasEditor()) {
        std::unique_ptr<juce::AudioProcessorEditor> ed(p->createEditorAndMakeActive());
        check(ed != nullptr && ed->getWidth() > 0, "editor opens");
        ed.reset();
    } else
        std::printf("skip editor (no display)\n");

    p->releaseResources();
    p.reset();
    q.reset();
    std::printf("%s\n", failures ? "FAILED" : "all host checks passed");
    return failures ? 1 : 0;
}
