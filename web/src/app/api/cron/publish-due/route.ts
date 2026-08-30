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
 * maxDuration 300 = current Vercel Hobby cap. The batch limit (≤ 20) is a SIZE bound,
 * not a time bound — one Instagram publish alone can poll for ~45s — so the run also
 * keeps a wall-clock budget (CLAIM_BUDGET_MS) and stops CLAIMING once it is spent.
 * Unclaimed rows stay due for the next tick; that is strictly better than being killed
 * between a successful publish and its persist, which re-publishes the row 10 min later.
 */

import { createServerClient } from "@/lib/supabase";
import {
  consumeScheduledPost,
  deriveScheduledPostKey,
  releaseScheduledPost,
  usageEnforceFor,
} from "@/lib/server/usage/meterScheduledPost";
import {
  aggregateDelivery,
  classifyDelivery,
  isRefundable,
  readProviderSignal,
  type DeliveryOutcome,
} from "@/lib/server/usage/deliveryOutcome";
import { publishPinForUser } from "@/lib/server/pinterest/publishPin";
import {
  NeedsReconnectError,
  NotConnectedError,
  PinterestTrialAccessError,
} from "@/lib/server/pinterest/service";
import {
  createPublishJob,
  deferredOutcome,
  fanOutDestinations,
  hasTimeForDestination,
  pinterestOutcomeRow,
  recordOutcomes,
  trialAccessPendingOutcome,
} from "@/lib/social/publishFanout";
import type { DestinationOutcome } from "@/lib/social/publishRules";
import {
  recordPublishEvent,
  recordFailedPublishEvent,
  newPublishAttemptId,
  PUBLISH_EVENT_ATTEMPTED,
  PUBLISH_EVENT_SUCCEEDED,
  type PublishEventBase,
} from "@/lib/server/publishEvents";
import {
  mergeOutcomesIntoRow,
  writeFailure,
  writeOutcomes,
  type FinalWriteOptions,
  type RowIo,
} from "./persistRow";
import {
  CLAIM_BUDGET_MS,
  RUN_DEADLINE_MS,
  staleClaimCutoffIso,
  payloadToPublishInput,
  destinationPublishInput,
  describeThrown,
  owedDestinations,
  failedRowsForUnattempted,
  didNotCompleteMessage,
} from "./publishDueLogic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TABLE = "pin_drafts";
const DUE_LIMIT = 20; // ≤ 20 per run so one invocation stays comfortably under maxDuration.
/** Pause before the single persist retry — long enough for a transient blip, short
 *  enough that it cannot itself push the run past maxDuration. */
const PERSIST_RETRY_DELAY_MS = 500;

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

/**
 * The two database operations every persist is built from.
 *
 * Deliberately narrow. persistRow.ts owns the merge rules — re-read, apply onto the
 * LATEST payload, stamp at write time — and does not know Supabase exists, which is
 * what makes those rules testable against a fake row store.
 */
