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
 *     plan:        "free" | "starter" | "pro" | "business"
 *   }
 *
 * `plan` is here so the Settings panel can offer the right action when a connect is
 * refused: a paid user can buy an extra account slot, a Free user can only upgrade.
 * It is resolved with the SAME resolver the connect gate uses (never user_metadata,
 * never a client value), so the offer and the enforcement cannot disagree. It
 * degrades to "free" if resolution fails — the Upgrade CTA is always safe to show.
 */

import { getUserIdFromSameOriginSession } from "@/lib/server/authUser";
import { listConnections, summarizeConnectionList } from "@/lib/social/server/socialConnectionStore";
import { resolvePlan } from "@/lib/server/entitlements";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // Read-only, non-secret metadata — same-origin cookie session (no network verify
  // round trip), matching /api/pinterest/status and /api/pinterest/boards.
  const uid = await getUserIdFromSameOriginSession(req);
  if (!uid) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [connections, plan] = await Promise.all([
      listConnections(uid),
      resolvePlan(uid).catch(() => "free" as const),
    ]);
    const platforms = summarizeConnectionList(connections);
    return Response.json({ platforms, connections, plan });
  } catch (err) {
    console.error("[social/connections GET]", (err as Error).message);
    return Response.json({ error: "Could not load social connections" }, { status: 500 });
  }
}
