/**
 * POST /api/pinterest/pins
 *
 * Publishes an existing generated Pin to a board on the connected account.
 *
 * Body:
 *   { boardId, title?, description?, link?, altText?, imageUrl, sourcePinId? }
 *
 * This route is a thin HTTP shell around `publishPinForUser` (lib/server/pinterest/
 * publishPin.ts) so a scheduler/cron worker can reuse the exact same publish logic
 * without any Request/Response coupling. This shell owns only:
 *   - authentication (Bearer / cookie session),
 *   - JSON body parsing,
 *   - the per-process duplicate-publish in-flight lock (publish_in_progress),
 *   - mapping the typed PublishResult / thrown errors onto HTTP responses,
 *   - best-effort publish analytics (attempted / succeeded / failed events).
 *
 * Security:
 *   - Requires the authenticated VibePin user (Bearer).
 *   - The board MUST belong to the connected account. Pinterest itself enforces
 *     this (createPin runs with that account's own token, so a foreign board id
 *     is rejected upstream); the server-side lookup runs concurrently only to
 *     supply the board name and a friendly board_not_owned error.
 *   - imageUrl must be a public http(s) URL (no localhost/blob/data/private hosts).
 *   - Returns the real Pinterest Pin id + URL only after Pinterest confirms.
 */

import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { pinterestErrorResponse, unauthorized } from "@/lib/server/pinterest/routeHelpers";
import {
  consumeScheduledPost,
  deriveScheduledPostKey,
  immediateBucketForNow,
  releaseScheduledPost,
  scheduledPostLimitResponseBody,
  signImmediateBucket,
  usageEnforceFor,
} from "@/lib/server/usage/meterScheduledPost";
import {
  classifyDelivery,
  isRefundable,
  readProviderSignal,
  type DeliveryOutcome,
} from "@/lib/server/usage/deliveryOutcome";
import { NeedsReconnectError, NotConnectedError, PinterestTrialAccessError } from "@/lib/server/pinterest/service";
import { publishPinForUser } from "@/lib/server/pinterest/publishPin";
import { createServerClient } from "@/lib/supabase";
import {
  recordPublishEvent,
  recordFailedPublishEvent,
  newPublishAttemptId,
  PUBLISH_EVENT_ATTEMPTED,
  PUBLISH_EVENT_SUCCEEDED,
  type PublishEventBase,
} from "@/lib/server/publishEvents";
import {
  validateImmediatePublishReceipt,
  validateStoredImmediatePublishReceipt,
} from "@/lib/server/publish/confirmationReceipt";
import {
  PublishIntentLedgerError,
  claimPublishIntentDestination,
  claimPublishRetryDestinations,
  settlePublishIntentDestination,
} from "@/lib/server/publish/publishIntentLedger";
import { findConnection } from "@/lib/social/server/socialConnectionStore";
import { resolveDestinationCapability } from "@/lib/social/destinationCapability";
import { requiresPublishAsset } from "@/lib/server/publishMedia";

export const dynamic = "force-dynamic";

// Best-effort duplicate-publish guard, keyed by `${userId}:${sourcePinId}`.
// Per-process, in-memory only — NOT durable idempotency: it does not survive
// server restarts and does not coordinate across multiple instances. It only
// catches an accidental duplicate request racing in on the SAME process (e.g. a
// double-click that slipped past the client-side guards). sourcePinId is optional;
// requests that omit it are never locked (unchanged behavior).
const _inFlightPublishes = new Set<string>();

