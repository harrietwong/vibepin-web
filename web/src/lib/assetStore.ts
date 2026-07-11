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

export type AssetRole   = "product" | "style_reference";
export type AssetSource =
  | "upload"
  | "product_signal"
  | "product_ideas"
  | "pin_opportunity"
  | "viral_pin"
  | "url"
  | "recent";

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
};

const STORAGE_KEY = "vp_assets_v1";
const listeners   = new Set<() => void>();
const EMPTY: AssetItem[] = [];
let _cache: AssetItem[] | null = null;

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

function write(items: AssetItem[]): void {
  if (typeof window === "undefined") return;
  _cache = items;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch { /* quota */ }
  listeners.forEach(fn => fn());
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
  write([asset, ...items].slice(0, 200)); // cap at 200 items
  return asset;
}

export function markUsed(id: string): void {
  const items = read();
  const item  = items.find(x => x.id === id);
  if (item) { item.lastUsedAt = new Date().toISOString(); write([...items]); }
}

export function removeAsset(id: string): void {
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
