/**
 * Brand profile — local workspace prefs (localStorage).
 * Feeds AI-generated Pin titles, descriptions, and keywords.
 */

export type BrandProfile = {
  websiteUrl:         string;  // optional, used for context
  brandVoice:         string;  // e.g. "Friendly, practical, Pinterest-optimized"
  targetAudience:     string;  // e.g. "Gift buyers, home decor shoppers"
  productKeywords:    string;  // comma-separated keyword hints
  personalizeContent: boolean; // whether to use brand profile in AI prompts
};

const STORE_KEY = "vp:brand_profile:v1";

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
    };
  } catch {
    return defaultBrandProfile();
  }
}

export function saveBrandProfile(profile: BrandProfile): void {
  if (!ok()) return;
  localStorage.setItem(STORE_KEY, JSON.stringify(profile));
}
