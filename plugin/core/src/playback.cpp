#include "mkwavez/playback.h"

#include <algorithm>
#include <cmath>

namespace mkwavez {

PackedWavetable PackedWavetable::fromRows(WavetableShape shape, Interp interp, const std::vector<std::vector<int32_t>>& rows) {
    PackedWavetable p;
    p.shape = shape;
    p.interp = interp;
    p.rowStart.assign(1, 0);
    for (const auto& r : rows) {
        p.ids.insert(p.ids.end(), r.begin(), r.end());
        p.rowStart.push_back((int32_t) p.ids.size());
    }
    return p;
}

PackedWavetable PackedWavetable::fromIds(const std::vector<int32_t>& ids, Interp interp) {
    return fromRows(WavetableShape::oneD, interp, {ids});
}

void Mix::put(int32_t id, double weight) {
    if (weight <= 0 && n > 0) return;
    for (int k = 0; k < n; ++k) {
        if (ids[k] == id) {
            w[k] += weight;
            return;
        }
    }
    if (n < MAX_MIX) {
        ids[n] = id;
        w[n] = weight;
        ++n;
    }
}

namespace {

struct Line {
    int32_t a = -1, b = -1;
    double w = 0, x = 0;
};

int nearestFilled(const int32_t* ids, int off, int L, int k) {
    for (int d = 0; d < 2 * L; ++d) {
        const int lo = k - d, hi = k + d;
        if (lo >= 0 && lo < L && ids[off + lo] >= 0) return lo;
        if (hi >= 0 && hi < L && ids[off + hi] >= 0) return hi;
        if (lo < 0 && hi >= L) break;
    }
    return -1;
}

bool rowHasFilled(const PackedWavetable& p, int r) {
    for (int k = p.rowStart[(size_t) r]; k < p.rowStart[(size_t) r + 1]; ++k)
        if (p.ids[(size_t) k] >= 0) return true;
    return false;
}

int nearestRow(const PackedWavetable& p, int nRows, int k) {
    for (int d = 0; d < 2 * nRows; ++d) {
        const int lo = k - d, hi = k + d;
        if (lo >= 0 && lo < nRows && rowHasFilled(p, lo)) return lo;
        if (hi >= 0 && hi < nRows && rowHasFilled(p, hi)) return hi;
        if (lo < 0 && hi >= nRows) break;
    }
    return -1;
}

/** JS Math.round: halves round towards +infinity. */
int jsRound(double v) { return (int) std::floor(v + 0.5); }

bool lineMix(const PackedWavetable& p, int r, int x0, int x1, double px, bool step, Line& out) {
    const int off = p.rowStart[(size_t) r];
    const int L = p.rowStart[(size_t) r + 1] - off;
    if (L <= 0) return false;
    int a = 0, b = L - 1;
    if (p.shape != WavetableShape::rows) {
        a = std::max(0, std::min(b, x0));
        const int e = std::max(0, std::min(b, x1));
        if (a > e) {
            b = a;
            a = e;
        } else
            b = e;
    }
    const int32_t* ids = p.ids.data();
    const double rel = px * (b - a);
    if (step) {
        const int k = a + jsRound(rel);
        int best = -1;
        for (int d = 0; d <= L; ++d) {
            const int lo = k - d, hi = k + d;
            const bool inLo = lo >= a && lo <= b;
            const bool inHi = hi >= a && hi <= b;
            if (!inLo && !inHi) break;
            if (inLo && ids[off + lo] >= 0) {
                best = lo;
                break;
            }
            if (inHi && ids[off + hi] >= 0) {
                best = hi;
                break;
            }
        }
        if (best < 0) best = nearestFilled(ids, off, L, k);
        if (best < 0) return false;
        out.a = out.b = ids[off + best];
        out.w = 0;
        out.x = best;
        return true;
    }
    const double flD = std::floor(rel);
    const int fl = (int) flD;
    const int i = a + fl;
    int left = -1;
    for (int x = i; x >= a; --x) {
        if (ids[off + x] >= 0) {
            left = x;
            break;
        }
    }
    int right = -1;
    for (int x = i + 1; x <= b; ++x) {
        if (ids[off + x] >= 0) {
            right = x;
            break;
        }
    }
    out.x = a + rel;
    if (left >= 0 && right >= 0) {
        out.a = ids[off + left];
        out.b = ids[off + right];
        out.w = right - left == 1 && left == i ? rel - flD : (rel - (left - a)) / (right - left);
        return true;
    }
    int k = left >= 0 ? left : right;
    if (k < 0) k = nearestFilled(ids, off, L, jsRound(out.x));
    if (k < 0) return false;
    out.a = out.b = ids[off + k];
    out.w = 0;
    return true;
}

} // namespace

Mix& resolveMix(const PackedWavetable& p, const MixWindow& win, double px, double py, bool step, Mix& out) {
    out.n = 0;
    const int nRows = p.rowCount();
    if (nRows <= 0 || p.ids.empty()) return out;
    int y0 = 0, y1 = 0;
    if (p.shape != WavetableShape::oneD) {
        const int max = nRows - 1;
        y0 = std::max(0, std::min(max, win.y0));
        y1 = std::max(0, std::min(max, win.y1));
        if (y0 > y1) std::swap(y0, y1);
    }
    const double relY = py * (y1 - y0);
    Line line;
    if (step) {
        const int k = y0 + jsRound(relY);
        int row = -1;
        for (int d = 0; d <= nRows; ++d) {
            const int lo = k - d, hi = k + d;
            if (lo < y0 && hi > y1) break;
            if (lo >= y0 && lo <= y1 && rowHasFilled(p, lo)) {
                row = lo;
                break;
            }
            if (hi >= y0 && hi <= y1 && rowHasFilled(p, hi)) {
                row = hi;
                break;
            }
        }
        if (row < 0) row = nearestRow(p, nRows, k);
        if (row < 0 || !lineMix(p, row, win.x0, win.x1, px, true, line)) return out;
        out.put(line.a, 1);
        out.x = line.x;
        out.y = row;
        return out;
    }
    const double flD = std::floor(relY);
    const int fl = (int) flD;
    const int i = y0 + fl;
    int top = -1;
    for (int r = i; r >= y0; --r) {
        if (rowHasFilled(p, r)) {
            top = r;
            break;
        }
    }
    int bot = -1;
    for (int r = i + 1; r <= y1; ++r) {
        if (rowHasFilled(p, r)) {
            bot = r;
            break;
        }
    }
    double wy = 0;
    if (top >= 0 && bot >= 0)
        wy = bot - top == 1 && top == i ? relY - flD : (relY - (top - y0)) / (bot - top);
    else if (top < 0 && bot < 0) {
        top = nearestRow(p, nRows, jsRound(y0 + relY));
        if (top < 0) return out;
    } else if (top < 0)
        top = bot;
    if (bot < 0 || wy == 0) bot = top;
    out.y = y0 + relY;
    lineMix(p, top, win.x0, win.x1, px, false, line);
    out.x = line.x;
    const int32_t a0 = line.a, b0 = line.b;
    const double w0 = line.w;
    out.put(a0, (1 - wy) * (1 - w0));
    out.put(b0, (1 - wy) * w0);
    if (bot != top) {
        lineMix(p, bot, win.x0, win.x1, px, false, line);
        out.put(line.a, wy * (1 - line.w));
        out.put(line.b, wy * line.w);
    }
    return out;
}

} // namespace mkwavez
