/**
 * Pinterest OAuth + publishing unit tests.
 * Run: npx tsx scripts/test-pinterest-oauth.ts
 *
 * Mocks Pinterest HTTP (globalThis.fetch / injected hooks). Never creates real Pins.
 */

import { randomBytes } from "node:crypto";

// Env must be set BEFORE the server modules load (some read env at import time).
process.env.PINTEREST_TOKEN_ENC_KEY = randomBytes(32).toString("base64");
process.env.PINTEREST_APP_ID = "test-app-id";
process.env.PINTEREST_APP_SECRET = "test-app-secret";
process.env.PINTEREST_REDIRECT_URI = "http://localhost:3000/api/auth/pinterest/callback";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

export {};

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
function assertEq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}
async function expectThrow(fn: () => Promise<unknown> | unknown, msg: string) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(msg);
}

async function main() {
// Dynamic imports after env is configured.
const config = await import("../src/lib/server/pinterest/config");
const crypto = await import("../src/lib/server/crypto");
const oauthState = await import("../src/lib/server/pinterest/oauthState");
const validate = await import("../src/lib/server/pinterest/validatePublish");
const service = await import("../src/lib/server/pinterest/service");
const routeHelpers = await import("../src/lib/server/pinterest/routeHelpers");
const connectionStore = await import("../src/lib/server/pinterest/connectionStore");

console.log("\nPinterest OAuth + publishing tests\n");

// 1. Authorization URL generation + 2. exact redirect URI + 3. scopes
await test("authorization URL has correct params, exact redirect URI, and scopes", () => {
  const env = config.getPinterestEnv();
  const url = new URL(config.buildAuthorizeUrl(env, "STATE123"));
  assertEq(url.origin + url.pathname, "https://www.pinterest.com/oauth/", "auth endpoint");
  assertEq(url.searchParams.get("client_id"), "test-app-id", "client_id");
  assertEq(url.searchParams.get("response_type"), "code", "response_type");
  assertEq(url.searchParams.get("redirect_uri"), "http://localhost:3000/api/auth/pinterest/callback", "exact redirect URI");
  assertEq(url.searchParams.get("state"), "STATE123", "state");
  // Default env resolves to production → minimum scopes, NO boards:write.
  assertEq(url.searchParams.get("scope"), "user_accounts:read,boards:read,pins:read,pins:write", "production scopes");
});

await test("production requests minimum scopes; no boards:write, no forbidden / secret scopes", () => {
  const s = config.pinterestScopeString();
  for (const bad of ["ads:", "catalogs:", "_secret"]) {
    assert(!s.includes(bad), `scope string must not include ${bad}`);
  }
  assert(s.includes("pins:write"), "pins:write required for publishing");
  assert(!s.includes("boards:write"), "production must NOT request boards:write");
  assertEq(config.PRODUCTION_SCOPES.length, 4, "exactly 4 production scopes");
});

await test("sandbox requests boards:write for the demo-board helper", () => {
  const old = process.env.PINTEREST_API_ENV;
  process.env.PINTEREST_API_ENV = "sandbox";
  try {
    const s = config.pinterestScopeString();
    assert(s.includes("boards:write"), "sandbox requests boards:write");
    assertEq(config.SANDBOX_SCOPES.length, 5, "exactly 5 sandbox scopes");
  } finally {
    if (old === undefined) delete process.env.PINTEREST_API_ENV;
    else process.env.PINTEREST_API_ENV = old;
  }
});

await test("VERCEL_ENV=production forces production regardless of PINTEREST_API_ENV=sandbox", () => {
  const oldV = process.env.VERCEL_ENV;
  const oldE = process.env.PINTEREST_API_ENV;
  process.env.VERCEL_ENV = "production";
  process.env.PINTEREST_API_ENV = "sandbox"; // stray flag must be ignored in prod
  try {
    assertEq(config.getPinterestApiEnv(), "production", "prod deploy forces production");
    assertEq(config.getPinterestApiBase(), "https://api.pinterest.com/v5", "prod uses production base, NOT api-sandbox");
    assert(!config.pinterestScopeString().includes("boards:write"), "prod scopes even with sandbox flag");
  } finally {
    if (oldV === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = oldV;
    if (oldE === undefined) delete process.env.PINTEREST_API_ENV; else process.env.PINTEREST_API_ENV = oldE;
  }
});

await test("sandbox mode uses api-sandbox base and sandbox access token", async () => {
  const oldMode = process.env.PINTEREST_API_MODE;
  const oldToken = process.env.PINTEREST_SANDBOX_ACCESS_TOKEN;
  const origFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedAuth = "";
  process.env.PINTEREST_API_MODE = "sandbox";
  process.env.PINTEREST_SANDBOX_ACCESS_TOKEN = "SANDBOX_TOKEN";
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedAuth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
    return new Response(JSON.stringify({ username: "sandbox_user", account_type: "SANDBOX" }), { status: 200 });
  }) as typeof fetch;
  try {
    assertEq(config.getPinterestApiBase(), "https://api-sandbox.pinterest.com/v5", "sandbox api base");
    const client = await service.PinterestClient.forSandboxDemo("user-1");
    await client.getCurrentPinterestUser();
    assert(capturedUrl.startsWith("https://api-sandbox.pinterest.com/v5/user_account"), "sandbox endpoint used");
    assertEq(capturedAuth, "Bearer SANDBOX_TOKEN", "sandbox token used");
  } finally {
    globalThis.fetch = origFetch;
    if (oldMode === undefined) delete process.env.PINTEREST_API_MODE;
    else process.env.PINTEREST_API_MODE = oldMode;
    if (oldToken === undefined) delete process.env.PINTEREST_SANDBOX_ACCESS_TOKEN;
    else process.env.PINTEREST_SANDBOX_ACCESS_TOKEN = oldToken;
  }
});

