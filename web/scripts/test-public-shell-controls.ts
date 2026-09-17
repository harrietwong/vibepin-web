import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readLocalTheme, writeLocalTheme } from "../src/lib/theme/themeStore";
import { normalizeLocalePreferences } from "../src/lib/i18n/config";
import {
  PUBLIC_CONTROL_MIN_SIZE,
  isPublicShellRoute,
  isPublicHeaderCompact,
  closePublicMenuOnEscape,
} from "../src/components/public/publicShellContract";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  OK ${name}`);
}

const shell = readFileSync("src/components/public/PublicShell.tsx", "utf8");
const globals = readFileSync("src/app/globals.css", "utf8");
const rootLayout = readFileSync("src/app/layout.tsx", "utf8");
const themeStore = readFileSync("src/lib/theme/themeStore.ts", "utf8");
const localeConfig = readFileSync("src/lib/i18n/config.ts", "utf8");
const en = readFileSync("src/lib/i18n/messages/en.ts", "utf8");
const zhCN = readFileSync("src/lib/i18n/messages/zh-CN.ts", "utf8");
const zhTW = readFileSync("src/lib/i18n/messages/zh-TW.ts", "utf8");
const vi = readFileSync("src/lib/i18n/messages/vi.ts", "utf8");

const publicPages = [
  "src/app/page.tsx",
  "src/app/pricing/page.tsx",
  "src/app/contact/page.tsx",
  "src/app/about/page.tsx",
  "src/app/careers/page.tsx",
  "src/app/privacy/page.tsx",
  "src/app/terms/page.tsx",
  "src/app/refund-policy/page.tsx",
  "src/app/login/page.tsx",
  "src/app/signup/page.tsx",
  "src/app/acceptable-use-policy/page.tsx",
  "src/app/data-deletion-status/page.tsx",
  "src/app/pinterest-app/page.tsx",
  "src/app/welcome/page.tsx",
];

test("PublicShell owns one shared app-language/theme provider pair", () => {
  assert.match(shell, /<ThemeProvider>/);
  assert.match(shell, /<LocaleProvider>/);
  assert.equal((shell.match(/<ThemeProvider>/g) ?? []).length, 1);
  assert.equal((shell.match(/<LocaleProvider>/g) ?? []).length, 1);
  assert.match(shell, /<PublicLanguageTheme\s*\/>/);
});

test("Public controls use the same preference stores and expose keyboard-safe menus", () => {
  for (const marker of [
    "ThemeProvider",
    "LocaleProvider",
    'data-testid="public-language-button"',
    'data-testid="public-theme-button"',
    'data-testid="public-language-menu"',
    'data-testid="public-theme-menu"',
    "onKeyDown",
    "closePublicMenuOnEscape(event.key",
    "focus-visible",
  ]) {
    assert.match(shell, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), marker);
  }
  assert.match(themeStore, /THEME_STORAGE_KEY\s*=/);
  assert.match(localeConfig, /LOCALE_STORAGE_KEY\s*=/);
});

test("Public shell stays contained at narrow mobile widths and respects reduced motion", () => {
  assert.match(shell, /overflow-x-clip/);
  assert.match(globals, /prefers-reduced-motion: reduce/);
  assert.match(globals, /public-shell/);
});

test("The shared anti-FOUC theme bootstrap covers public routes", () => {
  assert.match(rootLayout, /location\.pathname\.startsWith\('\/app'\)/);
  assert.match(rootLayout, /isPublicShellPath/);
  assert.match(rootLayout, /acceptable-use-policy/);
  assert.match(rootLayout, /location\.pathname\.startsWith\('\/app'\)\|\|isPublicShellPath/);
});

test("Public route allowlist excludes admin and unrelated root routes", () => {
  assert.equal(isPublicShellRoute("/"), true);
  assert.equal(isPublicShellRoute("/contact"), true);
  assert.equal(isPublicShellRoute("/app/studio"), false);
  assert.equal(isPublicShellRoute("/admin"), false);
  assert.equal(isPublicShellRoute("/products"), false);
});

test("Theme and locale preferences use the same persisted contract as the workspace", () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: () => ({ matches: false }) } });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
  });
  writeLocalTheme("light");
  assert.equal(readLocalTheme(), "light");
  assert.equal(normalizeLocalePreferences({ appLanguage: "zh-CN" }).appLanguage, "zh-CN");
});

test("Escape closes the real public menu and restores its trigger focus", () => {
  let closed = false;
  let focused = false;
  assert.equal(closePublicMenuOnEscape("Enter", () => { closed = true; }, () => { focused = true; }), false);
  assert.equal(closePublicMenuOnEscape("Escape", () => { closed = true; }, () => { focused = true; }), true);
  assert.equal(closed, true);
  assert.equal(focused, true);
});

test("Public controls preserve a 44px minimum hit target", () => {
  assert.equal(PUBLIC_CONTROL_MIN_SIZE, 44);
});

test("The shared header enters its compact layout at a 390px viewport", () => {
  assert.equal(isPublicHeaderCompact(391), false);
  assert.equal(isPublicHeaderCompact(390), true);
  assert.equal(isPublicHeaderCompact(320), true);
});

test("Public routes are wrapped without adding a second provider layer", () => {
  for (const file of publicPages) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /PublicShell/ , file);
    assert.doesNotMatch(source, /<ThemeProvider>|<LocaleProvider>/, file);
  }
});

test("Shell labels and Contact actions have English, Simplified Chinese, Traditional Chinese, and Vietnamese copy", () => {
  const keys = [
    "public.nav.about",
    "public.nav.careers",
    "public.nav.contact",
    "public.nav.pricing",
    "public.controls.language",
    "public.controls.theme",
    "contact.success.title",
    "contact.success.description",
    "contact.success.home",
    "contact.success.another",
    "contact.reason.product.title",
    "contact.reason.product.description",
    "contact.reason.billing.title",
    "contact.reason.billing.description",
    "contact.reason.partnership.title",
    "contact.reason.partnership.description",
  ];
  for (const key of keys) {
    for (const catalog of [en, zhCN, zhTW, vi]) {
      assert.match(catalog, new RegExp(`['\"]${key.replace(".", "\\.")}['\"]\\s*:`), `${key} missing`);
    }
  }
});

console.log(`\nPublic shell controls: ${passed} passed, 0 failed`);
