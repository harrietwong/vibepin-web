/**
 * GET /api/pinterest/boards[?bookmark=<cursor>]
 *
 * Loads the authenticated user's real Pinterest boards via the centralized
 * service. Returns only UI-facing fields. Supports cursor pagination.
 *   { items: [{ id, name, description, privacy }], bookmark: string | null }
 */

import { getUserIdFromSameOriginSession } from "@/lib/server/authUser";
import { PinterestClient } from "@/lib/server/pinterest/service";
import { canAttemptSandboxPublish } from "@/lib/server/pinterest/config";
import { pinterestErrorResponse, unauthorized } from "@/lib/server/pinterest/routeHelpers";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const uid = await getUserIdFromSameOriginSession(req);
  if (!uid) return unauthorized();

  try {
    const bookmark = new URL(req.url).searchParams.get("bookmark") ?? undefined;
    // In sandbox mode (PINTEREST_API_ENV=sandbox + a sandbox token) we MUST call the
    // sandbox API with the SANDBOX token — the real OAuth connection holds a production
    // token, and a production token against api-sandbox.pinterest.com is rejected 401.
    // Gated on canAttemptSandboxPublish(), so production (env=production) is unchanged
    // and still uses the real user connection.
    const client = canAttemptSandboxPublish()
      ? await PinterestClient.forSandboxDemo(uid)
      : await PinterestClient.forUser(uid);
    const { items, bookmark: next } = await client.listBoards(bookmark);
    return Response.json({ items, bookmark: next });
  } catch (err) {
    return pinterestErrorResponse(err);
  }
}
