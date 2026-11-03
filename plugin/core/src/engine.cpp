#include "mkwavez/engine.h"

#include <algorithm>
#include <cmath>

namespace mkwavez {

namespace {

constexpr int MAX_LIVE = detail::VoiceRuntime::MAX_LIVE;

inline uint32_t hashId(TableId id) { return (uint32_t) id * 2654435761u; }

} // namespace

SynthEngine::SynthEngine(double sampleRate)
    : sr(sampleRate),
      bendCoef(1 - std::exp(-CONTROL_BLOCK / (BEND_SMOOTH_SEC * sampleRate))),
      slew(CONTROL_BLOCK / (CROSSFADE_SEC * sampleRate)) {}

// ---- tables: open addressing, linear probing, backward-shift deletion ----

const MipSet* SynthEngine::findTable(TableId id) const {
    constexpr uint32_t mask = TABLE_CAPACITY - 1;
    for (uint32_t i = hashId(id) & mask;; i = (i + 1) & mask) {
        const TableSlot& s = tables[i];
        if (s.mips == nullptr) return nullptr;
        if (s.id == id) return s.mips;
    }
}

void SynthEngine::addTable(TableId id, const MipSet* mips) {
    if (mips == nullptr) return;
    constexpr uint32_t mask = TABLE_CAPACITY - 1;
    for (uint32_t i = hashId(id) & mask;; i = (i + 1) & mask) {
        TableSlot& s = tables[i];
        if (s.mips == nullptr) {
            // Keep the load factor ≤ 3/4 so probes stay short and always terminate.
            if (tableCount_ >= TABLE_CAPACITY * 3 / 4) {
                zombie(Retired::table, mips);
                return;
            }
            s.id = id;
            s.mips = mips;
            ++tableCount_;
            return;
        }
        if (s.id == id) {
            if (s.mips != mips) zombie(Retired::table, s.mips);
            s.mips = mips;
            return;
        }
    }
}

void SynthEngine::removeTable(TableId id) {
    constexpr uint32_t mask = TABLE_CAPACITY - 1;
    uint32_t i = hashId(id) & mask;
    for (;; i = (i + 1) & mask) {
        if (tables[i].mips == nullptr) return;
        if (tables[i].id == id) break;
    }
    zombie(Retired::table, tables[i].mips);
    tables[i] = {};
    --tableCount_;
    // Backward-shift: move later entries of the probe run into the hole.
    for (uint32_t j = (i + 1) & mask; tables[j].mips != nullptr; j = (j + 1) & mask) {
        const uint32_t home = hashId(tables[j].id) & mask;
        // Entry j may move to i if its home is not cyclically within (i, j].
        const bool between = i <= j ? (home > i && home <= j) : (home > i || home <= j);
        if (!between) {
            tables[i] = tables[j];
            tables[j] = {};
            i = j;
        }
    }
}

// ---- wavetables ----

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
    // Wavetables are only read inside resolve(): nothing holds them between blocks.
    if (kind == Retired::wavetable && retired.push({kind, ptr})) return;
    if (nZombies < MAX_ZOMBIES) zombies[(size_t) nZombies++] = {kind, ptr};
    // else: leaked rather than freed while possibly playing (only on absurd churn).
}

void SynthEngine::collectZombies() {
    if (nZombies == 0) return;
    // Pointers voices still play (≤ MAX_VOICES × (MAX_LIVE + 1)), sorted for lookup.
    const void* live[MAX_VOICES * (MAX_LIVE + 1)];
    int nLive = 0;
    for (int i = 0; i < nVoices; ++i) {
        const VoiceRuntime& v = *voices[(size_t) i];
        for (int k = 0; k < v.n; ++k) live[nLive++] = v.tabs[k];
        if (v.heldTable) live[nLive++] = v.heldTable;
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

const SynthEngine::VoiceRuntime* SynthEngine::findVoice(int32_t id) const {
    return const_cast<SynthEngine*>(this)->findVoice(id);
}

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
        v->params = p;
        v->env.configure(p.attack, p.decay, p.sustain, p.release, sr);
        return;
    }
    for (int i = 0; i < nVoices; ++i)
        if (voices[(size_t) i]->params.id == p.id) return; // still fading out
    if (nVoices == MAX_VOICES) return;
    for (auto& slot : pool) {
        if (slot.used) continue;
        slot = VoiceRuntime{};
        slot.used = true;
        slot.params = p;
        slot.lfoPhase = p.lfoPhase;
        slot.lfoPhaseY = p.lfoPhaseY;
        slot.env.configure(p.attack, p.decay, p.sustain, p.release, sr);
        voices[(size_t) nVoices++] = &slot;
        return;
    }
}

void SynthEngine::removeVoice(int32_t id) {
    VoiceRuntime* v = findVoice(id);
    if (!v) return;
    v->removing = true;
    v->gateRemaining = 0;
    const VoiceParams& p = v->params;
    v->env.configure(p.attack, p.decay, p.sustain, REMOVE_RELEASE_SEC, sr);
    v->env.gateOff();
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
            if (!voices[(size_t) i]->notes.size) voices[(size_t) i]->env.gateOff();
    playing = play;
}

