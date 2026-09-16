"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import type { ContentMedia } from "@/lib/contentDraftModel";
import { toProxyUrl } from "@/lib/imageProxy";

type Props = {
  media: ContentMedia | null | undefined;
  alt?: string;
  className?: string;
  style?: CSSProperties;
  loading?: "eager" | "lazy";
  imageTestId?: string;
  fallback?: ReactNode;
};

/** Shared display boundary: protected video URLs only ever reach a video element. */
export function ContentMediaRenderer({ media, alt = "", className, style, loading = "lazy", imageTestId, fallback }: Props) {
  const [failed, setFailed] = useState(false);
  if (!media || failed || !media.url.trim()) {
    return fallback ?? (
      <div data-testid="content-media-fallback" role="status" aria-live="polite"
        style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", background: "var(--app-surface-3, #0f172a)", color: "var(--app-text-muted, #94a3b8)", fontSize: 11, ...style }}>
        {media?.kind === "video" ? "Video preview could not be loaded." : "Media unavailable"}
      </div>
    );
  }
  if (media.kind === "video") {
    return (
      <>
        <video data-testid="content-media-video" src={media.url} controls muted playsInline preload="metadata"
          poster={media.posterUrl} aria-label={alt || "Video preview"} onError={() => setFailed(true)} className={className}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", ...style }} />
        <span className="sr-only" aria-live="polite">{failed ? "Video preview could not be loaded." : ""}</span>
      </>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img data-testid={imageTestId} src={toProxyUrl(media.url)} alt={alt} loading={loading} onError={() => setFailed(true)} className={className}
      style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", ...style }} />
  );
}
