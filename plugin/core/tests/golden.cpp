// The C++ core against the TypeScript core's numbers (tests/golden.test.ts).
#include "golden.h"

#include "check.h"
#include "mkwavez/dsp.h"
#include "mkwavez/engine.h"
#include "mkwavez/envelope.h"
#include "mkwavez/midi.h"
#include "mkwavez/playback.h"
#include "mkwavez/prng.h"
#include "mkwavez/svf.h"
#include "mkwavez/voice.h"

#include <cstdlib>
#include <fstream>
#include <memory>
#include <sstream>

using namespace mkwavez;

namespace golden {

const std::vector<Record>& records() {
    static const std::vector<Record> recs = [] {
        std::vector<Record> out;
        std::ifstream in(MKWAVEZ_GOLDEN_FILE);
        if (!in) {
            std::fprintf(stderr, "cannot open %s\n", MKWAVEZ_GOLDEN_FILE);
            std::exit(2);
        }
        std::string line;
        while (std::getline(in, line)) {
            if (line.empty() || line[0] == '#') continue;
            const char* p = line.c_str();
            char* end = nullptr;
            Record r;
            std::istringstream head(line);
            head >> r.kind >> r.name;
            size_t count = 0;
            head >> count;
            // Numbers: strtod is much faster than streams for ~100k values.
            p += (size_t) head.tellg();
            r.v.reserve(count);
            for (size_t i = 0; i < count; ++i) {
                r.v.push_back(std::strtod(p, &end));
                p = end;
            }
            out.push_back(std::move(r));
        }
        return out;
    }();
    return recs;
}

const std::vector<double>& get(const std::string& kind, const std::string& name) {
    static const std::vector<double> none;
    for (const auto& r : records())
        if (r.kind == kind && r.name == name) return r.v;
    check::report(false, ("golden record " + kind + " " + name).c_str(), __FILE__, __LINE__, "missing");
    return none;
}

} // namespace golden

namespace {

/** Max |a - b| over two sequences (sizes must match). */
template <typename A>
double maxDiff(const A& a, const std::vector<double>& b, size_t* at = nullptr) {
    if (a.size() != b.size()) return INFINITY;
    double m = 0;
    for (size_t i = 0; i < b.size(); ++i) {
        const double d = std::abs((double) a[i] - b[i]);
        if (d > m || std::isnan(d)) {
            m = std::isnan(d) ? INFINITY : d;
            if (at) *at = i;
        }
    }
    return m;
}

#define CHECK_SEQ(actual, name, tol)                                                                 \
    do {                                                                                             \
        size_t at_ = 0;                                                                              \
        const double d_ = maxDiff((actual), golden::get(kind_, (name)), &at_);                       \
        check::report(d_ <= (tol), (std::string(kind_) + " " + (name)).c_str(), __FILE__, __LINE__,  \
                      "max diff " + std::to_string(d_) + " at " + std::to_string(at_));              \
    } while (0)

constexpr const char* WAVES = "sine tri saw square p25 p10";
const BasicWave BASIC[] = {BasicWave::sine, BasicWave::tri, BasicWave::saw, BasicWave::square, BasicWave::p25, BasicWave::p10};

/** Same formulas as shapeInput() in tests/golden.test.ts. */
std::vector<double> shapeInput(int kind) {
    std::vector<double> x(TABLE_SIZE);
    Prng r(7);
    for (int i = 0; i < TABLE_SIZE; ++i) {
        const double t = (double) i / TABLE_SIZE;
        if (kind == 0)
            x[(size_t) i] = 2 * t - 1;
        else if (kind == 1)
            x[(size_t) i] = r.bipolar();
        else if (kind == 2)
            x[(size_t) i] = (t < 0.3 ? 1 : -1) + 0.5;
        else
            x[(size_t) i] = std::cos(2 * PI * 3 * t + 1) + 0.25 * std::sin(2 * PI * 7 * t);
    }
    return x;
}

} // namespace

TEST("golden: prng and deriveSeed are bit-exact") {
    const char* kind_ = "array";
    for (uint32_t seed : {0u, 1u, 12345u, 0xdeadbeefu}) {
        Prng r(seed);
        std::vector<double> got, derived;
        for (int i = 0; i < 16; ++i) got.push_back(r.next());
        for (uint32_t i = 0; i < 8; ++i) derived.push_back(deriveSeed(seed, i));
        CHECK_SEQ(got, "prng." + std::to_string(seed), 0.0);
        CHECK_SEQ(derived, "derive." + std::to_string(seed), 0.0);
    }
}