// 4. OAuth state creation
await test("generateState produces unique, sufficiently long tokens", () => {
  const a = oauthState.generateState();
  const b = oauthState.generateState();
  assert(a !== b, "states must differ");
  assert(a.length >= 32, "state should be long");
});

// 5. Valid state callback
await test("verifyState accepts a valid sealed cookie for the same user", () => {
  const state = oauthState.generateState();
  const cookie = oauthState.sealState(state, "user-1");
  const verdict = oauthState.verifyState(cookie, state, "user-1");
  assert(verdict.ok, "valid state should pass");
});

await test("verifyState preserves safe OAuth return path", () => {
  const state = oauthState.generateState();
  const cookie = oauthState.sealState(state, "user-1", "/app/plan?pin=123");
  const verdict = oauthState.verifyState(cookie, state, "user-1");
  assert(verdict.ok, "valid state should pass");
  assertEq(verdict.ok ? verdict.returnTo : null, "/app/plan?pin=123", "return path preserved");
});

// 6. Missing / mismatched state rejection
await test("verifyState rejects missing cookie and mismatched state param", () => {
  const state = oauthState.generateState();
  const cookie = oauthState.sealState(state, "user-1");
  assert(!oauthState.verifyState(undefined, state, "user-1").ok, "missing cookie rejected");
  assert(!oauthState.verifyState(cookie, "wrong-state", "user-1").ok, "mismatched state rejected");
  const wrongUser = oauthState.verifyState(cookie, state, "user-2");
  assert(!wrongUser.ok && wrongUser.reason === "user_mismatch", "user mismatch rejected");
});

// 7. Expired / reused state rejection
await test("verifyState rejects an expired sealed state", () => {
  const expiredCookie = crypto.sealJson({ state: "s", uid: "user-1", exp: Date.now() - 1000 });
  const verdict = oauthState.verifyState(expiredCookie, "s", "user-1");
  assert(!verdict.ok && verdict.reason === "expired", "expired state rejected");
});

// 10. Token encryption roundtrip + tamper detection (tokens never plaintext)
await test("encryptSecret/decryptSecret roundtrips and detects tampering", () => {
  const secret = "pina_v5_access_token_example";
  const ct = crypto.encryptSecret(secret);
  assert(ct.startsWith("v1:"), "versioned ciphertext");
  assert(!ct.includes(secret), "ciphertext must not contain plaintext");
  assertEq(crypto.decryptSecret(ct), secret, "roundtrip");
  // Flip a REAL byte of the AES-GCM payload, not a trailing base64 char: changing the
  // last base64 character can leave the decoded bytes identical (the low bits fall on
  // discarded padding), so decryption would sometimes NOT throw — a flaky test. Decode
  // "v1:"+base64, flip one payload byte (here in the IV, guaranteed to change the bytes),
  // re-encode: GCM auth then always fails and decryptSecret must throw.
  const raw = Buffer.from(ct.slice(3), "base64");
  raw[0] ^= 0xff;
  const tampered = "v1:" + raw.toString("base64");
  return expectThrow(() => crypto.decryptSecret(tampered), "tampered ciphertext must throw");
});

