// Port of src/core/engine/wtOsc.ts: one wavetable oscillator's table mix (tracked by table
// id), weights ramped across each control block. Shared by the Simple voice and the Synth
// voice's oscillators A and B. Fixed arrays, no allocation.
#pragma once

#include "playback.h"
#include "table_map.h"

#include <algorithm>
#include <cmath>

namespace mkwavez {

class WtOsc {
public:
    static constexpr int MAX_LIVE = 16;

    double phase = 0;
    int mipLevel = 0;
    bool step = false;
    double index = 0, indexY = 0;
    int n = 0;
    int32_t ids[MAX_LIVE]{};
    const MipSet* tabs[MAX_LIVE]{};
    double w0[MAX_LIVE]{}, w1[MAX_LIVE]{};
    Mix mix;
    MixWindow win;
    TableId heldId = -1;
    const MipSet* heldTable = nullptr;
    TableId targetId = -1;

    /** Block start = previous block end. */
    void hold() {
        for (int k = 0; k < n; ++k) w0[k] = w1[k];
    }

    void resolve(const TableMap& tables, const PackedWavetable& wt, int x0, int x1, int y0, int y1, double pos, double posY, double slew);
    /** Mixed sample at `ph` (0..1), `blockT` through the block. */
    double read(double ph, double blockT) const;
    /** Phase wrapped: in Step mode, take the pending target table. */
    void wrapped(const TableMap& tables);

    /** Every table pointer this oscillator may still read (for retirement). */
    template <typename Fn>
    void forEachTable(Fn&& fn) const {
        for (int k = 0; k < n; ++k) fn(tabs[k]);
        if (heldTable) fn(heldTable);
    }

    void clear() {
        n = 0;
        heldTable = nullptr;
        for (auto& t : tabs) t = nullptr;
    }
};

} // namespace mkwavez
