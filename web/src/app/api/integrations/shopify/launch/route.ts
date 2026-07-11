/**
 * Shopify App URL entry point (WP2, §3.3 step 1).
 *
 * Shopify sends the merchant here with a signed `?shop&hmac&timestamp&…` query.
 *   1. Verify the launch query HMAC (fail → 401 hmac_invalid).
 *   2. Validate the shop domain (fail → 400 invalid_shop_domain).
 *   3. Logged in → run the same connect logic and 302 to authorize.
 *      Not logged in → 302 to /login and come back to the Shopify settings tab
 *      (shop pre-filled) so the merchant can finish the install.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getUserIdFromCookieSession } from "@/lib/server/authUser";
import { verifyLaunchQueryHmac } from "@/lib/server/shopify/hmac";
import {
  SHOPIFY_SETTINGS_PATH,
  isValidShopDomain,
  normalizeShopInput,
} from "@/lib/server/shopify/config";
import {
  SHOPIFY_OAUTH_STATE_COOKIE,
  shopifyStateCookieOptions,
} from "@/lib/server/shopify/oauthState";
import { prepareShopifyConnect } from "../connect/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  if (!verifyLaunchQueryHmac(params)) {
    return NextResponse.json({ error: "Invalid HMAC signature", code: "hmac_invalid" }, { status: 401 });
  }

  const shopInput = params.get("shop");
  if (!isValidShopDomain(shopInput)) {
    return NextResponse.json({ error: "Invalid shop domain", code: "invalid_shop_domain" }, { status: 400 });
  }
  const shop = normalizeShopInput(shopInput);

  const uid = await getUserIdFromCookieSession();
  if (!uid) {
    // Land the merchant back on the Shopify settings tab (shop pre-filled) after login.
    const next = `${SHOPIFY_SETTINGS_PATH}?shop=${shop}`;
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(next)}`;
    return NextResponse.redirect(url);
  }

  const prep = await prepareShopifyConnect(uid, shop, SHOPIFY_SETTINGS_PATH);
  if (!prep.ok) {
    const url = req.nextUrl.clone();
    url.pathname = SHOPIFY_SETTINGS_PATH;
    url.search = `?shopify=${prep.code}`;
    return NextResponse.redirect(url);
  }

  const res = NextResponse.redirect(prep.authorizeUrl);
  res.cookies.set(
    SHOPIFY_OAUTH_STATE_COOKIE,
    prep.sealedCookie,
    shopifyStateCookieOptions(req.nextUrl.protocol === "https:"),
  );
  return res;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
