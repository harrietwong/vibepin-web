"use client";

/**
 * Admin console chrome state: theme (light/dark) + UI language (EN/中文).
 *
 * Fully independent of the client app's ThemeProvider / LocaleProvider —
 * separate localStorage keys, separate `data-admin-theme` DOM attribute,
 * separate small dictionary. Never touches `/app/*` state.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_ADMIN_THEME,
  readLocalAdminTheme,
  writeLocalAdminTheme,
  type AdminThemePreference,
} from "@/lib/admin/adminTheme";
import {
  DEFAULT_ADMIN_LANGUAGE,
  readLocalAdminLanguage,
  writeLocalAdminLanguage,
  adminT,
  adminTFmt,
  type AdminLanguage,
  type AdminMessageKey,
} from "@/lib/admin/adminMessages";

type AdminChromeContextValue = {
  theme: AdminThemePreference;
  setTheme: (theme: AdminThemePreference) => void;
  lang: AdminLanguage;
  setLang: (lang: AdminLanguage) => void;
  t: (key: AdminMessageKey) => string;
  tFmt: (key: AdminMessageKey, vars: Record<string, string | number>) => string;
};

const AdminChromeContext = createContext<AdminChromeContextValue | null>(null);

// SSR-safe: useLayoutEffect only in the browser, avoiding the Next.js server warning.
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function AdminChromeProvider({ children }: { children: ReactNode }) {
  // Must start at the SSR default so the first client render matches the
  // server; the real preference is applied in the layout effect below (the
  // inline bootstrap script in the root layout already avoids a visible flash
  // by setting the DOM attribute before React hydrates).
  const [theme, setThemeState] = useState<AdminThemePreference>(DEFAULT_ADMIN_THEME);
  const [lang, setLangState] = useState<AdminLanguage>(DEFAULT_ADMIN_LANGUAGE);

  useIsoLayoutEffect(() => {
    setThemeState(readLocalAdminTheme());
    setLangState(readLocalAdminLanguage());
  }, []);

  useIsoLayoutEffect(() => {
    document.documentElement.setAttribute("data-admin-theme", theme);
  }, [theme]);

  const setTheme = useCallback((next: AdminThemePreference) => {
    setThemeState(next);
    writeLocalAdminTheme(next);
  }, []);

  const setLang = useCallback((next: AdminLanguage) => {
    setLangState(next);
    writeLocalAdminLanguage(next);
  }, []);

  const t = useCallback((key: AdminMessageKey) => adminT(lang, key), [lang]);
  const tFmt = useCallback(
    (key: AdminMessageKey, vars: Record<string, string | number>) => adminTFmt(lang, key, vars),
    [lang],
  );

  const value = useMemo<AdminChromeContextValue>(
    () => ({ theme, setTheme, lang, setLang, t, tFmt }),
    [theme, setTheme, lang, setLang, t, tFmt],
  );

  return <AdminChromeContext.Provider value={value}>{children}</AdminChromeContext.Provider>;
}

export function useAdminChrome(): AdminChromeContextValue {
  const ctx = useContext(AdminChromeContext);
  if (!ctx) throw new Error("useAdminChrome must be used within AdminChromeProvider");
  return ctx;
}
