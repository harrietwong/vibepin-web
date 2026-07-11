/**
 * userStoreSyncHelpers.ts — small shared helpers for WP-B store adapters.
 *
 * These keep every store's sync wiring tiny and identical in behaviour. The
 * generic engine lives in userStoreSync.ts; each store exports a StoreSyncAdapter
 * (getAll + mergeServer). Singleton stores (one fixed doc_id) all share the exact
 * same LWW logic, so it lives here once as a factory.
 */

import type { StoreSyncAdapter } from "./userStoreSync";

/** Stable fallback for docs persisted before an `updatedAt` field existed. Making
 *  it the epoch means any real, timestamped edit (local or remote) always wins the
 *  LWW compare, while the pre-existing value still migrates on first load. */
export const EPOCH_UPDATED_AT = "1970-01-01T00:00:00.000Z";

/** Timestamp-safe compare: client ISO strings and PostgREST "+00:00" both parse. */
export function tsMs(value: string | null | undefined): number {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

/**
 * Build a StoreSyncAdapter for a "singleton" store — one that persists a single
 * JSON object under one localStorage key and syncs it as one fixed doc_id.
 *
 * Contract required of the store:
 *  - the persisted object carries an `updatedAt` ISO string (stamped on every save),
 *  - the store emits `eventName` after every persist.
 *
 * getAll returns [] when nothing has been persisted yet (so untouched defaults are
 * never uploaded); once a value exists it is reported under `docId`. mergeServer
 * does a single-key LWW across {local, incoming live, incoming tombstone} with one
 * persist + one emit, and — because the engine ignores the store event until its
 * startup baseline is seeded — never loops the merged value back into the outbox.
 */
export function makeSingletonAdapter<T extends Record<string, unknown>>(cfg: {
  storeKey: string;
  eventName: string;
  localStorageKey: string;
  docId: string;
  /** Emit the store's own change event (single call). */
  emit: () => void;
}): StoreSyncAdapter<T> {
  const { storeKey, eventName, localStorageKey, docId, emit } = cfg;

  function readRaw(): T | null {
    if (!hasWindow()) return null;
    try {
      const raw = localStorage.getItem(localStorageKey);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  function updatedAtOf(doc: T | null): string {
    const raw = doc ? (doc as Record<string, unknown>).updatedAt : undefined;
    return typeof raw === "string" ? raw : EPOCH_UPDATED_AT;
  }

  return {
    storeKey,
    eventName,
    getAll() {
      const doc = readRaw();
      if (!doc) return [];
      return [{ id: docId, updatedAt: updatedAtOf(doc), doc }];
    },
    mergeServer(live, deleted) {
      if (!hasWindow()) return;
      const local = readRaw();
      const localTs = local ? tsMs(updatedAtOf(local)) : -1;

      // Singleton: the server holds at most one row for docId, so `live`/`deleted`
      // carry at most one relevant entry. Payloads don't carry the doc_id, so for a
      // singleton the first live payload IS this doc.
      const incoming = (live[0] as T | undefined) ?? null;
      const incomingTs = incoming ? tsMs(updatedAtOf(incoming)) : -1;
      const tomb = deleted.find((d) => d.id === docId) ?? deleted[0] ?? null;
      const tombTs = tomb ? tsMs(tomb.deletedAt) : -1;

      // Winner = the strictly-newer of {keep local, write incoming, delete}.
      let action: "none" | "write" | "delete" = "none";
      let bestTs = localTs;
      if (incoming && incomingTs > bestTs) { action = "write"; bestTs = incomingTs; }
      if (tomb && tombTs > bestTs) { action = "delete"; bestTs = tombTs; }

      if (action === "write" && incoming) {
        try { localStorage.setItem(localStorageKey, JSON.stringify(incoming)); } catch { return; }
        emit();
      } else if (action === "delete" && local) {
        localStorage.removeItem(localStorageKey);
        emit();
      }
    },
  };
}
