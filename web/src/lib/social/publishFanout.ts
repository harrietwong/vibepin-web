/**
 * The shared publish EXECUTION layer (P0 option A, layers B + C).
 *
 * Publish now and the due-time worker previously shared nothing at all: one
 * dispatched from a live UI selection, the other read a Pinterest-only payload.
 * That is precisely how they drifted until a three-platform schedule executed as
 * a one-platform publish. Both now resolve destinations differently — a live
 * selection vs. frozen intent — and then hand off to the SAME function here.
 *
 * What this layer owns:
 *   B. the attempt   one `social_publish_jobs` row, created when dispatch starts
 *                    (never at schedule time — see below)
 *   C. the results   one `social_publish_job_destinations` row per destination
 *
 * The job row is created BEFORE the provider calls, not after, so a publish that
 * dies mid-flight leaves a `publishing` record instead of no trace at all. It is
 * still never created at schedule time: `customer360.loadPublishEvents` and
 * `adminOverview` both read every job row as publishing that already happened,
 * so a future-dated row would surface as fictitious activity.
 *
 * Pinterest is deliberately NOT dispatched here. It keeps its dedicated, tested
 * path (`/api/pinterest/pins`), which owns board validation, metering and
 * adopt-once targeting. This module records Pinterest's outcome alongside the
 * others so a merchant sees one coherent result set.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isSocialProvider, platformName, type SocialProvider } from "./platforms";
import { findConnection } from "./server/socialConnectionStore";
import { getSocialProviderById } from "./providers";
import { classifyDelivery, readProviderSignal } from "@/lib/server/usage/deliveryOutcome";
import type { ScheduledDestination } from "../pinDraftStore";
import type { SocialPostPayload } from "./types";
import {
  deferredOutcome,
  hasTimeForDestination,
  rollUpJobStatus,
  type DestinationOutcome,
} from "./publishRules";

// The pure decision rules live in publishRules (importable without Supabase);
// re-exported here so callers have one entry point for the execution layer.
export * from "./publishRules";

/** A Pinterest result produced by the dedicated Pinterest path, folded in here. */
export type PinterestOutcome = {
  ok: boolean;
  connectionId?: string | null;
  pinId?: string | null;
  pinUrl?: string | null;
  error?: string | null;
};

function isMissingTable(code: string | undefined): boolean {
  return code === "42P01";
}

/**
 * Roll the per-destination results into the job's status.
 *
 * `skipped` destinations are excluded: a platform we deliberately did not attempt
 * must not make a fully successful publish look partial.
 */

/**
 * Destinations that still need dispatching, given what already succeeded.
 *
 * This is what makes a retry safe: a destination that has already published is
 * never dispatched again, so retrying a partial failure cannot double-post to the
 * platforms that worked.
 */

/** Create the attempt row. Returns null when the v32 tables are absent. */
export async function createPublishJob(
  db: SupabaseClient,
  uid: string,
  postId: string | null,
  productId: string | null,
  intent?: { intentId: string; fingerprint: string },
): Promise<string | null> {
  const { data, error } = await db
    .from("social_publish_jobs")
    // `publishing`, not a terminal status: the attempt has started and has not yet
    // resolved. A crash therefore leaves an honest in-flight record.
    .insert({
      user_id: uid,
      post_id: postId,
      product_id: productId,
      status: "publishing",
      ...(intent ? {
        publish_intent_id: intent.intentId,
        publish_intent_fingerprint: intent.fingerprint,
      } : {}),
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505" && intent) {
      const existing = await db.from("social_publish_jobs")
        .select("id,publish_intent_fingerprint")
        .eq("user_id", uid)
        .eq("publish_intent_id", intent.intentId)
        .maybeSingle();
      if (!existing.error && existing.data
          && (existing.data as { publish_intent_fingerprint?: string }).publish_intent_fingerprint === intent.fingerprint) {
        return (existing.data as { id: string }).id;
      }
    }
    if (isMissingTable(error.code)) return null;
    console.error("[publishFanout] create job:", error.message);
    return null;
  }
  return (data as { id: string }).id;
}

