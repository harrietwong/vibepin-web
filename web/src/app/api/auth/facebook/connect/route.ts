/**
 * /api/auth/facebook/connect
 *
 * Starts the Facebook OAuth flow for the logged-in VibePin user. Mirrors the
 * Pinterest connect route:
 *   1. Require a Supabase session (cookie for GET navigation, Bearer for POST).
 *   2. Generate a cryptographically random `state`.
 *   3. Seal { state, uid, returnTo, exp } into an encrypted HttpOnly cookie (~10 min).
 *   4. Redirect (GET) or return the authorize URL (POST) to Facebook's dialog.
 *
 * The `state` param sent to Facebook is opaque random — it never contains a user id.
 *
 * Two entry points, same as Pinterest:
 *   GET  — browser navigation (used by <a href> / window.location); redirects.
 *   POST — Bearer-auth JSON APIs (used by the "Connect" button fetch); returns { url }.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  getUserIdFromBearer,
  getUserIdFromCookies,
  getUserIdFromCookieSession,
} from "@/lib/server/authUser";
import { ConfigurationError } from "@/lib/server/pinterest/errors";
import { buildAuthorizeUrl, getFacebookEnv, isFacebookConfigured } from "@/lib/server/facebook/config";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_RETURN_COOKIE,
  generateState,
  sealState,
  stateCookieOptions,
  returnCookieOptions,
  isFacebookEncryptionConfigured,
} from "@/lib/server/facebook/oauthState";

export const dynamic = "force-dynamic";

const SOCIAL_SETTINGS_PATH = "/app/settings/social";

function settingsRedirect(req: NextRequest, status: string): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = SOCIAL_SETTINGS_PATH;
  url.search = `?facebook=${status}`;
  return NextResponse.redirect(url);
}

function sanitizeReturnTo(value: string | null | undefined): string {
  if (!value) return SOCIAL_SETTINGS_PATH;
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded.startsWith("/app/")) return SOCIAL_SETTINGS_PATH;
    if (decoded.startsWith("//") || decoded.includes("://")) return SOCIAL_SETTINGS_PATH;
    return decoded;
  } catch {
    return SOCIAL_SETTINGS_PATH;
  }
}

function loginRedirect(req: NextRequest, returnTo: string): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(returnTo)}`;
  return NextResponse.redirect(url);
}

/** Config check with a safe message (never echoes secret values). */
function connectConfigError(): ConfigurationError | null {
  if (!isFacebookEncryptionConfigured()) {
    return new ConfigurationError(
      "FACEBOOK_TOKEN_ENC_KEY is not set — add it to web/.env.local, then restart the dev server.",
    );
  }
  if (!isFacebookConfigured()) {
    return new ConfigurationError(
      "Facebook OAuth env is incomplete — set FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, and FACEBOOK_REDIRECT_URI in web/.env.local.",
    );
  }
  return null;
}

type ConnectPayload = { authorizeUrl: string; state: string };

function buildConnectPayload(): ConnectPayload {
  const configErr = connectConfigError();
  if (configErr) throw configErr;
  const state = generateState();
  const authorizeUrl = buildAuthorizeUrl(getFacebookEnv(), state);
  return { authorizeUrl, state };
}

function attachOAuthStateCookie(
  res: NextResponse,
  req: NextRequest,
  state: string,
  uid: string,
  returnTo: string,
): NextResponse {
  try {
    res.cookies.set(
      OAUTH_STATE_COOKIE,
      sealState(state, uid, returnTo),
      stateCookieOptions(req.nextUrl.protocol === "https:"),
    );
    return res;
  } catch (err) {
    console.error("[facebook/connect] seal state failed:", (err as Error).message);
    throw new ConfigurationError("Facebook OAuth could not be started — check FACEBOOK_TOKEN_ENC_KEY.");
  }
}

function configErrorResponse(req: NextRequest, err: ConfigurationError, asJson: boolean): NextResponse {
  console.error("[facebook/connect] config error:", err.message);
  if (asJson) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 500 });
  }
  return settingsRedirect(req, "config_error");
}

export async function GET(req: NextRequest) {
  const returnTo = sanitizeReturnTo(req.nextUrl.searchParams.get("next"));

  const uid = await getUserIdFromCookieSession();
  if (!uid) return loginRedirect(req, returnTo);

  let payload: ConnectPayload;
  try {
    payload = buildConnectPayload();
  } catch (err) {
    if (err instanceof ConfigurationError) return configErrorResponse(req, err, false);
    console.error("[facebook/connect] unexpected error:", (err as Error).message);
    return settingsRedirect(req, "config_error");
  }

  const res = NextResponse.redirect(payload.authorizeUrl);
  // Plain returnTo cookie (no secret) so the callback can send the user back to the
  // exact origin even if state validation later fails. Cleared by the callback.
  res.cookies.set(OAUTH_RETURN_COOKIE, returnTo, returnCookieOptions(req.nextUrl.protocol === "https:"));
  try {
    return attachOAuthStateCookie(res, req, payload.state, uid, returnTo);
  } catch (err) {
    if (err instanceof ConfigurationError) return configErrorResponse(req, err, false);
    return settingsRedirect(req, "config_error");
  }
}

/**
 * Bearer-friendly OAuth bootstrap — used when JSON APIs auth via Authorization
 * header (the "Connect" button's fetch). Returns { url } to redirect to; sets the
 * sealed state + returnTo cookies on the same response.
 */
export async function POST(req: NextRequest) {
  let returnTo = SOCIAL_SETTINGS_PATH;
  try {
    const body = (await req.json()) as { next?: string };
    returnTo = sanitizeReturnTo(body.next ?? null);
  } catch {
    /* empty body ok */
  }

  const uid = (await getUserIdFromBearer(req)) ?? (await getUserIdFromCookies());
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
  }

  let payload: ConnectPayload;
  try {
    payload = buildConnectPayload();
  } catch (err) {
    if (err instanceof ConfigurationError) return configErrorResponse(req, err, true);
    console.error("[facebook/connect] unexpected error:", (err as Error).message);
    return NextResponse.json({ error: "Facebook is not configured", code: "config_error" }, { status: 500 });
  }

  const res = NextResponse.json({ url: payload.authorizeUrl });
  res.cookies.set(OAUTH_RETURN_COOKIE, returnTo, returnCookieOptions(req.nextUrl.protocol === "https:"));
  try {
    return attachOAuthStateCookie(res, req, payload.state, uid, returnTo);
  } catch (err) {
    if (err instanceof ConfigurationError) return configErrorResponse(req, err, true);
    return NextResponse.json({ error: "Facebook OAuth could not be started", code: "config_error" }, { status: 500 });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
