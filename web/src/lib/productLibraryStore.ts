// User Product Library — localStorage MVP (no DB required).
// Stores the user's own uploaded products and product sets.

import type { StoreSyncAdapter } from "./userStoreSync";
import type { MediaOffloadCandidate } from "./mediaOffload";
import { isLocalMediaUrl } from "./mediaUrl";

export type LibraryProduct = {
  id:         string;
  title:      string;
  imageUrl:   string; // stable hosted URL (uploads externalized); may be a data: URL until swept
  category:   string;
  collection: string;
  tags:       string[];
  createdAt:  string;
  lastUsed?:  string;
  updatedAt?: string; // ISO — stamped on every write (account-sync LWW key; WP-C)
};

export type ProductSet = {
  id:         string;
  name:       string;
  productIds: string[];
  category:   string;
  createdAt:  string;
  updatedAt:  string;
};

export type ReferencePin = {
  id:           string;
  imageUrl:     string;
  source:       "viral_pin" | "opportunity" | "uploaded" | "studio";
  keyword?:     string;
  category?:    string;
  visualFormat?: string; // flat_lay | on_body | room_scene | product_only | mirror | moodboard
  humanPresence?: string; // visible | hands | none
  savedAt:      string;
  updatedAt?:   string; // ISO — account-sync LWW key; backfilled from savedAt when absent (WP-C)
};

type LibraryState = {
  products:    LibraryProduct[];
  sets:        ProductSet[];
  collections: string[]; // collection names (user-defined)
  references:  ReferencePin[];
};

const PRODUCTS_KEY    = "vp_product_library_v1";
const REFERENCES_KEY  = "vp_reference_library_v1";
const listeners       = new Set<() => void>();

/** window event fired after every persist — drives the account-sync engine (WP-C). */
export const PRODUCT_LIBRARY_EVENT = "vp:product_library_updated";

// ── Seed data (demo purposes so first-open isn't empty) ──────────────────────
const SEED_COLLECTIONS = [
  "Bedroom Decor", "Living Room", "Kitchen & Dining",
  "Home Office", "Bathroom", "Digital Products", "Summer Collection",
];
// Stable copy of the original seed for the "pristine library" sync guard. Kept
// separate because emptyState() aliases SEED_COLLECTIONS, which addCollection then
// mutates in place — so SEED_COLLECTIONS itself is not a reliable baseline.
const SEED_COLLECTIONS_SNAPSHOT = [...SEED_COLLECTIONS];

function emptyState(): LibraryState {
  // Spread the seed so addCollection can't mutate the module constant in place.
  return { products: [], sets: [], collections: [...SEED_COLLECTIONS], references: [] };
}

// Stable server-side snapshot — must never be mutated.
const EMPTY_STATE: LibraryState = Object.freeze({
  products: [], sets: [], collections: SEED_COLLECTIONS, references: [],
});

// Module-level cache — same reference until write() is called.
let _cache: LibraryState | null = null;

function read(): LibraryState {
  if (typeof window === "undefined") return EMPTY_STATE;
  if (_cache) return _cache;
  try {
    const raw  = localStorage.getItem(PRODUCTS_KEY);
    const rRaw = localStorage.getItem(REFERENCES_KEY);
    const base = raw ? (JSON.parse(raw) as LibraryState) : emptyState();
    if (rRaw) base.references = JSON.parse(rRaw) as ReferencePin[];
    _cache = base;
  } catch {
    _cache = emptyState();
  }
  return _cache;
}

function write(state: LibraryState): void {
  if (typeof window === "undefined") return;
  _cache = state; // update cache before notifying listeners
  try {
    const { references, ...rest } = state;
    localStorage.setItem(PRODUCTS_KEY,   JSON.stringify(rest));
    localStorage.setItem(REFERENCES_KEY, JSON.stringify(references));
  } catch { /* quota exceeded — ignore */ }
  listeners.forEach(fn => fn());
  try { window.dispatchEvent(new Event(PRODUCT_LIBRARY_EVENT)); } catch { /* ignore */ }
}

// Stable server-side snapshot for useSyncExternalStore.
export function getServerState(): LibraryState { return EMPTY_STATE; }

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Subscriptions ──────────────────────────────────────────────────────────────

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── Products ───────────────────────────────────────────────────────────────────

export function getProducts(): LibraryProduct[] {
  return read().products;
}

export function addProduct(p: Omit<LibraryProduct, "id" | "createdAt">): LibraryProduct {
  const s = read();
  const now = new Date().toISOString();
  const product: LibraryProduct = { ...p, id: uid(), createdAt: now, updatedAt: now };
  s.products = [product, ...s.products];
  write(s);
  return product;
}

export function updateProduct(id: string, patch: Partial<LibraryProduct>): void {
  const s = read();
  const now = new Date().toISOString();
  s.products = s.products.map(p => p.id === id ? { ...p, ...patch, updatedAt: now } : p);
  write(s);
}

