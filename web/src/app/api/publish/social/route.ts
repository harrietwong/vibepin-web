/**
 * POST /api/publish/social
 *
 * Creates a merchant-approved, multi-platform publish job and dispatches it to
 * each selected destination through the vendor-neutral provider abstraction.
 *
 * This route only runs because the merchant reviewed the content, selected
 * destinations, and explicitly clicked Publish — there is no auto-publishing.
 *
 * Body:
 *   {
 *     postId?: string,
 *     productId?: string,
 *     post: { imageUrls: string[], title?, caption?, destinationUrl?, altText? },
 *     destinations: Array<{ provider, socialConnectionId? }>
 *   }
 *
 * Response:
 *   {
 *     ok: boolean,                       // true when every destination published
 *     jobId: string | null,              // null if the v32 tables aren't applied
 *     status: SocialPublishJobStatus,
 *     destinations: Array<{ provider, status, externalPostUrl?, error? }>
 *   }
 *
 * Pinterest is intentionally NOT published here — it keeps its dedicated,
 * tested flow (/api/pinterest/pins). If a pinterest destination is sent it is
 * marked "skipped" so the two paths never double-post.
 */

import { getUserIdFromBearer } from "@/lib/server/authUser";
import { createServerClient } from "@/lib/supabase";
import { isSocialProvider, platformName, type SocialProvider } from "@/lib/social/platforms";
import { findConnection, summarizeConnections } from "@/lib/social/server/socialConnectionStore";
import { getSocialProviderById } from "@/lib/social/providers";
import type { SocialConnection, SocialPostPayload } from "@/lib/social/types";

export const dynamic = "force-dynamic";

type DestStatus = "pending" | "skipped" | "publishing" | "published" | "failed";
type JobStatus =
  | "draft"
  | "publishing"
  | "published"
  | "partially_published"
  | "failed";

type DestOutcome = {
  provider: SocialProvider;
  status: DestStatus;
  socialConnectionId: string | null;
  externalPostId?: string | null;
  externalPostUrl?: string | null;
  error?: string | null;
};

function isMissingTable(code: string | undefined): boolean {
  return code === "42P01";
}

/** Persist the job + destination rows. Returns null if the v32 tables are absent. */
async function persistJob(
  uid: string,
  postId: string | null,
  productId: string | null,
  outcomes: DestOutcome[],
  jobStatus: JobStatus,
): Promise<string | null> {
  const db = createServerClient();
  const { data: job, error: jobErr } = await db
    .from("social_publish_jobs")
    .insert({ user_id: uid, post_id: postId, product_id: productId, status: jobStatus })
    .select("id")
    .single();

  if (jobErr) {
    if (isMissingTable(jobErr.code)) return null; // migration not applied — skip persistence
    console.error("[publish/social] persist job:", jobErr.message);
    return null;
  }

  const jobId = (job as { id: string }).id;
  const rows = outcomes.map(o => ({
    publish_job_id: jobId,
    provider: o.provider,
    social_connection_id: o.socialConnectionId,
    status: o.status,
    external_post_id: o.externalPostId ?? null,
    external_post_url: o.externalPostUrl ?? null,
    error_message: o.error ?? null,
    published_at: o.status === "published" ? new Date().toISOString() : null,
  }));
  const { error: destErr } = await db.from("social_publish_job_destinations").insert(rows);
  if (destErr && !isMissingTable(destErr.code)) {
    console.error("[publish/social] persist destinations:", destErr.message);
  }
  return jobId;
}

function rollUpStatus(outcomes: DestOutcome[]): JobStatus {
  const active = outcomes.filter(o => o.status !== "skipped");
  if (!active.length) return "failed";
  const published = active.filter(o => o.status === "published").length;
  if (published === active.length) return "published";
  if (published > 0) return "partially_published";
  return "failed";
}

export async function POST(req: Request) {
  const uid = await getUserIdFromBearer(req);
  if (!uid) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const postId = typeof body.postId === "string" ? body.postId : null;
  const productId = typeof body.productId === "string" ? body.productId : null;
  const rawPost = (body.post ?? {}) as Record<string, unknown>;
  const post: SocialPostPayload = {
    imageUrls: Array.isArray(rawPost.imageUrls) ? (rawPost.imageUrls as string[]) : [],
    title: typeof rawPost.title === "string" ? rawPost.title : undefined,
    caption: typeof rawPost.caption === "string" ? rawPost.caption : undefined,
    destinationUrl: typeof rawPost.destinationUrl === "string" ? rawPost.destinationUrl : undefined,
    altText: typeof rawPost.altText === "string" ? rawPost.altText : undefined,
  };

  const requested = Array.isArray(body.destinations) ? body.destinations : [];
  if (!requested.length) {
    return Response.json({ error: "Select at least one destination to publish." }, { status: 400 });
  }

  const summaries = await summarizeConnections(uid);
  const byProvider = new Map(summaries.map(s => [s.provider, s]));

  const outcomes: DestOutcome[] = [];
  for (const raw of requested) {
    const provider = (raw as { provider?: unknown }).provider;
    if (!isSocialProvider(provider)) continue;

    // Pinterest is published by its own dedicated flow — never here.
    if (provider === "pinterest") {
      outcomes.push({
        provider,
        status: "skipped",
        socialConnectionId: null,
        error: "Pinterest is published through the Pinterest flow.",
      });
      continue;
    }

    const requestedId =
      typeof (raw as { socialConnectionId?: unknown }).socialConnectionId === "string"
        ? ((raw as { socialConnectionId: string }).socialConnectionId)
        : null;
    const summary = byProvider.get(provider);
    const connection: SocialConnection | null = requestedId
      ? await findConnection(uid, requestedId)
      : summary?.accounts.find(a => a.connectionStatus === "connected") ?? null;

    if (!connection || connection.connectionStatus !== "connected") {
      outcomes.push({
        provider,
        status: "failed",
        socialConnectionId: connection?.id ?? null,
        error: `Connect your ${platformName(provider)} account in Settings to publish here.`,
      });
      continue;
    }

    try {
      const result = await getSocialProviderById(connection.authProvider).publishPost({
        provider,
        connection,
        post,
      });
      outcomes.push({
        provider,
        status: result.ok ? "published" : "failed",
        socialConnectionId: connection.id,
        externalPostId: result.externalPostId ?? null,
        externalPostUrl: result.externalPostUrl ?? null,
        error: result.ok ? null : result.error ?? "Publishing is not available for this platform yet.",
      });
    } catch (err) {
      outcomes.push({
        provider,
        status: "failed",
        socialConnectionId: connection.id,
        error: (err as Error).message || "Publishing failed.",
      });
    }
  }

  const jobStatus = rollUpStatus(outcomes);
  const jobId = await persistJob(uid, postId, productId, outcomes, jobStatus);

  return Response.json({
    ok: jobStatus === "published",
    jobId,
    status: jobStatus,
    destinations: outcomes.map(o => ({
      provider: o.provider,
      status: o.status,
      externalPostUrl: o.externalPostUrl ?? null,
      error: o.error ?? null,
    })),
  });
}
