/**
 * GET /api/pinterest/boards[?bookmark=<cursor>]
 *
 * Loads the authenticated user's real Pinterest boards via the centralized
 * service. Returns only UI-facing fields. Supports cursor pagination.
 *   { items: [{ id, name, description, privacy }], bookmark: string | null }
 */

import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { PinterestClient } from "@/lib/server/pinterest/service";
import { canAttemptSandboxPublish, isSandboxDemoBoard } from "@/lib/server/pinterest/config";
import { pinterestErrorResponse, unauthorized } from "@/lib/server/pinterest/routeHelpers";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const uid = await getUserIdFromBearerOrCookies(req).catch(() => null);
  if (!uid) return unauthorized();

  try {
    const params = new URL(req.url).searchParams;
    const bookmark = params.get("bookmark") ?? undefined;
    // Which connected account's boards to list. Board ids are per-account, so a Pin
    // targeting one account must only ever be offered THAT account's boards. Omitted ⇒
    // the user's default connection (unchanged for every single-account user).
    // forConnection refuses ids that aren't this uid's.
    const connectionId = (params.get("connectionId") ?? "").trim();
    // In sandbox mode (PINTEREST_API_ENV=sandbox + a sandbox token) we MUST call the
    // sandbox API with the SANDBOX token — the real OAuth connection holds a production
    // token, and a production token against api-sandbox.pinterest.com is rejected 401.
    // Gated on canAttemptSandboxPublish(), so production (env=production) is unchanged
    // and still uses the real user connection.
    const client = canAttemptSandboxPublish()
      ? await PinterestClient.forSandboxDemo(uid)
      : connectionId
        ? await PinterestClient.forConnection(uid, connectionId)
        : await PinterestClient.forUser(uid);
    const { items, bookmark: next } = await client.listBoards(bookmark);
    // The sandbox demo board is unpublishable from production: Pinterest rejects
    // the Pin with "Cannot add non-sandbox pins on sandbox boards" (code 15).
    // Offering it in the production board picker is offering a choice that can
    // only fail — and it failed silently as a generic "Failed to publish", which
    // sent the merchant chasing tokens, scopes and 2FA instead of the board.
    // It stays listed in sandbox mode, where it is the whole point.
    const visible = canAttemptSandboxPublish() ? items : items.filter(b => !isSandboxDemoBoard(b));
    return Response.json({ items: visible, bookmark: next });
  } catch (err) {
    return pinterestErrorResponse(err);
  }
}
