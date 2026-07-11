import type { SetupSnapshot, HistoryEntry, GenerationErrorType, CategoryAudit } from "@/lib/studioPersistence";
import { resolveModelLabel } from "@/lib/studio/modelLabel";

export type FeedPinStatus = "completed" | "generating" | "failed" | "added";

export type PinDetailStudioPin = {
  id: string;
  url: string;
  planningStatus: string;
  title: string;
  description: string;
  setupSnapshot?: SetupSnapshot | null;
  generationSetup?: SetupSnapshot | null;
  batchId?: string | null;
  requestId?: string | null;
  createdAt?: string;
};

export type PinDetailSession = {
  id: string;
  savedAt: string;
  keyword: string;
  category: string;
  source: string;
  status: string;
  promptFull?: string;
  setupSnapshot?: SetupSnapshot;
  errorType?: GenerationErrorType;
  errorMessage?: string;
  model?: string;
  format?: string;
  textOverlay?: string;
  groupErrors?: Record<number, { message?: string; errorType?: GenerationErrorType }>;
  groups: { refUrl: string | null; refIndex: number; status: string }[];
  categoryAudit?: CategoryAudit;
};

export type PinDetailEntry = {
  key: string;
  sessionId: string;
  groupIdx: number;
  pinIdx?: number;
  pin?: PinDetailStudioPin;
  status: FeedPinStatus;
  refLabel: string;
  createdAt: string;
  placeholderVariant?: "generating" | "queued" | "failed";
};

export type PinDetailView = {
  pinId: string;
  sessionId: string;
  statusLabel: "Completed" | "Failed" | "Generating" | "Queued" | "Added to Plan";
  generationStatus: string;
  planningStatus: string;
  refLabel: string;
  imageUrl: string | null;
  isPlaceholder: boolean;
  placeholderVariant: "generating" | "queued" | "failed" | null;
  pin: PinDetailStudioPin | null;
  entry: PinDetailEntry;
  session: PinDetailSession;
  promptSnapshot: string | null;
  setupSnapshot: SetupSnapshot | null;
  setupSnapshotSource:
    | "pin.setupSnapshot"
    | "pin.generationSetup"
    | "batch.setupSnapshot"
    | "local_history"
    | "session_text_fallback"
    | "legacy_prompt_fallback";
  setupSnapshotMissingReasons: string[];
  isLegacyRecovery: boolean;
  errorMessage: string | null;
  errorType: string | null;
  model: string;
  format: string;
  textOverlay: string;
  createdAt: string;
  groupIdx: number;
  pinIdx?: number;
  source: string;
  categoryAudit?: CategoryAudit;
};

function nonEmpty(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v || v === "undefined" || v === "null") return null;
  return v;
}

function hasUsableSetupSnapshot(snapshot: SetupSnapshot | null | undefined): snapshot is SetupSnapshot {
  if (!snapshot) return false;
  return (
    (snapshot.selectedProducts?.length ?? 0) > 0
    || (snapshot.selectedReferences?.length ?? 0) > 0
    || !!nonEmpty(snapshot.promptSnapshot)
    || !!nonEmpty(snapshot.keyword)
    || !!nonEmpty(snapshot.opportunityTitle)
  );
}