void SynthEngine::noteOn(int32_t voiceId, double freq, double gateSamples) {
    VoiceRuntime* v = findVoice(voiceId);
    if (!v || v->notes.size) return;
    v->freq = freq;
    v->vel = 1;
    v->gateRemaining = std::max<int64_t>(1, (int64_t) std::floor(gateSamples + 0.5));
    v->env.gateOn();
    resolvePitch(*v);
}

// ---- MIDI ----

void SynthEngine::midiNoteOn(int32_t voiceId, int note, int velocity) {
    if (velocity <= 0) return midiNoteOff(voiceId, note);
    VoiceRuntime* v = findVoice(voiceId);
    if (!v) return;
    v->notes.push(note, velocity);
    v->freq = midiNoteFreq(note, v->params.octave);
    v->vel = velocityGain(velocity);
    v->gateRemaining = 0;
    v->env.gateOn();
    resolvePitch(*v);
}

void SynthEngine::midiNoteOff(int32_t voiceId, int note) {
    VoiceRuntime* v = findVoice(voiceId);
    if (!v) return;
    const bool wasTop = v->notes.top() == note;
    if (!v->notes.remove(note)) return;
    if (!v->notes.size) {
        v->env.gateOff();
    } else if (wasTop) {
        v->freq = midiNoteFreq(v->notes.top(), v->params.octave);
        v->vel = velocityGain(v->notes.topVelocity());
        resolvePitch(*v);
    }
}

void SynthEngine::midiAllNotesOff(int32_t voiceId) {
    for (int i = 0; i < nVoices; ++i) {
        VoiceRuntime& v = *voices[(size_t) i];
        if (v.removing || (voiceId >= 0 && v.params.id != voiceId) || !v.notes.size) continue;
        v.notes.clear();
        v.env.gateOff();
    }
}

void SynthEngine::patchVoice(int32_t voiceId, const VoicePatch& patch) {
    if (VoiceRuntime* v = findVoice(voiceId)) patch.applyTo(v->params);
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
        case MidiVoiceEvent::cc: return;
    }
}

void SynthEngine::status(EngineStatus& out) const {
    out.tick = tick;
    out.playing = playing;
    out.voiceCount = std::min(nVoices, EngineStatus::MAX);
    for (int i = 0; i < out.voiceCount; ++i) {
        const VoiceRuntime& v = *voices[(size_t) i];
        VoiceStatus& o = out.voices[i];
        o.id = v.params.id;
        o.pos = v.pos;
        o.posY = v.posY;
        o.index = v.index;
        o.y = v.indexY;
        o.env = v.env.value;
        o.note = v.notes.top();
    }
}

// ---- audio ----

void SynthEngine::process(float* out, int frames) {
    // The sequencer clock (as the TS engine): one fractional accumulator per eighth note,
    // split into TICKS_PER_EIGHTH ticks by thresholds within the eighth; each sequence steps
    // on the ticks that are multiples of its STEP_TICKS, counted from the transport start.
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
            } else if (sub < TICKS_PER_EIGHTH - 1 && toNext <= (eighthLen * (TICKS_PER_EIGHTH - 1 - sub)) / TICKS_PER_EIGHTH) {
                ++sub;
                ++tick;
                triggerTick();
            }
            toNext -= 1;
        }

        double mix = 0;
        for (int k = 0; k < nVoices; ++k) mix += renderVoiceSample(*voices[(size_t) k], blockT);
        out[i] = (float) (mix * MASTER_GAIN);
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
    // Drop voices whose removal release has finished.
    int k = 0;
    for (int i = 0; i < nVoices; ++i) {
        VoiceRuntime* v = voices[(size_t) i];
        if (v->removing && v->env.stage == Adsr::Idle) {
            v->used = false;
            v->n = 0;
            v->heldTable = nullptr;
        } else
            voices[(size_t) k++] = v;
    }
    nVoices = k;

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
        resolve(v);
    }
    collectZombies();
}

void SynthEngine::resolvePitch(VoiceRuntime& v) {
    v.mipLevel = mipLevelFor(v.freq * std::max(v.bendFrom, v.bendTo), sr);
    if (v.n == 0) resolve(v);
}

