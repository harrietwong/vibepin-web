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
 *   - mapping the typed PublishResult / thrown errors onto HTTP responses.
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

  const sourcePinId = typeof body.sourcePinId === "string" ? body.sourcePinId.trim() : "";
  const lockKey = sourcePinId ? `${uid}:${sourcePinId}` : null;
  if (lockKey) {
    if (_inFlightPublishes.has(lockKey)) {
      return Response.json(
        { error: "This Pin is already being published.", code: "publish_in_progress" },
        { status: 409 },
      );
    }
    _inFlightPublishes.add(lockKey);
  }

  try {
    const result = await publishPinForUser({
      uid,
      boardId: typeof body.boardId === "string" ? body.boardId : "",
      imageUrl: body.imageUrl,
      title: body.title,
      description: body.description,
      link: body.link,
      altText: body.altText,
    });

    if (!result.ok) {
      return Response.json({ error: result.error, code: result.code }, { status: result.status });
    }

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
    return pinterestErrorResponse(err);
  } finally {
    if (lockKey) _inFlightPublishes.delete(lockKey);
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
