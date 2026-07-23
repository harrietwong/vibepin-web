/**
 * POST /api/auth/facebook/deauthorize
 *
 * Meta's "Deauthorize Callback URL" — required for every app using Facebook
 * Login. Facebook POSTs here (form-urlencoded, containing `signed_request`)
 * whenever a user removes the app from their Facebook settings. This is a
 * server-to-server webhook, not a browser navigation: there is no session, no
 * cookie, no CORS-relevant origin — trust comes ONLY from the HMAC-SHA256
 * signature over `signed_request` (see lib/server/facebook/signedRequest.ts).
 *
 * On a valid signed_request we disconnect the matching social_connections row
 * (provider='facebook', provider_account_id=<facebook user id>) the same way
 * the OAuth disconnect flow does: clear the token columns and mark
 * connection_status='not_connected' (row kept, not deleted).
 *
 * Per Meta's spec:
 *   - Always return HTTP 200 once the signature is valid, even if no matching
 *     connection is found locally (the user may have already disconnected, or
 *     never actually persisted a connection here).
 *   - Return 400 only when the signed_request itself fails verification.
 */

import { NextResponse, type NextRequest } from "next/server";
import { parseSignedRequest } from "@/lib/server/facebook/signedRequest";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const TABLE = "social_connections";
const PROVIDER = "facebook";

async function extractSignedRequest(req: NextRequest): Promise<string | null> {
  const contentType = req.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await req.json()) as { signed_request?: string };
      return typeof body.signed_request === "string" ? body.signed_request : null;
    }
    // Meta's documented content-type is application/x-www-form-urlencoded.
    const form = await req.formData();
    const value = form.get("signed_request");
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Disconnect by Facebook account id (not VibePin uid — this webhook has no
 * VibePin session). Mirrors connectionStore.ts's disconnectFacebookConnection
 * semantics (clear tokens, mark not_connected, keep the row) but resolves the
 * row by provider_account_id since that's all Meta gives us here.
 */
async function disconnectByFacebookAccountId(fbUserId: string): Promise<void> {
  const db = createServerClient();
  const { error } = await db
    .from(TABLE)
    .update({
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      token_expires_at: null,
      connection_status: "not_connected",
      updated_at: new Date().toISOString(),
    })
    .eq("provider", PROVIDER)
    .eq("provider_account_id", fbUserId);

  // Missing table / no matching row are both non-fatal here — Meta still gets 200.
  if (error && error.code !== "42P01" && error.code !== "PGRST205") {
    console.error("[facebook/deauthorize] disconnect failed:", error.message);
  }
}

export async function POST(req: NextRequest) {
  const signedRequest = await extractSignedRequest(req);
  const parsed = parseSignedRequest(signedRequest);
  if (!parsed) {
    return NextResponse.json({ error: "Invalid signed_request" }, { status: 400 });
  }

  try {
    await disconnectByFacebookAccountId(parsed.userId);
  } catch (err) {
    // Never fail the webhook on a storage hiccup — log and still ack 200 so Meta
    // doesn't retry indefinitely; the connection will simply appear stale until
    // the user reconnects or retries deauthorizing.
    console.error("[facebook/deauthorize] unexpected error:", (err as Error).message);
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
