/**
 * POST /api/integrations/facebook/connect-page
 *
 * Body: { pageId: string } — or { pageUrl: string } from which a NUMERIC id is
 * extracted. Manually connects a Facebook Page the automatic /me/accounts
 * enumeration did not list.
 *
 * WHY THIS ROUTE EXISTS
 * Meta returns HTTP 200 `{"data":[]}` from /me/accounts for some Pages the user
 * really does administer (Business-Portfolio-owned Pages not selected in the
 * Login-for-Business asset picker), while GET /{page-id} with the SAME user token
 * resolves the Page and hands back its page-scoped token. Enumeration-empty is
 * therefore not "no Page", and this route is the fallback path: the user types the
 * numeric Page id, the SERVER verifies it against Graph, and only a Graph-verified
 * Page is persisted.
 *
 * SECURITY INVARIANTS:
 *   - Requires a logged-in same-origin session (identical to select-page).
 *   - The client NEVER submits a token. The user access token is read + decrypted
 *     server-side from the stored connection.
 *   - The response NEVER contains a token (user or page) — only { ok, pageId,
 *     pageName } on success, or { error, code } on failure.
 *   - The pageId is not trusted: Graph must confirm it resolves to a Page whose id
 *     matches exactly and that yields a page-scoped access token.
 *   - Username URLs are REJECTED, never guessed. Resolving a vanity name to an id
 *     needs an extra Graph lookup with different failure modes, and a wrong guess
 *     would silently connect the wrong Page.
 */

import { getUserIdFromSameOriginSession } from "@/lib/server/authUser";
import {
  connectFacebookPageManually,
  getFacebookUserToken,
  MULTIPLE_FACEBOOK_CONNECTIONS,
} from "@/lib/server/facebook/connectionStore";
import { FacebookApiError, fetchPageById } from "@/lib/server/facebook/service";

export const dynamic = "force-dynamic";

/** A bare Facebook Page id: digits only. */
const NUMERIC_ID = /^\d+$/;

type ExtractResult =
  | { ok: true; pageId: string }
  | { ok: false; code: "page_url_needs_numeric_id" };

/**
 * Pull a NUMERIC Page id out of a Facebook URL. Only two unambiguous shapes are
 * accepted:
 *   https://www.facebook.com/123456789...      → path segment that is all digits
 *   https://www.facebook.com/profile.php?id=123456789 (or any ?id=/&page_id=)
 *
 * Anything else — most importantly a vanity username like
 * facebook.com/vibepin.co — is REJECTED with page_url_needs_numeric_id. We never
 * query Graph with a username: guessing which node a name resolves to is exactly
 * how a user ends up connected to someone else's Page.
 */
function extractNumericPageId(rawUrl: string): ExtractResult {
  const trimmed = rawUrl.trim();
  if (!trimmed) return { ok: false, code: "page_url_needs_numeric_id" };

  // Accept input with or without a scheme.
  let parsed: URL | null = null;
  try {
    parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    parsed = null;
  }
  if (!parsed) return { ok: false, code: "page_url_needs_numeric_id" };

  // Query-string form first (?id= / &page_id=), which is always explicit.
  for (const key of ["id", "page_id"]) {
    const value = parsed.searchParams.get(key)?.trim();
    if (value && NUMERIC_ID.test(value)) return { ok: true, pageId: value };
  }

  // Otherwise a path segment that is entirely digits (…/123456789 or …/123456789/posts).
  const numericSegment = parsed.pathname
    .split("/")
    .map(s => s.trim())
    .find(s => s.length > 0 && NUMERIC_ID.test(s));
  if (numericSegment) return { ok: true, pageId: numericSegment };

  // A username-only URL is not resolvable without guessing → ask for the id.
  return { ok: false, code: "page_url_needs_numeric_id" };
}

/** Strip anything token-shaped out of a Meta message before it reaches the client. */
function safeMetaMessage(message: string): string {
  // Meta messages are descriptive text, but be defensive: drop long opaque runs
  // (access tokens are long base64-ish blobs) and any access_token=... fragment.
  return message
    .replace(/access_token=[^\s&]+/gi, "access_token=[redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]")
    .slice(0, 300);
}

/** Map a service error code to the HTTP status the client should see. */
function statusForCode(code: string): number {
  if (code === "page_not_found") return 404;
  if (code === "page_access_denied") return 403;
  if (code === "page_no_access_token") return 422;
  return 502; // graph_api_error / page_id_mismatch / page_name_missing / anything else
}

/**
 * Public, stable error codes the client branches on. The service layer's codes
 * are internal; this is the contract the UI is written against.
 */
function publicCodeFor(code: string): string {
  if (code === "page_not_found" || code === "page_id_mismatch") return "FACEBOOK_PAGE_NOT_FOUND";
  if (code === "page_access_denied" || code === "page_no_access_token") {
    return "FACEBOOK_PAGE_ACCESS_DENIED";
  }
  return "FACEBOOK_GRAPH_API_ERROR";
}

