"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import type { ContentImageMedia, ContentMedia } from "@/lib/contentDraftModel";
import { toProxyUrl } from "@/lib/imageProxy";

type Props = {
  media: ContentMedia | null | undefined;
  alt?: string;
  className?: string;
  style?: CSSProperties;
  loading?: "eager" | "lazy";
  imageTestId?: string;
  fallback?: ReactNode;
  /** Lets image-only surfaces keep their established loading/recovery behavior. */
  renderImage?: (media: ContentImageMedia) => ReactNode;
};

/** Shared display boundary: protected video URLs only ever reach a video element. */
export function ContentMediaRenderer({ media, alt = "", className, style, loading = "lazy", imageTestId, fallback, renderImage }: Props) {
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
      {media?.kind === "video" && failed && <span data-testid="content-media-error" role="status" aria-live="polite"
        style={{ position: "absolute", left: 6, right: 6, bottom: 6, padding: "4px 6px", borderRadius: 4, background: "var(--app-surface, #161D2E)", color: "var(--app-text, #E2E8F0)", fontSize: 12, lineHeight: 1.3 }}>{error}</span>}
    </div>;
  }
  if (media.kind === "video") {
    const stopMediaInteraction = (event: React.SyntheticEvent) => event.stopPropagation();
    return (
      <span data-content-media-controls="true" style={{ width: "100%", height: "100%", display: "block" }}
        onClick={stopMediaInteraction} onPointerDown={stopMediaInteraction} onKeyDown={stopMediaInteraction}>
        <video data-testid="content-media-video" src={media.url} controls muted playsInline preload="metadata"
          poster={media.posterUrl} aria-label={alt || "Video preview"} onError={fail} className={className}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", ...style }} />
      </span>
    );
  }
  if (renderImage) return <>{renderImage(media)}</>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img data-testid={imageTestId} src={toProxyUrl(media.url)} alt={alt} loading={loading} onError={fail} className={className}
      style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", ...style }} />
  );
}
