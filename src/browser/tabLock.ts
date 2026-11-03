/**
 * One tab at a time owns autosave (Web Locks API). `acquire()` takes the lock if free;
 * `takeOver()` steals it from another tab, whose `onLost` fires. Without the Web Locks
 * API every tab owns autosave (as before; last writer wins).
 */
const LOCK_NAME = 'mkwavez-autosave';

interface LockOpts {
  ifAvailable?: boolean;
  steal?: boolean;
  signal?: AbortSignal;
}

interface Locks {
  request(name: string, opts: LockOpts, cb: (lock: unknown) => Promise<void>): Promise<void>;
}

export class TabLock {
  /** Called when another tab took the lock over. */
  onLost?: () => void;

  private get locks(): Locks | null {
    return (globalThis.navigator as { locks?: Locks } | undefined)?.locks ?? null;
  }

  get supported(): boolean {
    return !!this.locks;
  }

  /**
   * Take the lock if no other tab holds it. Resolves true when this tab owns autosave. A
   * reload's previous document may still hold it for a moment, so a busy lock is waited
   * for briefly (`waitMs`) before giving up.
   */
  async acquire(waitMs = 1500): Promise<boolean> {
    if (await this.request({ ifAvailable: true })) return true;
    if (typeof AbortSignal === 'undefined' || !('timeout' in AbortSignal)) return false;
    return this.request({ signal: AbortSignal.timeout(waitMs) });
  }

  /** Take the lock from the tab holding it. */
  takeOver(): Promise<boolean> {
    return this.request({ steal: true });
  }

  private request(opts: LockOpts): Promise<boolean> {
    const locks = this.locks;
    if (!locks) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let granted = false;
      locks
        .request(LOCK_NAME, opts, (lock) => {
          if (!lock) {
            resolve(false);
            return Promise.resolve();
          }
          granted = true;
          resolve(true);
          // Held until the tab closes (or another tab steals it).
          return new Promise<void>(() => {});
        })
        .catch(() => {
          // Stolen (AbortError), or the request itself failed.
          if (!granted) {
            resolve(false);
            return;
          }
          this.onLost?.();
        });
    });
  }
}
