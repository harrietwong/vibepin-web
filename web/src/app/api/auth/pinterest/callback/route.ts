/**
 * GET /api/auth/pinterest/callback
 *
 * Exact registered redirect URI. Pinterest sends the browser here with `code` and
 * `state`. This route does ONLY the work required to mark the connection
 * "connected" before redirecting:
 *   1. Handles Pinterest authorization errors (user denied, etc.).
 *   2. Verifies `state` against the sealed cookie AND the current session user.
 *   3. Clears the state cookie (single use) regardless of outcome.
 *   4. Exchanges the code for tokens server-side (Basic auth) — required, not skippable.
 *   5. Reads WHICH Pinterest account authorized, and decides whether this is a new
 *      account, a reconnect of an existing one, or an account mismatch to refuse.
 *   6. Encrypts + persists the tokens onto the decided connection (never another).
 *   7. Redirects back to returnTo (or the dark Integrations page) with a status flag.
 *
 * Step 5 is not optional (PRD §9.2 / §10). It used to be skipped for latency — the
 * callback wrote tokens with NULL account fields and let a background sync-account
 * call fill the identity in afterwards. That saved one API round trip and cost
 * correctness: with a user-keyed upsert and no identity check, authorizing a SECOND
 * Pinterest account silently overwrote the first one's tokens. The user's Pins kept
 * publishing — to the wrong account, with no error anywhere. One extra round trip
 * here is the price of never doing that again.
 *
 * Board sync, publish-permission validation, and other account enrichment still
 * happen lazily on demand elsewhere (e.g. the publish drawer), never here.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getUserIdFromCookies } from "@/lib/server/authUser";
import { PINTEREST_INTEGRATIONS_PATH } from "@/lib/pinterestPaths";
import { OAUTH_STATE_COOKIE, OAUTH_RETURN_COOKIE, verifyState, readSealedReturnTo, safeReturnTo } from "@/lib/server/pinterest/oauthState";
import { exchangeCodeForTokens, fetchAccountIdentity } from "@/lib/server/pinterest/service";
import { upsertConnection, listConnections } from "@/lib/server/pinterest/connectionStore";
import { decideConnect, type AuthorizedAccount, type ExistingConnection } from "@/lib/server/pinterest/connectDecision";
import { evaluateAccountQuota } from "@/lib/server/pinterest/accountQuota";
import { resolvePlan } from "@/lib/server/entitlements";

export const dynamic = "force-dynamic";

const SLOW_STEP_MS = 500;
const SLOW_TOTAL_MS = 2000;
const DEV = process.env.NODE_ENV !== "production";

/** Dev-only, secret-free step log: durations, booleans, status — never tokens/code/secrets. */
function devLog(step: string, fields: Record<string, unknown> = {}): void {
  if (!DEV) return;
  console.log(`[Pinterest OAuth Callback] ${step}`, fields);
}

/** Server-Timing header (dev/staging only) so the callback's latency breakdown is visible in Network. */
function withServerTiming(res: NextResponse, marks: Record<string, number>): NextResponse {
  if (DEV) {
    res.headers.set(
      "Server-Timing",
      Object.entries(marks).map(([name, dur]) => `${name};dur=${dur.toFixed(1)}`).join(", "),
    );
  }
  return res;
}

/** Warn (dev-only) on any step over SLOW_STEP_MS, and on a slow total over SLOW_TOTAL_MS. */
function warnOnSlowSteps(marks: Record<string, number>): void {
  if (!DEV) return;
  for (const [name, dur] of Object.entries(marks)) {
    if (name === "total") continue;
    if (dur > SLOW_STEP_MS) {
      console.warn(`[Pinterest OAuth Callback] Slow step: ${name} ${dur.toFixed(0)}ms`);
    }
  }
  if (marks.total > SLOW_TOTAL_MS) {
    console.warn(`[Pinterest OAuth Callback] Slow callback total ${marks.total.toFixed(0)}ms`);
  }
}

