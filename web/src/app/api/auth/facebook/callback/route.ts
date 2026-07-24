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
 *      the four required business scopes → store 'reconnect_required' (never mark
 *      active) and redirect ?facebook=reconnect_required.
 *   6. Fetch the Facebook user (id + name) and discover IG-linked Pages
 *      (/me/accounts). Zero eligible Pages → 'no_instagram_account'
 *      (?facebook=no_instagram_account). We NEVER bypass with a hard-coded id.
 *   7. Encrypt + persist into social_connections (provider='facebook') incl. the
 *      per-Page page-scoped tokens (encrypted) for Phase 2 IG publishing.
 *   8. Redirect back to returnTo (or the social settings page) with a status flag.
 *
 * On success the redirect carries `?facebook=connected` (single eligible Page,
 * auto-selected) or `?facebook=select_account` (multiple — user must choose).
 *
 * SELECTION POLICY: with exactly ONE eligible Page we select it (there is nothing
 * to choose). With several we store them all as candidates and DO NOT auto-pick
 * index 0 — the user selects later. Phase 1 persists the candidate list; the
 * selection-landing UI is a follow-up.
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
  discoverInstagramAccounts,
} from "@/lib/server/facebook/service";
import { upsertFacebookConnection } from "@/lib/server/facebook/connectionStore";
import { missingRequiredScopes } from "@/lib/server/facebook/config";

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

  // ── Discover Instagram-linked Pages ─────────────────────────────────────────
  let pages;
  try {
    pages = await discoverInstagramAccounts(tokens.accessToken);
  } catch (err) {
    console.error("[Facebook OAuth Callback] account discovery failed:", (err as Error).message);
    return redirectAfterOAuth(req, "discovery_failed", verdict.returnTo);
  }

  if (pages.length === 0) {
    // Scopes are fine, but no Page has a linked IG Business account. We NEVER
    // bypass this with a known id — the user must link an IG account to a Page.
    try {
      await upsertFacebookConnection(uid, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.accessTokenExpiresAt,
        scopes: grantedScopes,
        accountId: fbUser.id,
        accountName: fbUser.name,
        state: "no_instagram_account",
        pages: [],
        selected: null,
      });
    } catch (persistErr) {
      console.error("[Facebook OAuth Callback] persist (no-ig) failed:", (persistErr as Error).message);
      return redirectAfterOAuth(req, "persist_failed", verdict.returnTo);
    }
    return redirectAfterOAuth(req, "no_instagram_account", verdict.returnTo);
  }

  // One eligible Page → select it (nothing to choose). Several → store all as
  // candidates and DO NOT auto-pick index 0; the user selects later.
  const single = pages.length === 1 ? pages[0] : null;
  const selected = single
    ? {
        pageId: single.pageId,
        pageName: single.pageName,
        instagramUserId: single.instagram.id,
        instagramUsername: single.instagram.username,
      }
    : null;

  try {
    await upsertFacebookConnection(uid, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.accessTokenExpiresAt,
      scopes: grantedScopes,
      accountId: fbUser.id,
      accountName: fbUser.name,
      // A single selected Page = a usable connection. Multiple = still connected
      // (scopes + IG present) but pending the user's account choice.
      state: "connected",
      pages,
      selected,
    });
  } catch (persistErr) {
    console.error("[Facebook OAuth Callback] persist failed:", (persistErr as Error).message);
    return redirectAfterOAuth(req, "persist_failed", verdict.returnTo);
  }

  return redirectAfterOAuth(req, selected ? "connected" : "select_account", verdict.returnTo);
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
