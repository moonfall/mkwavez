// Bounded lock-free single-producer / single-consumer queue (no allocation after
// construction). push / pushBatch on the producer thread, pop on the consumer thread.
// A batch becomes visible to the consumer all at once (one release store).
#pragma once

#include <atomic>
#include <cstddef>
#include <memory>

namespace mkwavez {

template <typename T>
class SpscQueue {
public:
    /** Holds up to `capacity` items. */
    explicit SpscQueue(size_t capacity) : cap(capacity + 1), buf(std::make_unique<T[]>(capacity + 1)) {}

    size_t capacity() const { return cap - 1; }

    /** Free slots as seen by the producer. */
    size_t freeSpace() const {
        const size_t w = writeIdx.load(std::memory_order_relaxed);
        const size_t r = readIdx.load(std::memory_order_acquire);
        return (r + cap - w - 1) % cap;
    }

    bool push(const T& item) { return pushBatch(&item, 1); }

    /** All of items[0..n) or nothing. */
    bool pushBatch(const T* items, size_t n) {
        if (n > freeSpace()) return false;
        size_t w = writeIdx.load(std::memory_order_relaxed);
        for (size_t i = 0; i < n; ++i) {
            buf[w] = items[i];
            w = (w + 1) % cap;
        }
        writeIdx.store(w, std::memory_order_release);
        return true;
    }

    bool pop(T& out) {
        const size_t r = readIdx.load(std::memory_order_relaxed);
        if (r == writeIdx.load(std::memory_order_acquire)) return false;
        out = buf[r];
        readIdx.store((r + 1) % cap, std::memory_order_release);
        return true;
    }

    bool empty() const { return readIdx.load(std::memory_order_acquire) == writeIdx.load(std::memory_order_acquire); }

private:
    const size_t cap;
    std::unique_ptr<T[]> buf;
    alignas(64) std::atomic<size_t> writeIdx{0};
    alignas(64) std::atomic<size_t> readIdx{0};
};

} // namespace mkwavez
