#include "WebLink.h"

#include "SynthJson.h"

using namespace mkwavez;

namespace {

constexpr int RECORD_CHUNK = 64;

WavetableShape shapeOf(const juce::String& s) { return s == "2d" ? WavetableShape::twoD : s == "rows" ? WavetableShape::rows : WavetableShape::oneD; }

std::vector<int32_t> intArray(const juce::var& v) {
    std::vector<int32_t> out;
    if (const auto* a = v.getArray()) {
        out.reserve((size_t) a->size());
        for (const auto& x : *a) out.push_back((int32_t) (int) x);
    }
    return out;
}

bool decodeTable(const juce::String& b64, Table& out) {
    juce::MemoryOutputStream bytes;
    if (!juce::Base64::convertFromBase64(bytes, b64) || bytes.getDataSize() != sizeof(Table)) return false;
    std::memcpy(out.data(), bytes.getData(), sizeof(Table));
    for (float& x : out)
        if (!std::isfinite(x)) x = 0;
    return true;
}

double num(const juce::var& o, const char* key, double fallback) {
    const auto v = o.getProperty(key, fallback);
    return v.isDouble() || v.isInt() || v.isInt64() || v.isBool() ? (double) v : fallback;
}

VoiceParams decodeVoice(const juce::var& o) {
    VoiceParams v;
    v.id = (int) num(o, "id", 0);
    v.wavetableId = (int) num(o, "wavetableId", 0);
    v.windowStart = (int) num(o, "windowStart", 0);
    v.windowEnd = (int) num(o, "windowEnd", 0);
    v.windowStartY = (int) num(o, "windowStartY", 0);
    v.windowEndY = (int) num(o, "windowEndY", 0);
    v.position = num(o, "position", v.position);
    v.positionY = num(o, "positionY", v.positionY);
    v.lfoDepth = num(o, "lfoDepth", v.lfoDepth);
    v.lfoRate = num(o, "lfoRate", v.lfoRate);
    v.lfoDepthY = num(o, "lfoDepthY", v.lfoDepthY);
    v.lfoRateY = num(o, "lfoRateY", v.lfoRateY);
    v.lfoPhase = num(o, "lfoPhase", 0);
    v.lfoPhaseY = num(o, "lfoPhaseY", 0);
    v.octave = num(o, "octave", 0);
    v.level = num(o, "level", v.level);
    v.mute = (bool) o.getProperty("mute", false);
    v.attack = num(o, "attack", v.attack);
    v.decay = num(o, "decay", v.decay);
    v.sustain = num(o, "sustain", v.sustain);
    v.release = num(o, "release", v.release);
    v.type = o.getProperty("type", "simple").toString() == "synth" ? VoiceType::synth : VoiceType::simple;
    v.synth = synthjson::decode(o.getProperty("synth", {}));
    return v;
}

SequenceData decodeSequence(const juce::var& o) {
    SequenceData s;
    s.id = (int) num(o, "id", 0);
    const auto voice = o.getProperty("voiceId", {});
    s.voiceId = voice.isVoid() || voice.isUndefined() ? -1 : (int) voice;
    s.length = juce::jlimit(1, MAX_STEPS, (int) num(o, "length", 16));
    s.gate = juce::jlimit(0.05, 1.0, num(o, "gate", 0.5));
    const auto len = o.getProperty("stepLength", "1/8").toString();
    s.stepLength = len == "1/4" ? StepLength::quarter : len == "1/16" ? StepLength::sixteenth : len == "1/8T" ? StepLength::eighthTriplet
                 : len == "1/16T" ? StepLength::sixteenthTriplet : StepLength::eighth;
    const auto steps = intArray(o.getProperty("steps", {}));
    for (size_t i = 0; i < s.steps.size(); ++i) s.steps[i] = (int8_t) (i < steps.size() && steps[i] >= 0 && steps[i] < SCALE_ROWS ? steps[i] : REST);
    return s;
}

juce::var obj(std::initializer_list<std::pair<const char*, juce::var>> props) {
    auto* o = new juce::DynamicObject();
    for (const auto& [k, v] : props) o->setProperty(k, v);
    return juce::var(o);
}

} // namespace

WebLink::WebLink(MkwavezProcessor& p) : proc(p) {
    for (auto& s : sentVoice) s.fill(std::numeric_limits<float>::quiet_NaN());
    for (auto& s : sentSynth) s.fill(std::numeric_limits<float>::quiet_NaN());
}

