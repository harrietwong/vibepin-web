// User Product Library — localStorage MVP (no DB required).
// Stores the user's own uploaded products and product sets.

export type LibraryProduct = {
  id:         string;
  title:      string;
  imageUrl:   string; // base64 data URL for MVP uploads
  category:   string;
  collection: string;
  tags:       string[];
  createdAt:  string;
  lastUsed?:  string;
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

// ── Seed data (demo purposes so first-open isn't empty) ──────────────────────
const SEED_COLLECTIONS = [
  "Bedroom Decor", "Living Room", "Kitchen & Dining",
  "Home Office", "Bathroom", "Digital Products", "Summer Collection",
];

function emptyState(): LibraryState {
  return { products: [], sets: [], collections: SEED_COLLECTIONS, references: [] };
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
  const product: LibraryProduct = { ...p, id: uid(), createdAt: new Date().toISOString() };
  s.products = [product, ...s.products];
  write(s);
  return product;
}

export function updateProduct(id: string, patch: Partial<LibraryProduct>): void {
  const s = read();
  s.products = s.products.map(p => p.id === id ? { ...p, ...patch } : p);
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
