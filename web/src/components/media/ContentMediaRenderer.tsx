"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import type { ContentImageMedia, ContentMedia } from "@/lib/contentDraftModel";
import { NeutralMediaFallback, ResilientMediaImage } from "./ResilientMediaImage";

type Props = {
  media: ContentMedia | null | undefined;
  alt?: string;
  className?: string;
  style?: CSSProperties;
  loading?: "eager" | "lazy";
  imageTestId?: string;
  fallback?: ReactNode;
  /** Interactive video players are inappropriate inside parent buttons/links. */
  videoControls?: boolean;
  /** Lets image-only surfaces keep their established loading/recovery behavior. */
  renderImage?: (media: ContentImageMedia) => ReactNode;
};

/** Stable resource identity; changing it must create a fresh load/error lifecycle. */
export function mediaIdentity(media: Pick<ContentMedia, "id" | "url">): string {
  return `${media.id}:${media.url}`;
}

/** Parent cards activate on click, Enter, and Space only; Escape/Tab must bubble. */
export function isMediaActivationKey(key: string): boolean {
  return key === "Enter" || key === " ";
}

/**
 * Let dismiss and focus-navigation keys reach the surrounding drawer or link.
 * The native video UI only needs to be insulated from an ancestor's activation
 * handler for pointer clicks and keyboard activation.
 */
export function stopMediaActivation(event: { type: string; key?: string; stopPropagation: () => void }): void {
  if (event.type === "click" || (event.type === "keydown" && isMediaActivationKey(event.key || ""))) {
    event.stopPropagation();
  }
}

function MediaFallback({ media, failed, style, fallback }: Pick<Props, "media" | "style" | "fallback"> & { failed: boolean }) {
  const error = media?.kind === "video" && failed ? "Video preview could not be loaded." : "Media unavailable";
  return <div role="status" aria-live="polite" style={{ width: "100%", height: "100%", position: "relative" }}>
    {fallback ?? (
      <NeutralMediaFallback testId="content-media-fallback" label={error}
        style={{ fontSize: 12, ...style }} />
    )}
    {media?.kind === "video" && failed && fallback && <span data-testid="content-media-error"
      style={{ position: "absolute", left: 6, right: 6, bottom: 6, padding: "4px 6px", borderRadius: 4, background: "var(--app-surface, #161D2E)", color: "var(--app-text, #E2E8F0)", fontSize: 12, lineHeight: 1.3 }}>{error}</span>}
  </div>;
}

/** Shared display boundary: protected video URLs only ever reach a video element. */
export function ContentMediaRenderer({ media, ...props }: Props) {
  if (!media || !media.url.trim()) return <MediaFallback media={media} failed={false} style={props.style} fallback={props.fallback} />;
  // The keyed child deliberately discards a prior error when A → B → A changes media.
  return <MediaResource key={mediaIdentity(media)} media={media} {...props} />;
}

function MediaResource({ media, alt = "", className, style, loading = "lazy", imageTestId, fallback, videoControls = true, renderImage }: Omit<Props, "media"> & { media: ContentMedia }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <MediaFallback media={media} failed style={style} fallback={fallback} />;
  if (media.kind === "video") {
    return (
      <span data-content-media-controls={videoControls ? "true" : undefined} style={{ width: "100%", height: "100%", display: "block" }}
        onClick={videoControls ? stopMediaActivation : undefined} onKeyDown={videoControls ? stopMediaActivation : undefined}>
        <video data-testid="content-media-video" src={media.url} controls={videoControls} muted playsInline preload="metadata"
          poster={media.posterUrl} aria-label={alt || "Video preview"} tabIndex={videoControls ? undefined : -1}
          onError={() => setFailed(true)} className={className}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", ...style }} />
      </span>
    );
  }
  if (renderImage) return <>{renderImage(media)}</>;
  return <ResilientMediaImage
    src={media.url}
    alt={alt}
    loading={loading}
    imageTestId={imageTestId}
    className={className}
    candidate={media}
    fallback={fallback ?? <MediaFallback media={media} failed style={style} />}
    style={{ width: "100%", height: "100%", objectFit: "cover", ...style }}
  />;
}
