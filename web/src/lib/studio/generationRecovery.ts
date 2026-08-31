"use client";

/**
 * WP3-P2: refresh/reload recovery for in-flight generation jobs.
 *
 * StudioBoard used to call pinDraftStore.failStaleGeneratingDrafts() unconditionally
 * on mount — correct for inline-mode generation (the client promise dies with the
 * page, so a "generating" card found on mount really is dead), but WRONG for
 * worker-mode: the generation_jobs row lives server-side and keeps running across a
 * reload. reconcileGeneratingDrafts() replaces that blind kill with a per-job check:
 *
 *   - generating drafts WITHOUT a generationJobId → inline-mode leftovers. Judged
 *     dead exactly as before (delegates to failStaleGeneratingDrafts(true), the
 *     "only drafts without a jobId" mode — behavior for this partition is unchanged).
 *   - generating drafts WITH a generationJobId → grouped by jobId, one
 *     GET /api/generation-jobs/[id] per group:
 *       - terminal (done/partial/failed) → applied immediately, per slot, matched by
 *         draft.generationSlot against results[slot] (NOT array order — order is not
 *         stable after a localStorage reload).
 *       - queued/running → left in "generating" and handed to pollGenerationJob to
 *         resume live updates (activePolls in generateAiVersions.ts prevents a second
 *         concurrent poll loop for the same jobId).
 *       - 404 / malformed body → the whole job's cards are judged dead (job doesn't
 *         exist or isn't ours — nothing will ever resolve them).
 *       - network/5xx ambiguity → retried once; a second unknown outcome remains
 *         recoverable and cannot become a fresh user Retry.
 *
 * Recovery bodies are origin-local but owner-bound. Before any POST/GET, one
 * network-verified Supabase owner/token pair is captured; drafts belonging to a
 * different (or unknown) owner cause zero requests and remain available when their
 * original owner signs back in.
 */

import * as pinDraftStore from "@/lib/pinDraftStore";
import {
  pollGenerationJob,
  verifiedGenerationAuthContext,
  type GenerationJobResult,
  type GenerationJobStatus,
  type VerifiedGenerationAuthContext,
} from "@/lib/studio/generateAiVersions";

type JobStatusBody = { status?: GenerationJobStatus; results?: GenerationJobResult[] };
type RecoveredIntentBody = { jobId?: string; slots?: number };
type RecoveryProbe<T> =
  | { kind: "ok"; body: T }
  | { kind: "definitive_failure" }
  | { kind: "unknown" };

export type GenerationRecoveryOptions = {
  intervalMs?: number;
  timeoutMs?: number;
  /** Test-only: production always resolves a network-verified immutable context. */
  authContext?: VerifiedGenerationAuthContext;
  /** Test-only transport seam. */
  fetchImpl?: typeof fetch;
};

async function fetchJobStatus(
  jobId: string,
  authContext: VerifiedGenerationAuthContext,
  send: typeof fetch,
): Promise<RecoveryProbe<JobStatusBody>> {
  try {
    const res = await send(`/api/generation-jobs/${jobId}`, { headers: authContext.headers });
    if (res.status === 404) return { kind: "definitive_failure" };
    if (!res.ok) return res.status >= 500 ? { kind: "unknown" } : { kind: "definitive_failure" };
    const body = await res.json() as JobStatusBody;
    if (!body || typeof body.status !== "string" || !Array.isArray(body.results)) {
      return { kind: "unknown" };
    }
    return { kind: "ok", body };
  } catch {
    return { kind: "unknown" };
  }
}

/** One retry only for an unknown transport/server outcome; definitive 4xx stops. */
async function fetchJobStatusWithRetry(
  jobId: string,
  authContext: VerifiedGenerationAuthContext,
  send: typeof fetch,
): Promise<RecoveryProbe<JobStatusBody>> {
  const first = await fetchJobStatus(jobId, authContext, send);
  if (first.kind !== "unknown") return first;
  return fetchJobStatus(jobId, authContext, send);
}

/** Apply a terminal (done/partial/failed) job's results to its drafts, matched by generationSlot. */
function applyTerminalResults(drafts: PinDraftLike[], results: GenerationJobResult[]) {
  const bySlot = new Map(results.map(r => [r.slot, r]));
  for (const d of drafts) {
    const slot = d.generationSlot;
    const r = slot !== undefined ? bySlot.get(slot) : undefined;
    if (r && r.status === "done" && r.imageUrl) {
      pinDraftStore.completeGeneratedDraft(d.id, r.imageUrl);
    } else {
      // No matching slot in the response, or that slot failed — either way the card
      // cannot resolve. failGeneratedDraft is idempotent so this is safe to call even
      // if it was already marked failed by a concurrent path.
      pinDraftStore.failGeneratedDraft(d.id);
    }
  }
}

function killDrafts(drafts: PinDraftLike[]) {
  for (const d of drafts) pinDraftStore.failGeneratedDraft(d.id);
}

type PinDraftLike = {
  id: string;
  generationSlot?: number;
  generationJobId?: string;
  generationIntentId?: string;
  generationIntentPayload?: Record<string, unknown>;
  generationIntentOwnerId?: string;
  generationRecoveryPending?: boolean;
};

async function recoverJobIdFromIntent(
  payload: Record<string, unknown>,
  authContext: VerifiedGenerationAuthContext,
  send: typeof fetch,
): Promise<RecoveryProbe<RecoveredIntentBody>> {
  const serialized = JSON.stringify(payload);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await send("/api/generate", {
        method: "POST",
        headers: authContext.headers,
        body: serialized,
      });
      if (!response.ok) {
        if (response.status >= 500) continue;
        return { kind: "definitive_failure" };
      }
      const body = await response.json() as RecoveredIntentBody;
      return body.jobId && typeof body.slots === "number"
        ? { kind: "ok", body }
        : { kind: "unknown" };
    } catch {
      // One bounded retry replays the exact persisted intent body.
    }
  }
  return { kind: "unknown" };
}

