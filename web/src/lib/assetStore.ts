// Lightweight asset store — persisted in localStorage.
// Saves products (from Product Signals) and style references (from Viral Pins / Pin Opportunities)
// so users can reuse them inside Create Pin Studio without navigating away.

import type {
  AssetRoleV2,
  DestinationType,
  ItemType,
  ProductSubtype,
  ProductType,
  RiskFlag,
  SourceContext,
} from "@/lib/assetClassification";
import type { StoreSyncAdapter } from "./userStoreSync";
import type { MediaOffloadCandidate } from "./mediaOffload";
import { isLocalMediaUrl } from "./mediaUrl";

export type AssetRole   = "product" | "style_reference";
export type AssetSource =
  | "upload"
  | "product_signal"
  | "product_ideas"
  | "pin_opportunity"
  | "viral_pin"
  | "url"
  | "recent"
  | "shopify";

export type AssetItem = {
  id:           string;
  role:         AssetRole;
  assetRole?:   AssetRoleV2;
  itemType?:    ItemType;
  productType?: ProductType;
  productSubtype?: ProductSubtype;
  destinationType?: DestinationType;
  sourceContext?: SourceContext;
  riskFlags?:   RiskFlag[];
  source:       AssetSource;
  imageUrl:     string;
  title?:       string;
  category?:    string;
  keyword?:     string;
  visualFormat?: string;
  sourceUrl?:   string;
  productUrl?:  string;
  sourceDomain?: string;
  extractionReason?: string;
  // Extended product metadata (URL import)
  price?:        string;
  currency?:     string;
  canonicalUrl?: string;
  store?:        string;
  allImages?:    string[];
  status?:       "ready" | "import_issue";
  createdAt:    string;
  lastUsedAt:   string;
  updatedAt?:   string; // ISO — account-sync LWW key (WP-C); falls back to lastUsedAt/createdAt
};

const STORAGE_KEY = "vp_assets_v1";
const listeners   = new Set<() => void>();
const EMPTY: AssetItem[] = [];
let _cache: AssetItem[] | null = null;

/** window event fired after every persist — drives the account-sync engine (WP-C). */
export const ASSET_STORE_EVENT = "vp:assets_updated";

/** Local hot-cache cap. `let` so tests can shrink it; product default 200. */
let MAX_ASSETS = 200;

/**
 * Capacity-eviction shadow (account sync, WP-C). localStorage keeps the newest
 * MAX_ASSETS; the sync server holds the FULL set. Assets pushed out of the hot cache
 * by capacity are kept here (this session) and still reported by the adapter's
 * getAll(), so a trim never looks like a user delete (no tombstone storm). A real
 * removeAsset() drops the id from BOTH the cache and this shadow → tombstone.
 */
const _evicted = new Map<string, AssetItem>();

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function read(): AssetItem[] {
  if (typeof window === "undefined") return EMPTY;
  if (_cache) return _cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    _cache = raw ? (JSON.parse(raw) as AssetItem[]) : [];
  } catch {
    _cache = [];
  }
  return _cache;
}

function recencyKey(a: AssetItem): string { return a.lastUsedAt || a.createdAt || ""; }

function write(items: AssetItem[]): void {
  if (typeof window === "undefined") return;
  // Trim to newest MAX_ASSETS for the hot cache; overflow → shadow (no tombstone).
  const sorted = [...items].sort((a, b) => recencyKey(b).localeCompare(recencyKey(a)));
  const kept = sorted.slice(0, MAX_ASSETS);
  const keptIds = new Set(kept.map(a => a.id));
  for (const a of sorted.slice(MAX_ASSETS)) _evicted.set(a.id, a);
  for (const id of keptIds) _evicted.delete(id);
  _cache = kept;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(kept)); } catch { /* quota */ }
  listeners.forEach(fn => fn());
  try { window.dispatchEvent(new Event(ASSET_STORE_EVENT)); } catch { /* ignore */ }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function getAssets(): AssetItem[] { return read(); }

// Stable empty-array reference for useSyncExternalStore server snapshot.
export function getServerAssets(): AssetItem[] { return EMPTY; }

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function saveAsset(item: Omit<AssetItem, "id" | "createdAt" | "lastUsedAt">): AssetItem {
  const items = read();
  // Deduplicate by imageUrl + role
  const existing = items.find(x => x.imageUrl === item.imageUrl && x.role === item.role);
  if (existing) {
    existing.lastUsedAt = new Date().toISOString();
    write([...items]);
    return existing;
  }
  const now = new Date().toISOString();
  const asset: AssetItem = { ...item, id: uid(), createdAt: now, lastUsedAt: now };
  write([asset, ...items]); // write() trims to MAX_ASSETS (overflow → shadow, no tombstone)
  return asset;
}

export function markUsed(id: string): void {
  const items = read();
  const item  = items.find(x => x.id === id);
  if (item) { item.lastUsedAt = new Date().toISOString(); write([...items]); }
}

export function removeAsset(id: string): void {
  _evicted.delete(id); // real user delete → drop from shadow so the engine tombstones it
  write(read().filter(x => x.id !== id));
}

export function getByRole(role: AssetRole): AssetItem[] {
  return read().filter(x => x.role === role);
}

