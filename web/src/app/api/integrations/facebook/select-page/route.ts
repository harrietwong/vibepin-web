/**
 * POST /api/integrations/facebook/select-page
 *
 * Body: { pageId: string }
 *
 * Promotes one of the previously-stored candidate Pages to the active publishing
 * target for the authenticated user's Facebook connection. Requires a logged-in
 * session (same-origin cookie, matching /api/social/connections).
 *
 * ANTI-FORGERY: selectFacebookPage only accepts a pageId that already exists in
 * the server-stored candidatePages (discovered from Graph during the OAuth
 * callback). A client cannot inject an arbitrary Page — an unknown pageId returns
 * 400. Tokens are never returned.
 */

import { getUserIdFromSameOriginSession } from "@/lib/server/authUser";
import { selectFacebookPage } from "@/lib/server/facebook/connectionStore";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const uid = await getUserIdFromSameOriginSession(req);
  if (!uid) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let pageId: string;
  try {
    const body = (await req.json()) as { pageId?: unknown };
    pageId = typeof body.pageId === "string" ? body.pageId.trim() : "";
  } catch {
    pageId = "";
  }
  if (!pageId) {
    return Response.json({ error: "pageId is required", code: "bad_request" }, { status: 400 });
  }

  try {
    const result = await selectFacebookPage(uid, pageId);
    return Response.json({ ok: true, pageId: result.pageId, pageName: result.pageName });
  } catch (err) {
    const message = (err as Error).message;
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
