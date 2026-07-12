"use client";

import { useEffect, useState, type CSSProperties } from "react";

export type PinThumbnailProps = {
  /** Already-resolved image URL (caller applies toProxyUrl / toThumbUrl). */
  src: string;
  alt?: string;
  /** `lazy` for below-the-fold thumbnails, `eager` for first-screen tiles. */
  loading?: "lazy" | "eager";
  objectFit?: CSSProperties["objectFit"];
  /** Extra styles merged onto the fill wrapper. */
  style?: CSSProperties;
  /** Test id applied to the <img> element (keeps existing selectors working). */
  imgTestId?: string;
  /** Force an always-dark placeholder/fallback (for the hardcoded-dark hover card),
   *  so the skeleton is never a near-white box in light theme. */
  dark?: boolean;
};

/**
 * Shared Pin thumbnail used across Weekly Plan (Week + Month), Unscheduled list,
 * Day Detail and the added-needs-date grid.
 *
 * Behaviour:
 *  - Fills its parent (the parent owns the stable, portrait dimensions), so the
 *    layout never jumps and there is no blank collapse on error.
 *  - Shows a subtle theme-aware shimmer skeleton until the image loads.
 *  - `decoding="async"` + configurable `loading` so off-screen thumbnails defer.
 *  - Clean fallback tile on error (does NOT collapse the container).
 *  - Load state is keyed on `src`, so selection/hover re-renders never remount
 *    the <img> or trigger a reload — only a genuine src change resets it.
 *
 * The parent MUST be `position: relative` (all current call sites already are).
 */
export function PinThumbnail({
  src,
  alt = "",
  loading = "lazy",
  objectFit = "cover",
  style,
  imgTestId,
  dark = false,
}: PinThumbnailProps) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");

  // Reset only when the actual source changes — not on selection/hover.
  useEffect(() => {
    setStatus("loading");
  }, [src]);

  return (
    <span
      data-testid="pin-thumbnail"
      style={{
        position: "absolute", inset: 0, overflow: "hidden", display: "block",
        // Dark base color paints immediately (before skeleton/img), guaranteeing the
        // hover card never flashes a white rectangle on the very first frame.
        background: dark ? "#0f172a" : undefined,
        ...style,
      }}
    >
      {status !== "loaded" && (
        <span
          aria-hidden="true"
          data-testid="pin-thumbnail-skeleton"
          className={status === "loading" ? (dark ? "pin-thumb-skeleton pin-thumb-skeleton--dark" : "pin-thumb-skeleton") : undefined}
          style={{
            position: "absolute",
            inset: 0,
            background: status === "error" ? (dark ? "#0f172a" : "var(--app-surface-2)") : undefined,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {status === "error" && (
            <span
              data-testid="pin-thumbnail-fallback"
              aria-hidden="true"
              style={{ fontSize: 16, opacity: 0.45, color: dark ? "#94a3b8" : "var(--app-text-muted)" }}
            >
              🖼
            </span>
          )}
        </span>
      )}
      {status !== "error" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          loading={loading}
          decoding="async"
          draggable={false}
          data-testid={imgTestId}
          onLoad={() => setStatus("loaded")}
          onError={() => setStatus("error")}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit,
            display: "block",
            opacity: status === "loaded" ? 1 : 0,
            transition: "opacity 0.2s ease",
          }}
        />
      )}
    </span>
  );
}
