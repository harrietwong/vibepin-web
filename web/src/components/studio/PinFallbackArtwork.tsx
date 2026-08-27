"use client";

import { Image as ImageIcon, Sparkles } from "lucide-react";

/**
 * Branded, non-blank media fallback used whenever a Pin image is missing or cannot
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
        background: "linear-gradient(145deg, #20113b 0%, #53258b 44%, #e644b5 100%)",
        color: "#fff",
      }}
    >
      <span style={{ position: "absolute", width: "74%", aspectRatio: "1", borderRadius: "50%", left: "-28%", top: "-22%", background: "rgba(255,255,255,.13)" }} />
      <span style={{ position: "absolute", width: "54%", aspectRatio: "1", borderRadius: "50%", right: "-18%", bottom: "-15%", background: "rgba(255,255,255,.12)" }} />
      <span style={{ position: "absolute", inset: "12%", border: "1px solid rgba(255,255,255,.18)", borderRadius: compact ? 8 : 18, transform: "rotate(-4deg)" }} />
      <span style={{ position: "relative", width: compact ? 28 : 54, height: compact ? 28 : 54, borderRadius: compact ? 8 : 16, display: "grid", placeItems: "center", background: "rgba(255,255,255,.16)", border: "1px solid rgba(255,255,255,.26)", boxShadow: "0 12px 30px rgba(27,8,53,.28)", backdropFilter: "blur(8px)" }}>
        {busy ? <Sparkles style={{ width: compact ? 15 : 25, height: compact ? 15 : 25 }} /> : <ImageIcon style={{ width: compact ? 15 : 25, height: compact ? 15 : 25 }} />}
      </span>
      {busy && !compact && (
        <span style={{ position: "absolute", bottom: 18, fontSize: 10.5, fontWeight: 750, letterSpacing: ".01em", color: "rgba(255,255,255,.9)" }}>
          Creating preview…
        </span>
      )}
      <span style={{ position: "absolute", width: 7, height: 7, borderRadius: 999, right: compact ? 7 : 18, top: compact ? 7 : 18, background: "#ff4fbd", boxShadow: "0 0 0 4px rgba(255,255,255,.14)" }} />
    </div>
  );
}
