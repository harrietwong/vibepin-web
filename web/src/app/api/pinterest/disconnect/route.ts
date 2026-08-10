/**
 * GET / DELETE /api/pinterest/disconnect
 *
 * DELETE disconnects the authenticated user's Pinterest account: invalidates stored
 * tokens and marks the connection disconnected. Non-sensitive metadata rows are
 * preserved (the row stays, tokens are nulled, disconnected_at set).
 *
 * Idempotent: safe to call repeatedly. `disconnect()` is a 0-or-more-row UPDATE, so
 * calling it when there is no connection (or an already-disconnected one) is a
 * no-op that still returns 200 { ok: true, disconnected: true } — never an error
 * just because the connection is already gone. This keeps the UI's optimistic
 * disconnect single-click and retry-safe.
 *
 * ── Phase D ③: per-account Remove ────────────────────────────────────────────
 * `?connectionId=…` narrows the DELETE to ONE connection. Without it the behaviour
 * is exactly what it always was — every live connection for this user — because the
 * Settings "Disconnect" button on a single-account platform still means "disconnect
 * Pinterest", and changing that would be a silent behaviour change for every
 * existing user. With multiple accounts, the un-narrowed call was a real bug:
 * pressing Remove on one account tore down all of them.
 *
 * It rides in the QUERY STRING, not a DELETE body, on purpose: DELETE bodies are
 * dropped by enough proxies and fetch implementations that they cannot be relied on.
 *
 * A foreign connectionId cannot do damage: `disconnect()` keeps its own
 * `.eq("user_id", uid)`, so a stranger's id simply matches zero rows and the call
 * stays a 200 no-op.
 *
 * GET `?connectionId=…` answers the question the Remove dialog needs first: how many
 * Pins are still scheduled to publish through this account. 0 ⇒ the UI removes
 * without asking. `?cancelScheduled=1` on the DELETE is the "Cancel those schedules"
 * branch of that dialog; the "Keep" branch passes nothing, because Phase C's
 * `target_disconnected` retry block is already what stops those Pins at publish time.
 */

import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { disconnect } from "@/lib/server/pinterest/connectionStore";
import {
  cancelScheduledForConnection,
  countScheduledForConnection,
} from "@/lib/server/pinterest/scheduledForConnection";
import { pinterestErrorResponse, unauthorized } from "@/lib/server/pinterest/routeHelpers";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/** The optional single-connection target. Empty/absent ⇒ user-wide disconnect. */
function readConnectionId(req: Request): string | undefined {
  const raw = new URL(req.url).searchParams.get("connectionId");
  const id = typeof raw === "string" ? raw.trim() : "";
  return id || undefined;
}

export async function GET(req: Request) {
  const uid = await getUserIdFromBearerOrCookies(req);
  if (!uid) return unauthorized();

  const connectionId = readConnectionId(req);
  // No target ⇒ nothing account-specific to warn about; the user-wide Disconnect
  // has never shown a schedule prompt and this endpoint doesn't invent one.
  if (!connectionId) return Response.json({ ok: true, scheduledCount: 0 });

  try {
    const scheduledCount = await countScheduledForConnection(createServerClient(), uid, connectionId);
    return Response.json({ ok: true, scheduledCount });
  } catch (err) {
    return pinterestErrorResponse(err);
  }
}

export async function DELETE(req: Request) {
  const uid = await getUserIdFromBearerOrCookies(req);
  if (!uid) return unauthorized();

  const connectionId = readConnectionId(req);
  const cancelScheduled = new URL(req.url).searchParams.get("cancelScheduled") === "1";

  try {
    let cancelledScheduled = 0;
    // Cancel BEFORE disconnecting: if the request dies half-way, the worse outcome is
    // schedules cleared on a still-connected account (visible, recoverable) rather than
    // a removed account leaving live rows the cron keeps picking up.
    if (connectionId && cancelScheduled) {
      cancelledScheduled = await cancelScheduledForConnection(
        createServerClient(), uid, connectionId, new Date().toISOString(),
      );
    }
    await disconnect(uid, connectionId);
    return Response.json({ ok: true, disconnected: true, cancelledScheduled });
  } catch (err) {
    return pinterestErrorResponse(err);
  }
}