// 8. Token exchange success (mock fetch) + verifies grant_type + redirect_uri
await test("exchangeCodeForTokens posts correct body and parses tokens", async () => {
  const orig = globalThis.fetch;
  let capturedBody = "";
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    capturedBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        access_token: "AT", refresh_token: "RT",
        expires_in: 3600, refresh_token_expires_in: 7200,
        scope: "user_accounts:read boards:read boards:write pins:read pins:write",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const tokens = await service.exchangeCodeForTokens("AUTH_CODE");
    assert(capturedBody.includes("grant_type=authorization_code"), "grant_type");
    assert(capturedBody.includes("code=AUTH_CODE"), "code in body");
    assert(capturedBody.includes(encodeURIComponent("http://localhost:3000/api/auth/pinterest/callback")), "exact redirect_uri in body");
    assertEq(tokens.accessToken, "AT", "access token");
    assertEq(tokens.refreshToken, "RT", "refresh token");
    assert(tokens.accessTokenExpiresAt && tokens.refreshTokenExpiresAt, "expiries computed");
    assertEq(tokens.scopes.length, 5, "scopes parsed");
  } finally {
    globalThis.fetch = orig;
  }
});

// 9. Token exchange failure
await test("exchangeCodeForTokens throws on token endpoint error", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "invalid_grant", error_description: "bad code" }), { status: 400 })
  ) as typeof fetch;
  try {
    await expectThrow(() => service.exchangeCodeForTokens("BAD"), "should throw on 400");
  } finally {
    globalThis.fetch = orig;
  }
});

// 15. Access-token refresh
await test("refreshAccessToken posts grant_type=refresh_token and parses result", async () => {
  const orig = globalThis.fetch;
  let body = "";
  globalThis.fetch = (async (_u: string | URL, init?: RequestInit) => {
    body = String(init?.body ?? "");
    return new Response(JSON.stringify({ access_token: "AT2", refresh_token: "RT2", expires_in: 3600 }), { status: 200 });
  }) as typeof fetch;
  try {
    const t = await service.refreshAccessToken("RT");
    assert(body.includes("grant_type=refresh_token"), "grant_type refresh");
    assert(body.includes("refresh_token=RT"), "refresh token in body");
    assertEq(t.accessToken, "AT2", "new access token");
  } finally {
    globalThis.fetch = orig;
  }
});

// 16. Exactly one retry after a 401 (refresh + retry once)
await test("PinterestClient refreshes and retries exactly once on 401", async () => {
  let fetchCalls = 0;
  let refreshCalls = 0;
  const client = service.PinterestClient.forTest({
    accessToken: "old",
    refreshToken: "rt",
    hooks: {
      fetchImpl: async () => {
        fetchCalls++;
        if (fetchCalls === 1) return new Response("{}", { status: 401 });
        return new Response(JSON.stringify({ username: "creator", account_type: "BUSINESS" }), { status: 200 });
      },
      refreshFn: async () => {
        refreshCalls++;
        return { accessToken: "new", refreshToken: "rt2", accessTokenExpiresAt: null, refreshTokenExpiresAt: null, scopes: [] };
      },
      persistTokens: async () => ({ applied: true }),
    },
  });
  const user = await client.getCurrentPinterestUser();
  assertEq(fetchCalls, 2, "one original + one retry");
  assertEq(refreshCalls, 1, "exactly one refresh");
  assertEq(user.username, "creator", "user returned after retry");
});

await test("PinterestClient does NOT retry more than once on repeated 401", async () => {
  let fetchCalls = 0;
  let refreshCalls = 0;
  const client = service.PinterestClient.forTest({
    accessToken: "old",
    refreshToken: "rt",
    hooks: {
      fetchImpl: async () => { fetchCalls++; return new Response("{}", { status: 401 }); },
      refreshFn: async () => { refreshCalls++; return { accessToken: "new", refreshToken: "rt2", accessTokenExpiresAt: null, refreshTokenExpiresAt: null, scopes: [] }; },
      persistTokens: async () => ({ applied: true }),
    },
  });
  await expectThrow(() => client.getCurrentPinterestUser(), "should throw after single retry");
  assertEq(fetchCalls, 2, "no infinite retry — exactly two attempts");
  assertEq(refreshCalls, 1, "exactly one refresh attempt");
});

