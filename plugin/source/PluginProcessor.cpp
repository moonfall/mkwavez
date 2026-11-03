#include "PluginProcessor.h"

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
    lastPlaying = false;
    lastBpm = 0;
    outGain.reset(sampleRate, 0.02);
    outGain.setCurrentAndTargetValue(juce::Decibels::decibelsToGain(ptr.gain->load()));
}

void MkwavezProcessor::releaseResources() { engineHost.release(); }

void MkwavezProcessor::timerCallback() { engineHost.housekeeping(); }

void MkwavezProcessor::resetDocument() {
    engineHost.load(Document::makeDefault());
    setProjectJson({});
    ++stateGen;
}

// ---- audio thread ----

void MkwavezProcessor::applyParameters(SynthEngine& e, bool force) {
    for (int s = 0; s < params::VOICE_SLOTS; ++s) {
        std::array<float, params::VOICE_FIELD_COUNT> now{};
        for (int f = 0; f < params::VOICE_FIELD_COUNT; ++f) now[(size_t) f] = ptr.voice[(size_t) s][(size_t) f]->load(std::memory_order_relaxed);
        auto& last = lastVoice[(size_t) s];
        if (!force && now == last) continue;
        last = now;
        const VoiceParams* cur = e.voiceParams(s + 1);
        if (!cur) continue;
        VoiceParams v = *cur;
        params::applyVoiceFields(v, now);
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
    const bool sync = ptr.hostSync->load() >= 0.5f;
    const bool playing = ptr.play->load() >= 0.5f || (sync && hostPlaying);
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
        if (patch.mask) e.patchVoice(ev.voiceId, patch);
    });
}

void MkwavezProcessor::publishStatus(const SynthEngine& e) {
    e.status(scratchStatus);
    status.step.store(scratchStatus.step, std::memory_order_relaxed);
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
    const int webVoice = midiSettings.omniVoice.load(std::memory_order_relaxed);
    r.selectedVoice = webVoice >= 0 ? webVoice : juce::roundToInt(ptr.midiVoice->load());
    for (size_t i = 0; i < ccMap.cc.size(); ++i) ccMap.cc[i] = midiSettings.cc[i].load(std::memory_order_relaxed);
    const bool midiOn = midiSettings.enabled.load(std::memory_order_relaxed);
    r.voiceCount = e->voiceIds(r.voiceIds, MAX_ROUTED_VOICES);
    const bool retarget = r.omni != routing.omni || r.selectedVoice != routing.selectedVoice || r.voiceCount != routing.voiceCount ||
                          !std::equal(r.voiceIds, r.voiceIds + r.voiceCount, routing.voiceIds);
    routing = r;
    if (retarget) router.retarget(routing, [&](const MidiVoiceEvent& ev) { e->applyMidi(ev); });

    // Render up to each MIDI event's sample offset, then apply it (sample-accurate).
    float* out = buffer.getWritePointer(0);
    int pos = 0;
    for (const auto meta : midi) {
        const int at = juce::jlimit(pos, frames, meta.samplePosition);
        if (at > pos) e->process(out + pos, at - pos);
        pos = at;
        if (midiOn) handleMidi(*e, meta.getMessage());
    }
    if (frames > pos) e->process(out + pos, frames - pos);

    outGain.setTargetValue(juce::Decibels::decibelsToGain(ptr.gain->load()));
    outGain.applyGain(out, frames);
    for (int c = 1; c < buffer.getNumChannels(); ++c) buffer.copyFrom(c, 0, buffer, 0, 0, frames);

    publishStatus(*e);
}

// ---- state ----

juce::String MkwavezProcessor::projectJson() const {
    const juce::ScopedLock lock(projectLock);
    return project;
}

void MkwavezProcessor::setProjectJson(const juce::String& json) {
    const juce::ScopedLock lock(projectLock);
    project = json;
}

void MkwavezProcessor::getStateInformation(juce::MemoryBlock& destData) {
    juce::ValueTree root("mkwavez");
    root.setProperty("version", state::VERSION, nullptr);
    root.setProperty("project", projectJson(), nullptr);
    root.appendChild(apvts.copyState(), nullptr);
    engineHost.read([&](const Document& doc) { root.appendChild(state::toValueTree(doc), nullptr); });
    juce::MemoryOutputStream out(destData, false);
    root.writeToStream(out);
}

void MkwavezProcessor::setStateInformation(const void* data, int sizeInBytes) {
    const auto root = juce::ValueTree::readFromData(data, (size_t) sizeInBytes);
    if (!root.hasType("mkwavez")) return;
    if (const auto p = root.getChildWithName(apvts.state.getType()); p.isValid()) apvts.replaceState(p);
    Document doc;
    if (state::fromValueTree(root.getChildWithName("document"), doc)) {
        engineHost.load(std::move(doc));
        setProjectJson(root.getProperty("project").toString());
    } else
        setProjectJson({});
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
