// Ports of src/core/engine/adsr.ts and noteStack.ts.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace mkwavez {

/**
 * ADSR: linear attack, exponential decay / release (time constant = stage time / 4).
 * Retriggering starts the attack from the current level.
 */
class Adsr {
public:
    enum Stage : uint8_t { Idle = 0, Attack = 1, Decay = 2, Sustain = 3, Release = 4 };

    void configure(double attack, double decay, double sustain, double release, double sampleRate) {
        attackInc = 1 / std::max(1.0, attack * sampleRate);
        decayCoef = std::exp(-4 / std::max(1.0, decay * sampleRate));
        releaseCoef = std::exp(-4 / std::max(1.0, release * sampleRate));
        sustainLevel = std::max(0.0, std::min(1.0, sustain));
    }

    void gateOn() { stage = Attack; }
    void gateOff() {
        if (stage != Idle) stage = Release;
    }

    double next() {
        switch (stage) {
            case Idle: return 0;
            case Attack:
                value += attackInc;
                if (value >= 1) {
                    value = 1;
                    stage = Decay;
                }
                break;
            case Decay:
                value = sustainLevel + (value - sustainLevel) * decayCoef;
                if (std::abs(value - sustainLevel) < 1e-4) {
                    value = sustainLevel;
                    stage = Sustain;
                }
                break;
            case Sustain:
                value = sustainLevel;
                if (sustainLevel <= 0) stage = Idle;
                break;
            case Release:
                value *= releaseCoef;
                if (value < 1e-5) {
                    value = 0;
                    stage = Idle;
                }
                break;
        }
        return value;
    }

    Stage stage = Idle;
    double value = 0;

private:
    double attackInc = 1, decayCoef = 0, releaseCoef = 0, sustainLevel = 1;
};

/**
 * Held keys of one monophonic voice (last-note priority), fixed capacity; refcounted so
 * the same note held from two channels stays held until both release it.
 */
class NoteStack {
public:
    static constexpr int CAPACITY = 16;

    int size = 0;

    int top() const { return size ? notes[size - 1] : -1; }
    int topVelocity() const { return size ? vels[size - 1] : 0; }
    bool has(int note) const { return indexOf(note) >= 0; }

    void push(int note, int velocity) {
        const int i = indexOf(note);
        int count = 1;
        if (i >= 0) {
            count = std::min(255, counts[i] + 1);
            removeAt(i);
        }
        if (size == CAPACITY) removeAt(0);
        notes[size] = (int16_t) note;
        vels[size] = (uint8_t) velocity;
        counts[size] = (uint8_t) count;
        ++size;
    }

    /** Release one holder: true if the note is no longer held at all. */
    bool remove(int note) {
        const int i = indexOf(note);
        if (i < 0) return false;
        if (--counts[i] > 0) return false;
        removeAt(i);
        return true;
    }

    void clear() { size = 0; }

private:
    int indexOf(int note) const {
        for (int i = 0; i < size; ++i)
            if (notes[i] == note) return i;
        return -1;
    }
    void removeAt(int i) {
        for (int k = i; k + 1 < size; ++k) {
            notes[k] = notes[k + 1];
            vels[k] = vels[k + 1];
            counts[k] = counts[k + 1];
        }
        --size;
    }

    int16_t notes[CAPACITY]{};
    uint8_t vels[CAPACITY]{};
    uint8_t counts[CAPACITY]{};
};

} // namespace mkwavez
