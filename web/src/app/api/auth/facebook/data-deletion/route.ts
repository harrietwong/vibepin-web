/**
 * POST /api/auth/facebook/data-deletion
 *
 * Meta's "Data Deletion Request Callback URL" — required for every app using
 * Facebook Login (in addition to, and distinct from, the deauthorize
 * callback). Facebook POSTs here (form-urlencoded `signed_request`) when a
 * user requests their data be deleted via Facebook's own settings.
 *
 * Trust model is identical to deauthorize: HMAC-SHA256 verification of
 * `signed_request` via lib/server/facebook/signedRequest.ts. No session, no
 * cookie.
 *
 * On a valid signed_request we:
 *   1. Disconnect the matching social_connections row (same as deauthorize —
 *      clear tokens, mark not_connected; VibePin never stores Facebook content
 *      beyond the OAuth connection tokens, so this satisfies the deletion).
 *   2. Return Meta's REQUIRED JSON shape:
 *        { url: "<status page the user can check>", confirmation_code: "<unique>" }
 *      (Meta's spec allows a bare confirmation_code string as an alternative,
 *      but the {url, confirmation_code} object is the documented default and
 *      is what we implement here.)
 *
 * Invalid signed_request → 400 (never 500, never a partial JSON body).
 */

import { randomBytes } from "node:crypto";
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
    const form = await req.formData();
    const value = form.get("signed_request");
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/** Same disconnect semantics as the deauthorize callback (see that route's comment). */
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

  if (error && error.code !== "42P01" && error.code !== "PGRST205") {
    console.error("[facebook/data-deletion] disconnect failed:", error.message);
  }
}

function buildConfirmationCode(fbUserId: string): string {
  return `fb-del-${fbUserId}-${randomBytes(8).toString("hex")}`;
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
    // Never fail the webhook on a storage hiccup — Meta still needs a
    // confirmation code; the connection will appear stale until reconnect.
    console.error("[facebook/data-deletion] unexpected error:", (err as Error).message);
  }

  const confirmationCode = buildConfirmationCode(parsed.userId);
  const statusUrl = new URL(`/data-deletion-status?code=${encodeURIComponent(confirmationCode)}`, req.nextUrl.origin);

  return NextResponse.json(
    { url: statusUrl.toString(), confirmation_code: confirmationCode },
    { status: 200 },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
