// Port of src/core/midi.ts for one MIDI input (a plugin host delivers a single stream):
// message parsing, channel → voice routing with note / bend tracking, velocity curve,
// pitch-bend scale and the CC → parameter map. Allocation-free (audio-thread safe): the
// router emits events through a callback.
#pragma once

#include "voice.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

namespace mkwavez {

inline constexpr double BEND_RANGE_SEMITONES = 2;
inline constexpr int CC_MOD_WHEEL = 1;
inline constexpr int CC_ALL_SOUND_OFF = 120;
inline constexpr int CC_RESET_ALL_CONTROLLERS = 121;
inline constexpr int CC_ALL_NOTES_OFF = 123;
inline constexpr int CC_MAX_ASSIGNABLE = 119;
inline constexpr double LFO_RATE_MIN = 0.02;
inline constexpr double LFO_RATE_MAX = 4;

/** Squared velocity curve over 40 dB: 127 = 1, 1 = 0.01 + …, 0 = 0. */
inline double velocityGain(int velocity) {
    if (velocity <= 0) return 0;
    const double x = std::min(127, velocity) / 127.0;
    return 0.01 + 0.99 * x * x;
}

/** Equal-tempered note frequency (A4 = 69 = 440 Hz), shifted by the voice octave. */
inline double midiNoteFreq(int note, double octave = 0) { return 440 * std::pow(2.0, (note - 69) / 12.0 + octave); }

/** Bend -1..1 → semitones. */
inline double bendSemitones(double value) { return std::max(-1.0, std::min(1.0, value)) * BEND_RANGE_SEMITONES; }

/** Channels are 1..16; bend value -1..1. */
struct MidiMessage {
    enum Kind : uint8_t { none, noteOn, noteOff, cc, bend } kind = none;
    int channel = 1;
    int a = 0; // note / controller
    int b = 0; // velocity / controller value
    double value = 0; // bend
};

/** One complete MIDI message (no running status). Note-on velocity 0 = note-off. */
inline MidiMessage parseMidi(const uint8_t* data, int size) {
    MidiMessage m;
    if (size < 2) return m;
    const int status = data[0];
    if (status < 0x80 || status >= 0xf0) return m;
    const int type = status & 0xf0;
    m.channel = (status & 0x0f) + 1;
    const int d1 = data[1] & 0x7f;
    const bool hasD2 = size >= 3;
    const int d2 = hasD2 ? data[2] & 0x7f : 0;
    if (!hasD2) return m;
    switch (type) {
        case 0x80: m.kind = MidiMessage::noteOff; m.a = d1; break;
        case 0x90: m.kind = d2 == 0 ? MidiMessage::noteOff : MidiMessage::noteOn; m.a = d1; m.b = d2; break;
        case 0xb0: m.kind = MidiMessage::cc; m.a = d1; m.b = d2; break;
        case 0xe0: {
            const int v = ((d2 << 7) | d1) - 8192;
            m.kind = MidiMessage::bend;
            m.value = v >= 0 ? v / 8191.0 : v / 8192.0;
            break;
        }
        default: break;
    }
    return m;
}

/** Engine events (one voice each). allNotesOff with voiceId -1 = every voice. */
struct MidiVoiceEvent {
    enum Type : uint8_t { noteOn, noteOff, allNotesOff, bend, cc } type = noteOn;
    int voiceId = -1;
    int note = 0; // note, or controller for cc
    int velocity = 0; // velocity, or controller value for cc
    double semitones = 0;
};

inline constexpr int MAX_ROUTED_VOICES = 16;

struct MidiRouting {
    /** Omni: every channel → selectedVoice; otherwise channel N → voice id N. */
    bool omni = true;
    int selectedVoice = -1;
    int voiceIds[MAX_ROUTED_VOICES]{};
    int voiceCount = 0;

    bool hasVoice(int id) const {
        for (int i = 0; i < voiceCount; ++i)
            if (voiceIds[i] == id) return true;
        return false;
    }
    int target(int channel) const {
        const int id = omni ? selectedVoice : channel;
        return id >= 0 && hasVoice(id) ? id : -1;
    }
};

/**
 * Remembers where each held note went so its note-off reaches the same voice even if the
 * routing changed, and which voice each channel's wheel is bending.
 */
class MidiRouter {
public:
    MidiRouter() { reset(); }

    void reset() {
        for (auto& ch : held) ch.fill(-1);
        for (auto& b : bent) b = {-1, 0};
    }

    template <typename Emit>
    void route(const MidiMessage& msg, const MidiRouting& r, Emit&& emit) {
        const int ch = msg.channel - 1;
        switch (msg.kind) {
            case MidiMessage::none: return;
            case MidiMessage::noteOn: {
                int& slot = held[(size_t) ch][(size_t) msg.a];
                if (slot >= 0) {
                    emit(MidiVoiceEvent{MidiVoiceEvent::noteOff, slot, msg.a, 0, 0});
                    slot = -1;
                }
                const int v = r.target(msg.channel);
                if (v < 0) return;
                slot = v;
                emit(MidiVoiceEvent{MidiVoiceEvent::noteOn, v, msg.a, msg.b, 0});
                return;
            }
            case MidiMessage::noteOff: {
                int& slot = held[(size_t) ch][(size_t) msg.a];
                if (slot < 0) return;
                emit(MidiVoiceEvent{MidiVoiceEvent::noteOff, slot, msg.a, 0, 0});
                slot = -1;
                return;
            }
            case MidiMessage::bend: {
                Bent& b = bent[(size_t) ch];
                const int v = r.target(msg.channel);
                if (b.voiceId >= 0 && b.voiceId != v) emit(MidiVoiceEvent{MidiVoiceEvent::bend, b.voiceId, 0, 0, 0});
                b = {-1, 0};
                if (v < 0) return;
                const double semis = bendSemitones(msg.value);
                if (std::abs(semis) > 0) b = {v, semis};
                emit(MidiVoiceEvent{MidiVoiceEvent::bend, v, 0, 0, semis});
                return;
            }
            case MidiMessage::cc: {
                if (msg.a == CC_ALL_NOTES_OFF || msg.a == CC_ALL_SOUND_OFF) return channelOff(msg.channel, r, emit);
                if (msg.a == CC_RESET_ALL_CONTROLLERS) {
                    Bent& b = bent[(size_t) ch];
                    if (b.voiceId >= 0) emit(MidiVoiceEvent{MidiVoiceEvent::bend, b.voiceId, 0, 0, 0});
                    b = {-1, 0};
                    return;
                }
                const int v = r.target(msg.channel);
                if (v >= 0) emit(MidiVoiceEvent{MidiVoiceEvent::cc, v, msg.a, msg.b, 0});
                return;
            }
        }
    }