void SynthEngine::resolve(VoiceRuntime& v) {
    const VoiceParams& p = v.params;
    const PackedWavetable* wt = findWavetable(p.wavetableId);
    v.pos = modulatedPosition(p.position, p.lfoDepth, v.lfoPhase);
    v.posY = modulatedPosition(p.positionY, p.lfoDepthY, v.lfoPhaseY);
    v.mipLevel = mipLevelFor(v.freq * std::max(v.bendFrom, v.bendTo), sr);
    // The previous block's end weights are this block's start weights.
    for (int k = 0; k < v.n; ++k) v.w0[k] = v.w1[k];
    if (!wt) return;
    v.win = {p.windowStart, p.windowEnd, p.windowStartY, p.windowEndY};
    v.step = wt->interp == Interp::step;
    const Mix& mix = resolveMix(*wt, v.win, v.pos, v.posY, v.step, v.mix);
    if (mix.n == 0) return;
    v.index = mix.x;
    v.indexY = mix.y;
    if (v.step) {
        v.targetId = mix.ids[0];
        if (v.heldId < 0) {
            // Switched from Blend while sounding: keep the mix until the phase wraps.
            if (v.n > 0) return;
            v.heldId = v.targetId;
        }
        if (const MipSet* t = findTable(v.heldId)) v.heldTable = t;
        if (!v.heldTable) return;
        for (int k = 1; k < v.n; ++k) v.tabs[k] = nullptr;
        v.n = 1;
        v.ids[0] = v.heldId;
        v.tabs[0] = v.heldTable;
        v.w0[0] = v.w1[0] = 1;
        return;
    }
    v.heldId = v.targetId = -1;
    v.heldTable = nullptr;
    double total = 0;
    bool missing = false;
    for (int k = 0; k < mix.n; ++k) {
        if (findTable(mix.ids[k]))
            total += mix.w[k];
        else
            missing = true;
    }
    if (total <= 0) return;
    const double norm = missing ? 1 / total : 1;
    const bool first = v.n == 0;

    int32_t nIds[MAX_LIVE];
    const MipSet* nTabs[MAX_LIVE];
    double nW0[MAX_LIVE], nW1[MAX_LIVE];
    int m = 0;
    for (int k = 0; k < v.n; ++k) {
        const int32_t id = v.ids[k];
        double w = 0;
        for (int j = 0; j < mix.n; ++j)
            if (mix.ids[j] == id) w = mix.w[j] * norm;
        if (w == 0 && v.w0[k] == 0) continue;
        nIds[m] = id;
        nTabs[m] = v.tabs[k];
        nW0[m] = v.w0[k];
        nW1[m] = w;
        ++m;
    }
    for (int j = 0; j < mix.n && m < MAX_LIVE; ++j) {
        const int32_t id = mix.ids[j];
        const MipSet* t = findTable(id);
        if (!t) continue;
        bool known = false;
        for (int k = 0; k < m; ++k)
            if (nIds[k] == id) known = true;
        if (known) continue;
        const double w = mix.w[j] * norm;
        nIds[m] = id;
        nTabs[m] = t;
        nW0[m] = first ? w : 0;
        nW1[m] = w;
        ++m;
    }
    double maxDiff = 0;
    for (int k = 0; k < m; ++k) maxDiff = std::max(maxDiff, std::abs(nW1[k] - nW0[k]));
    if (maxDiff > slew) {
        const double f = slew / maxDiff;
        for (int k = 0; k < m; ++k) nW1[k] = nW0[k] + (nW1[k] - nW0[k]) * f;
    }
    for (int k = 0; k < m; ++k) {
        v.ids[k] = nIds[k];
        v.tabs[k] = nTabs[k];
        v.w0[k] = nW0[k];
        v.w1[k] = nW1[k];
    }
    for (int k = m; k < MAX_LIVE; ++k) v.tabs[k] = nullptr;
    v.n = m;
}

double SynthEngine::renderVoiceSample(VoiceRuntime& v, double blockT) {
    if (v.gateRemaining > 0 && --v.gateRemaining == 0) v.env.gateOff();
    const double e = v.env.next();
    const double target = v.params.mute ? 0 : v.params.level * v.vel;
    v.gain += (target - v.gain) * 0.002;

    double out = 0;
    if (e > 0 && v.n > 0) {
        const int off = MIP_OFFSETS[(size_t) v.mipLevel];
        const int len = MIP_LENGTHS[(size_t) v.mipLevel];
        const double x = v.phase * len;
        const int k = (int) x;
        const double fr = x - k;
        const int k1 = off + k;
        const int k2 = k + 1 == len ? off : k1 + 1;
        for (int j = 0; j < v.n; ++j) {
            const float* T = v.tabs[j]->data();
            const double a0 = T[k1];
            const double w = v.w0[j] + (v.w1[j] - v.w0[j]) * blockT;
            out += (a0 + (T[k2] - a0) * fr) * w;
        }
        out *= e * v.gain;
    }

    v.phase += (v.freq * (v.bendFrom + (v.bendTo - v.bendFrom) * blockT)) / sr;
    if (v.phase >= 1) {
        v.phase -= std::floor(v.phase);
        if (v.step && v.targetId >= 0 && v.heldId != v.targetId) {
            if (const MipSet* t = findTable(v.targetId)) {
                v.heldId = v.targetId;
                v.heldTable = t;
                for (int j = 1; j < v.n; ++j) v.tabs[j] = nullptr;
                v.n = 1;
                v.ids[0] = v.heldId;
                v.tabs[0] = t;
                v.w0[0] = v.w1[0] = 1;
            }
        }
    }
    return out;
}

} // namespace mkwavez