TEST("golden: shared constants") {
    const char* kind_ = "array";
    CHECK_SEQ(std::vector<double>({(double) TABLE_SIZE, (double) TIMELINE_CAP, (double) PREVIEW_ID_BASE}), "constants", 0.0);
}

TEST("golden: shape, basic waves and mip sets") {
    const char* kind_ = "array";
    (void) WAVES;
    for (int k = 0; k < 4; ++k) CHECK_SEQ(shape(shapeInput(k).data()), "shape." + std::to_string(k), 2e-6);
    ShapeOptions lp;
    lp.lowpassHarmonic = 12;
    CHECK_SEQ(shape(shapeInput(1).data(), lp), "shape.1.lp12", 2e-6);
    ShapeOptions k20;
    k20.kmax = 20;
    CHECK_SEQ(shape(shapeInput(0).data(), k20), "shape.0.k20", 2e-6);
    for (int i = 0; i < BASIC_WAVE_COUNT; ++i) CHECK_SEQ(basicWave(BASIC[i]), "basic." + std::to_string(i), 2e-6);
    CHECK_SEQ(buildMipSet(basicWave(BasicWave::saw)), "mips.2", 2e-6);
    CHECK_SEQ(buildMipSet(basicWave(BasicWave::p25)), "mips.4", 2e-6);
}

TEST("golden: mip level, modulated position, velocity, note frequency, ADSR") {
    const char* kind_ = "array";
    const double freqs[] = {20, 55, 110, 220, 330, 440, 880, 1760, 3000, 5000, 9000, 15000};
    for (int sr : {44100, 48000, 96000}) {
        std::vector<double> got;
        for (double f : freqs) got.push_back(mipLevelFor(f, sr));
        CHECK_SEQ(got, "miplevel." + std::to_string(sr), 0.0);
    }
    std::vector<double> mp;
    for (double pos : {0.0, 0.3, 0.5, 0.9, 1.0})
        for (double depth : {0.0, 0.5, 1.0})
            for (double ph : {0.0, 1.0, 2.5, 4.0, 5.5}) mp.push_back(modulatedPosition(pos, depth, ph));
    CHECK_SEQ(mp, "modpos", 1e-14);
    std::vector<double> vg;
    for (int v : {0, 1, 32, 64, 100, 127, 200}) vg.push_back(velocityGain(v));
    CHECK_SEQ(vg, "velgain", 1e-15);
    std::vector<double> nf;
    for (int n : {0, 21, 60, 69, 127})
        for (double oct : {0.0, -1.0, 2.0}) nf.push_back(midiNoteFreq(n, oct));
    CHECK_SEQ(nf, "notefreq", 1e-9);
    Adsr a;
    a.configure(0.002, 0.01, 0.4, 0.02, 48000);
    std::vector<double> env;
    a.gateOn();
    for (int i = 0; i < 1500; ++i) {
        if (i == 900) a.gateOff();
        if (i == 1200) a.gateOn();
        env.push_back(a.next());
    }
    CHECK_SEQ(env, "adsr", 1e-12);
}

TEST("golden: synth helpers (reflect, limiter, drive, resonance, cutoff, LFO waves, SVF)") {
    const char* kind_ = "array";
    const double xs[] = {-3, -1.2, -0.5, 0, 0.3, 0.9, 1, 1.7, 2.6};
    std::vector<double> rf, sl, dr;
    for (double x : xs) {
        rf.push_back(reflect01(x));
        sl.push_back(softLimit(x));
    }
    for (double d : {0.0, 0.25, 1.0})
        for (double x : xs) dr.push_back(driveSample(x, d));
    CHECK_SEQ(rf, "reflect01", 1e-15);
    CHECK_SEQ(sl, "softLimit", 1e-15);
    CHECK_SEQ(dr, "drive", 1e-14);
    std::vector<double> rk, cg, lw, ly, fo;
    for (double r : {-1.0, 0.0, 0.15, 0.5, 0.99, 1.0, 2.0}) rk.push_back(resonanceK(r));
    for (double f : {1.0, 20.0, 440.0, 2400.0, 12000.0, 23000.0, 30000.0}) {
        cg.push_back(cutoffG(f, 44100));
        cg.push_back(cutoffG(f, 96000));
    }
    for (int sh = 0; sh < LFO_SHAPE_COUNT; ++sh)
        for (double ph : {0.0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.99}) {
            lw.push_back(lfoWave((LfoShape) sh, ph, 0.7, -0.3));
            ly.push_back(lfoWaveY((LfoShape) sh, ph, 0.7, -0.3, 0.4, -0.6));
        }
    Prng r(11);
    for (int mode = 0; mode < 5; ++mode) {
        MultiFilter f;
        for (int i = 0; i < 256; ++i) {
            const double x = i == 0 ? 1 : r.bipolar() * 0.3;
            const double g = cutoffG(200 * std::pow(2.0, (i % 64) / 10.0), 48000);
            fo.push_back(f.process(x, mode, g, resonanceK((i % 7) / 6.0)));
        }
    }
    CHECK_SEQ(rk, "resK", 1e-15);
    CHECK_SEQ(cg, "cutoffG", 1e-12);
    CHECK_SEQ(lw, "lfoWave", 1e-14);
    CHECK_SEQ(ly, "lfoWaveY", 1e-14);
    CHECK_SEQ(fo, "svf", 1e-9);
}

