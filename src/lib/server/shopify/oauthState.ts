/**
 * Short-lived, single-use Shopify OAuth state, sealed into an HttpOnly cookie
 * (server-only, WP2). Mirrors web/src/lib/server/pinterest/oauthState.ts.
 *
 * The opaque `state` token sent to Shopify is random and carries no user data.
 * The cookie separately binds that state to the authenticated VibePin user, the
 * target shop domain, and an expiry — encrypted (AES-256-GCM via the Shopify
 * token cipher) so the browser cannot read or forge it.
 *
 * Flow:
 *   connect()  → generate state, set cookie = seal({ state, uid, shopDomain, exp, returnTo })
 *   callback() → read cookie, verify state matches, uid matches session, shop
 *                matches, not expired, then CLEAR the cookie (single use).
 */

import { randomBytes } from "node:crypto";
import { safeEqual } from "../crypto";
import { shopifyTokenCipher } from "./connectionStore";
import { normalizeShopInput } from "./config";

export const SHOPIFY_OAUTH_STATE_COOKIE = "shopify_oauth_state";
export const SHOPIFY_STATE_TTL_MS = 10 * 60 * 1000; // ~10 minutes

/** Same-origin `/app/*` guard for a returnTo path (never trust cross-origin). */
export function safeShopifyReturnTo(value: string | null | undefined): string | undefined {
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

export type ShopifySealedState = {
  state: string;
  uid: string;
  shopDomain: string;
  exp: number; // epoch ms
  returnTo?: string;
};

export function generateShopifyState(): string {
  return randomBytes(32).toString("base64url");
}

/** Seal { state, uid, shopDomain, exp, returnTo } into the encrypted cookie value. */
export function sealShopifyState(
  state: string,
  uid: string,
  shopDomain: string,
  returnTo?: string | null,
): string {
  const rt = safeShopifyReturnTo(returnTo);
  const payload: ShopifySealedState = {
    state,
    uid,
    shopDomain: normalizeShopInput(shopDomain),
    exp: Date.now() + SHOPIFY_STATE_TTL_MS,
    ...(rt ? { returnTo: rt } : {}),
  };
  return shopifyTokenCipher.sealJson(payload);
}

export type ShopifyStateVerdict =
  | { ok: true; uid: string; shopDomain: string; returnTo?: string }
  | { ok: false; reason: "missing" | "expired" | "mismatch" | "user_mismatch" | "shop_mismatch" };

/**
 * Verify the state param + shop param returned by Shopify against the sealed
 * cookie and the current session user. Pure — the route clears the cookie.
 */
export function verifyShopifyState(
  cookieValue: string | undefined,
  stateParam: string | undefined,
  sessionUid: string,
  shopParam: string | undefined,
): ShopifyStateVerdict {
  const sealed = shopifyTokenCipher.unsealJson<ShopifySealedState>(cookieValue);
  if (!sealed || !stateParam) return { ok: false, reason: "missing" };
  if (Date.now() > sealed.exp) return { ok: false, reason: "expired" };
  if (!safeEqual(sealed.state, stateParam)) return { ok: false, reason: "mismatch" };
  if (!safeEqual(sealed.uid, sessionUid)) return { ok: false, reason: "user_mismatch" };
  if (!safeEqual(sealed.shopDomain, normalizeShopInput(shopParam ?? ""))) {
    return { ok: false, reason: "shop_mismatch" };
  }
  return { ok: true, uid: sealed.uid, shopDomain: sealed.shopDomain, returnTo: sealed.returnTo };
}

/** Cookie options for the sealed state (lax + httpOnly; secure off on localhost). */
export function shopifyStateCookieOptions(isSecure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isSecure,
    path: "/",
    maxAge: Math.floor(SHOPIFY_STATE_TTL_MS / 1000),
  };
}
