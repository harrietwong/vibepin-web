// Create Basket — localStorage-persisted, event-driven.
// Works across page navigations without a framework store.

import type { StoreSyncAdapter } from "./userStoreSync";
import type { MediaOffloadCandidate } from "./mediaOffload";
import { isLocalMediaUrl } from "./mediaUrl";

export type BasketOpportunity = {
  id:       string;
  keyword:  string;
  category: string;
  tier:     string; // best_bet | steady | competitive
};

export type BasketProduct = {
  id:          string;
  title:       string;
  imageUrl:    string;
  collection?: string;
  category?:   string;
};

export type BasketReference = {
  id:           string;
  imageUrl:     string;
  source:       string; // "viral_pin" | "opportunity" | "uploaded" | "library"
  keyword?:     string;
  visualFormat?: string;
};

export type CreateBasket = {
  opportunities: BasketOpportunity[];
  products:      BasketProduct[];
  references:    BasketReference[];
  updatedAt:     string;
};

const STORAGE_KEY = "vp_basket_v1";
const listeners   = new Set<() => void>();

/** window event fired after every persist — drives the account-sync engine (WP-C). */
export const BASKET_EVENT = "vp:basket_updated";

// Stable empty reference for SSR — must never be mutated. NOTE: Object.freeze is
// shallow — the nested arrays stay mutable, so this must never be (shallow-)copied
// into a mutable basket: pushes would leak into the shared template arrays and
// cleared items could resurrect. Mutable paths use emptyBasket() instead.
const EMPTY_BASKET: CreateBasket = Object.freeze({ opportunities: [], products: [], references: [], updatedAt: "" });

function emptyBasket(): CreateBasket {
  return { opportunities: [], products: [], references: [], updatedAt: new Date().toISOString() };
}

// Module-level cache so the same object reference is returned until write() is called.
let _cache: CreateBasket | null = null;

function read(): CreateBasket {
  if (typeof window === "undefined") return EMPTY_BASKET;
  if (_cache) return _cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    _cache = raw ? (JSON.parse(raw) as CreateBasket) : emptyBasket();
  } catch {
    _cache = emptyBasket();
  }
  return _cache;
}

function write(basket: CreateBasket): void {
  if (typeof window === "undefined") return;
  basket.updatedAt = new Date().toISOString();
  persistRaw(basket);
}

/** Persist WITHOUT re-stamping updatedAt (used by mergeServer so a pulled server
 *  basket keeps its authoritative timestamp and never ping-pongs). */
