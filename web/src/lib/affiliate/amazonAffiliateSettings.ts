/**
 * amazonAffiliateSettings.ts — Creator's Amazon Associates settings (localStorage MVP).
 *
 * No backend user-settings table exists yet, so this is local/mock persistence.
 * Mirrors the brandProfileStore pattern: synchronous, SSR-safe, default on miss.
 */

import { normalizeMarketplace, type AmazonMarketplace } from "./amazon";

export type AmazonAffiliateSettings = {
  marketplace: AmazonMarketplace;
  trackingId: string;
  /**
   * Legacy flag. MVP readiness no longer depends on this — a present tracking ID
   * plus a valid marketplace is enough (see hasUsableAmazonSettings). Kept for
   * backward compatibility with previously-saved settings; new saves set it true.
   */
  enabled: boolean;
};

const STORE_KEY = "vp:amazon_affiliate_settings:v1";

export function defaultAmazonAffiliateSettings(): AmazonAffiliateSettings {
  return { marketplace: "US", trackingId: "", enabled: true };
}

function ok(): boolean { return typeof window !== "undefined"; }

export function getAmazonAffiliateSettings(): AmazonAffiliateSettings {
  if (!ok()) return defaultAmazonAffiliateSettings();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultAmazonAffiliateSettings();
    const p = JSON.parse(raw) as Partial<AmazonAffiliateSettings>;
    return {
      marketplace: normalizeMarketplace(p.marketplace),
      trackingId: typeof p.trackingId === "string" ? p.trackingId.trim() : "",
      enabled: typeof p.enabled === "boolean" ? p.enabled : true,
    };
  } catch {
    return defaultAmazonAffiliateSettings();
  }
}

export function saveAmazonAffiliateSettings(settings: AmazonAffiliateSettings): void {
  if (!ok()) return;
  const trackingId = settings.trackingId.trim();
  const clean: AmazonAffiliateSettings = {
    marketplace: normalizeMarketplace(settings.marketplace),
    trackingId,
    // MVP: presence of a tracking ID is the enable signal — keep the legacy flag
    // consistent so any old code paths reading `enabled` stay correct.
    enabled: trackingId.length > 0,
  };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(clean));
  } catch { /* quota exceeded — ignore */ }
}

/**
 * Settings are usable for link generation as soon as a tracking ID is present.
 * The marketplace always resolves to a valid value (normalized on read/write), so
 * a non-empty tracking tag is the only requirement. The legacy `enabled` flag is
 * intentionally NOT consulted — MVP has no separate enable step.
 */
export function hasUsableAmazonSettings(settings: AmazonAffiliateSettings | null | undefined): boolean {
  return !!settings && !!settings.trackingId.trim();
}
