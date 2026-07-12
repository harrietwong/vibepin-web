/**
 * GET /api/social/connections
 *
 * Returns the authenticated merchant's connected social accounts, plus a
 * per-platform summary for all four supported platforms (Pinterest, Instagram,
 * Facebook Page, TikTok). Token ciphertext is never included.
 *
 * Response:
 *   {
 *     platforms:   PlatformConnectionSummary[]  // one per platform, in catalog order
 *     connections: SocialConnection[]           // flat list of connected accounts
 *   }
 */

import { getUserIdFromSameOriginSession } from "@/lib/server/authUser";
import { listConnections, summarizeConnectionList } from "@/lib/social/server/socialConnectionStore";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // Read-only, non-secret metadata — same-origin cookie session (no network verify
  // round trip), matching /api/pinterest/status and /api/pinterest/boards.
  const uid = await getUserIdFromSameOriginSession(req);
  if (!uid) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const connections = await listConnections(uid);
    const platforms = summarizeConnectionList(connections);
    return Response.json({ platforms, connections });
  } catch (err) {
    console.error("[social/connections GET]", (err as Error).message);
    return Response.json({ error: "Could not load social connections" }, { status: 500 });
  }
}
