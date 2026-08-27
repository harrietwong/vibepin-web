/**
 * GET /api/cron/publish-due — server-side auto-publisher for due Pins (PRD WP-A).
 *
 * Trigger: a VPS crontab hits this every ~5 min with a bearer secret (Vercel Hobby cron
 * is once-a-day, unusable). See docs/运维/自动发布-cron配置.md. It is HTTP-free of any
 * per-user session — it acts across all users via the service-role client.
 *
 * Correctness model (why this is safe to fire repeatedly / from >1 caller):
 *   1. SCAN   scheduled_at <= now(), live (not deleted/archived/posted), limit ≤ 20.
 *   2. CLAIM  one atomic conditional UPDATE … RETURNING sets publish_claimed_at = now()
 *             ONLY on rows still claimable (unclaimed OR claim older than 10 min). Only
 *             the RETURNING rows are ours — a racing worker's claim excludes them here.
 *   3. PUBLISH each claimed row independently (own try/catch): publishPinForUser →
 *             on success mark posted + clear scheduling; on failure/throw record WP-B
 *             failure semantics + clear scheduling (so it leaves the due scan, no storm).
 *
 * KNOWN MVP LIMITATION (at-least-once): the claim UPDATE and the result UPDATE are two
 * steps. If the process dies AFTER Pinterest creates the Pin but BEFORE we persist the
 * success, the row's claim goes stale (10 min) and it is re-claimed and re-published —
 * publishPinForUser has no idempotency key against Pinterest. A durable idempotency key
 * is the P1 follow-up; the window is small and bounded.
 *
 * maxDuration 300 = current Vercel Hobby cap; the limit ≤ 20 keeps a run well under it.
 */

import { createServerClient } from "@/lib/supabase";
import { consumeScheduledPost, deriveScheduledPostKey } from "@/lib/server/usage/meterScheduledPost";
import { publishPinForUser } from "@/lib/server/pinterest/publishPin";
import { PinterestTrialAccessError } from "@/lib/server/pinterest/service";
import { resolveScheduledDestinations } from "@/lib/social/scheduledDestinations";
import {
  createPublishJob,
  fanOutDestinations,
  pinterestOutcomeRow,
  recordOutcomes,
} from "@/lib/social/publishFanout";
import { pendingDestinations, type DestinationOutcome } from "@/lib/social/publishRules";
import {
  recordPublishEvent,
  recordFailedPublishEvent,
  newPublishAttemptId,
  PUBLISH_EVENT_ATTEMPTED,
  PUBLISH_EVENT_SUCCEEDED,
  type PublishEventBase,
} from "@/lib/server/publishEvents";
import {
  staleClaimCutoffIso,
  payloadToPublishInput,
  payloadAfterOutcomes,
  payloadAfterFailure,
  destinationPublishInput,
  describeThrown,
} from "./publishDueLogic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TABLE = "pin_drafts";
const DUE_LIMIT = 20; // ≤ 20 per run so one invocation stays comfortably under maxDuration.

type DueRow = {
  vibepin_user_id: string;
  draft_id: string;
  payload: Record<string, unknown>;
  /** The due instant — the stable half of the 5B metering idempotency key. */
  scheduled_at: string | null;
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** Quote a value for a PostgREST or=() filter (timestamps contain ':' and '+').
 *  Mirrors the helper in /api/pin-drafts/route.ts. */
function pgQuote(value: string): string {
  return `"${value.replace(/["\\]/g, "")}"`;
}

/** pin_drafts / v42 columns not applied yet → degrade to an empty run, not a 500. */
function isMissingSchemaError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const message = err.message ?? "";
  return (
    err.code === "PGRST205" || err.code === "42P01"        // missing table
    || err.code === "PGRST204" || err.code === "42703"     // missing column (scheduled_at / publish_claimed_at)
    || message.includes("Could not find the table")
    || (message.includes("relation") && message.includes("does not exist"))
    || (message.includes("Could not find the") && message.includes("column"))
    || (message.includes("column") && message.includes("does not exist"))
  );
}

