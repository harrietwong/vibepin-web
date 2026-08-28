/**
 * GET /api/auth/instagram/callback
 *
 * Exact registered redirect URI. Instagram sends the browser here with `code` and
 * `state` (or `error` on cancel/denial). Mirrors the Facebook callback but is
 * SIMPLER — Instagram Login has no Facebook Page / permissions-enumeration step:
 *   1. Handle Instagram authorization errors (user denied, etc.).
 *   2. Verify `state` against the sealed cookie AND the current session user.
 *   3. Clear the OAuth cookies (single use) regardless of outcome.
 *   4. Exchange the code for tokens (short-lived + user_id → long-lived) server-side.
 *   5. Fetch the Instagram profile (user_id / username / account_type / name).
 *      A PERSONAL account is REJECTED (?instagram=personal_account) — VibePin
 *      supports only Business / Creator accounts. Nothing is persisted for a
 *      rejected account.
 *   5b. If this flow was started as a Reconnect (the target connection id rides in
 *      the sealed state), compare the Instagram account that just authorized with
 *      the identity recorded on that row. A DIFFERENT account writes NOTHING and
 *      redirects ?instagram=account_mismatch&expected=&got= — the same refusal
 *      Pinterest and Facebook make.
 *   6. Encrypt + persist into social_connections (provider='instagram') as
 *      'connected'.
 *   7. Redirect back to returnTo (or the social settings page) with a status flag.
 *
 * On success the redirect carries `?instagram=connected`.
 *
 * This flow is FULLY DECOUPLED from Facebook — it never reads a Facebook Page, a
 * Facebook token, or the provider='facebook' row.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getUserIdFromCookies } from "@/lib/server/authUser";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_RETURN_COOKIE,
  verifyState,
  readSealedReturnTo,
  safeReturnTo,
} from "@/lib/server/instagram/oauthState";
import {
  exchangeCodeForTokens,
  fetchInstagramProfile,
  isProfessionalAccount,
} from "@/lib/server/instagram/service";
import {
  upsertInstagramConnection,
  getInstagramReconnectTarget,
} from "@/lib/server/instagram/connectionStore";
import { decideReconnect } from "@/lib/server/social/reconnectIdentity";
import { INSTAGRAM_SCOPES } from "@/lib/server/instagram/config";
import { ConnectionLimitError } from "@/lib/server/social/connectionLimit";

export const dynamic = "force-dynamic";

const SOCIAL_SETTINGS_PATH = "/app/settings/social";

/**
 * Non-production OAuth diagnostic (mirrors the Facebook [facebook-oauth-debug]
 * contract). Prints identity and scope facts only: the access token is reported
 * as a boolean, and no secret, raw profile object, or request URL is ever logged.
 */
function igDebug(record: {
  igUserId: string | null;
  username: string | null;
  accountType: string | null;
  scopes: string[];
  tokenPresent: boolean;
  tokenExpiresAt: string | null;
}): void {
  if (process.env.VERCEL_ENV === "production") return;
  console.log("[instagram-oauth-debug]", JSON.stringify(record));
}

