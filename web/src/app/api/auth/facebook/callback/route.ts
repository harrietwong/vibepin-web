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
 *   5b. If this flow was started as a Reconnect (the target connection id rides in
 *      the sealed state), compare the Facebook user that just authorized with the
 *      identity recorded on that row. A DIFFERENT user writes NOTHING at all and
 *      redirects ?facebook=account_mismatch&expected=&got= — the same refusal
 *      Pinterest makes. Checked before step 5's write, which also persists.
 *   6. Fetch the Facebook user (id + name) and discover the Pages the user manages
 *      (/me/accounts). An EMPTY (but successful) enumeration →
 *      'page_discovery_empty' (?facebook=page_discovery_empty) — see below. We
 *      NEVER bypass with a hard-coded id. Instagram is fully decoupled — this flow
 *      never reads instagram_business_account.
 *   7. Encrypt + persist into social_connections (provider='facebook') incl. each
 *      Page's page-scoped token (encrypted) for publishing.
 *   8. Redirect back to returnTo (or the social settings page) with a status flag.
 *
 * On success the redirect carries `?facebook=connected` (exactly one Page,
 * auto-selected) or `?facebook=select_page` (several — user must choose a Page).
 *
 * FAILURE-STATUS TRIAGE: any Graph call that actually FAILS (FacebookApiError)
 * redirects `?facebook=graph_api_error` — never a Page-state status.
 *
 * EMPTY ENUMERATION IS NOT "NO PAGE": when Graph returns 2xx with every required
 * scope granted but `data` is empty, that is `page_discovery_empty` — an
 * AUTHORIZED connection awaiting a manually-specified Page id, NOT an error.
 * Business-Portfolio-owned Pages routinely come back this way even though
 * GET /{page-id} with the very same user token resolves them and returns a Page
 * token. The user token is therefore preserved so the manual fallback
 * (POST /api/integrations/facebook/connect-page) can use it. The old `no_pages`
 * status — which asserted the user owns no Page — has been removed entirely.
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
  FacebookApiError,
  debugProbePageById,
  exchangeCodeForTokens,
  fetchFacebookUser,
  fetchGrantedPermissions,
  fetchManagedPages,
  restorePreviousPage,
  type ManagedPage,
} from "@/lib/server/facebook/service";
import {
  upsertFacebookConnection,
  getStoredFacebookSelection,
  getFacebookReconnectTarget,
} from "@/lib/server/facebook/connectionStore";
import { decideReconnect } from "@/lib/server/social/reconnectIdentity";
import { missingRequiredScopes } from "@/lib/server/facebook/config";
import { ConnectionLimitError } from "@/lib/server/social/connectionLimit";

export const dynamic = "force-dynamic";

const SOCIAL_SETTINGS_PATH = "/app/settings/social";

/**
 * Development-only diagnostic log for the callback (mirrors service.fbDebug).
 * Never prints tokens or request URLs — only ids, counts, and scope names.
 */
