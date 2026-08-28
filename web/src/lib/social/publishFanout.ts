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
import type { ScheduledDestination } from "../pinDraftStore";
import type { SocialPostPayload } from "./types";
import { rollUpJobStatus, type DestinationOutcome } from "./publishRules";

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
): Promise<string | null> {
  const { data, error } = await db
    .from("social_publish_jobs")
    // `publishing`, not a terminal status: the attempt has started and has not yet
    // resolved. A crash therefore leaves an honest in-flight record.
    .insert({ user_id: uid, post_id: postId, product_id: productId, status: "publishing" })
    .select("id")
    .single();
  if (error) {
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
): Promise<void> {
  const nowIso = new Date().toISOString();
  const rows = outcomes.map(o => ({
    publish_job_id: jobId,
    provider: o.provider,
    social_connection_id: o.socialConnectionId,
    status: o.status,
    external_post_id: o.externalPostId ?? null,
    external_post_url: o.externalPostUrl ?? null,
    error_message: o.error ?? null,
    published_at: o.status === "published" ? nowIso : null,
  }));
  const { error: destErr } = await db.from("social_publish_job_destinations").insert(rows);
  if (destErr && !isMissingTable(destErr.code)) {
    console.error("[publishFanout] persist destinations:", destErr.message);
  }
  const { error: jobErr } = await db
    .from("social_publish_jobs")
    .update({ status: rollUpJobStatus(outcomes), updated_at: nowIso })
    .eq("id", jobId);
  if (jobErr && !isMissingTable(jobErr.code)) {
    console.error("[publishFanout] finalize job:", jobErr.message);
  }
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
      };
    }

    const result = await getSocialProviderById(connection.authProvider).publishPost({
      provider,
      connection,
      post,
      userId: uid,
    });
    return {
      ...base,
      status: result.ok ? "published" : "failed",
      externalPostId: result.externalPostId ?? null,
      externalPostUrl: result.externalPostUrl ?? null,
      accountName: result.accountName ?? null,
      error: result.ok
        ? null
        : result.status === "not_implemented"
          ? `Publishing to ${platformName(provider)} is coming soon.`
          : result.error ?? "Publishing is not available for this platform yet.",
    };
  } catch (err) {
    return { ...base, status: "failed", error: (err as Error).message || "Publishing failed." };
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
export async function fanOutDestinations(
  uid: string,
  destinations: readonly ScheduledDestination[],
  post: SocialPostPayload,
): Promise<DestinationOutcome[]> {
  const outcomes: DestinationOutcome[] = [];
  for (const destination of destinations) {
    if (destination.provider === "pinterest") continue; // dedicated path owns it
    // Belt and braces: `dispatchDestination` already resolves rather than rejects for
    // everything it can see. This catch covers what it cannot — and it is the reason
    // the invariant above holds no matter how that function is later changed.
    try {
      outcomes.push(await dispatchDestination(uid, destination, post));
    } catch (err) {
      outcomes.push(isolationFailure(destination, err));
    }
  }
  return outcomes;
}

