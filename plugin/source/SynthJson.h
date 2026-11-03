// SynthParams ⇄ JSON (juce::var) with the field names and enum strings of src/core/synth.ts,
// so the page's voices decode directly and the plugin state stores the same shape.
// Decoding validates like normalizeSynth (unknown / bad values → defaults, numbers clamped).
#pragma once

#include "mkwavez/synth.h"

#include <juce_core/juce_core.h>

namespace synthjson {

juce::var encode(const mkwavez::SynthParams& s);
mkwavez::SynthParams decode(const juce::var& v);

} // namespace synthjson