export function removeProduct(id: string): void {
  const s = read();
  s.products = s.products.filter(p => p.id !== id);
  // Also remove from sets
  s.sets = s.sets.map(set => ({
    ...set,
    productIds: set.productIds.filter(pid => pid !== id),
    updatedAt: new Date().toISOString(),
  }));
  write(s);
}

// ── Collections ────────────────────────────────────────────────────────────────

export function getCollections(): string[] {
  return read().collections;
}

export function addCollection(name: string): void {
  const s = read();
  if (!s.collections.includes(name)) s.collections.push(name);
  write(s);
}

// ── Product Sets ───────────────────────────────────────────────────────────────

export function getSets(): ProductSet[] {
  return read().sets;
}

export function createSet(name: string, productIds: string[], category = ""): ProductSet {
  const s = read();
  const now = new Date().toISOString();
  const set: ProductSet = { id: uid(), name, productIds, category, createdAt: now, updatedAt: now };
  s.sets = [set, ...s.sets];
  write(s);
  return set;
}

export function deleteSet(id: string): void {
  const s = read();
  s.sets = s.sets.filter(set => set.id !== id);
  write(s);
}

// ── References ─────────────────────────────────────────────────────────────────

export function getReferences(): ReferencePin[] {
  return read().references;
}

export function saveReference(r: Omit<ReferencePin, "id" | "savedAt">): ReferencePin {
  const s = read();
  // Deduplicate by imageUrl
  if (s.references.find(x => x.imageUrl === r.imageUrl)) {
    return s.references.find(x => x.imageUrl === r.imageUrl)!;
  }
  const ref: ReferencePin = { ...r, id: uid(), savedAt: new Date().toISOString() };
  s.references = [ref, ...s.references];
  write(s);
  return ref;
}

export function removeReference(id: string): void {
  const s = read();
  s.references = s.references.filter(r => r.id !== id);
  write(s);
}

export function getFullState(): LibraryState {
  return read();
}

// ── Account-level sync (WP-C) ────────────────────────────────────────────────
// Two adapters over the ONE library state:
//   • `product_library` — products (doc_id `product:<id>`), sets (`set:<id>`) and
//     collections (`collection:<encoded name>`); each payload carries `kind`.
//   • `reference_library` — references (doc_id = reference id).
// Both share PRODUCT_LIBRARY_EVENT. getAll() EXCLUDES any doc still holding a
// local (data:/blob:) image so oversized/meaningless payloads never sync — the
// media-offload sweep replaces those with stable URLs, which re-enters the diff.

const EPOCH = "1970-01-01T00:00:00.000Z";

