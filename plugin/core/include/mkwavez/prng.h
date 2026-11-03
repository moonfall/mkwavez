// Port of src/core/prng.ts: mulberry32 with one uint32 of state, bit-exact with the TS
// version (Math.imul = 32-bit wrapping multiply).
#pragma once

#include <cstdint>

namespace mkwavez {

class Prng {
public:
    explicit Prng(uint32_t seed) : state(seed) {}

    /** Uniform in [0, 1). */
    double next() {
        state += 0x6d2b79f5u;
        uint32_t t = (state ^ (state >> 15)) * (1u | state);
        t = (t + ((t ^ (t >> 7)) * (61u | t))) ^ t;
        return (double) (t ^ (t >> 14)) / 4294967296.0;
    }

    /** Uniform in [-1, 1). */
    double bipolar() { return next() * 2.0 - 1.0; }

    /** Integer in [0, n). */
    int integer(int n) { return (int) (next() * n); }

    uint32_t state;
};

/** Mix a seed with a stream index (splitmix-style) to derive independent seeds. */
inline uint32_t deriveSeed(uint32_t seed, uint32_t index) {
    uint32_t z = seed ^ ((index + 1u) * 0x9e3779b9u);
    z = (z ^ (z >> 16)) * 0x85ebca6bu;
    z = (z ^ (z >> 13)) * 0xc2b2ae35u;
    return z ^ (z >> 16);
}

} // namespace mkwavez