WebLink::~WebLink() { releaseHeldNotes(); }

void WebLink::releaseHeldNotes() {
    for (const auto& [voice, note] : heldNotes) {
        MidiVoiceEvent m;
        m.type = MidiVoiceEvent::noteOff;
        m.voiceId = voice;
        m.note = note;
        proc.uiNotes().push(m);
    }
    heldNotes.clear();
}

void WebLink::handle(const juce::var& m, const Emit& emit) {
    ++handledCount;
    const auto type = m.getProperty("type", {}).toString();
    if (type == "hello") {
        // A (re)loaded page holds nothing.
        releaseHeldNotes();
        sendInit(emit);
    }
    else if (type == "session/put" || type == "session/commit") {
        proc.withSession([&](MkwavezProcessor::Session& s) {
            if (type == "session/commit") {
                ++commitCount;
                s.meta = m.getProperty("meta", {}).toString();
                for (int id : intArray(m.getProperty("remove", {}))) s.records.erase(id);
            }
            if (const auto* recs = m.getProperty("records", {}).getArray())
                for (const auto& r : *recs) s.records[(int) r.getProperty("id", 0)] = r.getProperty("json", {}).toString();
        });
    } else if (type == "session/remove") {
        proc.withSession([&](MkwavezProcessor::Session& s) {
            for (int id : intArray(m.getProperty("ids", {}))) s.records.erase(id);
        });
    } else if (type == "session/clear") {
        proc.withSession([](MkwavezProcessor::Session& s) {
            s.meta = {};
            s.records.clear();
        });
    } else if (type == "file/save") {
        juce::MemoryOutputStream bytes;
        const auto name = juce::File::createLegalFileName(m.getProperty("name", "mkwavez").toString());
        if (juce::Base64::convertFromBase64(bytes, m.getProperty("data", {}).toString()) && onSaveFile)
            onSaveFile(name.isEmpty() ? juce::String("mkwavez") : name, bytes.getMemoryBlock());
    } else if (type == "file/open") {
        if (onOpenFile) onOpenFile((int) m.getProperty("id", 0), m.getProperty("accept", "").toString());
    } else if (type == "settings")
        proc.withSession([&](MkwavezProcessor::Session& s) { s.settings = m.getProperty("json", {}).toString(); });
    else if (type == "batch")
        applyBatch(m.getProperty("ops", {}));
    else if (type == "log") {
        static const bool debug = juce::SystemStats::getEnvironmentVariable("MKWAVEZ_WEB_DEBUG", {}).isNotEmpty();
        const auto line = "[mkwavez web " + m.getProperty("level", {}).toString() + "] " + m.getProperty("message", {}).toString();
        if (debug) std::fprintf(stderr, "%s\n", line.toRawUTF8());
        DBG(line);
    }
    static const bool trace = juce::SystemStats::getEnvironmentVariable("MKWAVEZ_WEB_DEBUG", {}) == "2";
    if (trace) std::fprintf(stderr, "[mkwavez web] <- %s\n", juce::JSON::toString(m, true).substring(0, 300).toRawUTF8());
}

