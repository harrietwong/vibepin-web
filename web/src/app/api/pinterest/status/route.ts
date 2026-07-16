/**
 * GET /api/pinterest/status
 *
 * Returns safe connection metadata for the authenticated user. Never returns tokens.
 *   { connected, account, scopes, needsReconnect, connectionSource, apiEnv, environment? }
 *
 * `connectionSource` disambiguates a real user connection from provider config:
 *   - "db"           → the user has an active Pinterest connection record.
 *   - "sandbox_demo" → no user connection, but the server has a sandbox token so the
 *                      PUBLISH flow is unblocked. This is provider config, NOT a user
 *                      connection: the normal Settings UI must show "Not connected".
 *   - "none"         → no connection and no sandbox fallback.
 *
 * A real DB connection ALWAYS takes priority over the sandbox fallback, so a sandbox
 * token can never fake "connected" in Settings after the user explicitly disconnects
 * (the disconnect nulls the row → getActiveConnection returns null → source drops to
 * sandbox_demo/none, which Settings renders as not-connected).
 */

import { getUserIdFromSameOriginSession } from "@/lib/server/authUser";
import { getActiveConnection, toSafeStatus } from "@/lib/server/pinterest/connectionStore";
import {
  canAttemptSandboxPublish,
  getPinterestApiEnv,
  isPinterestSandboxEnv,
  pinterestRequestScopes,
} from "@/lib/server/pinterest/config";
import { pinterestErrorResponse, unauthorized } from "@/lib/server/pinterest/routeHelpers";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const uid = await getUserIdFromSameOriginSession(req);
  if (!uid) return unauthorized();

  const apiEnv = getPinterestApiEnv();
  // `environment` (used by the publish drawer to enable the sandbox demo-board
  // affordance) reflects the server env, independent of connection source.
  const environment = isPinterestSandboxEnv() ? "sandbox" : "production";

  try {
    // 1. A real user connection (DB record) is the only thing the normal Settings UI
    //    treats as connected — and it always wins over the sandbox fallback.
    const row = await getActiveConnection(uid);
    const dbStatus = toSafeStatus(row);
    if (dbStatus.connected) {
      return Response.json({ ...dbStatus, connectionSource: "db", apiEnv, environment });
    }

    // 2. No user connection. In sandbox demo mode we still report connected so the
    //    PUBLISH flow (which gates board-loading on `connected`) is not blocked — but
    //    tag it sandbox_demo so Settings shows "Not connected". Never exposes the token.
    if (canAttemptSandboxPublish()) {
      return Response.json({
        connected: true,
        account: { id: "sandbox", username: "sandbox", accountType: "SANDBOX" },
        scopes: [...pinterestRequestScopes()],
        needsReconnect: false,
        lastSyncedAt: null,
        connectionSource: "sandbox_demo",
        apiEnv,
        environment,
      });
    }

    // 3. Nothing connected.
    return Response.json({ ...dbStatus, connectionSource: "none", apiEnv, environment });
  } catch (err) {
    return pinterestErrorResponse(err);
  }
}
