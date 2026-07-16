/**
 * POST /api/pinterest/pins
 *
 * Publishes an existing generated Pin to a board on the connected account.
 *
 * Body:
 *   { boardId, title?, description?, link?, altText?, imageUrl, sourcePinId? }
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
import { PinterestApiError, PinterestClient } from "@/lib/server/pinterest/service";
import { getPinterestApiEnv, canAttemptSandboxPublish } from "@/lib/server/pinterest/config";
import { pinterestErrorResponse, unauthorized } from "@/lib/server/pinterest/routeHelpers";
import { validatePublicImageUrl, validateOptionalLink } from "@/lib/server/pinterest/validatePublish";
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

const MAX_BOARD_PAGES = 5; // fallback scan up to ~500 boards to confirm ownership

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
  if (!boardId) {
    return Response.json({ error: "boardId is required", code: "bad_request" }, { status: 400 });
  }

  const img = validatePublicImageUrl(body.imageUrl);
  if (!img.ok) {
    return Response.json({ error: img.message, code: "invalid_image_url" }, { status: 422 });
  }

  const link = validateOptionalLink(body.link);
  if (!link.ok) {
    return Response.json({ error: link.message, code: "invalid_link" }, { status: 422 });
  }

  const title = typeof body.title === "string" ? body.title.trim().slice(0, 100) : undefined;
  // PRD product cap: description ≤500 (Pinterest allows 800; the product promise is
  // 500, so the publish path must never send more).
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 500) : undefined;
  const altText = typeof body.altText === "string" ? body.altText.trim().slice(0, 500) : undefined;

  const sourcePinId = typeof body.sourcePinId === "string" ? body.sourcePinId.trim() : "";

  // Optional instrumentation fields — plumbed from client call sites, never required and
  // never block publish (missing draftId is a valid, nullable event field; an unrecognised
  // source degrades to "unknown"). See lib/server/publishEvents.ts for the contract.
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
  // Service-role client for the best-effort analytics writes. Constructing it must never
  // affect publish; recordPublishEvent swallows all failures.
  const analyticsDb = createServerClient();

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
    // Sandbox mode publishes with the SANDBOX token against the sandbox API (the real
    // OAuth connection's production token is rejected there). Gated on
    // canAttemptSandboxPublish() → production is unchanged and uses the real connection.
    const client = canAttemptSandboxPublish()
      ? await PinterestClient.forSandboxDemo(uid)
      : await PinterestClient.forUser(uid);

    // Ownership is enforced by Pinterest (same token creates the pin), so the
    // board lookup doesn't need to gate — and serialize a full Pinterest round
    // trip in front of — every publish. Run both concurrently; the lookup only
    // feeds the response's board name and the friendly error below.
    const boardPromise = findOwnedBoard(client, boardId);
    boardPromise.catch(() => {}); // consumed via .catch below — never an unhandled rejection

    let pin: Awaited<ReturnType<typeof client.createPin>>;
    try {
      pin = await client.createPin({
        boardId,
        title,
        description,
        link: link.url,
        altText,
        imageUrl: img.url,
      });
    } catch (err) {
      // A board-shaped rejection (403/404) with no owned board found is our
      // clearer board_not_owned error; anything else forwards as-is.
      if (err instanceof PinterestApiError && (err.status === 403 || err.status === 404)) {
        const board = await boardPromise.catch(() => null);
        if (!board) {
          void recordFailedPublishEvent(analyticsDb, eventBase, Date.now() - publishStartedMs, {
            code: "board_not_owned",
            message: "Board not found on the connected Pinterest account",
          });
          return Response.json(
            { error: "Board not found on the connected Pinterest account", code: "board_not_owned" },
            { status: 403 },
          );
        }
      }
      throw err;
    }

    // The lookup only feeds the response's board name and callers prefer their
    // locally-selected name anyway — never serialize a slow board fetch (getBoard
    // miss → up to 5 listBoards pages ≈ many seconds through a proxy) behind an
    // already-successful publish. Take the result if it settled (it ran while
    // createPin was in flight), otherwise respond now with the id-only fallback.
    const board = await Promise.race([
      boardPromise.catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
    ]);
    void recordPublishEvent(analyticsDb, PUBLISH_EVENT_SUCCEEDED, {
      ...eventBase,
      durationMs: Date.now() - publishStartedMs,
      remotePinId: pin.id,
      remotePinUrl: pin.url,
    });
    return Response.json(
      {
        ok: true,
        pin: { id: pin.id, url: pin.url },
        // Lookup hiccup after a successful publish: fall back to the id — the
        // drawer prefers its locally-selected board name anyway.
        board: board ?? { id: boardId, name: "" },
        environment: getPinterestApiEnv(),
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

/** Find a board by id across up to MAX_BOARD_PAGES pages of the user's boards. */
async function findOwnedBoard(
  client: PinterestClient,
  boardId: string,
): Promise<{ id: string; name: string } | null> {
  const byId = await client.getBoard(boardId);
  if (byId) return { id: byId.id, name: byId.name };

  let bookmark: string | undefined;
  for (let page = 0; page < MAX_BOARD_PAGES; page++) {
    const { items, bookmark: next } = await client.listBoards(bookmark);
    const match = items.find((b) => b.id === boardId);
    if (match) return { id: match.id, name: match.name };
    if (!next) break;
    bookmark = next;
  }
  return null;
}
