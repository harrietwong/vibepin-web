/**
 * Publishing preferences — local workspace prefs (localStorage).
 * Controls weekly goal, default mode, format, and safety check toggles.
 */

export type PublishingMode   = "manual" | "smart";
export type PublishingFormat = "standard" | "simplified";

export type PublishingPrefs = {
  weeklyGoal:          number;           // 1–14, default 5
  defaultMode:         PublishingMode;   // default "manual"
  defaultFormat:       PublishingFormat; // default "standard"
  duplicateUrlWarning: boolean;          // default true
  showAltTextField:    boolean;          // default true
  imageRefresh:        boolean;          // default false
};

const STORE_KEY = "vp:publishing_prefs:v1";

export function defaultPublishingPrefs(): PublishingPrefs {
  return {
    weeklyGoal:          5,
    defaultMode:         "manual",
    defaultFormat:       "standard",
    duplicateUrlWarning: true,
    showAltTextField:    true,
    imageRefresh:        false,
  };
}

function ok(): boolean { return typeof window !== "undefined"; }

export function getPublishingPrefs(): PublishingPrefs {
  if (!ok()) return defaultPublishingPrefs();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultPublishingPrefs();
    const p = JSON.parse(raw) as Partial<PublishingPrefs>;
    const d = defaultPublishingPrefs();
    return {
      weeklyGoal:          typeof p.weeklyGoal === "number" ? Math.min(14, Math.max(1, p.weeklyGoal)) : d.weeklyGoal,
      defaultMode:         p.defaultMode === "smart" ? "smart" : d.defaultMode,
      defaultFormat:       p.defaultFormat === "simplified" ? "simplified" : d.defaultFormat,
      duplicateUrlWarning: typeof p.duplicateUrlWarning === "boolean" ? p.duplicateUrlWarning : d.duplicateUrlWarning,
      showAltTextField:    typeof p.showAltTextField    === "boolean" ? p.showAltTextField    : d.showAltTextField,
      imageRefresh:        typeof p.imageRefresh        === "boolean" ? p.imageRefresh        : d.imageRefresh,
    };
  } catch {
    return defaultPublishingPrefs();
  }
}

export function savePublishingPrefs(prefs: PublishingPrefs): void {
  if (!ok()) return;
  localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
}
