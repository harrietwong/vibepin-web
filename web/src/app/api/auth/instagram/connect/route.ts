/**
 * /api/auth/instagram/connect
 *
 * Starts the Instagram Login (Business Login for Instagram) OAuth flow for the
 * logged-in VibePin user. Mirrors the Facebook connect route, but the authorize
 * URL points at Instagram's own dialog (www.instagram.com/oauth/authorize) and is
 * always scope-based (Instagram Login has no config_id):
 *   1. Require a Supabase session (cookie for GET navigation, Bearer for POST).
 *   2. Generate a cryptographically random `state`.
 *   3. Seal { state, uid, returnTo, exp } into an encrypted HttpOnly cookie (~10 min).
 *   4. Redirect (GET) or return the authorize URL (POST) to Instagram's dialog.
 *
 * The `state` param sent to Instagram is opaque random — it never contains a user id.
 *
 * Two entry points, same as Facebook:
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
import { canConnectAnotherAccount } from "@/lib/server/social/connectionLimit";
import { buildAuthorizeUrl, getInstagramEnv, isInstagramConfigured } from "@/lib/server/instagram/config";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_RETURN_COOKIE,
  generateState,
  sealState,
  stateCookieOptions,
  returnCookieOptions,
  isInstagramEncryptionConfigured,
} from "@/lib/server/instagram/oauthState";

export const dynamic = "force-dynamic";

const SOCIAL_SETTINGS_PATH = "/app/settings/social";
const PROVIDER = "instagram";

function settingsRedirect(req: NextRequest, status: string): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = SOCIAL_SETTINGS_PATH;
  url.search = `?instagram=${status}`;
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

/**
 * Plan gate for "add an account": true when the flow must be refused because the
 * user has no room left (plan allowance + purchased extra slots all spent).
 *
 * This mirrors the Pinterest connect route. Until now Instagram had no start-side
 * check at all: the user was sent all the way through the OAuth dialog, granted
 * permissions, and only THEN had the write refused by the store. Refusing before
 * the dialog is the difference between "you cannot add another account" and
 * "authorize us, wait, and then be told no".
 *
 * A `reconnect=<id>` flow is ALWAYS allowed through. Reconnect repairs an existing
 * row (the store's UPDATE branch, which never consults the limit) — refusing it at
 * the ceiling would leave an at-limit user permanently unable to fix a broken
 * connection. The id is only shape-checked here; it grants nothing, because it is
 * re-read against THIS user's own rows in the callback (a forged or foreign id
 * resolves to nothing and degrades to a plain connect), the callback refuses a
 * different account outright, and the store's insert branch re-checks the limit.
 * So a forged id cannot create an over-limit row.
 *
 * Fails OPEN on an unexpected error: an entitlement lookup that throws must not
 * become a connect outage. The persist-time check is the backstop.
 */
async function isOverAccountLimit(uid: string, reconnectId: string | null): Promise<boolean> {
  if (reconnectId) return false;
  try {
    const verdict = await canConnectAnotherAccount(uid, PROVIDER);
    if (verdict.allowed) return false;
    console.warn(
      `[instagram/connect] account limit reached (plan=${verdict.plan}, used=${verdict.current}/${verdict.limit})`,
    );
    return true;
  } catch (err) {
    console.error("[instagram/connect] quota check failed, allowing start:", (err as Error).message);
    return false;
  }
}

/** Shape-only validation of a reconnect id (see isOverAccountLimit). */
function sanitizeReconnectId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^[0-9a-fA-F-]{16,64}$/.test(trimmed)) return null;
  return trimmed;
}

/** Config check with a safe message (never echoes secret values). */
function connectConfigError(): ConfigurationError | null {
  if (!isInstagramEncryptionConfigured()) {
    return new ConfigurationError(
      "INSTAGRAM_TOKEN_ENC_KEY is not set — add it to web/.env.local, then restart the dev server.",
    );
  }
  if (!isInstagramConfigured()) {
    return new ConfigurationError(
      "Instagram OAuth env is incomplete — set INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET, and INSTAGRAM_REDIRECT_URI in web/.env.local.",
    );
  }
  return null;
}

type ConnectPayload = { authorizeUrl: string; state: string };