export async function POST(req: Request) {
  const uid = await getUserIdFromBearerOrCookies(req);
  if (!uid) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body", code: "bad_request" }, { status: 400 });
  }

  const boardId = typeof body.boardId === "string" ? body.boardId.trim() : "";
  const sourcePinId = typeof body.sourcePinId === "string" ? body.sourcePinId.trim() : "";

  // Optional instrumentation fields — plumbed from client call sites, never required and
  // never block publish (missing draftId is a valid, nullable event field; an unrecognised
  // source degrades to "immediate"). See lib/server/publishEvents.ts for the contract.
  const draftId = typeof body.draftId === "string" && body.draftId.trim() ? body.draftId.trim() : null;
  const source =
    body.source === "immediate" || body.source === "scheduled-cron" ? body.source : "immediate";

  // Scheduled cron calls the server function directly and never enter this immediate
  // HTTP shell. Every request here therefore needs a full merchant confirmation.
  const destinationId = typeof body.destinationId === "string" ? body.destinationId.trim() : "";
  const imageUrls = Array.isArray(body.imageUrls)
    ? body.imageUrls.filter((item): item is string => typeof item === "string")
    : (typeof body.imageUrl === "string" ? [body.imageUrl] : []);
  const confirmation = validateImmediatePublishReceipt(body.confirmation, {
    draftId: draftId ?? "",
    title: typeof body.title === "string" ? body.title : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
    destinationUrl: typeof body.link === "string" ? body.link : undefined,
    altText: typeof body.altText === "string" ? body.altText : undefined,
    imageUrls,
  }, destinationId ? [destinationId] : []);
  if (!confirmation.ok) {
    return Response.json({ error: confirmation.error, code: confirmation.code }, { status: confirmation.code === "confirmation_required" ? 400 : 409 });
  }
  const confirmedDestination = confirmation.destinations.find(destination => destination.id === destinationId);
  if (!confirmedDestination || confirmedDestination.provider !== "pinterest"
      || confirmedDestination.boardId !== boardId
      || confirmedDestination.socialConnectionId !== (typeof body.connectionId === "string" ? body.connectionId.trim() : "")) {
    return Response.json({ error: "The Pinterest account or Board no longer matches the confirmation.", code: "invalid_confirmation" }, { status: 409 });
  }
  if (imageUrls.some(url => requiresPublishAsset(url, new URL(req.url).origin))) {
    return Response.json({
      error: "Publish media asset is not materialized for provider delivery.",
      code: "publish_asset_required",
    }, { status: 409 });
  }

  let durableDb: ReturnType<typeof createServerClient>;
  try {
    durableDb = createServerClient();
    const stored = await validateStoredImmediatePublishReceipt(durableDb, uid, confirmation.receipt);
    if (!stored.ok) {
      return Response.json({ error: stored.error, code: stored.code }, {
        status: stored.code === "invalid_confirmation" ? 409 : 503,
      });
    }
    const connection = await findConnection(uid, confirmedDestination.socialConnectionId);
    const capability = resolveDestinationCapability({
      provider: "pinterest",
      connection,
      connectionId: confirmedDestination.socialConnectionId,
      subdestinationId: boardId,
      mediaCount: imageUrls.length,
      mode: "now",
    });
    if (!capability.publishNow) {
      return Response.json({
        error: "This Pinterest destination is no longer available.",
        code: "destination_validation_failed",
        reasonCode: capability.unavailableReason,
      }, { status: 422 });
    }
  } catch (error) {
    console.error("[publish] durable preflight unavailable:", (error as Error)?.message ?? String(error));
    return Response.json({ error: "Could not verify the publishing destination.", code: "publish_intent_unavailable" }, { status: 503 });
  }

  let durableClaim: Awaited<ReturnType<typeof claimPublishIntentDestination>>;
  try {
    if (confirmation.receipt.priorIntentId) {
      const retryClaims = await claimPublishRetryDestinations(
        durableDb,
        uid,
        confirmation.receipt,
        [confirmedDestination],
      );
      const retryClaim = retryClaims[0];
      if (!retryClaim) throw new PublishIntentLedgerError("unavailable", "Durable retry claim was not returned.");
      durableClaim = retryClaim.claim;
    } else {
      durableClaim = await claimPublishIntentDestination(durableDb, uid, confirmation.receipt, confirmedDestination);
    }
  } catch (error) {
    const code = error instanceof PublishIntentLedgerError ? error.code : "unavailable";
    if (code === "retry_not_allowed") {
      return Response.json({
        error: "This Pinterest destination is no longer eligible for retry.",
        code: "retry_destination_not_allowed",
      }, { status: 409 });
    }
    return Response.json({ error: "Could not establish durable publish recovery.", code: `publish_intent_${code}` }, { status: code === "conflict" ? 409 : 503 });
  }
  if (!durableClaim.claimed) {
    if (durableClaim.status === "published" && durableClaim.remoteId && durableClaim.remoteUrl) {
      return Response.json({
        ok: true,
        replayed: true,
        pin: { id: durableClaim.remoteId, url: durableClaim.remoteUrl },
        board: { id: boardId, name: typeof durableClaim.evidence.boardName === "string" ? durableClaim.evidence.boardName : (confirmedDestination.boardName ?? "") },
        connectionId: confirmedDestination.socialConnectionId,
        intentId: confirmation.receipt.intentId,
        jobId: durableClaim.destinationJobId,
        intentJobId: durableClaim.intentJobId,
        remoteEvidence: durableClaim.evidence,
      });
    }
    return Response.json({
      error: durableClaim.status === "delivery_unknown"
        ? "Delivery status is unknown. Reconcile the original intent before retrying."
        : "This publish intent is already in progress.",
      code: durableClaim.status === "delivery_unknown" ? "delivery_unknown" : "publish_in_progress",
      intentId: confirmation.receipt.intentId,
      jobId: durableClaim.destinationJobId,
      intentJobId: durableClaim.intentJobId,
      remoteEvidence: durableClaim.evidence,
    }, { status: 409 });
  }
  const settleDurableClaim = async (input: {
    status: "published" | "failed" | "delivery_unknown";
    retryAllowed: boolean;
    remoteId?: string | null;
    remoteUrl?: string | null;
    providerStatus?: number | null;
    evidence?: Record<string, unknown>;
  }): Promise<boolean> => {
    if (!durableClaim.claimToken) return false;
    try {
      await settlePublishIntentDestination(durableDb, uid, {
        intentId: confirmation.receipt.intentId,
        destinationId,
        claimToken: durableClaim.claimToken,
        status: input.status,
        retryAllowed: input.retryAllowed,
        remoteId: input.remoteId,
        remoteUrl: input.remoteUrl,
        providerStatus: input.providerStatus,
        evidence: input.evidence,
      });
      return true;
    } catch (error) {
      console.error("[publish] durable settlement unavailable:", (error as Error)?.message ?? String(error));
      return false;
    }
  };
  const eventBase: PublishEventBase = {
    publishAttemptId: newPublishAttemptId(),
    userId: uid,
    draftId,
    boardId,
    source,
  };
  // Service-role client for the best-effort analytics writes. Construction itself is also
  // best-effort: a missing service-role env must degrade analytics, never break publish
  // (recordPublishEvent no-ops on null and swallows all write failures).
  let analyticsDb: ReturnType<typeof createServerClient> | null = null;
  try {
    analyticsDb = durableDb;
  } catch (err) {
    console.warn("[publish] analytics client unavailable:", err instanceof Error ? err.message : String(err));
  }

  const lockKey = sourcePinId ? `${uid}:${sourcePinId}` : null;
  if (lockKey) {
    if (_inFlightPublishes.has(lockKey)) {
      // A de-duped duplicate request never actually publishes — the winning request owns
      // this attempt's events, so emit nothing here (avoids double-counting one publish).
      const persisted = await settleDurableClaim({
        status: "failed",
        retryAllowed: true,
        evidence: { category: "not_sent", reason: "local_publish_in_progress" },
      });
      return Response.json(
        persisted
          ? { error: "This Pin is already being published.", code: "publish_in_progress" }
          : { error: "Could not release the durable publish claim.", code: "publish_intent_settlement_unavailable" },
        { status: persisted ? 409 : 503 },
      );
    }
    _inFlightPublishes.add(lockKey);
  }

  // Attempt starts here (past the de-dup gate). All three events share eventBase.publishAttemptId.
  const publishStartedMs = Date.now();
  // Fire-and-forget: the attempted event never blocks the publish it precedes.
  void recordPublishEvent(analyticsDb, PUBLISH_EVENT_ATTEMPTED, eventBase);

  // ── Phase 5B: meter the immediate publish ──────────────────────────────────
  // The frozen contract charges "publish now" exactly like a scheduled post —
  // otherwise switching to immediate would be a free bypass of the quota. Keyed on
  // (draftId, UTC date bucket): a double-click or client retry the same day is free,
  // while a deliberate republish tomorrow correctly counts again. draftId is required
  // (all live callers send it); sourcePinId is the documented fallback. Metered before
  // the provider call so a crash mid-publish still records the action the user took,
  // and fail-open in shadow so a ledger outage can never block a publish.
  // Minted ONCE, here, and relayed to the client in both the success and typed-failure
  // JSON below — this is the value /api/publish/social's second call for the SAME
  // Content should use instead of computing its own, so a UTC-midnight straddle
  // between the two requests cannot compute two different date buckets for one
  // publish (see meterScheduledPost.ts's module header).
  // mintedAt is the SAME instant the bucket itself is derived from — both travel to
  // the client together and the social route verifies the signature against this
  // exact pair (meterScheduledPost.ts's classifyImmediateBucket), never a value it
  // computes itself.
  const meteringBucketMintedAt = Date.now();
  const meteringBucket = immediateBucketForNow(meteringBucketMintedAt);
  // Signed only against draftId (never the sourcePinId fallback below): the social
  // route verifies a relayed bucket against ITS OWN `postId`, which the client always
  // sends as the draft id (see publishContent.ts) — signing against a different
  // identity here would make a legitimate relay unverifiable there. `null` (Fix 5,
  // production with no real salt configured) means "refuse to sign" — omit both sig
  // and mintedAt below rather than relay an unsigned/forgeable bucket.
  const meteringBucketSig = draftId ? signImmediateBucket(uid, draftId, meteringBucket, meteringBucketMintedAt) : undefined;
  const meterIdentity = draftId ?? (sourcePinId || null);
  // The key this request charged under. Kept so a refund below releases the EXACT
  // key that was consumed — re-deriving it would recompute the UTC bucket and could
  // land on a different day (and refund nothing).
  let meterKey: string | null = null;
  // Whether THIS request's consume actually charged a unit (v68 `replayed:false`).
  // The refund gate below reads it — see the comment there for why a replayed consume
  // must never be released.
  let meterFresh = false;
  if (meterIdentity) {
    meterKey = deriveScheduledPostKey(uid, meterIdentity, undefined, meteringBucket);
    const consumed = await consumeScheduledPost({
      userId: uid,
      key: meterKey,
      referenceId: meterIdentity,
      metadata: { source: "immediate" },
    });
    meterFresh = consumed.kind === "consumed" && consumed.fresh === true;

    // ── A.4.0 BLOCKING SITE — refuse over-quota BEFORE touching Pinterest ───────
    // Until now `insufficient` was recorded and discarded: the scheduled-post
    // enforce flag was a switch wired to nothing. This is the gate it turns on, and
    // it sits ahead of the provider call on purpose — a publish refused after
    // Pinterest already created the Pin is not a refusal, it is a lie plus a charge.
    // Both conditions are required: the global mode must be `enforce` AND the
    // per-type flag must be on (usageEnforceFor). In `shadow` this branch is
    // unreachable and behaviour is exactly as before. 402 matches the image/text
    // limit responses so the client's existing limit handling applies unchanged.
    // No refund here: an `insufficient` consume never charged anything.
    if (consumed.kind === "insufficient" && usageEnforceFor("scheduled_post")) {
      if (lockKey) _inFlightPublishes.delete(lockKey);
      void recordFailedPublishEvent(analyticsDb, eventBase, Date.now() - publishStartedMs, {
        code: "scheduled_post_limit_reached",
        message: "Scheduled post limit reached",
      });
      const persisted = await settleDurableClaim({
        status: "failed",
        retryAllowed: true,
        evidence: { category: "not_sent", reason: "scheduled_post_limit_reached" },
      });
      if (!persisted) {
        return Response.json({
          error: "Could not release the durable publish claim.",
          code: "publish_intent_settlement_unavailable",
          intentId: confirmation.receipt.intentId,
          jobId: durableClaim.destinationJobId,
          intentJobId: durableClaim.intentJobId,
        }, { status: 503 });
      }
      return Response.json(scheduledPostLimitResponseBody(), { status: 402 });
    }
  }

  /**
   * ── DELIVERY TRI-STATE → REFUND (design §A.4; PRD v3.2 §5.3/§5.4) ────────────
   * This route charges before publishing, so it owes a refund when nothing was
   * created. The mapping, in the order it is evaluated:
   *
   *   not_sent  (REFUND)  typed `result.ok === false` — every code in
   *                       PublishValidationFailure: bad_request, invalid_image_url,
   *                       invalid_link, board_not_owned, carousel_too_few,
   *                       carousel_too_many, carousel_aspect_mismatch — plus a thrown
   *                       NotConnectedError / NeedsReconnectError (incl.
   *                       MissingPinterestScopesError, its subclass). None of these
   *                       reached Pinterest.
   *   rejected  (REFUND)  thrown with a real Pinterest status 4xx AND no pin id.
   *   sent      (CHARGE)  result.ok === true, or a thrown error that nonetheless
   *                       carries a pin id.
   *   delivery_unknown    thrown with no provider status at all (DatabaseError,
   *             (CHARGE)  ConfigurationError, a socket error, our own 502 "Pinterest
   *                       did not return a Pin id" — which has no observed provider
   *                       status), or a 5xx.
   *
   * PinterestTrialAccessError is deliberately NOT refunded: the Pin is publishable,
   * just not until Pinterest approves the app, and the same key will be charged
   * again on the eventual retry. Refunding it would churn release/re-consume pairs
   * for an account that simply has not been approved yet.
   *
   * The classification reads ONLY `providerStatus` / `providerResourceId` — never
   * message text (see deliveryOutcome.ts).
   */
  const settleMetering = async (outcome: DeliveryOutcome): Promise<void> => {
    if (!meterKey || !meterIdentity) return;
    // ── ONLY A FRESH CONSUME MAY BE RELEASED (Codex round 7, High 1 + High 2) ────
    // The key K is shared with /api/publish/social (same Content) and with a same-day
    // retry of this same draft, while `usage_release_scheduled_post` takes only
    // (user, K, reason) — it refunds the family's standing consume regardless of who
    // asks. Without this gate, a request whose consume merely REPLAYED could give
    // back a unit another attempt charged and delivered. `fresh` is v68's own
    // `replayed:false`, i.e. "this request inserted the consume event".
    // Deliberately also excludes `off` / `insufficient` / `error` consumes: none of
    // them charged anything here, so a release after one of them could only hit a
    // PRIOR attempt's consume.
    // Residual, deferred to publish-action identity (PRD v3.2 §21 5A): two CONCURRENT
    // attempts on the same key where the fresh one fails and the replaying one
    // succeeds still refunds a delivered publish. A same-day retry AFTER a success is
    // not a residual — it is correctly non-refundable, the unit was earned.
    if (!meterFresh) return;
    if (!isRefundable(outcome)) return;
    await releaseScheduledPost({
      userId: uid,
      key: meterKey,
      reason: outcome,
      referenceId: meterIdentity,
      metadata: { source: "immediate", route: "pinterest_pins" },
    });
  };

  try {
    const result = await publishPinForUser({
      uid,
      boardId,
      imageUrl: body.imageUrl,
      // The Pin's full media set in display order, when the client sends one. Absent
      // ⇒ imageUrl alone, exactly as before. publishPinForUser validates every entry
      // and refuses a set Pinterest cannot take — it never truncates to the cover.
      imageUrls: body.imageUrls,
      title: body.title,
      description: body.description,
      link: body.link,
      altText: body.altText,
      // This Pin's pinned publish target. Only ever resolved through
      // PinterestClient.forConnection, which refuses rows that aren't this uid's — a
      // caller cannot publish onto someone else's account by naming their id.
      connectionId: body.connectionId,
    });

    if (!result.ok) {
      // A request-shaped failure (validation / board_not_owned) — one best-effort failed
      // event covers all of them; the typed result carries a stable code + message.
      void recordFailedPublishEvent(analyticsDb, eventBase, Date.now() - publishStartedMs, {
        code: result.code,
        message: result.error,
      });
      // Every typed failure is decided before (or instead of) a successful create —
      // board_not_owned included, since Pinterest refused it and created nothing.
      await settleMetering(classifyDelivery({ preNetwork: true }));
      const persisted = await settleDurableClaim({
        status: "failed",
        retryAllowed: true,
        evidence: { category: "not_sent", error: result.error, errorCode: result.code },
      });
      if (!persisted) {
        return Response.json({
          error: "The failed attempt could not be durably recorded. Reconcile this intent before retrying.",
          code: "publish_intent_settlement_unavailable",
          intentId: confirmation.receipt.intentId,
          jobId: durableClaim.destinationJobId,
          intentJobId: durableClaim.intentJobId,
        }, { status: 503 });
      }
      // meteringBucket travels even on a typed failure: the client may still proceed to
      // publish this Content's other (social) destinations, and that call needs the
      // SAME bucket this request metered under (see meterScheduledPost.ts header).
      // meteringBucketSig travels alongside it so the social route can AUTHENTICATE
      // the bucket, not merely accept whatever date shape it is handed.
      return Response.json(
        {
          error: result.error,
          code: result.code,
          intentId: confirmation.receipt.intentId,
          jobId: durableClaim.destinationJobId,
          intentJobId: durableClaim.intentJobId,
          meteringBucket,
          ...(meteringBucketSig ? { meteringBucketSig, meteringBucketMintedAt } : {}),
        },
        { status: result.status },
      );
    }

    void recordPublishEvent(analyticsDb, PUBLISH_EVENT_SUCCEEDED, {
      ...eventBase,
      durationMs: Date.now() - publishStartedMs,
      remotePinId: result.pin.id,
      remotePinUrl: result.pin.url,
    });
    const persisted = await settleDurableClaim({
      status: "published",
      retryAllowed: false,
      remoteId: result.pin.id,
      remoteUrl: result.pin.url,
      evidence: {
        category: "published",
        boardId: result.board.id,
        boardName: result.board.name,
        environment: result.environment ?? "production",
      },
    });
    if (!persisted) {
      return Response.json({
        error: "Pinterest confirmed the Pin, but its recovery receipt could not be durably recorded. Do not retry; reconcile this intent.",
        code: "publish_intent_settlement_unavailable",
        intentId: confirmation.receipt.intentId,
        jobId: durableClaim.destinationJobId,
        intentJobId: durableClaim.intentJobId,
        remoteEvidence: { remoteId: result.pin.id, remoteUrl: result.pin.url, boardId: result.board.id },
      }, { status: 503 });
    }
    return Response.json(
      {
        ok: true,
        pin: result.pin,
        board: result.board,
        environment: result.environment,
        // Which account this published through, so the client can pin an adopted
        // (previously untargeted) draft to it — adopt-once (PRD §14).
        connectionId: result.connectionId,
        intentId: confirmation.receipt.intentId,
        jobId: durableClaim.destinationJobId,
        intentJobId: durableClaim.intentJobId,
        remoteEvidence: { remoteId: result.pin.id, remoteUrl: result.pin.url, boardId: result.board.id },
        // Server-minted immediate-publish bucket (see meterScheduledPost.ts header) —
        // additive field, relayed by the client to /api/publish/social so a second
        // fan-out call for this SAME Content buckets identically even across a UTC
        // midnight straddle.
        meteringBucket,
        // HMAC over (uid, draftId, meteringBucket, meteringBucketMintedAt) so the social
        // route can verify this bucket really was minted here (and how long ago), not
        // merely accept an in-window date shape. Travels together with the sig — a
        // mintedAt with no sig (or vice versa) is meaningless to the verifier.
        ...(meteringBucketSig ? { meteringBucketSig, meteringBucketMintedAt } : {}),
      },
      { status: 201 },
    );
  } catch (err) {
    // Record the failure BEFORE mapping to a Response — recordFailedPublishEvent is fully
    // wrapped/best-effort so this can never mask the original Pinterest error.
    void recordFailedPublishEvent(analyticsDb, eventBase, Date.now() - publishStartedMs, err);
    // Classify by TYPE first, then by observed provider status. Our own connection
    // errors carry an HTTP `status` we chose (409/401) that no provider ever sent —
    // reading that as a provider rejection is exactly the bug the two-field rule
    // exists to prevent, so they are matched by class before any status is consulted.
    let durableStatus: "failed" | "delivery_unknown" = "delivery_unknown";
    let retryAllowed = false;
    if (err instanceof PinterestTrialAccessError) {
      // Not a delivery failure — an app-approval state. Charge stands (see above).
      durableStatus = "failed";
      retryAllowed = true;
    } else if (err instanceof NotConnectedError || err instanceof NeedsReconnectError) {
      await settleMetering(classifyDelivery({ preNetwork: true }));
      durableStatus = "failed";
      retryAllowed = true;
    } else {
      const signal = readProviderSignal(err);
      const delivery = classifyDelivery(signal);
      await settleMetering(delivery);
      durableStatus = delivery === "delivery_unknown" ? "delivery_unknown" : "failed";
      retryAllowed = durableStatus === "failed";
    }
    const signal = readProviderSignal(err);
    const persisted = await settleDurableClaim({
      status: durableStatus,
      retryAllowed,
      providerStatus: signal.providerStatus,
      remoteId: signal.providerResourceId,
      evidence: {
        category: durableStatus,
        error: (err as Error)?.message ?? "Publishing failed.",
        providerResourceId: signal.providerResourceId ?? null,
      },
    });
    // meteringBucket(+Sig) travels even on an UNTYPED (thrown) failure, for the same
    // reason it travels on a typed one above: the client may still proceed to this
    // Content's social destinations, and that call needs the identical bucket this
    // request metered under.
    if (!persisted) {
      return Response.json({
        error: "The provider result could not be durably recorded. Reconcile this intent before retrying.",
        code: "publish_intent_settlement_unavailable",
        intentId: confirmation.receipt.intentId,
        jobId: durableClaim.destinationJobId,
        intentJobId: durableClaim.intentJobId,
        remoteEvidence: { providerStatus: signal.providerStatus ?? null, remoteId: signal.providerResourceId ?? null },
      }, { status: 503 });
    }
    return pinterestErrorResponse(err, {
      meteringBucket,
      ...(meteringBucketSig ? { meteringBucketSig, meteringBucketMintedAt } : {}),
      intentId: confirmation.receipt.intentId,
      jobId: durableClaim.destinationJobId,
      intentJobId: durableClaim.intentJobId,
      remoteEvidence: { providerStatus: signal.providerStatus ?? null, remoteId: signal.providerResourceId ?? null },
    });
  } finally {
    if (lockKey) _inFlightPublishes.delete(lockKey);
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