void WebLink::sendInit(const Emit& emit) {
    helloGen = proc.stateGeneration();
    // Stale controller moves from while the page was closed.
    CcMessage stale;
    while (proc.ccMessages().pop(stale)) {
    }

    // Current parameter values: the page applies them before it syncs, so host automation
    // made while it was closed isn't overwritten by the saved project.
    auto& s = proc.parameters();
    juce::Array<juce::var> voices;
    for (int slot = 0; slot < params::VOICE_SLOTS; ++slot) {
        auto* patch = new juce::DynamicObject();
        for (int f = 0; f < params::VOICE_FIELD_COUNT; ++f) {
            const float v = s.getRawParameterValue(params::voiceId(slot, (params::VoiceField) f))->load();
            sentVoice[(size_t) slot][(size_t) f] = v;
            if (f == params::mute)
                patch->setProperty(params::fieldKey((params::VoiceField) f), v >= 0.5f);
            else
                patch->setProperty(params::fieldKey((params::VoiceField) f), v);
        }
        auto* synth = new juce::DynamicObject();
        for (int f = 0; f < params::SYNTH_FIELD_COUNT; ++f) {
            const float v = s.getRawParameterValue(params::synthId(slot, (params::SynthField) f))->load();
            sentSynth[(size_t) slot][(size_t) f] = v;
            synth->setProperty(params::synthKey((params::SynthField) f), v);
        }
        patch->setProperty("synth", juce::var(synth));
        voices.add(obj({{"id", slot + 1}, {"patch", juce::var(patch)}}));
    }
    const auto& st = proc.liveStatus();
    sentPlaying = st.transportPlaying.load();
    sentBpm = st.transportBpm.load();

    juce::Array<juce::var> tableIds, wtIds, voiceIds, seqIds;
    proc.host().read([&](const Document& doc) {
        for (const auto& t : doc.tables) tableIds.add(t.id);
        for (const auto& w : doc.wavetables) wtIds.add(w.id);
        for (const auto& v : doc.voices) voiceIds.add(v.id);
        for (const auto& q : doc.sequences) seqIds.add(q.id);
    });
    juce::String meta, settings;
    std::vector<std::pair<int, juce::String>> records;
    proc.withSession([&](const MkwavezProcessor::Session& sess) {
        meta = sess.meta;
        settings = sess.settings;
        records.assign(sess.records.begin(), sess.records.end());
    });
    emit(obj({{"type", "init"},
              {"meta", meta.isEmpty() ? juce::var() : juce::var(meta)},
              {"records", (int) records.size()},
              {"settings", settings.isEmpty() ? juce::var() : juce::var(settings)},
              {"sampleRate", st.sampleRate.load()},
              {"voices", voices},
              {"transport", transportMessage(sentPlaying, sentBpm)},
              // What the engine holds now, so the page's first sync replaces exactly that.
              {"engine", obj({{"tables", tableIds}, {"wavetables", wtIds}, {"voices", voiceIds}, {"sequences", seqIds}})}}));
    for (size_t i = 0; i < records.size(); i += RECORD_CHUNK) {
        juce::Array<juce::var> items;
        for (size_t k = i; k < std::min(records.size(), i + RECORD_CHUNK); ++k) items.add(obj({{"id", records[k].first}, {"json", records[k].second}}));
        emit(obj({{"type", "records"}, {"items", items}}));
    }
}

void WebLink::setParam(const juce::String& id, float value) {
    if (auto* p = proc.parameters().getParameter(id)) {
        const float norm = p->convertTo0to1(value);
        if (std::abs(p->getValue() - norm) > 1e-6f) p->setValueNotifyingHost(norm);
    }
}

void WebLink::setVoiceParams(const VoiceParams& v) {
    const int slot = v.id - 1;
    if (slot < 0 || slot >= params::VOICE_SLOTS) return;
    for (int f = 0; f < params::VOICE_FIELD_COUNT; ++f) {
        const auto field = (params::VoiceField) f;
        const float value = (float) params::fieldValue(v, field);
        setParam(params::voiceId(slot, field), value);
        // Remember the parameter's actual (snapped / clamped) value so it isn't echoed back.
        sentVoice[(size_t) slot][(size_t) f] = proc.parameters().getRawParameterValue(params::voiceId(slot, field))->load();
    }
    for (int f = 0; f < params::SYNTH_FIELD_COUNT; ++f) {
        const auto field = (params::SynthField) f;
        setParam(params::synthId(slot, field), (float) params::synthValue(v.synth, field));
        sentSynth[(size_t) slot][(size_t) f] = proc.parameters().getRawParameterValue(params::synthId(slot, field))->load();
    }
}

