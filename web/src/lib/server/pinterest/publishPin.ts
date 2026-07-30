/**
 * publishPin.ts — server-side "publish one Pin" core, extracted from
 * POST /api/pinterest/pins so it can be reused by a scheduler/cron worker with no
 * Request/Response coupling.
 *
 * Contract (must stay behavior-identical to the route it was lifted from):
 *   - Validation failures (missing board / bad image or link URL / field shape) are
 *     returned as a typed `{ ok: false, kind: "validation", error, code, status }`
 *     result — NOT thrown. The route maps these straight onto Response.json(...).
 *   - `board_not_owned` (403) is likewise a typed validation-style result.
 *   - Connection / Pinterest-API errors (NotConnectedError, NeedsReconnectError,
 *     ConfigurationError, DatabaseError, PinterestApiError, …) are THROWN, exactly as
 *     before, so the caller's existing `pinterestErrorResponse(err)` mapping is the
 *     single source of truth for those HTTP statuses. This function never constructs
 *     an HTTP Response.
 *   - The in-flight duplicate-publish lock (`publish_in_progress`, 409) stays in the
 *     route: it is per-process request de-dup, not part of the publish operation, and
 *     a cron worker wants its own coordination.
 *
 * Truncation caps (title 100, description 500, altText 500) and the "publish first,
 * verify board name only for the response / friendly 403" ordering are preserved.
 */

import { PinterestApiError, PinterestClient } from "./service";
import { canAttemptSandboxPublish, getPinterestApiEnv } from "./config";
import { validateOptionalLink, validatePublicImageUrl } from "./validatePublish";

const MAX_BOARD_PAGES = 5; // fallback scan up to ~500 boards to confirm ownership

export interface PublishPinInput {
  /** Authenticated VibePin user id. */
  uid: string;
  boardId: string;
  imageUrl: unknown;
  title?: unknown;
  description?: unknown;
  link?: unknown;
  altText?: unknown;
}

/** A successful publish: the live Pinterest Pin, the board, and the environment. */
export interface PublishSuccess {
  ok: true;
  pin: { id: string; url: string };
  board: { id: string; name: string };
  environment: "sandbox" | "production";
}

/**
 * A request-shaped failure the caller renders directly (no throw). `status`/`code`
 * mirror the exact values the route used to emit for each case.
 */
export interface PublishValidationFailure {
  ok: false;
  kind: "validation";
  error: string;
  code:
    | "bad_request"
    | "invalid_image_url"
    | "invalid_link"
    | "board_not_owned";
  status: 400 | 403 | 422;
}

export type PublishResult = PublishSuccess | PublishValidationFailure;

/**
 * Publish a single already-generated Pin to a board on the user's connected account.
 * Pure of HTTP: returns a typed result for request-shaped problems, throws for
 * connection / Pinterest-API problems (caller maps those via pinterestErrorResponse).
 */
export async function publishPinForUser(input: PublishPinInput): Promise<PublishResult> {
  const boardId = typeof input.boardId === "string" ? input.boardId.trim() : "";
  if (!boardId) {
    return { ok: false, kind: "validation", error: "boardId is required", code: "bad_request", status: 400 };
  }

  const img = validatePublicImageUrl(input.imageUrl);
  if (!img.ok) {
    return { ok: false, kind: "validation", error: img.message, code: "invalid_image_url", status: 422 };
  }

  const link = validateOptionalLink(input.link);
  if (!link.ok) {
    return { ok: false, kind: "validation", error: link.message, code: "invalid_link", status: 422 };
  }

  // Title ≤100 / description ≤500 is enforced as a hard client-side block (pinFieldErrors
  // in pinReadiness.ts) before Schedule/Publish is even reachable, so a live user request
  // should never arrive here over-length. This slice() is a SERVER-SIDE FALLBACK ONLY —
  // it exists so a draft that was scheduled before this validation shipped (or edited by
  // some future path that skips the client gate) does not permanently fail every cron
  // auto-publish attempt; it silently truncates instead of blocking. PRD product cap:
  // description ≤500 (Pinterest allows 800; the product promise is 500).
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 100) : undefined;
  const description = typeof input.description === "string" ? input.description.trim().slice(0, 500) : undefined;
  const altText = typeof input.altText === "string" ? input.altText.trim().slice(0, 500) : undefined;

  // Sandbox mode publishes with the SANDBOX token against the sandbox API (the real
  // OAuth connection's production token is rejected there). Gated on
  // canAttemptSandboxPublish() → production is unchanged and uses the real connection.
  const client = canAttemptSandboxPublish()
    ? await PinterestClient.forSandboxDemo(input.uid)
    : await PinterestClient.forUser(input.uid);

  // Ownership is enforced by Pinterest (same token creates the pin), so the board
  // lookup doesn't need to gate — and serialize a full Pinterest round trip in front
  // of — every publish. Run both concurrently; the lookup only feeds the response's
  // board name and the friendly error below.
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
    // A board-shaped rejection (403/404) with no owned board found is our clearer
    // board_not_owned error; anything else forwards as-is (thrown → caller maps it).
    if (err instanceof PinterestApiError && (err.status === 403 || err.status === 404)) {
      const board = await boardPromise.catch(() => null);
      if (!board) {
        return {
          ok: false,
          kind: "validation",
          error: "Board not found on the connected Pinterest account",
          code: "board_not_owned",
          status: 403,
        };
      }
    }
    throw err;
  }

  // The lookup only feeds the response's board name and callers prefer their locally-
  // selected name anyway — never serialize a slow board fetch (getBoard miss → up to 5
  // listBoards pages ≈ many seconds through a proxy) behind an already-successful
  // publish. Take the result if it settled (it ran while createPin was in flight),
  // otherwise respond now with the id-only fallback.
  const board = await Promise.race([
    boardPromise.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
  ]);

  return {
    ok: true,
    pin: { id: pin.id, url: pin.url },
    // Lookup hiccup after a successful publish: fall back to the id — the drawer
    // prefers its locally-selected board name anyway.
    board: board ?? { id: boardId, name: "" },
    environment: getPinterestApiEnv(),
  };
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
