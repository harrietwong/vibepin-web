import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readLocalTheme, writeLocalTheme } from "../src/lib/theme/themeStore";
import { normalizeLocalePreferences } from "../src/lib/i18n/config";
import { getMessages } from "../src/lib/i18n/messages";
import { resolveTheme } from "../src/lib/theme/themeStore";

// Providers create the browser client at module evaluation time. Supply inert
// public values so this is a real React render test, not an environment test.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const HomePage = require("../src/app/page").default as typeof import("../src/app/page").default;
import {
  PUBLIC_CONTROL_MIN_SIZE,
  isPublicShellRoute,
  isPublicHeaderCompact,
  publicMenuTargetIndex,
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
const themeStore = readFileSync("src/lib/theme/themeStore.ts", "utf8");
const localeConfig = readFileSync("src/lib/i18n/config.ts", "utf8");
const shellContract = readFileSync("src/components/public/publicShellContract.ts", "utf8");
const en = readFileSync("src/lib/i18n/messages/en.ts", "utf8");
const zhCN = readFileSync("src/lib/i18n/messages/zh-CN.ts", "utf8");
const zhTW = readFileSync("src/lib/i18n/messages/zh-TW.ts", "utf8");
const vi = readFileSync("src/lib/i18n/messages/vi.ts", "utf8");
const contactForm = readFileSync("src/app/contact/ContactForm.tsx", "utf8");

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

test("landing server-renders through PublicShell before reading locale context", () => {
  const markup = renderToStaticMarkup(React.createElement(HomePage));
  assert.match(markup, /Pinterest growth starts with signals\./);
  assert.match(markup, /data-testid="public-language-button"/);
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

function contrastRatio(foreground: string, background: string) {
  const channels = (hex: string) => hex.match(/[A-Fa-f0-9]{2}/g)!.map(value => parseInt(value, 16) / 255);
  const luminance = (hex: string) => channels(hex).map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

test("public locale and theme switching resolve real user-facing state", () => {
  assert.equal(getMessages("zh-CN")["public.controls.language"], "语言");
  assert.equal(getMessages("zh-TW")["contact.success.title"], "訊息已傳送");
  assert.equal(getMessages("vi")["public.nav.pricing"], "Bảng giá");
  assert.equal(resolveTheme("light"), "light");
  assert.equal(resolveTheme("dark"), "dark");
});

test("public light and dark body/muted text meet WCAG AA contrast", () => {
  assert.ok(contrastRatio("17202B", "F7F8FA") >= 4.5, "light body text");
  assert.ok(contrastRatio("52657D", "F7F8FA") >= 4.5, "light muted text");
  assert.ok(contrastRatio("E8F0EC", "080E0B") >= 4.5, "dark body text");
  assert.ok(contrastRatio("8B9E97", "080E0B") >= 4.5, "dark muted text");
  assert.match(globals, /--public-bg/);
  assert.match(globals, /\.public-shell \.lp/);
  assert.doesNotMatch(globals, /public-page-content nav \.text-white/);
});

test("Escape closes the real public menu and restores its trigger focus", () => {
  let closed = false;
  let focused = false;
  assert.equal(closePublicMenuOnEscape("Enter", () => { closed = true; }, () => { focused = true; }), false);
  assert.equal(closePublicMenuOnEscape("Escape", () => { closed = true; }, () => { focused = true; }), true);
  assert.equal(closed, true);
  assert.equal(focused, true);
});

test("public menu keyboard contract covers roving selection keys", () => {
  assert.match(shellContract, /ArrowDown/);
  assert.equal(publicMenuTargetIndex("ArrowDown", 1, 3), 2);
  assert.equal(publicMenuTargetIndex("ArrowUp", 0, 3), 2);
  assert.equal(publicMenuTargetIndex("Home", 2, 3), 0);
  assert.equal(publicMenuTargetIndex("End", 0, 3), 2);
  assert.equal(publicMenuTargetIndex("Enter", 0, 3), null);
});

test("Public controls preserve a 44px minimum hit target", () => {
  assert.equal(PUBLIC_CONTROL_MIN_SIZE, 44);
  assert.match(contactForm, /htmlFor=\{`contact-\$\{name\}`\}/);
  assert.match(contactForm, /id=\{`contact-\$\{name\}`\}/);
  assert.match(contactForm, /htmlFor="contact-message"/);
  assert.match(contactForm, /id="contact-message"/);
  assert.match(contactForm, /contact-success-another"[\s\S]*?min-h-11/);
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
