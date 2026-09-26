import type { MarketplaceId } from "./types";

/**
 * FR-04: recognise the four marketplaces that get a manual-entry fallback card
 * instead of a plain "not supported" failure. Pure hostname classification, no
 * network. Country subdomains (e.g. `m.tiktok.com`, `www.aliexpress.us`) match via
 * the same suffix logic as `isBlockedMarketplace`. `tiktok.com` and `tiktokshop.com`
 * both classify as `tiktok_shop` — TikTok Shop listings are reachable from either
 * host and the PRD names only Instagram (a different property) as the carve-out.
 * Returns null for everything else, including Instagram (not a marketplace — stays
 * a generic `failed` result) and Amazon (its own text-only channel).
 *
 * Lives in its own module (not urlSecurity.ts) because the Studio card imports it in
 * the browser bundle; urlSecurity.ts pulls in `node:net` and the fetch-og DNS guard
 * (`node:dns/promises`), which a client chunk cannot contain.
 */
export function classifyManualMarketplace(hostname: string): MarketplaceId | null {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  const matches = (suffix: string) => host === suffix || host.endsWith(`.${suffix}`);
  if (matches("temu.com")) return "temu";
  if (matches("shein.com")) return "shein";
  if (matches("aliexpress.com") || matches("aliexpress.us")) return "aliexpress";
  if (matches("tiktok.com") || matches("tiktokshop.com")) return "tiktok_shop";
  return null;
}
