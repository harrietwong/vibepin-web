/**
 * bulkCopyDrafts.ts — glue between the pure bulk orchestration (bulkGenerateCopy.ts)
 * and the real AI Copy client / draft records (T4). No React, no store writes.
 */

import {
  AMAZON_PRODUCT_NAME_REQUIRED,
  isRateLimitError,
  isTextLimitReachedError,
} from "@/lib/ai-copy/generatePinCopy";
import type { MetadataTouchedFlags } from "@/lib/pinMetadata";
import type { BulkCopyErrorKind, CopyTouchedFlags } from "./bulkGenerateCopy";

/** Thrown by a bulk `generate` when the card already has a copy request running. */
export class BulkCopyBusyError extends Error {
  constructor() { super("busy"); this.name = "BulkCopyBusyError"; }
}

/** Map an AI Copy client error onto the bulk runner's vocabulary. */
export function classifyBulkCopyError(error: unknown): BulkCopyErrorKind {
  if (error instanceof BulkCopyBusyError) return { kind: "busy" };
  if (isTextLimitReachedError(error) || (error as { status?: number })?.status === 402) return { kind: "text_limit" };
  if (isRateLimitError(error) || (error as { status?: number })?.status === 429) {
    const retry = (error as { retryAfterSeconds?: number | null }).retryAfterSeconds;
    return { kind: "rate_limited", retryAfterSeconds: typeof retry === "number" && Number.isFinite(retry) ? retry : null };
  }
  if ((error as { code?: string })?.code === AMAZON_PRODUCT_NAME_REQUIRED) return { kind: "needs_product_name" };
  return { kind: "failed", message: error instanceof Error && error.message ? error.message : "Copy generation failed." };
}

type CopyValues = { title?: string | null; description?: string | null; altText?: string | null };

/**
 * Touched flags for a MANUAL edit (a user typing into a card / row): every copy field
 * whose value differs from what is stored becomes touched. Returns null when no copy
 * field changed. AI applies never call this — they are not the user's text.
 */
export function manualCopyTouched(
  stored: CopyValues & { metadataTouched?: Partial<MetadataTouchedFlags> },
  next: CopyValues,
): Partial<MetadataTouchedFlags> | null {
  const flags: Partial<MetadataTouchedFlags> = {};
  if (next.title !== undefined && (next.title ?? "") !== (stored.title ?? "")) flags.titleTouched = true;
  if (next.description !== undefined && (next.description ?? "") !== (stored.description ?? "")) flags.descriptionTouched = true;
  if (next.altText !== undefined && (next.altText ?? "") !== (stored.altText ?? "")) flags.altTextTouched = true;
  if (!Object.keys(flags).length) return null;
  return { ...(stored.metadataTouched ?? {}), ...flags };
}

/** Touched flags the bulk merge reads: the draft's own flags plus unsaved row edits. */
export function copyTouchedOf(
  draftTouched: Partial<MetadataTouchedFlags> | undefined,
  rowTouched?: CopyTouchedFlags,
): CopyTouchedFlags {
  return {
    titleTouched: !!(draftTouched?.titleTouched || rowTouched?.titleTouched),
    descriptionTouched: !!(draftTouched?.descriptionTouched || rowTouched?.descriptionTouched),
    altTextTouched: !!(draftTouched?.altTextTouched || rowTouched?.altTextTouched),
  };
}
