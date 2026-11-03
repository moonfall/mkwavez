/**
 * Checkpoints for step-based simulations (reaction-diffusion, Life): a batch asks for
 * snapshots at increasing step counts, each normally simulated from step 0. Stepping is
 * deterministic, so continuing from the nearest earlier checkpoint gives bit-identical
 * results; this only saves time (a pure memo, safe to drop at any point).
 */
export class StepCache<S> {
  private key = '';
  private readonly states = new Map<number, S>();

  constructor(private readonly limit = 256) {}

  /**
   * The state after `step` steps for simulation `key`: from the nearest checkpoint ≤ step
   * (or init()), advanced in place by advance(state, n). `clone` copies a state.
   */
  at(key: string, step: number, init: () => S, advance: (s: S, n: number) => void, clone: (s: S) => S): S {
    if (key !== this.key) {
      this.key = key;
      this.states.clear();
    }
    let best = -1;
    for (const k of this.states.keys()) if (k <= step && k > best) best = k;
    const s = best >= 0 ? clone(this.states.get(best)!) : init();
    advance(s, step - Math.max(0, best));
    if (this.states.size >= this.limit) this.states.clear();
    this.states.set(step, clone(s));
    return s;
  }
}