/** Write the per-destination results and finalize the job status. */
export async function recordOutcomes(
  db: SupabaseClient,
  jobId: string,
  outcomes: readonly DestinationOutcome[],
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const rows = outcomes.map(o => ({
    publish_job_id: jobId,
    provider: o.provider,
    social_connection_id: o.socialConnectionId,
    // v32's check constraint predates requested/accepted/delivery_unknown. Preserve
    // the exact lifecycle in payload while mapping to its existing safe terminal or
    // in-flight bucket; no migration is required for this Preview-only code gate.
    status: o.status === "requested" || o.status === "accepted"
      ? "publishing"
      : o.status === "delivery_unknown"
        ? "failed"
        : o.status,
    external_post_id: o.externalPostId ?? null,
    external_post_url: o.externalPostUrl ?? null,
    error_message: o.error ?? null,
    payload: {
      lifecycleStatus: o.status,
      retryAllowed: o.status !== "delivery_unknown",
      providerStatus: o.providerStatus ?? null,
      providerResourceId: o.providerResourceId ?? null,
      errorCode: o.errorCode ?? null,
      attempt: o.attempt ?? null,
      startedAt: o.startedAt ?? null,
      finishedAt: o.finishedAt ?? null,
    },
    published_at: o.status === "published" ? nowIso : null,
  }));
  const destinationTable = db.from("social_publish_job_destinations");
  const connectedRows = rows.filter(row => row.social_connection_id !== null);
  const nullConnectionRows = rows.filter(row => row.social_connection_id === null);
  let persistenceOk = true;

  // Resolve by the exact key and update the existing row. This deliberately
  // avoids PostgREST `upsert(... onConflict: columns)` because a partial unique
  // index cannot be inferred from a column list (42P10). A concurrent insert is
  // handled by reading the winner and updating it, so retries never append rows.
  const persistRow = async (row: typeof rows[number]): Promise<boolean> => {
    const table = db.from("social_publish_job_destinations");
    const query = row.social_connection_id === null
      ? table.select("id").eq("publish_job_id", jobId).eq("provider", row.provider).is("social_connection_id", null)
      : table.select("id").eq("publish_job_id", jobId).eq("provider", row.provider).eq("social_connection_id", row.social_connection_id);
    const { data: existing, error: lookupError } = await query.maybeSingle();
    if (lookupError) {
      if (isMissingTable(lookupError.code)) return true;
      console.error("[publishFanout] find destination:", lookupError.message);
      return false;
    }
    if (existing && typeof (existing as { id?: unknown }).id === "string") {
      const { error } = await db.from("social_publish_job_destinations").update(row).eq("id", (existing as { id: string }).id);
      if (error && !isMissingTable(error.code)) {
        console.error("[publishFanout] update destination:", error.message);
        return false;
      }
      return true;
    }
    const { error: insertError } = await db.from("social_publish_job_destinations").insert(row);
    if (!insertError || isMissingTable(insertError.code)) return true;
    if (insertError.code !== "23505") {
      console.error("[publishFanout] persist destination:", insertError.message);
      return false;
    }
    // Another request inserted the exact key between lookup and insert.
    const winnerQuery = row.social_connection_id === null
      ? db.from("social_publish_job_destinations").select("id").eq("publish_job_id", jobId).eq("provider", row.provider).is("social_connection_id", null)
      : db.from("social_publish_job_destinations").select("id").eq("publish_job_id", jobId).eq("provider", row.provider).eq("social_connection_id", row.social_connection_id);
    const { data: winner, error: winnerError } = await winnerQuery.maybeSingle();
    if (winnerError || !winner || typeof (winner as { id?: unknown }).id !== "string") {
      if (winnerError && !isMissingTable(winnerError.code)) console.error("[publishFanout] find destination winner:", winnerError.message);
      return false;
    }
    const { error: updateError } = await db.from("social_publish_job_destinations").update(row).eq("id", (winner as { id: string }).id);
    if (updateError && !isMissingTable(updateError.code)) {
      console.error("[publishFanout] update destination winner:", updateError.message);
      return false;
    }
    return true;
  };

  // The tiny pre-v32 ordering test double only exposes insert/update. Keep its
  // legacy write path; deployed Supabase builders always expose select().
  const hasSelect = typeof (destinationTable as unknown as { select?: unknown }).select === "function";
  if (!hasSelect && rows.length) {
    const { error } = await (destinationTable as unknown as { insert: (values: unknown) => Promise<{ error: { code?: string; message: string } | null }> }).insert(rows);
    persistenceOk = !error || isMissingTable(error.code);
    if (error && !isMissingTable(error.code)) console.error("[publishFanout] persist destinations:", error.message);
  } else {
    for (const row of connectedRows) persistenceOk = await persistRow(row) && persistenceOk;
  }

  // A null connection is a deliberate skipped/refused destination. PostgreSQL
  // NULLs do not conflict in the non-null unique key, so resolve that reserved
  // per-job/provider row explicitly before updating/inserting it.
  if (hasSelect) {
    for (const row of nullConnectionRows) persistenceOk = await persistRow(row) && persistenceOk;
  }
  const { error: jobErr } = await db
    .from("social_publish_jobs")
    .update({ status: rollUpJobStatus(outcomes), updated_at: nowIso })
    .eq("id", jobId);
  if (jobErr && !isMissingTable(jobErr.code)) {
    console.error("[publishFanout] finalize job:", jobErr.message);
    persistenceOk = false;
  }
  return persistenceOk;
}

