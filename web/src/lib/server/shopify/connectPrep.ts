import { resolvePlan, getEntitlements } from "@/lib/server/entitlements";
import { listConnections } from "@/lib/server/shopify/connectionStore";
import {
  buildAuthorizeUrl,
  isShopifyConfigured,
  isValidShopDomain,
  normalizeShopInput,
} from "@/lib/server/shopify/config";
import { generateShopifyState, sealShopifyState } from "@/lib/server/shopify/oauthState";

export type ConnectPrep =
  | { ok: true; shopDomain: string; authorizeUrl: string; sealedCookie: string }
  | { ok: false; status: number; code: string; error: string };

/** Shared transport-independent Shopify OAuth preparation. */
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
  const plan = await resolvePlan(userId);
  const { maxStores } = getEntitlements(plan);

  let active: Array<{ shop_domain: string; status: string }> = [];
  try {
    const rows = await listConnections(userId);
    active = rows.filter(row => row.disconnected_at == null);
  } catch {
    return { ok: false, status: 500, code: "config_error", error: "Shopify store storage is unavailable" };
  }

  if (active.some(row => row.shop_domain === shopDomain && row.status === "connected")) {
    return { ok: false, status: 409, code: "already_connected", error: "This store is already connected" };
  }

  const activeOtherStores = new Set(
    active.filter(row => row.shop_domain !== shopDomain).map(row => row.shop_domain),
  ).size;
  if (activeOtherStores >= maxStores) {
    return { ok: false, status: 403, code: "plan_limit_stores", error: "Store limit reached for your plan" };
  }

  try {
    const state = generateShopifyState();
    return {
      ok: true,
      shopDomain,
      authorizeUrl: buildAuthorizeUrl(shopDomain, state),
      sealedCookie: sealShopifyState(state, userId, shopDomain, returnTo),
    };
  } catch (err) {
    console.error("[shopify/connect] seal state failed:", (err as Error).message);
    return { ok: false, status: 500, code: "config_error", error: "Shopify OAuth could not be started" };
  }
}