export async function GET(req: Request): Promise<Response> {
  // ── Auth: bearer CRON_SECRET. Missing config ⇒ 503 (never run unauthenticated). ──
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron/publish-due] CRON_SECRET is not configured — refusing to run.");
    return json({ error: "cron_not_configured", code: "cron_not_configured" }, 503);
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return json({ error: "unauthorized", code: "unauthorized" }, 401);
  }

  const db = createServerClient();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // ── 1) SCAN due, live rows ───────────────────────────────────────────────────
  const { data: dueRows, error: scanError } = await db
    .from(TABLE)
    // scheduled_at is selected because it is the STABLE half of the metering
    // idempotency key (Phase 5B). Claim time is not usable: it is regenerated on
    // every run, so a stale re-claim would mint a new key and double-count.
    .select("vibepin_user_id, draft_id, payload, scheduled_at")
    .lte("scheduled_at", nowIso)
    .not("scheduled_at", "is", null)
    .is("deleted_at", null)
    .is("archived_at", null)
    .order("scheduled_at", { ascending: true })
    .limit(DUE_LIMIT);

  if (scanError) {
    if (isMissingSchemaError(scanError)) return json({ claimed: 0, published: 0, failed: 0, skipped: 0 });
    console.error("[cron/publish-due] scan error:", scanError.message);
    return json({ error: "scan_failed", code: "database_unavailable" }, 503);
  }

  const candidates = (dueRows ?? []) as DueRow[];
  if (candidates.length === 0) return json({ claimed: 0, published: 0, failed: 0, skipped: 0 });

  // ── 2) CLAIM atomically. One conditional UPDATE … RETURNING per row: set the lock
  //    only when the row is still claimable (unclaimed OR the prior claim is stale).
  //    PostgREST returns exactly the updated rows; a racing worker's claim excludes it. ─
  const staleCutoff = staleClaimCutoffIso(nowMs);
  const claimed: DueRow[] = [];
  let skipped = 0;

  for (const row of candidates) {
    const { data: won, error: claimError } = await db
      .from(TABLE)
      .update({ publish_claimed_at: nowIso })
      .eq("vibepin_user_id", row.vibepin_user_id)
      .eq("draft_id", row.draft_id)
      .or(`publish_claimed_at.is.null,publish_claimed_at.lt.${pgQuote(staleCutoff)}`)
      .select("vibepin_user_id, draft_id, payload, scheduled_at");

    if (claimError) {
      // A schema hiccup mid-run: treat as un-claimable, don't crash the batch.
      console.error("[cron/publish-due] claim error:", claimError.message);
      skipped++;
      continue;
    }
    if (won && won.length > 0) claimed.push(won[0] as DueRow);
    else skipped++; // lost the race to another worker / already-claimed
  }

  // ── 3) PUBLISH each claimed row independently ────────────────────────────────
  let published = 0;
  let failed = 0;

  for (const row of claimed) {
    // Per-row publish attempt: one publishAttemptId ties this row's attempted →
    // succeeded/failed events. boardId comes from the stored payload (may be "" if the
    // payload is unpublishable). Analytics is best-effort — see lib/server/publishEvents.ts.
    const eventBase: PublishEventBase = {
      publishAttemptId: newPublishAttemptId(),
      userId: row.vibepin_user_id,
      draftId: typeof row.draft_id === "string" && row.draft_id ? row.draft_id : null,
      boardId: typeof row.payload?.boardId === "string" ? row.payload.boardId : "",
      source: "scheduled-cron",
    };
    const rowStartedMs = Date.now();
    void recordPublishEvent(db, PUBLISH_EVENT_ATTEMPTED, eventBase);
    try {
      const input = payloadToPublishInput(row.vibepin_user_id, row.payload);
      if (!input) {
        // Unpublishable payload (missing image/board): record a content failure, don't call Pinterest.
        // NO metering here — the contract charges only actions that really attempt
        // delivery, and this row never reaches Pinterest.
        await persistFailure(db, row, { message: "Missing image or board — cannot publish", code: "bad_request" }, nowIso);
        void recordFailedPublishEvent(db, eventBase, Date.now() - rowStartedMs, {
          code: "bad_request",
          message: "Missing image or board — cannot publish",
        });
        failed++;
        continue;
      }

      // ── Phase 5B: meter the scheduled post ────────────────────────────────────
      // Keyed on (draft_id, scheduled_at), NOT on claim time and NOT on the success
      // event. This route is at-least-once by construction (see the header): a death
      // between the Pinterest create and persistSuccess leaves a stale claim that is
      // re-claimed and re-published. Because scheduled_at is only cleared by
      // persistSuccess, a re-claim of that same row derives the IDENTICAL key, and
      // usage_consume_scheduled_post collapses the replay to one charge. Metering
      // before the provider call also means a crash mid-publish still recorded the
      // attempt the user really made. Fail-open in shadow: consumeScheduledPost never
      // throws, so a ledger outage cannot stop a scheduled publish.
      await consumeScheduledPost({
        userId: row.vibepin_user_id,
        key: deriveScheduledPostKey(row.vibepin_user_id, String(row.draft_id ?? ""), row.scheduled_at),
        referenceId: typeof row.draft_id === "string" ? row.draft_id : null,
        metadata: { source: "scheduled-cron" },
      });

      // ── The destinations this Content was scheduled to ────────────────────────
      // A legacy Pin (scheduled before intent was stored) resolves to Pinterest-only
      // here, so it behaves exactly as it did before: no extra platforms are ever
      // invented for it, and exactly one Pinterest publish happens.
      const intent = resolveScheduledDestinations(row.payload as Parameters<typeof resolveScheduledDestinations>[0]);
      // What is still owed. A row re-claimed after a stale lock (this route is
      // at-least-once by construction — see the header) must not re-publish the
      // account that already succeeded; `pendingDestinations` is keyed by ACCOUNT,
      // so two accounts on one platform retry independently.
      const priorResults = Array.isArray(row.payload.destinationResults)
        ? (row.payload.destinationResults as Array<{ provider: string; status: string; socialConnectionId?: string | null }>)
        : [];
      const owed = pendingDestinations(intent, priorResults);
      const pinterestTargets = owed.filter(d => d.provider === "pinterest");
      const extras = owed.filter(d => d.provider !== "pinterest");
      const legacyTarget = typeof row.payload.targetConnectionId === "string" ? row.payload.targetConnectionId.trim() : "";

      const outcomes: DestinationOutcome[] = [];
      let adoptedConnectionId: string | null = null;
      let firstFailure: { code?: string; message: string } | null = null;
      let trialBlocked = 0;

      // ── Publish EVERY Pinterest destination, each to its own account+board ────
      // One account failing must not abandon the others or the social fan-out: each
      // gets its own try/catch and its own result row. Before this, a Content with
      // two Pinterest accounts published to one of them and the second silently
      // never happened.
      for (const destination of pinterestTargets) {
        const perDestination = destinationPublishInput(input, destination, legacyTarget);
        if (!perDestination) {
          outcomes.push({
            provider: "pinterest", status: "failed",
            socialConnectionId: destination.socialConnectionId ?? null,
            error: "Choose a Pinterest board before publishing.",
          });
          if (!firstFailure) firstFailure = { code: "bad_request", message: "Choose a Pinterest board before publishing." };
          continue;
        }
        try {
          const result = await publishPinForUser(perDestination);
          if (result.ok) {
            // Adopt-once (PRD §14) applies only to a Content that named no account.
            if (!destination.socialConnectionId && result.connectionId) adoptedConnectionId = result.connectionId;
            outcomes.push(pinterestOutcomeRow(destination, {
              ok: true, connectionId: result.connectionId,
              pinId: result.pin.id, pinUrl: result.pin.url,
            }));
          } else {
            outcomes.push(pinterestOutcomeRow(destination, {
              ok: false, connectionId: result.connectionId, error: result.error,
            }));
            if (!firstFailure) firstFailure = { code: result.code, message: result.error };
          }
        } catch (err) {
          if (err instanceof PinterestTrialAccessError) {
            // Not a failure — the Content is publishable, just not until Pinterest
            // grants access. Record nothing for this destination so the row keeps its
            // schedule (handled after the loop).
            trialBlocked++;
            continue;
          }
          const described = describeThrown(err);
          outcomes.push(pinterestOutcomeRow(destination, { ok: false, error: described.message }));
          if (!firstFailure) firstFailure = described;
        }
      }

      // Every attempted Pinterest destination was blocked by trial access and nothing
      // else was owed: keep today's behaviour exactly — release the claim, leave the
      // payload and scheduled_at untouched so the row is re-scanned until approved.
      if (trialBlocked > 0 && outcomes.length === 0 && extras.length === 0) {
        await releaseClaim(db, row);
        void recordFailedPublishEvent(db, eventBase, Date.now() - rowStartedMs, {
          code: "pinterest_trial_access", message: "Pinterest access is still under review",
        });
        skipped++;
        continue;
      }

      // ── Fan out to the non-Pinterest destinations ─────────────────────────────
      // Runs BEFORE the persist so a fan-out crash cannot leave the Content marked
      // posted with no record of the platforms that were still owed.
      if (extras.length) {
        try {
          const jobId = await createPublishJob(
            db,
            row.vibepin_user_id,
            typeof row.draft_id === "string" ? row.draft_id : null,
            null,
          );
          const fanned = await fanOutDestinations(row.vibepin_user_id, extras, {
            // The whole media set, in display order — a Content scheduled as a
            // carousel must fan out as one, not as its cover image.
            imageUrls: input.imageUrls,
            title: input.title,
            caption: input.description,
            destinationUrl: input.link,
            altText: input.altText,
          });
          outcomes.push(...fanned);
          if (jobId) await recordOutcomes(db, jobId, outcomes);
        } catch (fanErr) {
          // A fan-out failure must never undo a Pinterest publish that already
          // succeeded, so it is logged and the Content still completes as posted.
          console.error("[cron/publish-due] fan-out:", (fanErr as Error).message);
        }
      }

      if (!outcomes.length) {
        // Nothing was owed at all (every destination had already published on an
        // earlier attempt). Clear the schedule so the row leaves the due scan.
        await persistOutcomes(db, row, [], nowIso, null);
        skipped++;
        continue;
      }

      await persistOutcomes(db, row, outcomes, nowIso, adoptedConnectionId);
      const anyPublished = outcomes.some(o => o.status === "published");
      if (anyPublished) {
        const pin = outcomes.find(o => o.provider === "pinterest" && o.status === "published");
        void recordPublishEvent(db, PUBLISH_EVENT_SUCCEEDED, {
          ...eventBase,
          durationMs: Date.now() - rowStartedMs,
          remotePinId: pin?.externalPostId ?? undefined,
          remotePinUrl: pin?.externalPostUrl ?? undefined,
        });
        published++;
      } else {
        void recordFailedPublishEvent(db, eventBase, Date.now() - rowStartedMs, {
          code: firstFailure?.code,
          message: firstFailure?.message ?? "Publish failed",
        });
        failed++;
      }
    } catch (err) {
      if (err instanceof PinterestTrialAccessError) {
        // Trial/Standard-access block is NOT a real publish failure — the Pin is
        // publishable, just not until Pinterest grants access. DraftDetailsDrawer.tsx
        // (WP-B) keeps the same exemption client-side: "save this Pin and publish
        // after access is approved". Cron must be consistent: only release the claim,
        // leave payload/scheduled_at untouched so the row is re-scanned (and skipped
        // again) on every future run until the account is approved. (The per-destination
        // loop above handles the same error for a Pinterest entry; this catches it from
        // anywhere else in the row's processing.)
        await releaseClaim(db, row);
        // Draft-wise this is a skip (row stays scheduled, no failure written), but the
        // publish ATTEMPT did terminate — Pinterest refused it. Record the terminal event
        // (code pinterest_trial_access) so this attempt's `attempted` never dangles like a
        // process death; the eventual post-approval publish is a new attempt id.
        void recordFailedPublishEvent(db, eventBase, Date.now() - rowStartedMs, err);
        skipped++;
        continue;
      }
      // Thrown connection/API error (needs_reconnect / not_connected / api). Mark this
      // ONE row failed (via mapPublishErrorToCategory → auth/transient) and move on —
      // a single expired account never aborts the batch, and no retry storm (scheduling
      // is cleared so the row leaves the due scan).
      await persistFailure(db, row, describeThrown(err), nowIso);
      void recordFailedPublishEvent(db, eventBase, Date.now() - rowStartedMs, err);
      failed++;
    }
  }

  return json({ claimed: claimed.length, published, failed, skipped });
}

