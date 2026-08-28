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

  try {
    // Revoke at the provider first — this is what invalidates the credentials, and
    // it names the CONNECTION, so the merchant's other accounts on the same platform
    // are untouched (official.ts forwards connectionId to the Facebook/Instagram
    // stores, whose UPDATE is narrowed by `.eq("id", connectionId)`).
    await getSocialProviderById(connection.authProvider).disconnect({
      userId: uid,
      connectionId,
      externalConnectionId: connection.externalConnectionId,
      provider: connection.provider,
    });

    // SOFT: the row stays. Tokens are gone; the account is now a "Disconnected" row
    // in Settings that a reconnect can repair. For Facebook this also preserves
    // metadata.facebook.lastKnownPageId — the Page the merchant already identified —
    // so a later reconnect does not have to ask for the Page id by hand again.
    if (mode === "disconnect") {
      return Response.json({ ok: true, mode });
    }

    // HARD. Cancel BEFORE the delete: if the request dies half-way, the worse
    // outcome is a disconnected-but-present account whose schedules were not yet
    // cleared (visible, retryable) rather than a deleted account leaving live rows
    // the cron keeps picking up.
    //
    // And the cancel has to actually SUCCEED. It used to degrade a read error to
    // "nothing is scheduled" and log-and-skip failed updates, then return a count
    // this route could not tell apart from real success — so a transient DB failure
    // deleted the account, reported success, and left the merchant's schedules
    // pointing at a row that no longer exists. The two steps are one decision:
    // either the schedules the customer asked to cancel are gone, or the account
    // stays and they can retry.
    let cancelledScheduled = 0;
    if (cancelScheduled) {
      const outcome = await cancelScheduledForSocialConnection(
        createServerClient(), uid, connectionId, new Date().toISOString(),
      );
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
    }

    await deleteConnection(uid, connectionId);
    return Response.json({ ok: true, mode, cancelledScheduled });
  } catch (err) {
    console.error("[social/disconnect POST]", (err as Error).message);
    return Response.json({ error: "Could not disconnect account" }, { status: 500 });
  }
}
