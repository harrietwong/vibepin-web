/**
 * amazonAffiliateSettings.ts — Creator's Amazon Associates settings (localStorage MVP).
 *
 * No backend user-settings table exists yet, so this is local/mock persistence.
 * Mirrors the brandProfileStore pattern: synchronous, SSR-safe, default on miss.
 */

import { normalizeMarketplace, type AmazonMarketplace } from "./amazon";
import { makeSingletonAdapter } from "../userStoreSyncHelpers";

export type AmazonAffiliateSettings = {
  marketplace: AmazonMarketplace;
  trackingId: string;
  /**
   * Legacy flag. MVP readiness no longer depends on this — a present tracking ID
   * plus a valid marketplace is enough (see hasUsableAmazonSettings). Kept for
   * backward compatibility with previously-saved settings; new saves set it true.
   */
  enabled: boolean;
  /** ISO — stamped on every save (account sync LWW key). */
  updatedAt?: string;
  /**
   * One-time Amazon risk notice (design §5, ruling 8): the notice version the user
   * acknowledged, and when. A UX preference that rides this synced singleton — NOT a
   * legal consent record. Bumping AMAZON_RISK_NOTICE_VERSION shows the notice again.
   */
  riskNoticeAckVersion?: number;
  riskNoticeAckAt?: string;
};

/** Bump when the risk notice text changes materially — everyone sees it once more. */
export const AMAZON_RISK_NOTICE_VERSION = 1;

const STORE_KEY = "vp:amazon_affiliate_settings:v1";
export const AMAZON_AFFILIATE_SETTINGS_EVENT = "vp:amazon_affiliate_settings_updated";

export function defaultAmazonAffiliateSettings(): AmazonAffiliateSettings {
  return { marketplace: "US", trackingId: "", enabled: true };
}

function ok(): boolean { return typeof window !== "undefined"; }

function emit(): void {
  if (ok()) window.dispatchEvent(new Event(AMAZON_AFFILIATE_SETTINGS_EVENT));
}

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
      updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : undefined,
      ...(typeof p.riskNoticeAckVersion === "number" ? { riskNoticeAckVersion: p.riskNoticeAckVersion } : {}),
      ...(typeof p.riskNoticeAckAt === "string" ? { riskNoticeAckAt: p.riskNoticeAckAt } : {}),
    };
  } catch {
    return defaultAmazonAffiliateSettings();
  }
}

export function saveAmazonAffiliateSettings(settings: AmazonAffiliateSettings): void {
  if (!ok()) return;
  const trackingId = settings.trackingId.trim();
  // The Settings form only edits marketplace + tag; carry the stored risk-notice
  // acknowledgement through so saving the tag never re-shows the notice.
  const stored = getAmazonAffiliateSettings();
  const ackVersion = settings.riskNoticeAckVersion ?? stored.riskNoticeAckVersion;
  const ackAt = settings.riskNoticeAckAt ?? stored.riskNoticeAckAt;
  const clean: AmazonAffiliateSettings = {
    marketplace: normalizeMarketplace(settings.marketplace),
    trackingId,
    // MVP: presence of a tracking ID is the enable signal — keep the legacy flag
    // consistent so any old code paths reading `enabled` stay correct.
    enabled: trackingId.length > 0,
    updatedAt: new Date().toISOString(),
    ...(ackVersion !== undefined ? { riskNoticeAckVersion: ackVersion } : {}),
    ...(ackAt !== undefined ? { riskNoticeAckAt: ackAt } : {}),
  };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(clean));
    emit();
  } catch { /* quota exceeded — ignore */ }
}

/**
 * Account-level sync adapter (WP-B). Singleton doc under storeKey
 * `amazon_affiliate_settings`. This carries the creator's affiliate tracking ID —
 * correctness-critical — so LWW is keyed strictly on `updatedAt`: a server value is
 * only written locally when it is STRICTLY newer than the local one. Same
 * localStorage key + event as the getter/setter (link generation reads it via
 * getAmazonAffiliateSettings), so nothing downstream changes.
 */
export const amazonAffiliateSettingsSyncAdapter = makeSingletonAdapter<AmazonAffiliateSettings>({
  storeKey: "amazon_affiliate_settings",
  eventName: AMAZON_AFFILIATE_SETTINGS_EVENT,
  localStorageKey: STORE_KEY,
  docId: "settings",
  emit,
});

/** True when the current risk notice version has been acknowledged on this account. */
export function hasAcknowledgedAmazonRiskNotice(settings: AmazonAffiliateSettings | null | undefined = getAmazonAffiliateSettings()): boolean {
  return (settings?.riskNoticeAckVersion ?? 0) >= AMAZON_RISK_NOTICE_VERSION;
}

/**
 * Record the acknowledgement (merge-write, bumps updatedAt so the account sync LWW
 * carries it to the server; an older device's stale doc can never un-acknowledge it).
 */
export function acknowledgeAmazonRiskNotice(now: string = new Date().toISOString()): void {
  if (!ok()) return;
  const current = getAmazonAffiliateSettings();
  const next: AmazonAffiliateSettings = {
    ...current,
    riskNoticeAckVersion: AMAZON_RISK_NOTICE_VERSION,
    riskNoticeAckAt: now,
    updatedAt: now,
  };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
    emit();
  } catch { /* quota exceeded — the notice simply shows again next time */ }
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
