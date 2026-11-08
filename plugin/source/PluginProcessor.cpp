#include "PluginProcessor.h"

#include <optional>

#include "PluginEditor.h"
#include "State.h"
#if MKWAVEZ_WEBVIEW
 #include "WebEditor.h"
#endif

using namespace mkwavez;

MkwavezProcessor::MkwavezProcessor()
    : AudioProcessor(BusesProperties().withOutput("Output", juce::AudioChannelSet::stereo(), true)),
      apvts(*this, nullptr, "params", params::createLayout()),
      ptr(apvts) {
    for (auto& v : lastVoice) v.fill(std::numeric_limits<float>::quiet_NaN());
    for (auto& v : lastSynth) v.fill(std::numeric_limits<float>::quiet_NaN());
    startTimerHz(20);
}

MkwavezProcessor::~MkwavezProcessor() { stopTimer(); }

bool MkwavezProcessor::isBusesLayoutSupported(const BusesLayout& layouts) const {
    const auto out = layouts.getMainOutputChannelSet();
    return layouts.getMainInputChannelSet().isDisabled() && (out == juce::AudioChannelSet::mono() || out == juce::AudioChannelSet::stereo());
}

void MkwavezProcessor::prepareToPlay(double sampleRate, int) {
    engineHost.prepare(sampleRate);
    status.sampleRate = sampleRate;
    router.reset();
    for (auto& v : lastVoice) v.fill(std::numeric_limits<float>::quiet_NaN());
    for (auto& v : lastSynth) v.fill(std::numeric_limits<float>::quiet_NaN());
    lastPlaying = false;
    lastBpm = 0;
    outGain.reset(sampleRate, 0.02);
    outGain.setCurrentAndTargetValue(juce::Decibels::decibelsToGain(ptr.gain->load()));
}

void MkwavezProcessor::releaseResources() { engineHost.release(); }

void MkwavezProcessor::timerCallback() { engineHost.housekeeping(); }

void MkwavezProcessor::resetDocument() {
    engineHost.load(Document::makeDefault());
    withSession([](Session& s) {
        s.meta = {};
        s.records.clear();
    });
    ++stateGen;
}

// ---- audio thread ----

void MkwavezProcessor::applyParameters(SynthEngine& e, bool force) {
    for (int s = 0; s < params::VOICE_SLOTS; ++s) {
        std::array<float, params::VOICE_FIELD_COUNT> now{};
        for (int f = 0; f < params::VOICE_FIELD_COUNT; ++f) now[(size_t) f] = ptr.voice[(size_t) s][(size_t) f]->load(std::memory_order_relaxed);
        std::array<float, params::SYNTH_FIELD_COUNT> nowS{};
        for (int f = 0; f < params::SYNTH_FIELD_COUNT; ++f) nowS[(size_t) f] = ptr.synth[(size_t) s][(size_t) f]->load(std::memory_order_relaxed);
        auto& last = lastVoice[(size_t) s];
        auto& lastS = lastSynth[(size_t) s];
        if (!force && now == last && nowS == lastS) continue;
        last = now;
        lastS = nowS;
        const VoiceParams* cur = e.voiceParams(s + 1);
        if (!cur) continue;
        VoiceParams v = *cur;
        params::applyVoiceFields(v, now);
        params::applySynthFields(v.synth, nowS);
        e.setVoice(v);
    }
}

void MkwavezProcessor::applyTransport(SynthEngine& e) {
    bool hostPlaying = false;
    double hostBpm = 0;
    if (auto* ph = getPlayHead()) {
        if (const auto pos = ph->getPosition()) {
            hostPlaying = pos->getIsPlaying();
            if (const auto b = pos->getBpm()) hostBpm = *b;
        }
    }
    // Host sync: the tempo follows the host. The internal sequencer runs from Play, and with
    // the host's transport only when "Sequencer follows host" is on (off by default: the
    // voices play the host's MIDI).
    const bool sync = ptr.hostSync->load() >= 0.5f;
    const bool follow = ptr.seqFollow->load() >= 0.5f;
    const bool playing = ptr.play->load() >= 0.5f || (follow && hostPlaying);
    const double bpm = sync && hostBpm > 0 ? hostBpm : (double) ptr.bpm->load();
    if (playing != lastPlaying || std::abs(bpm - lastBpm) > 1e-9) {
        e.setTransport(playing, bpm);
        lastPlaying = playing;
        lastBpm = bpm;
        status.transportPlaying.store(playing, std::memory_order_relaxed);
        status.transportBpm.store(bpm, std::memory_order_relaxed);
    }
}