function buildConnectPayload(): ConnectPayload {
  const configErr = connectConfigError();
  if (configErr) throw configErr;
  const state = generateState();
  const authorizeUrl = buildAuthorizeUrl(getInstagramEnv(), state);
  return { authorizeUrl, state };
}

function attachOAuthStateCookie(
  res: NextResponse,
  req: NextRequest,
  state: string,
  uid: string,
  returnTo: string,
  reconnectConnectionId: string | null,
): NextResponse {
  try {
    res.cookies.set(
      OAUTH_STATE_COOKIE,
      // The reconnect target rides INSIDE the sealed cookie, never in the opaque
      // `state` param handed to Instagram: the callback has to be able to trust it
      // (it decides whether a different account is refused), and only the sealed
      // cookie is tamper-evident.
      sealState(state, uid, returnTo, reconnectConnectionId),
      stateCookieOptions(req.nextUrl.protocol === "https:"),
    );
    return res;
  } catch (err) {
    console.error("[instagram/connect] seal state failed:", (err as Error).message);
    throw new ConfigurationError("Instagram OAuth could not be started — check INSTAGRAM_TOKEN_ENC_KEY.");
  }
}

function configErrorResponse(req: NextRequest, err: ConfigurationError, asJson: boolean): NextResponse {
  console.error("[instagram/connect] config error:", err.message);
  if (asJson) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 500 });
  }
  return settingsRedirect(req, "config_error");
}

export async function GET(req: NextRequest) {
  const returnTo = sanitizeReturnTo(req.nextUrl.searchParams.get("next"));
  const reconnectId = sanitizeReconnectId(req.nextUrl.searchParams.get("reconnect"));

  const uid = await getUserIdFromCookieSession();
  if (!uid) return loginRedirect(req, returnTo);

  // Refuse BEFORE the OAuth dialog. `account_limit` is the same flag the callback
  // redirects with, so the Settings panel shows one banner either way.
  if (await isOverAccountLimit(uid, reconnectId)) {
    return settingsRedirect(req, "account_limit");
  }

  let payload: ConnectPayload;
  try {
    payload = buildConnectPayload();
  } catch (err) {
    if (err instanceof ConfigurationError) return configErrorResponse(req, err, false);
    console.error("[instagram/connect] unexpected error:", (err as Error).message);
    return settingsRedirect(req, "config_error");
  }

  const res = NextResponse.redirect(payload.authorizeUrl);
  // Plain returnTo cookie (no secret) so the callback can send the user back to the
  // exact origin even if state validation later fails. Cleared by the callback.
  res.cookies.set(OAUTH_RETURN_COOKIE, returnTo, returnCookieOptions(req.nextUrl.protocol === "https:"));
  try {
    return attachOAuthStateCookie(res, req, payload.state, uid, returnTo, reconnectId);
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
  let reconnectId: string | null = null;
  try {
    const body = (await req.json()) as { next?: string; reconnect?: string };
    returnTo = sanitizeReturnTo(body.next ?? null);
    reconnectId = sanitizeReconnectId(body.reconnect ?? null);
  } catch {
    /* empty body ok */
  }

  const uid = (await getUserIdFromBearer(req)) ?? (await getUserIdFromCookies());
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
  }

  if (await isOverAccountLimit(uid, reconnectId)) {
    return NextResponse.json(
      { error: "You've reached your plan's connected account limit.", code: "account_limit" },
      { status: 403 },
    );
  }

  let payload: ConnectPayload;
  try {
    payload = buildConnectPayload();
  } catch (err) {
    if (err instanceof ConfigurationError) return configErrorResponse(req, err, true);
    console.error("[instagram/connect] unexpected error:", (err as Error).message);
    return NextResponse.json({ error: "Instagram is not configured", code: "config_error" }, { status: 500 });
  }

  const res = NextResponse.json({ url: payload.authorizeUrl });
  res.cookies.set(OAUTH_RETURN_COOKIE, returnTo, returnCookieOptions(req.nextUrl.protocol === "https:"));
  try {
    return attachOAuthStateCookie(res, req, payload.state, uid, returnTo, reconnectId);
  } catch (err) {
    if (err instanceof ConfigurationError) return configErrorResponse(req, err, true);
    return NextResponse.json({ error: "Instagram OAuth could not be started", code: "config_error" }, { status: 500 });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
