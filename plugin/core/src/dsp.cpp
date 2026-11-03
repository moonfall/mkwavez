#include "mkwavez/dsp.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace mkwavez {

void fft(double* re, double* im, int n, bool inverse) {
    for (int i = 1, j = 0; i < n; ++i) {
        int bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            std::swap(re[i], re[j]);
            std::swap(im[i], im[j]);
        }
    }
    for (int len = 2; len <= n; len <<= 1) {
        const double ang = ((inverse ? 2.0 : -2.0) * PI) / len;
        const double wr = std::cos(ang);
        const double wi = std::sin(ang);
        const int half = len >> 1;
        for (int i = 0; i < n; i += len) {
            double cr = 1, ci = 0;
            for (int k = 0; k < half; ++k) {
                const int u = i + k;
                const int v = u + half;
                const double tr = re[v] * cr - im[v] * ci;
                const double ti = re[v] * ci + im[v] * cr;
                re[v] = re[u] - tr;
                im[v] = im[u] - ti;
                re[u] += tr;
                im[u] += ti;
                const double nc = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = nc;
            }
        }
    }
    if (inverse) {
        for (int i = 0; i < n; ++i) {
            re[i] /= n;
            im[i] /= n;
        }
    }
}

namespace {
constexpr double ALIGN_EPS = 1e-6;
}

Table shape(const double* x, ShapeOptions opts) {
    constexpr int n = TABLE_SIZE;
    const int kmax = std::min(opts.kmax, n / 2 - 1);
    const double kc = opts.lowpassHarmonic;

    std::vector<double> re(x, x + n), im(n, 0.0);
    for (auto& v : re)
        if (!std::isfinite(v)) v = 0;
    fft(re.data(), im.data(), n, false);

    re[0] = 0;
    im[0] = 0;
    double maxMag = 0;
    for (int k = 1; k < n / 2; ++k) {
        const double w = k > kmax ? 0 : kc > 0 ? std::exp(-(k / kc) * (k / kc)) : 1;
        re[(size_t) k] *= w;
        im[(size_t) k] *= w;
        maxMag = std::max(maxMag, std::hypot(re[(size_t) k], im[(size_t) k]));
    }

    if (maxMag > 0) {
        int k0 = 0;
        for (int k = 1; k <= kmax; ++k) {
            if (std::hypot(re[(size_t) k], im[(size_t) k]) > maxMag * ALIGN_EPS) {
                k0 = k;
                break;
            }
        }
        if (k0 > 0) {
            const double phi = std::atan2(im[(size_t) k0], re[(size_t) k0]);
            const double delta = (-PI / 2 - phi) / k0;
            for (int k = 1; k <= kmax; ++k) {
                const double c = std::cos(k * delta);
                const double s = std::sin(k * delta);
                const double r = re[(size_t) k] * c - im[(size_t) k] * s;
                im[(size_t) k] = re[(size_t) k] * s + im[(size_t) k] * c;
                re[(size_t) k] = r;
            }
        }
    }

    for (int k = 1; k < n / 2; ++k) {
        re[(size_t) (n - k)] = re[(size_t) k];
        im[(size_t) (n - k)] = -im[(size_t) k];
    }
    re[n / 2] = 0;
    im[n / 2] = 0;
    fft(re.data(), im.data(), n, true);

    Table y{};
    double peak = 0;
    for (int i = 0; i < n; ++i) peak = std::max(peak, std::abs(re[(size_t) i]));
    if (peak > 1e-12)
        for (int i = 0; i < n; ++i) y[(size_t) i] = (float) (re[(size_t) i] / peak);
    return y;
}

const char* basicWaveName(BasicWave w) {
    switch (w) {
        case BasicWave::sine: return "sine";
        case BasicWave::tri: return "tri";
        case BasicWave::saw: return "saw";
        case BasicWave::square: return "square";
        case BasicWave::p25: return "p25";
        case BasicWave::p10: return "p10";
    }
    return "?";
}

namespace {

template <typename Amp>
Table additive(Amp amp) {
    std::vector<double> x(TABLE_SIZE, 0.0);
    for (int k = 1; k <= KMAX; ++k) {
        const double a = amp(k);
        if (a == 0) continue;
        const double w = (2 * PI * k) / TABLE_SIZE;
        for (int i = 0; i < TABLE_SIZE; ++i) x[(size_t) i] += a * std::sin(w * i);
    }
    return shape(x.data());
}

Table pulse(double duty) {
    std::vector<double> x(TABLE_SIZE);
    for (int i = 0; i < TABLE_SIZE; ++i) x[(size_t) i] = i < duty * TABLE_SIZE ? 1 : -1;
    return shape(x.data());
}

} // namespace

Table basicWave(BasicWave w) {
    switch (w) {
        case BasicWave::sine: return additive([](int k) { return k == 1 ? 1.0 : 0.0; });
        case BasicWave::tri:
            return additive([](int k) { return k % 2 ? ((((k - 1) / 2) % 2) ? -1.0 : 1.0) / (k * k) : 0.0; });
        case BasicWave::saw: return additive([](int k) { return 1.0 / k; });
        case BasicWave::square: return additive([](int k) { return k % 2 ? 1.0 / k : 0.0; });
        case BasicWave::p25: return pulse(0.25);
        case BasicWave::p10: return pulse(0.1);
    }
    throw std::invalid_argument("basicWave");
}

MipSet buildMipSet(const Table& table) {
    std::vector<double> re(table.begin(), table.end()), im(TABLE_SIZE, 0.0);
    fft(re.data(), im.data(), TABLE_SIZE, false);
    MipSet out{};
    std::vector<double> lr, li;
    for (int l = 0; l < MIP_LEVELS; ++l) {
        const int len = MIP_LENGTHS[(size_t) l];
        const int K = std::min(MIP_HARMONICS[(size_t) l], len / 2 - 1);
        lr.assign((size_t) len, 0.0);
        li.assign((size_t) len, 0.0);
        const double scale = (double) len / TABLE_SIZE;
        for (int k = 1; k <= K; ++k) {
            lr[(size_t) k] = re[(size_t) k] * scale;
            li[(size_t) k] = im[(size_t) k] * scale;
            lr[(size_t) (len - k)] = lr[(size_t) k];
            li[(size_t) (len - k)] = -li[(size_t) k];
        }
        fft(lr.data(), li.data(), len, true);
        const int off = MIP_OFFSETS[(size_t) l];
        for (int i = 0; i < len; ++i) out[(size_t) (off + i)] = (float) lr[(size_t) i];
    }
    return out;
}

int mipLevelFor(double freq, double sampleRate) {
    const double limit = MIP_NYQUIST_FRACTION * sampleRate;
    for (int l = 0; l < MIP_LEVELS; ++l)
        if (freq * MIP_HARMONICS[(size_t) l] < limit) return l;
    return MIP_LEVELS - 1;
}

} // namespace mkwavez