/**
 * Persist what the attempt achieved across ALL its destinations.
 *
 * Replaces the success/failure pair for the multi-destination path: with two Pinterest
 * accounts, "one published, one failed" is neither, and forcing it into one of them
 * would either lose the failure or mark a delivered Pin as failed. `scheduled_at` is
 * cleared either way — a partial success must not re-fire and double-post the account
 * that worked, and a total failure leaves the due scan (no retry storm), exactly as
 * before.
 */
async function persistOutcomes(
  db: ReturnType<typeof createServerClient>,
  row: DueRow,
  outcomes: readonly DestinationOutcome[],
  nowIso: string,
  connectionId?: string | null,
): Promise<void> {
  const payload = payloadAfterOutcomes(row.payload, outcomes, nowIso, connectionId);
  const { error } = await db
    .from(TABLE)
    .update({
      payload,
      status: typeof payload.status === "string" ? payload.status : null,
      updated_at: nowIso,
      scheduled_at: null,       // no longer due
      publish_claimed_at: null, // release the claim
    })
    .eq("vibepin_user_id", row.vibepin_user_id)
    .eq("draft_id", row.draft_id);
  if (error) console.error("[cron/publish-due] persist success error:", error.message);
}

/** Persist the failure payload (WP-B §11.5 fields + cleared scheduling + cleared claim). */
async function persistFailure(
  db: ReturnType<typeof createServerClient>,
  row: DueRow,
  fail: { message: string; code?: string },
  nowIso: string,
  connectionId?: string | null,
): Promise<void> {
  const payload = payloadAfterFailure(row.payload, fail, nowIso, connectionId);
  const { error } = await db
    .from(TABLE)
    .update({
      payload,
      status: typeof payload.status === "string" ? payload.status : null,
      updated_at: nowIso,
      scheduled_at: null,       // drop out of the due scan (no retry storm)
      publish_claimed_at: null, // release the claim
    })
    .eq("vibepin_user_id", row.vibepin_user_id)
    .eq("draft_id", row.draft_id);
  if (error) console.error("[cron/publish-due] persist failure error:", error.message);
}

/** Release only the claim lock, leaving payload/scheduled_at untouched — used for the
 *  trial-access exemption (not a failure, just "not yet"; the row must remain due). */
async function releaseClaim(db: ReturnType<typeof createServerClient>, row: DueRow): Promise<void> {
  const { error } = await db
    .from(TABLE)
    .update({ publish_claimed_at: null })
    .eq("vibepin_user_id", row.vibepin_user_id)
    .eq("draft_id", row.draft_id);
  if (error) console.error("[cron/publish-due] release claim error:", error.message);
}