function resolveSetupSnapshot(
  session: PinDetailSession,
  entry: PinDetailEntry,
  historyEntry?: HistoryEntry | null,
): {
  setup: SetupSnapshot | null;
  source: PinDetailView["setupSnapshotSource"];
  missingReasons: string[];
} {
  const missingReasons: string[] = [];

  if (hasUsableSetupSnapshot(entry.pin?.setupSnapshot)) {
    return { setup: entry.pin.setupSnapshot, source: "pin.setupSnapshot", missingReasons };
  }
  missingReasons.push("pin.setupSnapshot absent");

  if (hasUsableSetupSnapshot(entry.pin?.generationSetup)) {
    return { setup: entry.pin.generationSetup, source: "pin.generationSetup", missingReasons };
  }
  missingReasons.push("pin.generationSetup absent");

  if (hasUsableSetupSnapshot(session.setupSnapshot)) {
    return { setup: session.setupSnapshot, source: "batch.setupSnapshot", missingReasons };
  }
  missingReasons.push("batch.setupSnapshot absent");

  if (hasUsableSetupSnapshot(historyEntry?.setupSnapshot)) {
    return { setup: historyEntry.setupSnapshot, source: "local_history", missingReasons };
  }
  missingReasons.push("local history setupSnapshot absent");

  // 5th fallback: synthesise a minimal snapshot from session text fields so the Remix tab
  // can still show the prompt/keyword without triggering the "Older generation" legacy banner.
  // This covers pins where the DB save silently failed (data-URL payload too large) but the
  // session.promptFull / keyword columns were saved successfully.
  const syntheticKeyword = nonEmpty(session.keyword);
  const syntheticPrompt  =
    nonEmpty(session.promptFull)
    ?? nonEmpty(historyEntry?.promptFull)
    ?? nonEmpty(historyEntry?.promptExcerpt);
  if (syntheticKeyword || syntheticPrompt) {
    missingReasons.push("synthesised from session text fields");
    return {
      setup: {
        mode:               session.source ?? "keyword_led",
        keyword:            syntheticKeyword ?? "",
        noTextOverlay:      true,
        imagesPerReference: 1,
        selectedProducts:   [],
        selectedReferences: [],
        promptSnapshot:     syntheticPrompt ?? "",
      },
      source: "session_text_fallback",
      missingReasons,
    };
  }

  return { setup: null, source: "legacy_prompt_fallback", missingReasons };
}

function logRemixHydration(detail: PinDetailView): void {
  if (typeof window === "undefined" || process.env.NODE_ENV === "production") return;
  console.log("[RemixHydration] resolved setup source", {
    pinId: detail.pinId,
    createdAt: detail.createdAt,
    batchId: detail.entry.pin?.batchId ?? detail.sessionId,
    requestId: detail.entry.pin?.requestId ?? detail.entry.key,
    generationStatus: detail.generationStatus,
    planStatus: detail.planningStatus,
    hasPinSetupSnapshot: !!detail.entry.pin?.setupSnapshot,
    hasPinGenerationSetup: !!detail.entry.pin?.generationSetup,
    hasBatchSetupSnapshot: !!detail.session.setupSnapshot,
    hasLocalHistorySetupSnapshot: detail.setupSnapshotSource === "local_history",
    sourceUsed: detail.setupSnapshotSource,
    missingBeforeSource: detail.setupSnapshotMissingReasons,
    productImagesCount: detail.setupSnapshot?.selectedProducts?.length ?? 0,
    pinReferencesCount: detail.setupSnapshot?.selectedReferences?.length ?? 0,
  });
}

export function resolveStatusLabel(entry: PinDetailEntry): PinDetailView["statusLabel"] {
  if (entry.pin && entry.pin.planningStatus !== "not_added") return "Added to Plan";
  if (entry.status === "added") return "Added to Plan";
  if (entry.status === "failed" || entry.placeholderVariant === "failed") return "Failed";
  if (entry.placeholderVariant === "queued") return "Queued";
  if (entry.status === "generating" || entry.placeholderVariant === "generating") return "Generating";
  return "Completed";
}