void WebLink::applyBatch(const juce::var& ops) {
    const auto* list = ops.getArray();
    if (!list) return;
    std::vector<DocChange> changes;
    for (const auto& op : *list) {
        const auto type = op.getProperty("type", {}).toString();
        if (type == "tables/addData") {
            if (const auto* items = op.getProperty("items", {}).getArray()) {
                for (const auto& it : *items) {
                    DocChange c;
                    c.kind = DocChange::addTable;
                    c.id = (int) it.getProperty("id", 0);
                    if (decodeTable(it.getProperty("data", {}).toString(), c.table)) changes.push_back(std::move(c));
                    ++tablesIn;
                }
            }
        } else if (type == "tables/remove") {
            for (int id : intArray(op.getProperty("ids", {}))) {
                DocChange c;
                c.kind = DocChange::removeTable;
                c.id = id;
                changes.push_back(c);
            }
        } else if (type == "wavetable/set") {
            const auto w = op.getProperty("wavetable", {});
            DocChange c;
            c.kind = DocChange::setWavetable;
            c.id = (int) op.getProperty("id", 0);
            c.wavetable.shape = shapeOf(w.getProperty("shape", "1d").toString());
            c.wavetable.interp = w.getProperty("interp", "blend").toString() == "step" ? Interp::step : Interp::blend;
            c.wavetable.rowStart = intArray(w.getProperty("rowStart", {}));
            c.wavetable.ids = intArray(w.getProperty("ids", {}));
            const auto& rs = c.wavetable.rowStart;
            bool ok = !rs.empty() && rs.front() == 0 && rs.back() == (int32_t) c.wavetable.ids.size();
            for (size_t i = 1; ok && i < rs.size(); ++i) ok = rs[i] >= rs[i - 1];
            if (ok) changes.push_back(std::move(c));
        } else if (type == "wavetable/remove") {
            DocChange c;
            c.kind = DocChange::removeWavetable;
            c.id = (int) op.getProperty("id", 0);
            changes.push_back(c);
        } else if (type == "voice/set") {
            DocChange c;
            c.kind = DocChange::setVoice;
            c.voice = decodeVoice(op.getProperty("voice", {}));
            c.id = c.voice.id;
            setVoiceParams(c.voice);
            changes.push_back(c);
        } else if (type == "voice/remove") {
            DocChange c;
            c.kind = DocChange::removeVoice;
            c.id = (int) op.getProperty("id", 0);
            changes.push_back(c);
        } else if (type == "sequence/set") {
            DocChange c;
            c.kind = DocChange::setSequence;
            c.sequence = decodeSequence(op.getProperty("sequence", {}));
            c.id = c.sequence.id;
            changes.push_back(c);
        } else if (type == "sequence/remove") {
            DocChange c;
            c.kind = DocChange::removeSequence;
            c.id = (int) op.getProperty("id", 0);
            changes.push_back(c);
        } else if (type == "transport") {
            setParam(params::play, (bool) op.getProperty("playing", false) ? 1.0f : 0.0f);
            setParam(params::bpm, (float) num(op, "bpm", 132));
        } else if (type == "midi/settings") {
            auto& ms = proc.webMidi();
            ms.enabled = (bool) op.getProperty("enabled", true);
            const auto voice = op.getProperty("voice", {});
            ms.omniVoice = voice.isVoid() || voice.isUndefined() ? 0 : (int) voice; // 0 = no voice
            setParam(params::omni, (bool) op.getProperty("omni", false) ? 1.0f : 0.0f);
            ms.mpe = (bool) op.getProperty("mpe", false);
            const auto cc = op.getProperty("cc", {});
            // Order = CC_PARAMS (src/core/midi.ts) = mkwavez::CcParam.
            const char* keys[CC_PARAM_COUNT] = {"position", "positionY", "lfoDepth", "lfoRate", "level", "cutoff", "resonance",
                                                "drive", "filterEnv", "oscMix", "subLevel", "noiseLevel", "glide", "lfo1Rate",
                                                "lfo1Depth", "lfo2Rate", "lfo2Depth", "lfo3Rate", "lfo3Depth",
                                                "macro1", "macro2", "macro3", "macro4"};
            for (int i = 0; i < CC_PARAM_COUNT; ++i) ms.cc[(size_t) i] = (int) num(cc, keys[i], -1);
        } else if (type == "midi") {
            // The page's Hold button: note on / off for a voice (host MIDI is routed natively).
            if (const auto* evs = op.getProperty("events", {}).getArray()) {
                for (const auto& ev : *evs) {
                    const auto t = ev.getProperty("type", {}).toString();
                    if (t != "noteOn" && t != "noteOff") continue;
                    MidiVoiceEvent m;
                    m.type = t == "noteOn" ? MidiVoiceEvent::noteOn : MidiVoiceEvent::noteOff;
                    m.voiceId = (int) num(ev, "voiceId", -1);
                    m.note = juce::jlimit(0, 127, (int) num(ev, "note", 60));
                    m.velocity = juce::jlimit(0, 127, (int) num(ev, "velocity", 0));
                    if (m.type == MidiVoiceEvent::noteOn)
                        heldNotes.insert({m.voiceId, m.note});
                    else
                        heldNotes.erase({m.voiceId, m.note});
                    proc.uiNotes().push(m);
                }
            }
        }
        // 'voice/patch': the page doesn't send it in plugin mode (host MIDI is routed natively).
    }
    static const bool trace = juce::SystemStats::getEnvironmentVariable("MKWAVEZ_WEB_DEBUG", {}) == "2";
    if (trace) {
        juce::String types;
        for (const auto& op : *list) types << op.getProperty("type", {}).toString() << " ";
        std::fprintf(stderr, "[mkwavez web] batch: %s→ %d changes\n", types.toRawUTF8(), (int) changes.size());
    }
    if (!changes.empty()) proc.host().apply(changes);
}

