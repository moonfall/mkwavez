#include "State.h"

#include "SynthJson.h"

namespace state {

using namespace mkwavez;

namespace {

const juce::Identifier DOCUMENT{"document"}, TABLES{"tables"}, TABLE{"table"}, WAVETABLES{"wavetables"}, WAVETABLE{"wavetable"},
    VOICES{"voices"}, VOICE{"voice"}, SEQUENCES{"sequences"}, SEQUENCE{"sequence"};
const juce::Identifier version{"version"}, id{"id"}, data{"data"}, name{"name"}, shape{"shape"}, interp{"interp"}, rowStart{"rowStart"},
    ids{"ids"}, wavetableId{"wavetableId"}, windowStart{"windowStart"}, windowEnd{"windowEnd"}, windowStartY{"windowStartY"},
    windowEndY{"windowEndY"}, lfoPhase{"lfoPhase"}, lfoPhaseY{"lfoPhaseY"}, voiceId{"voiceId"}, length{"length"}, steps{"steps"},
    gate{"gate"}, stepLength{"stepLength"}, type{"type"}, synth{"synth"};

template <typename T>
juce::MemoryBlock block(const T* p, size_t n) {
    return juce::MemoryBlock(p, n * sizeof(T));
}

template <typename T>
std::vector<T> unblock(const juce::var& v) {
    std::vector<T> out;
    if (const auto* mb = v.getBinaryData()) {
        out.resize(mb->getSize() / sizeof(T));
        std::memcpy(out.data(), mb->getData(), out.size() * sizeof(T));
    }
    return out;
}

} // namespace

juce::ValueTree toValueTree(const Document& doc) {
    juce::ValueTree root(DOCUMENT);
    root.setProperty(version, VERSION, nullptr);

    juce::ValueTree tables(TABLES);
    for (const auto& t : doc.tables) {
        // Generate's unadded waveforms are never saved (as in the web app: a restore leaves
        // the Preview wavetables' slots empty until the editor shows a preview again).
        if (isPreviewId(t.id)) continue;
        juce::ValueTree n(TABLE);
        n.setProperty(id, t.id, nullptr);
        n.setProperty(data, block(t.data.data(), t.data.size()), nullptr);
        tables.appendChild(n, nullptr);
    }
    root.appendChild(tables, nullptr);

    juce::ValueTree wts(WAVETABLES);
    for (const auto& w : doc.wavetables) {
        juce::ValueTree n(WAVETABLE);
        n.setProperty(id, w.id, nullptr);
        n.setProperty(name, juce::String(w.name), nullptr);
        n.setProperty(shape, (int) w.packed.shape, nullptr);
        n.setProperty(interp, (int) w.packed.interp, nullptr);
        n.setProperty(rowStart, block(w.packed.rowStart.data(), w.packed.rowStart.size()), nullptr);
        n.setProperty(ids, block(w.packed.ids.data(), w.packed.ids.size()), nullptr);
        wts.appendChild(n, nullptr);
    }
    root.appendChild(wts, nullptr);

    // Parameter-driven voice fields live in the parameter state, not here.
    juce::ValueTree voices(VOICES);
    for (const auto& v : doc.voices) {
        juce::ValueTree n(VOICE);
        n.setProperty(id, v.id, nullptr);
        n.setProperty(wavetableId, v.wavetableId, nullptr);
        n.setProperty(windowStart, v.windowStart, nullptr);
        n.setProperty(windowEnd, v.windowEnd, nullptr);
        n.setProperty(windowStartY, v.windowStartY, nullptr);
        n.setProperty(windowEndY, v.windowEndY, nullptr);
        n.setProperty(lfoPhase, v.lfoPhase, nullptr);
        n.setProperty(lfoPhaseY, v.lfoPhaseY, nullptr);
        n.setProperty(type, v.type == VoiceType::synth ? "synth" : "simple", nullptr);
        n.setProperty(synth, juce::JSON::toString(synthjson::encode(v.synth), true), nullptr);
        voices.appendChild(n, nullptr);
    }
    root.appendChild(voices, nullptr);

    juce::ValueTree seqs(SEQUENCES);
    for (const auto& s : doc.sequences) {
        juce::ValueTree n(SEQUENCE);
        n.setProperty(id, s.id, nullptr);
        n.setProperty(voiceId, s.voiceId, nullptr);
        n.setProperty(length, s.length, nullptr);
        n.setProperty(gate, s.gate, nullptr);
        n.setProperty(stepLength, (int) s.stepLength, nullptr);
        n.setProperty(steps, block(s.steps.data(), s.steps.size()), nullptr);
        seqs.appendChild(n, nullptr);
    }
    root.appendChild(seqs, nullptr);
    return root;
}

bool fromValueTree(const juce::ValueTree& root, Document& out) {
    if (!root.hasType(DOCUMENT) || (int) root.getProperty(version, 0) != VERSION) return false;
    Document doc;

    for (const auto& n : root.getChildWithName(TABLES)) {
        const auto samples = unblock<float>(n.getProperty(data));
        if (samples.size() != (size_t) TABLE_SIZE) return false;
        Document::TableData t;
        t.id = (int) n.getProperty(id);
        std::copy(samples.begin(), samples.end(), t.data.begin());
        doc.tables.push_back(t);
    }

    for (const auto& n : root.getChildWithName(WAVETABLES)) {
        Document::WavetableData w;
        w.id = (int) n.getProperty(id);
        w.name = n.getProperty(name).toString().toStdString();
        w.packed.shape = (WavetableShape) juce::jlimit(0, 2, (int) n.getProperty(shape));
        w.packed.interp = (Interp) juce::jlimit(0, 1, (int) n.getProperty(interp));
        w.packed.rowStart = unblock<int32_t>(n.getProperty(rowStart));
        w.packed.ids = unblock<int32_t>(n.getProperty(ids));
        // Validate: offsets start at 0, never decrease, end at the slot count.
        const auto& rs = w.packed.rowStart;
        if (rs.empty() || rs.front() != 0 || rs.back() != (int32_t) w.packed.ids.size()) return false;
        for (size_t i = 1; i < rs.size(); ++i)
            if (rs[i] < rs[i - 1]) return false;
        doc.wavetables.push_back(std::move(w));
    }

    for (const auto& n : root.getChildWithName(VOICES)) {
        VoiceParams v;
        v.id = (int) n.getProperty(id);
        v.wavetableId = (int) n.getProperty(wavetableId);
        v.windowStart = (int) n.getProperty(windowStart);
        v.windowEnd = (int) n.getProperty(windowEnd);
        v.windowStartY = (int) n.getProperty(windowStartY);
        v.windowEndY = (int) n.getProperty(windowEndY);
        v.lfoPhase = (double) n.getProperty(lfoPhase);
        v.lfoPhaseY = (double) n.getProperty(lfoPhaseY);
        v.type = n.getProperty(type).toString() == "synth" ? VoiceType::synth : VoiceType::simple;
        if (n.hasProperty(synth)) v.synth = synthjson::decode(juce::JSON::parse(n.getProperty(synth).toString()));
        doc.voices.push_back(v);
    }

    for (const auto& n : root.getChildWithName(SEQUENCES)) {
        SequenceData s;
        s.id = (int) n.getProperty(id);
        s.voiceId = (int) n.getProperty(voiceId);
        s.length = juce::jlimit(1, MAX_STEPS, (int) n.getProperty(length));
        s.gate = juce::jlimit(0.05, 1.0, (double) n.getProperty(gate));
        s.stepLength = (StepLength) juce::jlimit(0, STEP_LENGTH_COUNT - 1, (int) n.getProperty(stepLength, (int) StepLength::eighth));
        const auto st = unblock<int8_t>(n.getProperty(steps));
        for (size_t i = 0; i < s.steps.size() && i < st.size(); ++i)
            s.steps[i] = st[i] >= 0 && st[i] < SCALE_ROWS ? st[i] : (int8_t) REST;
        doc.sequences.push_back(s);
    }

    out = std::move(doc);
    return true;
}

} // namespace state