export async function POST(req: Request) {
  const uid = await getUserIdFromSameOriginSession(req);
  if (!uid) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let rawPageId = "";
  let rawPageUrl = "";
  // WHICH connected Facebook account this Page is being added to. Always an
  // ADDITIONAL filter on top of the row's owner (the store keeps
  // `.eq("user_id", uid)`), so a forged id can never reach another user's row.
  let connectionId: string | undefined;
  try {
    const body = (await req.json()) as {
      pageId?: unknown;
      pageUrl?: unknown;
      connectionId?: unknown;
    };
    rawPageId = typeof body.pageId === "string" ? body.pageId.trim() : "";
    rawPageUrl = typeof body.pageUrl === "string" ? body.pageUrl.trim() : "";
    // "" → undefined: `.eq("id", "")` matches zero rows, which would look like
    // "no Facebook connection" instead of failing loudly.
    const rawConnectionId = typeof body.connectionId === "string" ? body.connectionId.trim() : "";
    connectionId = rawConnectionId || undefined;
  } catch {
    // Malformed body → both stay empty and fall through to the 400 below.
  }

  // Resolve the id: an explicit pageId wins; otherwise try the URL.
  let pageId = rawPageId;
  if (!pageId && rawPageUrl) {
    const extracted = extractNumericPageId(rawPageUrl);
    if (!extracted.ok) {
      return Response.json(
        {
          error:
            "That Facebook URL does not contain a numeric Page ID. Open your Page's About section and enter the Page ID instead.",
          code: "page_url_needs_numeric_id",
        },
        { status: 400 },
      );
    }
    pageId = extracted.pageId;
  }

  // Local-testing convenience ONLY: with neither field supplied, fall back to
  // FACEBOOK_TEST_PAGE_ID. Gated on NODE_ENV === "development" so a production
  // build can never resolve a Page from the environment instead of the user.
  if (!pageId && process.env.NODE_ENV === "development") {
    const testPageId = process.env.FACEBOOK_TEST_PAGE_ID?.trim() ?? "";
    if (NUMERIC_ID.test(testPageId)) pageId = testPageId;
  }

  if (!pageId) {
    return Response.json({ error: "pageId is required", code: "bad_request" }, { status: 400 });
  }
  if (!NUMERIC_ID.test(pageId)) {
    return Response.json(
      { error: "Page ID must be numeric", code: "invalid_page_id" },
      { status: 400 },
    );
  }

  // ── Resolve the user token (server-side only) ────────────────────────────────
  let userToken: string | null;
  try {
    userToken = await getFacebookUserToken(uid, connectionId);
  } catch (err) {
    const message = (err as Error).message;
    if (message === MULTIPLE_FACEBOOK_CONNECTIONS) {
      // Distinct from "no connection": telling a customer who has TWO Facebook
      // accounts to "connect Facebook first" would be plainly wrong.
      return Response.json(
        {
          error: "Several Facebook accounts are connected — reopen Settings and add the Page from the account you mean",
          code: "multiple_facebook_connections",
        },
        { status: 409 },
      );
    }
    console.error("[facebook/connect-page] token read failed:", message);
    return Response.json(
      { error: "Facebook connection is unavailable", code: "storage_unavailable" },
      { status: 500 },
    );
  }
  if (!userToken) {
    return Response.json(
      { error: "Connect Facebook first, then add your Page", code: "no_facebook_connection" },
      { status: 409 },
    );
  }

  // ── Verify the Page against Graph, then persist ──────────────────────────────
  try {
    const page = await fetchPageById(userToken, pageId);
    const result = await connectFacebookPageManually(uid, page, connectionId);
    // Response carries ONLY display-safe fields — never a token.
    return Response.json({ ok: true, pageId: result.pageId, pageName: result.pageName });
  } catch (err) {
    if (err instanceof FacebookApiError) {
      // Log the classification only (the message may echo Meta text; no token/URL).
      console.error(`[facebook/connect-page] graph failure code=${err.code} status=${err.status}`);
      return Response.json(
        { error: safeMetaMessage(err.message), code: publicCodeFor(err.code) },
        { status: statusForCode(err.code) },
      );
    }
    const message = (err as Error).message;
    if (message === MULTIPLE_FACEBOOK_CONNECTIONS) {
      return Response.json(
        {
          error: "Several Facebook accounts are connected — reopen Settings and add the Page from the account you mean",
          code: "multiple_facebook_connections",
        },
        { status: 409 },
      );
    }
    if (message === "NO_FACEBOOK_CONNECTION") {
      return Response.json(
        { error: "Connect Facebook first, then add your Page", code: "no_facebook_connection" },
        { status: 409 },
      );
    }
    console.error("[facebook/connect-page POST]", message);
    return Response.json(
      { error: "Could not connect that Facebook Page", code: "server_error" },
      { status: 500 },
    );
  }
}