// 10b. Tokens never included in status responses
await test("toSafeStatus never includes token fields", () => {
  const row = {
    id: "1", vibepin_user_id: "u", provider: "pinterest",
    pinterest_user_id: "pid", pinterest_username: "creator", pinterest_account_type: "BUSINESS",
    access_token_encrypted: "v1:secret", refresh_token_encrypted: "v1:secret",
    access_token_expires_at: null, refresh_token_expires_at: null,
    scopes: ["user_accounts:read", "boards:read", "boards:write", "pins:read", "pins:write"], needs_reconnect: false,
    created_at: "", updated_at: "", disconnected_at: null, token_version: 0,
  };
  const safe = connectionStore.toSafeStatus(row);
  const json = JSON.stringify(safe);
  assert(!json.includes("secret"), "no token material in safe status");
  assert(!("access_token_encrypted" in safe), "no token key in safe status");
  assertEq(safe.connected, true, "connected");
  assertEq(safe.account?.username, "creator", "username surfaced");
  assertEq(connectionStore.toSafeStatus(null).connected, false, "null row => not connected");
});

const mkRow = (scopes: string[]) => ({
  id: "1", vibepin_user_id: "u", provider: "pinterest",
  pinterest_user_id: "pid", pinterest_username: "creator", pinterest_account_type: "BUSINESS",
  access_token_encrypted: "v1:secret", refresh_token_encrypted: "v1:secret",
  access_token_expires_at: null, refresh_token_expires_at: null,
  scopes, needs_reconnect: false,
  created_at: "", updated_at: "", disconnected_at: null, token_version: 0,
});

await test("toSafeStatus: production-scope connection (no boards:write) is usable, NOT needsReconnect", () => {
  // boards:write is no longer requested or required in production. A connection with
  // the publish floor (boards:read + pins:read + pins:write) must stay usable.
  const safe = connectionStore.toSafeStatus(mkRow(["boards:read", "pins:read", "pins:write"]));
  assertEq(safe.connected, true, "still connected");
  assertEq(safe.needsReconnect, false, "production floor met => no reconnect");
});

await test("toSafeStatus: connection missing a required scope (pins:write) DOES need reconnect", () => {
  const safe = connectionStore.toSafeStatus(mkRow(["boards:read", "pins:read"]));
  assertEq(safe.connected, true, "still connected");
  assertEq(safe.needsReconnect, true, "missing pins:write => reconnect required");
});

// 13. Publish route rejects non-public image URLs
await test("validatePublicImageUrl rejects localhost/blob/data and accepts public https", () => {
  assert(!validate.validatePublicImageUrl("http://localhost:3000/x.png").ok, "localhost rejected");
  assert(!validate.validatePublicImageUrl("http://127.0.0.1/x.png").ok, "loopback rejected");
  assert(!validate.validatePublicImageUrl("http://192.168.1.5/x.png").ok, "private LAN rejected");
  assert(!validate.validatePublicImageUrl("data:image/png;base64,AAAA").ok, "data: rejected");
  assert(!validate.validatePublicImageUrl("blob:http://x/y").ok, "blob: rejected");
  assert(!validate.validatePublicImageUrl("/api/storage-image?path=studio/x.png").ok, "relative proxy rejected");
  const ok = validate.validatePublicImageUrl("https://jaxteelkecvlozdrdoog.supabase.co/storage/v1/object/public/generated/studio/x.png");
  assert(ok.ok, "public supabase URL accepted");
});

await test("validateOptionalLink: empty ok, localhost rejected, public ok", () => {
  assert(validate.validateOptionalLink("").ok, "empty link ok");
  assert(validate.validateOptionalLink(undefined).ok, "undefined link ok");
  assert(!validate.validateOptionalLink("http://localhost/x").ok, "localhost link rejected");
  assert(validate.validateOptionalLink("https://shop.example.com/p/1").ok, "public link ok");
});

