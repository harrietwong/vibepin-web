/**
 * POST /api/integrations/facebook/select-page
 *
 * Body: { pageId: string, connectionId?: string }
 *
 * Promotes one of the previously-stored candidate Pages to the active publishing
 * target for the authenticated user's Facebook connection. Requires a logged-in
 * session (same-origin cookie, matching /api/social/connections).
 *
 * ANTI-FORGERY: selectFacebookPage only accepts a pageId that already exists in
 * the server-stored candidatePages (discovered from Graph during the OAuth
 * callback). A client cannot inject an arbitrary Page — an unknown pageId returns
 * 400. Tokens are never returned.
 *
 * MULTI-ACCOUNT: `connectionId` names WHICH connected Facebook account is being
 * pointed at this Page. It is an additional filter on top of the row's owner —
 * the store always keeps `.eq("user_id", uid)`, so a forged id cannot reach
 * another user's connection. With several accounts connected and no id, the
 * store refuses (409) rather than re-pointing an arbitrary one.
 */

import { getUserIdFromSameOriginSession } from "@/lib/server/authUser";
import {
  selectFacebookPage,
  MULTIPLE_FACEBOOK_CONNECTIONS,
} from "@/lib/server/facebook/connectionStore";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const uid = await getUserIdFromSameOriginSession(req);
  if (!uid) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let pageId: string;
  let connectionId: string | undefined;
  try {
    const body = (await req.json()) as { pageId?: unknown; connectionId?: unknown };
    pageId = typeof body.pageId === "string" ? body.pageId.trim() : "";
    // Empty string must become undefined: `.eq("id", "")` matches zero rows, so a
    // blank value would silently select nothing instead of failing loudly.
    const rawConnectionId = typeof body.connectionId === "string" ? body.connectionId.trim() : "";
    connectionId = rawConnectionId || undefined;
  } catch {
    pageId = "";
  }
  if (!pageId) {
    return Response.json({ error: "pageId is required", code: "bad_request" }, { status: 400 });
  }

  try {
    const result = await selectFacebookPage(uid, pageId, connectionId);
    return Response.json({ ok: true, pageId: result.pageId, pageName: result.pageName });
  } catch (err) {
    const message = (err as Error).message;
    if (message === MULTIPLE_FACEBOOK_CONNECTIONS) {
      return Response.json(
        {
          error: "Several Facebook accounts are connected — reopen Settings and pick a Page from the account you mean",
          code: "multiple_facebook_connections",
        },
        { status: 409 },
      );
    }
    if (message === "PAGE_NOT_A_CANDIDATE") {
      return Response.json(
        { error: "That Page is not among your connected candidates", code: "invalid_page" },
        { status: 400 },
      );
    }
    console.error("[facebook/select-page POST]", message);
    return Response.json({ error: "Could not select the Facebook Page" }, { status: 500 });
  }
}
