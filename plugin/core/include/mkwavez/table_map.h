// Table id → mip set: fixed-capacity open addressing (linear probing, backward-shift
// deletion). No allocation after construction; lookups are audio-thread safe.
#pragma once

#include "dsp.h"
#include "playback.h"

#include <array>
#include <cstdint>

namespace mkwavez {

class TableMap {
public:
    /** Power of two, > 2 × TIMELINE_CAP; the load factor is kept ≤ 3/4. */
    static constexpr int CAPACITY = 16384;

    const MipSet* find(TableId id) const {
        for (uint32_t i = home(id);; i = (i + 1) & MASK) {
            const Slot& s = slots[i];
            if (s.mips == nullptr) return nullptr;
            if (s.id == id) return s.mips;
        }
    }

    /** Insert or replace. Returns the replaced pointer (or `mips` itself if the map is full), else nullptr. */
    const MipSet* insert(TableId id, const MipSet* mips) {
        for (uint32_t i = home(id);; i = (i + 1) & MASK) {
            Slot& s = slots[i];
            if (s.mips == nullptr) {
                if (count >= CAPACITY * 3 / 4) return mips;
                s = {id, mips};
                ++count;
                return nullptr;
            }
            if (s.id == id) {
                const MipSet* old = s.mips != mips ? s.mips : nullptr;
                s.mips = mips;
                return old;
            }
        }
    }

    /** Remove; returns the removed pointer or nullptr. */
    const MipSet* erase(TableId id) {
        uint32_t i = home(id);
        for (;; i = (i + 1) & MASK) {
            if (slots[i].mips == nullptr) return nullptr;
            if (slots[i].id == id) break;
        }
        const MipSet* old = slots[i].mips;
        slots[i] = {};
        --count;
        for (uint32_t j = (i + 1) & MASK; slots[j].mips != nullptr; j = (j + 1) & MASK) {
            const uint32_t h = home(slots[j].id);
            const bool between = i <= j ? (h > i && h <= j) : (h > i || h <= j);
            if (!between) {
                slots[i] = slots[j];
                slots[j] = {};
                i = j;
            }
        }
        return old;
    }

    int size() const { return count; }

private:
    static constexpr uint32_t MASK = CAPACITY - 1;
    static uint32_t home(TableId id) { return ((uint32_t) id * 2654435761u) & MASK; }
    struct Slot {
        TableId id = -1;
        const MipSet* mips = nullptr;
    };
    std::array<Slot, CAPACITY> slots{};
    int count = 0;
};

} // namespace mkwavez
