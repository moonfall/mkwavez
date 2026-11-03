// Message-thread side of the native engine: owns the engine-facing project state (the
// Document: what the web app's AudioBridge sends the worklet), the memory the engine
// points at, and the lock-free command queue into the audio thread. JUCE-free.
//
// Threads: load() / read() / housekeeping() from any non-audio thread (internally locked);
// drain() / engine() on the audio thread; prepare() while processing is stopped.
#pragma once

#include "mkwavez/engine.h"

#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace mkwavez {

/** Engine-facing project state. Plain data. */
struct Document {
    struct TableData {
        TableId id = 0;
        Table data{};
    };
    struct WavetableData {
        WavetableId id = 0;
        std::string name;
        PackedWavetable packed;
    };
    /** Timeline order. */
    std::vector<TableData> tables;
    std::vector<WavetableData> wavetables;
    std::vector<VoiceParams> voices;
    std::vector<SequenceData> sequences;

    const TableData* table(TableId id) const;
    const WavetableData* wavetable(WavetableId id) const;
    const VoiceParams* voice(int32_t id) const;

    /** The web app's start state: five basic tables, Timeline + Last batch, four voices (V1 unmuted), three sequences. */
    static Document makeDefault();
};

/** One state change for the audio thread (applied in order; a pushed batch lands atomically). */
struct EngineCommand {
    enum Type : uint8_t {
        addTable, removeTable, setWavetable, removeWavetable, setVoice, removeVoice, setSequence, removeSequence
    } type = addTable;
    int32_t id = 0;
    const MipSet* mips = nullptr;
    const PackedWavetable* wavetable = nullptr;
    VoiceParams voice{};
    SequenceData sequence{};
};

class EngineHost {
public:
    static constexpr size_t QUEUE_CAPACITY = 4096;

    EngineHost();
    ~EngineHost();

    // ---- any non-audio thread ----

    /** Replace the whole document (state load, reset). */
    void load(Document doc);
    /** Read the document under the lock (keep `fn` short: the UI calls this per paint). */
    template <typename Fn>
    void read(Fn&& fn) const {
        std::lock_guard<std::mutex> lock(mutex);
        fn(doc);
    }
    /** Free memory the engine retired; send commands that didn't fit the queue. Call from a timer. */
    void housekeeping();
    /** Bytes held for tables / wavetables (live + awaiting retirement), for diagnostics. */
    size_t ownedTables() const;

    // ---- audio side ----

    /** New engine at this rate with the whole document applied (processing must be stopped). */
    void prepare(double sampleRate);
    /** Release the engine (processing stopped). */
    void release();
    SynthEngine* engine() { return eng.get(); }
    /** Apply queued commands. Returns true if any voice was set (re-apply parameter overlays). */
    bool drain();

private:
    /** Under the lock: queue (or, if the queue is full / backlogged, buffer) commands in order. */
    void send(std::vector<EngineCommand>& cmds);
    void flushOutbox();
    void collectRetired();
    const MipSet* mipsFor(const Document::TableData& t);
    void applyAll(SynthEngine& e);

    mutable std::mutex mutex;
    Document doc;
    std::unique_ptr<SynthEngine> eng;
    SpscQueue<EngineCommand> queue{QUEUE_CAPACITY};
    std::deque<EngineCommand> outbox;

    /** What the engine may point at: live allocations by id, retired ones awaiting release. */
    std::map<TableId, std::unique_ptr<MipSet>> mips;
    std::map<WavetableId, std::unique_ptr<PackedWavetable>> packed;
    std::unordered_map<const void*, std::unique_ptr<MipSet>> retiringTables;
    std::unordered_map<const void*, std::unique_ptr<PackedWavetable>> retiringWavetables;
};

} // namespace mkwavez
