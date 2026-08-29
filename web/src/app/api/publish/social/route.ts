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
  let meterKey: string | null = null;
  // Whether THIS request's consume actually charged a unit (v67 `replayed:false`).
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
      return Response.json(scheduledPostLimitResponseBody(), { status: 402 });
    }
  } else {
    // No draft identity on the request — never charge a key that could collide
    // across drafts. Direct API callers that omit postId are simply unmetered.
    logEvent("usage_meter_skipped", { reason: "no_draft_identity", route: "publish_social" });
  }

  const outcomes: DestOutcome[] = [];
  // Parallel to `outcomes`, but only for targets we actually ATTEMPTED — the refund
  // classification (below) must not see skips, which are not delivery failures.
  const deliveries: DeliveryOutcome[] = [];

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
  let summaries: Awaited<ReturnType<typeof summarizeConnections>>;
  let byProvider: Map<SocialProvider, (typeof summaries)[number]>;
  let db: ReturnType<typeof createServerClient>;
  let jobId: Awaited<ReturnType<typeof createPublishJob>>;

  try {
  summaries = await summarizeConnections(uid);
  byProvider = new Map(summaries.map(s => [s.provider, s]));

  // Create the attempt BEFORE dispatching anything. Previously the job row was
  // written only after every provider call returned, so a crash mid-publish left
  // a post live on the platform with no record of it, and a client that
  // refreshed during publishing had no in-flight state to recover — it simply
  // saw nothing. The row starts as `publishing` and is finalized once the
  // outcomes are known.
  db = createServerClient();
  jobId = await createPublishJob(db, uid, postId, productId);
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
        post,
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
      deliveries.push(classifyDelivery({
        ok: result.ok,
        preNetwork: result.status === "not_implemented" || result.preNetwork === true,
        providerStatus: result.providerStatus,
        providerResourceId: result.providerResourceId ?? result.externalPostId ?? null,
      }));
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
      // A provider that THREW instead of returning a typed failure. The two provider
      // fields are read off it if present; otherwise this is `delivery_unknown` and
      // the charge stands — we cannot prove the post was not created.
      deliveries.push(classifyDelivery(readProviderSignal(err)));
      outcomes.push({
        provider,
        status: "failed",
        socialConnectionId: connection.id,
        error: (err as Error).message || "Publishing failed.",
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
    throw err;
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
   * So: release only when THIS request's own consume was fresh (v67 `replayed:false`
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
