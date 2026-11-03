#include "mkwavez/engine.h"

#include <algorithm>
#include <cmath>

namespace mkwavez {

namespace {
constexpr int TICKS_PER_EIGHTH_ = TICKS_PER_EIGHTH;
}

SynthEngine::SynthEngine(double sampleRate)
    : sr(sampleRate),
      bendCoef(1 - std::exp(-CONTROL_BLOCK / (BEND_SMOOTH_SEC * sampleRate))),
      slew(CONTROL_BLOCK / (CROSSFADE_SEC * sampleRate)) {
    typeStep = 1 / (TYPE_FADE_SEC * sampleRate);
    ctl.tables = &tables;
}

// ---- tables / wavetables ----

void SynthEngine::addTable(TableId id, const MipSet* mips) {
    if (mips == nullptr) return;
    if (const MipSet* old = tables.insert(id, mips)) zombie(Retired::table, old);
}

void SynthEngine::removeTable(TableId id) {
    if (const MipSet* old = tables.erase(id)) zombie(Retired::table, old);
}

const PackedWavetable* SynthEngine::findWavetable(WavetableId id) const {
    for (int i = 0; i < nWavetables; ++i)
        if (wavetables[(size_t) i].id == id) return wavetables[(size_t) i].wt;
    return nullptr;
}

void SynthEngine::setWavetable(WavetableId id, const PackedWavetable* wt) {
    if (wt == nullptr) return;
    for (int i = 0; i < nWavetables; ++i) {
        auto& s = wavetables[(size_t) i];
        if (s.id == id) {
            if (s.wt != wt) zombie(Retired::wavetable, s.wt);
            s.wt = wt;
            return;
        }
    }
    if (nWavetables == MAX_WAVETABLES) {
        zombie(Retired::wavetable, wt);
        return;
    }
    wavetables[(size_t) nWavetables++] = {id, wt};
}

void SynthEngine::removeWavetable(WavetableId id) {
    for (int i = 0; i < nWavetables; ++i) {
        if (wavetables[(size_t) i].id != id) continue;
        zombie(Retired::wavetable, wavetables[(size_t) i].wt);
        for (int k = i; k + 1 < nWavetables; ++k) wavetables[(size_t) k] = wavetables[(size_t) k + 1];
        --nWavetables;
        return;
    }
}

// ---- retirement ----

void SynthEngine::zombie(Retired::Kind kind, const void* ptr) {
    if (ptr == nullptr) return;
    // Wavetables are only read inside a control block: nothing holds them between blocks.
    if (kind == Retired::wavetable && retired.push({kind, ptr})) return;
    if (nZombies < MAX_ZOMBIES) zombies[(size_t) nZombies++] = {kind, ptr};
}

void SynthEngine::collectZombies() {
    if (nZombies == 0) return;
    // Pointers voices may still read (Simple osc + Synth A / B), sorted for lookup.
    constexpr int PER_VOICE = 3 * (WtOsc::MAX_LIVE + 1);
    const void* live[MAX_VOICES * PER_VOICE];
    int nLive = 0;
    const auto add = [&](const MipSet* t) { live[nLive++] = t; };
    for (int i = 0; i < nVoices; ++i) {
        const VoiceRuntime& v = *voices[(size_t) i];
        v.osc.forEachTable(add);
        if (v.syn) v.syn->forEachTable(add);
    }
    std::sort(live, live + nLive);
    int kept = 0;
    for (int z = 0; z < nZombies; ++z) {
        const Retired r = zombies[(size_t) z];
        const bool inUse = r.kind == Retired::table && std::binary_search(live, live + nLive, r.ptr);
        if (inUse || !retired.push(r)) zombies[(size_t) kept++] = r;
    }
    nZombies = kept;
}

// ---- voices ----

SynthEngine::VoiceRuntime* SynthEngine::findVoice(int32_t id) {
    for (int i = 0; i < nVoices; ++i) {
        VoiceRuntime* v = voices[(size_t) i];
        if (v->params.id == id && !v->removing) return v;
    }
    return nullptr;
}

const SynthEngine::VoiceRuntime* SynthEngine::findVoice(int32_t id) const { return const_cast<SynthEngine*>(this)->findVoice(id); }

const VoiceParams* SynthEngine::voiceParams(int32_t id) const {
    const VoiceRuntime* v = findVoice(id);
    return v ? &v->params : nullptr;
}

int SynthEngine::voiceIds(int32_t* out, int max) const {
    int n = 0;
    for (int i = 0; i < nVoices && n < max; ++i)
        if (!voices[(size_t) i]->removing) out[n++] = voices[(size_t) i]->params.id;
    return n;
}

void SynthEngine::setVoice(const VoiceParams& p) {
    if (VoiceRuntime* v = findVoice(p.id)) {
        applyParams(*v, p);
        return;
    }
    for (int i = 0; i < nVoices; ++i)
        if (voices[(size_t) i]->params.id == p.id) return; // still fading out
    if (nVoices == MAX_VOICES) return;
    for (auto& slot : pool) {
        if (slot.used) continue;
        slot.used = true;
        slot.params = p;
        slot.env = Adsr{};
        slot.osc = WtOsc{};
        slot.lfoPhase = p.lfoPhase;
        slot.lfoPhaseY = p.lfoPhaseY;
        slot.freq = 110;
        slot.gateRemaining = 0;
        slot.gain = 0;
        slot.vel = 1;
        slot.notes = NoteStack{};
        slot.bendTarget = slot.bendSemis = 0;
        slot.bendFrom = slot.bendTo = 1;
        slot.pos = slot.posY = 0;
        slot.removing = false;
        slot.syn.reset();
        slot.typeMix = 0;
        slot.wheel = slot.pressure = 0;
        slot.env.configure(p.attack, p.decay, p.sustain, p.release, sr);
        if (p.type == VoiceType::synth) {
            slot.syn.emplace(sr, p.id, CONTROL_BLOCK, p.synth);
            slot.typeMix = 1;
        }
        voices[(size_t) nVoices++] = &slot;
        return;
    }
}

void SynthEngine::applyParams(VoiceRuntime& v, const VoiceParams& p) {
    const bool wasSynth = v.params.type == VoiceType::synth;
    v.params = p;
    v.env.configure(p.attack, p.decay, p.sustain, p.release, sr);
    if (p.type == VoiceType::synth && (!v.syn || !wasSynth)) {
        // Becoming a Synth voice: its path starts at the current note, envelopes in step with the gate.
        if (!v.syn) v.syn.emplace(sr, p.id, CONTROL_BLOCK, p.synth);
        v.syn->vel = v.notes.size ? v.notes.topVelocity() / 127.0 : 1;
        v.syn->resync(p, freqPitch(v.freq), v.notes.size > 0 || v.gateRemaining > 0, v.env.stage != Adsr::Idle && v.typeMix > 0);
    }
}

void SynthEngine::removeVoice(int32_t id) {
    VoiceRuntime* v = findVoice(id);
    if (!v) return;
    v->removing = true;
    v->gateRemaining = 0;
    const VoiceParams& p = v->params;
    v->env.configure(p.attack, p.decay, p.sustain, REMOVE_RELEASE_SEC, sr);
    gateOff(*v);
}

void SynthEngine::gateOff(VoiceRuntime& v) {
    v.env.gateOff();
    if (v.syn) v.syn->gateOff(v.params);
}

void SynthEngine::synthNote(VoiceRuntime& v, double velocity, bool legato, bool retrigger) {
    if (v.syn) v.syn->noteOn(v.params, freqPitch(v.freq), velocity, legato, retrigger, v.env.stage != Adsr::Idle);
}

// ---- sequences / transport ----

void SynthEngine::setSequence(const SequenceData& s) {
    for (int i = 0; i < nSequences; ++i) {
        if (sequences[(size_t) i].id == s.id) {
            sequences[(size_t) i] = s;
            return;
        }
    }
    if (nSequences < MAX_SEQUENCES) sequences[(size_t) nSequences++] = s;
}

void SynthEngine::removeSequence(int32_t id) {
    int k = 0;
    for (int i = 0; i < nSequences; ++i)
        if (sequences[(size_t) i].id != id) sequences[(size_t) k++] = sequences[(size_t) i];
    nSequences = k;
}

void SynthEngine::setTransport(bool play, double newBpm) {
    bpm = std::max(20.0, std::min(400.0, newBpm));
    if (play && !playing) {
        tick = -1;
        toNext = 0;
        sub = 0;
    }
    if (!play && playing)
        for (int i = 0; i < nVoices; ++i)
            if (!voices[(size_t) i]->notes.size) gateOff(*voices[(size_t) i]);
    playing = play;
}

void SynthEngine::noteOn(int32_t voiceId, double freq, double gateSamples) {
    VoiceRuntime* v = findVoice(voiceId);
    if (!v || v->notes.size) return;
    v->freq = freq;
    v->vel = 1;
    v->gateRemaining = std::max<int64_t>(1, (int64_t) std::floor(gateSamples + 0.5));
    synthNote(*v, 1, false, true);
    v->env.gateOn();
    resolvePitch(*v);
}

// ---- MIDI ----

void SynthEngine::midiNoteOn(int32_t voiceId, int note, int velocity) {
    if (velocity <= 0) return midiNoteOff(voiceId, note);
    VoiceRuntime* v = findVoice(voiceId);
    if (!v) return;
    const bool legato = v->notes.size > 0;
    v->notes.push(note, velocity);
    v->freq = midiNoteFreq(note, v->params.octave);
    v->vel = velocityGain(velocity);
    v->gateRemaining = 0;
    synthNote(*v, std::min(127, velocity) / 127.0, legato, true);
    v->env.gateOn();
    resolvePitch(*v);
}

void SynthEngine::midiNoteOff(int32_t voiceId, int note) {
    VoiceRuntime* v = findVoice(voiceId);
    if (!v) return;
    const bool wasTop = v->notes.top() == note;
    if (!v->notes.remove(note)) return;
    if (!v->notes.size) {
        gateOff(*v);
    } else if (wasTop) {
        v->freq = midiNoteFreq(v->notes.top(), v->params.octave);
        v->vel = velocityGain(v->notes.topVelocity());
        synthNote(*v, v->notes.topVelocity() / 127.0, true, false);
        resolvePitch(*v);
    }
}

void SynthEngine::midiAllNotesOff(int32_t voiceId) {
    for (int i = 0; i < nVoices; ++i) {
        VoiceRuntime& v = *voices[(size_t) i];
        if (v.removing || (voiceId >= 0 && v.params.id != voiceId) || !v.notes.size) continue;
        v.notes.clear();
        gateOff(v);
    }
}

void SynthEngine::patchVoice(int32_t voiceId, const VoicePatch& patch) {
    if (VoiceRuntime* v = findVoice(voiceId)) {
        VoiceParams p = v->params;
        patch.applyTo(p);
        applyParams(*v, p);
    }
}

void SynthEngine::setPitchBend(int32_t voiceId, double semitones) {
    if (VoiceRuntime* v = findVoice(voiceId)) v->bendTarget = semitones;
}

void SynthEngine::applyMidi(const MidiVoiceEvent& ev) {
    switch (ev.type) {
        case MidiVoiceEvent::noteOn: return midiNoteOn(ev.voiceId, ev.note, ev.velocity);
        case MidiVoiceEvent::noteOff: return midiNoteOff(ev.voiceId, ev.note);
        case MidiVoiceEvent::allNotesOff: return midiAllNotesOff(ev.voiceId);
        case MidiVoiceEvent::bend: return setPitchBend(ev.voiceId, ev.semitones);
        case MidiVoiceEvent::mod:
        case MidiVoiceEvent::pressure:
            if (VoiceRuntime* v = findVoice(ev.voiceId)) {
                const double x = std::max(0.0, std::min(1.0, ev.semitones));
                (ev.type == MidiVoiceEvent::mod ? v->wheel : v->pressure) = x;
            }
            return;
        case MidiVoiceEvent::cc: return;
    }
}

void SynthEngine::status(EngineStatus& out) const {
    out.tick = tick;
    out.playing = playing;
    out.unisonLimited = unisonLimited;
    out.voiceCount = std::min(nVoices, EngineStatus::MAX);
    for (int i = 0; i < out.voiceCount; ++i) {
        const VoiceRuntime& v = *voices[(size_t) i];
        VoiceStatus& o = out.voices[i];
        o.id = v.params.id;
        if (v.params.type == VoiceType::synth && v.syn) {
            const SynthVoice& s = *v.syn;
            o.pos = s.posA;
            o.posY = s.posYA;
            o.index = s.a.index;
            o.y = s.a.indexY;
            o.posB = s.posB;
            o.posYB = s.posYB;
            o.indexB = s.b.index;
            o.yB = s.b.indexY;
        } else {
            o.pos = o.posB = v.pos;
            o.posY = o.posYB = v.posY;
            o.index = o.indexB = v.osc.index;
            o.y = o.yB = v.osc.indexY;
        }
        o.env = v.env.value;
        o.note = v.notes.top();
    }
}

// ---- audio ----

void SynthEngine::process(float* out, int frames, float* outR) {
    const double eighth = stepSamples(bpm, sr, StepLength::eighth);
    for (int i = 0; i < frames; ++i) {
        if (ctrlCountdown <= 0) {
            control(CONTROL_BLOCK);
            ctrlCountdown = CONTROL_BLOCK;
        }
        const double blockT = 1 - (double) ctrlCountdown / CONTROL_BLOCK;
        --ctrlCountdown;

        if (playing) {
            if (toNext <= 0) {
                toNext += eighth;
                eighthLen = eighth;
                sub = 0;
                ++tick;
                triggerTick();
            } else if (sub < TICKS_PER_EIGHTH_ - 1 && toNext <= (eighthLen * (TICKS_PER_EIGHTH_ - 1 - sub)) / TICKS_PER_EIGHTH_) {
                ++sub;
                ++tick;
                triggerTick();
            }
            toNext -= 1;
        }

        double left = 0, right = 0;
        for (int k = 0; k < nVoices; ++k) {
            VoiceRuntime& v = *voices[(size_t) k];
            if (!v.syn || (v.typeMix == 0 && v.params.type != VoiceType::synth)) {
                const double s = renderVoiceSample(v, blockT);
                left += s;
                right += s;
            } else {
                double l = 0, r = 0;
                renderMixed(v, blockT, l, r);
                left += l;
                right += r;
            }
        }
        if (outR) {
            out[i] = (float) (left * MASTER_GAIN);
            outR[i] = (float) (right * MASTER_GAIN);
        } else
            out[i] = (float) ((left + right) * 0.5 * MASTER_GAIN);
    }
}

void SynthEngine::triggerTick() {
    for (int i = 0; i < nSequences; ++i) {
        const SequenceData& s = sequences[(size_t) i];
        if (s.voiceId < 0 || s.length <= 0) continue;
        const int ticks = STEP_TICKS[(size_t) s.stepLength];
        if (tick % ticks != 0) continue;
        const int row = s.steps[(size_t) ((tick / ticks) % s.length)];
        if (row < 0) continue;
        VoiceRuntime* v = findVoice(s.voiceId);
        if (!v || v->notes.size) continue;
        noteOn(s.voiceId, noteFreq(row, v->params.octave), stepSamples(bpm, sr, s.stepLength) * s.gate);
    }
}

void SynthEngine::control(int blockLen) {
    int k = 0;
    for (int i = 0; i < nVoices; ++i) {
        VoiceRuntime* v = voices[(size_t) i];
        if (v->removing && v->env.stage == Adsr::Idle) {
            v->used = false;
            v->osc.clear();
            v->syn.reset();
        } else
            voices[(size_t) k++] = v;
    }
    nVoices = k;

    // CPU guard: unison copies of the Synth voices holding a note.
    int copies = 0;
    for (int i = 0; i < nVoices; ++i) {
        const VoiceRuntime& v = *voices[(size_t) i];
        if (!v.syn || v.params.type != VoiceType::synth || (!v.notes.size && v.gateRemaining <= 0)) continue;
        const SynthParams& s = v.params.synth;
        copies += s.aUnison + (s.bLevel > 0 || s.ringLevel > 0 || s.fm > 0 || s.sync ? s.bUnison : 0);
    }
    const double low = UNISON_BUDGET * 0.75;
    if (copies > UNISON_BUDGET)
        unisonLimited = true;
    else if (copies <= low)
        unisonLimited = false;
    ctl.unisonScale = unisonLimited ? std::min(1.0, (double) UNISON_BUDGET / copies) : 1;
    ctl.beat = playing && tick >= 0 && eighthLen > 0
                   ? ((double) (tick / TICKS_PER_EIGHTH_) + std::min(1.0, std::max(0.0, 1 - toNext / eighthLen))) / 2
                   : -1;

    for (int i = 0; i < nVoices; ++i) {
        VoiceRuntime& v = *voices[(size_t) i];
        v.lfoPhase += (2 * PI * v.params.lfoRate * blockLen) / sr;
        if (v.lfoPhase > 2 * PI) v.lfoPhase -= 2 * PI;
        v.lfoPhaseY += (2 * PI * v.params.lfoRateY * blockLen) / sr;
        if (v.lfoPhaseY > 2 * PI) v.lfoPhaseY -= 2 * PI;
        if (v.bendSemis != v.bendTarget || v.bendFrom != v.bendTo) {
            v.bendSemis += (v.bendTarget - v.bendSemis) * bendCoef;
            if (std::abs(v.bendTarget - v.bendSemis) < 1e-4) v.bendSemis = v.bendTarget;
            v.bendFrom = v.bendTo;
            v.bendTo = std::pow(2.0, v.bendSemis / 12);
        }
        const bool synthOnly = v.params.type == VoiceType::synth && v.typeMix == 1;
        if (!synthOnly) resolve(v);
        if (v.syn && (v.params.type == VoiceType::synth || v.typeMix > 0)) controlSynth(v, blockLen);
    }
    collectZombies();
}

void SynthEngine::controlSynth(VoiceRuntime& v, int blockLen) {
    const VoiceParams& p = v.params;
    const SynthParams& s = p.synth;
    ctl.bend = v.bendSemis;
    ctl.blockLen = blockLen;
    ctl.wtA = findWavetable(p.wavetableId);
    ctl.wtB = findWavetable(s.b.wavetableId);
    ctl.slew = slew;
    ctl.gainTarget = p.mute ? 0 : p.level * (1 - s.velAmp + s.velAmp * v.vel);
    ctl.bpm = bpm;
    ctl.wheel = v.wheel;
    ctl.pressure = v.pressure;
    v.syn->control(p, ctl);
}

void SynthEngine::resolvePitch(VoiceRuntime& v) {
    v.osc.mipLevel = mipLevelFor(v.freq * std::max(v.bendFrom, v.bendTo), sr);
    if (v.osc.n == 0) resolve(v);
}

void SynthEngine::resolve(VoiceRuntime& v) {
    const VoiceParams& p = v.params;
    const PackedWavetable* wt = findWavetable(p.wavetableId);
    v.pos = modulatedPosition(p.position, p.lfoDepth, v.lfoPhase);
    v.posY = modulatedPosition(p.positionY, p.lfoDepthY, v.lfoPhaseY);
    v.osc.mipLevel = mipLevelFor(v.freq * std::max(v.bendFrom, v.bendTo), sr);
    v.osc.hold();
    if (!wt) return;
    v.osc.resolve(tables, *wt, p.windowStart, p.windowEnd, p.windowStartY, p.windowEndY, v.pos, v.posY, slew);
}

double SynthEngine::renderVoiceSample(VoiceRuntime& v, double blockT) {
    if (v.gateRemaining > 0 && --v.gateRemaining == 0) gateOff(v);
    const double e = v.env.next();
    return simpleSample(v, e, blockT);
}

double SynthEngine::simpleSample(VoiceRuntime& v, double e, double blockT) {
    const double target = v.params.mute ? 0 : v.params.level * v.vel;
    v.gain += (target - v.gain) * 0.002;
    WtOsc& o = v.osc;
    double out = 0;
    if (e > 0 && o.n > 0) out = o.read(o.phase, blockT) * (e * v.gain);
    o.phase += (v.freq * (v.bendFrom + (v.bendTo - v.bendFrom) * blockT)) / sr;
    if (o.phase >= 1) {
        o.phase -= std::floor(o.phase);
        o.wrapped(tables);
    }
    return out;
}

void SynthEngine::renderMixed(VoiceRuntime& v, double blockT, double& l, double& r) {
    if (v.gateRemaining > 0 && --v.gateRemaining == 0) gateOff(v);
    const double e = v.env.next();
    const double target = v.params.type == VoiceType::synth ? 1 : 0;
    if (v.typeMix < target)
        v.typeMix = std::min(1.0, v.typeMix + typeStep);
    else if (v.typeMix > target)
        v.typeMix = std::max(0.0, v.typeMix - typeStep);
    const double m = v.typeMix;
    SynthVoice& syn = *v.syn;
    double simple = 0;
    if (m < 1) simple = simpleSample(v, e, blockT) * (1 - m);
    l = simple;
    r = simple;
    if (m > 0) {
        syn.render(v.params, e, blockT, tables);
        l += syn.outL * m * (syn.panL0 + (syn.panL1 - syn.panL0) * blockT);
        r += syn.outR * m * (syn.panR0 + (syn.panR1 - syn.panR0) * blockT);
    }
}

} // namespace mkwavez
