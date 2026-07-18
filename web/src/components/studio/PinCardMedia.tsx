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

import { useEffect, useMemo, useState } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { ImageOff } from "lucide-react";
import { toProxyUrl } from "@/lib/imageProxy";
import * as pinDraftStore from "@/lib/pinDraftStore";
import { resolveFailureMediaUrl, type FailureMediaDraft } from "@/lib/studio/failureMedia";
import { BUI } from "@/components/studio/boardUI";

function lookupParent(id: string): FailureMediaDraft | null {
  return pinDraftStore.getDraft(id);
}

/** Ordered list of every candidate URL for this draft (deduped), ending implicitly
 *  in the placeholder once the caller exhausts the list. Computed once per draft —
 *  onError just advances an index into it. */
function candidateChain(draft: FailureMediaDraft): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (u: string | null | undefined) => {
    const v = (u ?? "").trim();
    if (!v || v.startsWith("blob:") || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  push(draft.imageUrl);
  push(draft.sourceImageUrl);
  push(draft.setupSnapshot?.selectedProducts?.[0]?.imageUrl);
  push(draft.setupSnapshot?.selectedReferences?.[0]?.imageUrl);
  if (draft.parentDraftId) {
    const parent = lookupParent(draft.parentDraftId);
    if (parent) {
      push(parent.imageUrl);
      push(parent.sourceImageUrl);
      push(parent.setupSnapshot?.selectedProducts?.[0]?.imageUrl);
      push(parent.setupSnapshot?.selectedReferences?.[0]?.imageUrl);
    }
  }
  return out;
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
};

/** Resolve the first (best) candidate — used by callers that just need a URL/null,
 *  not the interactive fallback (e.g. to decide whether to show a source badge). */
export function resolveInitialFailureMediaUrl(draft: FailureMediaDraft): string | null {
  return resolveFailureMediaUrl(draft, lookupParent);
}

export function PinCardMedia({ draft, alt, className, style, placeholderVariant = "generationFailed", generating, hiddenByQuality }: PinCardMediaProps) {
  const { t: tr } = useLocale();
  const chain = useMemo(() => candidateChain(draft), [draft]);
  const [idx, setIdx] = useState(0);

  // A different draft (or an edit that changes the candidate chain) resets the walk.
  useEffect(() => { setIdx(0); }, [chain]);

  const current = idx < chain.length ? chain[idx] : null;

  if (!current) {
    const placeholderCopy = placeholderVariant === "noImage"
      ? tr("studioBoard.card.noImage")
      : tr("studioBoard.card.generationFailedPlaceholder");
    return (
      <div data-testid="card-generation-failed-placeholder"
        style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", gap: 6, background: BUI.surface3, color: BUI.textMuted, ...style }}
        className={className}>
        <ImageOff style={{ width: 22, height: 22 }} />
        <span style={{ fontSize: 11, fontWeight: 700 }}>{placeholderCopy}</span>
      </div>
    );
  }

  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      data-testid="card-generation-failed-image"
      src={toProxyUrl(current)}
      alt={alt}
      loading="lazy"
      onError={() => setIdx(i => i + 1)}
      onLoad={e => {
        const img = e.currentTarget;
        // A "successfully loaded" 1x1/2x2 pixel is junk (e.g. a stray placeholder PNG
        // data URL) — treat it exactly like a decode error and advance the chain.
        if (img.naturalWidth <= JUNK_IMAGE_MAX_DIMENSION || img.naturalHeight <= JUNK_IMAGE_MAX_DIMENSION) {
          setIdx(i => i + 1);
        }
      }}
      style={{ width: "100%", height: "100%", objectFit: "cover", display: "block",
        opacity: generating ? 0.55 : hiddenByQuality ? 0.35 : 1,
        filter: hiddenByQuality ? "blur(10px)" : "none",
        ...style }}
      className={className}
    />
  );
}
