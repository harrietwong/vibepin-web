/**
 * POST /api/pinterest/sync-account
 *
 * Deferred, best-effort profile enrichment. The OAuth callback deliberately skips
 * fetching the Pinterest account profile before redirecting (it's a non-essential
 * Pinterest API round trip + DB write that used to double the callback's
 * latency). The client calls this once after landing back in the app so the
 * username/account type backfill happens in the background instead of blocking
 * the redirect.
 *
 * Idempotent and safe to call repeatedly: cost is one Pinterest API call plus one
 * small partial DB update. Never returns tokens; never throws to the caller —
 * failures are logged server-side and reported as `{ ok: false }` so the UI can
 * quietly ignore them (the connection is already usable without this).
 *
 * The write is CONNECTION-scoped (v59). It used to pass the user id where the store
 * expected a row key, which was harmless only while a user could hold exactly one
 * Pinterest connection; with several, a user-scoped write would stamp whichever
 * account this call happened to read onto every row the user owns. The client tells
 * us the exact row it authenticated as (`boundConnectionId`), and the store refuses
 * the write unless that row is still unidentified or already this same account — so
 * a sync belonging to a superseded authorization can never relabel a live connection.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getUserIdFromBearer, getUserIdFromCookies } from "@/lib/server/authUser";
import { PinterestClient, NotConnectedError, NeedsReconnectError } from "@/lib/server/pinterest/service";
import { isPinterestSandboxEnv } from "@/lib/server/pinterest/config";
import { updateAccountInfo } from "@/lib/server/pinterest/connectionStore";

export const dynamic = "force-dynamic";

async function resolveUserId(req: NextRequest): Promise<string | null> {
  return (await getUserIdFromBearer(req)) ?? (await getUserIdFromCookies());
}

export async function POST(req: NextRequest) {
  const uid = await resolveUserId(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Sandbox env: the API base is the sandbox, but the user's stored OAuth token is
  // a production token the sandbox rejects — this sync can only fail after a wasted
  // Pinterest round trip. Skip it; enrichment resumes automatically in production.
  if (isPinterestSandboxEnv()) return NextResponse.json({ ok: false, code: "sandbox_env" });

  // An explicit `connectionId` targets one named connection (multi-account); without
  // one this resolves the user's single/default connection exactly as before.
  let requestedConnectionId: string | null = null;
  try {
    const body = (await req.json()) as { connectionId?: string } | null;
    const raw = body?.connectionId;
    if (typeof raw === "string" && raw.trim()) requestedConnectionId = raw.trim();
  } catch {
    /* empty body is the normal case */
  }

  try {
    const client = requestedConnectionId
      ? await PinterestClient.forConnection(uid, requestedConnectionId)
      : await PinterestClient.forUser(uid);
    const account = await client.getCurrentPinterestUser();
    // Write the row this client authenticated as — never the user, never the id the
    // caller asked for (forConnection already proved ownership of the resolved row).
    await updateAccountInfo(client.boundConnectionId, account);
    return NextResponse.json({ ok: true, account });
  } catch (err) {
    // Not connected / needs reconnect just means there's nothing to sync yet —
    // not an error worth surfacing to the user for a background call.
    if (err instanceof NotConnectedError || err instanceof NeedsReconnectError) {
      return NextResponse.json({ ok: false, code: err.code });
    }
    console.error("[pinterest/sync-account] failed:", (err as Error).message);
    return NextResponse.json({ ok: false });
  }
}
