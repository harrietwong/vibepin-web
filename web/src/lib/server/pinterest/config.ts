import { ConfigurationError } from "./errors";

/**
 * Centralized Pinterest OAuth + API configuration (server-only).
 *
 * Reads credentials from the Next.js server environment (web/.env.local):
 *   PINTEREST_APP_ID, PINTEREST_APP_SECRET, PINTEREST_REDIRECT_URI
 *
 * The global `pinterest_access_token` env value is intentionally NOT used — every
 * call uses a per-user OAuth token from the pinterest_connections table.
 */

// Requested scopes — read existing public boards + create public Pins only.
// No ads:*, catalogs:*, or *_secret scopes.
//
// Production requests the MINIMUM needed to publish: read the profile + boards,
// read + write Pins. It deliberately omits boards:write because the product does
// not create or edit Pinterest boards for real users (only the sandbox demo-board
// helper does, and only in the sandbox environment). Sandbox keeps boards:write so
// the demo-board helper can run during the approval flow.
export const PRODUCTION_SCOPES = [
  "user_accounts:read",
  "boards:read",
  "pins:read",
  "pins:write",
] as const;

export const SANDBOX_SCOPES = [
  "user_accounts:read",
  "boards:read",
  "boards:write",
  "pins:read",
  "pins:write",
] as const;

// Back-compat aliases (existing imports). PINTEREST_SCOPES is the production set.
export const PINTEREST_SCOPES = PRODUCTION_SCOPES;
export const PINTEREST_SCOPE_STRING = PRODUCTION_SCOPES.join(",");

// Scopes REQUIRED for a connection to be usable (drives reconnect gating). This is
// the publish-capability floor — boards:write is NOT required (it is not requested
// in production), so an existing production-scope connection is never marked
// needs_reconnect for lacking it.
export const PINTEREST_REQUIRED_SCOPES = [
  "boards:read",
  "pins:read",
  "pins:write",
] as const;

/** Scopes to REQUEST at authorize time for the current environment. */
export function pinterestRequestScopes(): readonly string[] {
  return isPinterestSandboxEnv() ? SANDBOX_SCOPES : PRODUCTION_SCOPES;
}

/** Comma-joined scope string for the current environment's authorize request. */
export function pinterestScopeString(): string {
  return pinterestRequestScopes().join(",");
}

export function missingPinterestScopes(scopes: readonly string[] | null | undefined): string[] {
  const granted = new Set(scopes ?? []);
  return PINTEREST_REQUIRED_SCOPES.filter(scope => !granted.has(scope));
}

export function hasRequiredPinterestScopes(scopes: readonly string[] | null | undefined): boolean {
  return missingPinterestScopes(scopes).length === 0;
}

export type PinterestApiEnv = "production" | "sandbox";
/** @deprecated Use PinterestApiEnv. */
export type PinterestApiMode = PinterestApiEnv;

// Pinterest API (v5).
export const PINTEREST_AUTH_URL = "https://www.pinterest.com/oauth/";
export const PINTEREST_TOKEN_URL = "https://api.pinterest.com/v5/oauth/token";
export const PINTEREST_PRODUCTION_API_BASE = "https://api.pinterest.com/v5";
export const PINTEREST_SANDBOX_API_BASE = "https://api-sandbox.pinterest.com/v5";

/**
 * Which Pinterest environment API calls target.
 *
 * SAFETY: Vercel Production ALWAYS uses the real Pinterest production API,
 * regardless of any PINTEREST_API_ENV value. This makes it impossible for a stray
 * sandbox flag in Production env to route real users at the sandbox host or to reuse
 * a sandbox token. Sandbox is only reachable on localhost / Preview / non-production
 * deploys, and only when explicitly opted in via PINTEREST_API_ENV=sandbox.
 *
 * Primary opt-in flag: PINTEREST_API_ENV=sandbox. PINTEREST_API_MODE is kept as a
 * backward-compatible alias. Anything other than the exact value "sandbox" resolves
 * to production, so the default is always production.
 */
export function getPinterestApiEnv(): PinterestApiEnv {
  // Hard guard: Vercel Production is production-only. VERCEL_ENV is set by Vercel to
  // "production" | "preview" | "development"; it is absent on local dev.
  if ((process.env.VERCEL_ENV ?? "").trim().toLowerCase() === "production") {
    return "production";
  }
  const raw = (process.env.PINTEREST_API_ENV ?? process.env.PINTEREST_API_MODE ?? "")
    .trim()
    .toLowerCase();
  return raw === "sandbox" ? "sandbox" : "production";
}

