// Port of src/core/engine/svf.ts: zero-delay-feedback state-variable filter (Cytomic
// trapezoidal SVF), LP12 / LP24 (two in series) / HP / BP / notch, plus drive and the soft
// limiter. Header-only, allocation-free.
#pragma once

#include "constants.h"

#include <algorithm>
#include <cmath>

namespace mkwavez {

inline constexpr double MAX_CUTOFF_FRACTION = 0.49;
inline constexpr double MIN_CUTOFF_HZ = 8;

namespace svf_detail {
inline constexpr double LP24_K1 = 1.848;
inline constexpr double LP24_K2 = 0.765;
inline constexpr double K_MIN = 0.01;
} // namespace svf_detail

/** Damping k = 1/Q for resonance 0..1. */
inline double resonanceK(double res) {
    const double r = std::max(0.0, std::min(1.0, res));
    return std::max(svf_detail::K_MIN, 2 * (1 - 0.995 * r));
}

/** g = tan(π·fc / sr), fc clamped to [MIN_CUTOFF_HZ, MAX_CUTOFF_FRACTION·sr]. */
inline double cutoffG(double fc, double sampleRate) {
    const double f = std::max(MIN_CUTOFF_HZ, std::min(MAX_CUTOFF_FRACTION * sampleRate, fc));
    return std::tan((PI * f) / sampleRate);
}

/** One channel of the multimode filter. mode: 0 LP12, 1 LP24, 2 HP, 3 BP, 4 notch. */
class MultiFilter {
public:
    void reset() { s1 = s2 = t1 = t2 = 0; }
    void copyFrom(const MultiFilter& o) {
        s1 = o.s1;
        s2 = o.s2;
        t1 = o.t1;
        t2 = o.t2;
    }
    bool closeTo(const MultiFilter& o, double eps = 1e-6) const {
        return std::abs(s1 - o.s1) < eps && std::abs(s2 - o.s2) < eps && std::abs(t1 - o.t1) < eps && std::abs(t2 - o.t2) < eps;
    }
    void flush() {
        if (std::abs(s1) < 1e-20) s1 = 0;
        if (std::abs(s2) < 1e-20) s2 = 0;
        if (std::abs(t1) < 1e-20) t1 = 0;
        if (std::abs(t2) < 1e-20) t2 = 0;
    }

    double process(double x, int mode, double g, double k) {
        using namespace svf_detail;
        if (mode == 1) {
            const double kk = std::min(LP24_K2, k * (LP24_K2 / 2) + K_MIN * 0.5);
            double a1 = 1 / (1 + g * (g + LP24_K1));
            double a2 = g * a1;
            double a3 = g * a2;
            double v3 = x - s2;
            double v1 = a1 * s1 + a2 * v3;
            double v2 = s2 + a2 * s1 + a3 * v3;
            s1 = 2 * v1 - s1;
            s2 = 2 * v2 - s2;
            a1 = 1 / (1 + g * (g + kk));
            a2 = g * a1;
            a3 = g * a2;
            v3 = v2 - t2;
            v1 = a1 * t1 + a2 * v3;
            v2 = t2 + a2 * t1 + a3 * v3;
            t1 = 2 * v1 - t1;
            t2 = 2 * v2 - t2;
            return v2;
        }
        const double a1 = 1 / (1 + g * (g + k));
        const double a2 = g * a1;
        const double a3 = g * a2;
        const double v3 = x - s2;
        const double v1 = a1 * s1 + a2 * v3;
        const double v2 = s2 + a2 * s1 + a3 * v3;
        s1 = 2 * v1 - s1;
        s2 = 2 * v2 - s2;
        switch (mode) {
            case 0: return v2;
            case 2: return x - k * v1 - v2;
            case 3: return k * v1;
            default: return x - k * v1;
        }
    }

private:
    double s1 = 0, s2 = 0, t1 = 0, t2 = 0;
};

/** Pre-filter drive: clean → tanh saturation (up to 9× gain), normalised. */
inline double driveSample(double x, double drive) {
    if (drive <= 0) return x;
    const double gain = 1 + 8 * drive;
    return x * (1 - drive) + (drive * std::tanh(gain * x)) / std::tanh(gain);
}

/** Linear up to ±1, then bends smoothly towards ±2. */
inline double softLimit(double x) {
    if (x > 1) return 1 + std::tanh(x - 1);
    if (x < -1) return -1 - std::tanh(-x - 1);
    return x;
}

} // namespace mkwavez
