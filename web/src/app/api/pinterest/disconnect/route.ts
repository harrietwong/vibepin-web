/**
 * GET / DELETE /api/pinterest/disconnect
 *
 * DELETE disconnects the authenticated user's Pinterest account: invalidates stored
 * tokens and marks the connection disconnected. Non-sensitive metadata rows are
 * preserved (the row stays, tokens are nulled, disconnected_at set). With
 * `?mode=remove&connectionId=…` it instead DELETES that one row (see below).
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
 *
 * ── `?mode=remove`: Disconnect and Remove stop being the same call ────────────
 * Default (`mode` absent or anything else) is the SOFT disconnect this route has
 * always done: tokens invalidated, row kept, `disconnected_at` stamped. The row now
 * STAYS in Settings as a "Disconnected" account with a Reconnect — and it goes on
 * holding its plan slot (PRD 0805 §11).
 *
 * `?mode=remove` is the HARD delete: the row is gone, and that is the only action
 * that frees the slot. Before this, Remove reused the soft path and only LOOKED like
 * a delete because a disconnected Pinterest row dropped out of the listing — the slot
 * stayed spent, invisibly.
 *
 * A remove REQUIRES `connectionId` (400 without it). The un-narrowed call means
 * "every live connection of this user", which as a soft disconnect is the legacy
 * Settings button and as a hard delete would be a mass deletion no button asks for.
 * Refusing is deliberate: silently downgrading it to a soft disconnect would report
 * "removed" while the account and its slot survived.
 */

import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { deleteConnection, disconnect } from "@/lib/server/pinterest/connectionStore";
import {
  cancelScheduledForConnection,
  countScheduledForConnection,
} from "@/lib/server/pinterest/scheduledForConnection";
import { pinterestErrorResponse, unauthorized } from "@/lib/server/pinterest/routeHelpers";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * The customer-readable refusal when the schedules could not all be cancelled
 * (Codex #6).
 *
 * It names a number because "something went wrong" gives the merchant nothing to
 * check: they chose to cancel N scheduled posts, and they need to know the account
 * is STILL THERE (so they can retry) rather than half-removed.
 */
function scheduleCancelFailedMessage(failed: number, readFailed: boolean): string {
  if (readFailed) {
    return "We couldn't check what's still scheduled through this account, so it was not removed. Please try again.";
  }
  const posts = failed === 1 ? "1 scheduled post" : `${failed} scheduled posts`;
  return `We couldn't cancel ${posts}, so the account was not removed. Please try again.`;
}

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

  const url = new URL(req.url);
  const connectionId = readConnectionId(req);
  const cancelScheduled = url.searchParams.get("cancelScheduled") === "1";
  // Only the exact string "remove" is the destructive action — a stale client that
  // sends nothing (or something unrecognised) gets the reversible one.
  const remove = url.searchParams.get("mode") === "remove";

  if (remove && !connectionId) {
    return Response.json(
      { ok: false, error: "connectionId is required to remove an account" },
      { status: 400 },
    );
  }

  try {
    let cancelledScheduled = 0;
    // Cancel BEFORE disconnecting/removing: if the request dies half-way, the worse
    // outcome is schedules cleared on a still-connected account (visible, recoverable)
    // rather than a removed account leaving live rows the cron keeps picking up.
    let cancelOutcome: { cleared: number; failed: number; readFailed: boolean } | null = null;
    if (connectionId && cancelScheduled) {
      cancelOutcome = await cancelScheduledForConnection(
        createServerClient(), uid, connectionId, new Date().toISOString(),
      );
      cancelledScheduled = cancelOutcome.cleared;
    }
    if (remove && connectionId) {
      // The cancel and the delete are ONE decision (Codex #6). A read error used to
      // degrade to "nothing is scheduled" and a failed update was logged and
      // skipped, so a transient DB failure deleted the account, reported success,
      // and left Pins scheduled to a connection that no longer exists. Refuse the
      // delete instead: the account stays, visible and retryable.
      //
      // Only the DELETE is gated. The soft disconnect below keeps the row, so a
      // half-cancel there is recoverable and the publish-time target_disconnected
      // block still stops those Pins.
      if (cancelOutcome && (cancelOutcome.readFailed || cancelOutcome.failed > 0)) {
        const userMessage = scheduleCancelFailedMessage(cancelOutcome.failed, cancelOutcome.readFailed);
        console.error(
          `[pinterest/disconnect] schedule cancel incomplete (cleared=${cancelOutcome.cleared}, failed=${cancelOutcome.failed}, readFailed=${cancelOutcome.readFailed}) — account kept`,
        );
        return Response.json(
          {
            ok: false,
            code: "schedule_cancel_failed",
            cleared: cancelOutcome.cleared,
            failed: cancelOutcome.failed,
            userMessage,
            // `error` is what the client's parseErrorResponse surfaces as the message.
            error: userMessage,
          },
          { status: 409 },
        );
      }
      await deleteConnection(uid, connectionId);
      return Response.json({ ok: true, removed: true, disconnected: true, cancelledScheduled });
    }
    await disconnect(uid, connectionId);
    return Response.json({ ok: true, disconnected: true, cancelledScheduled });
  } catch (err) {
    return pinterestErrorResponse(err);
  }
}
