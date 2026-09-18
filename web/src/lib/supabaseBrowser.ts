"use client";

/**
 * ONE shared Supabase browser client + ONE shared single-flight token refresh for
 * every internal API helper that attaches `Authorization: Bearer <access token>`
 * (currently pinterestClient.ts and socialClient.ts).
 *
 * Why this exists — the multi-client token-rotation race:
 * On the Pin edit modal open we fire ~4 authed requests at once (the drawer's
 * status + boards, and PublishDestinations' status + social connections). These used
 * to run against TWO separate `createBrowserClient()` instances (one per helper
 * module), each with its OWN refresh logic. Right after an OAuth-return full reload
 * the stored access token is expired, so multiple modules each called
 * `auth.refreshSession()` concurrently. Supabase refresh tokens are one-time-use and
 * ROTATE: whichever refresh hits the server first consumes the token; the others get
 * "Invalid Refresh Token: Already Used" and fall back to the stale expired access
 * token — which the server then rejects with 401. That surfaced as "status succeeds
 * but boards/connections 401 right after connecting".
 *
 * Routing every helper through this single client instance and this single in-flight
 * refresh promise makes the race structurally impossible: no matter how many callers
 * ask at once, exactly one network refresh happens and everyone shares its result.
 */

import { createBrowserClient } from "@supabase/ssr";

let _client: ReturnType<typeof createBrowserClient> | null = null;

export function supabaseBrowser() {
  if (_client) return _client;
  _client = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  return _client;
}

type BrowserSessionSnapshot = {
  accessToken: string;
  ownerUserId: string | null;
  expiresAt: number | null;
};

export type BrowserSessionIdentity = {
  accessToken: string;
  ownerUserId: string;
};

let refreshInFlight: Promise<BrowserSessionSnapshot | null> | null = null;

function sessionSnapshot(session: {
  access_token?: unknown;
  expires_at?: unknown;
  user?: { id?: unknown } | null;
} | null | undefined): BrowserSessionSnapshot | null {
  const accessToken = typeof session?.access_token === "string" && session.access_token
    ? session.access_token
    : null;
  if (!accessToken) return null;
  return {
    accessToken,
    ownerUserId: typeof session?.user?.id === "string" && session.user.id.trim()
      ? session.user.id
      : null,
    expiresAt: typeof session?.expires_at === "number" ? session.expires_at : null,
  };
}

function verifiedIdentity(snapshot: BrowserSessionSnapshot | null): BrowserSessionIdentity | null {
  return snapshot?.ownerUserId
    ? { accessToken: snapshot.accessToken, ownerUserId: snapshot.ownerUserId }
    : null;
}

// A refresh must never hang a caller indefinitely. supabase-js serializes token
// refreshes across ALL browser-client instances via a `navigator.locks` lock; if some
// other client instance is holding that lock on a slow/stalled refresh (high-latency
// region, proxy/VPN), our refreshSession() would wait behind it — which showed up as
// a board load that hung for the full 8s timeout instead of surfacing its real error.
// Capping the wait lets callers fall back to the token they already have and fail fast
// with the actual server response.
const REFRESH_TIMEOUT_MS = 3000;

/** Refresh the Supabase session at most once concurrently; all callers share the result. */
function refreshSessionSnapshotOnce(): Promise<BrowserSessionSnapshot | null> {
  if (refreshInFlight) return refreshInFlight;
  const run = async (): Promise<BrowserSessionSnapshot | null> => {
    try {
      const result = await Promise.race([
        supabaseBrowser().auth.refreshSession(),
        new Promise<null>(resolve => setTimeout(() => resolve(null), REFRESH_TIMEOUT_MS)),
      ]);
      return sessionSnapshot(result?.data?.session);
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  };
  refreshInFlight = run();
  return refreshInFlight;
}

export async function refreshSessionOnce(): Promise<string | null> {
  return (await refreshSessionSnapshotOnce())?.accessToken ?? null;
}

/** The current browser session only when it carries a verifiable owner binding. */
export async function currentSessionIdentity(): Promise<BrowserSessionIdentity | null> {
  const { data: { session } } = await supabaseBrowser().auth.getSession();
  return verifiedIdentity(sessionSnapshot(session));
}

/** A shared refreshed session only when the returned token carries an owner binding. */
export async function refreshSessionIdentityOnce(): Promise<BrowserSessionIdentity | null> {
  return verifiedIdentity(await refreshSessionSnapshotOnce());
}

/** A non-expired session token and the owner that Supabase returned with that token. */
export async function freshSessionIdentity(): Promise<BrowserSessionIdentity | null> {
  const { data: { session } } = await supabaseBrowser().auth.getSession();
  const snapshot = sessionSnapshot(session);
  const nowSec = Math.floor(Date.now() / 1000);
  const expired = !snapshot || (snapshot.expiresAt != null && snapshot.expiresAt <= nowSec + 5);
  if (!expired) return verifiedIdentity(snapshot);
  return verifiedIdentity(await refreshSessionSnapshotOnce()) ?? verifiedIdentity(snapshot);
}

/**
 * A NON-expired Supabase access token, refreshing first when needed.
 *
 * `getSession()` returns the stored session WITHOUT a synchronous refresh, so right
 * after a full page reload the stored access token can already be past expiry — the
 * server would then reject it with 401. Refreshing up-front (via the shared
 * single-flight) makes the very first post-reload API call authed.
 */
export async function freshAccessToken(): Promise<string | null> {
  const { data: { session } } = await supabaseBrowser().auth.getSession();
  const snapshot = sessionSnapshot(session);
  const nowSec = Math.floor(Date.now() / 1000);
  const expired = !snapshot || (snapshot.expiresAt != null && snapshot.expiresAt <= nowSec + 5);
  if (!expired) return snapshot.accessToken;
  const refreshed = await refreshSessionSnapshotOnce();
  // Refresh failed (offline / no refresh token) — fall back to whatever we have so a
  // still-valid-but-near-expiry token isn't discarded; the server decides.
  return refreshed?.accessToken ?? snapshot?.accessToken ?? null;
}