export function getRecentProducts(limit = 20): AssetItem[] {
  return read()
    .filter(x => x.role === "product")
    .sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime())
    .slice(0, limit);
}

export function getRecentReferences(limit = 20): AssetItem[] {
  return read()
    .filter(x => x.role === "style_reference")
    .sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime())
    .slice(0, limit);
}

// ── Account-level sync (WP-C) ────────────────────────────────────────────────
// Collection under storeKey `assets` (doc_id = asset id). LWW key = updatedAt ??
// lastUsedAt ?? createdAt. getAll() reports the hot cache PLUS the capacity-eviction
// shadow (so a 200-cap trim never tombstones), and marks any asset whose image is
// still a local (data:/blob:) URL as `hold: true` — the engine keeps a held asset
// (never PUTs or tombstones it) until the media-offload sweep externalizes the image
// and bumps updatedAt, which releases the hold and re-enters the diff. Held assets
// must be RETURNED (not dropped): dropping an already-synced asset would tombstone it.

function assetTsMs(v: string | null | undefined): number {
  const ms = v ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}
function assetTs(a: AssetItem): string { return a.updatedAt || a.lastUsedAt || a.createdAt; }

let _heldAssets = 0;

export const assetsSyncAdapter: StoreSyncAdapter<AssetItem> = {
  storeKey: "assets",
  eventName: ASSET_STORE_EVENT,
  getAll() {
    const present = read();
    const out: Array<{ id: string; updatedAt: string; doc: AssetItem; hold?: boolean }> = [];
    const seen = new Set<string>();
    let held = 0;
    const consider = (a: AssetItem) => {
      if (seen.has(a.id)) return;
      seen.add(a.id);
      // Still a local (data:/blob:) image → return it but HOLD (never PUT/tombstone
      // until the sweep externalizes it).
      const hold = isLocalMediaUrl(a.imageUrl);
      if (hold) held++;
      out.push({ id: a.id, updatedAt: assetTs(a), doc: a, ...(hold ? { hold: true } : {}) });
    };
    for (const a of present) consider(a);
    for (const a of _evicted.values()) consider(a);
    _heldAssets = held;
    return out;
  },
  mergeServer(live, deleted) {
    if (typeof window === "undefined") return;
    const map = new Map(read().map(a => [a.id, a]));
    let changed = false;
    for (const inc of live) {
      if (!inc || typeof inc.id !== "string" || !inc.id) continue;
      const local = map.get(inc.id) ?? _evicted.get(inc.id) ?? null;
      if (local && assetTsMs(assetTs(inc)) <= assetTsMs(assetTs(local))) continue;
      map.set(inc.id, inc);
      _evicted.delete(inc.id);
      changed = true;
    }
    for (const t of deleted) {
      if (!t || typeof t.id !== "string") continue;
      const local = map.get(t.id) ?? _evicted.get(t.id) ?? null;
      if (!local) continue;
      if (assetTsMs(assetTs(local)) >= assetTsMs(t.deletedAt)) continue;
      map.delete(t.id);
      _evicted.delete(t.id);
      changed = true;
    }
    if (changed) write([...map.values()]);
  },
};

// ── Media offload (WP-C) ──────────────────────────────────────────────────────

/** Assets (hot cache + shadow) whose image is still a local (data:/blob:) URL. */
export function collectMediaOffloadCandidates(): MediaOffloadCandidate[] {
  if (typeof window === "undefined") return [];
  const seen = new Set<string>();
  const out: MediaOffloadCandidate[] = [];
  const consider = (a: AssetItem) => {
    if (seen.has(a.id)) return;
    seen.add(a.id);
    if (isLocalMediaUrl(a.imageUrl)) {
      out.push({ url: a.imageUrl, replace: (stableUrl) => replaceAssetImage(a.id, stableUrl) });
    }
  };
  for (const a of read()) consider(a);
  for (const a of _evicted.values()) consider(a);
  return out;
}

/** Swap an asset's image (hot cache OR shadow) for a stable URL + bump updatedAt. */
function replaceAssetImage(id: string, stableUrl: string): void {
  const now = new Date().toISOString();
  const items = read();
  if (items.some(a => a.id === id)) {
    write(items.map(a => a.id === id ? { ...a, imageUrl: stableUrl, updatedAt: now } : a));
    return;
  }
  const ev = _evicted.get(id);
  if (ev) {
    _evicted.set(id, { ...ev, imageUrl: stableUrl, updatedAt: now });
    write(read()); // re-persist to fire the event so the engine re-diffs the shadow set
  }
}

// ── Test-only hooks (not used by product code) ───────────────────────────────
export function __setMaxAssetsForTests(n: number): void { MAX_ASSETS = n; }
// `excluded` key kept for back-compat; it now reports the count of HELD assets.
export function __getAssetsSyncDebug(): { excluded: number; held: number; evicted: number } {
  return { excluded: _heldAssets, held: _heldAssets, evicted: _evicted.size };
}
export function __resetAssetStoreForTests(): void {
  _cache = null;
  _evicted.clear();
  _heldAssets = 0;
  MAX_ASSETS = 200;
}
