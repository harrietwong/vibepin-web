/**
 * Short-lived, single-use OAuth state, sealed into an HttpOnly cookie.
 *
 * The opaque `state` token sent to Pinterest is random and contains no user data.
 * The cookie separately binds that state to the authenticated VibePin user and an
 * expiry, encrypted (AES-256-GCM) so the browser cannot read or forge it.
 *
 * Flow:
 *   connect()  → generate state, set cookie = seal({ state, uid, exp })
 *   callback() → read cookie, verify state param matches, uid matches session,
 *                not expired, then CLEAR the cookie (single use).
 */

import { randomBytes } from "node:crypto";
import { sealJson, unsealJson, safeEqual } from "../crypto";

export const OAUTH_STATE_COOKIE = "pinterest_oauth_state";
// A SEPARATE, plain (unsealed) cookie holding just the returnTo path. The sealed
// state cookie is the security boundary; this one exists only so that when state
// validation FAILS (stale/expired state, a cookie the proxy mangled, etc.) the
// callback can still send the user back to where they started (the exact Plan Pin)
// to retry, instead of dumping them on the generic Settings page. It carries no
// secret — returnTo is validated same-origin `/app/*` before it is ever written or
// read, so trusting it purely for a redirect target is safe.
export const OAUTH_RETURN_COOKIE = "pinterest_oauth_return";
export const STATE_TTL_MS = 10 * 60 * 1000; // ~10 minutes

/** Same-origin `/app/*` guard for a returnTo path read back from a cookie/param. */
export function safeReturnTo(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded.startsWith("/app/")) return undefined;
    if (decoded.startsWith("//") || decoded.includes("://")) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

/** Options for the plain returnTo cookie (lax + httpOnly; secure off on localhost). */
export function returnCookieOptions(isSecure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isSecure,
    path: "/",
    maxAge: Math.floor(STATE_TTL_MS / 1000),
  };
}

export type SealedState = {
  state: string;
  uid: string;
  exp: number; // epoch ms
  returnTo?: string;
};

export function generateState(): string {
  return randomBytes(32).toString("base64url");
}

export function sealState(state: string, uid: string, returnTo?: string): string {
  const payload: SealedState = {
    state,
    uid,
    exp: Date.now() + STATE_TTL_MS,
    ...(returnTo ? { returnTo } : {}),
  };
  return sealJson(payload);
}

export type StateVerdict =
  | { ok: true; uid: string; returnTo?: string }
  | { ok: false; reason: "missing" | "expired" | "mismatch" | "user_mismatch" };

/**
 * Verify the state param returned by Pinterest against the sealed cookie and the
 * current session user. Pure — the route is responsible for clearing the cookie.
 */
export function verifyState(
  cookieValue: string | undefined,
  stateParam: string | undefined,
  sessionUid: string,
): StateVerdict {
  const sealed = unsealJson<SealedState>(cookieValue);
  if (!sealed || !stateParam) return { ok: false, reason: "missing" };
  if (Date.now() > sealed.exp) return { ok: false, reason: "expired" };
  if (!safeEqual(sealed.state, stateParam)) return { ok: false, reason: "mismatch" };
  if (!safeEqual(sealed.uid, sessionUid)) return { ok: false, reason: "user_mismatch" };
  return { ok: true, uid: sealed.uid, returnTo: sealed.returnTo };
}

/**
 * Recover the sealed `returnTo` for the NON-success paths (user cancelled / error /
 * missing code), where we don't have (or need) the session uid to persist tokens —
 * we only need a safe page to send the user back to.
 *
 * Safe by construction: `returnTo` was validated same-origin `/app/*` at seal time,
 * and here we additionally require the returned `state` param to match the sealed
 * state (defense in depth against a forged error redirect steering the return path).
 * Returns undefined when there's no usable, matching returnTo.
 */
export function readSealedReturnTo(
  cookieValue: string | undefined,
  stateParam: string | undefined,
): string | undefined {
  const sealed = unsealJson<SealedState>(cookieValue);
  if (!sealed || !sealed.returnTo) return undefined;
  if (Date.now() > sealed.exp) return undefined;
  // Only honour the sealed returnTo when the state round-tripped intact.
  if (!stateParam || !safeEqual(sealed.state, stateParam)) return undefined;
  return sealed.returnTo;
}

/** Cookie options for the sealed state (lax + httpOnly; secure off on localhost). */
export function stateCookieOptions(isSecure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isSecure,
    path: "/",
    maxAge: Math.floor(STATE_TTL_MS / 1000),
  };
}