export function resolvePinDetail(
  session: PinDetailSession,
  entry: PinDetailEntry,
  historyEntry?: HistoryEntry | null,
): PinDetailView {
  const isPlaceholder = entry.status === "generating" || entry.status === "failed" || !entry.pin;
  const variant = entry.placeholderVariant ?? (entry.status === "failed" ? "failed" : isPlaceholder ? "generating" : null);
  const { setup, source: setupSnapshotSource, missingReasons: setupSnapshotMissingReasons } = resolveSetupSnapshot(session, entry, historyEntry);
  const promptSnapshot =
    nonEmpty(setup?.promptSnapshot)
    ?? nonEmpty(session.promptFull)
    ?? nonEmpty(historyEntry?.promptFull)
    ?? nonEmpty(historyEntry?.promptExcerpt)
    ?? null;

  const groupError = session.groupErrors?.[entry.groupIdx];
  const errorMessage =
    nonEmpty(groupError?.message)
    ?? nonEmpty(session.errorMessage)
    ?? nonEmpty(historyEntry?.errorMessage)
    ?? (isPlaceholder && variant === "failed" ? null : null);

  const errorType =
    groupError?.errorType
    ?? session.errorType
    ?? historyEntry?.errorType
    ?? null;

  const planningStatus = entry.pin?.planningStatus ?? "not_added";

  const detail: PinDetailView = {
    pinId: entry.pin?.id ?? entry.key,
    sessionId: session.id,
    statusLabel: resolveStatusLabel(entry),
    generationStatus: session.status,
    planningStatus,
    refLabel: entry.refLabel,
    imageUrl: entry.pin?.url ?? null,
    isPlaceholder,
    placeholderVariant: isPlaceholder ? (variant ?? "generating") : null,
    pin: entry.pin ?? null,
    entry,
    session,
    promptSnapshot,
    setupSnapshot: setup,
    setupSnapshotSource,
    setupSnapshotMissingReasons,
    isLegacyRecovery: setupSnapshotSource === "legacy_prompt_fallback",
    errorMessage: errorMessage ?? (variant === "failed" ? null : null),
    errorType: errorType ?? null,
    model: resolveModelLabel(session.model, setup?.modelKey),
    format: session.format ?? "2:3",
    textOverlay: session.textOverlay ?? (setup?.noTextOverlay === false ? "On" : "Off"),
    createdAt: entry.createdAt || session.savedAt,
    groupIdx: entry.groupIdx,
    pinIdx: entry.pinIdx,
    source: session.source,
    categoryAudit: session.categoryAudit,
  };
  logRemixHydration(detail);
  return detail;
}

export function findHistoryEntry(sessionId: string, history: HistoryEntry[]): HistoryEntry | null {
  return history.find(h => h.id === sessionId) ?? null;
}

// ── Normalised setup snapshot ─────────────────────────────────────────────────
//
// Snapshot priority is resolved by resolvePinDetail:
//  1. pin.setupSnapshot
//  2. pin.generationSetup
//  3. batch/session setupSnapshot
//  4. persistent local history setupSnapshot
//  5. legacy prompt fallback

/**
 * Recovery quality — how much of the original generation setup we could restore.
 *
 *   full           — every visual input that was used is recovered with a live
 *                     imageUrl (or no visual input was ever used and text is present)
 *   visual_partial — at least one product/reference recovered, but some are missing
 *   text_only      — no visual inputs recovered, but prompt / keyword / settings are
 *   unavailable    — nothing meaningful could be recovered
 */
export type RecoveryQuality = "full" | "visual_partial" | "text_only" | "unavailable";

export type GenerationSetupSnapshot = {
  productImages:   string[];
  pinReferences:   string[];
  prompt:          string;
  aspectRatio:     string;
  model:           string;
  imageCount:      number;
  opportunityTitle: string;
  noTextOverlay:   boolean;
  /** true = at least one product/reference recovered with a live imageUrl */
  isFullSnapshot:  boolean;
  /** how many visual inputs the original generation used (from snapshot array lengths / groups) */
  expectedProducts: number;
  expectedReferences: number;
  /** number of inputs actually recovered with a usable imageUrl */
  recoveredProducts: number;
  recoveredReferences: number;
  recoveryQuality: RecoveryQuality;
};

