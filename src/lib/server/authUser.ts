/**
 * Server-side helpers to resolve the authenticated VibePin user inside route
 * handlers. Two entry points matching the two existing repo conventions:
 *
 *   getUserIdFromBearer(req) — JSON API routes called via fetch() from the client
 *     with `Authorization: Bearer <supabase access token>` (matches
 *     /api/composer-drafts and /api/publish-jobs).
 *
 *   getUserIdFromCookies()  — browser-navigation routes (OAuth connect/callback)
 *     that can only carry the Supabase SSR session cookies (matches
 *     /auth/callback/route.ts).
 */

import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// ── Verified-bearer cache ─────────────────────────────────────────────────────
// `auth.getUser(token)` is a network round trip to Supabase Auth (~1.5–2s from
// high-latency regions) and sits on the critical path of every Bearer-authed API
// request (disconnect, publish, social). Cache the uid of a token we already
// verified, briefly. Only SUCCESSFUL verifications are cached; the TTL is far
// below token lifetime, so the revocation-visibility window this adds (≤60s,
// same process only) mirrors the connection-row cache tradeoff. The raw token is
// the map key — the same bytes already transit memory on every uncached request.
const VERIFIED_TOKEN_TTL_MS = 60_000;
const VERIFIED_TOKEN_MAX_ENTRIES = 500;
const verifiedTokens = new Map<string, { at: number; uid: string }>();

/** Verify an access token against Supabase Auth, with the short cache above. */
async function verifyAccessToken(token: string): Promise<string | null> {
  const hit = verifiedTokens.get(token);
  if (hit && Date.now() - hit.at < VERIFIED_TOKEN_TTL_MS) return hit.uid;

  const anon = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  const { data: { user }, error } = await anon.auth.getUser(token);
  if (error || !user) return null;
  if (verifiedTokens.size >= VERIFIED_TOKEN_MAX_ENTRIES) verifiedTokens.clear();
  verifiedTokens.set(token, { at: Date.now(), uid: user.id });
  return user.id;
}

/** Resolve user id from an `Authorization: Bearer <token>` header. */
export async function getUserIdFromBearer(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!token) return null;
  return verifyAccessToken(token);
}

/** Resolve user id from the Supabase SSR cookie session (browser navigation). */
export async function getUserIdFromCookies(): Promise<string | null> {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            /* Route handlers may be read-only in some contexts — best-effort refresh */
          }
        },
      },
    },
  );
  // Same verification result as `auth.getUser()` (network round trip to Supabase
  // Auth), but through the shared verified-token cache: getSession() reads (and
  // if needed refreshes) the cookie session locally, then the session's access
  // token is verified against the Auth server once per TTL instead of on every
  // request. Cookie-authed writes (publish, OAuth callback) stay fully verified.
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return null;
  return verifyAccessToken(token);
}

/** Resolve user id from Bearer first, then fall back to verified SSR cookies. */
export async function getUserIdFromBearerOrCookies(req: Request): Promise<string | null> {
  return (await getUserIdFromBearer(req)) ?? (await getUserIdFromCookies());
}

/**
 * Resolve user id from the local Supabase SSR cookie session without the network
 * verification round trip. Use only for pre-navigation guards where a later step
 * still verifies the user before privileged writes.
 */
export async function getUserIdFromCookieSession(): Promise<string | null> {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            /* Route handlers may be read-only in some contexts. */
          }
        },
      },
    },
  );
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user?.id ?? null;
}

/**
 * Resolve user id for same-origin browser APIs. Prefer the cookie session so
 * post-OAuth GETs do not wait on a client-side Supabase token refresh or a
 * server-side bearer verification round trip.
 */
export async function getUserIdFromSameOriginSession(req: Request): Promise<string | null> {
  return (await getUserIdFromCookieSession()) ?? (await getUserIdFromBearer(req));
}
