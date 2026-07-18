# Pinterest Sandbox → Production Transition

Date: 2026-07-15 · Scope: switch the Pinterest integration to Production safely, keep Sandbox available for localhost/Preview. No changes to Create Pin / scheduling / cron / publish-failure UX / Shopify.

---

## 1. Audit findings (existing implementation)

| # | Item | Finding |
|---|------|---------|
| 1 | **Env vars & where read** | `PINTEREST_APP_ID`, `PINTEREST_APP_SECRET`, `PINTEREST_REDIRECT_URI` (config.ts `getPinterestEnv`); `PINTEREST_API_ENV` / `PINTEREST_API_MODE` alias (env selector); `PINTEREST_SANDBOX_ACCESS_TOKEN` + `PINTEREST_SANDBOX_BASE_URL` (sandbox only); `PINTEREST_TOKEN_ENC_KEY` (crypto.ts, AES-256-GCM); now also `VERCEL_ENV` (new hard guard). |
| 2 | **Sandbox / Production base URLs** | Production `https://api.pinterest.com/v5`; Sandbox `https://api-sandbox.pinterest.com/v5`. Both constants in config.ts; `getPinterestApiBase()` picks by env. |
| 3 | **OAuth authorize + callback routes** | Authorize: `GET /api/auth/pinterest/connect` → `buildAuthorizeUrl` (endpoint `https://www.pinterest.com/oauth/`). Callback: `GET /api/auth/pinterest/callback` (exact registered redirect URI). |
| 4 | **Token storage schema** | Supabase table `pinterest_connections`: encrypted access/refresh tokens, `access_token_expires_at`, `refresh_token_expires_at`, `scopes[]`, `pinterest_user_id/username/account_type`, `needs_reconnect`, `disconnected_at`, timestamps. Per VibePin user (`vibepin_user_id`, unique). |
| 5 | **Refresh implemented?** | Yes. `PinterestClient` refreshes before expiry (60s skew) and once on a 401. |
| 6 | **Rotated refresh token persisted?** | Yes — `updateTokens()` writes the new refresh token + expiry only when Pinterest returns one, in a single atomic UPDATE. **Gap found & fixed:** concurrent refreshes could send an already-rotated refresh token / clobber newer tokens. Added an in-process per-user coalescing lock. |
| 7 | **debug-status output** | Was sandbox-oriented (apiEnv, baseUrl, sandboxTokenPresent, canAttemptSandboxPublish, standardAccessRequired). **Rewritten** to the production-safe boolean set (below). Never returned secrets before or after. |
| 8 | **Exact scopes** | Was a single 5-scope set incl. `boards:write`. **Split:** Production = `user_accounts:read, boards:read, pins:read, pins:write` (4, no boards:write). Sandbox = adds `boards:write` (5) for the demo-board helper. |
| 9 | **Per-environment Pinterest env?** | Now yes and enforced: Vercel Production is ALWAYS production (VERCEL_ENV guard). localhost / Preview may opt into sandbox via `PINTEREST_API_ENV=sandbox`. |
| 10 | **Files needing modification** | `config.ts`, `service.ts`, `api/pinterest/debug-status/route.ts`, `api/pinterest/status/route.ts`, `scripts/test-pinterest-oauth.ts`. |

**Product does NOT create/edit Pinterest boards for real users** → `boards:write` dropped from production scopes (the demo-board helper that needs it only runs in sandbox).

**Trial-access handler kept:** `PinterestTrialAccessError` / `isTrialAccessResponse` is a *detector* of Pinterest's own "trial access… api-sandbox" rejection message, not a blocker VibePin imposes. With Standard access granted Pinterest won't emit it; keeping it preserves clear handling if a real permission error ever recurs. No production blocker existed to remove.

---

## 2. Vercel environment variables (REVIEW BEFORE CHANGING — placeholders only)

> Nothing was changed in Vercel. These are the exact names/values to set. Secrets are the SAME app credentials already in use — do not create parallel vars.

**Production environment (vibepin.co):**
```
PINTEREST_APP_ID            = <existing Pinterest app id>
PINTEREST_APP_SECRET        = <existing Pinterest app secret>
PINTEREST_REDIRECT_URI      = https://vibepin.co/api/auth/pinterest/callback
PINTEREST_TOKEN_ENC_KEY     = <existing 32-byte base64 key — MUST match what encrypted current tokens>
# Do NOT set PINTEREST_API_ENV / PINTEREST_API_MODE in Production.
# Even if set to "sandbox", the VERCEL_ENV=production guard forces production.
# Do NOT set PINTEREST_SANDBOX_ACCESS_TOKEN in Production.
```

