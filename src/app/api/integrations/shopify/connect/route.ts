/**
 * Shopify OAuth start (WP2). Two entry points:
 *
 *   GET  — browser navigation (cookie session). Sets the sealed state cookie and
 *          302-redirects to Shopify's authorize page. On failure redirects to the
 *          Settings Shopify tab with ?shopify=<code>.
 *   POST — Settings "Connect" button (Bearer). Returns { url } + Set-Cookie so the
 *          client can navigate to authorize itself.
 *
 * Both share prepareShopifyConnect() — the launch route reuses it too so a
 * Shopify-initiated (App URL) install and a VibePin-initiated connect run the
 * exact same entitlement + state-sealing logic.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  getUserIdFromBearer,
  getUserIdFromCookieSession,
} from "@/lib/server/authUser";
import { resolvePlan, getEntitlements } from "@/lib/server/entitlements";
import { listConnections } from "@/lib/server/shopify/connectionStore";
import {
  SHOPIFY_SETTINGS_PATH,
  buildAuthorizeUrl,
  isShopifyConfigured,
  isValidShopDomain,
  normalizeShopInput,
} from "@/lib/server/shopify/config";
import {
  SHOPIFY_OAUTH_STATE_COOKIE,
  generateShopifyState,
  sealShopifyState,
  shopifyStateCookieOptions,
} from "@/lib/server/shopify/oauthState";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Result of preparing an OAuth start: either an authorize URL + sealed cookie, or a coded error. */
export type ConnectPrep =
  | { ok: true; shopDomain: string; authorizeUrl: string; sealedCookie: string }
  | { ok: false; status: number; code: string; error: string };

/**
 * Shared connect logic (§3.3 step 3): config gate → shop-domain validation →
 * entitlement/active-store checks → generate + seal state → authorize URL.
 * Pure of transport concerns; both routes and /launch consume this.
 */
export async function prepareShopifyConnect(
  userId: string,
  shopInput: string | null | undefined,
  returnTo: string,
): Promise<ConnectPrep> {
  if (!isShopifyConfigured()) {
    return { ok: false, status: 500, code: "config_error", error: "Shopify is not configured" };
  }
  if (!isValidShopDomain(shopInput)) {
    return { ok: false, status: 400, code: "invalid_shop_domain", error: "Invalid shop domain" };
  }
  const shopDomain = normalizeShopInput(shopInput);

  // Entitlement + active-store gate (决策 3 / §6.2).
  const plan = await resolvePlan(userId);
  const { maxStores } = getEntitlements(plan);

  let active: Array<{ shop_domain: string; status: string }> = [];
  try {
    const rows = await listConnections(userId);
    active = rows.filter((r) => r.disconnected_at == null);
  } catch {
    // Unexpected storage error — fail safe as a config error (no partial connect).
    return { ok: false, status: 500, code: "config_error", error: "Shopify store storage is unavailable" };
  }

  // Same shop already healthy-connected → guide the user to Reconnect instead.
  const sameShopHealthy = active.some(
    (r) => r.shop_domain === shopDomain && r.status === "connected",
  );
  if (sameShopHealthy) {
    return { ok: false, status: 409, code: "already_connected", error: "This store is already connected" };
  }

  // Plan store cap counts distinct active stores OTHER than the one being (re)connected.
  const activeOtherStores = new Set(
    active.filter((r) => r.shop_domain !== shopDomain).map((r) => r.shop_domain),
  ).size;
  if (activeOtherStores >= maxStores) {
    return { ok: false, status: 403, code: "plan_limit_stores", error: "Store limit reached for your plan" };
  }

  try {
    const state = generateShopifyState();
    const sealedCookie = sealShopifyState(state, userId, shopDomain, returnTo);
    const authorizeUrl = buildAuthorizeUrl(shopDomain, state);
    return { ok: true, shopDomain, authorizeUrl, sealedCookie };
  } catch (err) {
    console.error("[shopify/connect] seal state failed:", (err as Error).message);
    return { ok: false, status: 500, code: "config_error", error: "Shopify OAuth could not be started" };
  }
}

function isSecureReq(req: NextRequest): boolean {
  return req.nextUrl.protocol === "https:";
}

function settingsRedirect(req: NextRequest, code: string): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = SHOPIFY_SETTINGS_PATH;
  url.search = `?shopify=${code}`;
  return NextResponse.redirect(url);
}

function loginRedirect(req: NextRequest, next: string): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(next)}`;
  return NextResponse.redirect(url);
}

// ── GET: browser navigation ────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const shopInput = req.nextUrl.searchParams.get("shop");
  const uid = await getUserIdFromCookieSession();
  if (!uid) {
    const shop = normalizeShopInput(shopInput);
    const next = shop ? `${SHOPIFY_SETTINGS_PATH}?shop=${shop}` : SHOPIFY_SETTINGS_PATH;
    return loginRedirect(req, next);
  }

  const prep = await prepareShopifyConnect(uid, shopInput, SHOPIFY_SETTINGS_PATH);
  if (!prep.ok) {
    return settingsRedirect(req, prep.code);
  }
  const res = NextResponse.redirect(prep.authorizeUrl);
  res.cookies.set(SHOPIFY_OAUTH_STATE_COOKIE, prep.sealedCookie, shopifyStateCookieOptions(isSecureReq(req)));
  return res;
}

// ── POST: Settings "Connect" button (Bearer) ───────────────────────────────
export async function POST(req: NextRequest) {
  const uid = await getUserIdFromBearer(req);
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
  }

  let shopDomain: string | null = null;
  try {
    const body = (await req.json()) as { shopDomain?: string };
    shopDomain = body?.shopDomain ?? null;
  } catch {
    /* empty/invalid body → treated as missing shop below */
  }

  const prep = await prepareShopifyConnect(uid, shopDomain, SHOPIFY_SETTINGS_PATH);
  if (!prep.ok) {
    return NextResponse.json({ error: prep.error, code: prep.code }, { status: prep.status });
  }

  const res = NextResponse.json({ url: prep.authorizeUrl });
  res.cookies.set(SHOPIFY_OAUTH_STATE_COOKIE, prep.sealedCookie, shopifyStateCookieOptions(isSecureReq(req)));
  return res;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
