"use client";
import { useState, useRef, useCallback, useSyncExternalStore, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Plus, Search, Upload, X, CheckCircle2, ShoppingBag,
  BookmarkPlus, Trash2, MoreHorizontal, FolderOpen, ImagePlus, Sparkles,
} from "lucide-react";
import * as lib from "@/lib/productLibraryStore";
import * as basket from "@/lib/basketStore";
import { uploadPinImage } from "@/lib/studio/uploadPinImage";
import { toast } from "sonner";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import type { MessageKey } from "@/lib/i18n/messages/en";

// ── useBasket hook ─────────────────────────────────────────────────────────────
function useBasket() {
  return useSyncExternalStore(basket.subscribe, basket.getBasket, basket.getServerBasket);
}

// ── useLibrary hook ────────────────────────────────────────────────────────────
function useLibrary() {
  return useSyncExternalStore(lib.subscribe, lib.getFullState, lib.getServerState);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = (now.getTime() - d.getTime()) / 1000;
  if (diff < 60)       return "just now";
  if (diff < 3600)     return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)    return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800)   return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const SOURCE_LABEL_KEYS: Record<string, MessageKey> = {
  viral_pin:   "productLibrary.source.viralPin" as MessageKey,
  opportunity: "productLibrary.source.opportunity" as MessageKey,
  uploaded:    "productLibrary.source.uploaded" as MessageKey,
  studio:      "productLibrary.source.studio" as MessageKey,
} as const;
const SOURCE_COLORS: Record<string, string> = {
  viral_pin:   "#7C3AED",
  opportunity: "#2563EB",
  uploaded:    "#059669",
  studio:      "#D97706",
};
const VF_LABEL_KEYS: Record<string, MessageKey> = {
  flat_lay:     "productLibrary.visualFormat.flatLay" as MessageKey,
  on_body:      "productLibrary.visualFormat.onBody" as MessageKey,
  room_scene:   "productLibrary.visualFormat.roomScene" as MessageKey,
  product_only: "productLibrary.visualFormat.productOnly" as MessageKey,
  mirror:       "productLibrary.visualFormat.mirror" as MessageKey,
  moodboard:    "productLibrary.visualFormat.moodboard" as MessageKey,
} as const;

// ── Upload product dialog ──────────────────────────────────────────────────────
function UploadProductDialog({
  collections, onClose, onSave,
}: {
  collections: string[];
  onClose: () => void;
  onSave: (p: Omit<lib.LibraryProduct, "id" | "createdAt">) => void;
}) {
  const { t: tr } = useLocale();
  const fileRef = useRef<HTMLInputElement>(null);
  const [title,      setTitle]      = useState("");
  const [category,   setCategory]   = useState("");
  const [collection, setCollection] = useState(collections[0] ?? "");
  const [tags,       setTags]       = useState("");
  const [imageUrl,   setImageUrl]   = useState<string | null>(null);

  async function pickFile(file: File) {
    // Show an instant local preview, then externalize to a stable hosted URL so the
    // saved product syncs across devices. If the upload fails we keep the data URL —
    // the background media-offload sweep will replace it later.
    const r = new FileReader();
    r.onload = e => setImageUrl(e.target?.result as string ?? null);
    r.readAsDataURL(file);
    try {
      const { publicUrl } = await uploadPinImage(file);
      setImageUrl(publicUrl);
    } catch { /* keep the data URL preview; sweep will fix it up */ }
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", borderRadius: 16, padding: 28, width: 440, maxWidth: "92vw", boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <p style={{ margin: 0, fontSize: "16px", fontWeight: 800, color: "#0F172A" }}>{tr("productLibrary.uploadDialog.title" as MessageKey)}</p>
          <button type="button" onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#94A3B8" }}>
            <X style={{ width: 18, height: 18 }}/>
          </button>
        </div>

        {/* Image upload area */}
        <div
          onClick={() => fileRef.current?.click()}
          style={{
            width: "100%", aspectRatio: "4/3", borderRadius: 12, border: "2px dashed #E5E7EB",
            background: "#F8FAFC", display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", cursor: "pointer", marginBottom: 16, overflow: "hidden",
            position: "relative",
          }}
        >
          {imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={imageUrl} alt="preview" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}/>
          ) : (
            <>
              <ImagePlus style={{ width: 32, height: 32, color: "#CBD5E1", marginBottom: 8 }}/>
              <p style={{ margin: 0, fontSize: "12px", color: "#94A3B8", fontWeight: 600 }}>{tr("productLibrary.uploadDialog.clickToUpload" as MessageKey)}</p>
              <p style={{ margin: "4px 0 0", fontSize: "10px", color: "#CBD5E1" }}>{tr("productLibrary.uploadDialog.fileHint" as MessageKey)}</p>
            </>
          )}
        </div>
        <input ref={fileRef} type="file" accept="image/*" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) void pickFile(f); }}/>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder={tr("productLibrary.uploadDialog.titlePlaceholder" as MessageKey)}
            style={{ borderRadius: 9, border: "1px solid #E5E7EB", padding: "9px 13px", fontSize: "13px", outline: "none", color: "#374151" }}/>

          <div style={{ display: "flex", gap: 10 }}>
            <input value={category} onChange={e => setCategory(e.target.value)} placeholder={tr("productLibrary.uploadDialog.categoryPlaceholder" as MessageKey)}
              style={{ flex: 1, borderRadius: 9, border: "1px solid #E5E7EB", padding: "9px 13px", fontSize: "13px", outline: "none", color: "#374151" }}/>

            <div style={{ flex: 1, position: "relative" }}>
              <select value={collection} onChange={e => setCollection(e.target.value)}
                style={{ width: "100%", appearance: "none", borderRadius: 9, border: "1px solid #E5E7EB", padding: "9px 32px 9px 13px", fontSize: "13px", outline: "none", color: "#374151", background: "#fff", cursor: "pointer" }}>
                {collections.map(c => <option key={c} value={c}>{c}</option>)}
                <option value="">{tr("productLibrary.uploadDialog.noCollection" as MessageKey)}</option>
              </select>
              <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", fontSize: 10, color: "#94A3B8", pointerEvents: "none" }}>▼</span>
            </div>
          </div>

          <input value={tags} onChange={e => setTags(e.target.value)} placeholder={tr("productLibrary.uploadDialog.tagsPlaceholder" as MessageKey)}
            style={{ borderRadius: 9, border: "1px solid #E5E7EB", padding: "9px 13px", fontSize: "13px", outline: "none", color: "#374151" }}/>
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
          <button type="button" onClick={onClose}
            style={{ flex: 1, padding: "11px", borderRadius: 10, border: "1px solid #E5E7EB", background: "#F8FAFC", fontSize: "13px", fontWeight: 600, color: "#374151", cursor: "pointer" }}>
            {tr("productLibrary.uploadDialog.cancel" as MessageKey)}
          </button>
          <button type="button"
            disabled={!title.trim() || !imageUrl}
            onClick={() => {
              if (!title.trim() || !imageUrl) return;
              onSave({
                title: title.trim(),
                imageUrl,
                category: category.trim() || "Uncategorized",
                collection: collection || "",
                tags: tags.split(",").map(t => t.trim()).filter(Boolean),
              });
              onClose();
            }}
            style={{
              flex: 2, padding: "11px", borderRadius: 10, border: "none", fontSize: "13px", fontWeight: 800,
              background: title.trim() && imageUrl ? "linear-gradient(135deg,#FF4D8D,#7C3AED)" : "#F1F5F9",
              color: title.trim() && imageUrl ? "#fff" : "#94A3B8",
              cursor: title.trim() && imageUrl ? "pointer" : "not-allowed",
            }}>
            {tr("productLibrary.uploadDialog.saveToLibrary" as MessageKey)}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── New collection dialog ──────────────────────────────────────────────────────
