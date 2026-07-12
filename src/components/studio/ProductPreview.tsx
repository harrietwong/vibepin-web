"use client";

import { useRef, useState } from "react";
import { Maximize2, X, ZoomIn, ZoomOut } from "lucide-react";
import type { PreviewProduct } from "@/lib/studio/productPreview";

const C = {
  bg2:       "var(--app-surface-2, #111827)",
  cardElev:  "var(--app-surface-3, #1A2236)",
  border:    "var(--app-border, rgba(255,255,255,0.09))",
  borderStr: "var(--app-border-hi, rgba(255,255,255,0.14))",
  text:      "var(--app-text, #E5E7EB)",
  textSec:   "var(--app-text-sec, #9CA3AF)",
  muted:     "var(--app-text-muted, #64748B)",
  gradient:  "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
} as const;

function sourceChipStyle(label: string): React.CSSProperties {
  const amazon = label === "Amazon";
  return {
    fontSize: 9, fontWeight: 900, padding: "2px 7px", borderRadius: 999, letterSpacing: "0.02em",
    background: amazon ? "rgba(255,153,0,0.95)" : "rgba(124,58,237,0.18)",
    color: amazon ? "#1A2235" : "#C4B5FD",
  };
}

function PreviewBody({ product, large }: { product: PreviewProduct; large?: boolean }) {
  return (
    <>
      <p data-testid="product-preview-title" style={{ margin: "0 0 6px", fontSize: large ? 14 : 12.5, fontWeight: 800, color: C.text, lineHeight: 1.35 }}>
        {product.title}
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span data-testid="product-preview-source" style={sourceChipStyle(product.sourceLabel)}>{product.sourceLabel}</span>
        {product.asin && (
          <span data-testid="product-preview-asin" style={{ fontSize: 10, fontWeight: 700, color: C.muted }}>
            ASIN {product.asin}
          </span>
        )}
      </div>
    </>
  );
}

/** Full-screen click preview with a zoomable image + "Use this product". */
export function ProductPreviewModal({ product, onUse, onClose }: {
  product: PreviewProduct;
  onUse: () => void;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(false);
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 600 }} />
      <div data-testid="product-preview-modal" onClick={e => e.stopPropagation()} style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 601,
        width: 560, maxWidth: "94vw", maxHeight: "90vh", background: C.bg2, borderRadius: 16,
        border: `1px solid ${C.borderStr}`, boxShadow: "0 24px 60px rgba(0,0,0,0.8)", overflow: "hidden",
        display: "flex", flexDirection: "column",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: C.textSec }}>Product preview</span>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" data-testid="product-preview-modal-zoom" title={zoom ? "Zoom out" : "Zoom in"} onClick={() => setZoom(z => !z)}
              style={{ background: "none", border: "none", color: C.textSec, cursor: "pointer", padding: 4 }}>
              {zoom ? <ZoomOut style={{ width: 16, height: 16 }} /> : <ZoomIn style={{ width: 16, height: 16 }} />}
            </button>
            <button type="button" data-testid="product-preview-modal-close" onClick={onClose}
              style={{ background: "none", border: "none", color: C.textSec, cursor: "pointer", padding: 4 }}>
              <X style={{ width: 16, height: 16 }} />
            </button>
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", background: "var(--app-bg, #0B1020)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          {product.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img data-testid="product-preview-modal-image" src={product.imageUrl} alt={product.title}
              onClick={() => setZoom(z => !z)}
              style={{ maxWidth: zoom ? "none" : "100%", width: zoom ? "180%" : "auto", maxHeight: zoom ? "none" : "56vh", objectFit: "contain", cursor: zoom ? "zoom-out" : "zoom-in", transition: "width 0.15s ease" }} />
          ) : (
            <div style={{ width: 300, height: 300, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 12 }}>No image</div>
          )}
        </div>
        <div style={{ padding: "12px 16px", borderTop: `1px solid ${C.border}` }}>
          <PreviewBody product={product} large />
          <button type="button" data-testid="product-preview-modal-use" onClick={onUse}
            style={{ marginTop: 12, width: "100%", padding: "11px 16px", borderRadius: 10, border: "none", background: C.gradient, color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>
            Use this product
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * Wraps a product card. On hover it shows a large image popover (title, source,
 * ASIN, "Use for Pins"). A zoom affordance opens the full click modal. Selection
 * is never required first — the wrapped card keeps its own click behavior.
 */
const POPOVER_W = 320;

export function ProductHoverPreview({ product, onUse, children }: {
  product: PreviewProduct;
  /** 1-step "Use for Pins" — selects this product and locks it into Create Pins. */
  onUse: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function place() {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    // Prefer the right; flip left when there isn't room. Fixed coords avoid
    // clipping by the picker's scroll container.
    const rightLeft = r.right + margin;
    const left = rightLeft + POPOVER_W <= window.innerWidth ? rightLeft : Math.max(margin, r.left - margin - POPOVER_W);
    const top = Math.min(Math.max(margin, r.top), Math.max(margin, window.innerHeight - 420));
    setPos({ left, top });
  }

  function show() { if (closeTimer.current) clearTimeout(closeTimer.current); place(); setOpen(true); }
  function hideSoon() { closeTimer.current = setTimeout(() => setOpen(false), 140); }

  return (
    <div ref={wrapRef} data-testid="product-preview-trigger" style={{ position: "relative" }}
      onMouseEnter={show} onMouseLeave={hideSoon}>
      {children}

      {open && (
        <div data-testid="product-preview-popover" onMouseEnter={show} onMouseLeave={hideSoon}
          // Fixed + flip so the popover is never clipped by the narrow picker panel.
          style={{
            position: "fixed", top: pos.top, left: pos.left, zIndex: 400, width: POPOVER_W,
            background: C.bg2, border: `1px solid ${C.borderStr}`, borderRadius: 14,
            boxShadow: "0 18px 48px rgba(0,0,0,0.6)", overflow: "hidden",
          }}>
          <div style={{ position: "relative", width: "100%", aspectRatio: "1 / 1", background: "var(--app-bg, #0B1020)" }}>
            {product.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img data-testid="product-preview-image" src={product.imageUrl} alt={product.title}
                style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 12 }}>No image</div>
            )}
            <button type="button" data-testid="product-preview-zoom" title="Open preview"
              onClick={e => { e.stopPropagation(); setModal(true); }}
              style={{ position: "absolute", top: 8, right: 8, width: 28, height: 28, borderRadius: 8, border: "none", background: "rgba(8,13,25,0.72)", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Maximize2 style={{ width: 14, height: 14 }} />
            </button>
          </div>
          <div style={{ padding: "12px 14px" }}>
            <PreviewBody product={product} />
            <button type="button" data-testid="product-preview-use"
              onClick={e => { e.stopPropagation(); onUse(); }}
              style={{ marginTop: 12, width: "100%", padding: "10px 14px", borderRadius: 10, border: "none", background: C.gradient, color: "#fff", fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}>
              Use for Pins
            </button>
          </div>
        </div>
      )}

      {modal && (
        <ProductPreviewModal product={product}
          onUse={() => { setModal(false); onUse(); }}
          onClose={() => setModal(false)} />
      )}
    </div>
  );
}