/**
 * Reconcile every board draft still in a "generating" state on mount. Fire-and-forget
 * from the caller's perspective (StudioBoard calls `void reconcileGeneratingDrafts()`)
 * — all outcomes land via the normal pinDraftStore mutations (completeGeneratedDraft /
 * failGeneratedDraft), which already notify subscribers, so the board re-renders as
 * each job resolves without this function returning anything the caller needs.
 *
 * `pollOpts` is test-only plumbing (overrides pollGenerationJob's interval/timeout so
 * unit tests don't hang on the real 4s/15min defaults) — production callers never pass it.
 */
export async function reconcileGeneratingDrafts(options?: GenerationRecoveryOptions): Promise<void> {
  const generating = pinDraftStore.generatingDrafts();
  if (!generating.length) return;

  // Resolve one immutable, network-verified owner/token pair before reading any
  // recovery payload. If signed out or verification fails, do nothing: preserving
  // A's record is safer than either replaying it anonymously or mutating it for B.
  let authContext: VerifiedGenerationAuthContext;
  try {
    authContext = options?.authContext ?? await verifiedGenerationAuthContext();
  } catch {
    return;
  }
  const send = options?.fetchImpl ?? fetch;

  // localStorage is origin-wide. Only the exact verified owner may inspect/replay
  // its recovery records. Ownerless legacy rows and another user's rows remain
  // untouched and cause ZERO requests; the original owner can recover after login.
  const owned = generating.filter(d => d.generationIntentOwnerId === authContext.ownerId);
  if (!owned.length) return;

  // A response can be lost after the DB commit but before onWorkerJob stores jobId.
  // Recover those cards by replaying their exact persisted intent before judging any
  // no-job placeholder dead. The DB anchor returns the original job.
  const withoutJobId = owned.filter(d => !d.generationJobId);
  const recoverable = new Map<string, PinDraftLike[]>();
  const unrecoverable: PinDraftLike[] = [];
  for (const draft of withoutJobId) {
    if (draft.generationIntentId && draft.generationIntentPayload) {
      const list = recoverable.get(draft.generationIntentId) ?? [];
      list.push(draft);
      recoverable.set(draft.generationIntentId, list);
    } else {
      unrecoverable.push(draft);
    }
  }
  killDrafts(unrecoverable);

  // Group the jobId-bearing drafts by job so each job is checked exactly once
  // regardless of how many slots/cards it has.
  const byJob = new Map<string, PinDraftLike[]>();
  for (const d of owned) {
    if (!d.generationJobId) continue;
    const list = byJob.get(d.generationJobId) ?? [];
    list.push(d);
    byJob.set(d.generationJobId, list);
  }

  for (const drafts of recoverable.values()) {
    const payload = drafts[0].generationIntentPayload;
    if (!payload) { killDrafts(drafts); continue; }
    const recovered = await recoverJobIdFromIntent(payload, authContext, send);
    if (recovered.kind === "unknown") {
      drafts.forEach(draft => pinDraftStore.updateDraft(draft.id, {
        generationStatus: "generating",
        generationRecoveryPending: true,
      }));
      continue;
    }
    if (recovered.kind === "definitive_failure") { killDrafts(drafts); continue; }
    const { jobId } = recovered.body;
    if (!jobId) { killDrafts(drafts); continue; }
    const slotDrafts = drafts.map((draft, slot) => ({
      ...draft,
      generationSlot: draft.generationSlot ?? slot,
    }));
    for (const draft of slotDrafts) {
      pinDraftStore.updateDraft(draft.id, {
        generationJobId: jobId,
        generationSlot: draft.generationSlot,
        generationRecoveryPending: false,
      });
    }
    byJob.set(jobId, slotDrafts);
  }

  await Promise.all(Array.from(byJob.entries()).map(async ([jobId, drafts]) => {
    const result = await fetchJobStatusWithRetry(jobId, authContext, send);
    if (result.kind === "unknown") {
      drafts.forEach(draft => pinDraftStore.updateDraft(draft.id, {
        generationStatus: "generating",
        generationRecoveryPending: true,
      }));
      return;
    }
    if (result.kind === "definitive_failure") {
      killDrafts(drafts);
      return;
    }

    const { status, results } = result.body;
    if (status === "done" || status === "partial" || status === "failed") {
      applyTerminalResults(drafts, results ?? []);
      return;
    }

    // queued/running — resume live polling. isPollingJob-style dedup lives inside
    // pollGenerationJob itself (activePolls) so a caller that already has a live
    // loop for this jobId (e.g. this function called twice in quick succession, or
    // StudioBoard's own enqueue-time poll still active) is a safe no-op here.
    pollGenerationJob(jobId, {
      onSlot: (slot, slotStatus, url) => {
        const draft = drafts.find(d => d.generationSlot === slot);
        if (!draft) return;
        if (slotStatus === "done" && url) {
          pinDraftStore.completeGeneratedDraft(draft.id, url);
        } else {
          pinDraftStore.failGeneratedDraft(draft.id);
        }
      },
      onEnd: () => {
        // No toast here — reconcile runs silently on mount/reload; StudioBoard's
        // own enqueue-time flow is what owns the user-facing toast copy.
      },
    }, { intervalMs: options?.intervalMs, timeoutMs: options?.timeoutMs });
  }));
}
