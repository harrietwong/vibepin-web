/**
 * GET /api/pinterest/debug-status
 *
 * Safe, non-secret diagnostics for the Pinterest environment. Confirms production
 * (or sandbox) wiring without ever exposing a secret.
 *
 * Returns ONLY booleans, an enum, and the non-secret API host string — NEVER an
 * access/refresh token, the app secret, the encryption key, or an Authorization
 * header. Presence flags report presence, never the value.
 *
 *   {
 *     apiEnv: "sandbox" | "production",
 *     apiBaseIsProduction: boolean,       // base === https://api.pinterest.com/v5
 *     baseUrl: string,                    // non-secret host only
 *     appCredentialsConfigured: boolean,  // APP_ID + APP_SECRET present
 *     productionRedirectConfigured: boolean,
 *     tokenEncryptionConfigured: boolean,
 *     tokenRefreshConfigured: boolean,    // creds + encryption both present
 *     sandboxTokenPresent: boolean,       // only meaningful (and only true) in sandbox env
 *     canAttemptSandboxPublish: boolean,
 *     standardAccessRequired: boolean,
 *     oauthConnectionPresent: boolean,    // this user has a stored connection
 *     connectionNeedsReconnect: boolean
 *   }
 */

import {
  getPinterestApiEnv,
  getPinterestApiBase,
  getPinterestSandboxAccessToken,
  canAttemptSandboxPublish,
  areAppCredentialsConfigured,
  isProductionRedirectConfigured,
  isPinterestSandboxEnv,
  PINTEREST_PRODUCTION_API_BASE,
} from "@/lib/server/pinterest/config";
import { isEncryptionConfigured } from "@/lib/server/crypto";
import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { getActiveConnection, toSafeStatus } from "@/lib/server/pinterest/connectionStore";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const apiEnv = getPinterestApiEnv();
  const baseUrl = getPinterestApiBase();
  const canSandbox = canAttemptSandboxPublish();
  const credsConfigured = areAppCredentialsConfigured();
  const encConfigured = isEncryptionConfigured();

  // Best-effort per-user connection presence (booleans only — toSafeStatus never
  // includes tokens). Wrapped so diagnostics never throw on an auth/DB hiccup.
  let oauthConnectionPresent = false;
  let connectionNeedsReconnect = false;
  try {
    const uid = await getUserIdFromBearerOrCookies(req);
    if (uid) {
      const status = toSafeStatus(await getActiveConnection(uid));
      oauthConnectionPresent = status.connected;
      connectionNeedsReconnect = status.needsReconnect;
    }
  } catch {
    // Diagnostics must not fail on auth/DB issues; leave the defaults.
  }

  return Response.json({
    apiEnv,
    apiBaseIsProduction: baseUrl === PINTEREST_PRODUCTION_API_BASE,
    baseUrl,
    appCredentialsConfigured: credsConfigured,
    productionRedirectConfigured: isProductionRedirectConfigured(),
    tokenEncryptionConfigured: encConfigured,
    // Automatic refresh needs both app credentials (to call the token endpoint) and
    // the encryption key (to read/store tokens). Reports capability, not a secret.
    tokenRefreshConfigured: credsConfigured && encConfigured,
    // Never true — and never even inspected — outside the sandbox environment.
    sandboxTokenPresent: isPinterestSandboxEnv() ? getPinterestSandboxAccessToken() !== null : false,
    canAttemptSandboxPublish: canSandbox,
    // In production (no active sandbox path) real Standard access is required.
    standardAccessRequired: !canSandbox,
    oauthConnectionPresent,
    connectionNeedsReconnect,
  });
}
