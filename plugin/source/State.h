// Document ⇄ juce::ValueTree (plugin state). Table data is stored as raw little-endian
// float32 blocks (binary ValueTree properties), mip sets are rebuilt on load.
#pragma once

#include "EngineHost.h"

#include <juce_data_structures/juce_data_structures.h>

namespace state {

/** Bumped when the layout changes incompatibly; older states are migrated or rejected. */
inline constexpr int VERSION = 1;

juce::ValueTree toValueTree(const mkwavez::Document& doc);
/** Returns false (and leaves `out` alone) if the tree isn't a usable document. */
bool fromValueTree(const juce::ValueTree& tree, mkwavez::Document& out);

} // namespace state
