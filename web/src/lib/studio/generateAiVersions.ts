"use client";

/**
 * Client helper for Board V2 Generate AI Image -> POST /api/generate.
 * It uses the real Studio generation contract: product images are subject inputs,
 * reference images are style/composition inputs, and Creative Direction V2 is sent
 * as structured metadata.
 */

import { createBrowserClient } from "@supabase/ssr";
import type { PinDraft } from "@/lib/pinDraftStore";
import type { AiVersionOptions } from "@/components/studio/AiVersionDrawer";
import { PINS_PER_REFERENCE_OPTIONS } from "@/lib/studio/selectedReferences";

const MAX_PINS_PER_REFERENCE = Math.max(...PINS_PER_REFERENCE_OPTIONS);

let _client: ReturnType<typeof createBrowserClient> | null = null;
function browser() {
  if (_client) return _client;
  _client = createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  return _client;
}

/** Exported for generationRecovery.ts's own GET /api/generation-jobs/[id] probe. */
export async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await browser().auth.getSession();
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (session?.access_token) h.Authorization = `Bearer ${session.access_token}`;
  return h;
}

export type AiVersionGenerateResult = {
  urls: string[];
  generationRequestId: string;
  promptSnapshot?: Record<string, unknown>;
  requestedImageCount?: number;
  actualImageCount?: number;
  countClamped?: boolean;
  source?: string;
};

function buildGenerateBody(opts: {
  source?: PinDraft | null;
  keyword?: string;
  setup: AiVersionOptions;
  generationRequestId: string;
  /**
   * Grouped generation: the ONE style reference this request carries. Omit (or
   * pass undefined) to keep the legacy "all of setup.referenceImages" behavior.
   */
  referenceImages?: string[];
}): Record<string, unknown> {
  const { source, setup, generationRequestId } = opts;
  const productImages = setup.productImages.length
    ? setup.productImages
    : source?.imageUrl ? [source.imageUrl] : [];
  const referenceImages = opts.referenceImages ?? setup.referenceImages;

  return {
    keyword: source?.keyword || opts.keyword || source?.title || setup.category || "pin",
    category: setup.category || source?.category || "",
    style: "editorial",
    // Per-GROUP count (pinsPerReference, 1..MAX_PINS_PER_REFERENCE) — never the batch total.
    count: Math.max(1, Math.min(MAX_PINS_PER_REFERENCE, setup.count)),
    prompt: setup.hiddenPrompt || setup.prompt,
    prompt_mode: "creative_direction_v2",
    prompt_version: 2,
    creative_direction_meta: setup.creativeDirectionMeta,
    selectedTags: setup.selectedTags,
    primaryFormatTag: setup.primaryFormatTag,
    directionBrief: setup.directionBrief,
    briefManuallyEdited: setup.briefManuallyEdited,
    inferredCategory: setup.category,
    productImageCountRequested: productImages.length,
    referenceImageCountRequested: referenceImages.length,
    outputCount: setup.count,
    variationMode: setup.variationMode,
    outputVariants: setup.outputVariants,
    generationRequestId,
    style_ref: referenceImages[0] || null,
    product_images: productImages,
    image_inputs: [
      ...productImages.map((sourceUrl, index) => ({
        role: "product",
        order: index + 1,
        sourceUrl,
        label: `Product image ${index + 1}`,
      })),
      ...referenceImages.map((sourceUrl, index) => ({
        role: "reference",
        order: productImages.length + index + 1,
        sourceUrl,
        label: `Reference image ${index + 1}`,
      })),
    ],
    text_overlay: false,
    reference_strength: referenceImages.length ? "strong" : "moderate",
    output_type: setup.category === "fashion" ? "fashion_editorial" : "",
    format: setup.format,
    model_key: setup.modelKey,
    product_metadata: setup.productMetadata,
  };
}