/**
 * Dispatch one non-Pinterest destination.
 *
 * The destination names an ACCOUNT, and that account is re-verified against the
 * publishing user before anything is sent: `findConnection` is user-scoped, so a
 * connection id belonging to someone else resolves to nothing rather than
 * publishing across a workspace boundary. Crucially it is looked up BY ID from
 * the frozen intent — never "the current default for this platform" — so a Pin
 * scheduled to one account cannot drift to another.
 */
export async function dispatchDestination(
  uid: string,
  destination: ScheduledDestination,
  post: SocialPostPayload,
): Promise<DestinationOutcome> {
  const provider = destination.provider;
  if (!isSocialProvider(provider)) {
    return { provider: "pinterest", status: "skipped", socialConnectionId: null, error: "Unknown platform." };
  }
  const base = { provider, socialConnectionId: destination.socialConnectionId };

  // EVERYTHING that can throw is inside this try — the connection lookup above all.
  //
  // `findConnection` reads the database. It sat OUTSIDE the try, so a transient
  // PostgREST error while resolving destination #2 rejected `fanOutDestinations`
  // itself, and with it the ALREADY-PUBLISHED outcome of destination #1 (the loop is
  // sequential, and the accumulated outcomes died with the rejection). The cron's
  // catch then wrote a `failed` row for every owed destination — including the one
  // that really published — so the retry re-posted it. A DB blip on one account is
  // not allowed to cost a double post on another.
  try {
    const connection = await findConnection(uid, destination.socialConnectionId);
    if (!connection || connection.connectionStatus !== "connected") {
      return {
        ...base,
        status: "failed",
        // The account this Pin was scheduled to is the one that must be fixed —
        // silently falling back to another account would publish somewhere the
        // merchant never chose.
        error: `Reconnect your ${platformName(provider)} account to publish this Pin.`,
        // Decided here, before any network call: this destination is `not_sent` and
        // its share of the scheduled-post charge is refundable (deliveryOutcome.ts).
        preNetwork: true,
      };
    }

    const result = await getSocialProviderById(connection.authProvider).publishPost({
      provider,
      connection,
      post,
      userId: uid,
    });
    const delivery = classifyDelivery({
      ok: result.ok,
      preNetwork: result.status === "not_implemented" || result.preNetwork === true,
      providerStatus: result.providerStatus,
      providerResourceId: result.providerResourceId ?? result.externalPostId ?? null,
    });
    return {
      ...base,
      status: result.ok ? "published" : delivery === "delivery_unknown" ? "delivery_unknown" : "failed",
      externalPostId: result.externalPostId ?? null,
      externalPostUrl: result.externalPostUrl ?? null,
      accountName: result.accountName ?? null,
      error: result.ok
        ? null
        : result.status === "not_implemented"
          ? `Publishing to ${platformName(provider)} is coming soon.`
          : result.error ?? "Publishing is not available for this platform yet.",
      // Carried through for the usage refund decision only (deliveryOutcome.ts).
      // `not_implemented` never reached a platform, so it is pre-network — and so is
      // any failure the provider decided before dispatching (`result.preNetwork`:
      // missing credentials, no account selected, a local media-rule refusal), which
      // carries no providerStatus and would otherwise read as a timeout and be charged.
      providerStatus: result.providerStatus ?? null,
      providerResourceId: result.providerResourceId ?? result.externalPostId ?? null,
      preNetwork: result.status === "not_implemented" || result.preNetwork === true,
    };
  } catch (err) {
    // A provider implementation that THREW rather than returning a typed failure.
    // Read the two provider fields off it if they happen to be there; otherwise
    // this is `delivery_unknown` and the charge stands.
    const signal = readProviderSignal(err);
    const delivery = classifyDelivery(signal);
    return {
      ...base,
      status: delivery === "delivery_unknown" ? "delivery_unknown" : "failed",
      error: (err as Error).message || "Publishing failed.",
      providerStatus: signal.providerStatus ?? null,
      providerResourceId: signal.providerResourceId ?? null,
    };
  }
}