    /** Routing changed: a held-off-centre wheel moves to its channel's new voice. */
    template <typename Emit>
    void retarget(const MidiRouting& r, Emit&& emit) {
        for (int ch = 0; ch < 16; ++ch) {
            Bent& b = bent[(size_t) ch];
            if (b.voiceId < 0) continue;
            const int v = r.target(ch + 1);
            if (v == b.voiceId) continue;
            emit(MidiVoiceEvent{MidiVoiceEvent::bend, b.voiceId, 0, 0, 0});
            if (v < 0)
                b = {-1, 0};
            else {
                b.voiceId = v;
                emit(MidiVoiceEvent{MidiVoiceEvent::bend, v, 0, 0, b.semitones});
            }
        }
    }

    /** Release everything (e.g. playback reset) and recentre all bends. */
    template <typename Emit>
    void releaseAll(Emit&& emit) {
        int voices[MAX_ROUTED_VOICES];
        int n = 0;
        for (auto& ch : held)
            for (auto& v : ch) {
                if (v < 0) continue;
                bool seen = false;
                for (int i = 0; i < n; ++i) seen |= voices[i] == v;
                if (!seen && n < MAX_ROUTED_VOICES) voices[n++] = v;
                v = -1;
            }
        for (int i = 0; i < n; ++i) emit(MidiVoiceEvent{MidiVoiceEvent::allNotesOff, voices[i], 0, 0, 0});
        for (auto& b : bent) {
            if (b.voiceId >= 0) emit(MidiVoiceEvent{MidiVoiceEvent::bend, b.voiceId, 0, 0, 0});
            b = {-1, 0};
        }
    }

    int heldCount() const {
        int n = 0;
        for (const auto& ch : held)
            for (int v : ch) n += v >= 0;
        return n;
    }

private:
    template <typename Emit>
    void channelOff(int channel, const MidiRouting& r, Emit&& emit) {
        // Voices with notes from this channel, plus the voice the channel plays now.
        int voices[MAX_ROUTED_VOICES];
        int n = 0;
        auto add = [&](int v) {
            for (int i = 0; i < n; ++i)
                if (voices[i] == v) return;
            if (n < MAX_ROUTED_VOICES) voices[n++] = v;
        };
        for (int v : held[(size_t) channel - 1])
            if (v >= 0) add(v);
        const int now = r.target(channel);
        if (now >= 0) add(now);
        // Forget every note (any channel) routed to those voices.
        for (auto& ch : held)
            for (auto& v : ch)
                for (int i = 0; i < n; ++i)
                    if (v == voices[i]) v = -1;
        for (int i = 0; i < n; ++i) emit(MidiVoiceEvent{MidiVoiceEvent::allNotesOff, voices[i], 0, 0, 0});
    }

    struct Bent {
        int voiceId;
        double semitones;
    };
    std::array<std::array<int, 128>, 16> held{};
    std::array<Bent, 16> bent{};
};

// ---- CC → parameter map ----

enum class CcParam : uint8_t { position, positionY, lfoDepth, lfoRate, level };
inline constexpr int CC_PARAM_COUNT = 5;

/** Parameter → controller (0..119) or -1. Default: mod wheel → position X. */
struct CcMap {
    std::array<int, CC_PARAM_COUNT> cc{CC_MOD_WHEEL, -1, -1, -1, -1};

    /** A controller drives one parameter: assigning it removes it elsewhere. */
    void assign(CcParam p, int controller) {
        const int c = controller >= 0 && controller <= CC_MAX_ASSIGNABLE ? controller : -1;
        if (c >= 0)
            for (auto& x : cc)
                if (x == c) x = -1;
        cc[(size_t) p] = c;
    }
};

/** A 7-bit controller value → that parameter's value (LFO rate exponential). */
inline double ccValue(CcParam p, int value) {
    const double x = std::max(0, std::min(127, value)) / 127.0;
    if (p == CcParam::lfoRate) return LFO_RATE_MIN * std::pow(LFO_RATE_MAX / LFO_RATE_MIN, x);
    return x;
}

/** The voice patch a controller move makes (mask 0 if unmapped). */
inline VoicePatch ccPatch(const CcMap& map, int controller, int value) {
    static constexpr VoicePatch::Field fields[CC_PARAM_COUNT] = {VoicePatch::position, VoicePatch::positionY, VoicePatch::lfoDepth,
                                                                VoicePatch::lfoRate, VoicePatch::level};
    VoicePatch patch;
    for (int i = 0; i < CC_PARAM_COUNT; ++i)
        if (map.cc[(size_t) i] == controller) patch.set(fields[i], ccValue((CcParam) i, value));
    return patch;
}

} // namespace mkwavez
