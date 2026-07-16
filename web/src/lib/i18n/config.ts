/** App UI + AI content language codes (ISO-style). */
export type LanguageCode =
  | "en"
  | "zh-CN"
  | "zh-TW"
  | "es"
  | "fr"
  | "de"
  | "pt"
  | "ja"
  | "ko"
  | "it"
  | "nl"
  | "pl"
  | "tr"
  | "vi"
  | "th"
  | "id"
  | "hi"
  | "ar"
  | "ru";

export type ContentLanguageSetting = LanguageCode | "same";

export type PinterestRegionCode =
  | "US"
  | "GB"
  | "CA"
  | "AU"
  | "DE"
  | "FR"
  | "ES"
  | "BR"
  | "JP"
  | "KR";

export type LocalePreferences = {
  appLanguage: LanguageCode;
  contentLanguage: ContentLanguageSetting;
  pinterestRegion: PinterestRegionCode;
};

export const DEFAULT_LOCALE_PREFERENCES: LocalePreferences = {
  appLanguage: "en",
  contentLanguage: "same",
  pinterestRegion: "US",
};

export const LOCALE_STORAGE_KEY = "vibepin-locale-prefs";

export type LanguageOption = {
  code: LanguageCode;
  label: string;
  nativeLabel: string;
  beta?: boolean;
  rtl?: boolean;
  disabled?: boolean;
};

export const PRIMARY_APP_LANGUAGES: LanguageOption[] = [
  { code: "en",    label: "English",     nativeLabel: "English" },
  { code: "zh-CN", label: "Simplified Chinese", nativeLabel: "简体中文" },
  { code: "zh-TW", label: "Traditional Chinese", nativeLabel: "繁體中文" },
  { code: "es",    label: "Spanish",     nativeLabel: "Español" },
  { code: "fr",    label: "French",      nativeLabel: "Français" },
  { code: "de",    label: "German",      nativeLabel: "Deutsch" },
  { code: "pt",    label: "Portuguese",  nativeLabel: "Português" },
  { code: "ja",    label: "Japanese",    nativeLabel: "日本語" },
  { code: "ko",    label: "Korean",      nativeLabel: "한국어" },
];

export const BETA_APP_LANGUAGES: LanguageOption[] = [
  { code: "it", label: "Italian",   nativeLabel: "Italiano" },
  { code: "nl", label: "Dutch",     nativeLabel: "Nederlands" },
  { code: "pl", label: "Polish",    nativeLabel: "Polski" },
  { code: "tr", label: "Turkish",   nativeLabel: "Türkçe" },
  { code: "vi", label: "Vietnamese", nativeLabel: "Tiếng Việt" },
  { code: "th", label: "Thai",      nativeLabel: "ไทย" },
  { code: "id", label: "Indonesian", nativeLabel: "Bahasa Indonesia" },
  { code: "hi", label: "Hindi",     nativeLabel: "हिन्दी" },
  { code: "ar", label: "Arabic",    nativeLabel: "العربية", beta: true, rtl: true },
  { code: "ru", label: "Russian",   nativeLabel: "Русский" },
];

export const ALL_APP_LANGUAGES: LanguageOption[] = [
  ...PRIMARY_APP_LANGUAGES,
  ...BETA_APP_LANGUAGES,
];

export type RegionOption = {
  code: PinterestRegionCode;
  labelKey: string;
};

export const PINTEREST_REGIONS: RegionOption[] = [
  { code: "US", labelKey: "region.US" },
  { code: "GB", labelKey: "region.GB" },
  { code: "CA", labelKey: "region.CA" },
  { code: "AU", labelKey: "region.AU" },
  { code: "DE", labelKey: "region.DE" },
  { code: "FR", labelKey: "region.FR" },
  { code: "ES", labelKey: "region.ES" },
  { code: "BR", labelKey: "region.BR" },
  { code: "JP", labelKey: "region.JP" },
  { code: "KR", labelKey: "region.KR" },
];

