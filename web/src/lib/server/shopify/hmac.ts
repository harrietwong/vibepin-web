/**
 * Shopify HMAC verification (server-only, WP2).
 *
 * Two distinct signatures share SHOPIFY_CLIENT_SECRET as the key:
 *   - Launch / OAuth callback query params: HMAC-SHA256 hex over the sorted
 *     `k=v&…` query string (excluding the `hmac` param itself).
 *   - Webhook bodies: HMAC-SHA256 base64 over the raw request body, compared
 *     against the `X-Shopify-Hmac-Sha256` header.
 *
 * Both compare in constant time via safeEqual (which checks length first, so a
 * length mismatch short-circuits before the timing-safe digest compare). Both
 * fail closed (return false) when the secret is not configured — never throw.
 */

import { createHmac } from "node:crypto";
import { safeEqual } from "../crypto";
import { shopifyClientSecret } from "./config";

/**
 * Verify the `hmac` query param on a launch / OAuth callback request.
 *
 * Message construction (Shopify spec): drop `hmac`, sort the remaining keys
 * lexicographically, join `key=value` pairs with `&` (values URL-decoded, as
 * URLSearchParams already returns them; repeated keys joined by `,`), then
 * HMAC-SHA256 with the client secret and compare the lowercase hex digest.
 */
export function verifyLaunchQueryHmac(searchParams: URLSearchParams): boolean {
  const provided = searchParams.get("hmac");
  const secret = shopifyClientSecret();
  if (!provided || !secret) return false;

  const seen = new Set<string>();
  const keys: string[] = [];
  for (const key of searchParams.keys()) {
    if (key === "hmac") continue;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  keys.sort();

  const message = keys
    .map((key) => `${key}=${searchParams.getAll(key).join(",")}`)
    .join("&");

  const digest = createHmac("sha256", secret).update(message, "utf8").digest("hex");
  return safeEqual(digest, provided);
}

/**
 * Verify a webhook body against the base64 `X-Shopify-Hmac-Sha256` header.
 * `rawBody` MUST be the exact unparsed body (the route reads it via req.text()).
 */
export function verifyWebhookHmac(rawBody: string, headerBase64: string | null | undefined): boolean {
  const secret = shopifyClientSecret();
  if (!secret || !headerBase64) return false;
  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  return safeEqual(digest, headerBase64);
}
