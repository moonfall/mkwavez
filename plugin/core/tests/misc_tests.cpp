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

TEST("midi: CC map assigns uniquely and patches") {
    CcMap map;
    CHECK(map.cc[(size_t) CcParam::position] == CC_MOD_WHEEL);
    map.assign(CcParam::level, CC_MOD_WHEEL);
    CHECK(map.cc[(size_t) CcParam::position] == -1);
    auto p = ccPatch(map, CC_MOD_WHEEL, 127);
    CHECK(p.has(VoicePatch::level) && p.get(VoicePatch::level) == 1 && !p.has(VoicePatch::position));
    map.assign(CcParam::lfoRate, 20);
    p = ccPatch(map, 20, 0);
    CHECK_NEAR(p.get(VoicePatch::lfoRate), LFO_RATE_MIN, 1e-12);
    CHECK(ccPatch(map, 21, 5).mask == 0);
    map.assign(CcParam::position, 120); // channel mode: unassigns
    CHECK(map.cc[(size_t) CcParam::position] == -1);
}
