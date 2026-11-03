// Port of src/core/wavetablePlayback.ts: the packed wavetable the engine plays and the
// position → (tables, weights) mapping shared by the engine and (later) the UI.
// resolveMix() is allocation-free (audio-thread safe).
#pragma once

#include <cstdint>
#include <vector>

namespace mkwavez {

using TableId = int32_t;
using WavetableId = int32_t;

enum class WavetableShape : uint8_t { oneD = 0, twoD = 1, rows = 2 };
enum class Interp : uint8_t { blend = 0, step = 1 };

/** A wavetable as the engine sees it: row offsets + slot ids (-1 = empty). Immutable once shared. */
struct PackedWavetable {
    WavetableShape shape = WavetableShape::oneD;
    Interp interp = Interp::blend;
    /** rowStart[r]..rowStart[r+1] are row r's slots in `ids`; size = rows + 1. */
    std::vector<int32_t> rowStart{0};
    std::vector<int32_t> ids;

    int rowCount() const { return (int) rowStart.size() - 1; }

    /** From row lengths and row-major ids. */
    static PackedWavetable fromRows(WavetableShape shape, Interp interp, const std::vector<std::vector<int32_t>>& rows);
    /** A 1D wavetable over the given ids. */
    static PackedWavetable fromIds(const std::vector<int32_t>& ids, Interp interp = Interp::blend);
};

inline constexpr int MAX_MIX = 4;

/** Up to four (table id, weight) pairs summing to 1, plus the resolved coordinates. */
struct Mix {
    int n = 0;
    int32_t ids[MAX_MIX]{};
    double w[MAX_MIX]{};
    /** Slot within the row / row (fractional for Blend, the chosen cell for Step). */
    double x = 0;
    double y = 0;

    void put(int32_t id, double weight);
};

/** Inclusive window (cell indices). */
struct MixWindow {
    int x0 = 0, x1 = 0, y0 = 0, y1 = 0;
};

/**
 * Position → tables and weights (see the TS docs): 1D uses the x window; 2D bilinear over
 * the rectangle; Rows aligns rows proportionally. Step picks the nearest filled cell. Empty
 * slots / rows are skipped; out.n == 0 only for an empty wavetable.
 */
Mix& resolveMix(const PackedWavetable& p, const MixWindow& win, double px, double py, bool step, Mix& out);

} // namespace mkwavez
