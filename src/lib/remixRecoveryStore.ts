/**
 * remixRecoveryStore.ts
 *
 * IndexedDB-backed durable store for Remix recovery.
 *
 * Why this exists:
 *   Uploaded product / reference images are base64 *data URLs*. They are far too
 *   large for localStorage (~5 MB), sessionStorage (~5 MB, cleared on browser
 *   restart) or the Supabase JSONB column (silently rejected). Those stores all
 *   strip data URLs, so on refresh the original visual inputs were lost and Remix
 *   fell back to a prompt-only "partial recovery" state.
 *
 *   IndexedDB has a much larger quota (typically a large fraction of free disk),
 *   survives page refresh AND browser restart, and needs no backend. We persist
 *   the FULL SetupSnapshot here — including data-URL images — so Remix can restore
 *   the actual inputs that created a Pin.
 *
 * Durability tiers for a generation's setup:
 *   1. snapshotRegistry (in-memory)  — current tab only, instant, lost on refresh
 *   2. THIS store (IndexedDB)        — durable across refresh + restart, full images
 *   3. sessionStorage                — tab-local fallback (may be compacted)
 *   4. Supabase DB (compact)         — cross-device, text + stable https URLs only
 *   5. localStorage history (compact)
 *
 * All operations fail soft: if IndexedDB is unavailable (private mode, disabled),
 * every call resolves to a no-op / null and the caller falls through to other tiers.
 */

import type { SetupSnapshot } from "./studioPersistence";

const DB_NAME    = "vibepin_remix";
const STORE      = "setups";
const DB_VERSION = 1;
const MAX_ENTRIES = 150;          // prune oldest beyond this on hydrate

type StoredSetup = {
  sessionId: string;
  snapshot:  SetupSnapshot;
  savedAt:   string;
};

let _dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof window === "undefined" || !("indexedDB" in window)) {
    return Promise.resolve(null);
  }
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise(resolve => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "sessionId" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return _dbPromise;
}

/** Persist the full setup snapshot (incl. data-URL images) for a generation. */
export async function saveSetupSnapshot(sessionId: string, snapshot: SetupSnapshot): Promise<void> {
  if (!sessionId || !snapshot) return;
  const db = await openDb();
  if (!db) return;
  await new Promise<void>(resolve => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ sessionId, snapshot, savedAt: new Date().toISOString() } satisfies StoredSetup);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => resolve();
      tx.onabort    = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Read one setup snapshot by sessionId. Returns null when absent or unavailable. */
export async function loadSetupSnapshot(sessionId: string): Promise<SetupSnapshot | null> {
  if (!sessionId) return null;
  const db = await openDb();
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const tx  = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(sessionId);
      req.onsuccess = () => resolve((req.result as StoredSetup | undefined)?.snapshot ?? null);
      req.onerror   = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Load every stored snapshot as a Map keyed by sessionId (for mount-time hydration). */
export async function loadAllSetupSnapshots(): Promise<Map<string, SetupSnapshot>> {
  const map = new Map<string, SetupSnapshot>();
  const db = await openDb();
  if (!db) return map;
  return new Promise(resolve => {
    try {
      const tx  = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const rows = (req.result as StoredSetup[] | undefined) ?? [];
        for (const row of rows) {
          if (row?.sessionId && row.snapshot) map.set(row.sessionId, row.snapshot);
        }
        resolve(map);
      };
      req.onerror = () => resolve(map);
    } catch {
      resolve(map);
    }
  });
}

/**
 * Keep IndexedDB bounded: retain the newest MAX_ENTRIES snapshots plus anything in
 * `keepSessionIds` (currently-loaded sessions), delete the rest. Fails soft.
 */
export async function pruneSetupSnapshots(keepSessionIds: Set<string>): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>(resolve => {
    try {
      const tx  = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = (req.result as StoredSetup[] | undefined) ?? [];
        if (rows.length <= MAX_ENTRIES) { resolve(); return; }
        const sorted = [...rows].sort(
          (a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime(),
        );
        sorted.slice(MAX_ENTRIES).forEach(row => {
          if (!keepSessionIds.has(row.sessionId)) {
            try { store.delete(row.sessionId); } catch { /* noop */ }
          }
        });
      };
      tx.oncomplete = () => resolve();
      tx.onerror    = () => resolve();
      tx.onabort    = () => resolve();
    } catch {
      resolve();
    }
  });
}