/** @deprecated Use getPinterestApiEnv(). */
export const getPinterestApiMode = getPinterestApiEnv;

/** True only when the server is explicitly configured for the sandbox environment. */
export function isPinterestSandboxEnv(): boolean {
  return getPinterestApiEnv() === "sandbox";
}

export function getPinterestApiBase(): string {
  if (isPinterestSandboxEnv()) {
    // Allow an override for forward-compat, else the documented sandbox host.
    return process.env.PINTEREST_SANDBOX_BASE_URL?.trim() || PINTEREST_SANDBOX_API_BASE;
  }
  return PINTEREST_PRODUCTION_API_BASE;
}

/**
 * Server-side resolver for the sandbox access token. Reads ONLY server env — the
 * token is never exposed to the browser and is never logged. Supports both the
 * uppercase and lowercase variable names. Returns null when absent.
 *
 * NOTE: this reads the token regardless of the current env; use
 * canAttemptSandboxPublish() to decide whether the sandbox path is actually
 * active. That keeps production behavior unchanged even if a token is present.
 */
export function getPinterestSandboxAccessToken(): string | null {
  const token =
    process.env.PINTEREST_SANDBOX_ACCESS_TOKEN?.trim() ||
    process.env.pinterest_sandbox_access_token?.trim() ||
    "";
  return token || null;
}

/**
 * Whether a sandbox demo publish may proceed: the server is in the sandbox
 * environment AND a sandbox token is configured. In production this is always
 * false, so the real Standard-access gating is never bypassed.
 */
export function canAttemptSandboxPublish(): boolean {
  return isPinterestSandboxEnv() && getPinterestSandboxAccessToken() !== null;
}

export type PinterestEnv = {
  appId: string;
  appSecret: string;
  redirectUri: string;
};

/**
 * Resolve OAuth credentials. Throws a clear error if any are missing so routes
 * can return a 500 with a safe message (never echoing secret values).
 */
export function getPinterestEnv(): PinterestEnv {
  const appId = process.env.PINTEREST_APP_ID?.trim() ?? "";
  const appSecret = process.env.PINTEREST_APP_SECRET?.trim() ?? "";
  const redirectUri = process.env.PINTEREST_REDIRECT_URI?.trim() ?? "";

  const missing: string[] = [];
  if (!appId) missing.push("PINTEREST_APP_ID");
  if (!appSecret) missing.push("PINTEREST_APP_SECRET");
  if (!redirectUri) missing.push("PINTEREST_REDIRECT_URI");
  if (missing.length) {
    throw new ConfigurationError(`Missing Pinterest env: ${missing.join(", ")}`);
  }

  return { appId, appSecret, redirectUri };
}

/** True when all OAuth env vars are present (for safe diagnostics). */
export function isPinterestConfigured(): boolean {
  try {
    getPinterestEnv();
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the app credentials (id + secret) are present. Safe for diagnostics —
 * reports presence only, never the values.
 */
export function areAppCredentialsConfigured(): boolean {
  return (
    (process.env.PINTEREST_APP_ID?.trim().length ?? 0) > 0 &&
    (process.env.PINTEREST_APP_SECRET?.trim().length ?? 0) > 0
  );
}

/**
 * True when the configured redirect URI looks like a valid PRODUCTION callback:
 * an https URL ending in the registered callback path. Reports config shape only,
 * never the value. Used by debug-status to confirm the production redirect is set.
 */
export function isProductionRedirectConfigured(): boolean {
  const uri = process.env.PINTEREST_REDIRECT_URI?.trim() ?? "";
  return uri.startsWith("https://") && uri.endsWith("/api/auth/pinterest/callback");
}

/** Basic auth header for the token endpoint: base64(appId:appSecret). */
export function basicAuthHeader(env: PinterestEnv): string {
  return "Basic " + Buffer.from(`${env.appId}:${env.appSecret}`).toString("base64");
}

/** Build the Pinterest authorization URL for a given opaque state token. */
export function buildAuthorizeUrl(env: PinterestEnv, state: string): string {
  const params = new URLSearchParams({
    client_id: env.appId,
    redirect_uri: env.redirectUri,
    response_type: "code",
    // Environment-aware: production requests the minimum (no boards:write); sandbox
    // keeps boards:write for the demo-board helper.
    scope: pinterestScopeString(),
    state,
  });
  return `${PINTEREST_AUTH_URL}?${params.toString()}`;
}

/** Public Pinterest URL for a created Pin. Centralized so callers never hand-build it. */
export function pinterestPinUrl(pinId: string): string {
  return `https://www.pinterest.com/pin/${pinId}/`;
}
