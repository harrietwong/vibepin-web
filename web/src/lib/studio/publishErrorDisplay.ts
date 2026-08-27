/**
 * publishErrorDisplay.ts — the ONLY sanctioned way to turn a draft's stored publish
 * failure into user-facing text.
 *
 * Why this exists (real-device QA finding): `draft.publishError` holds the RAW upstream
 * message (`err.message` from the cron/batch publish paths, which can carry Pinterest
 * API internals — request-shaped detail, upstream response fragments, ids). The failure
 * UX contract requires the card to show something "safe, redacted and readable", never
 * tokens/secrets/headers/raw response bodies. So the display layer maps the failure to a
 * fixed, translated sentence chosen by CATEGORY, and the raw string is never rendered.
 *
 * The raw `publishError` is deliberately KEPT on the draft — it is still the internal
 * diagnostic payload (support context, Contact support attachments, logs). This module
 * only governs what the UI is allowed to *show*.
 *
 * Pure + framework-free: returns a MessageKey, callers translate with their own `tr`.
 */

import type { PinDraft } from "@/lib/pinDraftStore";
import type { MessageKey } from "@/lib/i18n/messages/en";
import { mapPublishErrorToCategory, type ErrorCategory } from "@/lib/studio/pinLifecycle";

export type PublishErrorDisplayInput = Pick<PinDraft, "publishError" | "errorCategory" | "publishErrorCode">;

/**
 * Resolve the category we should DISPLAY for a failed draft.
 * Prefers the persisted `errorCategory`; otherwise re-derives it from the stable code
 * (and, only as a last resort, the raw message — read for classification, never shown).
 * Returns null when there is nothing recorded at all (legacy drafts).
 */
export function resolvePublishErrorCategory(d: PublishErrorDisplayInput): ErrorCategory | null {
  const persisted = d.errorCategory;
  if (persisted === "auth" || persisted === "content" || persisted === "transient") return persisted;
  const hasSignal = !!(d.publishError ?? "").trim() || !!(d.publishErrorCode ?? "").trim();
  if (!hasSignal) return null;
  return mapPublishErrorToCategory(d.publishErrorCode, d.publishError);
}

/**
 * The user-facing reason line for a failed Pin card.
 *
 *   auth      → reconnect Pinterest and retry
 *   content   → something about board/image/link needs editing
 *   transient → temporary, safe to retry
 *   (nothing recorded — legacy draft) → honest "no detail was recorded" fallback
 *
 * NEVER returns / embeds the raw `publishError` string.
 */
export function getPublishErrorDisplayKey(d: PublishErrorDisplayInput): MessageKey {
  const code = (d.publishErrorCode ?? "").trim().toLowerCase();
  const message = (d.publishError ?? "").trim().toLowerCase();
  if (code === "board_not_owned" || /board (not found|not owned|unavailable)/.test(message)) {
    return "studioBoard.card.publishError.board";
  }
  if (code === "invalid_image_url" || /image.*(invalid|failed|format|size|dimension|crop)/.test(message)) {
    return "studioBoard.card.publishError.image";
  }
  if (code === "invalid_link" || /link.*(invalid|failed)|invalid.*url/.test(message)) {
    return "studioBoard.card.publishError.link";
  }
  if (code === "network_error" || /timeout|timed out|network/.test(message)) {
    return "studioBoard.card.publishError.timeout";
  }
  switch (resolvePublishErrorCategory(d)) {
    case "auth":      return "studioBoard.card.publishError.auth";
    case "content":   return "studioBoard.card.publishError.content";
    case "transient": return "studioBoard.card.publishError.transient";
    default:          return "studioBoard.card.publishError.unknown";
  }
}
