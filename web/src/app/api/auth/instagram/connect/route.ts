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
import {
  buildAuthorizeUrl,
  getInstagramEnv,
  isInstagramConfigured,
  INSTAGRAM_COMMENT_DM_SCOPES,
} from "@/lib/server/instagram/config";
import { requireSuperAdminFromRequest } from "@/lib/server/superAdmin";
import { getOwnInstagramConnection } from "@/lib/server/instagram/commentDmAdmin";
import { decideExtraScopes, type ExtraScopesReason } from "@/lib/server/instagram/connectScopes";
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

function buildConnectPayload(extraScopes: readonly string[] = []): ConnectPayload {
  const configErr = connectConfigError();
  if (configErr) throw configErr;
  const state = generateState();
  const authorizeUrl = buildAuthorizeUrl(getInstagramEnv(), state, extraScopes);
  return { authorizeUrl, state };
}

/**
 * Extra scopes for `?features=comment_dm` (internal comment → DM automation), OR
 * for a plain `reconnect=<id>` aimed at a row that already has those scopes (see
 * connectScopes.ts — prevents a generic Reconnect from washing out an existing
 * comment-DM grant). Both cases are gated to a super admin reconnecting/connecting
 * as themselves; for everyone else the authorize URL is exactly the normal one.
 */
async function requestedExtraScopes(
  req: NextRequest,
  uid: string,
  reconnectId: string | null,
): Promise<readonly string[]> {
  const features = (req.nextUrl.searchParams.get("features") ?? "")
    .split(",")
    .map(f => f.trim())
    .filter(Boolean);

  const { scopes, reason } = await decideExtraScopes(
    { uid, features, reconnectId },
    {
      superAdminId: async () => {
        try {
          const admin = await requireSuperAdminFromRequest(req);
          return admin?.id ?? null;
        } catch (err) {
          console.error("[instagram/connect] super-admin check failed:", (err as Error).message);
          throw err;
        }
      },
      ownConnection: async (u, id) => {
        try {
          const row = await getOwnInstagramConnection(u, id);
          return row ? { user_id: row.user_id, scopes: row.scopes } : null;
        } catch (err) {
          console.error("[instagram/connect] reconnect target read failed:", (err as Error).message);
          throw err;
        }
      },
    },
  );

  logExtraScopesDecision(features.includes("comment_dm"), reason, scopes.length > 0);
  return scopes;
}

/**
 * Preserves the exact pre-existing info/warn wording for the `features=comment_dm`
 * path (anything grepping logs for it must keep matching); the reconnect-preserve
 * path — which did not exist before — gets its own distinct lines.
 */
function logExtraScopesDecision(featureRequested: boolean, reason: ExtraScopesReason, honored: boolean): void {
  if (reason === "not_requested") return; // the common case — no log noise

  if (featureRequested) {
    if (honored) {
      console.info(
        `[instagram/connect] comment_dm requested and honored, appending extra scopes: ${INSTAGRAM_COMMENT_DM_SCOPES.join(",")}`,
      );
      return;
    }
    const why = reason === "id_mismatch" ? "id mismatch" : reason === "check_threw" ? "check threw" : "not super admin";
    console.warn(`[instagram/connect] comment_dm requested but not honored: ${why}`);
    return;
  }

  // reconnect (no features=comment_dm) path
  if (honored) {
    console.info(
      `[instagram/connect] preserve existing comment-dm grant on reconnect, appending extra scopes: ${INSTAGRAM_COMMENT_DM_SCOPES.join(",")}`,
    );
    return;
  }
  const why: Record<ExtraScopesReason, string> = {
    feature_honored: "",
    reconnect_preserved: "",
    not_requested: "",
    not_super_admin: "not super admin",
    id_mismatch: "id mismatch",
    target_missing_or_foreign: "reconnect target missing or not owned by this user",
    target_lacks_scopes: "reconnect target does not already have comment-dm scopes",
    check_threw: "check threw",
  };
  console.warn(`[instagram/connect] reconnect scope-preserve not honored: ${why[reason]}`);
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

  const extraScopes = await requestedExtraScopes(req, uid, reconnectId);

  let payload: ConnectPayload;
  try {
    payload = buildConnectPayload(extraScopes);
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
