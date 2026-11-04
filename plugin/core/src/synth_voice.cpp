#include "mkwavez/synth_voice.h"

#include "mkwavez/midi.h"

#include <algorithm>
#include <cmath>

namespace mkwavez {

namespace {

constexpr double TWO_PI = 2 * PI;
constexpr double UNISON_PHASE = 0.381966;
/** Unison places (fraction of the detune) and pans for n copies (index n). */
constexpr double UNISON_PLACES[5][4] = {{0}, {0}, {-0.5, 0.5}, {0, -1, 1}, {-1, -1.0 / 3, 1.0 / 3, 1}};
constexpr double UNISON_PANS[5][4] = {{0}, {0}, {-1, 1}, {0, -1, 1}, {-1, -1.0 / 3, 1.0 / 3, 1}};

double clamp01(double x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
double clamp11(double x) { return x < -1 ? -1 : x > 1 ? 1 : x; }

/** Smoothed stereo controls snap onto their target this close. */
constexpr double SNAP = 1e-6;
/** One-pole step of x towards t by c, snapping onto t within SNAP. */
double approach(double x, double t, double c) {
    const double y = x + (t - x) * c;
    return std::abs(t - y) < SNAP ? t : y;
}

double polyBlep(double t, double dt) {
    if (t < dt) {
        const double x = t / dt;
        return x + x - x * x - 1;
    }
    if (t > 1 - dt) {
        const double x = (t - 1) / dt;
        return x * x + x + x + 1;
    }
    return 0;
}

double foldWave(double x) {
    double t = (x + 1) * 0.25;
    t -= std::floor(t);
    return 1 - std::abs(4 * t - 2);
}

/** See warpPhase / warpOut / warpSpeed in synthVoice.ts. */
double warpPhase(WarpMode mode, double ph, double a) {
    switch (mode) {
        case WarpMode::sync:
        case WarpMode::formant: {
            const double x = ph * (1 + (WARP_SYNC_MAX - 1) * std::abs(a));
            return x - std::floor(x);
        }
        case WarpMode::bend: return ph + ((0.9 * a) / TWO_PI) * std::sin(TWO_PI * ph);
        case WarpMode::squeeze: {
            const double w = 0.5 + 0.45 * a;
            return ph < w ? (0.5 * ph) / w : 0.5 + (0.5 * (ph - w)) / (1 - w);
        }
        case WarpMode::quantize: {
            const double m = std::abs(a);
            if (m == 0) return ph;
            const double n = std::floor(std::pow(2.0, 10 - 8 * m) + 0.5);
            return std::floor(ph * n) / n;
        }
        default: return ph;
    }
}

double warpOut(WarpMode mode, double x, double ph, double a) {
    const double m = std::abs(a);
    if (mode == WarpMode::formant) return x * (1 - m + m * (0.5 - 0.5 * std::cos(TWO_PI * ph)));
    if (mode == WarpMode::fold) return m == 0 ? x : foldWave(x * (1 + 4 * m));
    return x;
}

double warpSpeed(WarpMode mode, double a) {
    const double m = std::abs(a);
    switch (mode) {
        case WarpMode::sync:
        case WarpMode::formant: return 1 + (WARP_SYNC_MAX - 1) * m;
        case WarpMode::bend: return 1 + 0.9 * m;
        case WarpMode::squeeze: return 0.5 / (1 - (0.5 + 0.45 * m));
        case WarpMode::fold: return 1 + 4 * m;
        default: return 1;
    }
}

double readWarp(const WtOsc& o, double ph, double t, WarpMode mode, double a) {
    return mode == WarpMode::none ? o.read(ph, t) : warpOut(mode, o.read(warpPhase(mode, ph, a), t), ph, a);
}

/** JS Math.round. */
double jsRound(double x) { return std::floor(x + 0.5); }

} // namespace

void applyMatrix(const std::array<ModSlot, MOD_SLOTS>& slots, const double* src, double* dst) {
    for (int i = 0; i < N_DESTS; ++i) dst[i] = 0;
    for (const auto& s : slots) {
        if (s.src == SRC_NONE || s.dst == DST_NONE || s.amt == 0) continue;
        dst[s.dst] += s.amt * src[s.src];
    }
}

double pitchFreq(double semis) { return 440 * std::pow(2.0, (semis - 69) / 12); }
double freqPitch(double freq) { return 69 + 12 * std::log2(freq / 440); }

SynthVoice::SynthVoice(double sr, int32_t voiceId, int block, const SynthParams& s)
    : sampleRate(sr),
      blockLen(block),
      uniStep(block / (UNISON_FADE_SEC * sr)),
      uniGlide(1 - std::exp(-block / (UNISON_GLIDE_SEC * sr))),
      noise(deriveSeed(NOISE_SEED, (uint32_t) voiceId)),
      noiseR(deriveSeed(NOISE_R_SEED, (uint32_t) voiceId)),
      modRng(deriveSeed(MOD_SEED, (uint32_t) voiceId)),
      smooth(1 - std::exp(-block / (CONTROL_SMOOTH_SEC * sr))) {
    for (double& c : envCfg) c = -1;
    wA0[0] = wA1[0] = wB0[0] = wB1[0] = 1;
    for (int i = 0; i < LFO_COUNT; ++i) {
        lfoPhase[i] = s.lfos[(size_t) i].phase;
        lfoCur[i] = modRng.bipolar();
        lfoPrev[i] = lfoCur[i];
        lfoAge[i] = 1e9;
    }
}

void SynthVoice::configure(const SynthParams& s, int block) {
    double* c = envCfg;
    const double ad = s.mMode == ModEnvMode::ad ? 1 : 0;
    if (c[0] == s.fAttack && c[1] == s.fDecay && c[2] == s.fSustain && c[3] == s.fRelease && c[4] == s.pAttack && c[5] == s.pDecay &&
        c[6] == s.mAttack && c[7] == s.mDecay && c[8] == s.mSustain && c[9] == s.mRelease && c[10] == ad)
        return;
    c[0] = s.fAttack;
    c[1] = s.fDecay;
    c[2] = s.fSustain;
    c[3] = s.fRelease;
    c[4] = s.pAttack;
    c[5] = s.pDecay;
    c[6] = s.mAttack;
    c[7] = s.mDecay;
    c[8] = s.mSustain;
    c[9] = s.mRelease;
    c[10] = ad;
    fenv.configure(s.fAttack, s.fDecay, s.fSustain, s.fRelease, sampleRate);
    penv.configure(s.pAttack, s.pDecay, 0, s.pDecay, sampleRate / block);
    if (ad != 0)
        menv.configure(s.mAttack, s.mDecay, 0, s.mDecay, sampleRate / block);
    else
        menv.configure(s.mAttack, s.mDecay, s.mSustain, s.mRelease, sampleRate / block);
}

void SynthVoice::noteOn(const VoiceParams& p, double notePitch, double velocity, bool legato, bool retrigger, bool sounding) {
    const SynthParams& s = p.synth;
    target = notePitch;
    vel = velocity;
    gateHeld = true;
    const bool glide = s.glide > 0 && sounding && (!s.glideLegato || legato);
    if (!glide) pitch = notePitch;
    if (retrigger) {
        nbS = 0;
        nbSnap = true;
        configure(s, blockLen);
        fenv.gateOn();
        penv.gateOn();
        menv.gateOn();
        noteRand = modRng.bipolar();
        for (int i = 0; i < LFO_COUNT; ++i) {
            const LfoParams& l = s.lfos[(size_t) i];
            lfoAge[i] = 0;
            lfoDone[i] = 0;
            if (isOneShot(l.shape))
                lfoPhase[i] = l.phase;
            else if (l.retrig) {
                lfoPhase[i] = l.phase;
                lfoPrev[i] = lfoCur[i];
                lfoCur[i] = modRng.bipolar();
            }
        }
    }
    if (!glide) retune(p);
}

void SynthVoice::gateOff(const VoiceParams& p) {
    gateHeld = false;
    fenv.gateOff();
    penv.gateOff();
    if (p.synth.mMode != ModEnvMode::ad) menv.gateOff();
}

void SynthVoice::retune(const VoiceParams& p) {
    pitches(p, lastBend);
    incA0 = incA1;
    incB0 = incB1;
    incS0 = incS1;
    mips(p.synth, incA1, incB1);
}

void SynthVoice::mips(const SynthParams& s, double incA, double incB) {
    const double sr = sampleRate;
    const int ring = s.ringLevel > 0 || lv1[4] > 1e-4 ? 1 : 0;
    const double fa = incA * maxRatA * sr * wsA;
    const double fb = incB * maxRatB * sr * wsB;
    const double fmMax = dFm0 == 0 && dFm1 == 0 ? s.fm : clamp01(s.fm + std::max(dFm0, dFm1));
    const double side = fmMax > 0 ? (TWO_PI * FM_DEPTH * fmMax + 1) * fb : 0;
    const double limit = MIP_NYQUIST_FRACTION * sr;
    int la = MIP_LEVELS - 1;
    for (int l = 0; l < MIP_LEVELS; ++l) {
        if (fa * MIP_HARMONICS[(size_t) l] + side < limit) {
            la = l;
            break;
        }
    }
    a.mipLevel = std::min(MIP_LEVELS - 1, la + ring);
    b.mipLevel = std::min(MIP_LEVELS - 1, mipLevelFor(fb, sr) + ring);
}

void SynthVoice::resync(const VoiceParams& p, double notePitch, bool gated, bool sounding) {
    target = pitch = notePitch;
    configure(p.synth, blockLen);
    gateHeld = gated;
    if (gated) {
        fenv.gateOn();
        penv.gateOn();
        menv.gateOn();
    } else {
        for (Adsr* env : {&fenv, &penv, &menv}) {
            env->value = 0;
            env->stage = Adsr::Idle;
        }
    }
    if (!sounding) {
        filter.reset();
        filterR.reset();
    }
    retune(p);
}

void SynthVoice::reclaim() {
    for (WtOsc* o : {&a, &b, &aR, &bR}) {
        o->clear();
        o->heldId = o->targetId = -1;
    }
    rA = rB = false;
    cutSet = false;
}

void SynthVoice::pitches(const VoiceParams& p, double bendSemis) {
    const SynthParams& s = p.synth;
    const double sr = sampleRate;
    const double pe = penv.value * s.pAmount;
    const double base = pitch + bendSemis + nbS;
    const double pa = base + oscSemis(s.aOct, s.aCoarse, s.aFine) + (s.pTarget != PitchTarget::b ? pe : 0) + dst[DST_PITCH_A] * MOD_PITCH_SEMIS;
    const double pb = base + oscSemis(s.bOct, s.bCoarse, s.bFine) + (s.pTarget != PitchTarget::a ? pe : 0) + dst[DST_PITCH_B] * MOD_PITCH_SEMIS;
    const double fa = std::min(pitchFreq(pa), sr * 0.45);
    incA1 = fa / sr;
    incB1 = std::min(pitchFreq(pb), sr * 0.45) / sr;
    incS1 = fa / (s.subOct >= 2 ? 4 : 2) / sr;
}

void SynthVoice::stepLfos(const SynthParams& s, double bpm, int block, double beat) {
    const double dt = block / sampleRate;
    bool st = false;
    for (int i = 0; i < LFO_COUNT; ++i) {
        const LfoParams& l = s.lfos[(size_t) i];
        const double m = std::max(-1.0, std::min(1.0, dst[DST_LFO1_RATE + i]));
        const double mult = m == 0 ? 1 : std::pow(2.0, m * MOD_LFO_RATE_OCTAVES);
        const double inc = std::min(LFO_RATE_MAX_HZ * 2, std::max(0.0, lfoRateHz(l, bpm) * mult)) * dt;
        double ph = lfoPhase[i] + inc;
        const bool once = isOneShot(l.shape);
        if (once) {
            if (lfoDone[i] || ph >= 1) {
                ph = 1;
                lfoDone[i] = 1;
            }
        } else if (l.sync && !l.retrig && beat >= 0 && m == 0) {
            const double t = beat / LFO_DIV_BEATS[(size_t) l.div] + l.phase;
            double d = t - std::floor(t) - ph;
            d -= jsRound(d);
            ph += std::max(-0.5 * inc, std::min(0.5 * inc, d));
        }
        if (ph >= 1 && !once) {
            ph -= std::floor(ph);
            lfoPrev[i] = lfoCur[i];
            lfoCur[i] = modRng.bipolar();
        } else if (ph < 0)
            ph -= std::floor(ph);
        lfoPhase[i] = ph;
        const double age = lfoAge[i];
        const double fade = l.fade > 0 ? std::min(1.0, age / l.fade) : 1;
        lfoAge[i] = age + dt;
        const double dm = dst[DST_LFO1_DEPTH + i];
        const double depth = dm != 0 ? clamp01(l.depth + dm) : l.depth;
        lfoOut[i] = lfoWave(l.shape, ph, lfoCur[i], lfoPrev[i]) * depth * fade;
        if (l.stereo > 0 && depth > 0 && isPeriodicShape(l.shape)) {
            double phR = ph + l.stereo;
            if (phR >= 1) phR -= 1;
            lfoOutR[i] = lfoWave(l.shape, phR, lfoCur[i], lfoPrev[i]) * depth * fade;
            st = true;
        } else
            lfoOutR[i] = lfoOut[i];
    }
    lfoStereo = st;
}

void SynthVoice::control(const VoiceParams& p, const SynthControl& c) {
    const SynthParams& s = p.synth;
    blockLen = c.blockLen;
    configure(s, blockLen);
    if (pitch != target) {
        if (s.glide > 0) {
            const double coef = 1 - std::exp(-CONTROL_BLOCK / (std::max(1e-4, s.glide / 4) * sampleRate));
            pitch += (target - pitch) * coef;
            if (std::abs(target - pitch) < 1e-4) pitch = target;
        } else
            pitch = target;
    }
    penv.next();
    menv.next();
    stepLfos(s, c.bpm, blockLen, c.beat);
    src[SRC_LFO1] = lfoOut[0];
    src[SRC_LFO2] = lfoOut[1];
    src[SRC_LFO3] = lfoOut[2];
    src[SRC_FENV] = fenv.value;
    src[SRC_PENV] = penv.value;
    src[SRC_MENV] = menv.value;
    src[SRC_VEL] = vel;
    src[SRC_WHEEL] = c.wheel;
    src[SRC_AT] = c.pressure;
    src[SRC_KEY] = (pitch - 60) / 24;
    src[SRC_RAND] = noteRand;
    src[SRC_MACRO1] = s.macro1;
    src[SRC_MACRO2] = s.macro2;
    src[SRC_MACRO3] = s.macro3;
    src[SRC_MACRO4] = s.macro4;
    src[SRC_GATE] = gateHeld ? 1 : 0;
    src[SRC_SLIDE] = c.slide;
    applyMatrix(s.mods, src, dst);
    const double* dR = dst;
    if (lfoStereo) {
        for (int i = 0; i < N_SOURCES; ++i) srcR[i] = src[i];
        srcR[SRC_LFO1] = lfoOutR[0];
        srcR[SRC_LFO2] = lfoOutR[1];
        srcR[SRC_LFO3] = lfoOutR[2];
        applyMatrix(s.mods, srcR, dstR);
        dR = dstR;
    }
    const double bend = (c.bend * s.bendRange) / BEND_RANGE_SEMITONES;
    lastBend = bend;
    if (nbSnap) {
        nbS = c.noteBend;
        nbSnap = false;
    } else if (nbS != c.noteBend) {
        nbS += (c.noteBend - nbS) * smooth;
        if (std::abs(c.noteBend - nbS) < 1e-4) nbS = c.noteBend;
    }
    incA0 = incA1;
    incB0 = incB1;
    incS0 = incS1;
    pitches(p, bend);
    dFm0 = dFm1;
    dSat0 = dSat1;
    dW0 = dW1;
    dFm1 = dst[DST_FM];
    dSat1 = dst[DST_SAT];
    dW1 = dst[DST_WIDTH];
    unison(s, c.unisonScale);
    waA0 = waA1;
    waB0 = waB1;
    if (s.aWarp != WarpMode::none) {
        waA1 = approach(waA1, clamp11(s.aWarpAmt + dst[DST_WARP_A]), smooth);
        wsA = warpSpeed(s.aWarp, std::max(std::abs(waA0), std::abs(waA1)));
    } else
        wsA = 1;
    if (s.bWarp != WarpMode::none) {
        waB1 = approach(waB1, clamp11(s.bWarpAmt + dst[DST_WARP_B]), smooth);
        wsB = warpSpeed(s.bWarp, std::max(std::abs(waB0), std::abs(waB1)));
    } else
        wsB = 1;
    mips(s, std::max(incA0, incA1), std::max(incB0, incB1));
    aR.mipLevel = a.mipLevel;
    bR.mipLevel = b.mipLevel;

    posA = dst[DST_POS_A] != 0 ? reflect01(p.position + dst[DST_POS_A]) : p.position;
    posYA = dst[DST_POSY_A] != 0 ? reflect01(p.positionY + dst[DST_POSY_A]) : p.positionY;
    posB = dst[DST_POS_B] != 0 ? reflect01(s.b.position + dst[DST_POS_B]) : s.b.position;
    posYB = dst[DST_POSY_B] != 0 ? reflect01(s.b.positionY + dst[DST_POSY_B]) : s.b.positionY;
    const double pAR = dR[DST_POS_A] != 0 ? reflect01(p.position + dR[DST_POS_A]) : p.position;
    const double pYAR = dR[DST_POSY_A] != 0 ? reflect01(p.positionY + dR[DST_POSY_A]) : p.positionY;
    const double pBR = dR[DST_POS_B] != 0 ? reflect01(s.b.position + dR[DST_POS_B]) : s.b.position;
    const double pYBR = dR[DST_POSY_B] != 0 ? reflect01(s.b.positionY + dR[DST_POSY_B]) : s.b.positionY;
    const double xAL = s.aPosSpread > 0 ? reflect01(posA - s.aPosSpread / 2) : posA;
    const double xAR = s.aPosSpread > 0 ? reflect01(pAR + s.aPosSpread / 2) : pAR;
    const double xBL = s.bPosSpread > 0 ? reflect01(posB - s.bPosSpread / 2) : posB;
    const double xBR = s.bPosSpread > 0 ? reflect01(pBR + s.bPosSpread / 2) : pBR;
    a.hold();
    if ((xAR != xAL || pYAR != posYA) && !rA) {
        aR.copyFrom(a);
        rA = true;
    }
    if (c.wtA) a.resolve(*c.tables, *c.wtA, p.windowStart, p.windowEnd, p.windowStartY, p.windowEndY, xAL, posYA, c.slew);
    if (rA) {
        aR.hold();
        if (c.wtA) aR.resolve(*c.tables, *c.wtA, p.windowStart, p.windowEnd, p.windowStartY, p.windowEndY, xAR, pYAR, c.slew);
        if (xAR == xAL && pYAR == posYA && aR.sameMix(a)) {
            rA = false;
            aR.clear();
        }
    }
    b.hold();
    if ((xBR != xBL || pYBR != posYB) && !rB) {
        bR.copyFrom(b);
        rB = true;
    }
    if (c.wtB) b.resolve(*c.tables, *c.wtB, s.b.windowStart, s.b.windowEnd, s.b.windowStartY, s.b.windowEndY, xBL, posYB, c.slew);
    if (rB) {
        bR.hold();
        if (c.wtB) bR.resolve(*c.tables, *c.wtB, s.b.windowStart, s.b.windowEnd, s.b.windowStartY, s.b.windowEndY, xBR, pYBR, c.slew);
        if (xBR == xBL && pYBR == posYB && bR.sameMix(b)) {
            rB = false;
            bR.clear();
        }
    }

    const double cut = std::log2(s.cutoff) + (s.keyTrack * (pitch - 60)) / 12 + s.velAmount * (vel - 1) * FILTER_VEL_OCTAVES +
                       dst[DST_CUTOFF] * MOD_CUTOFF_OCTAVES;
    if (!cutSet) {
        cutS = cut1 = cut;
        cutSet = true;
    } else
        cutS += (cut - cutS) * smooth;
    cut0 = cut1;
    cut1 = cutS;
    k0 = k1;
    k1 += (resonanceK(clamp01(s.resonance + dst[DST_RES])) - k1) * smooth;
    driveM = clamp01(s.drive + dst[DST_DRIVE]);
    for (int i = 0; i < 5; ++i) lv0[i] = lv1[i];
    lv1[0] += (clamp01(s.aLevel + dst[DST_LEVEL_A]) - lv1[0]) * smooth;
    lv1[1] += (clamp01(s.bLevel + dst[DST_LEVEL_B]) - lv1[1]) * smooth;
    lv1[2] += (clamp01(s.subLevel + dst[DST_SUB]) - lv1[2]) * smooth;
    lv1[3] += (clamp01(s.noiseLevel + dst[DST_NOISE]) - lv1[3]) * smooth;
    lv1[4] += ((dst[DST_RING] != 0 ? clamp01(s.ringLevel + dst[DST_RING]) : s.ringLevel) - lv1[4]) * smooth;
    // Stereo controls (see synthVoice.ts).
    const double sm = smooth;
    fsS = approach(fsS, clamp11(s.filterSpread + dst[DST_F_SPREAD]) * FILTER_SPREAD_OCTAVES, sm);
    dCutS = approach(dCutS, (dR[DST_CUTOFF] - dst[DST_CUTOFF]) * MOD_CUTOFF_OCTAVES, sm);
    offL0 = offL1;
    offR0 = offR1;
    offL1 = fsS == 0 ? 0 : -fsS / 2;
    offR1 = fsS / 2 + dCutS;
    dLv0[0] = dLv1[0];
    dLv0[1] = dLv1[1];
    dLv1[0] = approach(dLv1[0], dR == dst ? 0 : clamp01(s.aLevel + dR[DST_LEVEL_A]) - clamp01(s.aLevel + dst[DST_LEVEL_A]), sm);
    dLv1[1] = approach(dLv1[1], dR == dst ? 0 : clamp01(s.bLevel + dR[DST_LEVEL_B]) - clamp01(s.bLevel + dst[DST_LEVEL_B]), sm);
    opA0 = opA1;
    opB0 = opB1;
    opA1 = approach(opA1, clamp11(s.aPan + dst[DST_PAN_A]), sm);
    opB1 = approach(opB1, clamp11(s.bPan + dst[DST_PAN_B]), sm);
    psA0 = psA1;
    psB0 = psB1;
    psA1 = approach(psA1, s.aPhaseSpread, uniGlide);
    psB1 = approach(psB1, s.bPhaseSpread, uniGlide);
    const double th = (s.noiseWidth * PI) / 4;
    nwC = s.noiseWidth > 0 ? std::cos(th) : 1;
    nwS = s.noiseWidth > 0 ? std::sin(th) : 0;
    const double pan = std::max(-1.0, std::min(1.0, s.pan + dst[DST_PAN]));
    const double gl = pan > 0 ? 1 - pan : 1;
    const double gr = pan < 0 ? 1 + pan : 1;
    panL0 = panL1;
    panR0 = panR1;
    panL1 += (gl - panL1) * smooth;
    panR1 += (gr - panR1) * smooth;
    gainTarget = c.gainTarget * std::max(0.0, 1 + dst[DST_AMP]);
    gainTargetR = c.gainTarget * std::max(0.0, 1 + dR[DST_AMP]);
    const bool wide = spread || rA || rB || opA0 != 0 || opA1 != 0 || opB0 != 0 || opB1 != 0 || psA0 != 0 || psA1 != 0 || psB0 != 0 ||
                      psB1 != 0 || offL0 != 0 || offL1 != 0 || offR0 != 0 || offR1 != 0 || dLv0[0] != 0 || dLv1[0] != 0 || dLv0[1] != 0 ||
                      dLv1[1] != 0 || gainTargetR != gainTarget || gainR != gain || (nwS != 0 && (lv0[3] > 0 || lv1[3] > 0));
    if (wide && !stereo) {
        filterR.copyFrom(filter);
        stereo = true;
    } else if (!wide && stereo && filter.closeTo(filterR))
        stereo = false;
    filter.flush();
    filterR.flush();
    if (std::abs(pink0) < 1e-20) pink0 = 0;
    if (std::abs(pink1) < 1e-20) pink1 = 0;
    if (std::abs(pink2) < 1e-20) pink2 = 0;
    if (std::abs(pinkR0) < 1e-20) pinkR0 = 0;
    if (std::abs(pinkR1) < 1e-20) pinkR1 = 0;
    if (std::abs(pinkR2) < 1e-20) pinkR2 = 0;
}

void SynthVoice::unison(const SynthParams& s, double scale) {
    const auto want = [&](int n) { return scale >= 1 ? n : std::max(1, (int) std::floor(n * scale)); };
    const int nA = want(s.aUnison);
    const int nB = want(s.bUnison);
    uA = copies(nA, wA0, wA1, phA, phCA, plA, pnA);
    uB = copies(nB, wB0, wB1, phB, phCB, plB, pnB);
    if (uA == 1) phCA = phA[0];
    if (uB == 1) phCB = phB[0];
    const double dA = dst[DST_DETUNE_A], dB = dst[DST_DETUNE_B];
    const double centsA = dA != 0 ? std::max(0.0, s.aDetune + dA * MOD_DETUNE_CENTS) : s.aDetune;
    const double centsB = dB != 0 ? std::max(0.0, s.bDetune + dB * MOD_DETUNE_CENTS) : s.bDetune;
    maxRatA = place(uA, nA, centsA, s.aSpread, plA, pnA, ratA, gAL, gAR);
    maxRatB = place(uB, nB, centsB, s.bSpread, plB, pnB, ratB, gBL, gBR);
    spread = (uA > 1 && s.aSpread > 0) || (uB > 1 && s.bSpread > 0);
}

int SynthVoice::copies(int n, double* w0, double* w1, double* ph, double centre, double* pl, double* pn) {
    const double tgt = 1 / std::sqrt((double) n);
    const double* places = UNISON_PLACES[n];
    const double* pans = UNISON_PANS[n];
    int count = 1;
    for (int i = 0; i < MAX_UNISON; ++i) {
        const double was = w1[i];
        w0[i] = was;
        const double t = i < n ? tgt : 0;
        if (was == 0 && t > 0) {
            ph[i] = std::fmod(centre + (n > 1 ? i * UNISON_PHASE : 0), 1.0);
            pl[i] = places[i];
            pn[i] = pans[i];
        }
        w1[i] = was + std::max(-uniStep, std::min(uniStep, t - was));
        if (w0[i] > 0 || w1[i] > 0) count = i + 1;
    }
    return count;
}

double SynthVoice::place(int count, int n, double cents, double spr, double* pl, double* pn, double* rat, double* gl, double* gr) {
    const double* places = UNISON_PLACES[n];
    const double* pans = UNISON_PANS[n];
    double max = 1;
    for (int i = 0; i < count; ++i) {
        if (i < n) {
            pl[i] += (places[i] - pl[i]) * uniGlide;
            pn[i] += (pans[i] - pn[i]) * uniGlide;
        }
        rat[i] = std::pow(2.0, (pl[i] * cents) / 1200);
        if (rat[i] > max) max = rat[i];
        const double pp = pn[i] * spr;
        gl[i] = pp > 0 ? 1 - pp : 1;
        gr[i] = pp < 0 ? 1 + pp : 1;
    }
    return max;
}

double SynthVoice::render(const VoiceParams& p, double e, double blockT, const TableMap& tables) {
    const SynthParams& s = p.synth;
    gain += (gainTarget - gain) * 0.002;
    if (stereo)
        gainR += (gainTargetR - gainR) * 0.002;
    else
        gainR = gain;
    const double fe = fenv.next();
    const double t = blockT;
    const double incA = incA0 + (incA1 - incA0) * t;
    const double incB = incB0 + (incB1 - incB0) * t;
    const double incS = incS0 + (incS1 - incS0) * t;
    double yL = 0, yR = 0;
    if (e > 0) {
        const double la = lv0[0] + (lv1[0] - lv0[0]) * t;
        const double lb = lv0[1] + (lv1[1] - lv0[1]) * t;
        const double ls = lv0[2] + (lv1[2] - lv0[2]) * t;
        const double ln = lv0[3] + (lv1[3] - lv0[3]) * t;
        const double lr = lv0[4] + (lv1[4] - lv0[4]) * t;
        const double psB = stereo ? psB0 + (psB1 - psB0) * t : 0;
        const double psA = stereo ? psA0 + (psA1 - psA0) * t : 0;
        const bool splitB = stereo && (psB != 0 || rB);
        const bool splitA = stereo && (psA != 0 || rA);
        const WtOsc& oscBR = rB ? bR : b;
        const WtOsc& oscAR = rA ? aR : a;
        const WarpMode wmA = s.aWarp, wmB = s.bWarp;
        const double wa = wmA == WarpMode::none ? 0 : waA0 + (waA1 - waA0) * t;
        const double wb = wmB == WarpMode::none ? 0 : waB0 + (waB1 - waB0) * t;
        double sbL = 0, sbR = 0, b0 = 0;
        const double fm = dFm0 == 0 && dFm1 == 0 ? s.fm : clamp01(s.fm + dFm0 + (dFm1 - dFm0) * t);
        if (b.n > 0 && (lb > 0 || lr > 0 || fm > 0)) {
            if (fm > 0) b0 = readWarp(b, uB == 1 ? phB[0] : phCB, t, wmB, wb);
            for (int i = 0; i < uB; ++i) {
                const double w = wB0[i] + (wB1[i] - wB0[i]) * t;
                const double v = readWarp(b, phB[i], t, wmB, wb) * w;
                sbL += v * gBL[i];
                if (splitB) {
                    double ph = phB[i] + psB;
                    if (ph >= 1) ph -= 1;
                    sbR += readWarp(oscBR, ph, t, wmB, wb) * w * gBR[i];
                } else
                    sbR += v * gBR[i];
            }
        }
        double saL = 0, saR = 0;
        if (a.n > 0) {
            const double fmOff = fm > 0 ? fm * FM_DEPTH * b0 : 0;
            for (int i = 0; i < uA; ++i) {
                double ph = phA[i] + fmOff;
                ph -= std::floor(ph);
                const double w = wA0[i] + (wA1[i] - wA0[i]) * t;
                const double v = readWarp(a, ph, t, wmA, wa) * w;
                saL += v * gAL[i];
                if (splitA) {
                    double phR = ph + psA;
                    if (phR >= 1) phR -= 1;
                    saR += readWarp(oscAR, phR, t, wmA, wa) * w * gAR[i];
                } else
                    saR += v * gAR[i];
            }
        }
        double x, xr;
        if (stereo) {
            const double pa = opA0 + (opA1 - opA0) * t;
            const double pb = opB0 + (opB1 - opB0) * t;
            const double laR = la + (dLv0[0] + (dLv1[0] - dLv0[0]) * t);
            const double lbR = lb + (dLv0[1] + (dLv1[1] - dLv0[1]) * t);
            x = la * saL * (pa > 0 ? 1 - pa : 1) + lb * sbL * (pb > 0 ? 1 - pb : 1) + lr * saL * sbL;
            xr = laR * saR * (pa < 0 ? 1 + pa : 1) + lbR * sbR * (pb < 0 ? 1 + pb : 1) + lr * saR * sbR;
        } else {
            x = la * saL + lb * sbL + lr * saL * sbL;
            xr = x;
        }
        if (ls > 0) {
            if (s.subWave == SubWave::square) {
                double q = subPhase < 0.5 ? 1 : -1;
                q += polyBlep(subPhase, incS);
                const double h = subPhase + 0.5;
                q -= polyBlep(h >= 1 ? h - 1 : h, incS);
                x += ls * q * 0.7;
                xr += ls * q * 0.7;
            } else {
                const double q = ls * std::sin(TWO_PI * subPhase);
                x += q;
                xr += q;
            }
        }
        if (ln > 0) {
            const double w = noise.bipolar();
            double q;
            if (s.noiseType == NoiseType::pink) {
                pink0 = 0.99765 * pink0 + w * 0.099046;
                pink1 = 0.963 * pink1 + w * 0.2965164;
                pink2 = 0.57 * pink2 + w * 1.0526913;
                q = ln * (pink0 + pink1 + pink2 + w * 0.1848) * PINK_GAIN;
            } else
                q = ln * w;
            if (stereo && nwS != 0) {
                const double w2 = noiseR.bipolar();
                double q2;
                if (s.noiseType == NoiseType::pink) {
                    pinkR0 = 0.99765 * pinkR0 + w2 * 0.099046;
                    pinkR1 = 0.963 * pinkR1 + w2 * 0.2965164;
                    pinkR2 = 0.57 * pinkR2 + w2 * 1.0526913;
                    q2 = ln * (pinkR0 + pinkR1 + pinkR2 + w2 * 0.1848) * PINK_GAIN;
                } else
                    q2 = ln * w2;
                x += nwC * q + nwS * q2;
                xr += nwC * q - nwS * q2;
            } else {
                x += q;
                xr += q;
            }
        }
        const double cut = cut0 + (cut1 - cut0) * t + fe * s.envAmount * FILTER_ENV_OCTAVES;
        double cutL = cut, cutR = cut;
        if (stereo) {
            const double oL = offL0 + (offL1 - offL0) * t;
            const double oR = offR0 + (offR1 - offR0) * t;
            if (oL != 0) cutL += oL;
            if (oR != 0) cutR += oR;
        }
        const double g = cutoffG(std::pow(2.0, cutL), sampleRate);
        const double k = k0 + (k1 - k0) * t;
        const int mode = (int) s.filterMode;
        const double amp = e * gain;
        const double sat = dSat0 == 0 && dSat1 == 0 ? s.sat : clamp01(s.sat + dSat0 + (dSat1 - dSat0) * t);
        yL = driveSample(filter.process(driveSample(x, driveM), mode, g, k), sat) * amp;
        if (stereo) {
            const double gR = cutR == cutL ? g : cutoffG(std::pow(2.0, cutR), sampleRate);
            yR = driveSample(filterR.process(driveSample(xr, driveM), mode, gR, k), sat) * (e * gainR);
            const double width = dW0 == 0 && dW1 == 0 ? s.width : std::max(0.0, std::min(2.0, s.width + 2 * (dW0 + (dW1 - dW0) * t)));
            if (width != 1) {
                const double m = (yL + yR) * 0.5;
                const double d = (yL - yR) * 0.5 * width;
                yL = m + d;
                yR = m - d;
            }
            yR = softLimit(yR);
        }
        yL = softLimit(yL);
        if (!stereo) yR = yL;
    }
    bool synced = false;
    phCB += incB;
    if (phCB >= 1) {
        phCB -= std::floor(phCB);
        b.wrapped(tables);
        if (rB) bR.wrapped(tables);
        if (s.sync) {
            const double frac = incB > 0 ? phCB / incB : 0;
            phCA = std::fmod(frac * incA, 1.0);
            for (int j = 0; j < uA; ++j) phA[j] = std::fmod(frac * incA * ratA[j], 1.0);
            a.wrapped(tables);
            if (rA) aR.wrapped(tables);
            synced = true;
        }
    }
    for (int i = 0; i < uB; ++i) {
        const double ph = phB[i] + incB * ratB[i];
        phB[i] = ph >= 1 ? ph - std::floor(ph) : ph;
    }
    if (!synced) {
        phCA += incA;
        if (phCA >= 1) {
            phCA -= std::floor(phCA);
            a.wrapped(tables);
            if (rA) aR.wrapped(tables);
        }
        for (int i = 0; i < uA; ++i) {
            const double ph = phA[i] + incA * ratA[i];
            phA[i] = ph >= 1 ? ph - std::floor(ph) : ph;
        }
    }
    subPhase += incS;
    if (subPhase >= 1) subPhase -= std::floor(subPhase);
    outL = yL;
    outR = yR;
    return (yL + yR) * 0.5;
}

} // namespace mkwavez
