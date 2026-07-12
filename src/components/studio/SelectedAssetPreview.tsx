"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { toProxyUrl } from "@/lib/imageProxy";

export type SelectedAssetPreviewItem = {
  imageUrl: string;
  title?: string | null;
  source?: string | null;
  sourceDomain?: string | null;
};

type PreviewKind = "product" | "reference";

type Props = {
  item: SelectedAssetPreviewItem;
  items?: SelectedAssetPreviewItem[];
  index?: number;
  kind: PreviewKind;
  thumbnailSize?: number;
  imageStyle?: CSSProperties;
  testId?: string;
};

const Z = 10000;

function labelFor(kind: PreviewKind, index: number, total: number) {
  const noun = kind === "product" ? "Product" : "Reference";
  return `${noun} ${index + 1} of ${Math.max(total, 1)}`;
}

function assetSource(item: SelectedAssetPreviewItem): string {
  return item.sourceDomain || item.source || "";
}

function clampPopoverPosition(rect: DOMRect) {
  const margin = 12;
  const width = 220;
  const height = 326;
  let left = rect.right + 10;
  if (left + width + margin > window.innerWidth) left = rect.left - width - 10;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));

  let top = rect.top + rect.height / 2 - height / 2;
  top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
  return { left, top };
}

export function SelectedAssetPreview({
  item,
  items,
  index = 0,
  kind,
  thumbnailSize = 42,
  imageStyle,
  testId = "selected-asset-thumbnail",
}: Props) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const allItems = useMemo(() => (items?.length ? items : [item]), [items, item]);
  const total = allItems.length;

  useEffect(() => {
    if (!galleryOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setGalleryOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [galleryOpen]);

  function clearCloseTimer() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }

  function openHover() {
    clearCloseTimer();
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setPos(clampPopoverPosition(rect));
    setHoverOpen(true);
  }

  function scheduleClose() {
    clearCloseTimer();
    closeTimer.current = setTimeout(() => setHoverOpen(false), 120);
  }

  const metaTitle = item.title?.trim();
  const metaSource = assetSource(item);

  const canPortal = typeof document !== "undefined";

  const hoverPreview = canPortal && hoverOpen ? createPortal(
    <div
      data-testid="selected-asset-hover-preview"
      onMouseEnter={clearCloseTimer}
      onMouseLeave={scheduleClose}
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        zIndex: Z,
        width: 220,
        padding: 10,
        borderRadius: 10,
        background: "var(--app-surface-3, #111827)",
        border: "1px solid var(--app-border-hi, rgba(255,255,255,0.16))",
        boxShadow: "0 18px 48px rgba(0,0,0,0.45)",
        pointerEvents: "auto",
      }}
    >
      <div style={{ width: "100%", maxHeight: 280, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", borderRadius: 8, background: "rgba(255,255,255,0.04)" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={toProxyUrl(item.imageUrl)} alt="" style={{ maxWidth: "100%", maxHeight: 280, width: "auto", height: "auto", objectFit: "contain", display: "block" }} />
      </div>
      <p style={{ margin: "8px 0 0", fontSize: 11, fontWeight: 800, color: "var(--app-text, #E2E8F0)" }}>
        {labelFor(kind, index, total)}
      </p>
      {metaTitle && (
        <p style={{ margin: "2px 0 0", fontSize: 10.5, lineHeight: 1.35, color: "var(--app-text-sec, #94A3B8)" }}>
          {metaTitle}
        </p>
      )}
      {metaSource && (
        <p style={{ margin: "2px 0 0", fontSize: 10, color: "var(--app-text-muted, #64748B)" }}>
          {metaSource}
        </p>
      )}
    </div>,
    document.body,
  ) : null;

  const gallery = canPortal && galleryOpen ? createPortal(
    <div
      data-testid="selected-asset-gallery"
      role="dialog"
      aria-modal="true"
      onMouseDown={() => setGalleryOpen(false)}
      style={{ position: "fixed", inset: 0, zIndex: Z + 1, background: "rgba(2,6,23,0.62)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
    >
      <div
        onMouseDown={e => e.stopPropagation()}
        style={{
          width: "min(680px, calc(100vw - 48px))",
          maxHeight: "min(720px, calc(100vh - 48px))",
          overflow: "auto",
          borderRadius: 12,
          background: "var(--app-surface, #161D2E)",
          border: "1px solid var(--app-border-hi, rgba(255,255,255,0.16))",
          boxShadow: "0 24px 72px rgba(0,0,0,0.5)",
          padding: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 900, color: "var(--app-text, #E2E8F0)" }}>
            Selected {kind === "product" ? "Products" : "References"}
          </p>
          <button type="button" aria-label="Close preview" onClick={() => setGalleryOpen(false)}
            style={{ width: 34, height: 34, borderRadius: 8, border: "1px solid var(--app-border, rgba(255,255,255,0.1))", background: "transparent", color: "var(--app-text-sec, #94A3B8)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <X style={{ width: 16, height: 16 }} />
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(128px, 1fr))", gap: 12 }}>
          {allItems.map((galleryItem, galleryIndex) => (
            <div key={`${galleryItem.imageUrl}-${galleryIndex}`} style={{ minWidth: 0 }}>
              <div style={{ height: 180, borderRadius: 9, background: "rgba(255,255,255,0.04)", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--app-border, rgba(255,255,255,0.08))" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={toProxyUrl(galleryItem.imageUrl)} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" }} />
              </div>
              <p style={{ margin: "7px 0 0", fontSize: 11, fontWeight: 800, color: "var(--app-text, #E2E8F0)" }}>
                {labelFor(kind, galleryIndex, total)}
              </p>
              {(galleryItem.title || assetSource(galleryItem)) && (
                <p style={{ margin: "2px 0 0", fontSize: 10.5, lineHeight: 1.35, color: "var(--app-text-sec, #94A3B8)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {galleryItem.title || assetSource(galleryItem)}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid={testId}
        aria-label={`Preview ${labelFor(kind, index, total)}`}
        onMouseEnter={openHover}
        onMouseLeave={scheduleClose}
        onFocus={openHover}
        onBlur={scheduleClose}
        onClick={e => {
          e.stopPropagation();
          setGalleryOpen(true);
        }}
        style={{
          width: thumbnailSize,
          height: thumbnailSize,
          padding: 0,
          borderRadius: 7,
          overflow: "hidden",
          border: "1px solid var(--app-border-hi, rgba(255,255,255,0.16))",
          background: "var(--app-surface-3, #111827)",
          cursor: "zoom-in",
          display: "block",
          flexShrink: 0,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={toProxyUrl(item.imageUrl)}
          alt=""
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", ...imageStyle }}
        />
      </button>
      {hoverPreview}
      {gallery}
    </>
  );
}