juce::var WebLink::transportMessage(bool playing, double bpm) const {
    return obj({{"type", "transport"}, {"playing", playing}, {"bpm", bpm}});
}

void WebLink::poll(const Emit& emit) {
    const auto& st = proc.liveStatus();

    // Status, shaped like the worklet's (EngineStatus).
    juce::Array<juce::var> voices;
    const int n = st.voiceCount.load(std::memory_order_acquire);
    for (int i = 0; i < n; ++i) {
        const auto& v = st.voices[(size_t) i];
        voices.add(obj({{"id", v.id.load()},
                        {"pos", v.pos.load()},
                        {"posY", v.posY.load()},
                        {"index", v.index.load()},
                        {"y", v.y.load()},
                        {"env", v.env.load()},
                        {"note", v.note.load()}}));
    }
    int tableCount = 0;
    proc.host().read([&](const Document& doc) { tableCount = (int) doc.tables.size(); });
    emit(obj({{"type", "status"},
              {"status", obj({{"tick", (juce::int64) st.tick.load()}, {"playing", st.playing.load()}, {"voices", voices}})},
              {"tableCount", tableCount},
              {"sampleRate", st.sampleRate.load()}}));

    // Host transport (play state, tempo) and Play / BPM automation.
    const bool playing = st.transportPlaying.load();
    const double bpm = st.transportBpm.load();
    if (playing != sentPlaying || std::abs(bpm - sentBpm) > 1e-6) {
        sentPlaying = playing;
        sentBpm = bpm;
        emit(transportMessage(playing, bpm));
    }

    // Voice parameter automation.
    auto& s = proc.parameters();
    for (int slot = 0; slot < params::VOICE_SLOTS; ++slot) {
        juce::DynamicObject::Ptr patch;
        for (int f = 0; f < params::VOICE_FIELD_COUNT; ++f) {
            const float v = s.getRawParameterValue(params::voiceId(slot, (params::VoiceField) f))->load();
            float& sent = sentVoice[(size_t) slot][(size_t) f];
            if (std::abs(v - sent) <= 0.0f) continue; // NaN (never sent) compares unequal
            sent = v;
            if (!patch) patch = new juce::DynamicObject();
            if (f == params::mute)
                patch->setProperty(params::fieldKey((params::VoiceField) f), v >= 0.5f);
            else
                patch->setProperty(params::fieldKey((params::VoiceField) f), v);
        }
        juce::DynamicObject::Ptr synth;
        for (int f = 0; f < params::SYNTH_FIELD_COUNT; ++f) {
            const float v = s.getRawParameterValue(params::synthId(slot, (params::SynthField) f))->load();
            float& sent = sentSynth[(size_t) slot][(size_t) f];
            if (std::abs(v - sent) <= 0.0f) continue;
            sent = v;
            if (!synth) synth = new juce::DynamicObject();
            synth->setProperty(params::synthKey((params::SynthField) f), v);
        }
        if (synth) {
            if (!patch) patch = new juce::DynamicObject();
            patch->setProperty("synth", juce::var(synth.get()));
        }
        if (patch) emit(obj({{"type", "voice/params"}, {"id", slot + 1}, {"patch", juce::var(patch.get())}}));
    }

    // Controller moves.
    juce::Array<juce::var> msgs;
    CcMessage cc;
    while (msgs.size() < 256 && proc.ccMessages().pop(cc)) msgs.add(juce::Array<juce::var>{(int) cc[0], (int) cc[1], (int) cc[2]});
    if (!msgs.isEmpty()) emit(obj({{"type", "midi/cc"}, {"messages", msgs}}));
}