function rowIo(db: ReturnType<typeof createServerClient>): RowIo {
  return {
    read: async row => {
      const { data, error } = await db
        .from(TABLE)
        // `updated_at` is read so the write can be made conditional on it — see the
        // compare-and-set in `update` below.
        .select("payload, scheduled_at, publish_claimed_at, updated_at")
        .eq("vibepin_user_id", row.vibepin_user_id)
        .eq("draft_id", row.draft_id)
        .maybeSingle();
      if (error) return { snapshot: null, error: error.message };
      if (!data) return { snapshot: null, error: null };
      const r = data as {
        payload?: unknown; scheduled_at?: string | null;
        publish_claimed_at?: string | null; updated_at?: string | null;
      };
      return {
        snapshot: {
          payload: (r.payload && typeof r.payload === "object" ? r.payload : {}) as Record<string, unknown>,
          scheduled_at: r.scheduled_at ?? null,
          publish_claimed_at: r.publish_claimed_at ?? null,
          // Passed through as the RAW string PostgREST returned. Parsing and re-
          // formatting it would drop the microseconds Postgres keeps, and the filter
          // below would then match nothing, ever.
          updated_at: r.updated_at ?? null,
        },
        error: null,
      };
    },
    /**
     * Compare-and-set: the write applies only while the row still looks like `observed`.
     *
     * Filtering on user + draft_id alone let a reschedule made between the merge's read
     * and its write be overwritten — the run cleared a slot it had never seen. The two
     * observed columns are what the merge decided from, so they are what it is
     * conditional on. `select("draft_id")` makes PostgREST return the affected rows;
     * none means the row moved, and persistRow re-merges onto the new one.
     */
    update: async (row, values, observed) => {
      let q = db
        .from(TABLE)
        .update(values)
        .eq("vibepin_user_id", row.vibepin_user_id)
        .eq("draft_id", row.draft_id);
      // `.eq` never matches NULL in SQL — an unscheduled row needs `.is`.
      q = observed.scheduled_at === null
        ? q.is("scheduled_at", null)
        : q.eq("scheduled_at", observed.scheduled_at);
      q = observed.updated_at === null
        ? q.is("updated_at", null)
        : q.eq("updated_at", observed.updated_at);
      const { data, error } = await q.select("draft_id");
      if (error) return { error: error.message, matched: false };
      return { error: null, matched: Array.isArray(data) && data.length > 0 };
    },
  };
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
  const io = rowIo(db);
  // The run's wall clock. Everything time-bounded below measures from here.
  const startedMs = Date.now();
  const nowMs = startedMs;
  const nowIso = new Date(nowMs).toISOString();
  // The instant after which no further DESTINATION may be started. The row budget
  // below stops the run taking new work; this stops it starting work inside a row it
  // already holds — a Content with three Instagram accounts is three ~45s container
  // polls, and being killed part-way through means the accounts that already
  // published are published again ten minutes later.
  const deadlineMs = startedMs + RUN_DEADLINE_MS;

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
    if (isMissingSchemaError(scanError)) return json({ claimed: 0, published: 0, failed: 0, skipped: 0, deferred: 0 });
    console.error("[cron/publish-due] scan error:", scanError.message);
    return json({ error: "scan_failed", code: "database_unavailable" }, 503);
  }

  const candidates = (dueRows ?? []) as DueRow[];
  if (candidates.length === 0) return json({ claimed: 0, published: 0, failed: 0, skipped: 0, deferred: 0 });

  // ── 2+3) CLAIM then PUBLISH, one row at a time ───────────────────────────────
  //
  // CLAIM is a single atomic conditional UPDATE … RETURNING: the lock is set only when
  // the row is still claimable (unclaimed OR the prior claim is stale). PostgREST
  // returns exactly the updated rows; a racing worker's claim excludes it.
  //
  // Claiming and publishing are INTERLEAVED on purpose. Claiming all 20 up front takes
  // milliseconds, so a time check there could never fire — the time is spent publishing.
  // Interleaved, the seconds row N spends publishing are what stop row N+1 from being
  // claimed once the budget is gone. A row we never claim is untouched: still due, still
  // unclaimed, taken by the next tick.
  const staleCutoff = staleClaimCutoffIso(nowMs);
  let claimedCount = 0;
  let skipped = 0;
  let deferred = 0;
  let published = 0;
  let failed = 0;

  for (const candidate of candidates) {
    // The budget is checked BEFORE the claim: an unclaimed row costs nothing, while a
    // claimed row we are killed before finishing is the double-post window.
    if (Date.now() - startedMs >= CLAIM_BUDGET_MS) {
      deferred++;
      continue;
    }

    // Stamped NOW, not at the top of the run: with claiming interleaved, a row can be
    // claimed minutes in, and a start-of-run stamp would shorten its 10-minute lock by
    // exactly that much — another worker could steal a row still being published.
    const claimIso = new Date().toISOString();
    const { data: won, error: claimError } = await db
      .from(TABLE)
      .update({ publish_claimed_at: claimIso })
      .eq("vibepin_user_id", candidate.vibepin_user_id)
      .eq("draft_id", candidate.draft_id)
      .or(`publish_claimed_at.is.null,publish_claimed_at.lt.${pgQuote(staleCutoff)}`)
      .select("vibepin_user_id, draft_id, payload, scheduled_at");

    if (claimError) {
      // A schema hiccup mid-run: treat as un-claimable, don't crash the batch.
      console.error("[cron/publish-due] claim error:", claimError.message);
      skipped++;
      continue;
    }
    if (!won || won.length === 0) {
      skipped++; // lost the race to another worker / already-claimed
      continue;
    }
    const row = won[0] as DueRow;
    claimedCount++;
    // No clock is captured here on purpose. Every persist below re-reads the row and
    // stamps itself at WRITE time (persistRow.ts): a timestamp taken now would already
    // be older than an edit the merchant makes during the publish, and the client's
    // LWW merge would push that edit — schedule and all — straight back.

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
    // Metering state for THIS row, declared at row scope so the outer catch below —
    // which handles a throw from anywhere in the row's processing, including before
    // the per-destination loop — can settle the refund too. `meterKey` stays null
    // until the consume actually runs; a null key means nothing was charged and
    // nothing can be refunded.
    let meterKey: string | null = null;
    // Whether THIS row's consume actually charged a unit (v68 `replayed:false`). Row
    // scope like meterKey, for the same reason: the outer catch settles too.
    let meterFresh = false;
    const meterReference = typeof row.draft_id === "string" ? row.draft_id : null;
    const deliveries: DeliveryOutcome[] = [];
    const settleMetering = async (): Promise<void> => {
      if (!meterKey) return;
      // ── ONLY A FRESH CONSUME MAY BE RELEASED (Codex round 7, High 1 + High 2) ──
      // `usage_release_scheduled_post` takes only (user, K, reason) and refunds the
      // family's standing consume regardless of which attempt asks, while K is shared
      // — this row's key is (draft_id, scheduled_at), and a re-claim of an unfinished
      // publish derives the IDENTICAL key on purpose (see the consume comment below).
      // So a re-claim whose consume merely REPLAYED must not release: the unit belongs
      // to the attempt that charged it, which may well have delivered. `fresh` is
      // v68's own `replayed:false`. `off` / `insufficient` / `error` consumes are
      // excluded too — none of them charged here.
      // Consequence worth stating, because it is the rule working as specified, not a
      // gap: this route is at-least-once, so a death after a not_sent failure but
      // before the release leaves the re-claim on a replayed consume, and that
      // re-claim's own failure is no longer refundable. The unit stays with the first
      // attempt. Do not "fix" this by dropping the gate.
      // Residual, deferred to publish-action identity (PRD v3.2 §21 5A): two
      // CONCURRENT attempts on one key where the fresh one fails and the replaying one
      // succeeds still refunds a delivered publish.
      if (!meterFresh) return;
      const outcome = aggregateDelivery(deliveries);
      if (!isRefundable(outcome)) return;
      await releaseScheduledPost({
        userId: row.vibepin_user_id,
        key: meterKey,
        reason: outcome,
        referenceId: meterReference,
        metadata: { source: "scheduled-cron", route: "cron_publish_due" },
      });
    };
    try {
      // `scheduled_at` rides into both: what is owed depends on the schedule being
      // processed, not on whether the destination has ever published. Without it, a
      // Posted Content the merchant re-scheduled owes nothing, and the run "completes"
      // it by clearing the slot they just chose.
      const owedFor = { scheduledAt: row.scheduled_at };

      // ── The destinations this Content still owes ──────────────────────────────
      // A legacy Pin (scheduled before intent was stored) resolves to Pinterest-only
      // here, so it behaves exactly as it did before: no extra platforms are ever
      // invented for it, and exactly one Pinterest publish happens. A row re-claimed
      // after a stale lock (this route is at-least-once by construction — see the
      // header) must not re-publish an account that already succeeded, which is why
      // this is what is OWED and not what was intended.
      //
      // Computed BEFORE the publish input, and that order is load-bearing.
      // `payloadToPublishInput` asks "does this Content need a Pinterest board?" by
      // checking that every OWED destination is Pinterest — and `every()` over an
      // EMPTY set is true. So a Content with nothing left to publish is treated as
      // needing a board, and an Instagram-only one (which has none, and never needed
      // one) came back null. That used to be unreachable; since results are persisted
      // incrementally it is not. Publish to Instagram, die before the final persist,
      // and the stale re-claim owes nothing, gets null here, and records a Content
      // that really did publish as "Missing image or board".
      const owed = owedDestinations(row.payload, owedFor);
      const priorResults = Array.isArray(row.payload.destinationResults)
        ? (row.payload.destinationResults as unknown[])
        : [];

      if (!owed.length && priorResults.length) {
        // Nothing to publish and a record of what already did: this run is finishing
        // an earlier one's work, not attempting anything. Complete the Content from
        // its own stored rows — no publish input, no provider, no failure. Metering is
        // skipped deliberately: nothing is delivered here, and the charge for this
        // (draft_id, scheduled_at) was already taken by the run that published.
        await persistOutcomes(io, row, []);
        skipped++;
        continue;
      }

      const input = payloadToPublishInput(row.vibepin_user_id, row.payload, owedFor);
      if (!input) {
        // Unpublishable payload (missing image/board): record a content failure, don't call Pinterest.
        // NO metering here — the contract charges only actions that really attempt
        // delivery, and this row never reaches Pinterest.
        await persistFailure(io, row, { message: "Missing image or board — cannot publish", code: "bad_request" });
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
      // Kept so a refund below releases the EXACT key that was charged.
      meterKey = deriveScheduledPostKey(row.vibepin_user_id, String(row.draft_id ?? ""), row.scheduled_at);
      const consumed = await consumeScheduledPost({
        userId: row.vibepin_user_id,
        key: meterKey,
        referenceId: meterReference,
        metadata: { source: "scheduled-cron" },
      });
      meterFresh = consumed.kind === "consumed" && consumed.fresh === true;

      // ── A.4.0 BLOCKING SITE — over-quota rows never reach a provider ──────────
      // The cron path cannot answer 402 to anyone, so the refusal is written into
      // the row instead: a `limit_reached` failure with §5.4's not_sent semantics
      // (nothing was charged — the consume was REFUSED, so there is nothing to
      // refund either) and, crucially, `scheduled_at` cleared by persistFailure.
      // Leaving it set would re-scan and re-refuse this row every five minutes for
      // as long as the user stays over limit — a retry storm made of failures the
      // user cannot clear by waiting. The merchant re-schedules once they have
      // capacity, exactly as with any other terminal failure. Shadow is unaffected:
      // usageEnforceFor is false unless the mode is `enforce` AND the per-type flag
      // is on, so this branch is unreachable today.
      if (consumed.kind === "insufficient" && usageEnforceFor("scheduled_post")) {
        await persistFailure(
          io,
          row,
          { message: "Scheduled post limit reached for this billing period.", code: "scheduled_post_limit_reached" },
        );
        void recordFailedPublishEvent(db, eventBase, Date.now() - rowStartedMs, {
          code: "scheduled_post_limit_reached",
          message: "Scheduled post limit reached for this billing period.",
        });
        failed++;
        continue;
      }

      /**
       * ── DELIVERY TRI-STATE → REFUND (design §A.4; PRD v3.2 §5.3/§5.4) ────────
       * Collected per destination and collapsed once at the end of the row, since
       * one Content is one charged unit however many destinations it has:
       *
       *   not_sent  (REFUND)  a destination with no usable board, a typed
       *                       publishPinForUser failure (bad_request /
       *                       invalid_image_url / invalid_link / board_not_owned /
       *                       carousel_*), a thrown NotConnectedError /
       *                       NeedsReconnectError, or a social target with no
       *                       connected account. None reached a provider.
       *   rejected  (REFUND)  a real provider 4xx with no resource id back.
       *   sent      (CHARGE)  ANY destination published — including one Pinterest
       *                       account succeeding while a second fails.
       *   delivery_unknown    5xx / timeout / an error carrying no provider status,
       *             (CHARGE)  or a row where nothing was attempted at all (every
       *                       destination had already published on an earlier
       *                       attempt — refunding there would give back a unit for
       *                       a Content that is live).
       *
       * PinterestTrialAccessError contributes nothing and never refunds: the row
       * keeps its schedule and will be re-charged under the SAME key on the next
       * pass, so refunding would churn release/re-consume pairs every five minutes
       * until the app is approved.
       *
       * Reads ONLY `providerStatus` / `providerResourceId` — never message text.
       */


      // Both reads of the owed set — this one and `payloadToPublishInput`'s
      // board requirement — take the same `owedFor`, so they can never disagree about
      // which platforms this run is for.
      const pinterestTargets = owed.filter(d => d.provider === "pinterest");
      const extras = owed.filter(d => d.provider !== "pinterest");
      const legacyTarget = typeof row.payload.targetConnectionId === "string" ? row.payload.targetConnectionId.trim() : "";

      const outcomes: DestinationOutcome[] = [];
      /**
       * Store ONE destination's outcome now, not at the end of the row.
       *
       * Between a provider's acknowledgement and the final persist sat every remaining
       * destination — minutes, in which a process kill lost the record of a post that
       * really exists and the next run sent it again. Written immediately, that run
       * reads a `published` row and owes nothing for it.
       *
       * Best-effort by design: a failed bookkeeping write is logged and the publish
       * continues. The final persist (which retries) is still the authoritative record.
       */
      const persistOne = async (outcome: DestinationOutcome): Promise<void> => {
        // `pending`/`skipped` describe nothing that happened — see outcomeRows.
        if (outcome.status !== "published" && outcome.status !== "failed") return;
        const { error: incErr } = await mergeOutcomesIntoRow(io, row, [outcome]);
        if (incErr) console.error("[cron/publish-due] incremental persist:", incErr);
      };
      /** Collect an outcome AND store it. */
      const record = async (outcome: DestinationOutcome): Promise<void> => {
        outcomes.push(outcome);
        await persistOne(outcome);
      };
      let adoptedConnectionId: string | null = null;
      let firstFailure: { code?: string; message: string } | null = null;
      let trialBlocked = 0;

      // ── Publish EVERY Pinterest destination, each to its own account+board ────
      // One account failing must not abandon the others or the social fan-out: each
      // gets its own try/catch and its own result row. Before this, a Content with
      // two Pinterest accounts published to one of them and the second silently
      // never happened.
      for (const destination of pinterestTargets) {
        if (!hasTimeForDestination(Date.now(), deadlineMs)) {
          // Not a failure and not a skip: nothing was sent, and this destination is
          // still owed. It keeps the Content scheduled (see the persist below) and the
          // next run attempts it — and only it.
          await record(deferredOutcome(destination));
          continue;
        }
        const perDestination = destinationPublishInput(input, destination, legacyTarget);
        if (!perDestination) {
          deliveries.push(classifyDelivery({ preNetwork: true }));
          await record({
            provider: "pinterest", status: "failed",
            socialConnectionId: destination.socialConnectionId ?? null,
            error: "Choose a Pinterest board before publishing.",
          });
          if (!firstFailure) firstFailure = { code: "bad_request", message: "Choose a Pinterest board before publishing." };
          continue;
        }
        try {
          const result = await publishPinForUser(perDestination);
          // A typed failure is decided before (or instead of) a create; a success is
          // a real Pin id. Either way this destination's state is known here.
          deliveries.push(classifyDelivery(result.ok ? { ok: true } : { preNetwork: true }));
          if (result.ok) {
            // Adopt-once (PRD §14) applies only to a Content that named no account.
            if (!destination.socialConnectionId && result.connectionId) adoptedConnectionId = result.connectionId;
            await record(pinterestOutcomeRow(destination, {
              ok: true, connectionId: result.connectionId,
              pinId: result.pin.id, pinUrl: result.pin.url,
            }));
          } else {
            await record(pinterestOutcomeRow(destination, {
              ok: false, connectionId: result.connectionId, error: result.error,
            }));
            if (!firstFailure) firstFailure = { code: result.code, message: result.error };
          }
        } catch (err) {
          if (err instanceof PinterestTrialAccessError) {
            // Not a failure — the Content is publishable, just not until Pinterest
            // grants access. It is recorded as PENDING so the row keeps its schedule and
            // this destination is owed again next run.
            //
            // Recording nothing here is what lost a trial-blocked destination in a MIXED
            // row: with another destination's failure already in `outcomes`, the
            // "every destination blocked" exemption below was skipped, the final persist
            // saw nothing pending, cleared the schedule, and this account was never
            // attempted again. `persistOne` stores nothing for a pending outcome, so the
            // row still carries no result for it — which is what makes it owed.
            trialBlocked++;
            await record(trialAccessPendingOutcome(destination));
            continue;
          }
          // Class first: our OWN connection errors carry an HTTP status we chose
          // (409/401) that no provider sent, so reading it as a provider rejection
          // would be exactly the mistake the two-field rule forbids.
          deliveries.push(
            err instanceof NotConnectedError || err instanceof NeedsReconnectError
              ? classifyDelivery({ preNetwork: true })
              : classifyDelivery(readProviderSignal(err)),
          );
          const described = describeThrown(err);
          await record(pinterestOutcomeRow(destination, { ok: false, error: described.message }));
          if (!firstFailure) firstFailure = described;
        }
      }

      // Every attempted Pinterest destination was blocked by trial access: keep today's
      // behaviour exactly — release the claim and leave the payload and scheduled_at
      // untouched, so the row is re-scanned until the account is approved.
      //
      // "Every one" now reads `outcomes.length === trialBlocked` rather than
      // `outcomes.length === 0`, because a blocked destination records a pending outcome
      // instead of nothing. The condition is the same set of rows as before: pending
      // trial rows are the ONLY thing in `outcomes` here. A row that also failed
      // elsewhere, or deferred on time, falls through to the ordinary persist — where the
      // pending row keeps the schedule for it just the same, and the failure is reported.
      //
      // This deliberately runs BEFORE the fan-out, extras or not. Trial access is an
      // APP-level block, so "every Pinterest entry blocked while IG/FB are also owed"
      // is the ordinary case, not an edge. Falling through would fan out, see a
      // published social row, mark the Content posted and clear its schedule — the
      // Pinterest entries would then have no result rows and nothing would ever
      // re-attempt them, breaking the promise that the Content keeps its slot until
      // Pinterest approves. The social destinations are re-attempted with it.
      if (trialBlocked > 0 && outcomes.length === trialBlocked) {
        // No refund: the row keeps its schedule and the SAME key is charged again
        // next pass, so a release here would only churn (see the mapping above).
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
      if (extras.length && !hasTimeForDestination(Date.now(), deadlineMs)) {
        // Every extra will be deferred, so no ATTEMPT is made — and no attempt row is
        // created. `customer360` and `adminOverview` read every `social_publish_jobs`
        // row as publishing that really happened; a job whose every destination is
        // pending would surface as activity that did not occur, and roll up to
        // `failed` when finalized.
        for (const destination of extras) outcomes.push(deferredOutcome(destination));
      } else if (extras.length) {
        // The job id must outlive the try: when the fan-out throws, the attempt still
        // has to be finalized with the failure rows below. A job row left in
        // `publishing` forever reads as a publish that is still in flight.
        let jobId: string | null = null;
        try {
          jobId = await createPublishJob(
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
          }, { deadlineMs, onOutcome: persistOne });
          outcomes.push(...fanned);
          // Defensive: an owed destination the fan-out returned no row for is not
          // "nothing happened", it is "nobody knows" — and silence there reads to the
          // merchant as a platform that was never even selected.
          const unreported = failedRowsForUnattempted(extras, didNotCompleteMessage, fanned);
          outcomes.push(...unreported);
          if (unreported.length && !firstFailure) {
            firstFailure = { message: unreported[0].error ?? "Publish failed" };
          }
          for (const f of fanned) {
            if (f.status === "skipped") continue; // never attempted, not a delivery failure
            deliveries.push(classifyDelivery({
              ok: f.status === "published",
              preNetwork: f.preNetwork,
              providerStatus: f.providerStatus,
              providerResourceId: f.providerResourceId ?? f.externalPostId ?? null,
            }));
          }
        } catch (fanErr) {
          // A fan-out failure must never undo a Pinterest publish that already
          // succeeded — but it must never be silent either. Before this, a throw was
          // logged and nothing else: the owed Instagram/Facebook destinations got no
          // result row at all, so the Content was marked posted from the Pinterest
          // result and the merchant had no way to learn the other platforms never
          // went out. Every owed destination now gets a failed row carrying the reason.
          const described = describeThrown(fanErr);
          console.error("[cron/publish-due] fan-out:", described.message);
          outcomes.push(...failedRowsForUnattempted(extras, described.message));
          if (!firstFailure) firstFailure = described;
        }
        // Recording the attempt must not itself become the reason a delivered publish
        // is reported as failed: its errors are logged, never thrown to the row's catch.
        try {
          if (jobId) await recordOutcomes(db, jobId, outcomes);
        } catch (recErr) {
          console.error("[cron/publish-due] record outcomes:", (recErr as Error).message);
        }
      }

      if (!outcomes.length) {
        // Nothing was owed at all (every destination had already published on an
        // earlier attempt). Clear the schedule so the row leaves the due scan.
        await persistOutcomes(io, row, []);
        // Explicitly NO refund: an empty attempt is not evidence of non-delivery —
        // this Content is live on every destination it named.
        skipped++;
        continue;
      }

      // Destinations the run had no time to start. They are still owed, so the
      // Content must keep its schedule — clearing it here is the "lost publish": the
      // merchant chose three platforms, two went out, and the third silently never
      // would have.
      const pending = outcomes.filter(o => o.status === "pending");
      const reported = outcomes.filter(o => o.status !== "pending" && o.status !== "skipped");
      if (pending.length && !reported.length) {
        // The run ran out of time before this row's FIRST destination. Nothing
        // happened, so nothing is written: release the claim and leave the payload and
        // scheduled_at exactly as they were, the same shape as the trial-access
        // exemption above. A payload write here would only bump updatedAt and push a
        // pointless LWW re-sync to every client.
        await releaseClaim(db, row);
        deferred++;
        continue;
      }

      // firstFailure carries the platform's stable CODE, which the outcome rows do not:
      // categorizing from the message alone would put a differently-worded
      // needs_reconnect in "transient" and offer the merchant the wrong fix.
      await persistOutcomes(io, row, outcomes, {
        connectionId: adoptedConnectionId,
        failureCode: firstFailure?.code,
        deferred: pending.length > 0,
      });
      // Refund decision for the whole row, once, after every destination is known.
      // Runs after the persist so a ledger hiccup can never delay writing what
      // actually happened (releaseScheduledPost is fail-open and never throws).
      await settleMetering();
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
      await persistFailure(io, row, describeThrown(err));
      // A throw that escaped the per-destination loops — the row failed as a whole.
      // Classify it the same way (class first, then the two provider fields) and
      // settle: if nothing was charged (`meterKey` still null, e.g. an unpublishable
      // payload) this is a no-op. The trial-access branch above already returned.
      deliveries.push(
        err instanceof NotConnectedError || err instanceof NeedsReconnectError
          ? classifyDelivery({ preNetwork: true })
          : classifyDelivery(readProviderSignal(err)),
      );
      await settleMetering();
      void recordFailedPublishEvent(db, eventBase, Date.now() - rowStartedMs, err);
      failed++;
    }
  }

  if (deferred > 0) {
    // Visible on purpose: a run that regularly defers is the signal to raise the tick
    // rate or lower DUE_LIMIT, and silence here would look like the rows never came due.
    console.warn(
      `[cron/publish-due] time budget spent after ${Date.now() - startedMs}ms — `
      + `${deferred} due row(s) left for the next run`,
    );
  }
  return json({ claimed: claimedCount, published, failed, skipped, deferred });
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
  io: RowIo,
  row: DueRow,
  outcomes: readonly DestinationOutcome[],
  options: FinalWriteOptions = {},
): Promise<void> {
  // The merge rules — re-read, apply onto the LATEST payload, stamp at write time,
  // clear the schedule only if it is still the one this run claimed — live in
  // persistRow.ts. Each attempt re-reads, so the retry below cannot write a payload
  // built from a snapshot the first attempt already found stale.
  const write = () => writeOutcomes(io, row, outcomes, options);

  // This write is the ONLY record that the publish above happened. Losing it means the
  // Content stays scheduled and claimed; ten minutes later the claim goes stale and the
  // row is published AGAIN — a second real post the merchant never asked for. One retry
  // costs half a second and covers the ordinary transient (a dropped connection, a
  // PostgREST 5xx).
  //
  // It must also NEVER throw: the row's catch calls persistFailure, which would overwrite
  // a delivered publish as failed AND clear scheduled_at + the claim. So every failure
  // mode ends here, loudly.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { error, gone } = await write();
      if (gone) {
        // Deleted while it was publishing. Re-creating it from this run's outcomes
        // would resurrect a Content the merchant threw away.
        console.warn(`[cron/publish-due] row vanished during publish draft_id=${String(row.draft_id)}`);
        return;
      }
      if (!error) return;
      if (attempt === 2) {
        // Nothing else to try. Log everything needed to reconstruct the row by hand —
        // the outcomes are otherwise lost with the process.
        console.error(
          `[cron/publish-due] persist outcomes FAILED after ${attempt} attempts`
          + ` draft_id=${String(row.draft_id)} user=${row.vibepin_user_id}: ${error}`
          + ` outcomes=${JSON.stringify(outcomes)}`,
        );
        // The claim is deliberately left in place: releasing it here would hand the row
        // straight back to the next run, which would publish it a second time.
        return;
      }
      console.error("[cron/publish-due] persist outcomes error (retrying):", error);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === 2) {
        console.error(
          `[cron/publish-due] persist outcomes THREW after ${attempt} attempts`
          + ` draft_id=${String(row.draft_id)} user=${row.vibepin_user_id}: ${message}`
          + ` outcomes=${JSON.stringify(outcomes)}`,
        );
        return;
      }
      console.error("[cron/publish-due] persist outcomes threw (retrying):", message);
    }
    await new Promise(resolve => setTimeout(resolve, PERSIST_RETRY_DELAY_MS));
  }
}

/** Persist the failure payload (WP-B §11.5 fields + cleared scheduling + cleared claim). */
async function persistFailure(
  io: RowIo,
  row: DueRow,
  fail: { message: string; code?: string },
  connectionId?: string | null,
): Promise<void> {
  // Read-merge-write, exactly like the outcome persist: a failure must not overwrite an
  // edit the merchant made while the attempt was running, and it must not cancel a slot
  // they rescheduled it to in the meantime.
  const { error } = await writeFailure(io, row, fail, connectionId);
  if (error) console.error("[cron/publish-due] persist failure error:", error);
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