void MkwavezProcessor::handleMidi(SynthEngine& e, const juce::MidiMessage& m) {
    const MidiMessage msg = parseMidi(m.getRawData(), m.getRawDataSize());
    if (msg.kind == MidiMessage::cc) {
        // The web UI hears controller moves (learn, LED, its sliders); dropped if it isn't reading.
        const auto* raw = m.getRawData();
        ccQueue.push(CcMessage{raw[0], raw[1], raw[2]});
    }
    router.route(msg, routing, [&](const MidiVoiceEvent& ev) {
        if (ev.type != MidiVoiceEvent::cc) return e.applyMidi(ev);
        // Mapped controllers (default: mod wheel → position X) patch the engine voice; the
        // parameter keeps its value, so the next move of that parameter takes over again.
        const VoicePatch patch = ccPatch(ccMap, ev.note, ev.velocity);
        if (!patch.empty()) e.patchVoice(ev.voiceId, patch);
    });
}

void MkwavezProcessor::publishStatus(const SynthEngine& e) {
    e.status(scratchStatus);
    status.tick.store(scratchStatus.tick, std::memory_order_relaxed);
    status.playing.store(scratchStatus.playing, std::memory_order_relaxed);
    for (int i = 0; i < scratchStatus.voiceCount; ++i) {
        const auto& s = scratchStatus.voices[i];
        auto& d = status.voices[(size_t) i];
        d.id.store(s.id, std::memory_order_relaxed);
        d.pos.store((float) s.pos, std::memory_order_relaxed);
        d.posY.store((float) s.posY, std::memory_order_relaxed);
        d.index.store((float) s.index, std::memory_order_relaxed);
        d.y.store((float) s.y, std::memory_order_relaxed);
        d.env.store((float) s.env, std::memory_order_relaxed);
        d.note.store(s.note, std::memory_order_relaxed);
    }
    status.voiceCount.store(scratchStatus.voiceCount, std::memory_order_release);
}

void MkwavezProcessor::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) {
    juce::ScopedNoDenormals noDenormals;
    const int frames = buffer.getNumSamples();
    SynthEngine* e = engineHost.engine();
    if (!e || buffer.getNumChannels() == 0) {
        buffer.clear();
        return;
    }

    const bool voicesChanged = engineHost.drain();
    applyParameters(*e, voicesChanged);
    applyTransport(*e);

    // MIDI routing: Omni → the chosen voice, else channel N → voice N.
    MidiRouting r;
    r.omni = ptr.omni->load() >= 0.5f;
    r.mpe = midiSettings.mpe.load(std::memory_order_relaxed);
    const int webVoice = midiSettings.omniVoice.load(std::memory_order_relaxed);
    r.selectedVoice = webVoice >= 0 ? webVoice : juce::roundToInt(ptr.midiVoice->load());
    for (size_t i = 0; i < ccMap.cc.size(); ++i) ccMap.cc[i] = midiSettings.cc[i].load(std::memory_order_relaxed);
    const bool midiOn = midiSettings.enabled.load(std::memory_order_relaxed);
    r.voiceCount = e->voiceIds(r.voiceIds, MAX_ROUTED_VOICES);
    const bool retarget = r.omni != routing.omni || r.mpe != routing.mpe || r.selectedVoice != routing.selectedVoice || r.voiceCount != routing.voiceCount ||
                          !std::equal(r.voiceIds, r.voiceIds + r.voiceCount, routing.voiceIds);
    routing = r;
    if (retarget) router.retarget(routing, [&](const MidiVoiceEvent& ev) { e->applyMidi(ev); });
    // Notes held from the web UI (whether or not MIDI input is on).
    for (MidiVoiceEvent ev; uiNoteQueue.pop(ev);) e->applyMidi(ev);

    // Render up to each MIDI event's sample offset, then apply it (sample-accurate). Stereo
    // (Synth voices pan / spread); a mono bus gets the mid.
    const bool stereo = buffer.getNumChannels() >= 2;
    float* out = buffer.getWritePointer(0);
    float* outR = stereo ? buffer.getWritePointer(1) : nullptr;
    int pos = 0;
    const auto render = [&](int from, int to) {
        if (to > from) e->process(out + from, to - from, outR ? outR + from : nullptr);
    };
    for (const auto meta : midi) {
        const int at = juce::jlimit(pos, frames, meta.samplePosition);
        render(pos, at);
        pos = at;
        if (midiOn) handleMidi(*e, meta.getMessage());
    }
    render(pos, frames);

    outGain.setTargetValue(juce::Decibels::decibelsToGain(ptr.gain->load()));
    for (int c = 2; c < buffer.getNumChannels(); ++c) buffer.clear(c, 0, frames);
    outGain.applyGain(buffer, frames);

    publishStatus(*e);
}