**Preview environment (optional — only if you want Preview on sandbox):**
```
PINTEREST_API_ENV                = sandbox
PINTEREST_SANDBOX_ACCESS_TOKEN   = <sandbox token>
PINTEREST_REDIRECT_URI           = <a preview/sandbox callback URL you register in the sandbox app>
```

**Local (`web/.env.local`) — action needed:** the file has `PINTEREST_API_ENV` on **two** lines (23=`production`, 34=`sandbox`); dotenv keeps the last, so local is currently **sandbox**. Keep whichever you want for local dev and delete the other line. (No effect on Vercel.)

### Pinterest developer dashboard
Register this exact production redirect URI:
```
https://vibepin.co/api/auth/pinterest/callback
```
Requested production scopes: `boards:read, pins:read, pins:write` (+ `user_accounts:read`). No `boards:write`, no `ads:*`, `catalogs:*`, or `*_secret`.

---

## 3. debug-status — production-safe fields (`GET /api/pinterest/debug-status`)

Returns ONLY these — booleans, one enum, one non-secret host string. Never a token/secret:
`apiEnv`, `apiBaseIsProduction`, `baseUrl`, `appCredentialsConfigured`, `productionRedirectConfigured`, `tokenEncryptionConfigured`, `tokenRefreshConfigured`, `sandboxTokenPresent` (false outside sandbox), `canAttemptSandboxPublish`, `standardAccessRequired`, `oauthConnectionPresent`, `connectionNeedsReconnect`.

---

## 4. Files changed

- `web/src/lib/server/pinterest/config.ts` — PRODUCTION_SCOPES/SANDBOX_SCOPES split; reduced required floor (no boards:write); `pinterestRequestScopes()`/`pinterestScopeString()`; VERCEL_ENV production guard; `areAppCredentialsConfigured()`/`isProductionRedirectConfigured()`; authorize URL uses env-aware scope string.
- `web/src/lib/server/pinterest/service.ts` — per-user concurrent-refresh coalescing lock (`_refreshInFlight`); `performRefresh()` does one exchange + one atomic rotated-token persist; `shareRefresh` field for testability. Publish image guard, idempotency, one-401-retry, trial-access detector all preserved.
- `web/src/app/api/pinterest/debug-status/route.ts` — rewritten to the safe boolean set.
- `web/src/app/api/pinterest/status/route.ts` — sandbox_demo scopes now env-aware.
- `web/scripts/test-pinterest-oauth.ts` — new production-scope contract + sandbox/VERCEL_ENV coverage + concurrency + debug-status contract tests (25 pass).

---

## 5. Verification

**Automated (run by me):** typecheck; Pinterest suites — oauth 25, integrations-repair 15, client-dedupe 7, connection-consistency 8, plan-connect 9 = **64 pass**.

**Production checklist (requires your Vercel deploy + live OAuth — I cannot run these):**
1. Set the Production env vars above; register the redirect URI. 2. Deploy to Production. 3. `GET /api/pinterest/debug-status` → `apiEnv:"production"`, `apiBaseIsProduction:true`, `appCredentialsConfigured:true`, `productionRedirectConfigured:true`, `tokenRefreshConfigured:true`, `sandboxTokenPresent:false`. 4. Fresh OAuth from vibepin.co → connected. 5. Granted scopes = boards:read/pins:read/pins:write (+user_accounts:read), no boards:write. 6. Account + boards fetch. 7. Publish a real Pin. 8. Pin ID + URL stored. 9. Open the Pin on pinterest.com. 10. Schedule a Pin; let cron publish once. 11. Cross-device: Scheduled→Posted. 12. Force a failure → Publish failures surfaces it. 13. Expiry/refresh: near-expiry request refreshes, rotated token persisted, no reconnect prompt. 14. Confirm no Production request hits `api-sandbox.pinterest.com` (network/logs).

## 6. Remaining risks
- `PINTEREST_TOKEN_ENC_KEY` in Production **must equal** the key that encrypted existing tokens, or stored tokens can't be decrypted (forces reconnect for connected users).
- Concurrent-refresh lock is in-process (per instance). Single-instance deploy today → fully effective. Multi-instance would need a DB-level guard (documented, not required now).
- Steps 2–14 depend on your Vercel action; not yet executed.
