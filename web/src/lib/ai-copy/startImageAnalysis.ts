"use client";

/**
 * startImageAnalysis — upload-time background image analysis + keyword prep.
 *
 * Fired right after a Pin draft card is created on upload. It calls
 * POST /api/ai-copy/analyze, then persists the structured analysis + recommended
 * high-search keywords ONTO the draft (pinDraftStore / localStorage), so a later
 * "Generate copy" can use the fast text path instead of re-running vision.
 *
 * Fire-and-forget: never throws. On failure it marks the draft failed so Generate
 * copy can fall back to the vision one-call path.
 *
 * MVP LIMITATIONS (accepted for Phase 1 — see the Generate-copy fallback):
 *  - Client-driven: closing/reloading the tab before the fetch resolves interrupts
 *    analysis. The draft is left imageAnalysisStatus="pending"; the next Generate
 *    briefly polls then falls back to the vision path, and a re-upload re-triggers it.
 *  - localStorage-only: the cached analysis + keywords are per-device/per-browser.
 *    There is no cross-device persistence and no server record.
 *  - No ret/backoff or queueing: a transient failure marks the draft "failed" (Generate
 *    uses the vision fallback); there is no automatic re-analysis.
 *  Production hardening (future): move this trigger to a server-side background job
 *  (queue/worker) keyed off the upload, persist analysis in the DB, and reconcile
 *  status server-side so it survives page close and works cross-device.
 */

import * as pinDraftStore from "@/lib/pinDraftStore";
import { readResolvedContentLanguage } from "@/lib/i18n/config";
import { track, trackLatency } from "@/lib/analytics";
import {
  classifyAnalysisError,
  parseRetryAfter,
  shouldApplyAnalysis,
} from "@/lib/studio/recommendationRequest";

/**
 * In-flight analyses, keyed by `draftId|imageUrl`. A second call for the same draft
 * AND the same image joins the first instead of issuing a duplicate vision request:
 * the drawer can trigger this from several places (open, product swap, manual retry)
 * and each duplicate would be a real, billable model call for the same image. Keying
 * on the image too (not just the draft id) means a draft whose image was swapped
 * gets its OWN slot — it no longer joins a stale run still in flight for the old
 * picture, which used to let that old run's failure/success land on the new image.
 */
const inFlight = new Map<string, Promise<void>>();

function inFlightKey(draftId: string, imageUrl: string | undefined): string {
  return `${draftId}|${imageUrl ?? ""}`;
}

type AnalyzeResponse = {
  ok?: boolean;
  error?: string;
  analysis?: {
    imageSummary?: string;
    visibleObjects?: string[];
    colors?: string[];
    style?: string;
    ocrText?: string;
    category?: string;
    model?: string;
  };
  recommendedKeywords?: string[];
  timingsMs?: Record<string, number>;
};

export function startImageAnalysis(draftId: string): Promise<void> {
  // Read the draft's CURRENT image before touching the map — the key must reflect
  // the picture this call is actually for, not whatever a prior in-flight run for
  // this draft id was started against.
  const key = inFlightKey(draftId, pinDraftStore.getDraft(draftId)?.imageUrl);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const run = runImageAnalysis(draftId).finally(() => {
    // Only clear our own entry (a newer run may already have taken the slot).
    if (inFlight.get(key) === run) inFlight.delete(key);
  });
  inFlight.set(key, run);
  return run;
}

