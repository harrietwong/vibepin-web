/** Canonical dark-app Settings routes (English UI). */

export const SETTINGS_PINTEREST_PATH = "/app/settings/pinterest";
export const SETTINGS_SHOPIFY_PATH = "/app/settings/shopify";
export const SETTINGS_SOCIAL_PATH = "/app/settings/social";
export const SETTINGS_PROFILE_PATH = "/app/settings/profile";
export const SETTINGS_BILLING_PATH = "/app/settings/billing";
export const SETTINGS_LANGUAGE_PATH = "/app/settings/language";
export const SETTINGS_WORKSPACE_PATH = "/app/settings/workspace";
export const SETTINGS_SUPPORT_PATH = "/app/settings/support";

/**
 * Settings now opens on Social accounts: Pinterest is one platform among several,
 * so it no longer owns a top-level section (PRD §2). SETTINGS_PINTEREST_PATH is
 * kept only as a redirect stub — see app/app/settings/pinterest/page.tsx — so old
 * bookmarks and any historical OAuth return URL still land somewhere real.
 */
export const SETTINGS_DEFAULT_PATH = SETTINGS_SOCIAL_PATH;

export type SettingsSectionId =
  | "profile"
  | "billing"
  | "social"
  | "language"
  | "workspace"
  | "support";

export const SETTINGS_NAV: { id: SettingsSectionId; href: string; label: string }[] = [
  { id: "profile", href: SETTINGS_PROFILE_PATH, label: "Profile" },
  { id: "billing", href: SETTINGS_BILLING_PATH, label: "Billing & Credits" },
  { id: "social", href: SETTINGS_SOCIAL_PATH, label: "Social accounts" },
  { id: "language", href: SETTINGS_LANGUAGE_PATH, label: "Language & Region" },
  { id: "workspace", href: SETTINGS_WORKSPACE_PATH, label: "Workspace" },
  { id: "support", href: SETTINGS_SUPPORT_PATH, label: "Support" },
];