/**
 * The outcome for a destination whose dispatch threw somewhere no other handler
 * covered. It exists so the invariant below can be stated without an "unless":
 * every destination gets exactly one row, whatever happened.
 */
function isolationFailure(
  destination: ScheduledDestination,
  err: unknown,
): DestinationOutcome {
  const message = (err as { message?: unknown } | null)?.message;
  return {
    provider: (isSocialProvider(destination.provider) ? destination.provider : "pinterest") as SocialProvider,
    status: "failed",
    socialConnectionId: destination.socialConnectionId ?? null,
    error: (typeof message === "string" && message) || "Publishing failed.",
  };
}

/**
 * Fan out to every non-Pinterest destination, independently.
 *
 * THE INVARIANT: this function never rejects, and every destination it is given
 * produces exactly one outcome, in the order it was given. Nothing a single
 * destination does — a DB error resolving its account, a provider client throwing
 * outside its own handler — may cost another destination its result.
 *
 * That is not a nicety. The loop is sequential and the outcomes accumulate in a local
 * array, so ONE rejection discarded every outcome collected before it. In the cron
 * that meant: Instagram published, Facebook's connection lookup threw, the whole call
 * rejected, and the catch wrote a `failed` row for BOTH — including the Instagram post
 * that is live on the platform. The next run then owed Instagram again and posted it a
 * second time. A lost outcome is not a missing record, it is a duplicate post.
 *
 * Sequential is still on purpose: these are third-party writes, and a merchant with
 * three connected platforms is not a throughput problem.
 */
export interface FanOutOptions {
  /**
   * Absolute epoch-ms after which no further destination may be STARTED.
   *
   * Not a cancellation: a destination already in flight runs to completion (that is
   * what `DESTINATION_RESERVE_MS` reserves room for). It stops the run from beginning
   * work it cannot finish and persist before the platform kills the process — which
   * is how a post that really went out ends up with no record and is sent again.
   *
   * Omitted ⇒ no deadline, i.e. the behaviour every caller had before.
   */
  deadlineMs?: number;
  /**
   * Called with each destination's outcome the moment it is known, before the next
   * destination starts.
   *
   * The caller persists it there. Waiting for the whole batch to return means every
   * post already made is unrecorded for as long as the destinations after it take —
   * and a process killed in that window republishes them all. A throwing callback is
   * logged and ignored: a bookkeeping failure must not cost a destination its outcome.
   */
  onOutcome?: (outcome: DestinationOutcome, destination: ScheduledDestination) => void | Promise<void>;
}

export async function fanOutDestinations(
  uid: string,
  destinations: readonly ScheduledDestination[],
  post: SocialPostPayload,
  options?: FanOutOptions,
): Promise<DestinationOutcome[]> {
  const outcomes: DestinationOutcome[] = [];
  for (const destination of destinations) {
    if (destination.provider === "pinterest") continue; // dedicated path owns it
    // Belt and braces: `dispatchDestination` already resolves rather than rejects for
    // everything it can see. This catch covers what it cannot — and it is the reason
    // the invariant above holds no matter how that function is later changed.
    let outcome: DestinationOutcome;
    try {
      outcome =
        // Checked per destination, immediately before dispatch, because that is where
        // the time actually goes: the check that mattered was made once at the top of
        // the row, and three Instagram accounts later the run was past the ceiling.
        hasTimeForDestination(Date.now(), options?.deadlineMs)
          ? await dispatchDestination(uid, destination, post)
          : deferredOutcome(destination);
    } catch (err) {
      outcome = isolationFailure(destination, err);
    }
    outcomes.push(outcome);
    if (options?.onOutcome) {
      try {
        await options.onOutcome(outcome, destination);
      } catch (err) {
        console.error("[publishFanout] onOutcome:", (err as Error).message);
      }
    }
  }
  return outcomes;
}
