// Colours from the web app's dark theme (src/ui/styles.css).
#pragma once

#include <juce_graphics/juce_graphics.h>

namespace theme {

inline const juce::Colour bg{0xff161615};
inline const juce::Colour panel{0xff1f1f1d};
inline const juce::Colour border{0xff3a3a36};
inline const juce::Colour text{0xffecece8};
inline const juce::Colour dim{0xff7c7c75};
inline const juce::Colour accent{0xff7c9bff};
inline const juce::Colour accentBg{0xff26314f};

/** --v0 … --v7, indexed by voice id − 1. */
inline juce::Colour voice(int id) {
    static const juce::uint32 colours[] = {0xffff8a00, 0xffff2d95, 0xffffd400, 0xff7c9bff, 0xff3bc9db, 0xffa9e34b, 0xffda77f2, 0xffc8946a};
    return juce::Colour(colours[((id - 1) % 8 + 8) % 8]);
}

} // namespace theme
