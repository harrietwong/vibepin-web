"use client";

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
import { createBrowserClient } from "@supabase/ssr";
import {
  DEFAULT_THEME,
  normalizeTheme,
  readLocalTheme,
  resolveTheme,
  systemTheme,
  writeLocalTheme,
  type ResolvedTheme,
  type ThemePreference,
} from "./themeStore";

type ThemeContextValue = {
  /** The raw user preference: "dark" | "light" | "system". */
  theme: ThemePreference;
  /** The concrete theme actually applied: "dark" | "light". */
  resolvedTheme: ResolvedTheme;
  /** Change the preference (persists to localStorage + user metadata). */
  setTheme: (theme: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

// Apply the stored theme synchronously before the browser paints, so heavy pages
// (e.g. the studio) never flash the SSR-default theme. Falls back to useEffect on
// the server to avoid the "useLayoutEffect does nothing on the server" warning.
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function ThemeProvider({ children }: { children: ReactNode }) {
  // `theme` is the user preference; `resolved` is what's actually painted.
  //
  // Both `theme` and `resolved` MUST start at the SSR default on the client too,
  // so the first client render matches the server. The real preference is read
  // from storage in the effect below — that changes the value (e.g. dark→light)
  // which forces a re-render that updates the `data-theme` attribute on the
  // shell. (The shell uses suppressHydrationWarning, so React will not patch the
  // attribute during hydration; only a genuine state change updates it.)
  const [theme, setThemeState] = useState<ThemePreference>(DEFAULT_THEME);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(DEFAULT_THEME));

  // ── Apply the local preference before paint (no FOUC on heavy pages) ──
  useIsoLayoutEffect(() => {
    const local = readLocalTheme();
    setThemeState(local);
    setResolved(resolveTheme(local));
  }, []);

  // ── Reconcile with the remote (user metadata) once authenticated ──
  // getSession() reads the session LOCALLY (no auth network round trip, no auth-lock
  // contention). appearanceTheme lives in user_metadata carried inside the session,
  // and the localStorage theme is already applied above, so this reconcile stays a
  // zero-network local read — important because this provider wraps every page,
  // including the OAuth-return Plan reload where a getUser() here serialized on the
  // auth lock ahead of the plan-data query.
  useEffect(() => {
    supabase.auth.getSession()
      .then(({ data }) => {
        const remote = data.session?.user?.user_metadata?.appearanceTheme;
        if (remote !== undefined && remote !== null) {
          const next = normalizeTheme(remote);
          setThemeState(next);
          setResolved(resolveTheme(next));
          writeLocalTheme(next);
        }
      })
      .catch(() => { /* logged out / offline — localStorage already applied */ });
  }, []);

  // ── Keep <html data-theme> in sync; clean up when leaving the app shell ──
  // <html> is the single source of truth for the active theme: the anti-FOUC
  // script sets it before first paint, this keeps it current, and every app
  // token/override cascades from it. Using a layout effect applies theme
  // switches before paint. Cleanup restores the prior value so marketing/landing
  // routes (rendered without this provider) are never force-themed.
  useIsoLayoutEffect(() => {
    const root = document.documentElement;
    const prev = root.getAttribute("data-theme");
    root.setAttribute("data-theme", resolved);
    return () => {
      if (prev) root.setAttribute("data-theme", prev);
      else root.removeAttribute("data-theme");
    };
  }, [resolved]);

  // ── React to OS changes while the user is on "system" ──
  useEffect(() => {
    if (theme !== "system" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(systemTheme());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((next: ThemePreference) => {
    setThemeState(next);
    setResolved(resolveTheme(next));
    writeLocalTheme(next);
    // Best-effort cross-device sync; never blocks the UI update.
    supabase.auth.updateUser({ data: { appearanceTheme: next } }).catch(() => {});
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme: resolved, setTheme }),
    [theme, resolved, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