function NewCollectionDialog({ onClose, onSave }: { onClose: () => void; onSave: (name: string) => void }) {
  const { t: tr } = useLocale();
  const [name, setName] = useState("");
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", borderRadius: 14, padding: 24, width: 340, boxShadow: "0 16px 40px rgba(0,0,0,0.2)" }}>
        <p style={{ margin: "0 0 16px", fontSize: "15px", fontWeight: 800, color: "#0F172A" }}>{tr("productLibrary.newCollectionDialog.title" as MessageKey)}</p>
        <input autoFocus value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && name.trim()) { onSave(name.trim()); onClose(); } }}
          placeholder={tr("productLibrary.newCollectionDialog.namePlaceholder" as MessageKey)}
          style={{ width: "100%", boxSizing: "border-box", borderRadius: 9, border: "1px solid #E5E7EB", padding: "9px 13px", fontSize: "13px", outline: "none", color: "#374151", marginBottom: 16 }}/>
        <div style={{ display: "flex", gap: 10 }}>
          <button type="button" onClick={onClose}
            style={{ flex: 1, padding: "10px", borderRadius: 9, border: "1px solid #E5E7EB", background: "#F8FAFC", fontSize: "13px", fontWeight: 600, color: "#374151", cursor: "pointer" }}>
            {tr("productLibrary.newCollectionDialog.cancel" as MessageKey)}
          </button>
          <button type="button" disabled={!name.trim()} onClick={() => { onSave(name.trim()); onClose(); }}
            style={{ flex: 2, padding: "10px", borderRadius: 9, border: "none", background: name.trim() ? "#7C3AED" : "#F1F5F9", color: name.trim() ? "#fff" : "#94A3B8", fontSize: "13px", fontWeight: 800, cursor: name.trim() ? "pointer" : "not-allowed" }}>
            {tr("productLibrary.newCollectionDialog.create" as MessageKey)}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Product card ───────────────────────────────────────────────────────────────