export function getGenerationSetupSnapshot(detail: PinDetailView): GenerationSetupSnapshot {
  // Use the best available snapshot chosen by resolvePinDetail.
  const snap = detail.setupSnapshot;

  const productImages = (snap?.selectedProducts ?? [])
    .map(p => p.imageUrl)
    .filter((u): u is string => !!u);

  // Ref recovery: snapshot > group refUrl
  const refFromGroup = detail.session.groups[detail.groupIdx]?.refUrl;
  const pinReferences = snap?.selectedReferences?.length
    ? snap.selectedReferences.map(r => r.imageUrl).filter(Boolean) as string[]
    : refFromGroup
      ? [refFromGroup]
      : [];

  const prompt = snap?.promptSnapshot ?? detail.promptSnapshot ?? detail.session.promptFull ?? "";
  const aspectRatio = detail.format ?? snap?.format ?? "2:3";
  const model = resolveModelLabel(detail.model ?? snap?.model, snap?.modelKey);
  const imageCount = snap?.imagesPerReference ?? 1;
  const opportunityTitle = snap?.opportunityTitle ?? detail.session.keyword ?? "";
  const noTextOverlay = snap?.noTextOverlay ?? true;

  const isFullSnapshot = !!snap && (productImages.length > 0 || pinReferences.length > 0);

  // ── Recovery quality ────────────────────────────────────────────────────────
  // Even a *compact* snapshot preserves the selectedProducts/selectedReferences
  // array lengths (only the imageUrls are nulled), so array length tells us how
  // many visual inputs the original generation used — the key to distinguishing
  // "lost some images" from "never had images".
  const expectedProducts   = snap?.selectedProducts?.length ?? 0;
  const expectedReferences = snap?.selectedReferences?.length
    ?? detail.session.groups.filter(g => !!g.refUrl).length;
  const recoveredProducts   = productImages.length;
  const recoveredReferences = pinReferences.length;
  const hasText = !!(
    (prompt ?? "").trim()
    || (opportunityTitle ?? "").trim()
    || (detail.session.keyword ?? "").trim()
  );
  const expectsVisual = expectedProducts > 0 || expectedReferences > 0;
  const recoveredAllVisual =
    recoveredProducts >= expectedProducts && recoveredReferences >= expectedReferences;

  // A *synthesized* source (text fallback / legacy) carries no authoritative record of
  // how many visual inputs were used — its product/reference arrays are empty by
  // construction. We must NOT read that as "no visual inputs were used" (which would
  // wrongly claim full recovery); the honest verdict is text_only (or visual_partial if
  // a reference was recovered from the group, or unavailable if nothing is left).
  const isSynthesizedSource =
    detail.setupSnapshotSource === "session_text_fallback"
    || detail.setupSnapshotSource === "legacy_prompt_fallback";

  let recoveryQuality: RecoveryQuality;
  if (isSynthesizedSource) {
    if (recoveredProducts > 0 || recoveredReferences > 0) recoveryQuality = "visual_partial";
    else if (hasText)                                     recoveryQuality = "text_only";
    else                                                  recoveryQuality = "unavailable";
  } else if (!expectsVisual) {
    // Authoritative snapshot says no visual inputs were used — prompt/settings IS the
    // complete setup, so this is full recovery.
    recoveryQuality = hasText ? "full" : "unavailable";
  } else if (recoveredAllVisual && (recoveredProducts > 0 || recoveredReferences > 0)) {
    recoveryQuality = "full";
  } else if (recoveredProducts > 0 || recoveredReferences > 0) {
    recoveryQuality = "visual_partial";
  } else if (hasText) {
    recoveryQuality = "text_only";
  } else {
    recoveryQuality = "unavailable";
  }

  return {
    productImages, pinReferences, prompt, aspectRatio, model, imageCount,
    opportunityTitle, noTextOverlay, isFullSnapshot,
    expectedProducts, expectedReferences, recoveredProducts, recoveredReferences,
    recoveryQuality,
  };
}
