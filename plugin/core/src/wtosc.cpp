#include "mkwavez/wtosc.h"

namespace mkwavez {

void WtOsc::resolve(const TableMap& tables, const PackedWavetable& wt, int x0, int x1, int y0, int y1, double pos, double posY, double slew) {
    win = {x0, x1, y0, y1};
    step = wt.interp == Interp::step;
    resolveMix(wt, win, pos, posY, step, mix);
    if (mix.n == 0) return;
    index = mix.x;
    indexY = mix.y;
    if (step) {
        targetId = mix.ids[0];
        if (heldId < 0) {
            if (n > 0) return;
            heldId = targetId;
        }
        if (const MipSet* t = tables.find(heldId)) heldTable = t;
        if (!heldTable) return;
        for (int k = 1; k < n; ++k) tabs[k] = nullptr;
        n = 1;
        ids[0] = heldId;
        tabs[0] = heldTable;
        w0[0] = w1[0] = 1;
        return;
    }
    heldId = targetId = -1;
    heldTable = nullptr;
    double total = 0;
    bool missing = false;
    for (int k = 0; k < mix.n; ++k) {
        if (tables.find(mix.ids[k]))
            total += mix.w[k];
        else
            missing = true;
    }
    if (total <= 0) return;
    const double norm = missing ? 1 / total : 1;
    const bool first = n == 0;
    int32_t nIds[MAX_LIVE];
    const MipSet* nTabs[MAX_LIVE];
    double nW0[MAX_LIVE], nW1[MAX_LIVE];
    int m = 0;
    for (int k = 0; k < n; ++k) {
        const int32_t id = ids[k];
        double w = 0;
        for (int j = 0; j < mix.n; ++j)
            if (mix.ids[j] == id) w = mix.w[j] * norm;
        if (w == 0 && w0[k] == 0) continue;
        nIds[m] = id;
        nTabs[m] = tabs[k];
        nW0[m] = w0[k];
        nW1[m] = w;
        ++m;
    }
    for (int j = 0; j < mix.n && m < MAX_LIVE; ++j) {
        const int32_t id = mix.ids[j];
        const MipSet* t = tables.find(id);
        if (!t) continue;
        bool known = false;
        for (int k = 0; k < m; ++k)
            if (nIds[k] == id) known = true;
        if (known) continue;
        const double w = mix.w[j] * norm;
        nIds[m] = id;
        nTabs[m] = t;
        nW0[m] = first ? w : 0;
        nW1[m] = w;
        ++m;
    }
    double maxDiff = 0;
    for (int k = 0; k < m; ++k) maxDiff = std::max(maxDiff, std::abs(nW1[k] - nW0[k]));
    if (maxDiff > slew) {
        const double f = slew / maxDiff;
        for (int k = 0; k < m; ++k) nW1[k] = nW0[k] + (nW1[k] - nW0[k]) * f;
    }
    for (int k = 0; k < m; ++k) {
        ids[k] = nIds[k];
        tabs[k] = nTabs[k];
        w0[k] = nW0[k];
        w1[k] = nW1[k];
    }
    for (int k = m; k < MAX_LIVE; ++k) tabs[k] = nullptr;
    n = m;
}

double WtOsc::read(double ph, double blockT) const {
    const int off = MIP_OFFSETS[(size_t) mipLevel];
    const int len = MIP_LENGTHS[(size_t) mipLevel];
    const double x = ph * len;
    const int k = (int) x;
    const double fr = x - k;
    const int k1 = off + k;
    const int k2 = k + 1 == len ? off : k1 + 1;
    double out = 0;
    for (int j = 0; j < n; ++j) {
        const float* T = tabs[j]->data();
        const double a0 = T[k1];
        const double w = w0[j] + (w1[j] - w0[j]) * blockT;
        out += (a0 + (T[k2] - a0) * fr) * w;
    }
    return out;
}

void WtOsc::wrapped(const TableMap& tables) {
    if (step && targetId >= 0 && heldId != targetId) {
        if (const MipSet* t = tables.find(targetId)) {
            heldId = targetId;
            heldTable = t;
            for (int j = 1; j < n; ++j) tabs[j] = nullptr;
            n = 1;
            ids[0] = heldId;
            tabs[0] = t;
            w0[0] = w1[0] = 1;
        }
    }
}


} // namespace mkwavez
