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
    analyticsDb = createServerClient();
  } catch (err) {
    console.warn("[publish] analytics client unavailable:", err instanceof Error ? err.message : String(err));
  }

  const lockKey = sourcePinId ? `${uid}:${sourcePinId}` : null;
  if (lockKey) {
    if (_inFlightPublishes.has(lockKey)) {
      // A de-duped duplicate request never actually publishes — the winning request owns
      // this attempt's events, so emit nothing here (avoids double-counting one publish).
      return Response.json(
        { error: "This Pin is already being published.", code: "publish_in_progress" },
        { status: 409 },
      );
    }
    _inFlightPublishes.add(lockKey);
  }

  // Attempt starts here (past the de-dup gate). All three events share eventBase.publishAttemptId.
  const publishStartedMs = Date.now();
  // Fire-and-forget: the attempted event never blocks the publish it precedes.
  void recordPublishEvent(analyticsDb, PUBLISH_EVENT_ATTEMPTED, eventBase);

  try {
    const result = await publishPinForUser({
      uid,
      boardId,
      imageUrl: body.imageUrl,
      title: body.title,
      description: body.description,
      link: body.link,
      altText: body.altText,
    });

    if (!result.ok) {
      // A request-shaped failure (validation / board_not_owned) — one best-effort failed
      // event covers all of them; the typed result carries a stable code + message.
      void recordFailedPublishEvent(analyticsDb, eventBase, Date.now() - publishStartedMs, {
        code: result.code,
        message: result.error,
      });
      return Response.json({ error: result.error, code: result.code }, { status: result.status });
    }

    void recordPublishEvent(analyticsDb, PUBLISH_EVENT_SUCCEEDED, {
      ...eventBase,
      durationMs: Date.now() - publishStartedMs,
      remotePinId: result.pin.id,
      remotePinUrl: result.pin.url,
    });
    return Response.json(
      {
        ok: true,
        pin: result.pin,
        board: result.board,
        environment: result.environment,
      },
      { status: 201 },
    );
  } catch (err) {
    // Record the failure BEFORE mapping to a Response — recordFailedPublishEvent is fully
    // wrapped/best-effort so this can never mask the original Pinterest error.
    void recordFailedPublishEvent(analyticsDb, eventBase, Date.now() - publishStartedMs, err);
    return pinterestErrorResponse(err);
  } finally {
    if (lockKey) _inFlightPublishes.delete(lockKey);
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
