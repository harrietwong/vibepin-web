"use client";

/**
 * PinCardMedia — renders the image for a GENERATION-failed board card, walking the
 * resolveFailureMediaUrl chain at runtime so a dead/expired candidate (a URL that
 * looked usable but 404s / fails to decode) advances to the next one instead of
 * leaving a broken image. Ends in a neutral gray "Generation failed" placeholder —
 * never blank, never blue failure art.
 *
 * Publish-failure cards do NOT use this component — they keep rendering the
 * successfully-generated final image directly (draft.imageUrl), unchanged.
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

export type PinCardMediaProps = {
  draft: FailureMediaDraft;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
};

/** Resolve the first (best) candidate — used by callers that just need a URL/null,
 *  not the interactive fallback (e.g. to decide whether to show a source badge). */
export function resolveInitialFailureMediaUrl(draft: FailureMediaDraft): string | null {
  return resolveFailureMediaUrl(draft, lookupParent);
}

export function PinCardMedia({ draft, alt, className, style }: PinCardMediaProps) {
  const { t: tr } = useLocale();
  const chain = useMemo(() => candidateChain(draft), [draft]);
  const [idx, setIdx] = useState(0);

  // A different draft (or an edit that changes the candidate chain) resets the walk.
  useEffect(() => { setIdx(0); }, [chain]);

  const current = idx < chain.length ? chain[idx] : null;

  if (!current) {
    return (
      <div data-testid="card-generation-failed-placeholder"
        style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", gap: 6, background: BUI.surface3, color: BUI.textMuted, ...style }}
        className={className}>
        <ImageOff style={{ width: 22, height: 22 }} />
        <span style={{ fontSize: 11, fontWeight: 700 }}>{tr("studioBoard.card.generationFailedPlaceholder")}</span>
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
      style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", ...style }}
      className={className}
    />
  );
}