/**
 * Shape-probed dual path (WP3-P1): POST /api/generate returns EITHER
 *   - worker mode:  { jobId, slots }               → caller should switch to enqueue+poll
 *   - inline mode:  { ok, urls, ... }               → resolved synchronously as before
 * We do not gate on a public env var — GENERATION_MODE lives server-side only, and the
 * grey-out switch must work without a redeploy of client bundles. Detecting "does the
 * response have a jobId" is the single source of truth for which mode is live.
 *
 * Generate ONE reference group.
 *
 * A batch of N references is N sequential calls to this function, each requesting
 * `setup.count` images with a single `styleReference` as its style_ref. That is not
 * a stylistic choice:
 *
 *  - /api/generate rebuilds image_inputs from `product_images` + ONE `style_ref`
 *    string (buildImageInputs), so a single request can only ever carry one
 *    reference image; and
 *  - it holds a per-user "active-generation" lock and returns 429
 *    (user_generation_limit) for a concurrent second call, so the groups must be
 *    serial rather than parallel.
 *
 * Product images and metadata are shared across every group; only the style
 * reference varies. The caller pairs each result with its group's reference to
 * persist the association onto the resulting Pins.
 */
export async function generateAiVersions(opts: {
  source?: PinDraft | null;
  keyword?: string;
  setup: AiVersionOptions;
  /** This group's style reference. Omit for a product/prompt-only group. */
  styleReference?: string | null;
  /** Shared across all groups in one batch, for log/telemetry correlation. */
  batchRequestId?: string;
}): Promise<AiVersionGenerateResult> {
  const { source, setup } = opts;
  const generationRequestId = opts.batchRequestId
    ? `${opts.batchRequestId}_g${Math.random().toString(36).slice(2, 6)}`
    : `board_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  // One reference per group. `styleReference === undefined` means the caller did not
  // opt into grouped generation, so fall back to the legacy first-reference behavior.
  const groupReference = opts.styleReference !== undefined
    ? opts.styleReference
    : setup.referenceImages[0] ?? null;
  const referenceImages = groupReference ? [groupReference] : [];

  const res = await fetch("/api/generate", {
    method: "POST",
    headers: await authHeaders(),
    // Grouped generation passes THIS group's single reference; everything else is
    // the shared body builder (also used by enqueueGeneration) so the two paths
    // can never drift.
    body: JSON.stringify(buildGenerateBody({ source, keyword: opts.keyword, setup, generationRequestId, referenceImages })),
  });
  if (!res.ok) throw new Error(`Generation failed (${res.status})`);
  const body = await res.json() as {
    ok?: boolean;
    urls?: string[];
    generation_request_id?: string;
    generationRequestId?: string;
    prompt_snapshot?: Record<string, unknown>;
    requested_image_count?: number;
    actual_image_count?: number;
    count_clamped?: boolean;
    source?: string;
  };
  return {
    urls: Array.isArray(body.urls) ? body.urls.filter(Boolean) : [],
    generationRequestId: body.generation_request_id || body.generationRequestId || generationRequestId,
    promptSnapshot: body.prompt_snapshot,
    requestedImageCount: body.requested_image_count,
    actualImageCount: body.actual_image_count,
    countClamped: body.count_clamped,
    source: body.source,
  };
}

// ── WP3-P1: enqueue + poll (GENERATION_MODE=worker path) ────────────────────────

export type EnqueueGenerationResult = { jobId: string; slots: number } | null;

/**
 * POST /api/generate and probe the response shape. Returns null when the server is
 * NOT in worker mode (no jobId in the body) — callers should fall back to the
 * existing synchronous generateAiVersions() path unchanged. Throws only on network/
 * non-JSON failures and on the 503 "generation_unavailable" honest-failure (worker
 * heartbeat stale/missing) so the caller's existing catch-block failure handling
 * applies uniformly.
 */
export async function enqueueGeneration(opts: {
  source?: PinDraft | null;
  keyword?: string;
  setup: AiVersionOptions;
}): Promise<EnqueueGenerationResult> {
  const { source, setup } = opts;
  const generationRequestId = `board_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const res = await fetch("/api/generate", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(buildGenerateBody({ source, keyword: opts.keyword, setup, generationRequestId })),
  });

  if (res.status === 503) {
    let code = "generation_unavailable";
    try { code = ((await res.json()) as { error?: string }).error || code; } catch { /* ignore */ }
    throw new Error(code);
  }
  if (!res.ok) throw new Error(`Generation failed (${res.status})`);

  const body = await res.json() as { jobId?: string; slots?: number };
  if (!body.jobId || typeof body.slots !== "number") return null; // inline-mode shape — caller falls back
  return { jobId: body.jobId, slots: body.slots };
}

export type GenerationJobResult = { slot: number; status: "pending" | "done" | "failed"; imageUrl: string | null; error: string | null };
export type GenerationJobStatus = "queued" | "running" | "done" | "partial" | "failed";