function persistRaw(basket: CreateBasket): void {
  if (typeof window === "undefined") return;
  _cache = basket; // update cache before notifying listeners
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(basket));
  } catch { /* quota exceeded — ignore */ }
  listeners.forEach(fn => fn());
  try { window.dispatchEvent(new Event(BASKET_EVENT)); } catch { /* ignore */ }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function getBasket(): CreateBasket {
  return read();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Products

export function addProducts(products: BasketProduct[]): void {
  const b = read();
  for (const p of products) {
    if (!b.products.find(x => x.id === p.id)) b.products.push(p);
  }
  write(b);
}

export function removeProduct(id: string): void {
  const b = read();
  b.products = b.products.filter(p => p.id !== id);
  write(b);
}

// References

export function addReferences(refs: BasketReference[]): void {
  const b = read();
  for (const r of refs) {
    if (!b.references.find(x => x.id === r.id)) b.references.push(r);
  }
  write(b);
}

export function removeReference(id: string): void {
  const b = read();
  b.references = b.references.filter(r => r.id !== id);
  write(b);
}

// Opportunities

export function addOpportunity(opp: BasketOpportunity): void {
  const b = read();
  // Only one active opportunity at a time (replace)
  b.opportunities = [opp];
  write(b);
}

export function removeOpportunity(id: string): void {
  const b = read();
  b.opportunities = b.opportunities.filter(o => o.id !== id);
  write(b);
}

// Utilities

export function clearBasket(): void {
  _cache = emptyBasket();
  if (typeof window !== "undefined") {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }
  listeners.forEach(fn => fn());
  if (typeof window !== "undefined") {
    try { window.dispatchEvent(new Event(BASKET_EVENT)); } catch { /* ignore */ }
  }
}

// Stable server-side snapshot — required by useSyncExternalStore.
export function getServerBasket(): CreateBasket { return EMPTY_BASKET; }
export function getServerCount():  number       { return 0; }

export function getTotalCount(): number {
  const b = read();
  return b.opportunities.length + b.products.length + b.references.length;
}

// ── Account-level sync (WP-C) ────────────────────────────────────────────────
// Singleton under storeKey `basket` (fixed doc_id "basket"). The basket already
// carries updatedAt. getAll() returns [] for an empty basket (nothing to sync) and
// returns the doc with `hold: true` while any product/reference image is still a
// local (data:/blob:) URL — the engine keeps a held doc (never tombstones or PUTs
// it) until the media-offload sweep replaces the image and bumps updatedAt, which
// releases the hold and re-enters the diff. NOTE: returning [] here would look like
// a delete to the engine and tombstone an already-synced basket, wiping other
// devices — that is exactly why a still-inline basket is HELD, not dropped.
// mergeServer writes the winner via persistRaw (no re-stamp).

const BASKET_DOC_ID = "basket";
const BASKET_EPOCH = "1970-01-01T00:00:00.000Z";

function basketTsMs(v: string | null | undefined): number {
  const ms = v ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

function basketHasLocalImage(b: CreateBasket): boolean {
  return b.products.some(p => isLocalMediaUrl(p.imageUrl)) || b.references.some(r => isLocalMediaUrl(r.imageUrl));
}

function basketIsEmpty(b: CreateBasket): boolean {
  return b.opportunities.length === 0 && b.products.length === 0 && b.references.length === 0;
}

let _basketHeld = false;

export const basketSyncAdapter: StoreSyncAdapter<CreateBasket> = {
  storeKey: "basket",
  eventName: BASKET_EVENT,
  getAll() {
    const b = read();
    if (basketIsEmpty(b)) { _basketHeld = false; return []; }
    // Still holds a local (data:/blob:) image → return the doc but HOLD it so the
    // engine keeps it (no tombstone, no PUT) until the sweep externalizes the image.
    const hold = basketHasLocalImage(b);
    _basketHeld = hold;
    return [{ id: BASKET_DOC_ID, updatedAt: b.updatedAt || BASKET_EPOCH, doc: b, ...(hold ? { hold: true } : {}) }];
  },
  mergeServer(live, deleted) {
    if (typeof window === "undefined") return;
    const local = read();
    const localTs = basketIsEmpty(local) ? -1 : basketTsMs(local.updatedAt);

    const incoming = (live[0] as CreateBasket | undefined) ?? null;
    const incomingTs = incoming ? basketTsMs(incoming.updatedAt) : -1;
    const tomb = deleted.find(d => d.id === BASKET_DOC_ID) ?? deleted[0] ?? null;
    const tombTs = tomb ? basketTsMs(tomb.deletedAt) : -1;

    let action: "none" | "write" | "delete" = "none";
    let bestTs = localTs;
    if (incoming && incomingTs > bestTs) { action = "write"; bestTs = incomingTs; }
    if (tomb && tombTs > bestTs) { action = "delete"; bestTs = tombTs; }

    if (action === "write" && incoming) {
      persistRaw({
        opportunities: incoming.opportunities ?? [],
        products: incoming.products ?? [],
        references: incoming.references ?? [],
        updatedAt: incoming.updatedAt || new Date().toISOString(),
      });
    } else if (action === "delete" && !basketIsEmpty(local)) {
      clearBasket();
    }
  },
};

// ── Media offload (WP-C) ──────────────────────────────────────────────────────

/** Basket products/references whose image is still a local (data:/blob:) URL. */
export function collectMediaOffloadCandidates(): MediaOffloadCandidate[] {
  if (typeof window === "undefined") return [];
  const b = read();
  const out: MediaOffloadCandidate[] = [];
  for (const p of b.products) {
    if (isLocalMediaUrl(p.imageUrl)) {
      out.push({
        url: p.imageUrl,
        replace: (stableUrl) => {
          const cur = read();
          cur.products = cur.products.map(x => x.id === p.id ? { ...x, imageUrl: stableUrl } : x);
          write(cur); // stamps a fresh updatedAt → re-enters the diff
        },
      });
    }
  }
  for (const r of b.references) {
    if (isLocalMediaUrl(r.imageUrl)) {
      out.push({
        url: r.imageUrl,
        replace: (stableUrl) => {
          const cur = read();
          cur.references = cur.references.map(x => x.id === r.id ? { ...x, imageUrl: stableUrl } : x);
          write(cur);
        },
      });
    }
  }
  return out;
}

// ── Test-only hooks ───────────────────────────────────────────────────────────
// `excluded` key kept for back-compat; it now reports whether the basket is HELD.
export function __getBasketSyncDebug(): { excluded: boolean; held: boolean } {
  return { excluded: _basketHeld, held: _basketHeld };
}
export function __resetBasketForTests(): void { _cache = null; _basketHeld = false; }
