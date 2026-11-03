/**
 * IndexedDB storage for the autosaved session (browser only). Object stores: `meta` (key
 * 'session' = the current SessionMeta), `waveforms` (WaveformRecord by id, Float32 samples
 * stored as typed arrays) and `kept` (key 'last': a session that couldn't be restored —
 * corrupt, or saved by a newer version — set aside intact, meta and records, so it can be
 * exported or discarded). Every call may reject (private mode, quota, blocked): callers
 * catch and carry on.
 */
import type { SessionBackend } from '../app/autosave';
import type { SessionMeta, WaveformRecord } from '../core/session';
import type { TableId } from '../core/table';

const DB_NAME = 'mkwavez';
const DB_VERSION = 2;
const META = 'meta';
const WAVEFORMS = 'waveforms';
const KEPT = 'kept';
const SESSION_KEY = 'session';
const KEPT_KEY = 'last';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export interface StoredSession {
  /** Raw meta (decode validates it); undefined when nothing was saved yet. */
  meta: unknown;
  records: Map<TableId, WaveformRecord>;
}

/** A session set aside because it couldn't be restored. */
export interface KeptSession {
  savedAt: number;
  error: string;
  meta: unknown;
  records: WaveformRecord[];
}

export class SessionStore implements SessionBackend {
  private constructor(private db: IDBDatabase) {
    // Another tab upgrading the schema: step aside rather than block it.
    db.onversionchange = () => db.close();
  }

  /** Open (or create) the database. Rejects when IndexedDB is unavailable or blocked. */
  static async open(timeoutMs = 4000): Promise<SessionStore> {
    const idb = globalThis.indexedDB;
    if (!idb) throw new Error('IndexedDB is not available');
    const r = idb.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      if (!db.objectStoreNames.contains(WAVEFORMS)) db.createObjectStore(WAVEFORMS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(KEPT)) db.createObjectStore(KEPT);
    };
    const db = await withTimeout(req(r), timeoutMs, 'Opening saved-session storage');
    return new SessionStore(db);
  }

  async load(): Promise<StoredSession> {
    const tx = this.db.transaction([META, WAVEFORMS], 'readonly');
    const [meta, recs] = await Promise.all([
      req(tx.objectStore(META).get(SESSION_KEY)),
      req(tx.objectStore(WAVEFORMS).getAll() as IDBRequest<WaveformRecord[]>),
    ]);
    const records = new Map<TableId, WaveformRecord>();
    for (const r of recs) if (r && Number.isInteger(r.id)) records.set(r.id, r);
    return { meta, records };
  }

  async putWaveforms(records: readonly WaveformRecord[]): Promise<void> {
    const tx = this.db.transaction(WAVEFORMS, 'readwrite');
    const st = tx.objectStore(WAVEFORMS);
    for (const r of records) st.put(r);
    await done(tx);
  }

  async commit(meta: SessionMeta, remove: readonly TableId[], records: readonly WaveformRecord[] = []): Promise<void> {
    // Created synchronously (before any await): queued even if the page is unloading.
    const tx = this.db.transaction([META, WAVEFORMS], 'readwrite');
    const wf = tx.objectStore(WAVEFORMS);
    for (const r of records) wf.put(r);
    tx.objectStore(META).put(meta, SESSION_KEY);
    for (const id of remove) wf.delete(id);
    await done(tx);
  }

  async remove(ids: readonly TableId[]): Promise<void> {
    const tx = this.db.transaction(WAVEFORMS, 'readwrite');
    const wf = tx.objectStore(WAVEFORMS);
    for (const id of ids) wf.delete(id);
    await done(tx);
  }

  /** Ids of every stored waveform record. */
  async keys(): Promise<TableId[]> {
    const tx = this.db.transaction(WAVEFORMS, 'readonly');
    return (await req(tx.objectStore(WAVEFORMS).getAllKeys())) as TableId[];
  }

  async clear(): Promise<void> {
    const tx = this.db.transaction([META, WAVEFORMS], 'readwrite');
    tx.objectStore(META).delete(SESSION_KEY);
    tx.objectStore(WAVEFORMS).clear();
    await done(tx);
  }

  /**
   * Set an unrestorable session aside, intact (meta + records), and empty the live
   * session, in one transaction. Replaces a previously kept one.
   */
  async keep(meta: unknown, records: readonly WaveformRecord[], error: string): Promise<void> {
    const tx = this.db.transaction([META, WAVEFORMS, KEPT], 'readwrite');
    tx.objectStore(KEPT).put({ savedAt: Date.now(), error, meta, records: [...records] } satisfies KeptSession, KEPT_KEY);
    tx.objectStore(META).delete(SESSION_KEY);
    tx.objectStore(WAVEFORMS).clear();
    await done(tx);
  }

  async loadKept(): Promise<KeptSession | undefined> {
    const tx = this.db.transaction(KEPT, 'readonly');
    return (await req(tx.objectStore(KEPT).get(KEPT_KEY))) as KeptSession | undefined;
  }

  async clearKept(): Promise<void> {
    const tx = this.db.transaction(KEPT, 'readwrite');
    tx.objectStore(KEPT).delete(KEPT_KEY);
    await done(tx);
  }
}
