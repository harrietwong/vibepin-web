/**
 * GET / POST /api/social/disconnect
 *
 * Per-ACCOUNT lifecycle for the non-Pinterest platforms. Pinterest has its own
 * dedicated route (/api/pinterest/disconnect); this one points the caller there so
 * the tested flow is preserved.
 *
 * POST body: { connectionId, mode?: "disconnect" | "remove", cancelScheduled?: boolean }
 *
 *   mode "disconnect" (default) — SOFT. Revoke at the provider and null the stored
 *     credentials; the account row survives with connection_status not_connected,
 *     so Settings keeps showing it as a "Disconnected" row the merchant can
 *     reconnect. This is what the per-row Disconnect button does.
 *
 *   mode "remove" — HARD. Same revoke, then the row is deleted. This is the only
 *     action that frees a plan slot, and the only one that can strand scheduled
 *     content, so it is the only one that takes `cancelScheduled`.
 *
 * Why "disconnect" is the default: the sole caller is the Settings panel, which
 * always names the mode. A client loaded before this shipped sends neither, and the
 * old behaviour for Instagram was a DELETE — so defaulting to soft means a stale tab
 * does the LESS destructive thing, never the more.
 *
 * GET `?connectionId=…` answers what the Remove dialog needs first: how many
 * scheduled Contents still publish through this account. 0 ⇒ the UI removes without
 * asking. Mirrors the Pinterest route's GET contract, including that a Pinterest id
 * is answered with `usePinterestFlow` rather than a number this route cannot compute
 * correctly (Pinterest's legacy `targetConnectionId` 口径 lives in its own module).
 */

import { getUserIdFromBearer } from "@/lib/server/authUser";
import {
  deleteConnection,
  findConnection,
} from "@/lib/social/server/socialConnectionStore";
import {
  cancelScheduledForSocialConnection,
  countScheduledForSocialConnection,
  countScheduledForSocialConnectionStrict,
} from "@/lib/server/social/scheduledForSocialConnection";
import { getSocialProviderById } from "@/lib/social/providers";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export type SocialDisconnectMode = "disconnect" | "remove";

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
 * Separate from the cancel failure above because the merchant's situation is
 * different: they have not asked to cancel anything, we simply cannot answer the
 * question that decides whether removing is safe. Retrying is the whole advice.
 */
function scheduleCheckFailedMessage(): string {
  return "We couldn't check what's still scheduled through this account, so it was not removed. Please try again.";
}

/**
 * The refusal when live schedules still target the account and the merchant has
 * not said what to do with them (Codex #1).
 *
 * It names the number because the next screen is a choice — keep them (they stop
 * at publish time) or cancel them — and that choice is not answerable without
 * knowing how much work is at stake.
 */
function schedulesExistMessage(count: number): string {
  const posts = count === 1 ? "1 scheduled post" : `${count} scheduled posts`;
  return `This account still has ${posts}. Choose whether to keep or cancel them before removing it.`;
}

/** Anything other than an explicit "remove" is the soft, reversible action. */
function readMode(value: unknown): SocialDisconnectMode {
  return value === "remove" ? "remove" : "disconnect";
}

export async function GET(req: Request) {
  const uid = await getUserIdFromBearer(req);
  if (!uid) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = new URL(req.url).searchParams.get("connectionId");
  const connectionId = typeof raw === "string" ? raw.trim() : "";
  // No target ⇒ nothing account-specific to warn about.
  if (!connectionId) return Response.json({ ok: true, scheduledCount: 0 });

  const connection = await findConnection(uid, connectionId);
  if (!connection) {
    return Response.json({ error: "Connection not found" }, { status: 404 });
  }
  if (connection.provider === "pinterest") {
    return Response.json({ ok: false, usePinterestFlow: true, scheduledCount: 0 });
  }

  const scheduledCount = await countScheduledForSocialConnection(
    createServerClient(), uid, connectionId,
  );
  return Response.json({ ok: true, scheduledCount });
}

