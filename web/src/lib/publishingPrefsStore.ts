/**
 * Publishing preferences — local workspace prefs (localStorage).
 * Controls weekly goal, default mode, format, and safety check toggles.
 */

import { makeSingletonAdapter } from "./userStoreSyncHelpers";

export type PublishingMode   = "manual" | "smart";
export type PublishingFormat = "standard" | "simplified";

export type PublishingPrefs = {
  weeklyGoal:          number;           // 1–14, default 5
  defaultMode:         PublishingMode;   // default "manual"
  defaultFormat:       PublishingFormat; // default "standard"
  duplicateUrlWarning: boolean;          // default true
  showAltTextField:    boolean;          // default true
  imageRefresh:        boolean;          // default false
  updatedAt?:          string;           // ISO — stamped on every save (account sync)
};

const STORE_KEY = "vp:publishing_prefs:v1";
export const PUBLISHING_PREFS_EVENT = "vp:publishing_prefs_updated";

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

function emit(): void {
  if (ok()) window.dispatchEvent(new Event(PUBLISHING_PREFS_EVENT));
}

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
      updatedAt:           typeof p.updatedAt === "string" ? p.updatedAt : undefined,
    };
  } catch {
    return defaultPublishingPrefs();
  }
}

export function savePublishingPrefs(prefs: PublishingPrefs): void {
  if (!ok()) return;
  const payload: PublishingPrefs = { ...prefs, updatedAt: new Date().toISOString() };
  localStorage.setItem(STORE_KEY, JSON.stringify(payload));
  emit();
}

/**
 * Account-level sync adapter (WP-B). Singleton doc under storeKey `publishing_prefs`.
 * Reads/writes the same localStorage key + event as the getters/setters above, so
 * the Settings UI keeps working unchanged; the engine adds cross-device persistence.
 */
export const publishingPrefsSyncAdapter = makeSingletonAdapter<PublishingPrefs>({
  storeKey: "publishing_prefs",
  eventName: PUBLISHING_PREFS_EVENT,
  localStorageKey: STORE_KEY,
  docId: "prefs",
  emit,
});
