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
import {
  SHOPIFY_SETTINGS_PATH,
  normalizeShopInput,
} from "@/lib/server/shopify/config";
import { prepareShopifyConnect } from "@/lib/server/shopify/connectPrep";
import {
  SHOPIFY_OAUTH_STATE_COOKIE,
  shopifyStateCookieOptions,
} from "@/lib/server/shopify/oauthState";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
