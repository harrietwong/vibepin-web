/**
 * Centralized Shopify OAuth + Admin API configuration (server-only, WP2).
 *
 * Reads credentials from the Next.js server environment (web/.env.local):
 *   SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_REDIRECT_URI,
 *   SHOPIFY_API_VERSION, SHOPIFY_SCOPES, SHOPIFY_APP_URL, SHOPIFY_TOKEN_ENCRYPTION_KEY
 *
 * Mirrors web/src/lib/server/pinterest/config.ts. Secrets are never logged or
 * echoed into responses — routes read the boolean helpers and re-throw safe
 * messages.
 */

/** Requested scopes are intersected with this hard safe default (read-only). */
const SAFE_SCOPES = ["read_products"] as const;

/** Default Admin API version if SHOPIFY_API_VERSION is unset. */
const DEFAULT_API_VERSION = "2026-07";

/** Canonical dark-app route for Shopify OAuth return + settings tab. */
export const SHOPIFY_SETTINGS_PATH = "/app/settings/shopify";

/** Shop domain shape: `store.myshopify.com` (lowercase). */
const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export type ShopifyEnv = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  apiVersion: string;
};

/** Admin API version (env override, else the pinned default). */
export function getShopifyApiVersion(): string {
  return process.env.SHOPIFY_API_VERSION?.trim() || DEFAULT_API_VERSION;
}

/** Public app URL used to build webhook callback URLs (trailing slashes trimmed). */
export function getShopifyAppUrl(): string {
  return (process.env.SHOPIFY_APP_URL?.trim() || "").replace(/\/+$/, "");
}

/** Client secret used for HMAC verification (empty string when unset — verify fails closed). */
export function shopifyClientSecret(): string {
  return process.env.SHOPIFY_CLIENT_SECRET?.trim() ?? "";
}

/**
 * Resolve OAuth credentials. Throws a clear (secret-free) error if any are
 * missing so routes can map it to a 500 config_error.
 */
export function getShopifyEnv(): ShopifyEnv {
  const clientId = process.env.SHOPIFY_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim() ?? "";
  const redirectUri = process.env.SHOPIFY_REDIRECT_URI?.trim() ?? "";

  const missing: string[] = [];
  if (!clientId) missing.push("SHOPIFY_CLIENT_ID");
  if (!clientSecret) missing.push("SHOPIFY_CLIENT_SECRET");
  if (!redirectUri) missing.push("SHOPIFY_REDIRECT_URI");
  if (missing.length) {
    throw new Error(`Missing Shopify env: ${missing.join(", ")}`);
  }

  return { clientId, clientSecret, redirectUri, apiVersion: getShopifyApiVersion() };
}

/**
 * True when OAuth env vars AND a token-encryption key are present. The key is
 * required to seal the state cookie and to encrypt the access token at rest, so
 * connect must fail with config_error without it.
 */
export function isShopifyConfigured(): boolean {
  try {
    getShopifyEnv();
  } catch {
    return false;
  }
  return Boolean(process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY?.trim());
}

/**
 * Normalize a user-supplied shop value to a bare host: trim + lowercase, strip
 * the URL scheme, and drop anything after the first path separator. Used both
 * for validation and for the canonical stored shop_domain.
 */
export function normalizeShopInput(input: string | null | undefined): string {
  let s = (input ?? "").trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/\/.*$/, "");
  return s;
}

/** True only when the normalized input is a well-formed `*.myshopify.com` host. */
export function isValidShopDomain(input: string | null | undefined): boolean {
  return SHOP_DOMAIN_RE.test(normalizeShopInput(input));
}

/**
 * Effective scope string: SHOPIFY_SCOPES intersected with the safe default set.
 * Anything not in SAFE_SCOPES is dropped; an empty result falls back to the
 * safe default so we never request more than read-only product access.
 */
export function resolveScopes(): string {
  const configured = (process.env.SHOPIFY_SCOPES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const safe = configured.filter((s) => (SAFE_SCOPES as readonly string[]).includes(s));
  return (safe.length ? safe : (SAFE_SCOPES as readonly string[])).join(",");
}

/**
 * Build the Shopify authorization URL for a normalized shop + opaque state.
 * redirect_uri is the exact registered SHOPIFY_REDIRECT_URI.
 */
export function buildAuthorizeUrl(shop: string, state: string): string {
  const env = getShopifyEnv();
  const host = normalizeShopInput(shop);
  const params = new URLSearchParams({
    client_id: env.clientId,
    scope: resolveScopes(),
    redirect_uri: env.redirectUri,
    state,
  });
  return `https://${host}/admin/oauth/authorize?${params.toString()}`;
}
