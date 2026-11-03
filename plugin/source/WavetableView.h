// The selected voice's wavetable: its slots as small waveforms (1D: a strip, 2D / Rows: a
// grid), the voice window tinted, the live play position as a caret.
#pragma once

#include "PluginProcessor.h"

#include <juce_gui_basics/juce_gui_basics.h>

class WavetableView final : public juce::Component {
public:
    explicit WavetableView(MkwavezProcessor& p) : proc(p) {}

    void setVoice(int voiceId) {
        voice = voiceId;
        repaint();
    }
    void paint(juce::Graphics& g) override;

private:
    MkwavezProcessor& proc;
    int voice = 1;
};