const FB_DEBUG_ENABLED = process.env.NODE_ENV !== "production";
function fbDebug(...parts: unknown[]): void {
  if (!FB_DEBUG_ENABLED) return;
  console.log("[facebook-oauth-debug]", ...parts);
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
  url.searchParams.set("facebook", status);
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
  //
  // ERROR TRIAGE: a Graph call that FAILED (FacebookApiError) is a different
  // problem from a Graph call that SUCCEEDED and told us something is missing.
  // Collapsing both into one status is what made "no Pages" the catch-all
  // explanation for every Facebook failure. Failures → `graph_api_error`;
  // successful-but-incomplete → the specific status (reconnect_required /
  // page_discovery_empty).
  let grantedScopes: string[];
  try {
    grantedScopes = await fetchGrantedPermissions(tokens.accessToken);
  } catch (err) {
    console.error("[Facebook OAuth Callback] permissions fetch failed:", (err as Error).message);
    if (err instanceof FacebookApiError) {
      fbDebug(`permissions fetch FAILED status=${err.status} code=${err.code}`);
      return redirectAfterOAuth(req, "graph_api_error", verdict.returnTo);
    }
    return redirectAfterOAuth(req, "permissions_failed", verdict.returnTo);
  }

  // Fetch the connecting Facebook user (id + name) for display + row identity.
  let fbUser;
  try {
    fbUser = await fetchFacebookUser(tokens.accessToken);
  } catch (err) {
    console.error("[Facebook OAuth Callback] user fetch failed:", (err as Error).message);
    if (err instanceof FacebookApiError) {
      fbDebug(`user fetch FAILED status=${err.status} code=${err.code}`);
      return redirectAfterOAuth(req, "graph_api_error", verdict.returnTo);
    }
    return redirectAfterOAuth(req, "profile_failed", verdict.returnTo);
  }

  // ── Reconnect identity gate (Codex #5) ──────────────────────────────────────
  // A Reconnect names the row it is repairing; that id rode here inside the sealed
  // OAuth state. If a DIFFERENT Facebook user just authorized, NOTHING may be
  // written — not the token, not a new row. Before this, the store fell back to
  // identity matching, found no row for the new account and INSERTED one: a slot
  // spent on an account the merchant never meant to add, while the account they
  // were repairing stayed disconnected, with nothing on screen saying so.
  //
  // Placed BEFORE the missing-scopes branch on purpose — that branch writes too, so
  // checking after it would still persist a mismatched authorization.
  let reconnectTargetId: string | null = null;
  if (verdict.reconnectConnectionId) {
    let target;
    try {
      target = await getFacebookReconnectTarget(uid, verdict.reconnectConnectionId);
    } catch (readErr) {
      // Reading the merchant's own row failed. Writing blind is exactly the
      // overwrite this gate exists to prevent, so refuse.
      console.error("[Facebook OAuth Callback] reconnect target read failed:", (readErr as Error).message);
      return redirectAfterOAuth(req, "persist_failed", verdict.returnTo);
    }
    const decision = decideReconnect({
      reconnectTargetId: verdict.reconnectConnectionId,
      target,
      authorizedAccountId: fbUser.id,
      authorizedLabel: fbUser.name,
    });
    if (decision.action === "reject") {
      fbDebug(`account_mismatch — nothing written (expected=${decision.expectedLabel ?? "?"})`);
      return redirectAfterOAuth(req, "account_mismatch", verdict.returnTo, {
        expected: decision.expectedLabel,
        got: decision.gotLabel,
        // The row the merchant was repairing, so "Sign in to the original" can
        // retry THAT row (Codex #3). Connect is a full-page navigation, so the
        // panel's React state is gone by the time this lands; without the id the
        // banner fell back to accounts[0] and sent someone repairing their SECOND
        // account into repairing their first. Safe to hand back: it is the user's
        // own connection id, just read and compared above, and the panel re-checks
        // it against the live list before using it.
        target: verdict.reconnectConnectionId,
      });
    }
    // Names the row every upsert below must land on. Load-bearing for a target row
    // that never recorded a facebookUserId: the store's identity rule only adopts a
    // LONE unidentified row, so a merchant with two Facebook rows would otherwise
    // get a duplicate insert instead of the repair they asked for.
    reconnectTargetId = decision.targetConnectionId;
  }

  const missing = missingRequiredScopes(grantedScopes);
  if (missing.length > 0) {
    fbDebug(
      `reconnect_required — missing_scopes=[${missing.join(", ")}]`,
      `granted=[${grantedScopes.join(", ")}]`,
      `fb_user=${fbUser.id}`,
    );
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
      }, reconnectTargetId);
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
    if (err instanceof FacebookApiError) {
      // Graph itself errored — do NOT tell the user they have no Pages.
      fbDebug(`page discovery FAILED status=${err.status} code=${err.code}`);
      return redirectAfterOAuth(req, "graph_api_error", verdict.returnTo);
    }
    return redirectAfterOAuth(req, "discovery_failed", verdict.returnTo);
  }

  fbDebug(
    `accounts_count=${pages.length}`,
    `permissions=[${grantedScopes.join(", ")}]`,
    `fb_user=${fbUser.id}`,
  );

  if (pages.length === 0) {
    // Reaching here means Graph SUCCEEDED, all required scopes are granted, and
    // `data` was genuinely empty — the only case that legitimately means "no Page".
    //
    // Development-only: probe one known Page id (FACEBOOK_DEBUG_PAGE_ID env, never
    // hard-coded) with the SAME user token to tell "user truly administers nothing"
    // apart from "the Page is reachable but Meta omitted it from /me/accounts". The
    // probe only writes debug logs — it never influences the outcome below.
    await debugProbePageById(tokens.accessToken);

    // An empty enumeration is NOT "you administer no Pages". Meta omits Pages the
    // user reaches through a Business portfolio rather than a direct personal
    // role, so the Page can be perfectly reachable by id.
    //
    // RECONNECT AUTO-RESTORE: if this user previously had a Page selected, verify
    // that saved id with the FRESH user token (never the old stored Page token).
    // Success → the connection comes back fully connected with zero typing.
    // Failure → fall through to manual entry, PRESERVING the saved Page id
    // (lastKnownPage) so nothing is wiped. A first-time connect has no saved id
    // and never reaches the restore path — we never guess.
    let previous: { pageId: string; pageName: string | null } | null = null;
    try {
      // Scoped to THIS Facebook user: with two Facebook accounts connected, an
      // unscoped read would restore the other account's Page — one this user may
      // not even administer. Mid-callback the row may not exist yet, so the
      // Facebook user id (not a connection id) is the only identity available.
      previous = await getStoredFacebookSelection(uid, { facebookUserId: fbUser.id });
    } catch {
      previous = null; // storage hiccup → behave like a first connect
    }

    if (previous) {
      const restored = await restorePreviousPage(tokens.accessToken, previous.pageId);
      fbDebug(
        `reconnect auto-restore attempted page=${previous.pageId}`,
        `outcome=${restored ? "restored" : "verification_failed"}`,
      );
      if (restored) {
        try {
          await upsertFacebookConnection(uid, {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.accessTokenExpiresAt,
            scopes: grantedScopes,
            accountId: fbUser.id,
            accountName: fbUser.name,
            state: "connected",
            pages: [restored],
            selected: { pageId: restored.pageId, pageName: restored.pageName },
          }, reconnectTargetId);
        } catch (persistErr) {
          console.error(
            "[Facebook OAuth Callback] persist (auto-restore) failed:",
            (persistErr as Error).message,
          );
          return redirectAfterOAuth(req, "persist_failed", verdict.returnTo);
        }
        return redirectAfterOAuth(req, "reconnected", verdict.returnTo);
      }

      // Verification failed: keep the fresh authorization, clear the (now
      // unverifiable) selection, but carry the old Page id forward untouched.
      try {
        await upsertFacebookConnection(uid, {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.accessTokenExpiresAt,
          scopes: grantedScopes,
          accountId: fbUser.id,
          accountName: fbUser.name,
          state: "page_discovery_empty",
          pages: [],
          selected: null,
          lastKnownPage: previous,
        }, reconnectTargetId);
      } catch (persistErr) {
        console.error(
          "[Facebook OAuth Callback] persist (restore-failed) failed:",
          (persistErr as Error).message,
        );
        return redirectAfterOAuth(req, "persist_failed", verdict.returnTo);
      }
      return redirectAfterOAuth(req, "page_reconnect_verification_failed", verdict.returnTo);
    }

    // First-time connect with an empty enumeration: keep the authorization
    // (user token + granted scopes) and let the user name the Page manually via
    // POST /api/integrations/facebook/connect-page. We never guess an id here.
    try {
      await upsertFacebookConnection(uid, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.accessTokenExpiresAt,
        scopes: grantedScopes,
        accountId: fbUser.id,
        accountName: fbUser.name,
        state: "page_discovery_empty",
        pages: [],
        selected: null,
      }, reconnectTargetId);
    } catch (persistErr) {
      // A plan ceiling is a user-actionable outcome, not a failure to report as
      // broken storage — surface it distinctly so the UI can offer disconnect/upgrade.
      if (persistErr instanceof ConnectionLimitError) {
        return redirectAfterOAuth(req, "account_limit", verdict.returnTo);
      }
      console.error("[Facebook OAuth Callback] persist (no-pages) failed:", (persistErr as Error).message);
      return redirectAfterOAuth(req, "persist_failed", verdict.returnTo);
    }
    return redirectAfterOAuth(req, "page_discovery_empty", verdict.returnTo);
  }

  // Exactly one Page → select it (nothing to choose). Several → store all as
  // candidates and DO NOT auto-pick index 0; the user selects one later.
  const single = pages.length === 1 ? pages[0] : null;

  // Reconnect with several Pages listed: if one of them is the Page this user
  // already had, re-select it instead of making them choose again. This is a
  // RESTORE of a prior explicit choice, not an auto-pick — with no prior choice
  // the picker still appears and index 0 is never assumed.
  let restoredChoice: ManagedPage | null = null;
  if (!single) {
    try {
      // Same scoping as the page_discovery_empty path above: restore only the
      // Page THIS Facebook user previously chose.
      const previous = await getStoredFacebookSelection(uid, { facebookUserId: fbUser.id });
      if (previous) {
        restoredChoice = pages.find(p => p.pageId === previous.pageId) ?? null;
        if (restoredChoice) {
          fbDebug(`reconnect restored prior Page from ${pages.length} candidates page=${restoredChoice.pageId}`);
        }
      }
    } catch {
      restoredChoice = null; // storage hiccup → fall through to the picker
    }
  }

  const chosen = single ?? restoredChoice;
  const selected = chosen ? { pageId: chosen.pageId, pageName: chosen.pageName } : null;

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
      state: chosen ? "connected" : "page_selection_required",
      pages,
      selected,
    }, reconnectTargetId);
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