function redirectAfterOAuth(req: NextRequest, status: string, returnTo = PINTEREST_INTEGRATIONS_PATH): NextResponse {
  const url = req.nextUrl.clone();
  const target = new URL(returnTo, req.nextUrl.origin);
  url.pathname = target.pathname;
  url.search = target.search;
  url.hash = target.hash;
  url.searchParams.set("pinterest", status);
  const res = NextResponse.redirect(url);
  // Both OAuth cookies are single-use — clear on every outcome.
  res.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
  res.cookies.set(OAUTH_RETURN_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}

export async function GET(req: NextRequest) {
  const t0 = performance.now();
  const marks: Record<string, number> = {};
  devLog("callback received");

  const params = req.nextUrl.searchParams;
  const code = params.get("code") ?? undefined;
  const stateParam = params.get("state") ?? undefined;
  const oauthError = params.get("error");
  const cookieValue = req.cookies.get(OAUTH_STATE_COOKIE)?.value;
  // Plain returnTo fallback: used ONLY to pick the redirect target when the sealed
  // state can't be trusted (state mismatch/expired), so a failed attempt still lands
  // the user back on the origin Pin to retry instead of on Settings.
  const returnFallback = safeReturnTo(req.cookies.get(OAUTH_RETURN_COOKIE)?.value);

  /** Finish: stamp total, log, warn on slow steps, attach Server-Timing, return. */
  function finish(res: NextResponse): NextResponse {
    marks.total = performance.now() - t0;
    warnOnSlowSteps(marks);
    return withServerTiming(res, marks);
  }

  // ── Cancel / error branch ───────────────────────────────────────────────────
  // Pinterest redirected back with an error (user cancelled, denied, etc.) — NEVER
  // exchange a code, fetch a profile, or call sync-account here. Recover the sealed
  // returnTo so the user lands back where they started (e.g. the exact Pin in Weekly
  // Plan), not the generic Settings page. `access_denied` = user cancelled.
  if (oauthError) {
    const status = oauthError === "access_denied" ? "cancelled" : "error";
    const returnTo = readSealedReturnTo(cookieValue, stateParam) ?? returnFallback;
    devLog(`${status} branch`, { returnToRecovered: !!returnTo });
    return finish(redirectAfterOAuth(req, status, returnTo));
  }

  // Kick off the token exchange NOW: it only needs `code`, so its Pinterest round
  // trip can overlap the ~equally-slow session verification below instead of
  // running after it. Safe to start before state validation because nothing is
  // persisted unless BOTH state and session checks pass — on any early return the
  // settled promise is discarded (the orphan catch keeps it handled).
  const tExchange = performance.now();
  const exchangePromise = code
    ? exchangeCodeForTokens(code).then((tokens) => {
        marks.codeExchange = performance.now() - tExchange;
        return tokens;
      })
    : null;
  exchangePromise?.catch(() => {});

  const tAuth = performance.now();
  const uid = await getUserIdFromCookies();
  marks.auth = performance.now() - tAuth;
  devLog("session resolved", { userIdPresent: !!uid, durationMs: marks.auth.toFixed(1) });
  if (!uid) {
    // Session lost during the round trip — recover returnTo so we still land on the
    // right page rather than defaulting to Settings.
    return finish(redirectAfterOAuth(req, "session_expired", readSealedReturnTo(cookieValue, stateParam) ?? returnFallback));
  }

  const tState = performance.now();
  const verdict = verifyState(cookieValue, stateParam, uid);
  marks.stateValidation = performance.now() - tState;
  devLog("state validation", { ok: verdict.ok, durationMs: marks.stateValidation.toFixed(1) });
  if (!verdict.ok) {
    // On every state-failure path fall back to the plain returnTo cookie so the user
    // returns to the origin Pin (and the drawer reopens for a retry) rather than Settings.
    if (verdict.reason === "expired") return finish(redirectAfterOAuth(req, "state_expired", returnFallback));
    if (verdict.reason === "user_mismatch") return finish(redirectAfterOAuth(req, "session_expired", returnFallback));
    console.error("[Pinterest OAuth Callback] state verify failed:", verdict.reason);
    return finish(redirectAfterOAuth(req, "state_mismatch", returnFallback));
  }

  if (!exchangePromise) {
    // Success-shaped redirect but no code (shouldn't happen) — treat as cancel and
    // return to the original context.
    devLog("cancelled branch", { reason: "missing_code", returnToRecovered: !!verdict.returnTo });
    return finish(redirectAfterOAuth(req, "cancelled", verdict.returnTo));
  }

  devLog("success branch");

  try {
    const tokens = await exchangePromise;
    devLog("token exchange", { durationMs: marks.codeExchange.toFixed(1) });

    // ── Who authorized, and which of this user's rows does that mean? ──────────
    // Identity and the user's existing rows are independent reads — run them
    // together so the added round trip costs max(a,b), not a+b.
    const tIdentity = performance.now();
    let account: AuthorizedAccount;
    let existing: ExistingConnection[];
    // Active = the same predicate listActiveConnections uses (not disconnected AND
    // token-bearing). Derived from the rows we already read, so the quota re-check
    // below costs no extra Pinterest/DB round trip.
    let activeCount = 0;
    try {
      const [identity, rows] = await Promise.all([
        fetchAccountIdentity(tokens.accessToken),
        listConnections(uid),
      ]);
      // A null identity means Pinterest would not tell us who this token belongs to.
      // We do NOT guess: with no id, decideConnect can only match an unidentified row
      // (or create), and a reconnect aimed at an identified row is refused below.
      account = identity ?? { id: null, username: null, accountType: null };
      activeCount = rows.filter(r => !r.disconnected_at && !!r.access_token_encrypted).length;
      existing = rows.map((r): ExistingConnection => ({
        connectionId: r.id,
        accountId: r.pinterest_user_id,
        username: r.pinterest_username,
        disconnected: !!r.disconnected_at,
      }));
    } catch (identityErr) {
      // Reading the user's own rows failed (the identity call never throws). Writing
      // blind is exactly the overwrite this route exists to prevent, so refuse.
      console.error("[Pinterest OAuth Callback] identity/rows read failed:", (identityErr as Error).message);
      return finish(redirectAfterOAuth(req, "persist_failed", verdict.returnTo));
    }
    marks.identity = performance.now() - tIdentity;

    const decision = decideConnect({
      account,
      existing,
      reconnectTargetId: verdict.reconnectConnectionId,
    });
    devLog("connect decision", {
      action: decision.action,
      identityKnown: !!account.id,
      existingCount: existing.length,
      reconnectTargeted: !!verdict.reconnectConnectionId,
      durationMs: marks.identity.toFixed(1),
    });

    // ── Refusal: a reconnect that landed on a different Pinterest account ──────
    // Nothing is written. The panel offers PRD §10's two options; usernames ride in
    // the query so it can name both accounts without another round trip.
    if (decision.action === "reject") {
      const res = redirectAfterOAuth(req, "account_mismatch", verdict.returnTo);
      const url = new URL(res.headers.get("location") ?? "/", req.nextUrl.origin);
      if (decision.expectedUsername) url.searchParams.set("expected", decision.expectedUsername);
      if (decision.gotUsername) url.searchParams.set("got", decision.gotUsername);
      const out = NextResponse.redirect(url);
      out.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
      out.cookies.set(OAUTH_RETURN_COOKIE, "", { path: "/", maxAge: 0 });
      return finish(out);
    }

    // ── Plan gate re-check (PRD §9.2 / §18) ───────────────────────────────────
    // The connect start already checked, but a second flow can consume the last
    // slot while this one is away at Pinterest, so the write side has to be the
    // authority. `decideConnect` stays a pure decision — the quota lives here.
    //
    // Which decisions add an active account:
    //   create                  → +1 active → blocked at the cap.
    //   update && revived       → reviving a DISCONNECTED row. Disconnected rows are
    //                             not counted as used, so bringing one back is also
    //                             +1 active. Blocked, deliberately: allowing it would
    //                             let a capped user hold unlimited accounts by
    //                             disconnecting and re-authorizing in rotation.
    //   update && !revived      → repairing an already-active row → count unchanged →
    //                             always allowed (this is Reconnect).
    // Fails OPEN on an unexpected error: a tokens-in-hand authorization must not be
    // thrown away because an entitlement read hiccuped.
    const addsAnAccount =
      decision.action === "create" || (decision.action === "update" && decision.revived);
    if (addsAnAccount) {
      let overLimit = false;
      try {
        const quota = await evaluateAccountQuota(uid, await resolvePlan(uid), activeCount);
        overLimit = !quota.canAddAccount;
        if (overLimit) {
          console.warn(
            `[Pinterest OAuth Callback] account limit reached (plan=${quota.plan}, used=${quota.used}/${quota.limit}) — nothing written`,
          );
        }
      } catch (quotaErr) {
        console.error("[Pinterest OAuth Callback] quota check failed, allowing:", (quotaErr as Error).message);
      }
      // Nothing is written — same refusal shape as account_mismatch.
      if (overLimit) return finish(redirectAfterOAuth(req, "limit_reached", verdict.returnTo));
    }

    try {
      const tPersist = performance.now();
      await upsertConnection(
        uid,
        {
          pinterestUserId: account.id,
          pinterestUsername: account.username,
          pinterestAccountType: account.accountType,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          accessTokenExpiresAt: tokens.accessTokenExpiresAt,
          refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
          scopes: tokens.scopes,
        },
        // "update" names the exact row to write; "create" passes none so the store
        // matches by account id and inserts when there is no such row.
        decision.action === "update" ? decision.connectionId : undefined,
      );
      marks.tokenPersist = performance.now() - tPersist;
      devLog("token persist", { durationMs: marks.tokenPersist.toFixed(1) });
    } catch (persistErr) {
      console.error("[Pinterest OAuth Callback] persist failed:", (persistErr as Error).message);
      return finish(redirectAfterOAuth(req, "persist_failed", verdict.returnTo));
    }

    devLog("redirect", { returnToPresent: !!verdict.returnTo, totalMs: (performance.now() - t0).toFixed(1) });
    return finish(redirectAfterOAuth(req, "connected", verdict.returnTo));
  } catch (err) {
    const msg = (err as Error).message ?? "unknown";
    console.error("[Pinterest OAuth Callback] token exchange failed:", msg);
    const status = msg.includes("Missing Pinterest env") ? "config_error" : "exchange_failed";
    return finish(redirectAfterOAuth(req, status, verdict.returnTo));
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
