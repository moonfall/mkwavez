#include "SynthJson.h"

#include <cmath>

using namespace mkwavez;

namespace synthjson {

namespace {

const char* const FILTER_MODES[] = {"lp12", "lp24", "hp", "bp", "notch"};
const char* const SUB_WAVES[] = {"sine", "square"};
const char* const NOISE_TYPES[] = {"white", "pink"};
const char* const PITCH_TARGETS[] = {"a", "b", "ab"};
const char* const MOD_MODES[] = {"ad", "adsr"};
const char* const PHASE_MODES[] = {"free", "reset", "random"};
const char* const NOTE_PRIORITIES[] = {"last", "low", "high"};
const char* const WARP_MODES[] = {"none", "sync", "formant", "bend", "squeeze", "quantize", "fold"};
const char* const LFO_SHAPES[] = {"sine", "tri", "saw", "square", "sh", "smooth", "rise", "fall"};
const char* const LFO_DIVS[] = {"8/1", "4/1", "2/1", "1/1", "1/2", "1/2D", "1/2T", "1/4", "1/4D", "1/4T", "1/8", "1/8D", "1/8T", "1/16", "1/16T", "1/32"};
const char* const MOD_SOURCES[] = {"lfo1", "lfo2", "lfo3", "fenv", "penv", "menv", "vel", "wheel", "at", "key", "rand",
                                   "macro1", "macro2", "macro3", "macro4", "gate"};
const char* const MOD_DESTS[] = {"pitchA", "pitchB", "posA", "posYA", "posB", "posYB", "levelA", "levelB", "sub", "noise",
                                 "cutoff", "res", "drive", "amp", "pan", "lfo1Rate", "lfo2Rate", "lfo3Rate",
                                 "panA", "panB", "fSpread", "warpA", "warpB",
                                 "fm", "ring", "sat", "width", "detuneA", "detuneB", "lfo1Depth", "lfo2Depth", "lfo3Depth"};

template <size_t N>
int indexOf(const char* const (&list)[N], const juce::var& v, int fallback) {
    const auto s = v.toString();
    for (size_t i = 0; i < N; ++i)
        if (s == list[i]) return (int) i;
    return fallback;
}

double num(const juce::var& o, const char* key, double def, double lo, double hi, bool integer = false) {
    const auto v = o.getProperty(key, {});
    if (!(v.isDouble() || v.isInt() || v.isInt64())) return def;
    double x = (double) v;
    if (!std::isfinite(x)) return def;
    x = std::max(lo, std::min(hi, x));
    return integer ? std::round(x) : x;
}

bool flag(const juce::var& o, const char* key, bool def) {
    const auto v = o.getProperty(key, {});
    return v.isBool() ? (bool) v : def;
}

juce::var obj() { return juce::var(new juce::DynamicObject()); }

void set(juce::var& o, const char* key, const juce::var& v) { o.getDynamicObject()->setProperty(key, v); }

} // namespace

juce::var encode(const SynthParams& s) {
    auto o = obj();
    set(o, "aOct", s.aOct);
    set(o, "aCoarse", s.aCoarse);
    set(o, "aFine", s.aFine);
    set(o, "aLevel", s.aLevel);
    auto b = obj();
    set(b, "wavetableId", s.b.wavetableId);
    set(b, "windowStart", s.b.windowStart);
    set(b, "windowEnd", s.b.windowEnd);
    set(b, "windowStartY", s.b.windowStartY);
    set(b, "windowEndY", s.b.windowEndY);
    set(b, "position", s.b.position);
    set(b, "positionY", s.b.positionY);
    set(o, "b", b);
    set(o, "bOct", s.bOct);
    set(o, "bCoarse", s.bCoarse);
    set(o, "bFine", s.bFine);
    set(o, "bLevel", s.bLevel);
    set(o, "subWave", SUB_WAVES[(int) s.subWave]);
    set(o, "subOct", s.subOct);
    set(o, "subLevel", s.subLevel);
    set(o, "noiseType", NOISE_TYPES[(int) s.noiseType]);
    set(o, "noiseLevel", s.noiseLevel);
    set(o, "ringLevel", s.ringLevel);
    set(o, "filterMode", FILTER_MODES[(int) s.filterMode]);
    set(o, "cutoff", s.cutoff);
    set(o, "resonance", s.resonance);
    set(o, "drive", s.drive);
    set(o, "keyTrack", s.keyTrack);
    set(o, "envAmount", s.envAmount);
    set(o, "velAmount", s.velAmount);
    set(o, "fAttack", s.fAttack);
    set(o, "fDecay", s.fDecay);
    set(o, "fSustain", s.fSustain);
    set(o, "fRelease", s.fRelease);
    set(o, "pAttack", s.pAttack);
    set(o, "pDecay", s.pDecay);
    set(o, "pAmount", s.pAmount);
    set(o, "pTarget", PITCH_TARGETS[(int) s.pTarget]);
    set(o, "velAmp", s.velAmp);
    set(o, "glide", s.glide);
    set(o, "glideLegato", s.glideLegato);
    set(o, "bendRange", s.bendRange);
    set(o, "pan", s.pan);
    juce::Array<juce::var> lfos;
    for (const auto& l : s.lfos) {
        auto x = obj();
        set(x, "shape", LFO_SHAPES[(int) l.shape]);
        set(x, "rate", l.rate);
        set(x, "sync", l.sync);
        set(x, "div", LFO_DIVS[l.div]);
        set(x, "retrig", l.retrig);
        set(x, "phase", l.phase);
        set(x, "stereo", l.stereo);
        set(x, "fade", l.fade);
        set(x, "depth", l.depth);
        lfos.add(x);
    }
    set(o, "lfos", lfos);
    set(o, "mAttack", s.mAttack);
    set(o, "mDecay", s.mDecay);
    set(o, "mSustain", s.mSustain);
    set(o, "mRelease", s.mRelease);
    set(o, "mMode", MOD_MODES[(int) s.mMode]);
    juce::Array<juce::var> mods;
    for (const auto& m : s.mods) {
        auto x = obj();
        set(x, "src", m.src == SRC_NONE ? "none" : MOD_SOURCES[(int) m.src]);
        set(x, "dst", m.dst == DST_NONE ? "none" : MOD_DESTS[(int) m.dst]);
        set(x, "amt", m.amt);
        mods.add(x);
    }
    set(o, "mods", mods);
    set(o, "sync", s.sync);
    set(o, "fm", s.fm);
    set(o, "aUnison", s.aUnison);
    set(o, "aDetune", s.aDetune);
    set(o, "aSpread", s.aSpread);
    set(o, "bUnison", s.bUnison);
    set(o, "bDetune", s.bDetune);
    set(o, "bSpread", s.bSpread);
    set(o, "sat", s.sat);
    set(o, "width", s.width);
    set(o, "aPan", s.aPan);
    set(o, "bPan", s.bPan);
    set(o, "aPhaseSpread", s.aPhaseSpread);
    set(o, "bPhaseSpread", s.bPhaseSpread);
    set(o, "aPosSpread", s.aPosSpread);
    set(o, "bPosSpread", s.bPosSpread);
    set(o, "noiseWidth", s.noiseWidth);
    set(o, "filterSpread", s.filterSpread);
    set(o, "poly", s.poly);
    set(o, "aWarp", WARP_MODES[(int) s.aWarp]);
    set(o, "aWarpAmt", s.aWarpAmt);
    set(o, "bWarp", WARP_MODES[(int) s.bWarp]);
    set(o, "bWarpAmt", s.bWarpAmt);
    set(o, "macro1", s.macro1);
    set(o, "macro2", s.macro2);
    set(o, "macro3", s.macro3);
    set(o, "macro4", s.macro4);
    set(o, "phaseMode", PHASE_MODES[(int) s.phaseMode]);
    set(o, "priority", NOTE_PRIORITIES[(int) s.priority]);
    set(o, "bendDown", s.bendDown);
    return o;
}

SynthParams decode(const juce::var& o) {
    const SynthParams d;
    SynthParams s;
    s.aOct = num(o, "aOct", d.aOct, -3, 3, true);
    s.aCoarse = num(o, "aCoarse", d.aCoarse, -24, 24, true);
    s.aFine = num(o, "aFine", d.aFine, -100, 100);
    s.aLevel = num(o, "aLevel", d.aLevel, 0, 1);
    const auto b = o.getProperty("b", {});
    s.b.wavetableId = (int) num(b, "wavetableId", 0, -1e9, 1e9, true);
    s.b.windowStart = (int) num(b, "windowStart", 0, -1e9, 1e9, true);
    s.b.windowEnd = (int) num(b, "windowEnd", 0, -1e9, 1e9, true);
    s.b.windowStartY = (int) num(b, "windowStartY", 0, -1e9, 1e9, true);
    s.b.windowEndY = (int) num(b, "windowEndY", 0, -1e9, 1e9, true);
    s.b.position = num(b, "position", 0.5, 0, 1);
    s.b.positionY = num(b, "positionY", 0.5, 0, 1);
    s.bOct = num(o, "bOct", d.bOct, -3, 3, true);
    s.bCoarse = num(o, "bCoarse", d.bCoarse, -24, 24, true);
    s.bFine = num(o, "bFine", d.bFine, -100, 100);
    s.bLevel = num(o, "bLevel", d.bLevel, 0, 1);
    s.subWave = (SubWave) indexOf(SUB_WAVES, o.getProperty("subWave", {}), (int) d.subWave);
    s.subOct = num(o, "subOct", d.subOct, 1, 2, true);
    s.subLevel = num(o, "subLevel", d.subLevel, 0, 1);
    s.noiseType = (NoiseType) indexOf(NOISE_TYPES, o.getProperty("noiseType", {}), (int) d.noiseType);
    s.noiseLevel = num(o, "noiseLevel", d.noiseLevel, 0, 1);
    s.ringLevel = num(o, "ringLevel", d.ringLevel, 0, 1);
    s.filterMode = (FilterMode) indexOf(FILTER_MODES, o.getProperty("filterMode", {}), (int) d.filterMode);
    s.cutoff = num(o, "cutoff", d.cutoff, CUTOFF_MIN, CUTOFF_MAX);
    s.resonance = num(o, "resonance", d.resonance, 0, 1);
    s.drive = num(o, "drive", d.drive, 0, 1);
    s.keyTrack = num(o, "keyTrack", d.keyTrack, 0, 1);
    s.envAmount = num(o, "envAmount", d.envAmount, -1, 1);
    s.velAmount = num(o, "velAmount", d.velAmount, 0, 1);
    s.fAttack = num(o, "fAttack", d.fAttack, 0, 10);
    s.fDecay = num(o, "fDecay", d.fDecay, 0, 10);
    s.fSustain = num(o, "fSustain", d.fSustain, 0, 1);
    s.fRelease = num(o, "fRelease", d.fRelease, 0, 10);
    s.pAttack = num(o, "pAttack", d.pAttack, 0, 10);
    s.pDecay = num(o, "pDecay", d.pDecay, 0, 10);
    s.pAmount = num(o, "pAmount", d.pAmount, -24, 24);
    s.pTarget = (PitchTarget) indexOf(PITCH_TARGETS, o.getProperty("pTarget", {}), (int) d.pTarget);
    s.velAmp = num(o, "velAmp", d.velAmp, 0, 1);
    s.glide = num(o, "glide", d.glide, 0, 5);
    s.glideLegato = flag(o, "glideLegato", d.glideLegato);
    s.bendRange = num(o, "bendRange", d.bendRange, 0, 24, true);
    s.pan = num(o, "pan", d.pan, -1, 1);
    if (const auto* lfos = o.getProperty("lfos", {}).getArray()) {
        for (int i = 0; i < LFO_COUNT; ++i) {
            const auto x = i < lfos->size() ? (*lfos)[i] : juce::var();
            const LfoParams& ld = d.lfos[(size_t) i];
            LfoParams& l = s.lfos[(size_t) i];
            l.shape = (LfoShape) indexOf(LFO_SHAPES, x.getProperty("shape", {}), (int) ld.shape);
            l.rate = num(x, "rate", ld.rate, LFO_RATE_MIN_HZ, LFO_RATE_MAX_HZ);
            l.sync = flag(x, "sync", ld.sync);
            l.div = indexOf(LFO_DIVS, x.getProperty("div", {}), ld.div);
            l.retrig = flag(x, "retrig", ld.retrig);
            l.phase = num(x, "phase", ld.phase, 0, 1);
            l.stereo = num(x, "stereo", ld.stereo, 0, 0.5);
            l.fade = num(x, "fade", ld.fade, 0, 10);
            l.depth = num(x, "depth", ld.depth, 0, 1);
        }
    }
    s.mAttack = num(o, "mAttack", d.mAttack, 0, 10);
    s.mDecay = num(o, "mDecay", d.mDecay, 0, 10);
    s.mSustain = num(o, "mSustain", d.mSustain, 0, 1);
    s.mRelease = num(o, "mRelease", d.mRelease, 0, 10);
    s.mMode = (ModEnvMode) indexOf(MOD_MODES, o.getProperty("mMode", {}), (int) d.mMode);
    // Saved data without a matrix: all slots empty (as normalizeSynth's EMPTY_MODS).
    s.mods = {};
    if (const auto* mods = o.getProperty("mods", {}).getArray()) {
        for (int i = 0; i < MOD_SLOTS && i < mods->size(); ++i) {
            const auto x = (*mods)[i];
            ModSlot& m = s.mods[(size_t) i];
            m.src = (ModSource) indexOf(MOD_SOURCES, x.getProperty("src", {}), -1);
            m.dst = (ModDest) indexOf(MOD_DESTS, x.getProperty("dst", {}), -1);
            m.amt = num(x, "amt", 0, -1, 1);
        }
    }
    s.sync = flag(o, "sync", d.sync);
    s.fm = num(o, "fm", d.fm, 0, 1);
    s.aUnison = (int) num(o, "aUnison", d.aUnison, 1, MAX_UNISON, true);
    s.aDetune = num(o, "aDetune", d.aDetune, 0, 100);
    s.aSpread = num(o, "aSpread", d.aSpread, 0, 1);
    s.bUnison = (int) num(o, "bUnison", d.bUnison, 1, MAX_UNISON, true);
    s.bDetune = num(o, "bDetune", d.bDetune, 0, 100);
    s.bSpread = num(o, "bSpread", d.bSpread, 0, 1);
    s.sat = num(o, "sat", d.sat, 0, 1);
    s.width = num(o, "width", d.width, 0, 2);
    s.aPan = num(o, "aPan", d.aPan, -1, 1);
    s.bPan = num(o, "bPan", d.bPan, -1, 1);
    s.aPhaseSpread = num(o, "aPhaseSpread", d.aPhaseSpread, 0, 0.5);
    s.bPhaseSpread = num(o, "bPhaseSpread", d.bPhaseSpread, 0, 0.5);
    s.aPosSpread = num(o, "aPosSpread", d.aPosSpread, 0, 1);
    s.bPosSpread = num(o, "bPosSpread", d.bPosSpread, 0, 1);
    s.noiseWidth = num(o, "noiseWidth", d.noiseWidth, 0, 1);
    s.filterSpread = num(o, "filterSpread", d.filterSpread, -1, 1);
    // Saved before polyphony: monophonic, as it was.
    s.poly = (int) num(o, "poly", 1, 1, MAX_POLY, true);
    s.aWarp = (WarpMode) indexOf(WARP_MODES, o.getProperty("aWarp", {}), (int) d.aWarp);
    s.aWarpAmt = num(o, "aWarpAmt", d.aWarpAmt, -1, 1);
    s.bWarp = (WarpMode) indexOf(WARP_MODES, o.getProperty("bWarp", {}), (int) d.bWarp);
    s.bWarpAmt = num(o, "bWarpAmt", d.bWarpAmt, -1, 1);
    s.macro1 = num(o, "macro1", d.macro1, 0, 1);
    s.macro2 = num(o, "macro2", d.macro2, 0, 1);
    s.macro3 = num(o, "macro3", d.macro3, 0, 1);
    s.macro4 = num(o, "macro4", d.macro4, 0, 1);
    s.phaseMode = (PhaseMode) indexOf(PHASE_MODES, o.getProperty("phaseMode", {}), (int) d.phaseMode);
    s.priority = (NotePriority) indexOf(NOTE_PRIORITIES, o.getProperty("priority", {}), (int) d.priority);
    // Saved before the separate down range: as far down as up.
    s.bendDown = num(o, "bendDown", s.bendRange, 0, 24, true);
    return s;
}

} // namespace synthjson
