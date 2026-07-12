"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createBrowserClient } from "@supabase/ssr";
import { toast } from "sonner";
import {
  DEFAULT_LOCALE_PREFERENCES,
  LOCALE_STORAGE_KEY,
  normalizeLocalePreferences,
  resolveContentLanguage,
  languageDirection,
  htmlLangAttr,
  type LocalePreferences,
  type LanguageCode,
  type ContentLanguageSetting,
  type PinterestRegionCode,
} from "./config";
import { getMessages } from "./messages";
import type { MessageKey } from "./messages/en";

type LocaleContextValue = {
  preferences: LocalePreferences;
  resolvedContentLanguage: LanguageCode;
  t: (key: MessageKey) => string;
  saving: boolean;
  languageModalOpen: boolean;
  openLanguageModal: () => void;
  closeLanguageModal: () => void;
  savePreferences: (patch: Partial<LocalePreferences>) => Promise<void>;
  setDraftPreferences: (patch: Partial<LocalePreferences>) => void;
  draftPreferences: LocalePreferences;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

function readLocalPrefs(): LocalePreferences {
  if (typeof window === "undefined") return DEFAULT_LOCALE_PREFERENCES;
  try {
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (!raw) return DEFAULT_LOCALE_PREFERENCES;
    return normalizeLocalePreferences(JSON.parse(raw));
  } catch {
    return DEFAULT_LOCALE_PREFERENCES;
  }
}

function writeLocalPrefs(prefs: LocalePreferences) {
  localStorage.setItem(LOCALE_STORAGE_KEY, JSON.stringify(prefs));
}

async function loadRemotePrefs(): Promise<LocalePreferences | null> {
  // getSession() reads the cookie-backed session LOCALLY — no auth network
  // verification round trip and no auth-lock contention. `user_metadata` is carried
  // inside the session, so this returns exactly what getUser() would, but without
  // adding a slow cross-border call to every app mount. This provider wraps the whole
  // app, so on the OAuth-return Plan reload a getUser() here serialized on the auth
  // lock ahead of the plan-data query. Local prefs are already applied first, so this
  // remote reconcile is non-critical.
  const { data: { session } } = await supabase.auth.getSession();
  const user = session?.user;
  if (!user) return null;
  const meta = user.user_metadata ?? {};
  return normalizeLocalePreferences({
    appLanguage: meta.appLanguage,
    contentLanguage: meta.contentLanguage,
    pinterestRegion: meta.pinterestRegion,
  });
}

async function persistRemotePrefs(prefs: LocalePreferences): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { error } = await supabase.auth.updateUser({
    data: {
      appLanguage: prefs.appLanguage,
      contentLanguage: prefs.contentLanguage,
      pinterestRegion: prefs.pinterestRegion,
    },
  });
  return !error;
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<LocalePreferences>(DEFAULT_LOCALE_PREFERENCES);
  const [draftPreferences, setDraftPreferencesState] = useState<LocalePreferences>(DEFAULT_LOCALE_PREFERENCES);
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [languageModalOpen, setLanguageModalOpen] = useState(false);

  useEffect(() => {
    // localStorage is authoritative once the user has chosen a language on this
    // device: a refresh must always keep that choice, even if the remote write
    // failed or the session can't persist metadata. The remote copy is only used
    // to SEED the very first visit (empty localStorage) for cross-device sync.
    const hasLocal = typeof window !== "undefined" && localStorage.getItem(LOCALE_STORAGE_KEY) != null;
    const local = readLocalPrefs();
    // One-time mount hydration from localStorage — intentional synchronous seed, not a
    // render-sync loop (same pattern the rest of the app disables this rule for).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreferences(local);
    setDraftPreferencesState(local);

    loadRemotePrefs().then(remote => {
      if (remote && !hasLocal) {
        setPreferences(remote);
        setDraftPreferencesState(remote);
        writeLocalPrefs(remote);
      }
      setHydrated(true);
    }).catch(() => setHydrated(true));
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    // App UI language drives both the BCP-47 lang attribute and text direction.
    // RTL languages (Arabic) flip the whole document via dir="rtl".
    document.documentElement.lang = htmlLangAttr(preferences.appLanguage);
    document.documentElement.dir = languageDirection(preferences.appLanguage);
  }, [preferences.appLanguage, hydrated]);

  const messages = useMemo(() => getMessages(preferences.appLanguage), [preferences.appLanguage]);

  const t = useCallback((key: MessageKey) => messages[key] ?? getMessages("en")[key] ?? key, [messages]);

  const resolvedContentLanguage = useMemo(
    () => resolveContentLanguage(preferences),
    [preferences],
  );

  const setDraftPreferences = useCallback((patch: Partial<LocalePreferences>) => {
    setDraftPreferencesState(prev => normalizeLocalePreferences({ ...prev, ...patch }));
  }, []);

  const savePreferences = useCallback(async (patch: Partial<LocalePreferences>) => {
    const next = normalizeLocalePreferences({ ...preferences, ...patch });
    setSaving(true);
    try {
      writeLocalPrefs(next);
      setPreferences(next);
      setDraftPreferencesState(next);
      await persistRemotePrefs(next);
      window.dispatchEvent(new CustomEvent("vibepin-locale-change", { detail: next }));
      toast.success(getMessages(next.appLanguage)["lang.saved"] ?? "Language settings saved");
    } finally {
      setSaving(false);
    }
  }, [preferences]);

  const value = useMemo<LocaleContextValue>(() => ({
    preferences,
    resolvedContentLanguage,
    t,
    saving,
    languageModalOpen,
    openLanguageModal: () => {
      setDraftPreferencesState(preferences);
      setLanguageModalOpen(true);
    },
    closeLanguageModal: () => setLanguageModalOpen(false),
    savePreferences,
    setDraftPreferences,
    draftPreferences,
  }), [
    preferences, resolvedContentLanguage, t, saving, languageModalOpen,
    savePreferences, setDraftPreferences, draftPreferences,
  ]);

  return (
    <LocaleContext.Provider value={value}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useLocale must be used within LocaleProvider");
  return ctx;
}

export function usePinterestRegion(): PinterestRegionCode {
  const { preferences } = useLocale();
  return preferences.pinterestRegion;
}

export type { LocalePreferences, LanguageCode, ContentLanguageSetting, PinterestRegionCode };