function ProductCard({
  product, selected, onToggle, onRemove, inBasket,
}: {
  product: lib.LibraryProduct;
  selected: boolean;
  onToggle: () => void;
  onRemove: () => void;
  inBasket: boolean;
}) {
  const { t: tr } = useLocale();
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div style={{
      borderRadius: 12, border: selected ? "2px solid #7C3AED" : "1.5px solid #E5E7EB",
      background: selected ? "rgba(124,58,237,0.03)" : "#fff",
      overflow: "hidden", display: "flex", flexDirection: "column",
      boxShadow: selected ? "0 0 0 3px rgba(124,58,237,0.1)" : "none",
      transition: "border-color 0.12s, box-shadow 0.12s",
      position: "relative",
    }}>
      {/* Image + checkbox overlay */}
      <div style={{ position: "relative", aspectRatio: "1/1", background: "#F8FAFC", cursor: "pointer" }} onClick={onToggle}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={product.imageUrl} alt={product.title}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          onError={e => { (e.currentTarget as HTMLImageElement).style.opacity = "0.3"; }}/>
        {/* Checkbox top-left */}
        <div style={{
          position: "absolute", top: 8, left: 8,
          width: 20, height: 20, borderRadius: 6,
          border: `2px solid ${selected ? "#7C3AED" : "rgba(255,255,255,0.85)"}`,
          background: selected ? "#7C3AED" : "rgba(255,255,255,0.55)",
          backdropFilter: "blur(4px)",
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: "0 1px 4px rgba(0,0,0,0.18)",
        }}>
          {selected && <CheckCircle2 style={{ width: 11, height: 11, color: "#fff" }}/>}
        </div>
        {/* Basket indicator */}
        {inBasket && (
          <div style={{ position: "absolute", top: 8, right: 8, padding: "2px 7px", borderRadius: 20, background: "rgba(124,58,237,0.85)", backdropFilter: "blur(4px)" }}>
            <span style={{ fontSize: "9px", fontWeight: 700, color: "#fff" }}>{tr("productLibrary.card.inBasket" as MessageKey)}</span>
          </div>
        )}
      </div>

      {/* Info */}
      <div style={{ padding: "10px 12px 10px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 4 }}>
          <p style={{ margin: 0, fontSize: "12px", fontWeight: 700, color: "#0F172A", lineHeight: 1.3, flex: 1 }}>{product.title}</p>
          {/* Menu button */}
          <div style={{ position: "relative", flexShrink: 0 }}>
            <button type="button" onClick={() => setMenuOpen(v => !v)}
              style={{ background: "none", border: "none", cursor: "pointer", color: "#94A3B8", padding: "2px" }}>
              <MoreHorizontal style={{ width: 14, height: 14 }}/>
            </button>
            {menuOpen && (
              <>
                <div style={{ position: "fixed", inset: 0, zIndex: 10 }} onClick={() => setMenuOpen(false)}/>
                <div style={{ position: "absolute", right: 0, top: "100%", zIndex: 20, background: "#fff", border: "1px solid #E5E7EB", borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", minWidth: 140, overflow: "hidden" }}>
                  <button type="button" onClick={() => { setMenuOpen(false); onRemove(); }}
                    style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", background: "none", border: "none", cursor: "pointer", fontSize: "12px", color: "#EF4444", fontWeight: 600, textAlign: "left" }}>
                    <Trash2 style={{ width: 12, height: 12 }}/> {tr("productLibrary.card.remove" as MessageKey)}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        <p style={{ margin: "3px 0 0", fontSize: "10px", color: "#94A3B8" }}>{product.category}</p>
        {product.collection && (
          <span style={{ display: "inline-block", marginTop: 5, fontSize: "9px", fontWeight: 700, color: "#7C3AED", background: "rgba(124,58,237,0.08)", padding: "2px 8px", borderRadius: 20 }}>
            {product.collection}
          </span>
        )}
        {product.lastUsed && (
          <p style={{ margin: "5px 0 0", fontSize: "9px", color: "#CBD5E1" }}>{tr("productLibrary.card.usedPrefix" as MessageKey).replace("{n}", formatDate(product.lastUsed))}</p>
        )}
      </div>
    </div>
  );
}

// ── Reference card ─────────────────────────────────────────────────────────────
function ReferenceCard({
  ref: r, selected, onToggle, onRemove, inBasket,
}: {
  ref: lib.ReferencePin; selected: boolean; onToggle: () => void; onRemove: () => void; inBasket: boolean;
}) {
  const { t: tr } = useLocale();
  const labelColor = SOURCE_COLORS[r.source] ?? "#374151";
  return (
    <div style={{
      borderRadius: 12, border: selected ? "2px solid #7C3AED" : "1.5px solid #E5E7EB",
      background: selected ? "rgba(124,58,237,0.03)" : "#fff", overflow: "hidden",
      display: "flex", flexDirection: "column",
      boxShadow: selected ? "0 0 0 3px rgba(124,58,237,0.1)" : "none",
      transition: "border-color 0.12s, box-shadow 0.12s", position: "relative",
    }}>
      <div style={{ position: "relative", aspectRatio: "2/3", background: "#F8FAFC", cursor: "pointer" }} onClick={onToggle}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={r.imageUrl} alt="reference"
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}/>
        <div style={{
          position: "absolute", top: 8, left: 8, width: 20, height: 20, borderRadius: 6,
          border: `2px solid ${selected ? "#7C3AED" : "rgba(255,255,255,0.85)"}`,
          background: selected ? "#7C3AED" : "rgba(255,255,255,0.55)",
          backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: "0 1px 4px rgba(0,0,0,0.18)",
        }}>
          {selected && <CheckCircle2 style={{ width: 11, height: 11, color: "#fff" }}/>}
        </div>
        {inBasket && (
          <div style={{ position: "absolute", top: 8, right: 8, padding: "2px 7px", borderRadius: 20, background: "rgba(124,58,237,0.85)", backdropFilter: "blur(4px)" }}>
            <span style={{ fontSize: "9px", fontWeight: 700, color: "#fff" }}>{tr("productLibrary.card.inBasket" as MessageKey)}</span>
          </div>
        )}
        <div style={{ position: "absolute", bottom: 6, left: 6 }}>
          <span style={{ fontSize: "9px", fontWeight: 700, color: labelColor, background: "rgba(255,255,255,0.88)", padding: "2px 7px", borderRadius: 20, backdropFilter: "blur(4px)", border: `1px solid ${labelColor}30` }}>
            {SOURCE_LABEL_KEYS[r.source] ? tr(SOURCE_LABEL_KEYS[r.source]) : r.source}
          </span>
        </div>
      </div>
      <div style={{ padding: "8px 10px" }}>
        {r.keyword && (
          <p style={{ margin: 0, fontSize: "11px", fontWeight: 600, color: "#374151", lineHeight: 1.3 }}>{r.keyword}</p>
        )}
        {r.visualFormat && (
          <p style={{ margin: "3px 0 0", fontSize: "9px", color: "#94A3B8" }}>{VF_LABEL_KEYS[r.visualFormat] ? tr(VF_LABEL_KEYS[r.visualFormat]) : r.visualFormat}</p>
        )}
        <p style={{ margin: "4px 0 0", fontSize: "9px", color: "#CBD5E1" }}>{formatDate(r.savedAt)}</p>
        <button type="button" onClick={onRemove}
          style={{ marginTop: 5, background: "none", border: "none", cursor: "pointer", fontSize: "10px", color: "#94A3B8", padding: 0, fontWeight: 500, display: "flex", alignItems: "center", gap: 4 }}>
          <Trash2 style={{ width: 10, height: 10 }}/> {tr("productLibrary.card.remove" as MessageKey)}
        </button>
      </div>
    </div>
  );
}

// ── Product Set card ───────────────────────────────────────────────────────────
function SetCard({ set, products, onDelete }: { set: lib.ProductSet; products: lib.LibraryProduct[]; onDelete: () => void }) {
  const { t: tr } = useLocale();
  const setProducts = products.filter(p => set.productIds.includes(p.id));
  return (
    <div style={{ borderRadius: 12, border: "1.5px solid #E5E7EB", background: "#fff", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <p style={{ margin: 0, fontSize: "13px", fontWeight: 700, color: "#0F172A" }}>{set.name}</p>
          <p style={{ margin: "2px 0 0", fontSize: "10px", color: "#94A3B8" }}>{setProducts.length} {setProducts.length !== 1 ? tr("productLibrary.setCard.products" as MessageKey) : tr("productLibrary.setCard.product" as MessageKey)}</p>
        </div>
        <button type="button" onClick={onDelete}
          style={{ background: "none", border: "none", cursor: "pointer", color: "#CBD5E1", padding: "2px" }}>
          <Trash2 style={{ width: 13, height: 13 }}/>
        </button>
      </div>
      <div style={{ display: "flex", gap: 5 }}>
        {setProducts.slice(0, 4).map(p => (
          <div key={p.id} style={{ width: 42, height: 42, borderRadius: 8, overflow: "hidden", border: "1px solid #E5E7EB", background: "#F8FAFC", flexShrink: 0 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.imageUrl} alt={p.title} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}/>
          </div>
        ))}
        {setProducts.length > 4 && (
          <div style={{ width: 42, height: 42, borderRadius: 8, border: "1.5px dashed #E5E7EB", background: "#F8FAFC", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: "10px", color: "#94A3B8", fontWeight: 700 }}>+{setProducts.length - 4}</span>
          </div>
        )}
      </div>
      <p style={{ margin: 0, fontSize: "9px", color: "#CBD5E1" }}>{tr("productLibrary.setCard.updatedPrefix" as MessageKey).replace("{n}", formatDate(set.updatedAt))}</p>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────
function ProductLibraryLoadingFallback() {
  const { t: tr } = useLocale();
  return <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#94A3B8", fontSize: "13px" }}>{tr("productLibrary.loading" as MessageKey)}</div>;
}

export default function ProductLibraryPage() {
  return (
    <Suspense fallback={<ProductLibraryLoadingFallback />}>
      <ProductLibraryContent />
    </Suspense>
  );
}

function ProductLibraryContent() {
  const { t: tr }     = useLocale();
  const router       = useRouter();
  const searchParams = useSearchParams();
  const activeTab    = (searchParams.get("tab") ?? "products") as "products" | "references";

  const libraryState = useLibrary();
  const basketState  = useBasket();

  // ── Product tab state ──────────────────────────────────────────────────────
  const [selectedIds,        setSelectedIds]       = useState<Set<string>>(new Set());
  const [searchQuery,        setSearchQuery]       = useState("");
  const [filterCategory,     setFilterCategory]    = useState("All categories");
  const [filterCollection,   setFilterCollection]  = useState("All collections");
  const [activeCollection,   setActiveCollection]  = useState<string | null>(null);
  const [showUploadDialog,   setShowUploadDialog]  = useState(false);
  const [showNewCollection,  setShowNewCollection] = useState(false);

  // ── Reference tab state ────────────────────────────────────────────────────
  const [selectedRefIds, setSelectedRefIds] = useState<Set<string>>(new Set());
  const refFileRef = useRef<HTMLInputElement>(null);

  // ── Derived ────────────────────────────────────────────────────────────────
  const products   = libraryState.products;
  const sets       = libraryState.sets;
  const collections = libraryState.collections;
  const references  = libraryState.references;

  const basketProductIds   = new Set(basketState.products.map(p => p.id));
  const basketReferenceIds = new Set(basketState.references.map(r => r.id));

  const filteredProducts = products.filter(p => {
    if (activeCollection && p.collection !== activeCollection) return false;
    if (filterCollection !== "All collections" && p.collection !== filterCollection) return false;
    if (filterCategory   !== "All categories"  && p.category  !== filterCategory)   return false;
    if (searchQuery && !p.title.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const collectionCounts = collections.reduce<Record<string, number>>((acc, c) => {
    acc[c] = products.filter(p => p.collection === c).length;
    return acc;
  }, {});

  // ── Actions ────────────────────────────────────────────────────────────────
  const toggleProduct = useCallback((id: string) => {
    setSelectedIds(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }, []);

  const toggleRef = useCallback((id: string) => {
    setSelectedRefIds(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }, []);

  function addSelectedToBasket() {
    const toAdd = products
      .filter(p => selectedIds.has(p.id))
      .map(p => ({ id: p.id, title: p.title, imageUrl: p.imageUrl, collection: p.collection, category: p.category }));
    basket.addProducts(toAdd);
    toast.success(tr((toAdd.length !== 1 ? "productLibrary.toast.productsAddedToBasketPlural" : "productLibrary.toast.productsAddedToBasket") as MessageKey).replace("{n}", String(toAdd.length)));
    setSelectedIds(new Set());
  }

  function addSelectedRefsToBasket() {
    const toAdd = references
      .filter(r => selectedRefIds.has(r.id))
      .map(r => ({ id: r.id, imageUrl: r.imageUrl, source: r.source, keyword: r.keyword, visualFormat: r.visualFormat }));
    basket.addReferences(toAdd);
    toast.success(tr((toAdd.length !== 1 ? "productLibrary.toast.referencesAddedToBasketPlural" : "productLibrary.toast.referencesAddedToBasket") as MessageKey).replace("{n}", String(toAdd.length)));
    setSelectedRefIds(new Set());
  }

  function createSetFromSelected() {
    const name = prompt(tr("productLibrary.prompt.productSetName" as MessageKey));
    if (!name?.trim()) return;
    lib.createSet(name.trim(), Array.from(selectedIds));
    toast.success(`${tr("productLibrary.toast.setCreatedPrefix" as MessageKey)}${name}${tr("productLibrary.toast.setCreatedSuffix" as MessageKey)}`);
    setSelectedIds(new Set());
  }

  async function uploadReference(file: File) {
    // Externalize to a stable hosted URL first; fall back to a data URL on failure
    // (the background media-offload sweep replaces it once uploads succeed).
    try {
      const { publicUrl } = await uploadPinImage(file);
      lib.saveReference({ imageUrl: publicUrl, source: "uploaded" });
      toast.success(tr("productLibrary.toast.referenceSaved" as MessageKey));
      return;
    } catch { /* fall through to local data URL */ }
    const r = new FileReader();
    r.onload = e => {
      lib.saveReference({ imageUrl: e.target?.result as string, source: "uploaded" });
      toast.success(tr("productLibrary.toast.referenceSaved" as MessageKey));
    };
    r.readAsDataURL(file);
  }

  const totalCount = basket.getTotalCount();
  const selCount   = selectedIds.size;
  const selRefCount = selectedRefIds.size;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh", background: "#F7F8FA" }}>

      {/* ── Header ── */}
      <div style={{ padding: "0 24px", background: "#fff", borderBottom: "1px solid #E5E7EB", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", height: 56 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: "18px", fontWeight: 800, color: "#0F172A" }}>{tr("productLibrary.header.title" as MessageKey)}</h1>
          <p style={{ margin: 0, fontSize: "11px", color: "#94A3B8" }}>{tr("productLibrary.header.subtitle" as MessageKey)}</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {totalCount > 0 && (
            <button type="button" onClick={() => router.push("/app/studio?fromBasket=1")}
              style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 16px", borderRadius: 30, border: "1px solid #E5E7EB", background: "#F8FAFC", fontSize: "12px", fontWeight: 700, color: "#374151", cursor: "pointer" }}>
              <ShoppingBag style={{ width: 14, height: 14 }}/> {tr("productLibrary.header.createBasket" as MessageKey)}
              <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, borderRadius: "50%", background: "#7C3AED", color: "#fff", fontSize: "10px", fontWeight: 800 }}>{totalCount}</span>
            </button>
          )}
        </div>
      </div>

      {/* ── Tabs ── */}
      <div style={{ padding: "0 24px", background: "#fff", borderBottom: "1px solid #E5E7EB", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 0 }}>
          {(["products", "references"] as const).map(tab => (
            <button key={tab} type="button"
              onClick={() => router.replace(`/app/product-library?tab=${tab}`)}
              style={{
                padding: "12px 20px", background: "none", border: "none", cursor: "pointer",
                fontSize: "13px", fontWeight: activeTab === tab ? 700 : 500,
                color: activeTab === tab ? "#7C3AED" : "#64748B",
                borderBottom: activeTab === tab ? "2px solid #7C3AED" : "2px solid transparent",
                marginBottom: -1,
              }}>
              {tab === "products" ? tr("productLibrary.tab.products" as MessageKey) : tr("productLibrary.tab.references" as MessageKey)}
            </button>
          ))}
        </div>
        <button type="button" style={{ display: "flex", alignItems: "center", gap: 5, background: "none", border: "none", cursor: "pointer", fontSize: "11px", color: "#94A3B8" }}>
          {tr("productLibrary.howItWorks" as MessageKey)}
        </button>
      </div>

      {/* ── Body ── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>

        {/* ── LEFT SIDEBAR ── */}
        <aside style={{ width: 220, flexShrink: 0, background: "#fff", borderRight: "1px solid #E5E7EB", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ flex: 1, overflowY: "auto", padding: "16px 14px", display: "flex", flexDirection: "column", gap: 24 }}>

            {activeTab === "products" && (
              <>
                {/* Collections */}
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                    <p style={{ margin: 0, fontSize: "11px", fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.07em" }}>{tr("productLibrary.sidebar.collections" as MessageKey)}</p>
                    <button type="button" onClick={() => setShowNewCollection(true)}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "#7C3AED", padding: 0 }}>
                      <Plus style={{ width: 14, height: 14 }}/>
                    </button>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    {/* All Products */}
                    <button type="button"
                      onClick={() => setActiveCollection(null)}
                      style={{
                        display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 8, border: "none",
                        background: activeCollection === null ? "rgba(124,58,237,0.08)" : "none",
                        cursor: "pointer", width: "100%", textAlign: "left",
                      }}>
                      <FolderOpen style={{ width: 13, height: 13, color: activeCollection === null ? "#7C3AED" : "#9CA3AF", flexShrink: 0 }}/>
                      <span style={{ flex: 1, fontSize: "12px", fontWeight: activeCollection === null ? 700 : 500, color: activeCollection === null ? "#7C3AED" : "#374151" }}>{tr("productLibrary.sidebar.allProducts" as MessageKey)}</span>
                      <span style={{ fontSize: "11px", color: "#94A3B8", fontWeight: 600 }}>{products.length}</span>
                    </button>

                    {collections.map(c => (
                      <button key={c} type="button"
                        onClick={() => setActiveCollection(c)}
                        style={{
                          display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 8, border: "none",
                          background: activeCollection === c ? "rgba(124,58,237,0.08)" : "none",
                          cursor: "pointer", width: "100%", textAlign: "left",
                        }}>
                        <FolderOpen style={{ width: 13, height: 13, color: activeCollection === c ? "#7C3AED" : "#9CA3AF", flexShrink: 0 }}/>
                        <span style={{ flex: 1, fontSize: "12px", fontWeight: activeCollection === c ? 700 : 500, color: activeCollection === c ? "#7C3AED" : "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c}</span>
                        <span style={{ fontSize: "11px", color: "#94A3B8", fontWeight: 600 }}>{collectionCounts[c] ?? 0}</span>
                      </button>
                    ))}

                    <button type="button" onClick={() => setShowNewCollection(true)}
                      style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", borderRadius: 8, border: "none", background: "none", cursor: "pointer", color: "#94A3B8", fontSize: "11px", fontWeight: 600, width: "100%", textAlign: "left" }}>
                      <Plus style={{ width: 12, height: 12 }}/> {tr("productLibrary.sidebar.newCollection" as MessageKey)}
                    </button>
                  </div>
                </div>

                {/* Quick actions */}
                <div>
                  <p style={{ margin: "0 0 8px", fontSize: "11px", fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.07em" }}>{tr("productLibrary.sidebar.quickActions" as MessageKey)}</p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <button type="button" onClick={() => { if (selCount > 0) createSetFromSelected(); else toast.info(tr("productLibrary.toast.selectProductsFirst" as MessageKey)); }}
                      style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 8, border: "1px solid #E5E7EB", background: "#FAFAFA", cursor: "pointer", fontSize: "11px", fontWeight: 600, color: "#374151" }}>
                      <FolderOpen style={{ width: 13, height: 13, color: "#7C3AED" }}/> {tr("productLibrary.sidebar.createProductSet" as MessageKey)}
                    </button>
                    <button type="button" onClick={() => router.push("/app/studio?fromBasket=1")}
                      style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 8, border: "1px solid #E5E7EB", background: "#FAFAFA", cursor: "pointer", fontSize: "11px", fontWeight: 600, color: "#374151", justifyContent: "space-between" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <ShoppingBag style={{ width: 13, height: 13, color: "#7C3AED" }}/> {tr("productLibrary.sidebar.viewCreateBasket" as MessageKey)}
                      </span>
                      {totalCount > 0 && (
                        <span style={{ fontSize: "10px", fontWeight: 800, color: "#7C3AED", background: "rgba(124,58,237,0.1)", padding: "1px 7px", borderRadius: 20 }}>{totalCount}</span>
                      )}
                    </button>
                  </div>
                </div>
              </>
            )}

            {activeTab === "references" && (
              <div>
                <p style={{ margin: "0 0 10px", fontSize: "11px", fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.07em" }}>{tr("productLibrary.sidebar.sources" as MessageKey)}</p>
                {(["all", "viral_pin", "opportunity", "uploaded", "studio"] as const).map(src => {
                  const count = src === "all" ? references.length : references.filter(r => r.source === src).length;
                  const label = src === "all" ? tr("productLibrary.source.all" as MessageKey) : tr(SOURCE_LABEL_KEYS[src]);
                  return (
                    <p key={src} style={{ margin: "0 0 5px", fontSize: "12px", color: "#374151", padding: "6px 10px", borderRadius: 8, cursor: "pointer" }}>
                      {label} <span style={{ color: "#94A3B8" }}>{count}</span>
                    </p>
                  );
                })}
                <div style={{ height: 1, background: "#F1F5F9", margin: "10px 0" }}/>
                <button type="button" onClick={() => refFileRef.current?.click()}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 8, border: "1px solid #E5E7EB", background: "#FAFAFA", cursor: "pointer", fontSize: "11px", fontWeight: 600, color: "#374151", width: "100%" }}>
                  <Upload style={{ width: 13, height: 13, color: "#7C3AED" }}/> {tr("productLibrary.sidebar.uploadReference" as MessageKey)}
                </button>
                <input ref={refFileRef} type="file" accept="image/*" className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) void uploadReference(f); }}/>
              </div>
            )}
          </div>
        </aside>

        {/* ── MAIN CONTENT ── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>

          {/* ── PRODUCTS TAB ── */}
          {activeTab === "products" && (
            <>
              {/* Toolbar */}
              <div style={{ padding: "12px 20px", background: "#fff", borderBottom: "1px solid #F1F5F9", flexShrink: 0, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                {/* Search */}
                <div style={{ position: "relative", flexShrink: 0 }}>
                  <Search style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", width: 13, height: 13, color: "#94A3B8", pointerEvents: "none" }}/>
                  <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                    placeholder={tr("productLibrary.toolbar.searchProducts" as MessageKey)}
                    style={{ paddingLeft: 32, paddingRight: 12, paddingTop: 8, paddingBottom: 8, borderRadius: 9, border: "1px solid #E5E7EB", fontSize: "12px", color: "#374151", outline: "none", background: "#FAFAFA", width: 200, boxSizing: "border-box" }}/>
                </div>

                {/* Category filter */}
                <div style={{ position: "relative" }}>
                  <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)}
                    style={{ appearance: "none", borderRadius: 9, border: "1px solid #E5E7EB", background: "#fff", padding: "8px 28px 8px 12px", fontSize: "12px", color: "#374151", cursor: "pointer", outline: "none" }}>
                    <option value="All categories">{tr("productLibrary.toolbar.allCategories" as MessageKey)}</option>
                    {[...new Set(products.map(p => p.category))].map(c => <option key={c}>{c}</option>)}
                  </select>
                  <span style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", fontSize: 9, color: "#94A3B8", pointerEvents: "none" }}>▼</span>
                </div>

                {/* Collection filter */}
                <div style={{ position: "relative" }}>
                  <select value={filterCollection} onChange={e => setFilterCollection(e.target.value)}
                    style={{ appearance: "none", borderRadius: 9, border: "1px solid #E5E7EB", background: "#fff", padding: "8px 28px 8px 12px", fontSize: "12px", color: "#374151", cursor: "pointer", outline: "none" }}>
                    <option value="All collections">{tr("productLibrary.toolbar.allCollections" as MessageKey)}</option>
                    {collections.map(c => <option key={c}>{c}</option>)}
                  </select>
                  <span style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", fontSize: 9, color: "#94A3B8", pointerEvents: "none" }}>▼</span>
                </div>

                <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexShrink: 0 }}>
                  <button type="button" onClick={() => setShowNewCollection(true)}
                    style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 9, border: "1px solid #E5E7EB", background: "#fff", fontSize: "12px", fontWeight: 600, color: "#374151", cursor: "pointer" }}>
                    <Plus style={{ width: 13, height: 13 }}/> {tr("productLibrary.toolbar.createCollection" as MessageKey)}
                  </button>
                  <button type="button" onClick={() => setShowUploadDialog(true)}
                    style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 9, border: "none", background: "linear-gradient(135deg,#FF4D8D,#7C3AED)", fontSize: "12px", fontWeight: 700, color: "#fff", cursor: "pointer" }}>
                    <Plus style={{ width: 13, height: 13 }}/> {tr("productLibrary.toolbar.uploadProduct" as MessageKey)}
                  </button>
                </div>
              </div>

              {/* Multi-select action bar */}
              {selCount > 0 && (
                <div style={{ padding: "10px 20px", background: "rgba(124,58,237,0.05)", borderBottom: "1px solid rgba(124,58,237,0.15)", flexShrink: 0, display: "flex", alignItems: "center", gap: 10 }}>
                  <input type="checkbox" checked readOnly style={{ accentColor: "#7C3AED", width: 14, height: 14 }}/>
                  <span style={{ fontSize: "13px", fontWeight: 700, color: "#7C3AED" }}>{tr("productLibrary.selection.selected" as MessageKey).replace("{n}", String(selCount))}</span>
                  <button type="button" onClick={addSelectedToBasket}
                    style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 20, border: "none", background: "#7C3AED", color: "#fff", fontSize: "12px", fontWeight: 700, cursor: "pointer" }}>
                    <ShoppingBag style={{ width: 13, height: 13 }}/> {tr("productLibrary.selection.addToBasket" as MessageKey)}
                  </button>
                  <button type="button" onClick={createSetFromSelected}
                    style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 20, border: "1px solid #E5E7EB", background: "#fff", color: "#374151", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
                    <FolderOpen style={{ width: 13, height: 13 }}/> {tr("productLibrary.selection.createProductSet" as MessageKey)}
                  </button>
                  <button type="button" onClick={() => setSelectedIds(new Set())}
                    style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", fontSize: "12px", color: "#94A3B8", fontWeight: 600 }}>
                    {tr("productLibrary.selection.clear" as MessageKey)}
                  </button>
                </div>
              )}

              {/* Product grid area */}
              <div style={{ flex: 1, overflowY: "auto", padding: "20px 20px 100px" }}>
                {/* Section header */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <p style={{ margin: 0, fontSize: "15px", fontWeight: 800, color: "#0F172A" }}>
                      {activeCollection ?? tr("productLibrary.sidebar.allProducts" as MessageKey)}
                    </p>
                    <span style={{ fontSize: "12px", color: "#94A3B8" }}>{filteredProducts.length} {tr("productLibrary.grid.productsCountSuffix" as MessageKey)}</span>
                  </div>
                </div>

                {filteredProducts.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "60px 0" }}>
                    <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#F1F5F9", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
                      <ShoppingBag style={{ width: 28, height: 28, color: "#CBD5E1" }}/>
                    </div>
                    <p style={{ margin: "0 0 6px", fontSize: "15px", fontWeight: 700, color: "#374151" }}>{tr("productLibrary.grid.emptyTitle" as MessageKey)}</p>
                    <p style={{ margin: "0 0 20px", fontSize: "12px", color: "#94A3B8" }}>{tr("productLibrary.grid.emptySub" as MessageKey)}</p>
                    <button type="button" onClick={() => setShowUploadDialog(true)}
                      style={{ padding: "10px 24px", borderRadius: 30, border: "none", background: "linear-gradient(135deg,#FF4D8D,#7C3AED)", color: "#fff", fontSize: "13px", fontWeight: 700, cursor: "pointer" }}>
                      {tr("productLibrary.grid.uploadFirstProduct" as MessageKey)}
                    </button>
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12 }}>
                    {filteredProducts.map(p => (
                      <ProductCard
                        key={p.id} product={p}
                        selected={selectedIds.has(p.id)}
                        onToggle={() => toggleProduct(p.id)}
                        onRemove={() => lib.removeProduct(p.id)}
                        inBasket={basketProductIds.has(p.id)}
                      />
                    ))}
                  </div>
                )}

                {/* Product Sets */}
                {sets.length > 0 && (
                  <div style={{ marginTop: 36 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                      <div>
                        <p style={{ margin: 0, fontSize: "15px", fontWeight: 800, color: "#0F172A" }}>{tr("productLibrary.sets.title" as MessageKey)}</p>
                        <p style={{ margin: "3px 0 0", fontSize: "11px", color: "#94A3B8" }}>{tr("productLibrary.sets.subtitle" as MessageKey)}</p>
                      </div>
                      <button type="button" style={{ fontSize: "11px", color: "#7C3AED", fontWeight: 600, background: "none", border: "none", cursor: "pointer" }}>{tr("productLibrary.sets.viewAll" as MessageKey)}</button>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
                      {sets.map(set => (
                        <SetCard key={set.id} set={set} products={products} onDelete={() => lib.deleteSet(set.id)}/>
                      ))}
                      {/* Create new set CTA */}
                      <button type="button" onClick={() => { if (selCount > 0) createSetFromSelected(); else toast.info(tr("productLibrary.toast.selectProductsToCreateSet" as MessageKey)); }}
                        style={{ borderRadius: 12, border: "1.5px dashed #E5E7EB", background: "#FAFAFA", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 120, cursor: "pointer" }}>
                        <Plus style={{ width: 20, height: 20, color: "#7C3AED" }}/>
                        <span style={{ fontSize: "12px", fontWeight: 700, color: "#7C3AED" }}>{tr("productLibrary.sets.createNewSet" as MessageKey)}</span>
                        <span style={{ fontSize: "10px", color: "#94A3B8" }}>{tr("productLibrary.sets.createNewSetHint" as MessageKey)}</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── REFERENCES TAB ── */}
          {activeTab === "references" && (
            <>
              {/* Toolbar */}
              <div style={{ padding: "12px 20px", background: "#fff", borderBottom: "1px solid #F1F5F9", flexShrink: 0, display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ position: "relative", flexShrink: 0 }}>
                  <Search style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", width: 13, height: 13, color: "#94A3B8", pointerEvents: "none" }}/>
                  <input placeholder={tr("productLibrary.references.searchPlaceholder" as MessageKey)}
                    style={{ paddingLeft: 32, paddingRight: 12, paddingTop: 8, paddingBottom: 8, borderRadius: 9, border: "1px solid #E5E7EB", fontSize: "12px", color: "#374151", outline: "none", background: "#FAFAFA", width: 200, boxSizing: "border-box" }}/>
                </div>
                <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexShrink: 0 }}>
                  <button type="button" onClick={() => refFileRef.current?.click()}
                    style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 9, border: "none", background: "linear-gradient(135deg,#FF4D8D,#7C3AED)", fontSize: "12px", fontWeight: 700, color: "#fff", cursor: "pointer" }}>
                    <Upload style={{ width: 13, height: 13 }}/> {tr("productLibrary.references.uploadReference" as MessageKey)}
                  </button>
                </div>
                <input ref={refFileRef} type="file" accept="image/*" className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) void uploadReference(f); }}/>
              </div>

              {/* Multi-select action bar */}
              {selRefCount > 0 && (
                <div style={{ padding: "10px 20px", background: "rgba(124,58,237,0.05)", borderBottom: "1px solid rgba(124,58,237,0.15)", flexShrink: 0, display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: "13px", fontWeight: 700, color: "#7C3AED" }}>{tr("productLibrary.selection.selected" as MessageKey).replace("{n}", String(selRefCount))}</span>
                  <button type="button" onClick={addSelectedRefsToBasket}
                    style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 20, border: "none", background: "#7C3AED", color: "#fff", fontSize: "12px", fontWeight: 700, cursor: "pointer" }}>
                    <ShoppingBag style={{ width: 13, height: 13 }}/> {tr("productLibrary.selection.addToBasket" as MessageKey)}
                  </button>
                  <button type="button" onClick={() => setSelectedRefIds(new Set())}
                    style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", fontSize: "12px", color: "#94A3B8", fontWeight: 600 }}>
                    {tr("productLibrary.selection.clear" as MessageKey)}
                  </button>
                </div>
              )}

              {/* Reference grid */}
              <div style={{ flex: 1, overflowY: "auto", padding: "20px 20px 100px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                  <p style={{ margin: 0, fontSize: "15px", fontWeight: 800, color: "#0F172A" }}>{tr("productLibrary.references.savedReferences" as MessageKey)}</p>
                  <span style={{ fontSize: "12px", color: "#94A3B8" }}>{references.length} {tr("productLibrary.references.pinsCountSuffix" as MessageKey)}</span>
                </div>

                {references.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "60px 0" }}>
                    <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#F1F5F9", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
                      <BookmarkPlus style={{ width: 28, height: 28, color: "#CBD5E1" }}/>
                    </div>
                    <p style={{ margin: "0 0 6px", fontSize: "15px", fontWeight: 700, color: "#374151" }}>{tr("productLibrary.references.emptyTitle" as MessageKey)}</p>
                    <p style={{ margin: "0 0 8px", fontSize: "12px", color: "#94A3B8" }}>{tr("productLibrary.references.emptySub" as MessageKey)}</p>
                    <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                      <button type="button" onClick={() => router.push("/app/discover")}
                        style={{ padding: "9px 18px", borderRadius: 20, border: "1px solid #E5E7EB", background: "#fff", fontSize: "12px", fontWeight: 600, color: "#374151", cursor: "pointer" }}>
                        {tr("productLibrary.references.browseViralPins" as MessageKey)}
                      </button>
                      <button type="button" onClick={() => refFileRef.current?.click()}
                        style={{ padding: "9px 18px", borderRadius: 20, border: "none", background: "linear-gradient(135deg,#FF4D8D,#7C3AED)", color: "#fff", fontSize: "12px", fontWeight: 700, cursor: "pointer" }}>
                        {tr("productLibrary.references.uploadReference" as MessageKey)}
                      </button>
                    </div>
                    <input ref={refFileRef} type="file" accept="image/*" className="hidden"
                      onChange={e => { const f = e.target.files?.[0]; if (f) void uploadReference(f); }}/>
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 12 }}>
                    {references.map(r => (
                      <ReferenceCard
                        key={r.id} ref={r}
                        selected={selectedRefIds.has(r.id)}
                        onToggle={() => toggleRef(r.id)}
                        onRemove={() => lib.removeReference(r.id)}
                        inBasket={basketReferenceIds.has(r.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Sticky bottom bar when basket has items ── */}
      {totalCount > 0 && (
        <div style={{
          position: "fixed", bottom: 0, left: 220, right: 0, zIndex: 100,
          padding: "12px 24px", background: "#fff", borderTop: "1px solid #E5E7EB",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          boxShadow: "0 -4px 24px rgba(0,0,0,0.08)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <ShoppingBag style={{ width: 16, height: 16, color: "#7C3AED" }}/>
            <span style={{ fontSize: "13px", fontWeight: 700, color: "#0F172A" }}>{tr("productLibrary.basketBar.createBasket" as MessageKey)}</span>
            <div style={{ display: "flex", gap: 8 }}>
              {basketState.products.length > 0 && (
                <span style={{ fontSize: "11px", color: "#7C3AED", fontWeight: 600, background: "rgba(124,58,237,0.08)", padding: "2px 10px", borderRadius: 20 }}>
                  {basketState.products.length} {basketState.products.length !== 1 ? tr("productLibrary.basketBar.products" as MessageKey) : tr("productLibrary.basketBar.product" as MessageKey)}
                </span>
              )}
              {basketState.references.length > 0 && (
                <span style={{ fontSize: "11px", color: "#2563EB", fontWeight: 600, background: "rgba(37,99,235,0.08)", padding: "2px 10px", borderRadius: 20 }}>
                  {basketState.references.length} {basketState.references.length !== 1 ? tr("productLibrary.basketBar.references" as MessageKey) : tr("productLibrary.basketBar.reference" as MessageKey)}
                </span>
              )}
              {basketState.opportunities.length > 0 && (
                <span style={{ fontSize: "11px", color: "#059669", fontWeight: 600, background: "rgba(5,150,105,0.08)", padding: "2px 10px", borderRadius: 20 }}>
                  {basketState.opportunities[0].keyword}
                </span>
              )}
            </div>
            <button type="button" onClick={() => basket.clearBasket()}
              style={{ background: "none", border: "none", cursor: "pointer", fontSize: "11px", color: "#94A3B8", fontWeight: 500 }}>
              {tr("productLibrary.basketBar.clear" as MessageKey)}
            </button>
          </div>
          <button type="button" onClick={() => router.push("/app/studio?fromBasket=1")}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 24px", borderRadius: 30, border: "none", background: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)", color: "#fff", fontSize: "13px", fontWeight: 800, cursor: "pointer" }}>
            <Sparkles style={{ width: 15, height: 15 }}/>
            {tr("productLibrary.basketBar.createPinsWithBasket" as MessageKey).replace("{n}", String(totalCount))}
          </button>
        </div>
      )}

      {/* ── Dialogs ── */}
      {showUploadDialog && (
        <UploadProductDialog
          collections={collections}
          onClose={() => setShowUploadDialog(false)}
          onSave={p => { lib.addProduct(p); toast.success(tr("productLibrary.toast.productSaved" as MessageKey)); }}
        />
      )}
      {showNewCollection && (
        <NewCollectionDialog
          onClose={() => setShowNewCollection(false)}
          onSave={name => { lib.addCollection(name); toast.success(`${tr("productLibrary.toast.collectionCreatedPrefix" as MessageKey)}${name}${tr("productLibrary.toast.collectionCreatedSuffix" as MessageKey)}`); }}
        />
      )}
    </div>
  );
}
