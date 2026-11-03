export const AdsrStage = { Idle: 0, Attack: 1, Decay: 2, Sustain: 3, Release: 4 } as const;
export type AdsrStage = (typeof AdsrStage)[keyof typeof AdsrStage];

/**
 * ADSR amplitude envelope: linear attack, exponential decay/release (time constant
 * = stage time / 4, so a stage is ~98% complete after its nominal time).
 * Retriggering starts the attack from the current level (no click).
 */
export class Adsr {
  stage: AdsrStage = AdsrStage.Idle;
  value = 0;
  private attackInc = 1;
  private decayCoef = 0;
  private releaseCoef = 0;
  private sustain = 1;

  configure(attack: number, decay: number, sustain: number, release: number, sampleRate: number): void {
    this.attackInc = 1 / Math.max(1, attack * sampleRate);
    this.decayCoef = Math.exp(-4 / Math.max(1, decay * sampleRate));
    this.releaseCoef = Math.exp(-4 / Math.max(1, release * sampleRate));
    this.sustain = Math.max(0, Math.min(1, sustain));
  }

  gateOn(): void {
    this.stage = AdsrStage.Attack;
  }

  gateOff(): void {
    if (this.stage !== AdsrStage.Idle) this.stage = AdsrStage.Release;
  }

  next(): number {
    switch (this.stage) {
      case AdsrStage.Idle:
        return 0;
      case AdsrStage.Attack:
        this.value += this.attackInc;
        if (this.value >= 1) {
          this.value = 1;
          this.stage = AdsrStage.Decay;
        }
        break;
      case AdsrStage.Decay:
        this.value = this.sustain + (this.value - this.sustain) * this.decayCoef;
        if (Math.abs(this.value - this.sustain) < 1e-4) {
          this.value = this.sustain;
          this.stage = AdsrStage.Sustain;
        }
        break;
      case AdsrStage.Sustain:
        this.value = this.sustain;
        if (this.sustain <= 0) this.stage = AdsrStage.Idle;
        break;
      case AdsrStage.Release:
        this.value *= this.releaseCoef;
        if (this.value < 1e-5) {
          this.value = 0;
          this.stage = AdsrStage.Idle;
        }
        break;
    }
    return this.value;
  }
}
