"use client";

/**
 * PinCardMedia — the board card's universal media renderer. Walks the
 * resolveFailureMediaUrl chain (imageUrl → sourceImageUrl → product input → reference
 * input → parent draft) at runtime so a dead/expired/degenerate candidate (a URL that
 * looked usable but 404s, fails to decode, or turns out to be a junk 1x1 placeholder
 * pixel) advances to the next one instead of leaving a broken image or a giant solid
 * color block. Ends in a neutral gray placeholder — never blank, never blue art.
 *
 * Used for every lifecycle that has at least one image candidate: generation-failed
 * cards (placeholderVariant "generationFailed") AND publish-failed / healthy cards
 * (placeholderVariant "noImage"), since the chain starts at draft.imageUrl and
 * naturally prefers the genuine final generated image when it is valid.
 */

import { useMemo, useState } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { ImageOff } from "lucide-react";
import { toProxyUrl } from "@/lib/imageProxy";
import * as pinDraftStore from "@/lib/pinDraftStore";
import { reduceMediaCursor, resolveFailureMediaCandidates, resolveFailureMediaUrl, syncMediaCursor, type FailureMediaDraft } from "@/lib/studio/failureMedia";
import { BUI } from "@/components/studio/boardUI";
import { ContentMediaRenderer } from "@/components/media/ContentMediaRenderer";
import { contentMedia } from "@/lib/contentDraftModel";
import type { MessageKey } from "@/lib/i18n/messages/en";

function lookupParent(id: string): FailureMediaDraft | null {
  return pinDraftStore.getDraft(id);
}

/** A loaded image no real upload/generation could ever produce — a 1x1 (or similarly
 *  tiny) placeholder pixel that "loads successfully" but renders as a giant solid
 *  color block. Advance past it exactly like a decode error. */
const JUNK_IMAGE_MAX_DIMENSION = 2;

export type PinCardMediaVariant = "generationFailed" | "noImage";

export type PinCardMediaProps = {
  draft: FailureMediaDraft;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
  /** Which placeholder copy to show once the chain is exhausted. "generationFailed"
   *  (default) keeps the current "Generation failed" copy for generation-failed cards;
   *  "noImage" uses the neutral studioBoard.card.noImage copy for publish-failed /
   *  healthy cards that simply have no resolvable image. */
  placeholderVariant?: PinCardMediaVariant;
  /** Dim the image while a regeneration is in flight (matches the old inline opacity). */
  generating?: boolean;
  /** Quality-judge "invalid" verdict not yet overridden by the user: blur + dim the
   *  image underneath the card's own overlay (matches the old inline filter/opacity). */
  hiddenByQuality?: boolean;
  /** Reports intrinsic dimensions discovered after loading unknown legacy media. */
  onIntrinsicSize?: (width: number, height: number) => void;
};

/** Resolve the first (best) candidate — used by callers that just need a URL/null,
 *  not the interactive fallback (e.g. to decide whether to show a source badge). */
export function resolveInitialFailureMediaUrl(draft: FailureMediaDraft): string | null {
  return resolveFailureMediaUrl(draft, lookupParent);
}

export function PinCardMedia({ draft, alt, className, style, placeholderVariant = "generationFailed", generating, hiddenByQuality, onIntrinsicSize }: PinCardMediaProps) {
  const { t: tr } = useLocale();
  const primaryMedia = contentMedia(draft as Parameters<typeof contentMedia>[0])[0];
  if (primaryMedia?.kind === "video") {
    return <ContentMediaRenderer media={primaryMedia} alt={alt} className={className} onIntrinsicSize={onIntrinsicSize} style={{ objectFit: "contain", opacity: generating ? 0.55 : hiddenByQuality ? 0.35 : 1, filter: hiddenByQuality ? "blur(10px)" : "none", ...style }} />;
  }
  return <ImagePinCardMedia draft={draft} alt={alt} className={className} style={style} placeholderVariant={placeholderVariant} generating={generating} hiddenByQuality={hiddenByQuality} onIntrinsicSize={onIntrinsicSize} tr={tr} />;
}