// ---- state ----

void MkwavezProcessor::getStateInformation(juce::MemoryBlock& destData) {
    juce::ValueTree root("mkwavez");
    root.setProperty("version", state::VERSION, nullptr);
    withSession([&](const Session& s) {
        juce::ValueTree t("session");
        t.setProperty("meta", s.meta, nullptr);
        t.setProperty("settings", s.settings, nullptr);
        for (const auto& [id, json] : s.records) {
            juce::ValueTree r("record");
            r.setProperty("id", id, nullptr);
            r.setProperty("json", json, nullptr);
            t.appendChild(r, nullptr);
        }
        root.appendChild(t, nullptr);
    });
    root.appendChild(apvts.copyState(), nullptr);
    engineHost.read([&](const Document& doc) { root.appendChild(state::toValueTree(doc), nullptr); });
    juce::MemoryOutputStream out(destData, false);
    root.writeToStream(out);
}

void MkwavezProcessor::setStateInformation(const void* data, int sizeInBytes) {
    const auto root = juce::ValueTree::readFromData(data, (size_t) sizeInBytes);
    if (!root.hasType("mkwavez")) return;
    const auto saved = root.getChildWithName(apvts.state.getType());
    // Projects saved before "Sequencer follows host" existed ran the sequencer with the host
    // whenever Host sync was on (its default): keep that. Read before replaceState, which
    // adopts `saved` as the parameter tree and adds the missing parameters to it.
    std::optional<bool> legacyFollow;
    if (saved.isValid() && !saved.getChildWithProperty("id", params::seqFollow).isValid()) {
        const auto hs = saved.getChildWithProperty("id", params::hostSync);
        legacyFollow = !hs.isValid() || (double) hs.getProperty("value", 1.0) >= 0.5;
    }
    if (saved.isValid()) apvts.replaceState(saved);
    if (legacyFollow)
        if (auto* prm = apvts.getParameter(params::seqFollow)) prm->setValueNotifyingHost(*legacyFollow ? 1.0f : 0.0f);
    Document doc;
    const bool ok = state::fromValueTree(root.getChildWithName("document"), doc);
    if (ok) {
        // Synth parameters a project saved before they existed would start at their defaults
        // and overwrite the voice's saved values: those follow the document instead.
        for (int slot = 0; slot < params::VOICE_SLOTS; ++slot) {
            const VoiceParams* v = nullptr;
            for (const auto& x : doc.voices)
                if (x.id == slot + 1) v = &x;
            if (!v) continue;
            for (int f = 0; f < params::SYNTH_FIELD_COUNT; ++f) {
                const auto id = params::synthId(slot, (params::SynthField) f);
                if (saved.isValid() && saved.getChildWithProperty("id", id).isValid()) continue;
                if (auto* prm = apvts.getParameter(id)) prm->setValueNotifyingHost(prm->convertTo0to1((float) params::synthValue(v->synth, (params::SynthField) f)));
            }
        }
        engineHost.load(std::move(doc));
    }
    withSession([&](Session& s) {
        s = {};
        const auto t = root.getChildWithName("session");
        if (!ok || !t.isValid()) return;
        s.meta = t.getProperty("meta").toString();
        s.settings = t.getProperty("settings").toString();
        for (const auto& r : t)
            if (r.hasType("record")) s.records[(int) r.getProperty("id")] = r.getProperty("json").toString();
    });
    ++stateGen;
}

juce::AudioProcessorEditor* MkwavezProcessor::createEditor() {
#if MKWAVEZ_WEBVIEW
    // MKWAVEZ_NATIVE_EDITOR=1 forces the minimal native editor (e.g. where no web view is available).
    if (juce::SystemStats::getEnvironmentVariable("MKWAVEZ_NATIVE_EDITOR", {}).isEmpty()) return new WebEditor(*this);
#endif
    return new MkwavezEditor(*this);
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new MkwavezProcessor(); }
