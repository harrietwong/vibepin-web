/**
 * GET /api/publish/in-flight?postId=<draftId>
 *
 * Answers one question: is a publish for this Pin still running right now?
 *
 * Completed publishes already survive a refresh without this route — the results
 * are written onto the draft (`postedAt`/`remotePinUrl` for Pinterest,
 * `socialPosts[]` for the rest) and `publishResults.ts` reassembles them. What
 * did NOT survive was the window between "merchant pressed Publish" and "every
 * provider answered": the drawer held that in `useState`, so a refresh mid-flight
 * showed nothing at all, and the merchant could not tell whether anything had
 * been sent (TC-094).
 *
 * Since the attempt row is now created BEFORE dispatch, a `publishing` job is a
 * truthful record of exactly that window, and this reads it back.
 *
 * Response:
 *   { inFlight: false }
 *   { inFlight: true, jobId, startedAt, destinations: [{ provider, status }] }
 *
 * Deliberately narrow:
 *  - only `publishing` jobs; a finished job is the draft's business, not this route's
 *  - no permalinks or account handles — those belong to the durable result path
 *  - `.eq("user_id", uid)`, so a job id from another workspace resolves to nothing
 */

import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { isAttemptLive } from "@/lib/server/publish/inFlight";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/** v32 tables absent ⇒ nothing to recover, which is not an error. */
function isMissingTable(code: string | undefined): boolean {
  return code === "42P01";
}

/**
 * A job older than this is treated as finished-or-abandoned rather than live.
 * Without it, a worker that died mid-publish would leave a row that claims to be
 * publishing forever, and the drawer would show a spinner that never resolves.
 * Matches the cron's own stale-claim window.
 */
export async function GET(req: Request): Promise<Response> {
  const uid = await getUserIdFromBearerOrCookies(req);
  if (!uid) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const postId = new URL(req.url).searchParams.get("postId")?.trim();
  if (!postId) {
    return Response.json({ error: "postId is required" }, { status: 400 });
  }

  const db = createServerClient();
  const { data: jobs, error } = await db
    .from("social_publish_jobs")
    .select("id, status, created_at")
    .eq("user_id", uid)
    .eq("post_id", postId)
    .eq("status", "publishing")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    if (isMissingTable(error.code)) return Response.json({ inFlight: false });
    console.error("[publish/in-flight] read job:", error.message);
    // Fail soft: a lookup problem must never make the drawer claim a publish is
    // running, which would be a worse lie than showing nothing.
    return Response.json({ inFlight: false });
  }

  const job = (jobs ?? [])[0] as { id: string; created_at: string } | undefined;
  if (!job) return Response.json({ inFlight: false });

  if (!isAttemptLive(job.created_at)) {
    return Response.json({ inFlight: false, stale: true });
  }

  const { data: dests, error: destErr } = await db
    .from("social_publish_job_destinations")
    .select("provider, status")
    .eq("publish_job_id", job.id);

  if (destErr && !isMissingTable(destErr.code)) {
    console.error("[publish/in-flight] read destinations:", destErr.message);
  }

  return Response.json({
    inFlight: true,
    jobId: job.id,
    startedAt: job.created_at,
    // Empty until the attempt finishes — destination rows are written with the
    // outcomes. An empty list therefore means "started, nothing resolved yet",
    // which is exactly what the merchant should be told.
    destinations: (dests ?? []).map(d => ({
      provider: (d as { provider: string }).provider,
      status: (d as { status: string }).status,
    })),
  });
}
