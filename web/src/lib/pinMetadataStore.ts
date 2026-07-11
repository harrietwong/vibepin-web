/**
 * pinMetadataStore.ts — persists per-pin metadata drafts in localStorage.
 */

import type { MetadataTouchedFlags, PinMetadataDraft } from "./pinMetadata";
import { EMPTY_TOUCHED } from "./pinMetadata";
import type { StoreSyncAdapter } from "./userStoreSync";

const STORE_KEY = "vp:pin_metadata:v1";
/** Local hot-cache cap. `let` so tests can shrink it; product default is 2000. */
let MAX_PINS = 2000;
export const METADATA_STORE_EVENT = "vp:pin_metadata_updated";

/**
 * Capacity-eviction shadow (account sync, WP-B).
 *
 * localStorage is a bounded hot cache (newest MAX_PINS). But the account-sync
 * server is the FULL set — capacity eviction must NOT look like a user delete, or
 * every trim would fire a tombstone storm that wipes older metadata server-side.
 * So docs pushed out of the hot cache by capacity are moved here (in-memory, this
 * session) and still reported by the sync adapter's getAll(). They therefore never
 * "disappear" from the engine's view, so no tombstone is emitted for them. A real
 * user delete removes the id from BOTH the cache and this shadow → the engine sees
 * it vanish → tombstone (correct). Reload starts the shadow empty, which is safe:
 * the startup pull re-seeds the baseline from post-merge local state, so surviving
 * ids never look deleted.
 */
const _evicted = new Map<string, StoredPinMetadata>();

export type StoredPinMetadata = {
  pinId: string;
  sessionId: string;
  imageUrl: string;
  metadataDraft: PinMetadataDraft;
  title: string;
  description: string;
  altText: string;
  destinationUrl: string;
  plannedDate: string;
  plannedTime?: string;
  plannedAt?: string;
  planningStatus: string;
  touched: MetadataTouchedFlags;
  updatedAt: string;
};

type StoreData = { pins: Record<string, StoredPinMetadata> };

function ok(): boolean { return typeof window !== "undefined"; }

function load(): StoreData {
  if (!ok()) return { pins: {} };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { pins: {} };
    const p = JSON.parse(raw) as Partial<StoreData>;
    return { pins: p.pins ?? {} };
  } catch { return { pins: {} }; }
}

function persist(data: StoreData): void {
  if (!ok()) return;
  const sorted = Object.values(data.pins).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const kept = sorted.slice(0, MAX_PINS);
  const keptIds = new Set(kept.map(p => p.pinId));
  // Capacity-evicted docs → shadow (keeps them in the sync set, no tombstone).
  for (const p of sorted.slice(MAX_PINS)) _evicted.set(p.pinId, p);
  // Anything now in the hot cache is no longer evicted.
  for (const id of keptIds) _evicted.delete(id);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ pins: Object.fromEntries(kept.map(p => [p.pinId, p])) }));
  } catch { /* quota */ }
}

function emit(): void {
  if (ok()) window.dispatchEvent(new Event(METADATA_STORE_EVENT));
}

export function getPinMetadata(pinId: string): StoredPinMetadata | null {
  return load().pins[pinId] ?? null;
}

export function getSessionPinMetadata(sessionId: string): StoredPinMetadata[] {
  return Object.values(load().pins).filter(p => p.sessionId === sessionId);
}

export function savePinMetadata(record: Omit<StoredPinMetadata, "updatedAt"> & { updatedAt?: string }): StoredPinMetadata {
  const data = load();
  const now = new Date().toISOString();
  const stored: StoredPinMetadata = {
    ...record,
    touched: { ...EMPTY_TOUCHED, ...record.touched },
    updatedAt: record.updatedAt ?? now,
  };
  data.pins[stored.pinId] = stored;
  persist(data);
  emit();
  return stored;
}

export function deletePinMetadata(pinId: string): void {
  const data = load();
  delete data.pins[pinId];
  _evicted.delete(pinId); // real user delete → drop from shadow so the engine tombstones it
  persist(data);
  emit();
}

// ── Account-level sync (WP-B) ────────────────────────────────────────────────

function metadataTsMs(v: string | null | undefined): number {
  const ms = v ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Collection under storeKey `pin_metadata` (doc_id = pinId). Per-doc updatedAt
 * already exists. getAll reports the hot cache PLUS the capacity-eviction shadow so
 * trims never look like deletes. mergeServer LWW-merges server docs/tombstones with
 * a single persist + emit.
 */
export const pinMetadataSyncAdapter: StoreSyncAdapter<StoredPinMetadata> = {
  storeKey: "pin_metadata",
  eventName: METADATA_STORE_EVENT,
  getAll() {
    const present = load().pins;
    const out: Array<{ id: string; updatedAt: string; doc: StoredPinMetadata }> = [];
    const seen = new Set<string>();
    for (const p of Object.values(present)) {
      out.push({ id: p.pinId, updatedAt: p.updatedAt, doc: p });
      seen.add(p.pinId);
    }
    for (const p of _evicted.values()) {
      if (!seen.has(p.pinId)) out.push({ id: p.pinId, updatedAt: p.updatedAt, doc: p });
    }
    return out;
  },
  mergeServer(live, deleted) {
    if (!ok()) return;
    const data = load();
    let changed = false;
    for (const inc of live) {
      if (!inc || typeof inc.pinId !== "string" || !inc.pinId) continue;
      const local = data.pins[inc.pinId] ?? _evicted.get(inc.pinId) ?? null;
      if (local && metadataTsMs(inc.updatedAt) <= metadataTsMs(local.updatedAt)) continue;
      data.pins[inc.pinId] = inc;   // re-materialize into the hot cache
      _evicted.delete(inc.pinId);
      changed = true;
    }
    for (const t of deleted) {
      if (!t || typeof t.id !== "string") continue;
      const local = data.pins[t.id] ?? _evicted.get(t.id) ?? null;
      if (!local) continue;
      if (metadataTsMs(local.updatedAt) >= metadataTsMs(t.deletedAt)) continue;
      delete data.pins[t.id];
      _evicted.delete(t.id);
      changed = true;
    }
    if (changed) { persist(data); emit(); } // persist may re-shadow overflow
  },
};

// ── Test-only hooks (not used by product code) ───────────────────────────────
export function __setMaxPinsForTests(n: number): void { MAX_PINS = n; }
export function __resetPinMetadataStoreForTests(): void {
  _evicted.clear();
  MAX_PINS = 2000;
}
