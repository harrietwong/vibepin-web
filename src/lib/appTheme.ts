export type AppTheme = "dark" | "light";

export const THEME_STORAGE_KEY = "vibepin-app-theme";

export function getStoredTheme(): AppTheme {
  if (typeof window === "undefined") return "dark";
  return localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
}

export function setStoredTheme(theme: AppTheme) {
  localStorage.setItem(THEME_STORAGE_KEY, theme);
}

export function toggleTheme(theme: AppTheme): AppTheme {
  return theme === "dark" ? "light" : "dark";
}