function ImagePinCardMedia({ draft, alt, className, style, placeholderVariant, generating, hiddenByQuality, onIntrinsicSize, tr }: PinCardMediaProps & { tr: (key: MessageKey) => string }) {
  const chain = useMemo(() => resolveFailureMediaCandidates(draft, lookupParent), [draft]);
  // A different draft (or an edit that changes the candidate chain) resets the walk.
  // Derived DURING RENDER instead of by setting state from an effect: the effect
  // version rendered the new chain under the OLD index for one frame before
  // correcting itself. Candidate identities are stable and cannot contain a newline.
  const chainKey = chain.map(candidate => candidate.identity).join("\n");
  const [cursor, setCursor] = useState({ identity: chainKey, index: 0 });
  const synchronizedCursor = syncMediaCursor(cursor, chainKey);
  if (synchronizedCursor !== cursor) setCursor(synchronizedCursor);
  const idx = synchronizedCursor.index;
  const advance = () => setCursor(previous => reduceMediaCursor(syncMediaCursor(previous, chainKey), { type: "advance" }));

  const current = idx < chain.length ? chain[idx] : null;

  if (!current) {
    const placeholderCopy = placeholderVariant === "noImage"
      ? tr("studioBoard.card.noImage")
      : tr("studioBoard.card.generationFailedPlaceholder");
    return (
      // Neutral, self-contained and inline — no external URL, so it always ships in
      // the production build. role/aria-label give it the alt text an <img> would
      // carry (PRD: "Pin image unavailable").
      <div data-testid="card-generation-failed-placeholder"
        role="img"
        aria-label={tr("studioBoard.card.pinImageUnavailable")}
        // One solid neutral media well across every missing/failed-image route. The
        // status label keeps it actionable without using a random or alarming color.
        style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", gap: 6,
          background: BUI.mediaFallback, border: `1px solid ${BUI.mediaFallbackBorder}`,
          color: BUI.mediaFallbackText, ...style }}
        className={className}>
        <ImageOff style={{ width: 22, height: 22 }} />
        <span style={{ fontSize: 11, fontWeight: 700 }}>{placeholderCopy}</span>
      </div>
    );
  }

  const img = (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      data-testid="card-generation-failed-image"
      src={toProxyUrl(current.url)}
      alt={alt}
      loading="lazy"
      onError={advance}
      onLoad={e => {
        const el = e.currentTarget;
        if (el.naturalWidth > JUNK_IMAGE_MAX_DIMENSION && el.naturalHeight > JUNK_IMAGE_MAX_DIMENSION) {
          onIntrinsicSize?.(el.naturalWidth, el.naturalHeight);
        }
        // A "successfully loaded" 1x1/2x2 pixel is junk (e.g. a stray placeholder PNG
        // data URL) — treat it exactly like a decode error and advance the chain.
        if (el.naturalWidth <= JUNK_IMAGE_MAX_DIMENSION || el.naturalHeight <= JUNK_IMAGE_MAX_DIMENSION) {
          advance();
        }
      }}
      style={{ width: "100%", height: "100%", objectFit: "contain", display: "block",
        opacity: generating ? 0.55 : hiddenByQuality ? 0.35 : 1,
        filter: hiddenByQuality ? "blur(10px)" : "none",
        ...style }}
      className={className}
    />
  );

  // A product/reference/parent image standing in for a failed generation must never
  // pass as the generated result. Only badge it once generation has actually failed —
  // a healthy card showing its own source image is not a fallback.
  const showOriginalBadge = placeholderVariant === "generationFailed"
    && !generating
    && current.origin === "original";

  if (!showOriginalBadge) return img;

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {img}
      <span
        data-testid="card-original-image-badge"
        style={{
          position: "absolute", left: 6, bottom: 6, padding: "2px 7px", borderRadius: 5,
          background: "rgba(15,23,42,0.82)", color: "#F8FAFC",
          fontSize: 9, fontWeight: 800, letterSpacing: "0.02em", pointerEvents: "none",
        }}
      >
        {tr("studioBoard.card.originalImageFallback")}
      </span>
    </div>
  );
}
