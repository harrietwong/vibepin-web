/**
 * Admin console theme — independent of the client app's ThemeProvider/themeStore.
 *
 * Separate localStorage key, separate `data-admin-theme` DOM attribute, separate
 * CSS variables (--admin-*) in globals.css. Never reads/writes the client app's
 * `vp:appearance_theme:v1` key or `data-theme` attribute, so opening admin pages
 * can never affect a customer's app appearance and vice versa.
 */

export type AdminThemePreference = "light" | "dark";

export const ADMIN_THEME_STORAGE_KEY = "vibepin-admin-theme";
export const DEFAULT_ADMIN_THEME: AdminThemePreference = "light";

export function normalizeAdminTheme(value: unknown): AdminThemePreference {
  return value === "dark" ? "dark" : DEFAULT_ADMIN_THEME;
}

function ok(): boolean {
  return typeof window !== "undefined";
}

export function readLocalAdminTheme(): AdminThemePreference {
  if (!ok()) return DEFAULT_ADMIN_THEME;
  try {
    return normalizeAdminTheme(localStorage.getItem(ADMIN_THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_ADMIN_THEME;
  }
}

export function writeLocalAdminTheme(theme: AdminThemePreference): void {
  if (!ok()) return;
  try {
    localStorage.setItem(ADMIN_THEME_STORAGE_KEY, theme);
  } catch {
    /* storage unavailable (private mode / quota) — non-fatal */
  }
}