TEST("golden: resolveMix (400 random wavetables and queries)") {
    int cases = 0, bad = 0;
    Mix out;
    for (const auto& r : golden::records()) {
        if (r.kind != "mix") continue;
        ++cases;
        const auto& v = r.v;
        size_t i = 0;
        PackedWavetable p;
        p.shape = (WavetableShape) (int) v[i++];
        const int nRows = (int) v[i++];
        p.rowStart.assign(1, 0);
        for (int y = 0; y < nRows; ++y) p.rowStart.push_back(p.rowStart.back() + (int32_t) v[i++]);
        for (int k = 0; k < p.rowStart.back(); ++k) p.ids.push_back((int32_t) v[i++]);
        MixWindow w{(int) v[i], (int) v[i + 1], (int) v[i + 2], (int) v[i + 3]};
        i += 4;
        const double px = v[i++], py = v[i++];
        const bool step = v[i++] != 0;
        resolveMix(p, w, px, py, step, out);
        bool ok = out.n == (int) v[i++];
        for (int k = 0; ok && k < out.n; ++k) {
            ok = out.ids[k] == (int32_t) v[i] && check::near(out.w[k], v[i + 1], 1e-12);
            i += 2;
        }
        ok = ok && check::near(out.x, v[i], 1e-12) && check::near(out.y, v[i + 1], 1e-12);
        if (!ok && bad++ < 5) check::report(false, ("mix case " + r.name).c_str(), __FILE__, __LINE__);
    }
    CHECK(cases == 400);
    CHECK(bad == 0);
}

// ---- engine scenarios (opcodes as in tests/golden.test.ts) ----

const char* const SCENARIOS[] = {"sequence", "midi2d", "steplen", "synth", "synthEdit", "synthGuard", "stereo", "poly", "warp", "macros", "modplus", "mpe", "phase", "mono", "lfo2d", "rows"};
/** Synth voices: the same bound as the rest (measured: well under it). */
constexpr double SYNTH_TOL = 2e-6;

