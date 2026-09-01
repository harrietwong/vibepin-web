"use client";

import { Image as ImageIcon, Sparkles } from "lucide-react";
import { BUI } from "@/components/studio/boardUI";

/**
 * Neutral, non-blank media fallback used whenever a Pin image is missing or cannot
 * be decoded. It intentionally contains no "No image" copy: the artwork keeps the
 * card scannable while the surrounding failure message explains what to do next.
 */
export function PinFallbackArtwork({ compact = false, busy = false }: { compact?: boolean; busy?: boolean }) {
  return (
    <div
      data-testid="pin-fallback-artwork"
      aria-label={busy ? "Preparing image preview" : "Image preview unavailable"}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: compact ? 56 : 120,
        overflow: "hidden",
        display: "grid",
        placeItems: "center",
        background: BUI.mediaFallback,
        border: `1px solid ${BUI.mediaFallbackBorder}`,
        color: BUI.mediaFallbackIcon,
      }}
    >
      <span className={busy ? "animate-pulse" : undefined}
        style={{ position: "relative", width: compact ? 28 : 48, height: compact ? 28 : 48, borderRadius: compact ? 8 : 14, display: "grid", placeItems: "center", background: "rgba(255,255,255,.045)", border: `1px solid ${BUI.mediaFallbackBorder}` }}>
        {busy ? <Sparkles style={{ width: compact ? 15 : 25, height: compact ? 15 : 25 }} /> : <ImageIcon style={{ width: compact ? 15 : 25, height: compact ? 15 : 25 }} />}
      </span>
      {busy && !compact && (
        <span style={{ position: "absolute", bottom: 18, fontSize: 10.5, fontWeight: 700, letterSpacing: ".01em", color: BUI.mediaFallbackText }}>
          Creating preview…
        </span>
      )}
    </div>
  );
}