export type PollGenerationCallbacks = {
  onSlot: (slot: number, status: "done" | "failed", url?: string) => void;
  onEnd:  (status: GenerationJobStatus | "timeout") => void;
};

const POLL_INTERVAL_MS = 4_000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * WP3-P2: module-level registry of jobIds currently being polled. Both the normal
 * enqueue-time call and generationRecovery.ts's reconcileGeneratingDrafts() (on
 * mount, after a reload) call pollGenerationJob — without this guard, a page
 * reload that races the in-flight poll (or two reconcile passes) would start a
 * second poll loop for the same job, double-firing onSlot/onEnd against the same
 * placeholders. Registered when polling starts, cleared on any terminal outcome
 * (finish()) or an explicit stop(), so a job can always be re-polled later once
 * the previous run has genuinely ended.
 */
const activePolls = new Map<string, true>();

/** True if `jobId` currently has a live pollGenerationJob() loop registered. */
export function isPollingJob(jobId: string): boolean {
  return activePolls.has(jobId);
}

/**
 * Poll GET /api/generation-jobs/[id] every 4s, diffing `results` against the last
 * seen snapshot so each slot's terminal callback fires exactly once. Stops on a
 * terminal job status (done/partial/failed) or after a 15-minute wall-clock cap —
 * whichever comes first — firing onEnd exactly once either way. On timeout, every
 * slot still pending is reported failed to the caller (but the job row itself is
 * left alone; this is a client-side give-up, not a server mutation).
 *
 * Returns a `stop()` function the caller can invoke to cancel polling early
 * (e.g. component unmount) without firing onEnd. If `jobId` is already being
 * polled (see `activePolls`), this is a no-op that returns an inert stop() —
 * the caller silently joins the existing loop's eventual callbacks instead of
 * starting a duplicate one.
 */
export function pollGenerationJob(
  jobId: string,
  cb: PollGenerationCallbacks,
  opts?: { intervalMs?: number; timeoutMs?: number },
): { stop: () => void } {
  if (activePolls.has(jobId)) {
    return { stop: () => {} };
  }
  activePolls.set(jobId, true);

  const intervalMs = opts?.intervalMs ?? POLL_INTERVAL_MS;
  const timeoutMs = opts?.timeoutMs ?? POLL_TIMEOUT_MS;
  const startedAt = Date.now();
  const seen = new Map<number, "pending" | "done" | "failed">();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clear() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function finish(status: GenerationJobStatus | "timeout") {
    if (stopped) return;
    stopped = true;
    clear();
    activePolls.delete(jobId);
    cb.onEnd(status);
  }

  async function tick() {
    if (stopped) return;

    if (Date.now() - startedAt >= timeoutMs) {
      // Any slot never resolved is reported failed to the caller (client-side give-up).
      for (const [slot, status] of seen) {
        if (status === "pending") cb.onSlot(slot, "failed");
      }
      finish("timeout");
      return;
    }

    try {
      const res = await fetch(`/api/generation-jobs/${jobId}`, { headers: await authHeaders() });
      if (!res.ok) {
        // Transient fetch/auth hiccup — keep polling until the overall timeout.
        schedule();
        return;
      }
      const body = await res.json() as { status?: GenerationJobStatus; results?: GenerationJobResult[] };
      const results = Array.isArray(body.results) ? body.results : [];

      for (const r of results) {
        const prev = seen.get(r.slot);
        if (prev === "done" || prev === "failed") continue; // already reported terminal — never repeat
        if (r.status === "done") {
          seen.set(r.slot, "done");
          cb.onSlot(r.slot, "done", r.imageUrl ?? undefined);
        } else if (r.status === "failed") {
          seen.set(r.slot, "failed");
          cb.onSlot(r.slot, "failed");
        } else {
          seen.set(r.slot, "pending");
        }
      }

      const status = body.status;
      if (status === "done" || status === "partial" || status === "failed") {
        // Terminal job status — any slot the row never resolved (should not normally
        // happen alongside a terminal status, but guards a malformed row) is failed.
        for (const [slot, s] of seen) {
          if (s === "pending") cb.onSlot(slot, "failed");
        }
        finish(status);
        return;
      }
    } catch {
      // Network error — keep polling until the overall timeout decides.
    }
    schedule();
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => { void tick(); }, intervalMs);
  }

  void tick();

  return {
    stop: () => { stopped = true; clear(); activePolls.delete(jobId); },
  };
}
