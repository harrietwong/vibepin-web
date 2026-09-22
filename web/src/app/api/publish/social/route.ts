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
 *     post: { imageUrls: string[], videoUrls?: string[], title?, caption?, destinationUrl?, altText? },
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
 * tested flow (/api/pinterest/pins). A Pinterest destination is rejected during
 * preflight before metering, job creation or provider dispatch.
 */

import { getUserIdFromBearer } from "@/lib/server/authUser";
import { createServerClient } from "@/lib/supabase";
import { isSocialProvider, platformName, PLATFORMS } from "@/lib/social/platforms";
import { findConnection, summarizeConnections } from "@/lib/social/server/socialConnectionStore";
import { resolveDestinationCapability } from "@/lib/social/destinationCapability";
import { requiresPublishAsset } from "@/lib/server/publishMedia";
import { getSocialProviderById } from "@/lib/social/providers";
import type { SocialConnection, SocialPostPayload } from "@/lib/social/types";
import { createPublishJob, recordOutcomes } from "@/lib/social/publishFanout";
import { classifyDispatchSettlement, rollUpJobStatus, type DestinationOutcome } from "@/lib/social/publishRules";
import {
  consumeScheduledPost,
  deriveScheduledPostKey,
  releaseScheduledPost,
  scheduledPostLimitResponseBody,
  usageEnforceFor,
  classifyImmediateBucket,
} from "@/lib/server/usage/meterScheduledPost";
import {
  aggregateDelivery,
  classifyDelivery,
  isRefundable,
  readProviderSignal,
  type DeliveryOutcome,
} from "@/lib/server/usage/deliveryOutcome";
import { logEvent } from "@/lib/server/usage/meterGeneration";
import {
  validateImmediatePublishReceipt,
  isConfirmedSocialDestinationSelection,
  validateStoredImmediatePublishReceipt,
} from "@/lib/server/publish/confirmationReceipt";
import {
  PublishIntentLedgerError,
  claimPublishIntentDestinations,
  claimPublishRetryDestinations,
  settlePublishIntentDestination,
  type PublishIntentClaim,
} from "@/lib/server/publish/publishIntentLedger";
import { dispatchSupabaseV76InstagramReel } from "@/lib/server/publish/v76InstagramReelsServer";
import type { PublishDestination } from "@/lib/contentDraftModel";

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
    videoUrls: Array.isArray(rawPost.videoUrls) ? (rawPost.videoUrls as string[]) : [],
    title: typeof rawPost.title === "string" ? rawPost.title : undefined,
    caption: typeof rawPost.caption === "string" ? rawPost.caption : undefined,
    destinationUrl: typeof rawPost.destinationUrl === "string" ? rawPost.destinationUrl : undefined,
    altText: typeof rawPost.altText === "string" ? rawPost.altText : undefined,
  };

  const requested = Array.isArray(body.destinations) ? body.destinations : [];
  if (!requested.length) {
    return Response.json({ error: "Select at least one destination to publish." }, { status: 400 });
  }
  const requestedProviders = requested.map(raw => String((raw as { provider?: unknown }).provider ?? "").toLowerCase());
  const videoUrls = post.videoUrls ?? [];
  if (requestedProviders.includes("instagram") && (videoUrls.length > 1 || (videoUrls.length > 0 && post.imageUrls.length > 0))) {
    return Response.json({ error: "Instagram Reels accepts exactly one video and cannot mix images.", code: "instagram_reels_media_invalid" }, { status: 422 });
  }

  const requestedDestinationIds = requested.map(raw => {
    const item = raw as { provider?: unknown; socialConnectionId?: unknown };
    const provider = typeof item.provider === "string" ? item.provider.trim().toLowerCase() : "";
    const connectionId = typeof item.socialConnectionId === "string" ? item.socialConnectionId.trim() : "";
    return `${provider}:${connectionId}`;
  });
  const confirmation = validateImmediatePublishReceipt(body.confirmation, {
    draftId: postId ?? "",
    title: post.title,
    description: post.caption,
    destinationUrl: post.destinationUrl,
    altText: post.altText,
    imageUrls: post.imageUrls,
    videoUrls: post.videoUrls,
  }, requestedDestinationIds);
  if (!confirmation.ok) {
    return Response.json({ error: confirmation.error, code: confirmation.code }, { status: confirmation.code === "confirmation_required" ? 400 : 409 });
  }
  if (!isConfirmedSocialDestinationSelection(
    requestedDestinationIds,
    confirmation.destinations,
    confirmation.receipt.dispatchDestinationIds,
  )) {
    return Response.json({
      error: confirmation.receipt.onlyPending
        ? "The submitted retry destinations are not confirmed."
        : "The social destination set no longer matches the confirmation.",
      code: "invalid_confirmation",
    }, { status: 409 });
  }
  // Draft media is owner-protected and cannot be handed to providers that fetch
  // unauthenticated URLs. A future intent-bound materializer must run here after
  // confirmation; fail closed until that seam is wired, never silently dispatch.
  if (post.imageUrls.some(url => typeof url === "string" && requiresPublishAsset(url, new URL(req.url).origin))) {
    return Response.json({
      error: "Publish media asset is not materialized for provider delivery.",
      code: "publish_asset_required",
    }, { status: 409 });
  }

  // Resolve every exact owner-scoped account before metering, job creation or provider
  // dispatch. This route never chooses a first/default account and never accepts the
  // Pinterest leg (its dedicated endpoint owns that dispatch).
  let summaries: Awaited<ReturnType<typeof summarizeConnections>>;
  try {
    summaries = await summarizeConnections(uid);
  } catch (error) {
    console.error("[publish/social preflight]", (error as Error).message);
    return Response.json({ error: "Could not validate publishing destinations.", code: "capability_unavailable" }, { status: 503 });
  }
  const byProvider = new Map(summaries.map(summary => [summary.provider, summary]));
  const seenDestinations = new Set<string>();
  const validation = requested.map(raw => {
    const item = raw as { provider?: unknown; socialConnectionId?: unknown };
    const provider = item.provider;
    const connectionId = typeof item.socialConnectionId === "string" ? item.socialConnectionId.trim() : "";
    if (!isSocialProvider(provider) || provider === "pinterest" || !PLATFORMS[provider].liveConnect) {
      return { provider: String(provider), socialConnectionId: connectionId || null, publishable: false, reasonCode: "unsupported_provider" };
    }
    const key = `${provider}:${connectionId}`;
    if (!connectionId || seenDestinations.has(key)) {
      return { provider, socialConnectionId: connectionId || null, publishable: false, reasonCode: connectionId ? "duplicate_destination" : "not_connected" };
    }
    seenDestinations.add(key);
    const connection = byProvider.get(provider)?.accounts.find(account => account.id === connectionId) ?? null;
    const capability = resolveDestinationCapability({
      provider,
      connection,
      connectionId,
      mediaCount: post.imageUrls.length + (post.videoUrls?.length ?? 0),
      mode: "now",
    });
    return {
      provider,
      socialConnectionId: capability.connectionId ?? connectionId,
      providerAccountId: capability.providerAccountId,
      displayIdentity: capability.displayIdentity,
      publishable: capability.publishNow,
      reasonCode: capability.unavailableReason,
    };
  });
  if (validation.some(result => !result.publishable)) {
    return Response.json({
      error: "One or more publishing destinations are no longer available.",
      code: "destination_validation_failed",
      results: validation,
    }, { status: 422 });
  }

  // Durable, per-destination idempotency is claimed only after the complete receipt
  // and live capability checks pass, but before metering, job creation or dispatch.
  // The database uniqueness constraint coordinates every server instance and survives
  // restarts; the old usage key/process lock do not.
  let db: ReturnType<typeof createServerClient>;
  try {
    db = createServerClient();
  } catch {
    return Response.json({ error: "Durable publish recovery is unavailable.", code: "publish_intent_unavailable" }, { status: 503 });
  }
  const stored = await validateStoredImmediatePublishReceipt(db, uid, confirmation.receipt);
  if (!stored.ok) {
    return Response.json({ error: stored.error, code: stored.code }, {
      status: stored.code === "invalid_confirmation" ? 409 : 503,
    });
  }
  const privateReelCandidate = requestedProviders.includes("instagram")
    && post.imageUrls.length === 0
    && videoUrls.length === 1
    && requiresPublishAsset(videoUrls[0], new URL(req.url).origin);
  const privateReel = privateReelCandidate
    && requested.length === 1
    && requestedProviders.length === 1
    && requestedProviders[0] === "instagram";
  if (privateReelCandidate && !privateReel) {
    // A single private Reel has one materialized provider copy per durable
    // destination. Do not let a mixed fan-out fall through to the pre-v76
    // generic claim path while that multi-destination graph is unsupported.
    return Response.json({
      error: "A private Instagram Reel must be published to its Instagram destination separately.",
      code: "instagram_reels_private_fanout_unsupported",
    }, { status: 422 });
  }
  if (privateReel) {
    const destination = confirmation.destinations.find(item => item.id === requestedDestinationIds[0]);
    if (!destination || destination.provider !== "instagram") {
      return Response.json({ error: "The confirmed destination set is invalid.", code: "invalid_confirmation" }, { status: 409 });
    }
    const result = await dispatchSupabaseV76InstagramReel({
      db,
      publishInput: { uid, receipt: confirmation.receipt, destination },
      publishReel: async (_current, signedFrozenCopyUrl) => {
        let connection: SocialConnection | null;
        try {
          connection = await findConnection(uid, destination.socialConnectionId ?? "");
        } catch {
          return { ok: false, status: "failed", error: "Could not prepare the Instagram connection.", preNetwork: true };
        }
        if (!connection || connection.connectionStatus !== "connected") {
          return { ok: false, status: "failed", error: "Connect your Instagram account in Settings to publish here.", preNetwork: true };
        }
        // Do not catch this provider-boundary call: it may have reached Meta.
        // The durable dispatcher will settle a thrown/ambiguous delivery as
        // delivery_unknown and forbid a blind retry.
        return getSocialProviderById(connection.authProvider).publishPost({
          provider: "instagram",
          connection,
          post: { ...post, imageUrls: [], videoUrls: [signedFrozenCopyUrl] },
          userId: uid,
        });
      },
    });
    const status = result.outcome === "published" ? 201 : result.outcome === "failed" ? 422 : 409;
    return Response.json({
      ok: result.outcome === "published",
      replayed: result.replayed === true,
      status: result.outcome,
      intentId: confirmation.receipt.intentId,
      jobId: null,
      destinations: [{
        provider: "instagram",
        socialConnectionId: destination.socialConnectionId ?? null,
        status: result.outcome === "published" ? "published" : result.outcome,
        externalPostId: result.remoteId ?? null,
        externalPostUrl: result.remoteUrl ?? null,
        retryAllowed: result.retryAllowed,
        remoteEvidence: result.evidence ?? {},
      }],
    }, { status });
  }
  const dispatchPost = post;
  const destinationById = new Map(confirmation.destinations.map(destination => [destination.id, destination]));
  const claims = new Map<string, { destination: PublishDestination; claim: PublishIntentClaim }>();
  try {
    const destinations: PublishDestination[] = [];
    for (const destinationId of [...requestedDestinationIds].sort()) {
      const destination = destinationById.get(destinationId);
      if (!destination || destination.provider === "pinterest") {
        return Response.json({ error: "The confirmed destination set is invalid.", code: "invalid_confirmation" }, { status: 409 });
      }
      destinations.push(destination);
    }
    const claimedDestinations = confirmation.receipt.priorIntentId
      ? await claimPublishRetryDestinations(db, uid, confirmation.receipt, destinations)
      : await claimPublishIntentDestinations(db, uid, confirmation.receipt, destinations);
    for (const claimed of claimedDestinations) {
      claims.set(claimed.destination.id, claimed);
    }
  } catch (error) {
    const code = error instanceof PublishIntentLedgerError ? error.code : "unavailable";
    if (code === "retry_not_allowed") {
      return Response.json({
        error: "Retry may include only destinations whose latest durable result failed and allows retry.",
        code: "retry_destination_not_allowed",
      }, { status: 409 });
    }
    return Response.json({ error: "Could not establish durable publish recovery.", code: `publish_intent_${code}` }, { status: code === "conflict" ? 409 : 503 });
  }

  const settleFreshClaimsNotSent = async (reason: string): Promise<boolean> => {
    const settlements = await Promise.all([...claims.values()].flatMap(({ destination, claim }) =>
      claim.claimed && claim.claimToken
        ? [settlePublishIntentDestination(db, uid, {
            intentId: confirmation.receipt.intentId,
            destinationId: destination.id,
            claimToken: claim.claimToken,
            status: "failed",
            retryAllowed: true,
            evidence: { category: "not_sent", reason },
          }).then(() => true).catch(() => false)]
        : []));
    return settlements.every(Boolean);
  };

  const recoveryClaim = [...claims.values()].find(({ claim }) =>
    !claim.claimed && (claim.status === "claimed" || claim.status === "delivery_unknown"));
  if (recoveryClaim) {
    // If this request freshly re-claimed a known failure before discovering a sibling
    // whose delivery is unknown, release the fresh claim as a typed not-sent failure.
    // Nothing remains stuck merely because all destinations are claimed independently.
    const released = await settleFreshClaimsNotSent("sibling_recovery_pending");
    if (!released) {
      return Response.json({
        error: "Could not release a durable publish claim. Reconcile this intent before retrying.",
        code: "publish_intent_settlement_unavailable",
        intentId: confirmation.receipt.intentId,
        intentJobId: recoveryClaim.claim.intentJobId,
      }, { status: 503 });
    }
    return Response.json({
      error: "A previous publish has unknown delivery. Reconcile the original intent before retrying.",
      code: "delivery_recovery_pending",
      intentId: confirmation.receipt.intentId,
      jobId: recoveryClaim.claim.destinationJobId,
      intentJobId: recoveryClaim.claim.intentJobId,
      remoteEvidence: recoveryClaim.claim.evidence,
    }, { status: 409 });
  }

  const dispatchDestinationIds = new Set([...claims.entries()].filter(([, value]) => value.claim.claimed).map(([id]) => id));
  const replayedOutcomes: DestOutcome[] = [...claims.values()].flatMap(({ destination, claim }) => {
    if (claim.claimed) return [];
    return [{
      provider: destination.provider,
      socialConnectionId: destination.socialConnectionId,
      status: claim.status === "published" ? "published" : "failed",
      externalPostId: claim.remoteId,
      externalPostUrl: claim.remoteUrl,
      providerStatus: claim.providerStatus,
      providerResourceId: claim.remoteId,
      error: typeof claim.evidence.error === "string" ? claim.evidence.error : null,
      errorCode: typeof claim.evidence.errorCode === "string" ? claim.evidence.errorCode : null,
      attempt: claim.attempt,
    } satisfies DestOutcome];
  });

  if (dispatchDestinationIds.size === 0) {
    return Response.json({
      ok: replayedOutcomes.every(outcome => outcome.status === "published"),
      replayed: true,
      jobId: replayedOutcomes.length === 1 ? [...claims.values()][0].claim.providerJobId : null,
      intentId: confirmation.receipt.intentId,
      intentJobId: [...claims.values()][0]?.claim.intentJobId ?? null,
      status: rollUpJobStatus(replayedOutcomes),
      destinations: replayedOutcomes,
    });
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
  let meterKey: string | null = null;
  // Whether THIS request's consume actually charged a unit (v68 `replayed:false`).
  // Read by the refund gate below — see the comment there.
  let meterFresh = false;
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
    // Kept so a refund below releases the EXACT key that was charged — including a
    // relayed bucket override. Re-deriving at refund time could resolve to a
    // different UTC day and refund nothing.
    meterKey = deriveScheduledPostKey(uid, postId, undefined, bucketOverride);
    const consumed = await consumeScheduledPost({
      userId: uid,
      key: meterKey,
      referenceId: postId,
      metadata: { source: "social_immediate" },
    });
    meterFresh = consumed.kind === "consumed" && consumed.fresh === true;

    // ── A.4.0 BLOCKING SITE — refuse over-quota BEFORE any provider dispatch ────
    // Before this, `insufficient` was recorded and thrown away here too, so the
    // scheduled-post enforce flag gated nothing on the social path either. Placed
    // ahead of createPublishJob as well as the dispatch loop: a refused publish must
    // leave no half-written job row claiming an attempt that never happened. No
    // refund — an `insufficient` consume charged nothing to give back. In shadow
    // this branch is unreachable and the route behaves exactly as before.
    if (consumed.kind === "insufficient" && usageEnforceFor("scheduled_post")) {
      const released = await settleFreshClaimsNotSent("scheduled_post_limit_reached");
      if (!released) {
        return Response.json({
          error: "Could not release a durable publish claim.",
          code: "publish_intent_settlement_unavailable",
          intentId: confirmation.receipt.intentId,
          intentJobId: [...claims.values()][0]?.claim.intentJobId ?? null,
        }, { status: 503 });
      }
      return Response.json(scheduledPostLimitResponseBody(), { status: 402 });
    }
  } else {
    // No draft identity on the request — never charge a key that could collide
    // across drafts. Direct API callers that omit postId are simply unmetered.
    logEvent("usage_meter_skipped", { reason: "no_draft_identity", route: "publish_social" });
  }

  const outcomes: DestOutcome[] = [...replayedOutcomes];
  // Parallel to `outcomes`, but only for targets we actually ATTEMPTED — the refund
  // classification (below) must not see skips, which are not delivery failures.
  const deliveries: DeliveryOutcome[] = [];
  const requestStartedAt = new Date().toISOString();

  /**
   * ── PRE-DISPATCH THROWS MUST RELEASE A FRESH CONSUME (Codex round 8, High 2) ──
   * The consume above is taken BEFORE anything is looked up or dispatched, so every
   * step between it and the first provider call is charged-but-unsent territory: a
   * throw from `summarizeConnections`, `createPublishJob` or the in-loop
   * `findConnection` (Supabase unavailable, v32 tables missing, a bug) unwound
   * straight out of this handler and left the unit charged although NO platform was
   * ever contacted. That is `not_sent` by the §A.4 table — the same state the loop
   * already refunds when a destination has no connected account.
   *
   * `dispatchStarted` is what keeps this honest, and it is why a plain try/catch
   * around the two lookups is not enough: `findConnection` runs INSIDE the loop, so
   * a throw there is pre-dispatch on the first target but post-dispatch on a later
   * one. Once ANY `publishPost` has been entered we can no longer prove the post was
   * not created, so a throw from that point on must keep its charge
   * (`delivery_unknown`) exactly as the existing inner catch decides.
   *
   * The try deliberately CLOSES before the settlement block below: with nothing
   * attempted, `aggregateDelivery([])` is `delivery_unknown` (charged by design), and
   * letting a settlement-time throw re-enter this catch with `dispatchStarted` still
   * false would refund it — the very free-publish bypass the settlement comment warns
   * about.
   */
  let dispatchStarted = false;
  let jobId: Awaited<ReturnType<typeof createPublishJob>> = null;

  try {
  // Create the attempt BEFORE dispatching anything. Previously the job row was
  // written only after every provider call returned, so a crash mid-publish left
  // a post live on the platform with no record of it, and a client that
  // refreshed during publishing had no in-flight state to recover — it simply
  // saw nothing. The row starts as `publishing` and is finalized once the
  // outcomes are known.
  jobId = await createPublishJob(db, uid, postId, productId, {
    intentId: confirmation.receipt.intentId,
    fingerprint: confirmation.receipt.fingerprint,
  });
  for (const raw of requested) {
    const provider = (raw as { provider?: unknown }).provider;
    if (!isSocialProvider(provider)) continue;

    const connectionId = typeof (raw as { socialConnectionId?: unknown }).socialConnectionId === "string"
      ? (raw as { socialConnectionId: string }).socialConnectionId.trim()
      : "";
    if (!dispatchDestinationIds.has(`${provider}:${connectionId}`)) continue;

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

    const connection: SocialConnection | null = await findConnection(uid, connectionId);

    if (!connection || connection.connectionStatus !== "connected") {
      // Refused here, before any network call → `not_sent`, refundable.
      deliveries.push(classifyDelivery({ preNetwork: true }));
      outcomes.push({
        provider,
        status: "failed",
        socialConnectionId: connection?.id ?? null,
        error: `Connect your ${platformName(provider)} account in Settings to publish here.`,
      });
      continue;
    }

    try {
      // From here on we cannot prove the platform was NOT reached: any throw past
      // this point keeps its charge (`delivery_unknown`), never a pre-dispatch refund.
      dispatchStarted = true;
      const result = await getSocialProviderById(connection.authProvider).publishPost({
        provider,
        connection,
        post: dispatchPost,
        // Providers backed by our OWN OAuth (Facebook) read server-only,
        // per-user credentials (the encrypted PAGE token) that are deliberately
        // absent from the client-safe SocialConnection projection. `uid` is the
        // bearer-verified session user — never a client-supplied value.
        userId: uid,
      });
      // `not_implemented` never reached a platform → pre-network, refundable. So is
      // any failure the provider itself decided before dispatching (`result.preNetwork`
      // — missing credentials, no Page/account selected, a local media-rule refusal):
      // those carry no providerStatus and would otherwise be indistinguishable from a
      // timeout, i.e. charged as `delivery_unknown`. See lib/social/types.ts.
      const delivery = classifyDelivery({
        ok: result.ok,
        preNetwork: result.status === "not_implemented" || result.preNetwork === true,
        providerStatus: result.providerStatus,
        providerResourceId: result.providerResourceId ?? result.externalPostId ?? null,
      });
      deliveries.push(delivery);
      outcomes.push({
        provider,
        status: result.ok ? "published" : delivery === "delivery_unknown" ? "delivery_unknown" : "failed",
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
        errorCode: result.ok ? null : result.status,
        providerStatus: result.providerStatus ?? null,
        providerResourceId: result.providerResourceId ?? result.externalPostId ?? null,
        preNetwork: result.status === "not_implemented" || result.preNetwork === true,
        attempt: 1,
        startedAt: requestStartedAt,
        finishedAt: new Date().toISOString(),
      });
    } catch (err) {
      // A provider that THREW instead of returning a typed failure. The two provider
      // fields are read off it if present; otherwise this is `delivery_unknown` and
      // the charge stands — we cannot prove the post was not created.
      const signal = readProviderSignal(err);
      const delivery = classifyDelivery(signal);
      deliveries.push(delivery);
      outcomes.push({
        provider,
        status: delivery === "delivery_unknown" ? "delivery_unknown" : "failed",
        socialConnectionId: connection.id,
        error: (err as Error).message || "Publishing failed.",
        errorCode: "provider_dispatch_error",
        providerStatus: signal.providerStatus ?? null,
        providerResourceId: signal.providerResourceId ?? null,
        attempt: 1,
        startedAt: requestStartedAt,
        finishedAt: new Date().toISOString(),
      });
    }
  }
  } catch (err) {
    // Charged, but nothing was ever sent → give the unit back and let the original
    // error propagate untouched (the caller's response must not change shape because
    // a refund happened). `releaseScheduledPost` never throws — it catches its own
    // RPC/transport errors and returns `{kind:"error"}` — so this is fail-open by
    // construction, exactly like the settlement release below.
    if (meterKey && postId && meterFresh && !dispatchStarted) {
      await releaseScheduledPost({
        userId: uid,
        key: meterKey,
        reason: "not_sent",
        referenceId: postId,
        metadata: { source: "social_immediate", route: "publish_social", stage: "pre_dispatch" },
      });
    }
  const settlementResults = await Promise.all([...claims.values()].flatMap(({ destination, claim }) =>
      claim.claimed && claim.claimToken
        ? [(() => {
          const settlement = classifyDispatchSettlement(destination, outcomes, dispatchStarted);
          return settlePublishIntentDestination(db, uid, {
            intentId: confirmation.receipt.intentId,
            destinationId: destination.id,
            claimToken: claim.claimToken,
            status: settlement.status,
            retryAllowed: settlement.retryAllowed,
            providerJobId: jobId,
            remoteId: settlement.outcome?.externalPostId,
            remoteUrl: settlement.outcome?.externalPostUrl,
            providerStatus: settlement.outcome?.providerStatus,
            evidence: {
              category: settlement.outcome?.status ?? (dispatchStarted ? "delivery_unknown" : "not_sent"),
              error: (settlement.outcome?.error ?? (err as Error)?.message) || "Publishing failed.",
              providerResourceId: settlement.outcome?.providerResourceId ?? null,
            },
          }).then(() => true).catch(() => false);
        })()]
        : []));
    if (!settlementResults.every(Boolean)) {
      return Response.json({
        error: "The durable publish claim could not be settled. Reconcile this intent before retrying.",
        code: "publish_intent_settlement_unavailable",
        intentId: confirmation.receipt.intentId,
        intentJobId: [...claims.values()][0]?.claim.intentJobId ?? null,
        jobId,
        dispatchStarted,
        remoteEvidence: outcomes.map(outcome => ({
          provider: outcome.provider,
          socialConnectionId: outcome.socialConnectionId,
          status: outcome.status,
          remoteId: outcome.externalPostId ?? null,
          remoteUrl: outcome.externalPostUrl ?? null,
          providerStatus: outcome.providerStatus ?? null,
        })),
      }, { status: 503 });
    }
    return Response.json({
      error: dispatchStarted
        ? "Delivery status is unknown. Reconcile the original publish intent before retrying."
        : "Publishing could not start.",
      code: dispatchStarted ? "delivery_unknown" : "publish_not_started",
      intentId: confirmation.receipt.intentId,
      intentJobId: [...claims.values()][0]?.claim.intentJobId ?? null,
      jobId,
    }, { status: 503 });
  }

  /**
   * ── DELIVERY TRI-STATE → REFUND (design §A.4; PRD v3.2 §5.3/§5.4) ────────────
   * One Content = one charged unit however many platforms it fans out to, so the
   * refund decision is singular too — `aggregateDelivery` collapses the per-target
   * classifications:
   *
   *   not_sent  (REFUND)  every attempted target failed before leaving us: no
   *                       connected account for it, a platform we cannot publish to
   *                       (`not_implemented`), or the route refused it outright.
   *   rejected  (REFUND)  every attempted target got a real platform 4xx and no post
   *                       id back.
   *   sent      (CHARGE)  ANY target published. Refunding a partial success would
   *                       make adding one deliberately broken destination a free
   *                       publish for all the others.
   *   delivery_unknown    any target timed out / 5xx'd / reported no status, or
   *             (CHARGE)  nothing was attempted at all.
   *
   * `skipped` targets (Pinterest, which has its own route, and coming-soon
   * platforms) contribute NOTHING: they are not attempts, and counting them as
   * `not_sent` would refund a Content whose real destinations all published.
   */
  /**
   * ── ONLY A FRESH CONSUME MAY BE RELEASED (Codex round 7, High 1 + High 2) ──────
   * This route deliberately consumes UNCONDITIONALLY (see the long comment above the
   * consume), which for a multi-platform publish means it lands on the key
   * /api/pinterest/pins already charged — as a REPLAY, no second unit. That replay is
   * what makes one Content cost one unit, and it is also what made refunding here
   * dangerous: `usage_release_scheduled_post` takes only (user, K, reason), so it
   * refunds the family's standing consume no matter which route asks. Pinterest could
   * publish the Pin (charge earned), every social target could then be rejected, and
   * this block would refund the delivered Pin. The same shape refunds a preceding
   * `delivery_unknown`, and a same-day retry of an already-successful publish refunds
   * an earned unit.
   * So: release only when THIS request's own consume was fresh (v68 `replayed:false`
   * — this request inserted the consume event, on K or on a re-armed K:r<n> after an
   * earlier refund). `off` / `insufficient` / `error` consumes are excluded for the
   * same reason: they charged nothing here, so a release could only hit another
   * attempt's consume.
   * Residual, deferred to publish-action identity (PRD v3.2 §21 5A): two CONCURRENT
   * attempts on the same key where the fresh one fails and the replaying one succeeds
   * still refunds a delivered publish. A same-day retry after a prior SUCCESS is not a
   * residual — correctly non-refundable, the unit was earned.
   */
  if (meterKey && postId && meterFresh) {
    const outcome: DeliveryOutcome = aggregateDelivery(deliveries);
    if (isRefundable(outcome)) {
      await releaseScheduledPost({
        userId: uid,
        key: meterKey,
        reason: outcome,
        referenceId: postId,
        metadata: { source: "social_immediate", route: "publish_social" },
      });
    }
  }

  const jobStatus = rollUpJobStatus(outcomes);
  // Write the per-destination results and move the job off `publishing`. Skipped
  // when the v32 tables are absent (createPublishJob returned null) — publishing
  // itself must not fail just because the record could not be kept.
  let outcomePersistenceFailed = false;
  if (jobId) outcomePersistenceFailed = !(await recordOutcomes(db, jobId, outcomes));

  // Finalize the durable receipt rows before returning anything to the browser. Every
  // response can therefore be recovered by original intent id even if it is lost in
  // transit after this point.
  try {
    for (const { destination, claim } of claims.values()) {
      if (!claim.claimed || !claim.claimToken) continue;
      const outcome = outcomes.find(item => item.provider === destination.provider
        && item.socialConnectionId === destination.socialConnectionId);
      const status = outcome?.status === "published"
        ? "published" as const
        : outcome?.status === "delivery_unknown"
          ? "delivery_unknown" as const
          : "failed" as const;
      const preNetwork = outcome?.preNetwork === true || outcome?.status === "skipped";
      const providerRejectedWithoutObject = typeof outcome?.providerStatus === "number"
        && outcome.providerStatus >= 400
        && outcome.providerStatus < 500
        && !outcome.externalPostId
        && !outcome.providerResourceId;
      await settlePublishIntentDestination(db, uid, {
        intentId: confirmation.receipt.intentId,
        destinationId: destination.id,
        claimToken: claim.claimToken,
        status,
        retryAllowed: status === "failed" && (preNetwork || providerRejectedWithoutObject),
        providerJobId: jobId,
        remoteId: outcome?.externalPostId,
        remoteUrl: outcome?.externalPostUrl,
        providerStatus: outcome?.providerStatus,
        evidence: {
          category: status,
          error: outcome?.error ?? null,
          errorCode: outcome?.errorCode ?? null,
          providerResourceId: outcome?.providerResourceId ?? outcome?.externalPostId ?? null,
          startedAt: outcome?.startedAt ?? requestStartedAt,
          finishedAt: outcome?.finishedAt ?? new Date().toISOString(),
        },
      });
    }
  } catch {
    return Response.json({
      error: "The provider response could not be durably recorded. Reconcile this intent before retrying.",
      code: "publish_intent_settlement_unavailable",
      intentId: confirmation.receipt.intentId,
      intentJobId: [...claims.values()][0]?.claim.intentJobId ?? null,
      jobId,
      remoteEvidence: outcomes.map(outcome => ({
        provider: outcome.provider,
        socialConnectionId: outcome.socialConnectionId,
        status: outcome.status,
        remoteId: outcome.externalPostId ?? null,
        remoteUrl: outcome.externalPostUrl ?? null,
        providerStatus: outcome.providerStatus ?? null,
      })),
    }, { status: 503 });
  }

  if (outcomePersistenceFailed) {
    return Response.json({
      error: "The publish result could not be durably recorded. Reconcile this intent before retrying.",
      code: "publish_intent_settlement_unavailable",
      intentId: confirmation.receipt.intentId,
      intentJobId: [...claims.values()][0]?.claim.intentJobId ?? null,
      jobId,
      remoteEvidence: outcomes.map(outcome => ({
        provider: outcome.provider,
        socialConnectionId: outcome.socialConnectionId,
        status: outcome.status,
        remoteId: outcome.externalPostId ?? null,
        remoteUrl: outcome.externalPostUrl ?? null,
        providerStatus: outcome.providerStatus ?? null,
      })),
    }, { status: 503 });
  }

  return Response.json({
    ok: jobStatus === "published",
    jobId,
    intentId: confirmation.receipt.intentId,
    intentJobId: [...claims.values()][0]?.claim.intentJobId ?? null,
    status: jobStatus,
    destinations: outcomes.map(o => ({
      provider: o.provider,
      status: o.status,
      // The remote post id/url are the ONLY provider-side identifiers exposed to
      // the client — never a token, never a connection secret. The UI needs both:
      // the url powers "View on Facebook", the id is the durable reference.
      externalPostId: o.externalPostId ?? null,
      externalPostUrl: o.externalPostUrl ?? null,
      socialConnectionId: o.socialConnectionId,
      accountName: o.accountName ?? null,
      error: o.error ?? null,
      errorCode: o.errorCode ?? null,
      providerStatus: o.providerStatus ?? null,
      attempt: o.attempt ?? null,
      startedAt: o.startedAt ?? null,
      finishedAt: o.finishedAt ?? null,
      intentId: confirmation.receipt.intentId,
      jobId: claims.get(`${o.provider}:${o.socialConnectionId ?? ""}`)?.claim.destinationJobId ?? jobId,
      remoteEvidence: {
        remoteId: o.externalPostId ?? null,
        remoteUrl: o.externalPostUrl ?? null,
        providerStatus: o.providerStatus ?? null,
        providerResourceId: o.providerResourceId ?? null,
      },
    })),
  });
}

