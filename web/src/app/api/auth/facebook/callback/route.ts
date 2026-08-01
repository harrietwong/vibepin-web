/**
 * GET /api/auth/facebook/callback
 *
 * Exact registered redirect URI. Facebook sends the browser here with `code` and
 * `state` (or `error` on cancel/denial). Mirrors the Pinterest callback:
 *   1. Handle Facebook authorization errors (user denied, etc.).
 *   2. Verify `state` against the sealed cookie AND the current session user.
 *   3. Clear the OAuth cookies (single use) regardless of outcome.
 *   4. Exchange the code for tokens (short-lived → long-lived) server-side.
 *   5. Verify the ACTUALLY-granted permissions (/me/permissions). Missing any of
 *      the required Page scopes → store 'reconnect_required' (never mark active)
 *      and redirect ?facebook=reconnect_required.
 *   6. Fetch the Facebook user (id + name) and discover the Pages the user manages
 *      (/me/accounts). Zero managed Pages → 'no_pages' (?facebook=no_pages). We
 *      NEVER bypass with a hard-coded id. Instagram is fully decoupled — this flow
 *      never reads instagram_business_account.
 *   7. Encrypt + persist into social_connections (provider='facebook') incl. each
 *      Page's page-scoped token (encrypted) for publishing.
 *   8. Redirect back to returnTo (or the social settings page) with a status flag.
 *
 * On success the redirect carries `?facebook=connected` (exactly one Page,
 * auto-selected) or `?facebook=select_page` (several — user must choose a Page).
 *
 * SELECTION POLICY: with exactly ONE managed Page we select it (there is nothing
 * to choose). With several we store them all as candidates and DO NOT auto-pick
 * index 0 — the user selects one later via the Page picker.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getUserIdFromCookies } from "@/lib/server/authUser";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_RETURN_COOKIE,
  verifyState,
  readSealedReturnTo,
  safeReturnTo,
} from "@/lib/server/facebook/oauthState";
import {
  exchangeCodeForTokens,
  fetchFacebookUser,
  fetchGrantedPermissions,
  fetchManagedPages,
} from "@/lib/server/facebook/service";
import { upsertFacebookConnection } from "@/lib/server/facebook/connectionStore";
import { missingRequiredScopes } from "@/lib/server/facebook/config";
import { ConnectionLimitError } from "@/lib/server/social/connectionLimit";

export const dynamic = "force-dynamic";

const SOCIAL_SETTINGS_PATH = "/app/settings/social";

function redirectAfterOAuth(req: NextRequest, status: string, returnTo = SOCIAL_SETTINGS_PATH): NextResponse {
  const url = req.nextUrl.clone();
  const target = new URL(returnTo, req.nextUrl.origin);
  url.pathname = target.pathname;
  url.search = target.search;
  url.hash = target.hash;
  url.searchParams.set("facebook", status);
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
  // Facebook redirected back with an error (user cancelled/denied). NEVER exchange a
  // code or fetch a profile here. `access_denied` = user cancelled.
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
    console.error("[Facebook OAuth Callback] state verify failed:", verdict.reason);
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
    console.error("[Facebook OAuth Callback] token exchange failed:", (err as Error).message);
    return redirectAfterOAuth(req, "exchange_failed", verdict.returnTo);
  }

  // ── Verify granted permissions ──────────────────────────────────────────────
  // Facebook can return a code even if the user unchecked some permissions. Read
  // what was ACTUALLY granted and gate on the four required business scopes.
  let grantedScopes: string[];
  try {
    grantedScopes = await fetchGrantedPermissions(tokens.accessToken);
  } catch (err) {
    console.error("[Facebook OAuth Callback] permissions fetch failed:", (err as Error).message);
    return redirectAfterOAuth(req, "permissions_failed", verdict.returnTo);
  }

  // Fetch the connecting Facebook user (id + name) for display + row identity.
  let fbUser;
  try {
    fbUser = await fetchFacebookUser(tokens.accessToken);
  } catch (err) {
    console.error("[Facebook OAuth Callback] user fetch failed:", (err as Error).message);
    return redirectAfterOAuth(req, "profile_failed", verdict.returnTo);
  }

  const missing = missingRequiredScopes(grantedScopes);
  if (missing.length > 0) {
    // Not usable — persist granted scopes + reconnect_required, never mark active.
    // The frontend reads metadata to show exactly which permissions are missing.
    try {
      await upsertFacebookConnection(uid, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.accessTokenExpiresAt,
        scopes: grantedScopes,
        accountId: fbUser.id,
        accountName: fbUser.name,
        state: "reconnect_required",
        pages: [],
        selected: null,
      });
    } catch (persistErr) {
      console.error("[Facebook OAuth Callback] persist (reconnect) failed:", (persistErr as Error).message);
      return redirectAfterOAuth(req, "persist_failed", verdict.returnTo);
    }
    return redirectAfterOAuth(req, "reconnect_required", verdict.returnTo);
  }

  // ── Discover the Pages the user manages ─────────────────────────────────────
  let pages;
  try {
    pages = await fetchManagedPages(tokens.accessToken);
  } catch (err) {
    console.error("[Facebook OAuth Callback] page discovery failed:", (err as Error).message);
    return redirectAfterOAuth(req, "discovery_failed", verdict.returnTo);
  }

  if (pages.length === 0) {
    // Scopes are fine, but the user manages no Facebook Page. We NEVER bypass this
    // with a known id — the user must create or gain admin of a Page first.
    try {
      await upsertFacebookConnection(uid, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.accessTokenExpiresAt,
        scopes: grantedScopes,
        accountId: fbUser.id,
        accountName: fbUser.name,
        state: "no_pages",
        pages: [],
        selected: null,
      });
    } catch (persistErr) {
      // A plan ceiling is a user-actionable outcome, not a failure to report as
      // broken storage — surface it distinctly so the UI can offer disconnect/upgrade.
      if (persistErr instanceof ConnectionLimitError) {
        return redirectAfterOAuth(req, "account_limit", verdict.returnTo);
      }
      console.error("[Facebook OAuth Callback] persist (no-pages) failed:", (persistErr as Error).message);
      return redirectAfterOAuth(req, "persist_failed", verdict.returnTo);
    }
    return redirectAfterOAuth(req, "no_pages", verdict.returnTo);
  }

  // Exactly one Page → select it (nothing to choose). Several → store all as
  // candidates and DO NOT auto-pick index 0; the user selects one later.
  const single = pages.length === 1 ? pages[0] : null;
  const selected = single ? { pageId: single.pageId, pageName: single.pageName } : null;

  try {
    await upsertFacebookConnection(uid, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.accessTokenExpiresAt,
      scopes: grantedScopes,
      accountId: fbUser.id,
      accountName: fbUser.name,
      // One selected Page = a usable connection. Multiple = authorized but pending
      // the user's Page choice (page_selection_required).
      state: single ? "connected" : "page_selection_required",
      pages,
      selected,
    });
  } catch (persistErr) {
    if (persistErr instanceof ConnectionLimitError) {
      return redirectAfterOAuth(req, "account_limit", verdict.returnTo);
    }
    console.error("[Facebook OAuth Callback] persist failed:", (persistErr as Error).message);
    return redirectAfterOAuth(req, "persist_failed", verdict.returnTo);
  }

  return redirectAfterOAuth(req, single ? "connected" : "select_page", verdict.returnTo);
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
