/**
 * Brand profile — local workspace prefs (localStorage).
 * Feeds AI-generated Pin titles, descriptions, and keywords.
 */

import { makeSingletonAdapter } from "./userStoreSyncHelpers";

export type BrandProfile = {
  websiteUrl:         string;  // optional, used for context
  brandVoice:         string;  // e.g. "Friendly, practical, Pinterest-optimized"
  targetAudience:     string;  // e.g. "Gift buyers, home decor shoppers"
  productKeywords:    string;  // comma-separated keyword hints
  personalizeContent: boolean; // whether to use brand profile in AI prompts
  updatedAt?:         string;  // ISO — stamped on every save (account sync)
};

const STORE_KEY = "vp:brand_profile:v1";
export const BRAND_PROFILE_EVENT = "vp:brand_profile_updated";

export function defaultBrandProfile(): BrandProfile {
  return {
    websiteUrl:         "",
    brandVoice:         "",
    targetAudience:     "",
    productKeywords:    "",
    personalizeContent: true,
  };
}

function ok(): boolean { return typeof window !== "undefined"; }

function emit(): void {
  if (ok()) window.dispatchEvent(new Event(BRAND_PROFILE_EVENT));
}

export function getBrandProfile(): BrandProfile {
  if (!ok()) return defaultBrandProfile();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultBrandProfile();
    const p = JSON.parse(raw) as Partial<BrandProfile>;
    const d = defaultBrandProfile();
    return {
      websiteUrl:         typeof p.websiteUrl         === "string" ? p.websiteUrl         : d.websiteUrl,
      brandVoice:         typeof p.brandVoice         === "string" ? p.brandVoice         : d.brandVoice,
      targetAudience:     typeof p.targetAudience     === "string" ? p.targetAudience     : d.targetAudience,
      productKeywords:    typeof p.productKeywords    === "string" ? p.productKeywords    : d.productKeywords,
      personalizeContent: typeof p.personalizeContent === "boolean" ? p.personalizeContent : d.personalizeContent,
      updatedAt:          typeof p.updatedAt          === "string" ? p.updatedAt          : undefined,
    };
  } catch {
    return defaultBrandProfile();
  }
}

export function saveBrandProfile(profile: BrandProfile): void {
  if (!ok()) return;
  const payload: BrandProfile = { ...profile, updatedAt: new Date().toISOString() };
  localStorage.setItem(STORE_KEY, JSON.stringify(payload));
  emit();
}

/**
 * Account-level sync adapter (WP-B). Singleton doc under storeKey `brand_profile`.
 * Same localStorage key + event as the getter/setter, so AI prompt callers and the
 * Settings UI are unaffected; the engine adds cross-device persistence.
 */
export const brandProfileSyncAdapter = makeSingletonAdapter<BrandProfile>({
  storeKey: "brand_profile",
  eventName: BRAND_PROFILE_EVENT,
  localStorageKey: STORE_KEY,
  docId: "profile",
  emit,
});
