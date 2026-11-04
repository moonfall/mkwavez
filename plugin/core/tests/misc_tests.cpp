// SPSC queue and MIDI routing (mirrors cases from tests/midi.test.ts).
#include "check.h"
#include "mkwavez/midi.h"
#include "mkwavez/spsc_queue.h"

#include <thread>
#include <vector>

using namespace mkwavez;

TEST("spsc: batches are all-or-nothing and FIFO") {
    SpscQueue<int> q(4);
    const int a[] = {1, 2, 3};
    CHECK(q.pushBatch(a, 3));
    CHECK(!q.pushBatch(a, 2)); // only one slot left
    CHECK(q.push(4));
    CHECK(!q.push(5));
    int x = 0;
    for (int want = 1; want <= 4; ++want) CHECK(q.pop(x) && x == want);
    CHECK(!q.pop(x));
}

TEST("spsc: concurrent producer / consumer keeps order") {
    SpscQueue<int> q(64);
    constexpr int N = 200000;
    std::thread producer([&] {
        for (int i = 0; i < N;) {
            int batch[3] = {i, i + 1, i + 2};
            const int n = std::min(3, N - i);
            if (q.pushBatch(batch, (size_t) n)) i += n;
        }
    });
    int expect = 0;
    bool ordered = true;
    while (expect < N) {
        int v;
        if (q.pop(v)) ordered = ordered && v == expect++;
    }
    producer.join();
    CHECK(ordered);
}

namespace {

struct Collect {
    std::vector<MidiVoiceEvent> evs;
    void operator()(const MidiVoiceEvent& e) { evs.push_back(e); }
};

MidiRouting routing(bool omni, int selected, std::initializer_list<int> ids) {
    MidiRouting r;
    r.omni = omni;
    r.selectedVoice = selected;
    for (int id : ids) r.voiceIds[r.voiceCount++] = id;
    return r;
}

MidiMessage msg(std::initializer_list<uint8_t> bytes) {
    std::vector<uint8_t> b(bytes);
    return parseMidi(b.data(), (int) b.size());
}

} // namespace

TEST("midi: parse") {
    auto m = msg({0x91, 60, 100});
    CHECK(m.kind == MidiMessage::noteOn && m.channel == 2 && m.a == 60 && m.b == 100);
    CHECK(msg({0x90, 60, 0}).kind == MidiMessage::noteOff);
    CHECK(msg({0xe0, 0x7f, 0x7f}).value == 1);
    CHECK(msg({0xe0, 0, 0}).value == -1);
    CHECK(msg({0xe0, 0, 0x40}).value == 0);
    CHECK(msg({0xf8}).kind == MidiMessage::none);
    CHECK(msg({0xc0, 5}).kind == MidiMessage::none);
}

TEST("midi: MPE member channels and polyphonic aftertouch") {
    CHECK(msg({0xa1, 60, 127}).kind == MidiMessage::polyPressure && msg({0xa1, 60, 127}).value == 1);
    MidiRouter router;
    Collect c;
    auto r = routing(false, 2, {1, 2, 3});
    r.mpe = true;
    router.route(msg({0xe3, 0x7f, 0x7f}), r, c); // channel 4 bend before its note: no note yet
    CHECK(c.evs.empty());
    router.route(msg({0x93, 67, 90}), r, c);    // the note starts with it, on the selected voice
    CHECK(c.evs.size() == 2 && c.evs[0].type == MidiVoiceEvent::noteOn && c.evs[0].voiceId == 2);
    CHECK(c.evs[1].type == MidiVoiceEvent::noteBend && c.evs[1].note == 67 && c.evs[1].semitones == MPE_BEND_RANGE);
    c.evs.clear();
    router.route(msg({0xd3, 127}), r, c);       // member pressure → that note
    router.route(msg({0xb3, 74, 127}), r, c);   // CC 74 → slide (not a cc)
    router.route(msg({0xe0, 0x7f, 0x7f}), r, c); // channel 1: voice-wide bend
    CHECK(c.evs.size() == 3);
    CHECK(c.evs[0].type == MidiVoiceEvent::notePressure && c.evs[0].semitones == 1);
    CHECK(c.evs[1].type == MidiVoiceEvent::noteSlide && c.evs[1].note == 67);
    CHECK(c.evs[2].type == MidiVoiceEvent::bend && c.evs[2].voiceId == 2 && c.evs[2].semitones == 2);
    c.evs.clear();
    router.route(msg({0xa3, 67, 64}), r, c);    // poly aftertouch on the held key
    router.route(msg({0xa3, 68, 64}), r, c);    // not held: nothing
    CHECK(c.evs.size() == 1 && c.evs[0].type == MidiVoiceEvent::notePressure && c.evs[0].voiceId == 2);
}

TEST("midi: a note-off reaches the voice its note-on went to") {
    MidiRouter router;
    Collect c;
    router.route(msg({0x90, 60, 100}), routing(true, 1, {1, 2}), c);
    router.route(msg({0x80, 60, 0}), routing(true, 2, {1, 2}), c);
    CHECK(c.evs.size() == 2);
    CHECK(c.evs[0].type == MidiVoiceEvent::noteOn && c.evs[0].voiceId == 1);
    CHECK(c.evs[1].type == MidiVoiceEvent::noteOff && c.evs[1].voiceId == 1);
    CHECK(router.heldCount() == 0);
}

