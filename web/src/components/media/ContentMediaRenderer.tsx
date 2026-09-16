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
  const identity = media ? `${media.id}:${media.url}` : "";
  const [failure, setFailure] = useState({ identity, failed: false });
  const failed = failure.identity === identity && failure.failed;
  const fail = () => setFailure({ identity, failed: true });
  if (!media || failed || !media.url.trim()) {
    const error = media?.kind === "video" && failed ? "Video preview could not be loaded." : "Media unavailable";
    return <div role="status" aria-live="polite" style={{ width: "100%", height: "100%", position: "relative" }}>
      {fallback ?? (
      <div data-testid="content-media-fallback" role="status" aria-live="polite"
        style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", background: "var(--app-surface-3, #0f172a)", color: "var(--app-text-muted, #94a3b8)", fontSize: 12, ...style }}>{error}</div>)}
      <span className="sr-only">{error}</span>
    </div>;
  }
  if (media.kind === "video") {
    return (
      <>
        <video data-testid="content-media-video" src={media.url} controls muted playsInline preload="metadata"
          poster={media.posterUrl} aria-label={alt || "Video preview"} onError={fail} className={className}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", ...style }} />
      </>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img data-testid={imageTestId} src={toProxyUrl(media.url)} alt={alt} loading={loading} onError={fail} className={className}
      style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", ...style }} />
  );
}
