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
import { disconnect, forgetConnection } from "@/lib/server/pinterest/connectionStore";
import {
  removeConnectionIfUnscheduled,
  removeUnavailableMessage,
} from "@/lib/server/social/removeConnectionIfUnscheduled";
import {
  cancelScheduledForConnection,
  countScheduledForConnection,
  countScheduledForConnectionStrict,
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

/**
 * The refusal when we could not even LOOK at what is scheduled (Codex #1).
 *
 * Distinct from the cancel failure above: the user has not asked to cancel
 * anything, we simply cannot answer the question that decides whether removing is
 * safe. Retrying is the whole advice.
 */
function scheduleCheckFailedMessage(): string {
  return "We couldn't check what's still scheduled through this account, so it was not removed. Please try again.";
}

/**
 * The refusal when Pins are still scheduled through the account and the user has
 * not said what to do with them (Codex #1).
 *
 * It names the number because the next screen is a choice - keep them (Phase C's
 * target_disconnected block stops them at publish time) or cancel them - and that
 * choice is not answerable without knowing how much work is at stake.
 */
function schedulesExistMessage(count: number): string {
  const pins = count === 1 ? "1 scheduled Pin" : `${count} scheduled Pins`;
  return `This account still has ${pins}. Choose whether to keep or cancel them before removing it.`;
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
    // A remove ALWAYS inspects the schedules itself, before anything is touched
    // (Codex #1). The panel used to be the authority: it pre-counted, and a count of
    // 0 meant it sent no `cancelScheduled` at all and this route inspected nothing.
    // A transient count failure answered 0 - so did a count taken before the user
    // scheduled a Pin in another tab - and the account was deleted while live
    // schedules still named it. The panel's count now only opens the dialog early.
    //
    // Only the `cancelScheduled` branch is exempt, because cancelling does its own
    // read and reports `readFailed`; a pre-count there would be a second chance to
    // fail at the same question. Its outcome gate below is that branch's check.
    if (remove && connectionId && !cancelScheduled) {
      const { count, readFailed } = await countScheduledForConnectionStrict(
        createServerClient(), uid, connectionId,
      );
      if (readFailed) {
        const userMessage = scheduleCheckFailedMessage();
        console.error("[pinterest/disconnect] schedule check failed - account kept");
        return Response.json(
          { ok: false, code: "schedule_check_failed", userMessage, error: userMessage },
          { status: 503 },
        );
      }
      if (count > 0) {
        const userMessage = schedulesExistMessage(count);
        return Response.json(
          {
            ok: false,
            code: "schedules_exist",
            scheduledCount: count,
            userMessage,
            error: userMessage,
          },
          { status: 409 },
        );
      }
    }

    let cancelledScheduled = 0;
    // Cancel BEFORE disconnecting/removing: if the request dies half-way, the worse
    // outcome is schedules cleared on a still-connected account (visible, recoverable)
    // rather than a removed account leaving live rows the cron keeps picking up.
    //
    // This is also why the credentials are only invalidated AFTER a successful
    // cancel (Codex #2): a refused remove must leave the account able to publish the
    // schedules it kept. `disconnect()` / the remove RPC below are the first writes
    // to the row, and both are past every refusal.
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
      // THE DELETE IS THE GUARD (Codex P0 #1). The strict pre-count above is UX; it
      // is a separate round trip, so a Pin scheduled in another tab between the two
      // used to survive the delete and go on naming a connection that no longer
      // exists. This RPC counts and deletes in ONE statement and is the authority.
      // ACCEPTED RESIDUAL (owner decision, 2026-08-29). The RPC guarantees that its
      // count and its delete see one snapshot; it does NOT serialise concurrent
      // schedule writes (the schedule path is validate-then-upsert in a separate
      // transaction). A schedule committed in the millisecond after this statement's
      // snapshot therefore survives, naming a connection that is gone. Bounded and
      // accepted: it fails at due time with `target_disconnected` — a visible
      // failure on the schedule, never a duplicate post.
      const removal = await removeConnectionIfUnscheduled(createServerClient(), uid, connectionId);
      if (removal.outcome === "unavailable") {
        // Fail CLOSED — never fall back to the plain delete, which IS the race.
        const userMessage = removeUnavailableMessage();
        console.error(`[pinterest/disconnect] remove guard unavailable (${removal.reason}) — account kept`);
        return Response.json(
          { ok: false, code: "remove_unavailable", userMessage, error: userMessage },
          { status: 503 },
        );
      }
      if (removal.outcome === "blocked") {
        // A schedule landed after the pre-count (or after the cancel). Same answer
        // as the pre-count's refusal, on the server's number; nothing was deleted.
        const userMessage = schedulesExistMessage(removal.scheduledCount);
        return Response.json(
          {
            ok: false,
            code: "schedules_exist",
            scheduledCount: removal.scheduledCount,
            userMessage,
            error: userMessage,
          },
          { status: 409 },
        );
      }
      // The row is gone (or was already gone — this endpoint is idempotent). The
      // delete happened in SQL, so this module's row cache has to be told by hand,
      // or a read inside the 120s TTL keeps serving a removed account.
      forgetConnection(uid, connectionId);
      return Response.json({ ok: true, removed: true, disconnected: true, cancelledScheduled });
    }
    await disconnect(uid, connectionId);
    return Response.json({ ok: true, disconnected: true, cancelledScheduled });
  } catch (err) {
    return pinterestErrorResponse(err);
  }
}
