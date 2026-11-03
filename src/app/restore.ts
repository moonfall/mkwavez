/**
 * Startup restore decision (no DOM; the store and tab lock are injected so it is unit-tested):
 *  - no storage → a fresh session, autosave off, a notice;
 *  - another tab owns autosave → that tab's last save is restored here, autosave paused;
 *  - an unrestorable save (corrupt, or from a newer version) → set aside intact (meta and
 *    every waveform record) and a fresh session whose ids don't collide with it, with a
 *    notice offering to export or discard it; if it can't be set aside, autosave stays off
 *    in this tab so it isn't overwritten.
 */
import { decodeSession, SessionError, type SessionState, type WaveformRecord } from '../core/session';
import type { Autosaver, SessionBackend } from './autosave';
import { defaultSessionState } from './defaultSession';

export interface RestoreStore extends SessionBackend {
  load(): Promise<{ meta: unknown; records: Map<number, WaveformRecord> }>;
  /** Kept (unrestorable) sessions: small entries only. */
  keptList(): Promise<readonly { maxId: number }[]>;
  /** Set a session aside intact and empty the live one (one transaction); earlier ones stay. */
  keep(meta: unknown, records: readonly WaveformRecord[], error: string): Promise<void>;
  /** The meta currently saved. */
  loadMeta(): Promise<unknown>;
  /** Ids of the stored waveform records. */
  keys(): Promise<number[]>;
}

/** Identifies one saved meta (to tell whether another tab saved since). */
export function metaStamp(meta: unknown): unknown {
  return typeof meta === 'object' && meta !== null ? ((meta as { savedAt?: unknown }).savedAt ?? null) : null;
}

export type NoticeKind = 'off' | 'warning' | 'kept' | 'unrestorable';

export interface Boot<S extends RestoreStore = RestoreStore> {
  state: SessionState;
  /** null = autosave off. */
  store: S | null;
  /** This tab owns autosave. */
  owner: boolean;
  /** Records in the store (autosave keeps those the restored session reaches). */
  stored: WaveformRecord[];
  restored: boolean;
  /** New waveform ids start at or above this (ids of kept sessions). */
  reserve: number;
  keptCount: number;
  /** `metaStamp` of the save read at startup (undefined: none). */
  stamp: unknown;
  /** Not the owner and the save couldn't be restored: set it aside once this tab owns autosave. */
  unrestorable?: { meta: unknown; records: WaveformRecord[]; why: string };
  notices: { kind: NoticeKind; text: string }[];
}

const maxId = (recs: Iterable<{ id: number }>) => {
  let m = 0;
  for (const r of recs) m = Math.max(m, r.id);
  return m;
};

export async function restoreSession<S extends RestoreStore>(
  openStore: () => Promise<S>,
  acquireLock: () => Promise<boolean>,
): Promise<Boot<S>> {
  const fresh = (): SessionState => ({ model: defaultSessionState(), ui: {} });
  const off = (text: string): Boot<S> => ({
    state: fresh(),
    store: null,
    owner: true,
    stored: [],
    restored: false,
    reserve: 0,
    keptCount: 0,
    stamp: undefined,
    notices: [{ kind: 'off', text }],
  });
  let store: S;
  try {
    store = await openStore();
  } catch (e) {
    console.warn('[session] storage unavailable', e);
    return off('Autosave is off: this browser isn’t allowing storage (private window?). Use Session → Export to keep your work.');
  }
  const owner = await acquireLock().catch(() => true);
  let loaded;
  let kept;
  try {
    loaded = await store.load();
    kept = await store.keptList();
  } catch (e) {
    console.warn('[session] reading the saved session failed', e);
    return off('Couldn’t read the saved session; autosave is off for this tab. Use Session → Export to keep your work.');
  }
  const base = { store, owner, reserve: kept.reduce((a, k) => Math.max(a, k.maxId + 1), 0), keptCount: kept.length, stamp: metaStamp(loaded.meta) };
  const stored = [...loaded.records.values()];
  if (loaded.meta === undefined) return { ...base, state: fresh(), stored, restored: false, notices: [] };
  try {
    const { state, warnings } = decodeSession(loaded.meta, loaded.records);
    if (warnings.length) console.warn('[session] restored with warnings', warnings);
    return {
      ...base,
      state,
      stored,
      restored: true,
      notices: warnings.length ? [{ kind: 'warning', text: `Session restored, but ${warnings[0]}.` }] : [],
    };
  } catch (e) {
    console.warn('[session] the saved session could not be restored', e);
    const newer = e instanceof SessionError && e.kind === 'incompatible';
    const why = newer ? 'it was saved by a newer version of mkwavez' : e instanceof Error ? e.message : String(e);
    // Another tab owns the store: leave it alone.
    if (!owner) {
      return {
        ...base,
        state: fresh(),
        stored: [],
        restored: false,
        reserve: Math.max(base.reserve, maxId(stored) + 1),
        unrestorable: { meta: loaded.meta, records: stored, why },
        notices: [{ kind: 'unrestorable', text: `Couldn’t restore the last session (${why}).` }],
      };
    }
    try {
      await store.keep(loaded.meta, stored, why);
    } catch (err) {
      console.warn('[session] setting the unrestorable session aside failed', err);
      return off(`Couldn’t restore the last session (${why}). It is left untouched, so autosave is off in this tab; Session → Export keeps this one.`);
    }
    return {
      ...base,
      state: fresh(),
      stored: [],
      restored: false,
      reserve: Math.max(base.reserve, maxId(stored) + 1),
      keptCount: base.keptCount + 1,
      stamp: undefined,
      notices: [{ kind: 'kept', text: `Couldn’t restore the last session (${why}); started a new one. The old session is kept.` }],
    };
  }
}

/**
 * This tab now owns autosave: the lock came free shortly after startup (a reload), or the
 * user took it over from another tab. If the store still holds the save this tab restored
 * (and this isn't a takeover), autosave carries on incrementally; otherwise every waveform
 * is rewritten in one transaction (`adopt`). A save this tab couldn't restore (it wasn't
 * the owner then) is set aside first, unless it has been replaced meanwhile.
 */
export async function becomeOwner(saver: Autosaver, store: RestoreStore, boot: Boot, takeover: boolean): Promise<void> {
  if (boot.unrestorable) {
    const { meta, records } = await store.load();
    if (meta !== undefined) {
      try {
        decodeSession(meta, records);
      } catch {
        await store.keep(meta, [...records.values()], boot.unrestorable.why);
        boot.keptCount++;
      }
    }
    boot.unrestorable = undefined;
    takeover = true;
  }
  if (!takeover && metaStamp(await store.loadMeta()) === boot.stamp) {
    saver.setActive(true);
    saver.init(boot.stored);
  } else {
    saver.adopt(await store.keys());
    saver.setActive(true);
  }
}
