/**
 * Shopify OAuth callback (WP2, §3.3 steps 4–6).
 *
 *   1. Verify the launch query HMAC.
 *   2. Verify the sealed state cookie (state + uid + shop + expiry), then CLEAR
 *      it (single use) on every outcome.
 *   3. Exchange the code for an offline access token (8s timeout).
 *   4. Best-effort read shop { name primaryDomain { host } } via Admin GraphQL.
 *   5. Upsert the connection (token encrypted, scopes from the token response).
 *   6. Best-effort register the APP_UNINSTALLED webhook (never blocks).
 *   7. 302 back to the Settings Shopify tab with ?shopify=<code>.
 *
 * Any failure redirects with the matching §6.4 error code — never leaks the code,
 * token, or secret.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getUserIdFromCookieSession } from "@/lib/server/authUser";
import { resolvePlan, getEntitlements } from "@/lib/server/entitlements";
import { upsertConnection, listConnections } from "@/lib/server/shopify/connectionStore";
import { verifyLaunchQueryHmac } from "@/lib/server/shopify/hmac";
import {
  SHOPIFY_SETTINGS_PATH,
  getShopifyEnv,
  getShopifyApiVersion,
  getShopifyAppUrl,
  isShopifyConfigured,
} from "@/lib/server/shopify/config";
import {
  SHOPIFY_OAUTH_STATE_COOKIE,
  verifyShopifyState,
} from "@/lib/server/shopify/oauthState";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_EXCHANGE_TIMEOUT_MS = 8_000;

/** 302 back to the Settings Shopify tab and clear the single-use state cookie. */
function done(req: NextRequest, code: string): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = SHOPIFY_SETTINGS_PATH;
  url.search = `?shopify=${code}`;
  const res = NextResponse.redirect(url);
  res.cookies.set(SHOPIFY_OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}

type TokenResponse = { access_token?: string; scope?: string };

/** POST the authorization code for an offline access token (8s timeout). */
async function exchangeCode(shop: string, code: string): Promise<{ accessToken: string; scopes: string[] }> {
  const env = getShopifyEnv();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_EXCHANGE_TIMEOUT_MS);
  try {
    const resp = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: env.clientId,
        client_secret: env.clientSecret,
        code,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`token exchange HTTP ${resp.status}`);
    const data = (await resp.json()) as TokenResponse;
    if (!data.access_token) throw new Error("token exchange missing access_token");
    const scopes = (data.scope ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return { accessToken: data.access_token, scopes };
  } finally {
    clearTimeout(timer);
  }
}

/** Minimal Admin GraphQL call (8s timeout). Throws on non-200 / GraphQL errors. */
async function adminGraphql<T>(shop: string, token: string, query: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_EXCHANGE_TIMEOUT_MS);
  try {
    const resp = await fetch(`https://${shop}/admin/api/${getShopifyApiVersion()}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`admin graphql HTTP ${resp.status}`);
    const json = (await resp.json()) as { data?: T; errors?: unknown };
    if (json.errors) throw new Error("admin graphql returned errors");
    return json.data as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const code = params.get("code") ?? undefined;
  const stateParam = params.get("state") ?? undefined;
  const shopParam = params.get("shop") ?? undefined;

  if (!isShopifyConfigured()) return done(req, "config_error");
  if (!verifyLaunchQueryHmac(params)) return done(req, "hmac_invalid");

  const uid = await getUserIdFromCookieSession();
  if (!uid) return done(req, "state_mismatch");

  const cookieValue = req.cookies.get(SHOPIFY_OAUTH_STATE_COOKIE)?.value;
  const verdict = verifyShopifyState(cookieValue, stateParam, uid, shopParam);
  if (!verdict.ok) {
    if (verdict.reason !== "expired") {
      console.error("[shopify/callback] state verify failed:", verdict.reason);
    }
    return done(req, "state_mismatch");
  }
  if (!code) return done(req, "state_mismatch");

  const shop = verdict.shopDomain; // canonical, from the sealed cookie

  // Re-check the store cap at callback time (race between connect and callback).
  try {
    const plan = await resolvePlan(uid);
    const { maxStores } = getEntitlements(plan);
    const active = (await listConnections(uid)).filter((r) => r.disconnected_at == null);
    const alreadyThisShop = active.some((r) => r.shop_domain === shop);
    const otherStores = new Set(
      active.filter((r) => r.shop_domain !== shop).map((r) => r.shop_domain),
    ).size;
    if (!alreadyThisShop && otherStores >= maxStores) {
      return done(req, "plan_limit_stores");
    }
  } catch {
    return done(req, "config_error");
  }

  // ── Token exchange ─────────────────────────────────────────────────────────
  let token: { accessToken: string; scopes: string[] };
  try {
    token = await exchangeCode(shop, code);
  } catch (err) {
    console.error("[shopify/callback] token exchange failed:", (err as Error).message);
    return done(req, "token_exchange_failed");
  }

  // ── Shop profile (best effort) ─────────────────────────────────────────────
  let shopName: string | null = null;
  let primaryDomain: string | null = null;
  try {
    const data = await adminGraphql<{ shop?: { name?: string; primaryDomain?: { host?: string } } }>(
      shop,
      token.accessToken,
      "{ shop { name primaryDomain { host } } }",
    );
    shopName = data.shop?.name ?? null;
    primaryDomain = data.shop?.primaryDomain?.host ?? null;
  } catch (err) {
    console.warn("[shopify/callback] shop profile fetch failed (non-fatal):", (err as Error).message);
  }

  // ── Persist ────────────────────────────────────────────────────────────────
  try {
    await upsertConnection(uid, {
      shopDomain: shop,
      accessToken: token.accessToken,
      scopes: token.scopes,
      shopName,
      primaryDomain,
    });
  } catch (err) {
    console.error("[shopify/callback] persist failed:", (err as Error).message);
    return done(req, "config_error");
  }

  // ── Register app/uninstalled webhook (best effort) ─────────────────────────
  const appUrl = getShopifyAppUrl();
  if (appUrl) {
    const callbackUrl = `${appUrl}/api/integrations/shopify/webhooks`;
    const mutation = `mutation {
      webhookSubscriptionCreate(
        topic: APP_UNINSTALLED,
        webhookSubscription: { callbackUrl: ${JSON.stringify(callbackUrl)}, format: JSON }
      ) { userErrors { message } webhookSubscription { id } }
    }`;
    try {
      await adminGraphql(shop, token.accessToken, mutation);
    } catch (err) {
      console.warn("[shopify/callback] webhook registration failed (non-fatal):", (err as Error).message);
    }
  }

  return done(req, "connected");
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
