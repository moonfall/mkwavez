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
import type { SessionBackend } from './autosave';
import { defaultSessionState } from './defaultSession';

export interface RestoreStore extends SessionBackend {
  load(): Promise<{ meta: unknown; records: Map<number, WaveformRecord> }>;
  loadKept(): Promise<{ records: readonly WaveformRecord[] } | undefined>;
  /** Set a session aside intact and empty the live one (one transaction). */
  keep(meta: unknown, records: readonly WaveformRecord[], error: string): Promise<void>;
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
  /** New waveform ids start at or above this (ids of a kept session). */
  reserve: number;
  hasKept: boolean;
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
    hasKept: false,
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
    kept = await store.loadKept();
  } catch (e) {
    console.warn('[session] reading the saved session failed', e);
    return off('Couldn’t read the saved session; autosave is off for this tab. Use Session → Export to keep your work.');
  }
  const base = { store, owner, reserve: kept ? maxId(kept.records) + 1 : 0, hasKept: !!kept };
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
    if (!owner) return { ...base, state: fresh(), stored: [], restored: false, notices: [{ kind: 'unrestorable', text: `Couldn’t restore the last session (${why}).` }] };
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
      hasKept: true,
      notices: [{ kind: 'kept', text: `Couldn’t restore the last session (${why}); started a new one. The old session is kept.` }],
    };
  }
}
