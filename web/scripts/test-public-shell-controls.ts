import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
    'event.key === "Escape"',
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
  assert.match(rootLayout, /if\(!location\.pathname\.startsWith\('\/admin'\)\)/);
  assert.doesNotMatch(rootLayout, /if\(location\.pathname\.startsWith\('\/app'\)\)/);
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
  ];
  for (const key of keys) {
    for (const catalog of [en, zhCN, zhTW, vi]) {
      assert.match(catalog, new RegExp(`['\"]${key.replace(".", "\\.")}['\"]\\s*:`), `${key} missing`);
    }
  }
});

console.log(`\nPublic shell controls: ${passed} passed, 0 failed`);