// 14. Pinterest API error mapping
await test("pinterestErrorResponse maps connection/API errors to safe statuses", async () => {
  const { DatabaseError } = await import("../src/lib/server/pinterest/errors");
  const notConnected = routeHelpers.pinterestErrorResponse(new service.NotConnectedError());
  assertEq(notConnected.status, 409, "not connected => 409");
  const reconnect = routeHelpers.pinterestErrorResponse(new service.NeedsReconnectError());
  assertEq(reconnect.status, 401, "needs reconnect => 401");
  const reconnectBody = await reconnect.json();
  assertEq(reconnectBody.needsReconnect, true, "needsReconnect flag set");
  const missingScope = routeHelpers.pinterestErrorResponse(new service.MissingPinterestScopesError(["boards:write"]));
  assertEq(missingScope.status, 401, "missing scopes => 401");
  const missingBody = await missingScope.json();
  assertEq(missingBody.needsReconnect, true, "missing scopes set reconnect flag");
  const trial = routeHelpers.pinterestErrorResponse(new service.PinterestTrialAccessError());
  assertEq(trial.status, 403, "trial access => 403");
  const trialBody = await trial.json();
  assertEq(trialBody.code, "pinterest_trial_access", "trial access code");
  const apiErr = routeHelpers.pinterestErrorResponse(new service.PinterestApiError("rate limited", 429));
  assertEq(apiErr.status, 429, "api error preserves status");
  const dbErr = routeHelpers.pinterestErrorResponse(new DatabaseError());
  assertEq(dbErr.status, 503, "database error => 503");
  const dbBody = await dbErr.json();
  assertEq(dbBody.code, "database_error", "database_error code");
  const unauth = routeHelpers.unauthorized();
  assertEq(unauth.status, 401, "unauthorized => 401");
});

// 11/12. Boards + Publish routes require authentication (auth helper rejects missing token)
await test("getUserIdFromBearer returns null without a valid bearer token", async () => {
  const authUser = await import("../src/lib/server/authUser");
  const noHeader = await authUser.getUserIdFromBearer(new Request("https://x.test/api"));
  assertEq(noHeader, null, "missing Authorization => null");
  const badScheme = await authUser.getUserIdFromBearer(
    new Request("https://x.test/api", { headers: { Authorization: "Basic abc" } }),
  );
  assertEq(badScheme, null, "non-bearer scheme => null");
});

// 14. Concurrent refresh coalescing — the rotated refresh token is never clobbered.
await test("concurrent refreshes for one user coalesce into a single refresh + atomic persist", async () => {
  let refreshCalls = 0;
  const persisted: Array<{ accessToken: string; refreshToken: string | null }> = [];
  // Two shared-lock clients for the SAME uid, both already-expired so every request
  // refreshes-before-use. Fire two requests concurrently.
  const mk = () => service.PinterestClient.forTest({
    uid: "same-user", accessToken: "old", refreshToken: "rt0",
    accessExpiresAt: new Date(Date.now() - 10_000).toISOString(),
    shareRefresh: true,
    hooks: {
      fetchImpl: async () => new Response(JSON.stringify({ username: "creator", account_type: "BUSINESS" }), { status: 200 }),
      refreshFn: async () => {
        refreshCalls++;
        await new Promise(r => setTimeout(r, 40)); // widen the race window
        return { accessToken: `at${refreshCalls}`, refreshToken: `rt${refreshCalls}`, accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshTokenExpiresAt: null, scopes: [] };
      },
      persistTokens: async (_uid, t) => { persisted.push({ accessToken: t.accessToken, refreshToken: t.refreshToken }); return { applied: true }; },
    },
  });
  const [a, b] = [mk(), mk()];
  await Promise.all([a.getCurrentPinterestUser(), b.getCurrentPinterestUser()]);
  assertEq(refreshCalls, 1, "exactly ONE refresh for two concurrent requests");
  assertEq(persisted.length, 1, "exactly ONE atomic persist (no clobber)");
  assertEq(persisted[0]?.refreshToken, "rt1", "rotated refresh token persisted atomically");
});

