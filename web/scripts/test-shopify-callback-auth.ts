/**
 * Shopify OAuth callback verified-auth boundary.
 * Run: npx tsx scripts/test-shopify-callback-auth.ts
 *
 * Hermetic by construction: auth, OAuth state, entitlements, persistence and
 * fetch are all in-memory fakes. No Shopify, Supabase or other network call can
 * leave this process.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.SHOPIFY_CLIENT_ID = "test-client-id";
process.env.SHOPIFY_CLIENT_SECRET = "test-client-secret";

export {};

import { Module } from "node:module";
import { NextRequest } from "next/server";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}\n      ${(error as Error).message}`);
  }
}
function assertEq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

const VERIFIED_USER = "11111111-1111-4111-8111-111111111111";
const WEAK_USER = "22222222-2222-4222-8222-222222222222";
const SHOP = "demo-store.myshopify.com";
const STATE_COOKIE = "vibepin_shopify_oauth_state";

let verifiedAuthId: string | null = null;
let weakSessionId: string | null = null;
let verifiedAuthCalls = 0;
let weakSessionCalls = 0;
let tokenExchangeCalls = 0;
let totalFetchCalls = 0;
let shopProfileFetchCalls = 0;
let webhookFetchCalls = 0;
let persistenceWrites = 0;
let planResolutionCalls = 0;
let entitlementCalls = 0;
let connectionListCalls = 0;
let stateVerifyCalls = 0;
let stateVerifiedForUser: string | null = null;
let persistedForUser: string | null = null;

function resetScenario() {
  verifiedAuthCalls = 0;
  weakSessionCalls = 0;
  tokenExchangeCalls = 0;
  totalFetchCalls = 0;
  shopProfileFetchCalls = 0;
  webhookFetchCalls = 0;
  persistenceWrites = 0;
  planResolutionCalls = 0;
  entitlementCalls = 0;
  connectionListCalls = 0;
  stateVerifyCalls = 0;
  stateVerifiedForUser = null;
  persistedForUser = null;
}

async function verifiedCookieAuth(): Promise<string | null> {
  verifiedAuthCalls++;
  return verifiedAuthId;
}

async function weakLocalSessionAuth(): Promise<string | null> {
  weakSessionCalls++;
  return weakSessionId;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalLoad = (Module as any)._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "@/lib/server/authUser" || /[\\/]lib[\\/]server[\\/]authUser(\.ts)?$/.test(request)) {
    return {
      // Aggregate verified-cookie seams so the route may use the direct helper or
      // a verified bearer-or-cookie wrapper without this test locking its name.
      getUserIdFromCookies: verifiedCookieAuth,
      getUserIdFromBearerOrCookies: verifiedCookieAuth,
      getUserIdFromBearer: async () => null,
      // Both local-session helpers are unsafe as final authorization here.
      getUserIdFromCookieSession: weakLocalSessionAuth,
      getUserIdFromSameOriginSession: weakLocalSessionAuth,
    };
  }
  if (request === "@/lib/server/entitlements" || /[\\/]lib[\\/]server[\\/]entitlements(\.ts)?$/.test(request)) {
    return {
      resolvePlan: async () => {
        planResolutionCalls++;
        return "pro";
      },
      getEntitlements: () => {
        entitlementCalls++;
        return { maxStores: 5 };
      },
    };
  }
  if (request === "@/lib/server/shopify/connectionStore" || /[\\/]shopify[\\/]connectionStore(\.ts)?$/.test(request)) {
    return {
      listConnections: async () => {
        connectionListCalls++;
        return [];
      },
      upsertConnection: async (userId: string) => {
        persistenceWrites++;
        persistedForUser = userId;
      },
    };
  }
  if (request === "@/lib/server/shopify/hmac" || /[\\/]shopify[\\/]hmac(\.ts)?$/.test(request)) {
    return { verifyLaunchQueryHmac: () => true };
  }
  if (request === "@/lib/server/shopify/config" || /[\\/]shopify[\\/]config(\.ts)?$/.test(request)) {
    return {
      SHOPIFY_SETTINGS_PATH: "/app/settings",
      getShopifyEnv: () => ({ clientId: "test-client-id", clientSecret: "test-client-secret" }),
      getShopifyApiVersion: () => "2026-07",
      getShopifyAppUrl: () => null,
      isShopifyConfigured: () => true,
    };
  }
  if (request === "@/lib/server/shopify/oauthState" || /[\\/]shopify[\\/]oauthState(\.ts)?$/.test(request)) {
    return {
      SHOPIFY_OAUTH_STATE_COOKIE: STATE_COOKIE,
      verifyShopifyState: (_cookie: string | undefined, _state: string | undefined, userId: string) => {
        stateVerifyCalls++;
        stateVerifiedForUser = userId;
        return { ok: true, uid: userId, shopDomain: SHOP, returnTo: "/app/settings" };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  totalFetchCalls++;
  const url = String(input);
  if (url.endsWith("/admin/oauth/access_token")) {
    tokenExchangeCalls++;
    return new Response(JSON.stringify({ access_token: "shpat_test_token", scope: "read_products" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.includes("/graphql.json")) {
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("webhookSubscriptionCreate")) webhookFetchCalls++;
    else shopProfileFetchCalls++;
    return new Response(JSON.stringify({ data: { shop: { name: "Demo", primaryDomain: { host: SHOP } } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  throw new Error(`unexpected network target in hermetic test: ${url}`);
};

function makeCallbackRequest(): NextRequest {
  const url = new URL("https://vibepin.co/api/integrations/shopify/callback");
  url.searchParams.set("code", "oauth-code");
  url.searchParams.set("state", "sealed-state");
  url.searchParams.set("shop", SHOP);
  url.searchParams.set("hmac", "test-hmac");
  return new NextRequest(url, {
    headers: { cookie: `${STATE_COOKIE}=sealed-cookie` },
  });
}

async function callCallback(): Promise<Response> {
  const routePath = require.resolve("../src/app/api/integrations/shopify/callback/route");
  delete require.cache[routePath];
  const route = await import(`../src/app/api/integrations/shopify/callback/route?auth=${Math.random()}`);
  return route.GET(makeCallbackRequest());
}

async function main() {
  console.log("\nShopify callback verified-auth tests\n");

  await test("verified cookie success binds state, token exchange and write to that user", async () => {
    resetScenario();
    verifiedAuthId = VERIFIED_USER;
    weakSessionId = null;

    const response = await callCallback();
    assertEq(weakSessionCalls, 0, "local-only session auth is never called");
    assertEq(verifiedAuthCalls > 0, true, "a verified cookie auth boundary is used");
    assertEq(stateVerifyCalls, 1, "sealed state is verified once");
    assertEq(stateVerifiedForUser, VERIFIED_USER, "sealed state is checked against the verified user");
    assertEq(tokenExchangeCalls, 1, "authorization code exchanged once");
    assertEq(persistenceWrites, 1, "connection written once");
    assertEq(persistedForUser, VERIFIED_USER, "connection owner is the verified user");
    assertEq(planResolutionCalls, 1, "store allowance is resolved once for the verified user");
    assertEq(entitlementCalls, 1, "entitlements are read once");
    assertEq(connectionListCalls, 1, "existing connections are read once");
    assertEq(shopProfileFetchCalls, 1, "shop profile is fetched once after verified auth");
    assertEq(webhookFetchCalls, 0, "webhook registration stays disabled when app URL is absent");
    assertEq(new URL(response.headers.get("location") ?? "https://invalid").searchParams.get("shopify"), "connected", "success redirect");
  });

  await test("failed verified cookie auth performs zero token exchange and zero write", async () => {
    resetScenario();
    verifiedAuthId = null;
    // A forged/local session is deliberately present. The callback must ignore it.
    weakSessionId = WEAK_USER;

    const response = await callCallback();
    assertEq(weakSessionCalls, 0, "local-only session cannot rescue failed verified auth");
    assertEq(verifiedAuthCalls > 0, true, "failed verified auth is still attempted");
    assertEq(stateVerifyCalls, 0, "ZERO sealed-state verification before verified auth");
    assertEq(stateVerifiedForUser, null, "no identity reaches state verification");
    assertEq(planResolutionCalls, 0, "ZERO plan reads after auth failure");
    assertEq(entitlementCalls, 0, "ZERO entitlement reads after auth failure");
    assertEq(connectionListCalls, 0, "ZERO connection reads after auth failure");
    assertEq(totalFetchCalls, 0, "ZERO external fetches after auth failure");
    assertEq(tokenExchangeCalls, 0, "ZERO Shopify token exchanges after auth failure");
    assertEq(shopProfileFetchCalls, 0, "ZERO Shopify GraphQL profile calls after auth failure");
    assertEq(webhookFetchCalls, 0, "ZERO Shopify webhook calls after auth failure");
    assertEq(persistenceWrites, 0, "ZERO connection writes after auth failure");
    assertEq(new URL(response.headers.get("location") ?? "https://invalid").searchParams.get("shopify"), "state_mismatch", "safe failure redirect");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Module as any)._load = originalLoad;
  globalThis.fetch = originalFetch;
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Module as any)._load = originalLoad;
  globalThis.fetch = originalFetch;
  console.error(error);
  process.exit(1);
});