export async function POST(req: Request) {
  const uid = await getUserIdFromBearer(req);
  if (!uid) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const connectionId = typeof body.connectionId === "string" ? body.connectionId.trim() : "";
  if (!connectionId) {
    return Response.json({ error: "connectionId is required" }, { status: 400 });
  }
  const mode = readMode(body.mode);
  const cancelScheduled = body.cancelScheduled === true;

  const connection = await findConnection(uid, connectionId);
  if (!connection) {
    return Response.json({ error: "Connection not found" }, { status: 404 });
  }

  // Pinterest: defer to its dedicated disconnect flow (DELETE /api/pinterest/disconnect).
  if (connection.provider === "pinterest") {
    return Response.json({ ok: false, usePinterestFlow: true });
  }

  /**
   * Invalidate the stored credentials at the provider.
   *
   * Named so the two modes can place it at different points in their sequence —
   * immediately for a soft disconnect, LAST for a remove (Codex #2) — without the
   * call itself being duplicated and drifting.
   */
  const revokeAtProvider = () => getSocialProviderById(connection.authProvider).disconnect({
    userId: uid,
    connectionId,
    externalConnectionId: connection.externalConnectionId,
    provider: connection.provider,
  });

  try {
    // -- SOFT disconnect ------------------------------------------------------
    // The row stays. Tokens are gone; the account is now a "Disconnected" row in
    // Settings that a reconnect can repair. For Facebook this also preserves
    // metadata.facebook.lastKnownPageId - the Page the merchant already identified -
    // so a later reconnect does not have to ask for the Page id by hand again.
    //
    // A soft disconnect never touches schedules, so it revokes immediately: there is
    // nothing to check and nothing to undo. The surviving row is what makes it
    // reversible.
    if (mode === "disconnect") {
      await revokeAtProvider();
      return Response.json({ ok: true, mode });
    }

    // -- HARD remove: check -> cancel -> revoke -> delete ---------------------
    // The order is the fix for two separate defects, and neither step may move.
    //
    // CHECK, ALWAYS (Codex #1). The client used to be the authority: it pre-counted,
    // and when that count came back 0 it sent `cancelScheduled:false` and this route
    // inspected nothing at all. A transient count failure answered 0 - and so did a
    // count taken before the merchant scheduled something in another tab. Either way
    // the account was hard-deleted while live schedules still pointed at it. The
    // client count is now a convenience that opens the dialog early; THIS decides.
    //
    // REVOKE LAST (Codex #2). Revoking first meant a cancellation failure returned
    // "account kept" after the credentials were already cleared - the kept account
    // could no longer publish, so its surviving schedules failed until the merchant
    // reconnected. A refusal has to leave the row genuinely untouched.
    //
    // Cancel still runs BEFORE the delete: if the request dies half-way, the worse
    // outcome is a present account whose schedules were not yet cleared (visible,
    // retryable) rather than a deleted account leaving live rows the cron picks up.
    let cancelledScheduled = 0;
    if (cancelScheduled) {
      // No separate count in this branch on purpose: the cancel does its own read
      // and reports `readFailed`, so a pre-count would just be a second chance to
      // fail at the same question. The outcome gate below IS the check here.
      const outcome = await cancelScheduledForSocialConnection(
        createServerClient(), uid, connectionId, new Date().toISOString(),
      );
      // The cancel has to actually SUCCEED. It used to degrade a read error to
      // "nothing is scheduled" and log-and-skip failed updates, then return a count
      // this route could not tell apart from real success. The two steps are one
      // decision: either the schedules the customer asked to cancel are gone, or the
      // account stays - with its tokens - and they can retry.
      if (outcome.readFailed || outcome.failed > 0) {
        const userMessage = scheduleCancelFailedMessage(outcome.failed, outcome.readFailed);
        console.error(
          `[social/disconnect POST] schedule cancel incomplete (cleared=${outcome.cleared}, failed=${outcome.failed}, readFailed=${outcome.readFailed}) — account kept`,
        );
        return Response.json(
          {
            ok: false,
            code: "schedule_cancel_failed",
            cleared: outcome.cleared,
            failed: outcome.failed,
            userMessage,
            // `error` is what the client's readError surfaces as the thrown message.
            error: userMessage,
          },
          { status: 409 },
        );
      }
      cancelledScheduled = outcome.cleared;
    } else {
      const { count, readFailed } = await countScheduledForSocialConnectionStrict(
        createServerClient(), uid, connectionId,
      );
      // We could not answer "is this safe to delete?". Not knowing is not the same
      // as nothing being scheduled, and only one of those permits a delete.
      if (readFailed) {
        const userMessage = scheduleCheckFailedMessage();
        console.error("[social/disconnect POST] schedule check failed - account kept");
        return Response.json(
          { ok: false, code: "schedule_check_failed", userMessage, error: userMessage },
          { status: 503 },
        );
      }
      // Schedules exist and nobody has decided their fate. Hand the decision back
      // with the SERVER's count - the number the panel dialog must show, because it
      // is the only one taken at the moment of the delete.
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

    // Only now are the credentials invalidated. The revoke names the CONNECTION, so
    // the merchant's other accounts on the same platform are untouched (official.ts
    // forwards connectionId to the Facebook/Instagram stores, whose UPDATE is
    // narrowed by `.eq("id", connectionId)`).
    await revokeAtProvider();
    await deleteConnection(uid, connectionId);
    return Response.json({ ok: true, mode, cancelledScheduled });
  } catch (err) {
    console.error("[social/disconnect POST]", (err as Error).message);
    return Response.json({ error: "Could not disconnect account" }, { status: 500 });
  }
}
