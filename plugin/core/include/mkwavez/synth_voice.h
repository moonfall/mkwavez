// Port of src/core/engine/synthVoice.ts: the Synth voice's signal path (osc A / B with
// unison, sub, noise, ring, FM, hard sync → drive → multimode filter → saturation, amp),
// its envelopes, LFOs and mod matrix. The engine owns note handling, the amp envelope and
// the Simple ↔ Synth crossfade. Fixed state, no allocation; deterministic.
#pragma once

#include "envelope.h"
#include "prng.h"
#include "svf.h"
#include "voice.h"
#include "wtosc.h"

namespace mkwavez {

inline constexpr double CONTROL_SMOOTH_SEC = 0.005;
inline constexpr uint32_t NOISE_SEED = 0x5eed;
inline constexpr uint32_t NOISE_R_SEED = 0x5eee;
inline constexpr uint32_t MOD_SEED = 0x10f0;
inline constexpr double UNISON_GLIDE_SEC = 0.03;
inline constexpr double UNISON_FADE_SEC = 0.01;
inline constexpr double PINK_GAIN = 0.32;

/** What the engine hands a Synth voice each control block. */
struct SynthControl {
    /** The engine's smoothed pitch bend (±2 st scale; rescaled to the voice's bend range). */
    double bend = 0;
    int blockLen = CONTROL_BLOCK;
    const TableMap* tables = nullptr;
    const PackedWavetable* wtA = nullptr;
    const PackedWavetable* wtB = nullptr;
    double slew = 0;
    double gainTarget = 0;
    double bpm = 132;
    double wheel = 0, pressure = 0;
    /** The note's MPE slide and per-note bend (semitones). */
    double slide = 0, noteBend = 0;
    double unisonScale = 1;
    /** Transport position in beats, or −1 when stopped. */
    double beat = -1;
};

double pitchFreq(double semis);
double freqPitch(double freq);

class SynthVoice {
public:
    SynthVoice(double sampleRate, int32_t voiceId, int blockLen, const SynthParams& s);

    void configure(const SynthParams& s, int blockLen);
    void noteOn(const VoiceParams& p, double pitch, double vel, bool legato, bool retrigger, bool sounding);
    void gateOff(const VoiceParams& p);
    void resync(const VoiceParams& p, double pitch, bool gated, bool sounding);
    /** A pooled note taken over by another voice: forget its table mixes and cutoff smoothing. */
    void reclaim();
    void control(const VoiceParams& p, const SynthControl& c);
    /** One sample (amp envelope value `e`) into outL / outR; returns the mid. */
    double render(const VoiceParams& p, double e, double blockT, const TableMap& tables);

    template <typename Fn>
    void forEachTable(Fn&& fn) const {
        a.forEachTable(fn);
        b.forEachTable(fn);
        aR.forEachTable(fn);
        bR.forEachTable(fn);
    }

    WtOsc a, b;
    /** Right-channel table mixes (stereo position / a stereo LFO on a position). */
    WtOsc aR, bR;
    bool rA = false, rB = false;
    bool stereo = false;
    Adsr fenv, penv, menv;
    MultiFilter filter, filterR;
    double outL = 0, outR = 0;
    double posA = 0, posYA = 0, posB = 0, posYB = 0;
    double panL0 = 1, panL1 = 1, panR0 = 1, panR1 = 1;
    double vel = 1;
    double pitch = 57, target = 57;

private:
    void retune(const VoiceParams& p);
    void mips(const SynthParams& s, double incA, double incB);
    void pitches(const VoiceParams& p, double bendSemis);
    void stepLfos(const SynthParams& s, double bpm, int blockLen, double beat);
    void unison(const SynthParams& s, double scale);
    int copies(int n, double* w0, double* w1, double* ph, double centre, double* pl, double* pn);
    double place(int count, int n, double cents, double spr, double* pl, double* pn, double* rat, double* gl, double* gr);

    double sampleRate;
    int blockLen = 64;
    double phA[MAX_UNISON]{}, phB[MAX_UNISON]{};
    double ratA[MAX_UNISON]{1, 1, 1, 1}, ratB[MAX_UNISON]{1, 1, 1, 1};
    double gAL[MAX_UNISON]{1, 1, 1, 1}, gAR[MAX_UNISON]{1, 1, 1, 1}, gBL[MAX_UNISON]{1, 1, 1, 1}, gBR[MAX_UNISON]{1, 1, 1, 1};
    double wA0[MAX_UNISON]{}, wA1[MAX_UNISON]{}, wB0[MAX_UNISON]{}, wB1[MAX_UNISON]{};
    int uA = 1, uB = 1;
    double maxRatA = 1, maxRatB = 1;
    double uniStep, uniGlide;
    double plA[MAX_UNISON]{}, plB[MAX_UNISON]{}, pnA[MAX_UNISON]{}, pnB[MAX_UNISON]{};
    double phCA = 0, phCB = 0;
    Prng noise;
    double pink0 = 0, pink1 = 0, pink2 = 0;
    double subPhase = 0;
    double incA0 = 0, incA1 = 0, incB0 = 0, incB1 = 0, incS0 = 0, incS1 = 0;
    double cut0 = 0, cut1 = 0, cutS = 0;
    bool cutSet = false;
    double k0 = 2, k1 = 2;
    double lv0[5]{}, lv1[5]{};
    double gain = 0, gainR = 0;
    double opA0 = 0, opA1 = 0, opB0 = 0, opB1 = 0;
    double psA0 = 0, psA1 = 0, psB0 = 0, psB1 = 0;
    double fsS = 0, dCutS = 0;
    double offL0 = 0, offL1 = 0, offR0 = 0, offR1 = 0;
    double dLv0[2]{}, dLv1[2]{};
    double waA0 = 0, waA1 = 0, waB0 = 0, waB1 = 0, wsA = 1, wsB = 1;
    uint8_t lfoDone[LFO_COUNT]{};
    bool gateHeld = false;
    double nbS = 0;
    bool nbSnap = false;
    double dFm0 = 0, dFm1 = 0, dSat0 = 0, dSat1 = 0, dW0 = 0, dW1 = 0;
    Prng noiseR;
    double pinkR0 = 0, pinkR1 = 0, pinkR2 = 0;
    double nwC = 1, nwS = 0;
    bool spread = false;
    double lfoOutR[LFO_COUNT]{};
    bool lfoStereo = false;
    double srcR[N_SOURCES]{};
    double dstR[N_DESTS]{};
    double gainTargetR = 0;
    double lfoPhase[LFO_COUNT]{}, lfoCur[LFO_COUNT]{}, lfoPrev[LFO_COUNT]{}, lfoAge[LFO_COUNT]{}, lfoOut[LFO_COUNT]{};
    Prng modRng;
    double noteRand = 0;
    double src[N_SOURCES]{};
    double dst[N_DESTS]{};
    double driveM = 0;
    double envCfg[11];
    double smooth;
    double lastBend = 0;
    double gainTarget = 0;
};

} // namespace mkwavez
