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
 *       - network error → retried once; a second failure judges the job's cards dead.
 */

import * as pinDraftStore from "@/lib/pinDraftStore";
import { authHeaders, pollGenerationJob, type GenerationJobResult, type GenerationJobStatus } from "@/lib/studio/generateAiVersions";

type JobStatusBody = { status?: GenerationJobStatus; results?: GenerationJobResult[] };

async function fetchJobStatus(jobId: string): Promise<{ ok: true; body: JobStatusBody } | { ok: false; notFound: boolean }> {
  try {
    const res = await fetch(`/api/generation-jobs/${jobId}`, { headers: await authHeaders() });
    if (res.status === 404) return { ok: false, notFound: true };
    if (!res.ok) return { ok: false, notFound: false };
    const body = await res.json() as JobStatusBody;
    if (!body || typeof body.status !== "string" || !Array.isArray(body.results)) {
      return { ok: false, notFound: false };
    }
    return { ok: true, body };
  } catch {
    return { ok: false, notFound: false };
  }
}

/** One retry on network/transport failure; a 404 (or a second failure) is NOT retried. */
async function fetchJobStatusWithRetry(jobId: string): Promise<{ ok: true; body: JobStatusBody } | { ok: false }> {
  const first = await fetchJobStatus(jobId);
  if (first.ok) return first;
  if (first.notFound) return { ok: false };
  const second = await fetchJobStatus(jobId);
  if (second.ok) return second;
  return { ok: false };
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

type PinDraftLike = { id: string; generationSlot?: number };

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
export async function reconcileGeneratingDrafts(pollOpts?: { intervalMs?: number; timeoutMs?: number }): Promise<void> {
  const generating = pinDraftStore.generatingDrafts();
  if (!generating.length) return;

  // Partition: no jobId → inline-mode leftovers, judged dead exactly as pre-P2.
  const withoutJobId = generating.filter(d => !d.generationJobId);
  if (withoutJobId.length) {
    pinDraftStore.failStaleGeneratingDrafts(true);
  }

  // Group the jobId-bearing drafts by job so each job is checked exactly once
  // regardless of how many slots/cards it has.
  const byJob = new Map<string, PinDraftLike[]>();
  for (const d of generating) {
    if (!d.generationJobId) continue;
    const list = byJob.get(d.generationJobId) ?? [];
    list.push(d);
    byJob.set(d.generationJobId, list);
  }

  await Promise.all(Array.from(byJob.entries()).map(async ([jobId, drafts]) => {
    const result = await fetchJobStatusWithRetry(jobId);
    if (!result.ok) {
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
    }, pollOpts);
  }));
}
