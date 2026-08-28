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
 *     destinations: Array<{ provider, status, externalPostId?, externalPostUrl?, accountName?, error? }>
 *   }
 *
 * A destination's externalPostId/externalPostUrl are persisted to
 * social_publish_job_destinations (v32 columns) AND returned, so the UI can link
 * straight to the live post ("View on Facebook").
 *
 * Pinterest is intentionally NOT published here — it keeps its dedicated,
 * tested flow (/api/pinterest/pins). If a pinterest destination is sent it is
 * marked "skipped" so the two paths never double-post.
 */

import { getUserIdFromBearer } from "@/lib/server/authUser";
import { createServerClient } from "@/lib/supabase";
import { isSocialProvider, platformName, PLATFORMS, type SocialProvider } from "@/lib/social/platforms";
import { findConnection, summarizeConnections } from "@/lib/social/server/socialConnectionStore";
import { getSocialProviderById } from "@/lib/social/providers";
import type { SocialConnection, SocialPostPayload } from "@/lib/social/types";
import { createPublishJob, recordOutcomes } from "@/lib/social/publishFanout";
import { rollUpJobStatus, type DestinationOutcome } from "@/lib/social/publishRules";
import { consumeScheduledPost, deriveScheduledPostKey } from "@/lib/server/usage/meterScheduledPost";
import { logEvent } from "@/lib/server/usage/meterGeneration";

export const dynamic = "force-dynamic";

/**
 * Publish now and the due-time scheduler now share ONE execution layer
 * (`publishFanout`), so the two paths can no longer drift apart on how an
 * attempt is recorded. `DestinationOutcome` is that layer's row shape.
 */
type DestOutcome = DestinationOutcome;

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

  // ── Metering: scheduled-post quota (PRD v3.1 decisions 3 & 4) ────────────────
  // One Content published = one unit, no matter how many platforms it fans out to.
  // /api/pinterest/pins already charges this for any publish that INCLUDES
  // Pinterest, keyed on deriveScheduledPostKey(uid, draftId) — draftId is the
  // SAME value the client sends here as `postId` (see publishContent.ts, which
  // sends `draftId` to the Pinterest call and `postId: draftId` to this one). So
  // when a publish targets Pinterest AND a social platform, both routes derive
  // the IDENTICAL key; usage_consume_scheduled_post's UNIQUE(user_id,
  // idempotency_key) collapses this route's call into a replay of that one, not
  // a second charge — which is why we must NOT call it again here in that case.
  // The gap this closes is the one the pins route cannot see: a publish that
  // goes ONLY to social platforms (possible since 4218c67) never touches
  // /api/pinterest/pins at all and would otherwise cost 0. Metered here, before
  // any provider dispatch, and fail-open exactly like the pins route/module
  // (shadow never blocks; enforce is not wired anywhere on this branch — see
  // meterScheduledPost.ts's scheduledPostLimitResponseBody(), NOT called from
  // either publish route yet, so this mirrors the pins route's current
  // shadow-only behavior rather than inventing a new enforce switch here).
  const hasPinterestDestination = requested.some(
    raw => (raw as { provider?: unknown }).provider === "pinterest",
  );
  if (!hasPinterestDestination) {
    if (postId) {
      await consumeScheduledPost({
        userId: uid,
        key: deriveScheduledPostKey(uid, postId),
        referenceId: postId,
        metadata: { source: "social_immediate" },
      });
    } else {
      // No draft identity on the request — never charge a key that could collide
      // across drafts. Direct API callers that omit postId are simply unmetered.
      logEvent("usage_meter_skipped", { reason: "no_draft_identity", route: "publish_social" });
    }
  }

  const summaries = await summarizeConnections(uid);
  const byProvider = new Map(summaries.map(s => [s.provider, s]));

  // Create the attempt BEFORE dispatching anything. Previously the job row was
  // written only after every provider call returned, so a crash mid-publish left
  // a post live on the platform with no record of it, and a client that
  // refreshed during publishing had no in-flight state to recover — it simply
  // saw nothing. The row starts as `publishing` and is finalized once the
  // outcomes are known.
  const db = createServerClient();
  const jobId = await createPublishJob(db, uid, postId, productId);

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

    // Publishing capability is not the same thing as being connected (PRD 0809 §4).
    // A platform we cannot publish to is refused HERE, before any provider call, so the
    // provider's internal "not yet wired for this platform" string can never reach a
    // customer as a publish result. The client already hides these rows; this is the
    // server-side half, for stale selections and direct API calls.
    if (!PLATFORMS[provider].liveConnect) {
      outcomes.push({
        provider,
        status: "skipped",
        socialConnectionId: null,
        error: `Publishing to ${platformName(provider)} is coming soon.`,
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
        // Providers backed by our OWN OAuth (Facebook) read server-only,
        // per-user credentials (the encrypted PAGE token) that are deliberately
        // absent from the client-safe SocialConnection projection. `uid` is the
        // bearer-verified session user — never a client-supplied value.
        userId: uid,
      });
      outcomes.push({
        provider,
        status: result.ok ? "published" : "failed",
        socialConnectionId: connection.id,
        externalPostId: result.externalPostId ?? null,
        externalPostUrl: result.externalPostUrl ?? null,
        accountName: result.accountName ?? null,
        // Never surface a provider's internal wording. `not_implemented` means we have
        // no publish path for this platform — say that in the customer's terms.
        error: result.ok
          ? null
          : result.status === "not_implemented"
            ? `Publishing to ${platformName(provider)} is coming soon.`
            : result.error ?? "Publishing is not available for this platform yet.",
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

  const jobStatus = rollUpJobStatus(outcomes);
  // Write the per-destination results and move the job off `publishing`. Skipped
  // when the v32 tables are absent (createPublishJob returned null) — publishing
  // itself must not fail just because the record could not be kept.
  if (jobId) await recordOutcomes(db, jobId, outcomes);

  return Response.json({
    ok: jobStatus === "published",
    jobId,
    status: jobStatus,
    destinations: outcomes.map(o => ({
      provider: o.provider,
      status: o.status,
      // The remote post id/url are the ONLY provider-side identifiers exposed to
      // the client — never a token, never a connection secret. The UI needs both:
      // the url powers "View on Facebook", the id is the durable reference.
      externalPostId: o.externalPostId ?? null,
      externalPostUrl: o.externalPostUrl ?? null,
      error: o.error ?? null,
    })),
  });
}
