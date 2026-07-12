/**
 * shopifyGrounding.ts — WP6 (§3.7.2 of the Phase 1 Shopify implementation plan):
 * weaves Shopify-only product fields (vendor/tags/price/availability) into the
 * AI Copy vision-fallback prompt context.
 *
 * Lives in its own module rather than:
 *   - inline in `api/ai-copy/route.ts` — a Next.js app-router route file may only
 *     export route handlers/config (route.ts:16-24 already document this
 *     constraint for why `buildContextBlock` itself lives in visionServer.ts, not
 *     the route), so a helper meant to be unit-tested directly can't live there;
 *   - inside `visionServer.ts` — this WP does not touch that file (it already
 *     supports Shopify CDN image fetching unchanged, §3.7.3).
 *
 * `appendShopifyProductDetails` is applied AFTER `buildContextBlock` (never
 * folded into it) so visionServer.ts stays untouched while the final prompt
 * context still carries the extra fields when present.
 */

export type ShopifyGroundingFields = {
  vendor?: string;
  tags?: string[];
  /** Display-formatted, currency already folded in (e.g. "USD 19.99"). */
  price?: string;
  availability?: string;
};

/**
 * Appends onto `buildContextBlock`'s output. Only emits a line when at least one
 * of its fields is actually present (§3.7.2 "price/availability 仅在非空时输出一
 * 行") — never fabricates vendor/tags/price/availability that aren't on the
 * snapshot. Returns `contextBlock` unchanged when there is nothing to add.
 */
export function appendShopifyProductDetails(contextBlock: string, pc: ShopifyGroundingFields): string {
  const details: string[] = [];
  if (pc.vendor) details.push(pc.vendor);
  if (pc.tags?.length) details.push(pc.tags.slice(0, 10).join(", "));

  const lines = [contextBlock];
  if (details.length) {
    lines.push(`Product details (name may stay as originally written; translate/paraphrase concepts): ${details.join(" | ")}`);
  }
  const priceLine = [pc.price, pc.availability].filter(Boolean).join(" — ");
  if (priceLine) lines.push(`Price/availability (context only, do not invent): ${priceLine}`);
  return lines.join("\n");
}
