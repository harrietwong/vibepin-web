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
 *     destinations: Array<{ provider, socialConnectionId? }>,
 *     meteringBucket?: string,           // relayed from /api/pinterest/pins for this
 *                                         // same Content; validated (never trusted
 *                                         // outright) — see the metering block below.
 *     meteringBucketSig?: string,        // HMAC over (uid, postId, meteringBucket,
 *                                         // meteringBucketMintedAt) from the same call.
 *     meteringBucketMintedAt?: number,   // the server instant the bucket+sig above were
 *                                         // minted at; verification is bound to THIS
 *                                         // value, not this route's own "now".
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
import {
  consumeScheduledPost,
  deriveScheduledPostKey,
  classifyImmediateBucket,
} from "@/lib/server/usage/meterScheduledPost";
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

  const postId = typeof body.postId === "string" && body.postId.trim() ? body.postId.trim() : null;
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
  // We ALWAYS attempt a consume here when postId is present — never gated on
  // whether `destinations` also names Pinterest. That gate used to trust the
  // client's own destination list to decide whether metering was "already done"
  // by /api/pinterest/pins; a request can claim a pinterest destination that
  // never actually published (a stale/failed entry sent alongside a real
  // Facebook one) and this route would then publish to Facebook for free. There
  // is no way to verify from here whether the pins route actually ran, so the
  // only safe rule is: this route always tries to charge.
  // This cannot double-charge a publish that ALSO went through
  // /api/pinterest/pins: both routes derive the SAME key —
  // deriveScheduledPostKey(uid, draftId) — for the SAME Content (draftId is the
  // value the client sends as `postId` here; see publishContent.ts). v55's
  // usage_consume_scheduled_post ledger enforces UNIQUE(user_id,
  // idempotency_key), so whichever call lands second is collapsed into a replay
  // (kind: "consumed", replayed: true, no increment) rather than a second unit —
  // this is exactly what protects the pins-route case, not a client-trusted flag.
  // That shared key alone is not sufficient, though: an immediate publish's key is
  // partly a UTC date bucket that each route would otherwise compute at ITS OWN
  // "now", and if the pins call and this call straddle a UTC midnight (or land on
  // clock-skewed instances) the two buckets — and therefore the two keys — could
  // differ, defeating the replay collapse above and double-charging. So the client
  // relays `meteringBucket` + `meteringBucketSig` + `meteringBucketMintedAt`, the
  // exact bucket the pins route minted and metered under plus the instant and
  // signature that prove it — and ONLY when `verifyImmediateBucket` confirms the
  // HMAC really was minted by the pins route for THIS (uid, postId) pair, the relay
  // arrived within `IMMEDIATE_BUCKET_MAX_RELAY_MS` of that mint, AND the bucket is
  // that mint instant's OWN UTC date (never trusted on shape alone, and never on
  // this route's own "now" — see meterScheduledPost.ts's module header for why
  // binding to the FROZEN mint instant is what makes a UTC-midnight straddle safe)
  // — it is used as `deriveScheduledPostKey`'s override instead of this route
  // computing its own. A missing/rejected/stale/unsigned bucket (including every
  // social-only publish, which never had a pins call to relay from) falls back to
  // this route's own date, exactly as before this relay existed. The residual case
  // is honest, not hidden: a social-only retry of the SAME Content on a LATER day
  // counts again, by the same one-bucket-per-day design as the pins route always had.
  // Metered before any provider dispatch, and fail-open exactly like the pins
  // route/module (shadow never blocks; enforce is not wired anywhere on this
  // branch — see meterScheduledPost.ts's scheduledPostLimitResponseBody(), NOT
  // called from either publish route yet, so this mirrors the pins route's
  // current shadow-only behavior rather than inventing a new enforce switch here).
  if (postId) {
    const rawBucket = body.meteringBucket;
    let bucketOverride: string | undefined;
    if (rawBucket !== undefined && rawBucket !== null) {
      const reason = classifyImmediateBucket(uid, postId, rawBucket, body.meteringBucketSig, body.meteringBucketMintedAt);
      if (reason !== "ok") {
        // Never blocks or errors the publish — just means this call derives its own
        // bucket below, same as if nothing had been sent. Covers a missing sig too
        // (Fix 5: the pins route omits sig+mintedAt entirely when it refused to sign
        // with an unsafe default salt in production) — classifyImmediateBucket
        // reports that as "bad_signature", same as any other unverifiable relay.
        logEvent("usage_meter_bucket_rejected", { route: "publish_social", reason });
      } else {
        bucketOverride = rawBucket as string;
      }
    }
    await consumeScheduledPost({
      userId: uid,
      key: deriveScheduledPostKey(uid, postId, undefined, bucketOverride),
      referenceId: postId,
      metadata: { source: "social_immediate" },
    });
  } else {
    // No draft identity on the request — never charge a key that could collide
    // across drafts. Direct API callers that omit postId are simply unmetered.
    logEvent("usage_meter_skipped", { reason: "no_draft_identity", route: "publish_social" });
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
