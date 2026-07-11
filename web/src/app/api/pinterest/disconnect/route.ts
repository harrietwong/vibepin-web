/**
 * DELETE /api/pinterest/disconnect
 *
 * Disconnects the authenticated user's Pinterest account: invalidates stored
 * tokens and marks the connection disconnected. Non-sensitive metadata rows are
 * preserved (the row stays, tokens are nulled, disconnected_at set).
 *
 * Idempotent: safe to call repeatedly. `disconnect()` is a 0-or-more-row UPDATE, so
 * calling it when there is no connection (or an already-disconnected one) is a
 * no-op that still returns 200 { ok: true, disconnected: true } — never an error
 * just because the connection is already gone. This keeps the UI's optimistic
 * disconnect single-click and retry-safe.
 */

import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { disconnect } from "@/lib/server/pinterest/connectionStore";
import { pinterestErrorResponse, unauthorized } from "@/lib/server/pinterest/routeHelpers";

export const dynamic = "force-dynamic";

export async function DELETE(req: Request) {
  const uid = await getUserIdFromBearerOrCookies(req);
  if (!uid) return unauthorized();

  try {
    await disconnect(uid);
    return Response.json({ ok: true, disconnected: true });
  } catch (err) {
    return pinterestErrorResponse(err);
  }
}
