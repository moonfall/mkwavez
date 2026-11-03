/**
 * IndexedDB storage for the autosaved session (browser only). Two object stores:
 * `meta` (key 'session' = the current SessionMeta, 'corrupt' = the last save that couldn't
 * be restored, kept for debugging) and `waveforms` (WaveformRecord by id, Float32 samples
 * stored as typed arrays). Every call may reject (private mode, quota, blocked): callers
 * catch and carry on without saving.
 */
import type { SessionBackend } from '../app/autosave';
import type { SessionMeta, WaveformRecord } from '../core/session';
import type { TableId } from '../core/table';

const DB_NAME = 'mkwavez';
const DB_VERSION = 1;
const META = 'meta';
const WAVEFORMS = 'waveforms';
const SESSION_KEY = 'session';
const CORRUPT_KEY = 'corrupt';

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

  async commit(meta: SessionMeta, remove: readonly TableId[]): Promise<void> {
    const tx = this.db.transaction([META, WAVEFORMS], 'readwrite');
    tx.objectStore(META).put(meta, SESSION_KEY);
    const wf = tx.objectStore(WAVEFORMS);
    for (const id of remove) wf.delete(id);
    await done(tx);
  }

  async clear(): Promise<void> {
    const tx = this.db.transaction([META, WAVEFORMS], 'readwrite');
    const corrupt = tx.objectStore(META).get(CORRUPT_KEY);
    tx.objectStore(WAVEFORMS).clear();
    corrupt.onsuccess = () => {
      // Keep only the debugging copy of an unreadable save.
      const keep = corrupt.result;
      tx.objectStore(META).clear();
      if (keep !== undefined) tx.objectStore(META).put(keep, CORRUPT_KEY);
    };
    await done(tx);
  }

  /** Keep an unreadable save (meta + the error) for debugging; the next autosave replaces 'session'. */
  async keepCorrupt(meta: unknown, error: string): Promise<void> {
    const tx = this.db.transaction(META, 'readwrite');
    tx.objectStore(META).put({ savedAt: Date.now(), error, meta }, CORRUPT_KEY);
    await done(tx);
  }

  /** Drop the debugging copy. */
  async clearCorrupt(): Promise<void> {
    const tx = this.db.transaction(META, 'readwrite');
    tx.objectStore(META).delete(CORRUPT_KEY);
    await done(tx);
  }
}
