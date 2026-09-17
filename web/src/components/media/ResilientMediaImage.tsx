"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { ImageOff } from "lucide-react";
import { toProxyUrl } from "@/lib/imageProxy";
import { canonicalMediaUrl, inspectLoadedMedia, type LoadedMediaMetrics } from "@/lib/studio/failureMedia";
import { BUI } from "@/components/studio/boardUI";

export type ResilientMediaIdentityInput = {
  id?: string;
  url?: string;
  imageUrl?: string;
};

/** Stable resource identity. A changed URL gets a fresh load/error lifecycle. */
export function mediaIdentity(media: ResilientMediaIdentityInput): string {
  return `${media.id ?? ""}:${canonicalMediaUrl(media.url ?? media.imageUrl ?? "")}`;
}

export type MediaLoadState = "loading" | "loaded" | "failed";
export type MediaLoadEvent = "valid-load" | "invalid-load" | "decode-error" | "timeout" | "resource-change";

/** The image boundary's complete lifecycle, kept explicit so terminal load results
 * cannot be mistaken for an in-flight request by the timeout effect. */
export function reduceMediaLoadState(state: MediaLoadState, event: MediaLoadEvent): MediaLoadState {
  if (event === "resource-change") return "loading";
  if (state !== "loading") return state;
  return event === "valid-load" ? "loaded" : "failed";
}

export function shouldScheduleMediaLoadTimeout(state: MediaLoadState): boolean {
  return state === "loading";
}

type TimeoutScheduler = (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
type TimeoutCanceller = (timer: ReturnType<typeof setTimeout>) => void;

/** Own the timer cleanup at the same boundary that owns the image lifecycle. */
export function startMediaLoadTimeout(
  timeoutMs: number,
  onTimeout: () => void,
  schedule: TimeoutScheduler = setTimeout,
  cancel: TimeoutCanceller = clearTimeout,
): () => void {
  if (timeoutMs <= 0) return () => undefined;
  let active = true;
  const timer = schedule(() => {
    if (active) onTimeout();
  }, timeoutMs);
  return () => {
    active = false;
    cancel(timer);
  };
}

type Props = {
  src: string;
  alt?: string;
  className?: string;
  style?: CSSProperties;
  loading?: "eager" | "lazy";
  imageTestId?: string;
  fallback?: ReactNode;
  /** The persisted identity/provenance lets the loader reject known fixture media. */
  candidate?: Pick<LoadedMediaMetrics, "id" | "provenance" | "knownPlaceholder">;
  /** A stalled image must not leave a permanent blank media well. */
  timeoutMs?: number;
};

type NeutralMediaFallbackProps = {
  label: string;
  testId?: string;
  style?: CSSProperties;
};

/** One neutral media well for unavailable images in cards and asset previews. */
export function NeutralMediaFallback({ label, testId, style }: NeutralMediaFallbackProps) {
  return (
    <div data-testid={testId} role="img" aria-label={label}
      style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", background: BUI.mediaFallback,
        border: `1px solid ${BUI.mediaFallbackBorder}`, color: BUI.mediaFallbackIcon, ...style }}>
      <ImageOff style={{ width: 18, height: 18 }} aria-hidden="true" />
    </div>
  );
}

function DefaultFallback({ alt }: Pick<Props, "alt">) {
  return <NeutralMediaFallback testId="resilient-media-fallback" label={alt || "Media unavailable"} />;
}

function MediaResource({ src, alt = "", className, style, loading = "lazy", imageTestId, fallback, candidate, timeoutMs = 8_000 }: Props) {
  const [loadState, setLoadState] = useState<MediaLoadState>("loading");
  const failed = loadState === "failed";

  useEffect(() => {
    if (!shouldScheduleMediaLoadTimeout(loadState)) return;
    return startMediaLoadTimeout(timeoutMs, () => {
      setLoadState(current => reduceMediaLoadState(current, "timeout"));
    });
  }, [loadState, timeoutMs]);

  if (failed) {
    return <div data-testid="resilient-media-status" role="status" aria-live="polite" style={{ width: "100%", height: "100%" }}>
      {fallback ?? <DefaultFallback alt={alt} />}
    </div>;
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      data-testid={imageTestId}
      src={toProxyUrl(src)}
      alt={alt}
      loading={loading}
      className={className}
      onError={() => setLoadState(current => reduceMediaLoadState(current, "decode-error"))}
      onLoad={event => {
        const image = event.currentTarget;
        // A successful decode can still be a 1x1/2x2 tracking pixel. Use the
        // browser's measured naturalWidth/naturalHeight, never URL spelling or color.
        const result = image.naturalWidth <= 2 || image.naturalHeight <= 2 || inspectLoadedMedia(image, candidate ?? src) !== "valid"
          ? "invalid-load"
          : "valid-load";
        setLoadState(current => reduceMediaLoadState(current, result));
      }}
      style={{ display: "block", ...style }}
    />
  );
}

/**
 * Shared image boundary for selected assets, cards, and content media. The keyed
 * child is intentional: A→B→A must retry A instead of restoring B's failed state.
 */
export function ResilientMediaImage(props: Props) {
  const identity = mediaIdentity({ url: props.src, id: props.candidate?.id });
  return <MediaResource key={identity} {...props} />;
}

type SelectedAssetImageItem = Pick<ResilientMediaIdentityInput, "imageUrl">;

/** Shared thumbnail/hover/gallery image integration for selected source assets. */
export function SelectedAssetImage({
  item,
  imageTestId,
  fallback,
  style,
}: {
  item: SelectedAssetImageItem;
  imageTestId: string;
  fallback: ReactNode;
  style?: CSSProperties;
}) {
  return <ResilientMediaImage key={mediaIdentity(item)} src={item.imageUrl ?? ""} alt=""
    imageTestId={imageTestId} fallback={fallback} style={style} />;
}
