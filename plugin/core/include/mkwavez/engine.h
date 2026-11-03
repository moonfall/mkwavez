// Port of src/core/engine/engine.ts: everything that runs on the audio thread. Fixed pools
// instead of Maps / arrays, no allocation, no locks. Command methods correspond 1:1 to the
// TS engine (and the worklet protocol); call them on the audio thread between process()
// calls (the plugin drains a lock-free command queue at the top of each block).
//
// Memory: tables (MipSet) and wavetables are owned by the caller and passed by pointer.
// The engine never frees them. A pointer stays in use after removeTable / a replacing
// setWavetable until no voice plays it any more (a table fading out, a held Step table);
// the engine then hands it back through popRetired() (consumer side: any one thread),
// and only then may the owner free it. Give every addTable its own allocation.
#pragma once

#include "dsp.h"
#include "envelope.h"
#include "midi.h"
#include "playback.h"
#include "spsc_queue.h"
#include "synth_voice.h"
#include "table_map.h"
#include "voice.h"
#include "wtosc.h"

#include <array>
#include <cstdint>
#include <optional>

namespace mkwavez {

inline constexpr double MASTER_GAIN = 0.22;
/** Release used when a voice is removed while sounding. */
inline constexpr double REMOVE_RELEASE_SEC = 0.012;
/** Pitch-bend smoothing time constant. */
inline constexpr double BEND_SMOOTH_SEC = 0.004;
/** Longest a mix change takes (weights slew-limited). */
inline constexpr double CROSSFADE_SEC = 0.006;
/** Simple ↔ Synth switch of a sounding voice crossfades over this long. */
inline constexpr double TYPE_FADE_SEC = 0.01;
/** CPU guard: unison copies all sounding Synth voices may play together. */
inline constexpr int UNISON_BUDGET = 32;

struct VoiceStatus {
    int32_t id = 0;
    double pos = 0, posY = 0, index = 0, y = 0, env = 0;
    int32_t note = -1;
    /** Synth voices: osc B's position and resolved coordinates (else equal to A's). */
    double posB = 0, posYB = 0, indexB = 0, yB = 0;
};

struct EngineStatus {
    static constexpr int MAX = 16;
    /** Shared clock: ticks since the transport started (TICKS_PER_BEAT per beat; -1 before the first). */
    int64_t tick = -1;
    bool playing = false;
    /** The CPU guard is reducing unison. */
    bool unisonLimited = false;
    int voiceCount = 0;
    VoiceStatus voices[MAX];
};

/** A pointer the engine no longer references (see the header comment). */
struct Retired {
    enum Kind : uint8_t { table, wavetable } kind = table;
    const void* ptr = nullptr;
};

namespace detail {

/** Per-voice audio-thread state (see the TS VoiceRuntime). */
struct VoiceRuntime {
    bool used = false;
    VoiceParams params;
    Adsr env;
    /** The Simple voice's oscillator. */
    WtOsc osc;
    double lfoPhase = 0, lfoPhaseY = 0;
    double freq = 110;
    int64_t gateRemaining = 0;
    double gain = 0;
    double vel = 1;
    NoteStack notes;
    double bendTarget = 0, bendSemis = 0, bendFrom = 1, bendTo = 1;
    double pos = 0, posY = 0;
    bool removing = false;
    /** The Synth path (constructed in place when the voice first becomes a Synth voice; no heap). */
    std::optional<SynthVoice> syn;
    /** Simple (0) ↔ Synth (1) crossfade. */
    double typeMix = 0;
    /** Mod wheel / channel pressure 0..1. */
    double wheel = 0, pressure = 0;
};

} // namespace detail

class SynthEngine {
public:
    static constexpr int MAX_VOICES = 16;
    static constexpr int MAX_SEQUENCES = 32;
    static constexpr int MAX_WAVETABLES = 64;
    /** Removed tables / replaced wavetables awaiting retirement. */
    static constexpr int MAX_ZOMBIES = 8192;

    explicit SynthEngine(double sampleRate);

    double sampleRate() const { return sr; }

