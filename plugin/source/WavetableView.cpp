#include "WavetableView.h"

#include "Theme.h"

using namespace mkwavez;

namespace {

void drawWave(juce::Graphics& g, const Table& t, juce::Rectangle<float> r, juce::Colour c) {
    juce::Path p;
    const int steps = juce::jmax(8, (int) r.getWidth());
    for (int i = 0; i <= steps; ++i) {
        const float x = r.getX() + r.getWidth() * (float) i / (float) steps;
        const float v = t[(size_t) ((i * (TABLE_SIZE - 1)) / steps)];
        const float y = r.getCentreY() - v * r.getHeight() * 0.42f;
        if (i == 0)
            p.startNewSubPath(x, y);
        else
            p.lineTo(x, y);
    }
    g.setColour(c);
    g.strokePath(p, juce::PathStrokeType(1.2f));
}

} // namespace

void WavetableView::paint(juce::Graphics& g) {
    const auto bounds = getLocalBounds().toFloat();
    g.setColour(theme::panel);
    g.fillRoundedRectangle(bounds, 6);

    // Live position of this voice.
    const auto& st = proc.liveStatus();
    float liveX = -1, liveY = -1;
    const int n = st.voiceCount.load(std::memory_order_acquire);
    for (int i = 0; i < n; ++i) {
        if (st.voices[(size_t) i].id.load() == voice) {
            liveX = st.voices[(size_t) i].index.load();
            liveY = st.voices[(size_t) i].y.load();
        }
    }

    proc.host().read([&](const Document& doc) {
        const VoiceParams* v = doc.voice(voice);
        const auto* wt = v ? doc.wavetable(v->wavetableId) : nullptr;
        if (!wt || wt->packed.ids.empty()) {
            g.setColour(theme::dim);
            g.drawText("Empty wavetable", getLocalBounds(), juce::Justification::centred);
            return;
        }
        const auto& p = wt->packed;
        const int rows = p.rowCount();
        int cols = 1;
        for (int r = 0; r < rows; ++r) cols = juce::jmax(cols, p.rowStart[(size_t) r + 1] - p.rowStart[(size_t) r]);
        const auto area = bounds.reduced(8).withTrimmedTop(18);
        g.setColour(theme::dim);
        g.setFont(12.0f);
        g.drawText(juce::String(wt->name) + "  ·  " + (p.shape == WavetableShape::oneD ? "1D" : p.shape == WavetableShape::twoD ? "2D" : "Rows") +
                       "  ·  " + (p.interp == Interp::blend ? "Blend" : "Step"),
                   bounds.reduced(8, 4).withHeight(16), juce::Justification::centredLeft);

        const float cw = area.getWidth() / (float) cols;
        const float ch = area.getHeight() / (float) juce::jmax(1, rows);
        const auto colour = theme::voice(voice);
        const bool rowsShape = p.shape == WavetableShape::rows;
        for (int r = 0; r < rows; ++r) {
            const int off = p.rowStart[(size_t) r];
            const int len = p.rowStart[(size_t) r + 1] - off;
            const bool inY = p.shape == WavetableShape::oneD || (r >= juce::jmin(v->windowStartY, v->windowEndY) && r <= juce::jmax(v->windowStartY, v->windowEndY));
            for (int x = 0; x < len; ++x) {
                const float w = rowsShape ? area.getWidth() / (float) len : cw;
                const juce::Rectangle<float> cell(area.getX() + (float) x * w, area.getY() + (float) r * ch, w, ch);
                const bool inX = rowsShape || (x >= juce::jmin(v->windowStart, v->windowEnd) && x <= juce::jmax(v->windowStart, v->windowEnd));
                if (inX && inY) {
                    g.setColour(colour.withAlpha(0.16f));
                    g.fillRect(cell.reduced(1));
                }
                const int id = p.ids[(size_t) (off + x)];
                if (const auto* t = id >= 0 ? doc.table(id) : nullptr)
                    drawWave(g, t->data, cell.reduced(3), inX && inY ? theme::text : theme::dim);
                else {
                    g.setColour(theme::dim.withAlpha(0.4f));
                    g.drawRect(cell.reduced(3), 1.0f);
                }
            }
        }
        if (liveX >= 0) {
            const int r = juce::jlimit(0, rows - 1, juce::roundToInt(liveY));
            const int len = juce::jmax(1, p.rowStart[(size_t) r + 1] - p.rowStart[(size_t) r]);
            const float w = rowsShape ? area.getWidth() / (float) len : cw;
            const float x = area.getX() + (liveX + 0.5f) * w;
            const float y = area.getY() + (p.shape == WavetableShape::oneD ? 0 : liveY * ch);
            g.setColour(colour);
            g.fillRect(juce::Rectangle<float>(x - 1, y, 2, p.shape == WavetableShape::oneD ? area.getHeight() : ch));
        }
    });
}
