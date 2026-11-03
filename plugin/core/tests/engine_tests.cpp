// Native-only engine behaviour: the table map, pointer retirement, pools.
#include "check.h"
#include "mkwavez/engine.h"
#include "mkwavez/prng.h"

#include <map>
#include <memory>
#include <set>
#include <vector>

using namespace mkwavez;

namespace {

std::vector<float> render(SynthEngine& e, int frames) {
    std::vector<float> out((size_t) frames);
    for (int f = 0; f < frames; f += 128) e.process(out.data() + f, std::min(128, frames - f));
    return out;
}

double rms(const std::vector<float>& x) {
    double s = 0;
    for (float v : x) s += (double) v * v;
    return std::sqrt(s / (double) x.size());
}

std::set<const void*> drain(SynthEngine& e) {
    std::set<const void*> out;
    Retired r;
    while (e.popRetired(r)) out.insert(r.ptr);
    return out;
}

} // namespace

TEST("engine: table map matches std::map under random adds / removes") {
    auto e = std::make_unique<SynthEngine>(48000);
    static MipSet dummy[64];
    std::map<int, const MipSet*> ref;
    Prng r(99);
    for (int i = 0; i < 40000; ++i) {
        const int id = 1 + r.integer(9000);
        if (r.next() < 0.55) {
            const MipSet* m = &dummy[r.integer(64)];
            e->addTable(id, m);
            ref[id] = m;
        } else {
            e->removeTable(id);
            ref.erase(id);
        }
    }
    CHECK(e->tableCount() == (int) ref.size());
    int bad = 0;
    for (int id = 0; id <= 9001; ++id) bad += e->hasTable(id) != (ref.count(id) > 0);
    CHECK(bad == 0);
}

TEST("engine: removed tables retire only once no voice plays them") {
    auto e = std::make_unique<SynthEngine>(48000);
    auto a = std::make_unique<MipSet>(buildMipSet(basicWave(BasicWave::saw)));
    auto b = std::make_unique<MipSet>(buildMipSet(basicWave(BasicWave::square)));
    e->addTable(1, a.get());
    e->addTable(2, b.get());
    PackedWavetable wt1 = PackedWavetable::fromIds({1, 2});
    e->setWavetable(0, &wt1);
    VoiceParams v;
    v.id = 1;
    v.windowEnd = 1;
    v.position = 0;
    v.lfoDepth = 0;
    v.sustain = 1;
    e->setVoice(v);
    e->midiNoteOn(1, 60, 100);
    CHECK(rms(render(*e, 4800)) > 0.01);

    // Table 1 is sounding: removing it keeps it alive (held mix) — not retired.
    e->removeTable(1);
    render(*e, 4800);
    CHECK(drain(*e).empty());
    CHECK(rms(render(*e, 4800)) > 0.01); // the previous mix holds

    // Point the wavetable at table 2: table 1 fades out, then retires; the replaced
    // wavetable retires at once.
    PackedWavetable wt2 = PackedWavetable::fromIds({2});
    e->setWavetable(0, &wt2);
    render(*e, 4800);
    const auto gone = drain(*e);
    CHECK(gone.count(a.get()) == 1);
    CHECK(gone.count(&wt1) == 1);
    CHECK(gone.count(b.get()) == 0);
    CHECK(rms(render(*e, 4800)) > 0.01);

    // Removing a voice drops its references.
    e->removeTable(2);
    render(*e, 480);
    CHECK(drain(*e).empty());
    e->removeVoice(1);
    render(*e, 4800);
    CHECK(e->voiceCount() == 0);
    CHECK(drain(*e).count(b.get()) == 1);
}

TEST("engine: voice pool is bounded and reuses slots") {
    auto e = std::make_unique<SynthEngine>(48000);
    VoiceParams v;
    for (int i = 1; i <= SynthEngine::MAX_VOICES + 4; ++i) {
        v.id = i;
        e->setVoice(v);
    }
    CHECK(e->voiceCount() == SynthEngine::MAX_VOICES);
    e->removeVoice(3);
    render(*e, 256); // silent voice: release completes immediately
    CHECK(e->voiceCount() == SynthEngine::MAX_VOICES - 1);
    v.id = 100;
    e->setVoice(v);
    CHECK(e->voiceParams(100) != nullptr);
    int32_t ids[SynthEngine::MAX_VOICES];
    const int n = e->voiceIds(ids, SynthEngine::MAX_VOICES);
    CHECK(n == SynthEngine::MAX_VOICES);
    CHECK(ids[n - 1] == 100);
}

TEST("engine: output stays finite and bounded across tempo / pitch extremes") {
    auto e = std::make_unique<SynthEngine>(96000);
    auto m = std::make_unique<MipSet>(buildMipSet(basicWave(BasicWave::p10)));
    e->addTable(1, m.get());
    PackedWavetable wt = PackedWavetable::fromIds({1});
    e->setWavetable(0, &wt);
    VoiceParams v;
    v.id = 1;
    v.level = 1;
    e->setVoice(v);
    SequenceData s;
    s.id = 1;
    s.voiceId = 1;
    s.length = 4;
    s.steps = {};
    e->setSequence(s);
    e->setTransport(true, 4000); // clamped to 400
    e->midiNoteOn(1, 127, 127);
    e->setPitchBend(1, 2);
    const auto out = render(*e, 96000);
    bool ok = true;
    for (float x : out) ok = ok && std::isfinite(x) && std::abs(x) <= 1;
    CHECK(ok);
    CHECK(rms(out) > 0.001);
}