async function runImageAnalysis(draftId: string): Promise<void> {
  const draft = pinDraftStore.getDraft(draftId);
  if (!draft || !draft.imageUrl) return;
  // Don't re-run an in-flight or completed analysis.
  if (draft.imageAnalysisStatus === "pending" || draft.imageAnalysisStatus === "ready") return;

  // The image this run is bound to. If the draft's image changes while the request is
  // out, the result describes a picture the draft no longer has and must be dropped.
  const startedImageUrl = draft.imageUrl;
  const started = performance.now();
  pinDraftStore.updateDraft(draftId, { imageAnalysisStatus: "pending", keywordStatus: "pending" });
  track("image_analysis_started", { draftId });

  // Best-effort linked-product context for keyword relevance. `title` is always on a
  // LinkedProduct; `productType`/`tags` ride along only on richer (Shopify) snapshots
  // and are simply absent otherwise — never fabricated.
  const linked = draft.linkedProducts?.length
    ? (draft.linkedProducts.find(p => p.productId === draft.primaryProductId) ?? draft.linkedProducts[0])
    : undefined;
  const looseProduct = linked as (typeof linked & { productType?: string; tags?: string[] }) | undefined;
  const productTags = Array.isArray(looseProduct?.tags) && looseProduct.tags.length
    ? looseProduct.tags.slice(0, 10)
    : undefined;

  // Hoisted so the catch can classify the failure from the real HTTP status /
  // Retry-After header instead of guessing from the error message alone.
  let res: Response | undefined;
  try {
    res = await fetch("/api/ai-copy/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      // Explicit (the fetch default): the route authenticates this same-origin
      // caller from the Supabase SSR session cookies.
      credentials: "same-origin",
      body: JSON.stringify({
        draftId,
        imageUrl: draft.imageUrl,
        category: draft.category || undefined,
        boardName: draft.boardName || undefined,
        language: readResolvedContentLanguage(),
        productTitle: linked?.title || undefined,
        productType: looseProduct?.productType || undefined,
        productTags,
      }),
    });
    const body = await res.json() as AnalyzeResponse;
    if (!res.ok || !body.ok || !body.analysis?.imageSummary) {
      // 401 = signed out / expired session, NOT a provider or image problem. This
      // helper is fire-and-forget with no UI surface of its own, so it keeps the
      // existing "mark failed → Generate copy uses the vision fallback" behaviour;
      // the error is tagged `unauthenticated` so the failure telemetry does not
      // read as an AI failure. The user-visible sign-in prompt comes from the
      // Generate-copy call (generatePinCopy.ts), which is a foreground action.
      //
      // 429 = the server's per-user AI cost ceiling (Phase 1B PR2). Same reasoning,
      // same silent path — a background call the user never initiated must not raise
      // a toast — but it is tagged `rate_limited` and gets its OWN analytics event so
      // it is not miscounted as an image/provider failure. Generate copy still works
      // for these drafts: it falls back to the vision one-call path.
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        track("image_analysis_rate_limited", {
          draftId,
          retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null,
        });
        throw new Error("rate_limited");
      }
      throw new Error(res.status === 401 ? "unauthenticated" : (body?.error || `analyze_http_${res.status}`));
    }

    // The draft's image may have been swapped while this request was out. Writing the
    // analysis now would describe the OLD picture — the exact mismatch that made
    // recommendations look unrelated to what the user is holding. Drop it instead, and
    // hand the draft back to "never analysed" so the new image can be analysed.
    const current = pinDraftStore.getDraft(draftId);
    if (!shouldApplyAnalysis(startedImageUrl, current?.imageUrl)) {
      if (current?.imageAnalysisStatus === "pending") {
        pinDraftStore.updateDraft(draftId, { imageAnalysisStatus: undefined, keywordStatus: undefined });
      }
      track("image_analysis_discarded_stale", { draftId });
      return;
    }

    const a = body.analysis;
    const recommended = Array.isArray(body.recommendedKeywords) ? body.recommendedKeywords : [];
    const now = new Date().toISOString();
    pinDraftStore.updateDraft(draftId, {
      imageAnalysisStatus:    "ready",
      // A success clears any previous failure reason — a "ready" draft never carries
      // a stale error code / countdown into the UI.
      imageAnalysisError:      undefined,
      imageAnalysisRetryAfter: undefined,
      imageSummary:           a.imageSummary,
      visibleObjects:         Array.isArray(a.visibleObjects) ? a.visibleObjects : [],
      colors:                 Array.isArray(a.colors) ? a.colors : [],
      style:                  a.style ?? "",
      ocrText:                a.ocrText ?? "",
      imageCategory:          a.category ?? "",
      imageAnalysisModel:     a.model ?? "",
      imageAnalysisUpdatedAt: now,
      keywordStatus:          "ready",
      recommendedKeywords:    recommended,
      keywordSource:          "pinterest_high_search",
      keywordUpdatedAt:       now,
    });

    const latencyMs = performance.now() - started;
    track("image_analysis_ready", { draftId, model: a.model ?? null });
    trackLatency("upload_to_analysis_ready", latencyMs, { draftId });
    track("recommended_keywords_ready", { draftId, count: recommended.length });
    trackLatency("upload_to_keywords_ready", latencyMs, { draftId, count: recommended.length });
  } catch (err) {
    // Record WHY it failed: the drawer offers a retry for a plain failure but must not
    // re-fire against a rate limit (that is a cost loop), and it can only say "try again
    // in Ns" if the Retry-After the server actually sent is kept.
    const errorCode = classifyAnalysisError(err, res?.status);
    const retryAfter = res?.status === 429 ? parseRetryAfter(res.headers.get("retry-after")) : undefined;
    const cur = pinDraftStore.getDraft(draftId);
    // Same guard as the success path: the draft's image may have been swapped while
    // this request was out. A FAILURE for the OLD picture must not blank the NEW
    // image's analysis state (no error, no retryAfter) — the new image is either
    // already analysing under its own in-flight key or has never been asked for yet,
    // and this stale failure must not overwrite either state.
    if (!shouldApplyAnalysis(startedImageUrl, cur?.imageUrl)) {
      if (cur?.imageAnalysisStatus === "pending") {
        pinDraftStore.updateDraft(draftId, { imageAnalysisStatus: undefined, keywordStatus: undefined });
      }
      track("image_analysis_discarded_stale", { draftId });
      return;
    }
    // Only overwrite our own pending marker (avoid clobbering a concurrent success).
    if (cur?.imageAnalysisStatus === "pending") {
      pinDraftStore.updateDraft(draftId, {
        imageAnalysisStatus:     "failed",
        keywordStatus:           "failed",
        imageAnalysisError:      errorCode,
        imageAnalysisRetryAfter: retryAfter,
      });
    }
    track("image_analysis_failed", { draftId, error: (err as Error)?.message?.slice(0, 120) ?? "unknown" });
  }
}
