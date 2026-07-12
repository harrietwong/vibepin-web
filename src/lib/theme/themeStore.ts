/**
 * Appearance theme — global light/dark preference.
 *
 * Persistence strategy:
 *   1. localStorage (primary, instant, works logged-out)   — plain string value
 *   2. Supabase user_metadata.appearanceTheme (best-effort) — syncs across devices
 *
 * The value is stored as a RAW string (not JSON) so the anti-FOUC inline script
 * in the root layout can read it synchronously without a JSON.parse.
 */

export type ThemePreference = "dark" | "light" | "system";
export type ResolvedTheme   = "dark" | "light";

export const THEME_STORAGE_KEY = "vp:appearance_theme:v1";
export const DEFAULT_THEME: ThemePreference = "dark";

export function normalizeTheme(value: unknown): ThemePreference {
  return value === "light" || value === "system" || value === "dark"
    ? value
    : DEFAULT_THEME;
}

function ok(): boolean {
  return typeof window !== "undefined";
}

export function readLocalTheme(): ThemePreference {
  if (!ok()) return DEFAULT_THEME;
  try {
    return normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

export function writeLocalTheme(theme: ThemePreference): void {
  if (!ok()) return;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* storage unavailable (private mode / quota) — non-fatal */
  }
}

/** The OS-level preference, used when the user picks "system". */
export function systemTheme(): ResolvedTheme {
  if (!ok() || typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Resolve a (possibly "system") preference to a concrete light/dark value. */
export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  return pref === "system" ? systemTheme() : pref;
}
