// The C++ core against the TypeScript core's numbers (tests/golden.test.ts).
#include "golden.h"

#include "check.h"
#include "mkwavez/dsp.h"
#include "mkwavez/engine.h"
#include "mkwavez/envelope.h"
#include "mkwavez/midi.h"
#include "mkwavez/playback.h"
#include "mkwavez/prng.h"
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

namespace {

enum Op { opTable = 1, opRemoveTable, opWavetable, opVoice, opRemoveVoice, opSequence, opTransport, opNoteOn, opNoteOff,
          opAllNotesOff, opBend, opPatch, opRemoveSequence, opRemoveWavetable };

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
            const VoicePatch::Field fields[] = {VoicePatch::position, VoicePatch::positionY, VoicePatch::lfoDepth, VoicePatch::lfoRate,
                                                VoicePatch::level};
            for (int k = 0; k < 5; ++k)
                if (mask & (1 << k)) patch.set(fields[k], a(2 + (size_t) k));
            return e.patchVoice(ai(0), patch);
        }
        case opRemoveSequence: return e.removeSequence(ai(0));
        case opRemoveWavetable: return e.removeWavetable(ai(0));
        default: check::report(false, "unknown golden op", __FILE__, __LINE__);
    }
}

} // namespace

/** Replays scenario `name` with the given chunk size; returns the output. */
std::vector<float> runScenario(const std::string& name, int chunk, EngineStatus* status) {
    std::vector<const std::vector<double>*> ops;
    for (const auto& r : golden::records())
        if (r.kind == "op" && r.name == name) ops.push_back(&r.v);
    const auto& render = golden::get("render", name);
    if (render.size() < 2) return {};
    const double sr = render[0];
    const int frames = (int) render[1];
    auto e = std::make_unique<SynthEngine>(sr);
    Store store;
    std::vector<float> out((size_t) frames);
    size_t next = 0;
    for (int f = 0; f < frames;) {
        while (next < ops.size() && (*ops[next])[0] <= f) applyOp(*e, store, *ops[next++]);
        int until = std::min(frames, f + chunk);
        if (next < ops.size()) until = std::min(until, (int) (*ops[next])[0]);
        e->process(out.data() + f, until - f);
        f = until;
    }
    if (status) e->status(*status);
    return out;
}

TEST("golden: engine scenarios render the same samples and status") {
    const char* kind_ = "out";
    for (const char* name : {"sequence", "midi2d", "steplen", "rows"}) {
        EngineStatus st;
        const auto out = runScenario(name, 128, &st);
        CHECK_SEQ(out, name, 2e-6);
        std::vector<double> s{(double) st.tick, st.playing ? 1.0 : 0.0, (double) st.voiceCount};
        for (int i = 0; i < st.voiceCount; ++i) {
            const auto& v = st.voices[i];
            s.insert(s.end(), {(double) v.id, v.pos, v.posY, v.index, v.y, v.env, (double) v.note});
        }
        size_t at = 0;
        const double d = maxDiff(s, golden::get("status", name), &at);
        check::report(d <= 1e-9, (std::string("status ") + name).c_str(), __FILE__, __LINE__, "max diff " + std::to_string(d) + " at " + std::to_string(at));
    }
}

TEST("engine: rendering is independent of the host block size") {
    for (const char* name : {"sequence", "midi2d", "steplen", "rows"}) {
        const auto ref = runScenario(name, 128, nullptr);
        for (int chunk : {1, 37, 64, 500, 4096}) {
            const auto out = runScenario(name, chunk, nullptr);
            CHECK(out == ref);
        }
    }
}