TEST("midi: channel routing, missing voices, repeated note-on") {
    MidiRouter router;
    Collect c;
    const auto r = routing(false, 1, {1, 3});
    router.route(msg({0x92, 64, 90}), r, c); // channel 3 → voice 3
    router.route(msg({0x91, 64, 90}), r, c); // channel 2: no voice 2
    router.route(msg({0x92, 64, 80}), r, c); // repeat: off then on
    CHECK(c.evs.size() == 3);
    CHECK(c.evs[0].voiceId == 3);
    CHECK(c.evs[1].type == MidiVoiceEvent::noteOff && c.evs[1].voiceId == 3);
    CHECK(c.evs[2].type == MidiVoiceEvent::noteOn && c.evs[2].velocity == 80);
}

TEST("midi: bend follows retargeting; all-notes-off; reset controllers") {
    MidiRouter router;
    Collect c;
    router.route(msg({0xe0, 0, 0x60}), routing(true, 1, {1, 2}), c);
    CHECK(c.evs.size() == 1 && c.evs[0].voiceId == 1 && c.evs[0].semitones > 0);
    const double semis = c.evs[0].semitones;
    c.evs.clear();
    router.retarget(routing(true, 2, {1, 2}), c);
    CHECK(c.evs.size() == 2);
    CHECK(c.evs[0].voiceId == 1 && c.evs[0].semitones == 0);
    CHECK(c.evs[1].voiceId == 2 && c.evs[1].semitones == semis);
    c.evs.clear();
    router.route(msg({0xb0, CC_RESET_ALL_CONTROLLERS, 0}), routing(true, 2, {1, 2}), c);
    CHECK(c.evs.size() == 1 && c.evs[0].voiceId == 2 && c.evs[0].semitones == 0);
    c.evs.clear();
    router.route(msg({0x90, 60, 100}), routing(true, 1, {1, 2}), c);
    router.route(msg({0x90, 62, 100}), routing(true, 2, {1, 2}), c);
    c.evs.clear();
    router.route(msg({0xb0, CC_ALL_NOTES_OFF, 0}), routing(true, 2, {1, 2}), c);
    CHECK(c.evs.size() == 2);
    CHECK(router.heldCount() == 0);
}

TEST("midi: CC map assigns uniquely and patches (simple and synth targets)") {
    CcMap map;
    CHECK(map.cc[(size_t) CcParam::position] == CC_MOD_WHEEL);
    map.assign(CcParam::level, CC_MOD_WHEEL);
    CHECK(map.cc[(size_t) CcParam::position] == -1);
    auto p = ccPatch(map, CC_MOD_WHEEL, 127);
    CHECK(p.has(CcParam::level) && p.get(CcParam::level) == 1 && !p.has(CcParam::position));
    map.assign(CcParam::lfoRate, 20);
    p = ccPatch(map, 20, 0);
    CHECK_NEAR(p.get(CcParam::lfoRate), LFO_RATE_MIN, 1e-12);
    CHECK(ccPatch(map, 21, 5).empty());
    map.assign(CcParam::position, 120); // channel mode: unassigns
    CHECK(map.cc[(size_t) CcParam::position] == -1);

    // Synth targets, as src/core/midi.ts targetPatch applies them.
    map.assign(CcParam::cutoff, 30);
    map.assign(CcParam::oscMix, 31);
    map.assign(CcParam::lfo2Rate, 32);
    map.assign(CcParam::filterEnv, 33);
    map.assign(CcParam::glide, 34);
    VoiceParams v;
    v.synth.lfos[1].sync = true;
    ccPatch(map, 30, 127).applyTo(v);
    ccPatch(map, 31, 127).applyTo(v);
    ccPatch(map, 32, 0).applyTo(v);
    ccPatch(map, 33, 0).applyTo(v);
    ccPatch(map, 34, 127).applyTo(v);
    CHECK_NEAR(v.synth.cutoff, CUTOFF_MAX, 1e-9);
    CHECK(v.synth.aLevel == 0 && v.synth.bLevel == 1);
    CHECK_NEAR(v.synth.lfos[1].rate, CC_LFO_RATE_MIN, 1e-12);
    CHECK(!v.synth.lfos[1].sync);
    CHECK(v.synth.envAmount == -1);
    CHECK_NEAR(v.synth.glide, CC_GLIDE_MAX, 1e-12);
}

TEST("midi: channel pressure and mod wheel are tracked like the bend") {
    MidiRouter router;
    Collect c;
    router.route(msg({0xd0, 64}), routing(true, 1, {1, 2}), c);
    CHECK(c.evs.size() == 1 && c.evs[0].type == MidiVoiceEvent::pressure && c.evs[0].voiceId == 1);
    CHECK_NEAR(c.evs[0].semitones, 64 / 127.0, 1e-12);
    c.evs.clear();
    router.route(msg({0xb0, CC_MOD_WHEEL, 127}), routing(true, 1, {1, 2}), c);
    CHECK(c.evs.size() == 2 && c.evs[0].type == MidiVoiceEvent::cc && c.evs[1].type == MidiVoiceEvent::mod && c.evs[1].semitones == 1);
    c.evs.clear();
    router.retarget(routing(true, 2, {1, 2}), c);
    // Each of mod and pressure: zero the old voice, move the value to the new one.
    int zeroed = 0, moved = 0;
    for (const auto& e : c.evs) {
        if (e.type != MidiVoiceEvent::mod && e.type != MidiVoiceEvent::pressure) continue;
        if (e.voiceId == 1 && e.semitones == 0) ++zeroed;
        if (e.voiceId == 2 && e.semitones > 0) ++moved;
    }
    CHECK(zeroed == 2 && moved == 2);
    c.evs.clear();
    router.route(msg({0xb0, CC_RESET_ALL_CONTROLLERS, 0}), routing(true, 2, {1, 2}), c);
    CHECK(c.evs.size() == 2);
}
