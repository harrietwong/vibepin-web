// Create Basket — localStorage-persisted, event-driven.
// Works across page navigations without a framework store.

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

// Stable empty reference for SSR — must never be mutated.
const EMPTY_BASKET: CreateBasket = Object.freeze({ opportunities: [], products: [], references: [], updatedAt: "" });

// Module-level cache so the same object reference is returned until write() is called.
let _cache: CreateBasket | null = null;

function read(): CreateBasket {
  if (typeof window === "undefined") return EMPTY_BASKET;
  if (_cache) return _cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    _cache = raw ? (JSON.parse(raw) as CreateBasket) : { ...EMPTY_BASKET, updatedAt: new Date().toISOString() };
  } catch {
    _cache = { ...EMPTY_BASKET, updatedAt: new Date().toISOString() };
  }
  return _cache;
}

function write(basket: CreateBasket): void {
  if (typeof window === "undefined") return;
  basket.updatedAt = new Date().toISOString();
  _cache = basket; // update cache before notifying listeners
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(basket));
  } catch { /* quota exceeded — ignore */ }
  listeners.forEach(fn => fn());
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
  const fresh = { ...EMPTY_BASKET, updatedAt: new Date().toISOString() };
  _cache = fresh;
  if (typeof window !== "undefined") {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }
  listeners.forEach(fn => fn());
}

// Stable server-side snapshot — required by useSyncExternalStore.
export function getServerBasket(): CreateBasket { return EMPTY_BASKET; }
export function getServerCount():  number       { return 0; }

export function getTotalCount(): number {
  const b = read();
  return b.opportunities.length + b.products.length + b.references.length;
}