    // ---- state commands ----
    /** Add (or replace) a table. A replaced pointer is retired like a removed one. */
    void addTable(TableId id, const MipSet* mips);
    void removeTable(TableId id);
    bool hasTable(TableId id) const { return findTable(id) != nullptr; }
    int tableCount() const { return tables.size(); }

    void setWavetable(WavetableId id, const PackedWavetable* wt);
    void removeWavetable(WavetableId id);

    void setVoice(const VoiceParams& p);
    void removeVoice(int32_t id);
    int voiceCount() const { return nVoices; }

    void setSequence(const SequenceData& s);
    void removeSequence(int32_t id);

    void setTransport(bool playing, double bpm);

    /** A sequencer note (ignored while MIDI keys are held on the voice). */
    void noteOn(int32_t voiceId, double freq, double gateSamples);

    void midiNoteOn(int32_t voiceId, int note, int velocity);
    void midiNoteOff(int32_t voiceId, int note);
    void midiAllNotesOff(int32_t voiceId);
    void patchVoice(int32_t voiceId, const VoicePatch& patch);
    void setPitchBend(int32_t voiceId, double semitones);
    /** Note / bend / all-notes-off events (cc events are ignored: map them with ccPatch). */
    void applyMidi(const MidiVoiceEvent& ev);

    /** Current params of a (non-removing) voice, or nullptr. */
    const VoiceParams* voiceParams(int32_t id) const;
    /** Ids of the voices that exist (not fading out), in creation order. */
    int voiceIds(int32_t* out, int max) const;

    void status(EngineStatus& out) const;

    // ---- audio ----
    /**
     * Render `frames` samples: stereo into out (left) and outR (right), or, without outR,
     * the mono sum ((L + R) / 2) into out. Simple voices are identical in both channels.
     */
    void process(float* out, int frames, float* outR = nullptr);

    // ---- memory ----
    bool popRetired(Retired& out) { return retired.pop(out); }

private:
    using VoiceRuntime = detail::VoiceRuntime;
    struct WavetableSlot {
        WavetableId id = -1;
        const PackedWavetable* wt = nullptr;
    };

    const MipSet* findTable(TableId id) const { return tables.find(id); }
    VoiceRuntime* findVoice(int32_t id);
    const VoiceRuntime* findVoice(int32_t id) const;
    const PackedWavetable* findWavetable(WavetableId id) const;
    void zombie(Retired::Kind kind, const void* ptr);
    void collectZombies();

    void triggerTick();
    void applyParams(VoiceRuntime& v, const VoiceParams& p);
    void gateOff(VoiceRuntime& v);
    void synthNote(VoiceRuntime& v, double vel, bool legato, bool retrigger);
    void controlSynth(VoiceRuntime& v, int blockLen);
    double simpleSample(VoiceRuntime& v, double e, double blockT);
    void renderMixed(VoiceRuntime& v, double blockT, double& l, double& r);
    void control(int blockLen);
    void resolvePitch(VoiceRuntime& v);
    void resolve(VoiceRuntime& v);
    double renderVoiceSample(VoiceRuntime& v, double blockT);
    double typeStep;
    SynthControl ctl;
    bool unisonLimited = false;

    double sr;
    double bendCoef;
    double slew;

    TableMap tables;

    std::array<WavetableSlot, MAX_WAVETABLES> wavetables{};
    int nWavetables = 0;

    std::array<VoiceRuntime, MAX_VOICES> pool{};
    std::array<VoiceRuntime*, MAX_VOICES> voices{}; // creation order; nVoices used
    int nVoices = 0;
    std::array<SequenceData, MAX_SEQUENCES> sequences{};
    int nSequences = 0;

    bool playing = false;
    double bpm = 132;
    /** Clock tick; -1 before the first. */
    int64_t tick = -1;
    /** Samples until the next eighth note (fractional accumulator). */
    double toNext = 0;
    /** Length of the eighth in progress (a tempo change takes effect on the next one). */
    double eighthLen = 0;
    /** Ticks into the eighth in progress (0..TICKS_PER_EIGHTH-1). */
    int sub = 0;
    int ctrlCountdown = 0;

    std::array<Retired, MAX_ZOMBIES> zombies{};
    int nZombies = 0;
    SpscQueue<Retired> retired{MAX_ZOMBIES};
};

} // namespace mkwavez