namespace {

enum Op { opTable = 1, opRemoveTable, opWavetable, opVoice, opRemoveVoice, opSequence, opTransport, opNoteOn, opNoteOff,
          opAllNotesOff, opBend, opPatch, opRemoveSequence, opRemoveWavetable, opMod, opPressure, opNotePressure, opNoteSlide, opNoteBend };

/** Synth params in the order of encodeSynth() in tests/golden.test.ts. */
SynthParams decodeSynth(const std::vector<double>& op, size_t i) {
    SynthParams s;
    const auto d = [&] { return op[i++]; };
    s.aOct = d(); s.aCoarse = d(); s.aFine = d(); s.aLevel = d();
    s.bOct = d(); s.bCoarse = d(); s.bFine = d(); s.bLevel = d();
    s.subWave = (SubWave) (int) d(); s.subOct = d(); s.subLevel = d();
    s.noiseType = (NoiseType) (int) d(); s.noiseLevel = d(); s.ringLevel = d();
    s.filterMode = (FilterMode) (int) d(); s.cutoff = d(); s.resonance = d(); s.drive = d(); s.keyTrack = d(); s.envAmount = d();
    s.velAmount = d(); s.fAttack = d(); s.fDecay = d(); s.fSustain = d(); s.fRelease = d(); s.pAttack = d(); s.pDecay = d();
    s.pAmount = d(); s.pTarget = (PitchTarget) (int) d(); s.velAmp = d();
    s.glide = d(); s.glideLegato = d() != 0; s.bendRange = d(); s.pan = d();
    s.mAttack = d(); s.mDecay = d(); s.mSustain = d(); s.mRelease = d(); s.mMode = (ModEnvMode) (int) d();
    s.sync = d() != 0; s.fm = d();
    s.aUnison = (int) d(); s.aDetune = d(); s.aSpread = d(); s.bUnison = (int) d(); s.bDetune = d(); s.bSpread = d();
    s.sat = d(); s.width = d();
    s.aPan = d(); s.bPan = d(); s.aPhaseSpread = d(); s.bPhaseSpread = d(); s.aPosSpread = d(); s.bPosSpread = d();
    s.noiseWidth = d(); s.filterSpread = d();
    s.poly = (int) d();
    s.aWarp = (WarpMode) (int) d(); s.aWarpAmt = d(); s.bWarp = (WarpMode) (int) d(); s.bWarpAmt = d();
    s.macro1 = d(); s.macro2 = d(); s.macro3 = d(); s.macro4 = d();
    s.phaseMode = (PhaseMode) (int) d();
    s.priority = (NotePriority) (int) d(); s.bendDown = d();
    s.b.wavetableId = (int) d(); s.b.windowStart = (int) d(); s.b.windowEnd = (int) d(); s.b.windowStartY = (int) d();
    s.b.windowEndY = (int) d(); s.b.position = d(); s.b.positionY = d();
    for (auto& l : s.lfos) {
        l.shape = (LfoShape) (int) d(); l.rate = d(); l.sync = d() != 0; l.div = (int) d(); l.retrig = d() != 0;
        l.phase = d(); l.fade = d(); l.depth = d(); l.stereo = d();
    }
    for (auto& m : s.mods) {
        m.src = (ModSource) (int) d(); m.dst = (ModDest) (int) d(); m.amt = d();
    }
    return s;
}

/** Owns what the engine points at (never freed during a scenario). */
struct Store {
    std::vector<std::unique_ptr<MipSet>> mips;
    std::vector<std::unique_ptr<PackedWavetable>> wavetables;
    std::map<int, MipSet> cache; // basic wave index → mip set
};

void applyOp(SynthEngine& e, Store& store, const std::vector<double>& op) {
    const auto a = [&](size_t i) { return op[i + 2]; };
    const auto ai = [&](size_t i) { return (int) op[i + 2]; };
    switch ((int) op[1]) {
        case opTable: {
            const int wave = ai(1);
            if (!store.cache.count(wave)) store.cache[wave] = buildMipSet(basicWave(BASIC[wave]));
            store.mips.push_back(std::make_unique<MipSet>(store.cache[wave]));
            e.addTable(ai(0), store.mips.back().get());
            return;
        }
        case opRemoveTable: return e.removeTable(ai(0));
        case opWavetable: {
            auto p = std::make_unique<PackedWavetable>();
            p->shape = (WavetableShape) ai(1);
            p->interp = (Interp) ai(2);
            const int nRows = ai(3);
            p->rowStart.assign(1, 0);
            for (int y = 0; y < nRows; ++y) p->rowStart.push_back(p->rowStart.back() + ai(4 + (size_t) y));
            for (size_t k = 4 + (size_t) nRows; k + 2 < op.size(); ++k) p->ids.push_back(ai(k));
            e.setWavetable(ai(0), p.get());
            store.wavetables.push_back(std::move(p));
            return;
        }
        case opVoice: {
            VoiceParams v;
            size_t i = 0;
            v.id = ai(i++);
            v.wavetableId = ai(i++);
            v.windowStart = ai(i++);
            v.windowEnd = ai(i++);
            v.windowStartY = ai(i++);
            v.windowEndY = ai(i++);
            v.position = a(i++);
            v.positionY = a(i++);
            v.lfoDepth = a(i++);
            v.lfoRate = a(i++);
            v.lfoDepthY = a(i++);
            v.lfoRateY = a(i++);
            v.lfoPhase = a(i++);
            v.lfoPhaseY = a(i++);
            v.octave = a(i++);
            v.level = a(i++);
            v.mute = a(i++) != 0;
            v.attack = a(i++);
            v.decay = a(i++);
            v.sustain = a(i++);
            v.release = a(i++);
            v.type = a(i++) != 0 ? VoiceType::synth : VoiceType::simple;
            v.synth = decodeSynth(op, i + 2);
            return e.setVoice(v);
        }
        case opRemoveVoice: return e.removeVoice(ai(0));
        case opSequence: {
            SequenceData s;
            s.id = ai(0);
            s.voiceId = ai(1);
            s.length = ai(2);
            s.gate = a(3);
            s.stepLength = (StepLength) ai(4);
            for (int k = 0; k < MAX_STEPS; ++k) s.steps[(size_t) k] = (int8_t) ai(5 + (size_t) k);
            return e.setSequence(s);
        }
        case opTransport: return e.setTransport(ai(0) != 0, a(1));
        case opNoteOn: return e.midiNoteOn(ai(0), ai(1), ai(2));
        case opNoteOff: return e.midiNoteOff(ai(0), ai(1));
        case opAllNotesOff: return e.midiAllNotesOff(ai(0));
        case opBend: return e.setPitchBend(ai(0), a(1));
        case opPatch: {
            VoicePatch patch;
            const int mask = ai(1);
            for (int k = 0; k < 5; ++k) // position, positionY, lfoDepth, lfoRate, level = CcParam 0..4
                if (mask & (1 << k)) patch.set((CcParam) k, a(2 + (size_t) k));
            return e.patchVoice(ai(0), patch);
        }
        case opRemoveSequence: return e.removeSequence(ai(0));
        case opRemoveWavetable: return e.removeWavetable(ai(0));
        case opMod: return e.applyMidi(MidiVoiceEvent{MidiVoiceEvent::mod, ai(0), 0, 0, a(1)});
        case opPressure: return e.applyMidi(MidiVoiceEvent{MidiVoiceEvent::pressure, ai(0), 0, 0, a(1)});
        case opNotePressure: return e.applyMidi(MidiVoiceEvent{MidiVoiceEvent::notePressure, ai(0), ai(1), 0, a(2)});
        case opNoteSlide: return e.applyMidi(MidiVoiceEvent{MidiVoiceEvent::noteSlide, ai(0), ai(1), 0, a(2)});
        case opNoteBend: return e.applyMidi(MidiVoiceEvent{MidiVoiceEvent::noteBend, ai(0), ai(1), 0, a(2)});
        default: check::report(false, "unknown golden op", __FILE__, __LINE__);
    }
}

} // namespace

