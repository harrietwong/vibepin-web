/**
 * Shared "is this a real user Pinterest connection" check.
 *
 * Only `connectionSource === "db"` is a real, user-initiated connection. Sandbox
 * tokens ("sandbox_demo") and the no-connection case ("none") unblock specific
 * flows (e.g. the sandbox publish path) but must never be treated as a real
 * connection by UI that reports connection status to the user. Deliberately
 * strict — no `?? "db"` default — so a status object that omits
 * `connectionSource` (e.g. a same-process fallback used only when the status
 * request itself failed) is never mistaken for a real DB-backed connection.
 */

import type { PinterestStatus } from "@/lib/pinterestClient";

export function isRealPinterestConnection(status: PinterestStatus): boolean {
  return status.connected && !status.needsReconnect && status.connectionSource === "db";
}

/**
 * PUBLISH-path capability check — distinct from `isRealPinterestConnection`.
 *
 * The publish flow (board loading, the Publish button's connect gating) works with
 * either a real merchant connection ("db") or the server's sandbox demo capability
 * ("sandbox_demo" — see /api/pinterest/status). Sandbox is a publish capability,
 * never a merchant connection: surfaces that REPORT connection status to the user
 * (Settings, Publishing accounts) must keep using `isRealPinterestConnection`.
 */
export function canPublishWithPinterest(status: PinterestStatus): boolean {
  return (
    status.connected &&
    !status.needsReconnect &&
    (status.connectionSource === "db" || status.connectionSource === "sandbox_demo")
  );
}
