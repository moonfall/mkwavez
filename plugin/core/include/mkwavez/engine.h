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
#include "voice.h"

#include <array>
#include <cstdint>

namespace mkwavez {

inline constexpr double MASTER_GAIN = 0.22;
/** Release used when a voice is removed while sounding. */
inline constexpr double REMOVE_RELEASE_SEC = 0.012;
/** Pitch-bend smoothing time constant. */
inline constexpr double BEND_SMOOTH_SEC = 0.004;
/** Longest a mix change takes (weights slew-limited). */
inline constexpr double CROSSFADE_SEC = 0.006;

struct VoiceStatus {
    int32_t id = 0;
    double pos = 0, posY = 0, index = 0, y = 0, env = 0;
    int32_t note = -1;
};

struct EngineStatus {
    static constexpr int MAX = 16;
    int64_t step = -1;
    bool playing = false;
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
    static constexpr int MAX_LIVE = 16;
    bool used = false;
    VoiceParams params;
    Adsr env;
    double phase = 0;
    double lfoPhase = 0, lfoPhaseY = 0;
    double freq = 110;
    int64_t gateRemaining = 0;
    double gain = 0;
    double vel = 1;
    NoteStack notes;
    double bendTarget = 0, bendSemis = 0, bendFrom = 1, bendTo = 1;
    double pos = 0, posY = 0, index = 0, indexY = 0;
    int mipLevel = 0;
    bool step = false;
    /** Tables being mixed (by id), weights ramping w0 → w1 across the control block. */
    int n = 0;
    int32_t ids[MAX_LIVE]{};
    const MipSet* tabs[MAX_LIVE]{};
    double w0[MAX_LIVE]{}, w1[MAX_LIVE]{};
    Mix mix;
    MixWindow win;
    TableId heldId = -1;
    const MipSet* heldTable = nullptr;
    TableId targetId = -1;
    bool removing = false;
};

} // namespace detail

class SynthEngine {
public:
    static constexpr int MAX_VOICES = 16;
    static constexpr int MAX_SEQUENCES = 32;
    static constexpr int MAX_WAVETABLES = 64;
    /** Open-addressing table map capacity (power of two, > 2 × TIMELINE_CAP). */
    static constexpr int TABLE_CAPACITY = 16384;
    /** Removed tables / replaced wavetables awaiting retirement. */
    static constexpr int MAX_ZOMBIES = 8192;

    explicit SynthEngine(double sampleRate);

    double sampleRate() const { return sr; }

    // ---- state commands ----
    /** Add (or replace) a table. A replaced pointer is retired like a removed one. */
    void addTable(TableId id, const MipSet* mips);
    void removeTable(TableId id);
    bool hasTable(TableId id) const { return findTable(id) != nullptr; }
    int tableCount() const { return tableCount_; }

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
    /** Render `frames` mono samples. */
    void process(float* out, int frames);

    // ---- memory ----
    bool popRetired(Retired& out) { return retired.pop(out); }

private:
    using VoiceRuntime = detail::VoiceRuntime;
    struct TableSlot {
        TableId id = -1;
        const MipSet* mips = nullptr;
    };
    struct WavetableSlot {
        WavetableId id = -1;
        const PackedWavetable* wt = nullptr;
    };

    const MipSet* findTable(TableId id) const;
    VoiceRuntime* findVoice(int32_t id);
    const VoiceRuntime* findVoice(int32_t id) const;
    const PackedWavetable* findWavetable(WavetableId id) const;
    void zombie(Retired::Kind kind, const void* ptr);
    void collectZombies();

    void triggerStep(double stepLen);
    void control(int blockLen);
    void resolvePitch(VoiceRuntime& v);
    void resolve(VoiceRuntime& v);
    double renderVoiceSample(VoiceRuntime& v, double blockT);

    double sr;
    double bendCoef;
    double slew;

    std::array<TableSlot, TABLE_CAPACITY> tables{};
    int tableCount_ = 0;

    std::array<WavetableSlot, MAX_WAVETABLES> wavetables{};
    int nWavetables = 0;

    std::array<VoiceRuntime, MAX_VOICES> pool{};
    std::array<VoiceRuntime*, MAX_VOICES> voices{}; // creation order; nVoices used
    int nVoices = 0;
    std::array<SequenceData, MAX_SEQUENCES> sequences{};
    int nSequences = 0;

    bool playing = false;
    double bpm = 132;
    int64_t step = -1;
    double toNext = 0;
    int ctrlCountdown = 0;

    std::array<Retired, MAX_ZOMBIES> zombies{};
    int nZombies = 0;
    SpscQueue<Retired> retired{MAX_ZOMBIES};
};

} // namespace mkwavez