/** Replays scenario `name` with the given chunk size; returns the left output (right in *right). */
std::vector<float> runScenario(const std::string& name, int chunk, EngineStatus* status, std::vector<float>* right = nullptr) {
    std::vector<const std::vector<double>*> ops;
    for (const auto& r : golden::records())
        if (r.kind == "op" && r.name == name) ops.push_back(&r.v);
    const auto& render = golden::get("render", name);
    if (render.size() < 2) return {};
    const double sr = render[0];
    const int frames = (int) render[1];
    auto e = std::make_unique<SynthEngine>(sr);
    Store store;
    std::vector<float> out((size_t) frames), outR((size_t) frames);
    size_t next = 0;
    for (int f = 0; f < frames;) {
        while (next < ops.size() && (*ops[next])[0] <= f) applyOp(*e, store, *ops[next++]);
        int until = std::min(frames, f + chunk);
        if (next < ops.size()) until = std::min(until, (int) (*ops[next])[0]);
        e->process(out.data() + f, until - f, outR.data() + f);
        f = until;
    }
    if (status) e->status(*status);
    if (right) *right = outR;
    return out;
}

TEST("golden: engine scenarios render the same samples and status") {
    const char* kind_ = "out";
    for (const char* name : SCENARIOS) {
        EngineStatus st;
        std::vector<float> right;
        const auto out = runScenario(name, 128, &st, &right);
        const double tol = std::string(name).rfind("synth", 0) == 0 ? SYNTH_TOL : 2e-6;
        CHECK_SEQ(out, name, tol);
        bool hasR = false;
        for (const auto& r : golden::records()) hasR |= r.kind == "outR" && r.name == name;
        {
            const char* kind_ = hasR ? "outR" : "out";
            CHECK_SEQ(right, name, tol);
        }
        std::vector<double> s{(double) st.tick, st.playing ? 1.0 : 0.0, st.unisonLimited ? 1.0 : 0.0, (double) st.voiceCount};
        for (int i = 0; i < st.voiceCount; ++i) {
            const auto& v = st.voices[i];
            s.insert(s.end(), {(double) v.id, v.pos, v.posY, v.index, v.y, v.env, (double) v.note, v.posB, v.posYB, v.indexB, v.yB});
        }
        size_t at = 0;
        const double d = maxDiff(s, golden::get("status", name), &at);
        check::report(d <= (tol > 2e-6 ? 1e-6 : 1e-9), (std::string("status ") + name).c_str(), __FILE__, __LINE__, "max diff " + std::to_string(d) + " at " + std::to_string(at));
    }
}

TEST("engine: rendering is independent of the host block size") {
    for (const char* name : SCENARIOS) {
        const auto ref = runScenario(name, 128, nullptr);
        for (int chunk : {1, 37, 64, 500, 4096}) {
            const auto out = runScenario(name, chunk, nullptr);
            CHECK(out == ref);
        }
    }
}
