/**
 * POST /api/social/disconnect
 *
 * Removes a connected social account for the authenticated merchant. Pinterest
 * has its own dedicated disconnect route (/api/pinterest/disconnect); this route
 * points the caller there so the tested flow is preserved.
 *
 * Body: { connectionId: string }
 * Response: { ok: true } | { ok: false, usePinterestFlow: true } | { error }
 */

import { getUserIdFromBearer } from "@/lib/server/authUser";
import {
  deleteConnection,
  findConnection,
} from "@/lib/social/server/socialConnectionStore";
import { getSocialProviderById } from "@/lib/social/providers";

export const dynamic = "force-dynamic";

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

  const connection = await findConnection(uid, connectionId);
  if (!connection) {
    return Response.json({ error: "Connection not found" }, { status: 404 });
  }

  // Pinterest: defer to its dedicated disconnect flow (DELETE /api/pinterest/disconnect).
  if (connection.provider === "pinterest") {
    return Response.json({ ok: false, usePinterestFlow: true });
  }

  try {
    // Best-effort revoke at the provider first (clears tokens for our own
    // OAuth platforms; a no-op for aggregators).
    await getSocialProviderById(connection.authProvider).disconnect({
      userId: uid,
      connectionId,
      externalConnectionId: connection.externalConnectionId,
      provider: connection.provider,
    });

    // Facebook keeps its row (tokens already nulled by the step above), mirroring
    // the Pinterest disconnect semantics. Deleting it would also erase
    // metadata.facebook.lastKnownPageId — the Page the merchant already
    // identified — so a later reconnect would fall back to asking for the Page id
    // by hand even though we knew it. Credentials are gone either way; only the
    // (non-secret) Page identity survives.
    if (connection.provider === "facebook") {
      return Response.json({ ok: true });
    }

    await deleteConnection(uid, connectionId);
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[social/disconnect POST]", (err as Error).message);
    return Response.json({ error: "Could not disconnect account" }, { status: 500 });
  }
}
