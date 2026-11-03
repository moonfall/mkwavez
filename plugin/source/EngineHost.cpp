#include "EngineHost.h"

#include <algorithm>
#include <cstring>
#include <set>

namespace mkwavez {

// ---- Document ----

const Document::TableData* Document::table(TableId id) const {
    for (const auto& t : tables)
        if (t.id == id) return &t;
    return nullptr;
}

const Document::WavetableData* Document::wavetable(WavetableId id) const {
    for (const auto& w : wavetables)
        if (w.id == id) return &w;
    return nullptr;
}

const VoiceParams* Document::voice(int32_t id) const {
    for (const auto& v : voices)
        if (v.id == id) return &v;
    return nullptr;
}

Document Document::makeDefault() {
    Document d;
    const BasicWave waves[] = {BasicWave::sine, BasicWave::tri, BasicWave::saw, BasicWave::square, BasicWave::p25};
    std::vector<int32_t> ids;
    for (int i = 0; i < 5; ++i) {
        d.tables.push_back({i + 1, basicWave(waves[i])});
        ids.push_back(i + 1);
    }
    // Ids as in src/core/wavetable.ts (TIMELINE_WAVETABLE_ID 0, LAST_BATCH_WAVETABLE_ID 1).
    d.wavetables.push_back({0, "Timeline", PackedWavetable::fromIds(ids)});
    d.wavetables.push_back({1, "Last batch", PackedWavetable::fromIds(ids)});

    // As src/main.ts; parameters (position, LFOs, level, mute, ADSR, octave) come from
    // the plugin's parameter defaults, which match these.
    VoiceParams v1;
    v1.id = 1;
    v1.wavetableId = 1;
    v1.windowEnd = 4;
    VoiceParams v2;
    v2.id = 2;
    v2.windowStart = 1;
    v2.windowEnd = 4;
    v2.lfoPhase = 1.5;
    VoiceParams v3;
    v3.id = 3;
    v3.windowEnd = 2;
    v3.lfoPhase = 3;
    VoiceParams v4;
    v4.id = 4;
    v4.windowEnd = 4;
    d.voices = {v1, v2, v3, v4};

    auto seq = [](int32_t id, int32_t voice, std::vector<int> steps) {
        SequenceData s;
        s.id = id;
        s.voiceId = voice;
        s.length = (int32_t) steps.size();
        for (size_t i = 0; i < steps.size(); ++i) s.steps[i] = (int8_t) steps[i];
        return s;
    };
    d.sequences = {
        seq(1, 1, {0, -1, 3, -1, 4, 4, -1, 2, 0, -1, 5, 4, -1, 3, 2, -1}),
        seq(2, 2, {-1, -1, 7, -1, -1, 5, -1, -1, -1, -1, 6, -1, 4, -1, -1, -1}),
        seq(3, 3, {0, -1, -1, -1, 0, -1, -1, -1, 3, -1, -1, -1, 2, -1, -1, -1}),
    };
    return d;
}

// ---- EngineHost ----

EngineHost::EngineHost() {
    std::lock_guard<std::mutex> lock(mutex);
    doc = Document::makeDefault();
    for (const auto& t : doc.tables) mipsFor(t);
    for (const auto& w : doc.wavetables) packed[w.id] = std::make_unique<PackedWavetable>(w.packed);
}

EngineHost::~EngineHost() {
    eng.reset(); // before the memory it points at
}

const MipSet* EngineHost::mipsFor(const Document::TableData& t) {
    auto& slot = mips[t.id];
    if (!slot) slot = std::make_unique<MipSet>(buildMipSet(t.data));
    return slot.get();
}

void EngineHost::load(Document next) {
    std::lock_guard<std::mutex> lock(mutex);
    std::vector<EngineCommand> cmds;
    auto cmd = [&](EngineCommand::Type type, int32_t id) {
        EngineCommand c;
        c.type = type;
        c.id = id;
        cmds.push_back(c);
        return &cmds.back();
    };

    std::set<int32_t> nextVoices, nextSeqs, nextWts, nextTables;
    for (const auto& v : next.voices) nextVoices.insert(v.id);
    for (const auto& s : next.sequences) nextSeqs.insert(s.id);
    for (const auto& w : next.wavetables) nextWts.insert(w.id);
    for (const auto& t : next.tables) nextTables.insert(t.id);

    for (const auto& v : doc.voices)
        if (!nextVoices.count(v.id)) cmd(EngineCommand::removeVoice, v.id);
    for (const auto& s : doc.sequences)
        if (!nextSeqs.count(s.id)) cmd(EngineCommand::removeSequence, s.id);
    for (const auto& w : doc.wavetables) {
        if (nextWts.count(w.id)) continue;
        cmd(EngineCommand::removeWavetable, w.id);
        if (auto it = packed.find(w.id); it != packed.end()) {
            retiringWavetables[it->second.get()] = std::move(it->second);
            packed.erase(it);
        }
    }
    // Tables: keep allocations whose data is unchanged; retire the rest.
    for (const auto& t : doc.tables) {
        const auto* n = next.table(t.id);
        const bool same = n && std::memcmp(n->data.data(), t.data.data(), sizeof(Table)) == 0;
        if (same) continue;
        cmd(EngineCommand::removeTable, t.id);
        if (auto it = mips.find(t.id); it != mips.end()) {
            retiringTables[it->second.get()] = std::move(it->second);
            mips.erase(it);
        }
    }
    for (const auto& t : next.tables) {
        if (mips.count(t.id)) continue; // unchanged and already in the engine
        cmd(EngineCommand::addTable, t.id)->mips = mipsFor(t);
    }
    for (const auto& w : next.wavetables) {
        auto fresh = std::make_unique<PackedWavetable>(w.packed);
        if (auto it = packed.find(w.id); it != packed.end()) retiringWavetables[it->second.get()] = std::move(it->second);
        cmd(EngineCommand::setWavetable, w.id)->wavetable = fresh.get();
        packed[w.id] = std::move(fresh);
    }
    for (const auto& v : next.voices) cmd(EngineCommand::setVoice, v.id)->voice = v;
    for (const auto& s : next.sequences) cmd(EngineCommand::setSequence, s.id)->sequence = s;

    doc = std::move(next);
    send(cmds);
}

void EngineHost::apply(const std::vector<DocChange>& changes) {
    std::lock_guard<std::mutex> lock(mutex);
    std::vector<EngineCommand> cmds;
    cmds.reserve(changes.size());
    auto cmd = [&](EngineCommand::Type type, int32_t id) -> EngineCommand& {
        EngineCommand c;
        c.type = type;
        c.id = id;
        cmds.push_back(c);
        return cmds.back();
    };
    auto retireTable = [&](TableId id) {
        if (auto it = mips.find(id); it != mips.end()) {
            retiringTables[it->second.get()] = std::move(it->second);
            mips.erase(it);
        }
    };
    for (const auto& c : changes) {
        switch (c.kind) {
            case DocChange::addTable: {
                // Ids are never reused for other data, but a re-add (undo past an eviction) may come
                // while the old allocation is still retiring: always give it a fresh one.
                retireTable(c.id);
                auto it = std::find_if(doc.tables.begin(), doc.tables.end(), [&](const auto& t) { return t.id == c.id; });
                if (it != doc.tables.end())
                    it->data = c.table;
                else
                    doc.tables.push_back({c.id, c.table});
                auto m = std::make_unique<MipSet>(buildMipSet(c.table));
                cmd(EngineCommand::addTable, c.id).mips = m.get();
                mips[c.id] = std::move(m);
                break;
            }
            case DocChange::removeTable: {
                const auto n = doc.tables.size();
                doc.tables.erase(std::remove_if(doc.tables.begin(), doc.tables.end(), [&](const auto& t) { return t.id == c.id; }), doc.tables.end());
                if (doc.tables.size() == n && !mips.count(c.id)) break;
                cmd(EngineCommand::removeTable, c.id);
                retireTable(c.id);
                break;
            }
            case DocChange::setWavetable: {
                auto it = std::find_if(doc.wavetables.begin(), doc.wavetables.end(), [&](const auto& w) { return w.id == c.id; });
                if (it != doc.wavetables.end()) {
                    it->name = c.name.empty() ? it->name : c.name;
                    it->packed = c.wavetable;
                } else
                    doc.wavetables.push_back({c.id, c.name, c.wavetable});
                auto fresh = std::make_unique<PackedWavetable>(c.wavetable);
                if (auto old = packed.find(c.id); old != packed.end()) retiringWavetables[old->second.get()] = std::move(old->second);
                cmd(EngineCommand::setWavetable, c.id).wavetable = fresh.get();
                packed[c.id] = std::move(fresh);
                break;
            }
            case DocChange::removeWavetable: {
                doc.wavetables.erase(std::remove_if(doc.wavetables.begin(), doc.wavetables.end(), [&](const auto& w) { return w.id == c.id; }),
                                     doc.wavetables.end());
                if (auto old = packed.find(c.id); old != packed.end()) {
                    retiringWavetables[old->second.get()] = std::move(old->second);
                    packed.erase(old);
                    cmd(EngineCommand::removeWavetable, c.id);
                }
                break;
            }
            case DocChange::setVoice: {
                auto it = std::find_if(doc.voices.begin(), doc.voices.end(), [&](const auto& v) { return v.id == c.id; });
                if (it != doc.voices.end())
                    *it = c.voice;
                else
                    doc.voices.push_back(c.voice);
                cmd(EngineCommand::setVoice, c.id).voice = c.voice;
                break;
            }
            case DocChange::removeVoice:
                doc.voices.erase(std::remove_if(doc.voices.begin(), doc.voices.end(), [&](const auto& v) { return v.id == c.id; }), doc.voices.end());
                cmd(EngineCommand::removeVoice, c.id);
                break;
            case DocChange::setSequence: {
                auto it = std::find_if(doc.sequences.begin(), doc.sequences.end(), [&](const auto& s) { return s.id == c.id; });
                if (it != doc.sequences.end())
                    *it = c.sequence;
                else
                    doc.sequences.push_back(c.sequence);
                cmd(EngineCommand::setSequence, c.id).sequence = c.sequence;
                break;
            }
            case DocChange::removeSequence:
                doc.sequences.erase(std::remove_if(doc.sequences.begin(), doc.sequences.end(), [&](const auto& s) { return s.id == c.id; }),
                                    doc.sequences.end());
                cmd(EngineCommand::removeSequence, c.id);
                break;
        }
    }
    send(cmds);
}

void EngineHost::send(std::vector<EngineCommand>& cmds) {
    if (cmds.empty()) return;
    // No engine yet: prepare() applies the whole document.
    if (!eng) return;
    flushOutbox();
    if (outbox.empty() && queue.pushBatch(cmds.data(), cmds.size())) return;
    // Too many for the queue at once: send in order, as space allows (housekeeping()).
    outbox.insert(outbox.end(), cmds.begin(), cmds.end());
    flushOutbox();
}

void EngineHost::flushOutbox() {
    while (!outbox.empty() && queue.push(outbox.front())) outbox.pop_front();
}

void EngineHost::housekeeping() {
    std::lock_guard<std::mutex> lock(mutex);
    flushOutbox();
    collectRetired();
}

void EngineHost::collectRetired() {
    if (!eng) return;
    Retired r;
    while (eng->popRetired(r)) {
        if (r.kind == Retired::table)
            retiringTables.erase(r.ptr);
        else
            retiringWavetables.erase(r.ptr);
    }
}

size_t EngineHost::ownedTables() const {
    std::lock_guard<std::mutex> lock(mutex);
    return mips.size() + retiringTables.size();
}

void EngineHost::applyAll(SynthEngine& e) {
    for (const auto& t : doc.tables) e.addTable(t.id, mips.at(t.id).get());
    for (const auto& w : doc.wavetables) e.setWavetable(w.id, packed.at(w.id).get());
    for (const auto& v : doc.voices) e.setVoice(v);
    for (const auto& s : doc.sequences) e.setSequence(s);
}

void EngineHost::prepare(double sampleRate) {
    std::lock_guard<std::mutex> lock(mutex);
    // Processing is stopped: drop whatever was queued (the document is the truth) and
    // the old engine; nothing references retiring memory any more.
    eng.reset();
    EngineCommand c;
    while (queue.pop(c)) {
    }
    outbox.clear();
    retiringTables.clear();
    retiringWavetables.clear();
    eng = std::make_unique<SynthEngine>(sampleRate);
    applyAll(*eng);
}

void EngineHost::release() {
    std::lock_guard<std::mutex> lock(mutex);
    eng.reset();
    EngineCommand c;
    while (queue.pop(c)) {
    }
    outbox.clear();
    retiringTables.clear();
    retiringWavetables.clear();
}

bool EngineHost::drain() {
    if (!eng) return false;
    bool voices = false;
    EngineCommand c;
    while (queue.pop(c)) {
        SynthEngine& e = *eng;
        switch (c.type) {
            case EngineCommand::addTable: e.addTable(c.id, c.mips); break;
            case EngineCommand::removeTable: e.removeTable(c.id); break;
            case EngineCommand::setWavetable: e.setWavetable(c.id, c.wavetable); break;
            case EngineCommand::removeWavetable: e.removeWavetable(c.id); break;
            case EngineCommand::setVoice:
                e.setVoice(c.voice);
                voices = true;
                break;
            case EngineCommand::removeVoice:
                e.removeVoice(c.id);
                voices = true;
                break;
            case EngineCommand::setSequence: e.setSequence(c.sequence); break;
            case EngineCommand::removeSequence: e.removeSequence(c.id); break;
        }
    }
    return voices;
}

} // namespace mkwavez