function libTsMs(v: string | null | undefined): number {
  const ms = v ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

function productTs(p: LibraryProduct): string { return p.updatedAt || p.createdAt || EPOCH; }
function referenceTs(r: ReferencePin): string { return r.updatedAt || r.savedAt || EPOCH; }

/** True when a serialized doc still embeds a local (data:/blob:) image. */
function hasLocalImage(doc: unknown): boolean {
  const url = (doc as { imageUrl?: unknown })?.imageUrl;
  return typeof url === "string" && isLocalMediaUrl(url);
}

let _excludedProducts = 0;
let _excludedReferences = 0;

type ProductLibraryDoc =
  | ({ kind: "product" } & LibraryProduct)
  | ({ kind: "set" } & ProductSet)
  | { kind: "collection"; name: string };

export const productLibrarySyncAdapter: StoreSyncAdapter<ProductLibraryDoc> = {
  storeKey: "product_library",
  eventName: PRODUCT_LIBRARY_EVENT,
  getAll() {
    const s = read();
    // Don't sync a pristine library (no products/sets + only the seed collections) —
    // mirrors the WP-B "never upload untouched defaults" rule.
    const collectionsAreSeed =
      s.collections.length === SEED_COLLECTIONS_SNAPSHOT.length &&
      s.collections.every((c, i) => c === SEED_COLLECTIONS_SNAPSHOT[i]);
    if (s.products.length === 0 && s.sets.length === 0 && collectionsAreSeed) {
      _excludedProducts = 0;
      return [];
    }
    const out: Array<{ id: string; updatedAt: string; doc: ProductLibraryDoc }> = [];
    let excluded = 0;
    for (const p of s.products) {
      if (hasLocalImage(p)) { excluded++; continue; } // wait for the sweep
      out.push({ id: `product:${p.id}`, updatedAt: productTs(p), doc: { kind: "product", ...p } });
    }
    for (const set of s.sets) {
      out.push({ id: `set:${set.id}`, updatedAt: set.updatedAt || EPOCH, doc: { kind: "set", ...set } });
    }
    for (const name of s.collections) {
      out.push({ id: `collection:${encodeURIComponent(name)}`, updatedAt: EPOCH, doc: { kind: "collection", name } });
    }
    _excludedProducts = excluded;
    return out;
  },
  mergeServer(live, deleted) {
    if (typeof window === "undefined") return;
    const s = read();
    const products = new Map(s.products.map(p => [p.id, p]));
    const sets = new Map(s.sets.map(x => [x.id, x]));
    const collections = new Set(s.collections);
    let changed = false;

    for (const inc of live) {
      if (!inc || typeof (inc as { kind?: unknown }).kind !== "string") continue;
      if (inc.kind === "product") {
        const { kind: _k, ...p } = inc; void _k;
        if (!p.id) continue;
        const local = products.get(p.id);
        if (local && libTsMs(productTs(inc)) <= libTsMs(productTs(local))) continue;
        products.set(p.id, p as LibraryProduct);
        changed = true;
      } else if (inc.kind === "set") {
        const { kind: _k, ...set } = inc; void _k;
        if (!set.id) continue;
        const local = sets.get(set.id);
        if (local && libTsMs(set.updatedAt) <= libTsMs(local.updatedAt)) continue;
        sets.set(set.id, set as ProductSet);
        changed = true;
      } else if (inc.kind === "collection") {
        if (inc.name && !collections.has(inc.name)) { collections.add(inc.name); changed = true; }
      }
    }

    for (const t of deleted) {
      if (!t || typeof t.id !== "string") continue;
      const [prefix, ...rest] = t.id.split(":");
      const rawId = rest.join(":");
      if (prefix === "product") {
        const local = products.get(rawId);
        if (local && libTsMs(productTs(local)) < libTsMs(t.deletedAt)) { products.delete(rawId); changed = true; }
      } else if (prefix === "set") {
        const local = sets.get(rawId);
        if (local && libTsMs(local.updatedAt) < libTsMs(t.deletedAt)) { sets.delete(rawId); changed = true; }
      } else if (prefix === "collection") {
        const name = decodeURIComponent(rawId);
        if (collections.has(name)) { collections.delete(name); changed = true; } // collections carry no ts → tombstone wins
      }
    }

    if (changed) {
      s.products = [...products.values()];
      s.sets = [...sets.values()];
      s.collections = [...collections];
      write(s);
    }
  },
};

export const referenceLibrarySyncAdapter: StoreSyncAdapter<ReferencePin> = {
  storeKey: "reference_library",
  eventName: PRODUCT_LIBRARY_EVENT,
  getAll() {
    const s = read();
    const out: Array<{ id: string; updatedAt: string; doc: ReferencePin }> = [];
    let excluded = 0;
    for (const r of s.references) {
      if (hasLocalImage(r)) { excluded++; continue; }
      out.push({ id: r.id, updatedAt: referenceTs(r), doc: r });
    }
    _excludedReferences = excluded;
    return out;
  },
  mergeServer(live, deleted) {
    if (typeof window === "undefined") return;
    const s = read();
    const refs = new Map(s.references.map(r => [r.id, r]));
    let changed = false;
    for (const inc of live) {
      if (!inc || typeof inc.id !== "string" || !inc.id) continue;
      const local = refs.get(inc.id);
      if (local && libTsMs(referenceTs(inc)) <= libTsMs(referenceTs(local))) continue;
      refs.set(inc.id, inc);
      changed = true;
    }
    for (const t of deleted) {
      if (!t || typeof t.id !== "string") continue;
      const local = refs.get(t.id);
      if (!local) continue;
      if (libTsMs(referenceTs(local)) >= libTsMs(t.deletedAt)) continue;
      refs.delete(t.id);
      changed = true;
    }
    if (changed) { s.references = [...refs.values()]; write(s); }
  },
};

// ── Media offload (WP-C) ──────────────────────────────────────────────────────

/** Products + references whose image is still a local (data:/blob:) URL. */
export function collectMediaOffloadCandidates(): MediaOffloadCandidate[] {
  if (typeof window === "undefined") return [];
  const s = read();
  const out: MediaOffloadCandidate[] = [];
  for (const p of s.products) {
    if (isLocalMediaUrl(p.imageUrl)) {
      out.push({ url: p.imageUrl, replace: (stableUrl) => updateProduct(p.id, { imageUrl: stableUrl }) });
    }
  }
  for (const r of s.references) {
    if (isLocalMediaUrl(r.imageUrl)) {
      out.push({
        url: r.imageUrl,
        replace: (stableUrl) => {
          const cur = read();
          const now = new Date().toISOString();
          cur.references = cur.references.map(x => x.id === r.id ? { ...x, imageUrl: stableUrl, updatedAt: now } : x);
          write(cur);
        },
      });
    }
  }
  return out;
}

// ── Test-only debug hooks ─────────────────────────────────────────────────────
export function __getProductLibrarySyncDebug(): { excludedProducts: number; excludedReferences: number } {
  return { excludedProducts: _excludedProducts, excludedReferences: _excludedReferences };
}
export function __resetProductLibraryForTests(): void {
  _cache = null;
  _excludedProducts = 0;
  _excludedReferences = 0;
}