// Product decision: AI-generated Pin copy always defaults to English, regardless
// of app UI language or any stored contentLanguage preference. The per-generation
// language dropdown on Create Pins (web/src/app/app/studio/page.tsx) is the only
// place a user can pick a different language for a given run. The `prefs` param
// and `contentLanguage` field/type are kept so already-stored user preferences
// (localStorage + user_metadata) remain valid shapes; they are simply not read here.
export function resolveContentLanguage(
  _prefs: Pick<LocalePreferences, "appLanguage" | "contentLanguage">,
): LanguageCode {
  return "en";
}

/** Languages that render right-to-left. */
export const RTL_LANGUAGES: LanguageCode[] = ["ar"];

export function isRtlLanguage(code: LanguageCode): boolean {
  return RTL_LANGUAGES.includes(code);
}

/** Document text direction for an app language. */
export function languageDirection(code: LanguageCode): "ltr" | "rtl" {
  return isRtlLanguage(code) ? "rtl" : "ltr";
}

/** BCP-47 `lang` attribute value for an app language. */
export function htmlLangAttr(code: LanguageCode): string {
  if (code === "zh-CN") return "zh-Hans";
  if (code === "zh-TW") return "zh-Hant";
  return code.split("-")[0];
}

export function isLanguageCode(v: unknown): v is LanguageCode {
  return typeof v === "string" && ALL_APP_LANGUAGES.some(l => l.code === v && !l.disabled);
}

export function isPinterestRegionCode(v: unknown): v is PinterestRegionCode {
  return typeof v === "string" && PINTEREST_REGIONS.some(r => r.code === v);
}

export function normalizeLocalePreferences(raw: Partial<LocalePreferences> | null | undefined): LocalePreferences {
  return {
    appLanguage: isLanguageCode(raw?.appLanguage) ? raw!.appLanguage : DEFAULT_LOCALE_PREFERENCES.appLanguage,
    contentLanguage:
      raw?.contentLanguage === "same" || isLanguageCode(raw?.contentLanguage)
        ? (raw!.contentLanguage as ContentLanguageSetting)
        : DEFAULT_LOCALE_PREFERENCES.contentLanguage,
    pinterestRegion: isPinterestRegionCode(raw?.pinterestRegion)
      ? raw!.pinterestRegion
      : DEFAULT_LOCALE_PREFERENCES.pinterestRegion,
  };
}

export function contentLanguageLabel(code: LanguageCode): string {
  return ALL_APP_LANGUAGES.find(l => l.code === code)?.nativeLabel ?? code;
}

/**
 * Compact badge label for the top-right App-language control, e.g. "EN", "简", "繁".
 * Chinese uses a single distinguishing glyph (简/繁); everything else uses the
 * uppercased base code. Kept here so the header pill and any future compact UI
 * share one source of truth.
 */
const APP_LANGUAGE_SHORT_LABEL: Record<LanguageCode, string> = {
  en: "EN", "zh-CN": "简", "zh-TW": "繁", es: "ES", fr: "FR", de: "DE",
  pt: "PT", ja: "JA", ko: "KO", it: "IT", nl: "NL", pl: "PL", tr: "TR",
  id: "ID", vi: "VI", th: "TH", hi: "HI", ar: "AR", ru: "RU",
};

export function appLanguageShortLabel(code: LanguageCode): string {
  return APP_LANGUAGE_SHORT_LABEL[code] ?? code.slice(0, 2).toUpperCase();
}

/** Client-side read for modules that cannot use React context (e.g. pin creation helpers). */
export function readLocalePreferencesFromStorage(): LocalePreferences {
  if (typeof window === "undefined") return DEFAULT_LOCALE_PREFERENCES;
  try {
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (!raw) return DEFAULT_LOCALE_PREFERENCES;
    return normalizeLocalePreferences(JSON.parse(raw));
  } catch {
    return DEFAULT_LOCALE_PREFERENCES;
  }
}

export function readResolvedContentLanguage(): LanguageCode {
  return resolveContentLanguage(readLocalePreferencesFromStorage());
}

export function readPinterestRegionFromStorage(): PinterestRegionCode {
  return readLocalePreferencesFromStorage().pinterestRegion;
}