// 15. debug-status contract: only booleans / non-secret host; never a token or secret.
await test("debug-status returns booleans + non-secret host only (never secrets)", async () => {
  const oldV = process.env.VERCEL_ENV; const oldE = process.env.PINTEREST_API_ENV;
  process.env.VERCEL_ENV = "production"; process.env.PINTEREST_API_ENV = "sandbox";
  try {
    const route = await import("../src/app/api/pinterest/debug-status/route");
    const res = await route.GET(new Request("https://vibepin.co/api/pinterest/debug-status"));
    const body = await res.json() as Record<string, unknown>;
    assertEq(body.apiEnv, "production", "prod deploy => production");
    assertEq(body.apiBaseIsProduction, true, "base is api.pinterest.com");
    assertEq(body.baseUrl, "https://api.pinterest.com/v5", "non-secret base host");
    assertEq(body.appCredentialsConfigured, true, "creds present");
    assertEq(body.tokenRefreshConfigured, true, "refresh available");
    assertEq(body.sandboxTokenPresent, false, "sandbox token ignored in production");
    assertEq(body.standardAccessRequired, true, "production needs Standard access");
    // No secret material anywhere in the response.
    const json = JSON.stringify(body);
    for (const secret of [process.env.PINTEREST_APP_SECRET!, process.env.PINTEREST_TOKEN_ENC_KEY!, "access_token", "refresh_token", "Bearer "]) {
      assert(!json.includes(secret), `debug-status must not leak ${secret.slice(0, 12)}`);
    }
  } finally {
    if (oldV === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = oldV;
    if (oldE === undefined) delete process.env.PINTEREST_API_ENV; else process.env.PINTEREST_API_ENV = oldE;
  }
});

// ── Cross-instance refresh CAS (Vercel multi-instance safety) ─────────────────
await test("refresh CAS: a lost write adopts the other instance's tokens, no reconnect", async () => {
  let marked = false;
  const past = new Date(Date.now() - 60_000).toISOString();
  const client = service.PinterestClient.forTest({
    accessToken: "stale", refreshToken: "rt-old", accessExpiresAt: past, // expiring → forces doRefresh
    hooks: {
      // Our refresh "succeeds" against Pinterest…
      refreshFn: async () => ({ accessToken: "mine", refreshToken: "rt-mine", accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshTokenExpiresAt: null, scopes: [] }),
      // …but the CAS loses: another instance already bumped the version.
      persistTokens: async () => ({ applied: false }),
      reloadConnection: async () => ({ accessToken: "theirs", refreshToken: "rt-theirs", accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), tokenVersion: 1 }),
      markReconnect: async () => { marked = true; },
      fetchImpl: async (_url, init) => {
        const auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
        // The request must go out with the ADOPTED token, not ours or the stale one.
        assert(auth.includes("theirs"), `must use the other instance's token, got ${auth}`);
        return new Response(JSON.stringify({ username: "creator", account_type: "BUSINESS" }), { status: 200 });
      },
    },
  });
  const user = await client.getCurrentPinterestUser();
  assertEq(user.username, "creator", "request succeeds with adopted tokens");
  assert(!marked, "a lost CAS must NOT mark needs_reconnect");
});

await test("refresh CAS: invalid_grant with a bumped version adopts, does not reconnect", async () => {
  let marked = false;
  const past = new Date(Date.now() - 60_000).toISOString();
  const client = service.PinterestClient.forTest({
    accessToken: "stale", refreshToken: "rt-old", accessExpiresAt: past,
    hooks: {
      // Pinterest rejects OUR refresh (another instance already consumed the old token).
      refreshFn: async () => { throw new service.PinterestApiError("invalid_grant", 400, "invalid_grant"); },
      // But the stored version moved past ours → someone else refreshed successfully.
      reloadConnection: async () => ({ accessToken: "theirs", refreshToken: "rt-theirs", accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), tokenVersion: 1 }),
      markReconnect: async () => { marked = true; },
      fetchImpl: async () => new Response(JSON.stringify({ username: "creator", account_type: "BUSINESS" }), { status: 200 }),
    },
  });
  const user = await client.getCurrentPinterestUser();
  assertEq(user.username, "creator", "invalid_grant race recovers with adopted tokens");
  assert(!marked, "a concurrent-refresh invalid_grant must NOT mark needs_reconnect");
});

await test("refresh CAS: invalid_grant with NO version bump is a real reconnect", async () => {
  let marked = false;
  const past = new Date(Date.now() - 60_000).toISOString();
  const client = service.PinterestClient.forTest({
    accessToken: "stale", refreshToken: "rt-dead", accessExpiresAt: past,
    hooks: {
      refreshFn: async () => { throw new service.PinterestApiError("invalid_grant", 400, "invalid_grant"); },
      // Version unchanged → nobody else refreshed → the token is genuinely dead.
      reloadConnection: async () => ({ accessToken: "stale", refreshToken: "rt-dead", accessExpiresAt: past, tokenVersion: 0 }),
      markReconnect: async () => { marked = true; },
      fetchImpl: async () => new Response("{}", { status: 200 }),
    },
  });
  await expectThrow(() => client.getCurrentPinterestUser(), "genuinely-dead token must throw NeedsReconnect");
  assert(marked, "a real invalid_grant (no concurrent refresh) MUST mark needs_reconnect");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
