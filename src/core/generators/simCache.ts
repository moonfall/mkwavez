/**
 * Checkpoints for step-based simulations (reaction-diffusion, Life): a batch asks for
 * snapshots at increasing step counts, each normally simulated from step 0. Stepping is
 * deterministic, so continuing from the nearest earlier checkpoint gives bit-identical
 * results; this only saves time (a pure memo, safe to drop at any point). Keeps the
 * checkpoints of the `simulations` most recently used keys (LRU), so alternating between
 * a few simulations (preview, thumbnails, another entry) doesn't rebuild them.
 */
export class StepCache<S> {
  /** key → (step → state); Map order = least recently used first. */
  private readonly sims = new Map<string, Map<number, S>>();

  constructor(
    private readonly simulations = 4,
    private readonly perSimulation = 128,
  ) {}

  /**
   * The state after `step` steps for simulation `key`: from the nearest checkpoint ≤ step
   * (or init()), advanced in place by advance(state, n). `clone` copies a state.
   */
  at(key: string, step: number, init: () => S, advance: (s: S, n: number) => void, clone: (s: S) => S): S {
    let states = this.sims.get(key);
    if (states) this.sims.delete(key);
    else states = new Map();
    this.sims.set(key, states);
    while (this.sims.size > this.simulations) this.sims.delete(this.sims.keys().next().value!);
    let best = -1;
    for (const k of states.keys()) if (k <= step && k > best) best = k;
    const s = best >= 0 ? clone(states.get(best)!) : init();
    advance(s, step - Math.max(0, best));
    if (states.size >= this.perSimulation) states.clear();
    states.set(step, clone(s));
    return s;
  }
}