function redirectAfterOAuth(
  req: NextRequest,
  status: string,
  returnTo = SOCIAL_SETTINGS_PATH,
  /**
   * Extra query params for the Settings panel. Used by `account_mismatch` to name
   * both accounts (`expected` / `got`) so the banner can be specific without
   * another round trip — the same contract the Pinterest callback uses.
   */
  extra?: Record<string, string | null | undefined>,
): NextResponse {
  const url = req.nextUrl.clone();
  const target = new URL(returnTo, req.nextUrl.origin);
  url.pathname = target.pathname;
  url.search = target.search;
  url.hash = target.hash;
  url.searchParams.set("instagram", status);
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value) url.searchParams.set(key, value);
  }
  const res = NextResponse.redirect(url);
  // Both OAuth cookies are single-use — clear on every outcome.
  res.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
  res.cookies.set(OAUTH_RETURN_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const code = params.get("code") ?? undefined;
  const stateParam = params.get("state") ?? undefined;
  const oauthError = params.get("error");
  const cookieValue = req.cookies.get(OAUTH_STATE_COOKIE)?.value;
  // Plain returnTo fallback used ONLY to pick the redirect target when the sealed
  // state can't be trusted (state mismatch/expired), so a failed attempt still lands
  // the user back where they started to retry.
  const returnFallback = safeReturnTo(req.cookies.get(OAUTH_RETURN_COOKIE)?.value);

  // ── Cancel / error branch ───────────────────────────────────────────────────
  // Instagram redirected back with an error (user cancelled/denied). NEVER exchange
  // a code or fetch a profile here. `access_denied` = user cancelled.
  if (oauthError) {
    const status = oauthError === "access_denied" ? "cancelled" : "error";
    const returnTo = readSealedReturnTo(cookieValue, stateParam) ?? returnFallback;
    return redirectAfterOAuth(req, status, returnTo);
  }

  const uid = await getUserIdFromCookies();
  if (!uid) {
    // Session lost during the round trip — recover returnTo so we still land right.
    return redirectAfterOAuth(req, "session_expired", readSealedReturnTo(cookieValue, stateParam) ?? returnFallback);
  }

  const verdict = verifyState(cookieValue, stateParam, uid);
  if (!verdict.ok) {
    if (verdict.reason === "expired") return redirectAfterOAuth(req, "state_expired", returnFallback);
    if (verdict.reason === "user_mismatch") return redirectAfterOAuth(req, "session_expired", returnFallback);
    console.error("[Instagram OAuth Callback] state verify failed:", verdict.reason);
    return redirectAfterOAuth(req, "state_mismatch", returnFallback);
  }

  if (!code) {
    // Success-shaped redirect but no code (shouldn't happen) — treat as cancel.
    return redirectAfterOAuth(req, "cancelled", verdict.returnTo);
  }

  // ── Success branch ──────────────────────────────────────────────────────────
  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code);
  } catch (err) {
    console.error("[Instagram OAuth Callback] token exchange failed:", (err as Error).message);
    return redirectAfterOAuth(req, "exchange_failed", verdict.returnTo);
  }

  // Fetch the connected Instagram account (id / username / account_type / name).
  let profile;
  try {
    profile = await fetchInstagramProfile(tokens.accessToken);
  } catch (err) {
    console.error("[Instagram OAuth Callback] profile fetch failed:", (err as Error).message);
    return redirectAfterOAuth(req, "profile_failed", verdict.returnTo);
  }

  // Non-production diagnostic: enough to tell a rejected connection apart from a
  // mis-scoped one without a round trip. Hand-picked fields only — the token is
  // reported as a boolean, never printed, and never is the raw profile object.
  igDebug({
    igUserId: profile.userId || tokens.userId,
    username: profile.username,
    accountType: profile.accountType,
    scopes: tokens.scopes.length > 0 ? tokens.scopes : [...INSTAGRAM_SCOPES],
    tokenPresent: Boolean(tokens.accessToken),
    tokenExpiresAt: tokens.accessTokenExpiresAt ?? null,
  });

  // ── Reconnect identity gate (Codex #5) ──────────────────────────────────────
  // A Reconnect names the row it is repairing; that id rode here inside the sealed
  // OAuth state. If a DIFFERENT Instagram account just authorized, NOTHING may be
  // written — not the token, not a new row. Before this, the store fell back to
  // identity matching, found no row for the new account and INSERTED one: a slot
  // spent on an account the merchant never meant to add, while the account they
  // were repairing stayed disconnected, with nothing on screen saying so.
  //
  // `profile.userId || tokens.userId` is the very expression the upsert stores as
  // provider_account_id, so the check and the write can never compare different
  // things.
  const authorizedAccountId = profile.userId || tokens.userId;
  let reconnectTargetId: string | null = null;
  if (verdict.reconnectConnectionId) {
    let target;
    try {
      target = await getInstagramReconnectTarget(uid, verdict.reconnectConnectionId);
    } catch (readErr) {
      // Reading the merchant's own row failed. Writing blind is exactly the
      // overwrite this gate exists to prevent, so refuse.
      console.error("[Instagram OAuth Callback] reconnect target read failed:", (readErr as Error).message);
      return redirectAfterOAuth(req, "persist_failed", verdict.returnTo);
    }
    const decision = decideReconnect({
      reconnectTargetId: verdict.reconnectConnectionId,
      target,
      authorizedAccountId,
      authorizedLabel: profile.username ?? profile.name ?? null,
    });
    if (decision.action === "reject") {
      return redirectAfterOAuth(req, "account_mismatch", verdict.returnTo, {
        expected: decision.expectedLabel,
        got: decision.gotLabel,
        // The row being repaired, so the banner's retry names it (Codex #3). The
        // panel's state cannot survive the full-page OAuth navigation, and without
        // this the banner guessed accounts[0] — which for a second Instagram
        // account is the wrong row every time. The panel still verifies the id is
        // in its current connection list before acting on it.
        target: verdict.reconnectConnectionId,
      });
    }
    // Names the row the upsert must land on. Load-bearing for a target row that
    // never recorded an account id: the store's identity rule only adopts a LONE
    // unidentified row, so a merchant with two Instagram rows would otherwise get a
    // duplicate insert instead of the repair they asked for.
    reconnectTargetId = decision.targetConnectionId;
  }

  // ── PERSONAL-account gate ─────────────────────────────────────────────────────
  // Content publishing requires a Business or Creator (MEDIA_CREATOR) account.
  // A PERSONAL (or unknown) account_type is rejected and NOTHING is persisted — we
  // never mark a non-professional account as connected.
  if (!isProfessionalAccount(profile.accountType)) {
    return redirectAfterOAuth(req, "personal_account", verdict.returnTo);
  }

  // Record the scopes Instagram actually granted (from the short-lived exchange);
  // fall back to the requested set when the response omitted them.
  const scopes = tokens.scopes.length > 0 ? tokens.scopes : [...INSTAGRAM_SCOPES];

  try {
    await upsertInstagramConnection(uid, {
      accessToken: tokens.accessToken,
      expiresAt: tokens.accessTokenExpiresAt,
      scopes,
      // Prefer the profile user_id; the token exchange user_id is the same account.
      accountId: authorizedAccountId,
      username: profile.username,
      name: profile.name,
      accountType: profile.accountType,
      state: "connected",
    }, reconnectTargetId);
  } catch (persistErr) {
    // A plan ceiling is user-actionable, not broken storage — surface it distinctly.
    if (persistErr instanceof ConnectionLimitError) {
      return redirectAfterOAuth(req, "account_limit", verdict.returnTo);
    }
    console.error("[Instagram OAuth Callback] persist failed:", (persistErr as Error).message);
    return redirectAfterOAuth(req, "persist_failed", verdict.returnTo);
  }

  return redirectAfterOAuth(req, "connected", verdict.returnTo);
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
