/**
 * i18n / app-localization tests.
 *
 * Covers the acceptance criteria for global multilingual UI support:
 *   - App language and AI content language are separate prefs.
 *   - Switching app language resolves a different message catalog.
 *   - AI content language does NOT change the app UI language.
 *   - Missing keys fall back to English.
 *   - Every locale catalog is a strict subset of the English key set
 *     (so a typo'd key can never silently ship).
 *   - Persistence round-trips through normalizeLocalePreferences.
 *   - RTL direction + html lang attribute derive from app language.
 *   - The Settings modal, sidebar, and account dropdown reference t()/labelKeys
 *     (i.e. are not hardcoded English).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import en from "../src/lib/i18n/messages/en";
import type { MessageKey } from "../src/lib/i18n/messages/en";
import { getMessages, PARTIAL, TRANSLATED_LOCALES } from "../src/lib/i18n/messages";
import {
  DEFAULT_LOCALE_PREFERENCES,
  normalizeLocalePreferences,
  resolveContentLanguage,
  languageDirection,
  htmlLangAttr,
  isLanguageCode,
  ALL_APP_LANGUAGES,
  type LanguageCode,
  type LocalePreferences,
} from "../src/lib/i18n/config";

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  OK ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`       ${(e as Error).message}`); failed++; }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const enKeys = new Set(Object.keys(en) as MessageKey[]);

console.log("i18n / app localization");

// Catalog integrity

test("every locale key exists in the English source of truth (no orphan keys)", () => {
  for (const [lang, catalog] of Object.entries(PARTIAL)) {
    for (const key of Object.keys(catalog ?? {})) {
      assert(enKeys.has(key as MessageKey), `locale ${lang} has key "${key}" not present in en.ts`);
    }
  }
});

test("all 18 required app languages are available (selectable + not disabled)", () => {
  const required: LanguageCode[] = [
    "en", "zh-CN", "zh-TW", "es", "fr", "de", "pt", "ja", "ko",
    "it", "nl", "pl", "tr", "id", "vi", "th", "hi", "ar",
  ];
  for (const code of required) {
    assert(isLanguageCode(code), `language ${code} should be selectable`);
    assert(ALL_APP_LANGUAGES.some(l => l.code === code), `language ${code} missing from ALL_APP_LANGUAGES`);
  }
});

test("priority locales ship a real (non-trivial) catalog", () => {
  const priority: LanguageCode[] = ["zh-CN", "zh-TW", "es", "fr", "de", "pt", "ja", "ko"];
  for (const code of priority) {
    const catalog = PARTIAL[code] ?? {};
    // Full locales translate well over half of the English keys.
    assert(Object.keys(catalog).length > enKeys.size * 0.5,
      `priority locale ${code} only has ${Object.keys(catalog).length}/${enKeys.size} keys`);
  }
});

test("every translated locale localizes the settings tab labels", () => {
  const tabKeys: MessageKey[] = [
    "settings.tab.account", "settings.tab.appearance", "settings.tab.aiSettings",
  ];
  for (const code of TRANSLATED_LOCALES) {
    if (code === "en") continue;
    const catalog = PARTIAL[code] ?? {};
    for (const k of tabKeys) {
      assert(typeof catalog[k] === "string" && catalog[k]!.length > 0,
        `locale ${code} is missing settings tab key ${k}`);
    }
  }
});

// Fallback to English

test("missing keys fall back to English in getMessages()", () => {
  // Every shipped locale is now fully translated (validate:i18n-coverage enforces
  // it), so no real key can serve as the "untranslated" fixture. Assert the
  // fallback MECHANISM instead: temporarily drop a key from a locale catalog and
  // confirm getMessages() still resolves it to the English source of truth.
  const itCatalog = PARTIAL["it"] as Record<string, string>;
  const probe: MessageKey = "billing.noUsage";
  const saved = itCatalog[probe];
  assert(typeof saved === "string", `fixture key ${probe} is absent from the Italian catalog`);

  delete itCatalog[probe];
  try {
    const it = getMessages("it");
    assert(it[probe] === en[probe],
      "untranslated key should fall back to English text");
  } finally {
    itCatalog[probe] = saved;
  }

  // A translated key should differ from English ("Salva" vs "Save").
  const it = getMessages("it");
  assert(it["common.save"] !== en["common.save"],
    "translated key should not equal English");
});

test("getMessages always returns a full English-shaped catalog", () => {
  for (const code of ALL_APP_LANGUAGES.map(l => l.code)) {
    const msgs = getMessages(code);
    for (const k of enKeys) {
      assert(typeof msgs[k] === "string", `getMessages(${code}) missing key ${k}`);
    }
  }
});

// App language vs AI content language separation

test("switching app language selects a different catalog without touching content language", () => {
  const enMsgs = getMessages("en");
  const zhMsgs = getMessages("zh-CN");
  assert(enMsgs["settings.title"] === "Settings", "english title wrong");
  assert(zhMsgs["settings.title"] === "\u8bbe\u7f6e", "chinese title should be \u8bbe\u7f6e");
  assert(enMsgs["settings.title"] !== zhMsgs["settings.title"], "app language must change UI text");
});

test("AI content language resolves from the user's stored preference, independent of app language", () => {
  // Current committed behaviour: the AI content-language selector still exists in
  // Settings, and resolveContentLanguage honours the stored preference — "same"
  // means follow the app language, otherwise use the chosen content language.
  // (A future "always default to English" product change must land together with the
  // removal of that selector and this test — not before.)
  const prefs = normalizeLocalePreferences({ appLanguage: "en", contentLanguage: "zh-CN", pinterestRegion: "US" });
  assert(getMessages(prefs.appLanguage)["settings.title"] === "Settings",
    "changing content language must not change UI language");
  assert(resolveContentLanguage(prefs) === "zh-CN", "resolveContentLanguage should honour the chosen content language");

  const samePrefs = normalizeLocalePreferences({ appLanguage: "ja", contentLanguage: "same", pinterestRegion: "JP" });
  assert(resolveContentLanguage(samePrefs) === "ja", "\"same\" content language should follow the app language");
});

// Persistence

test("preferences round-trip + persist app and content language separately", () => {
  const stored = { appLanguage: "ko", contentLanguage: "es", pinterestRegion: "KR" } as Partial<LocalePreferences>;
  const norm = normalizeLocalePreferences(stored);
  assert(norm.appLanguage === "ko", "app language should persist");
  assert(norm.contentLanguage === "es", "content language should persist independently");
  assert(norm.pinterestRegion === "KR", "region should persist");
});

test("invalid / missing language falls back to English default", () => {
  assert(normalizeLocalePreferences({ appLanguage: "klingon" as LanguageCode }).appLanguage
    === DEFAULT_LOCALE_PREFERENCES.appLanguage, "invalid app language should default to en");
  assert(normalizeLocalePreferences(null).appLanguage === "en", "null prefs should default to en");
});

// RTL + lang attribute

test("Arabic resolves to RTL; LTR languages resolve to ltr", () => {
  assert(languageDirection("ar") === "rtl", "Arabic should be rtl");
  assert(languageDirection("en") === "ltr", "English should be ltr");
  assert(languageDirection("zh-CN") === "ltr", "Chinese should be ltr");
});

test("html lang attribute uses BCP-47 script subtags for Chinese", () => {
  assert(htmlLangAttr("zh-CN") === "zh-Hans", "zh-CN -> zh-Hans");
  assert(htmlLangAttr("zh-TW") === "zh-Hant", "zh-TW -> zh-Hant");
  assert(htmlLangAttr("ja") === "ja", "ja -> ja");
  assert(htmlLangAttr("ar") === "ar", "ar -> ar");
});

// Components are wired to t(), not hardcoded

const settingsSrc = readFileSync(join(process.cwd(), "src/components/settings/SettingsModal.tsx"), "utf8");
const layoutSrc   = readFileSync(join(process.cwd(), "src/app/app/layout.tsx"), "utf8");
const workspaceSrc = readFileSync(join(process.cwd(), "src/app/app/workspace/[category]/page.tsx"), "utf8");
const studioSrc    = readFileSync(join(process.cwd(), "src/app/app/studio/page.tsx"), "utf8");
const planSrc      = readFileSync(join(process.cwd(), "src/app/app/plan/page.tsx"), "utf8");

test("Settings modal shell uses translation keys (title, tabs, save/cancel)", () => {
  assert(settingsSrc.includes('t("settings.title")'), "modal title not translated");
  assert(settingsSrc.includes('t("common.saveChanges")'), "save button not translated");
  assert(settingsSrc.includes('t("common.cancel")'), "cancel button not translated");
  assert(settingsSrc.includes("tabItem.labelKey"), "tab labels not driven by translation keys");
});

test("Settings has a dedicated Language tab with App language (and the current AI content-language selector)", () => {
  assert(settingsSrc.includes("settings-tab-language"), "no Language tab in the sidebar");
  assert(settingsSrc.includes("function LanguageTab"), "LanguageTab component missing");
  assert(settingsSrc.includes("language-app-language"), "App language selector missing from Language tab");
  // The AI content-language selector still exists in the committed UI. Removing it is a
  // product change that must land with its resolver + test change, not be pre-asserted here.
  assert(settingsSrc.includes("language-content-language"), "AI content language selector expected in the current Language tab");
  assert(settingsSrc.includes('t("language.appLanguage")'), "App language label not translated");
  assert(settingsSrc.includes('t("language.appLanguageHint")'), "App language hint not translated");
});

test("App language does NOT live only in Appearance (panel removed from Appearance)", () => {
  assert(!settingsSrc.includes("<LanguageRegionPanel embedded />"),
    "App language panel is still embedded in Appearance; it must move to the Language tab");
});

test("AI Settings tab keeps a shortcut to the Language tab (content language selector removed)", () => {
  assert(settingsSrc.includes("ai-settings-open-language"), "AI Settings is missing the 'Open Language settings' button");
  assert(settingsSrc.includes('onOpenTab("language")'), "shortcut does not switch to the Language tab");
});

test("Amazon Associates tab label uses a translation key (zh-CN keeps 'Amazon Associates' as a brand exception)", () => {
  assert(settingsSrc.includes('labelKey: "settings.tab.amazon"'), "Amazon tab not using a translation key");
  // Brand/proper-noun exception: "Amazon Associates" stays in Latin script in every
  // locale (same convention as platform names like Pinterest). It must NOT be translated.
  assert(getMessages("zh-CN")["settings.tab.amazon"] === "Amazon Associates",
    "Amazon Associates zh-CN label must stay 'Amazon Associates' (brand exception, not translated)");
});

test("Sidebar nav + account dropdown are translated (not hardcoded English)", () => {
  // Accepts both `t(item.labelKey)` and `t(item.labelKey!)` (the latter after the
  // optional-labelKey nav change); the intent is that nav labels go through t().
  assert(layoutSrc.includes("t(item.labelKey"), "sidebar nav labels not translated");
  assert(layoutSrc.includes('t("account.accountSettings")'), "account dropdown not translated");
  assert(layoutSrc.includes('t("account.signOut")'), "sign out not translated");
  assert(!layoutSrc.includes('label="Account settings"'), "found leftover hardcoded account label");
});

// Page bodies are translated (not only chrome)

test("Dashboard (workspace) body uses translation keys", () => {
  assert(workspaceSrc.includes('t("page.dashboard.tagline")'), "dashboard tagline not translated");
  assert(workspaceSrc.includes('t("page.dashboard.emptyTitle")'), "dashboard empty state not translated");
  assert(!workspaceSrc.includes("Ranked weekly opportunities backed by trend, pin, and product signals."),
    "found leftover hardcoded dashboard tagline");
});

test("Create Pins (studio) body uses translation keys", () => {
  assert(studioSrc.includes('tr("page.studio.filterAll")'), "studio filter tabs not translated");
  assert(studioSrc.includes('tr("page.studio.emptyTitle")'), "studio empty state not translated");
  assert(studioSrc.includes('tr("page.studio.pinSettings")'), "studio Pin settings not translated");
  assert(!studioSrc.includes(">\n              Your generated Pins will appear here"),
    "found leftover hardcoded studio empty title");
});

test("Weekly Plan (plan) body uses translation keys", () => {
  assert(planSrc.includes('tr("page.plan.title")'), "plan title not translated");
  assert(!planSrc.includes(">Weekly Plan</h1>"), "found leftover hardcoded Weekly Plan title");
});

test("zh-CN ships the required page-body translations", () => {
  const zh = getMessages("zh-CN");
  assert(zh["page.dashboard.tagline"] !== en["page.dashboard.tagline"], "dashboard tagline not translated to zh-CN");
  assert(zh["page.studio.emptyTitle"] === "\u751f\u6210\u7684 Pin \u5c06\u663e\u793a\u5728\u8fd9\u91cc", "studio empty title zh-CN wrong");
  assert(zh["page.plan.title"] === "\u6bcf\u5468\u8ba1\u5212", "plan title zh-CN wrong");
  assert(zh["language.appLanguageHint"] === "\u66f4\u6539 VibePin \u754c\u9762\u7684\u663e\u793a\u8bed\u8a00\u3002", "App language hint zh-CN wrong");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
