/* eslint-disable @typescript-eslint/no-require-imports */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getMessages, PARTIAL } from "../src/lib/i18n/messages";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const AboutPage = require("../src/app/about/page").default;
const PrivacyPage = require("../src/app/privacy/page").default;
const TermsPage = require("../src/app/terms/page").default;
const RefundPolicyPage = require("../src/app/refund-policy/page").default;
const AcceptableUsePolicyPage = require("../src/app/acceptable-use-policy/page").default;
const PinterestAppPage = require("../src/app/pinterest-app/page").default;
const CareersPage = require("../src/app/careers/page").default;
const WelcomePage = require("../src/app/welcome/page").default;

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed += 1; console.log(`  OK ${name}`); }
const locales = ["en", "zh-CN", "zh-TW", "vi"] as const;
const routes = ["about", "careers", "privacy", "terms", "refund", "acceptableUse", "pinterest", "welcome", "dataDeletion", "login", "signup"] as const;
const authFields = ["email", "password", "google", "divider", "loading", "alternatePrompt", "alternateCta", "legalNotice", "passwordHint", "forgotPassword", "resetEmailRequired", "resetSent", "confirmationTitle", "confirmationBody", "planPrefix", "signInPrompt", "signInCta", "termsLabel", "privacyLabel"] as const;

test("all required public prose is present in each supported locale catalog", () => {
  for (const locale of locales) {
    const messages = getMessages(locale);
    for (const route of routes) for (const field of ["eyebrow", "title", "body", "cta"] as const) assert.ok(messages[`public.route.${route}.${field}` as keyof typeof messages]?.trim(), `${locale} ${route}.${field}`);
    for (const field of authFields) assert.ok(messages[`public.auth.${field}` as keyof typeof messages]?.trim(), `${locale} auth ${field}`);
    for (const route of ["privacy", "terms", "refund", "acceptableUse", "pinterest"] as const) assert.ok(messages[`public.document.${route}.body` as keyof typeof messages]?.includes("##"), `${locale} ${route} document`);
  }
});

test("named public routes, including auth, contact, and deletion, have their own locale entries", () => {
  const required = [
    "public.route.login.title", "public.route.signup.title", "public.route.dataDeletion.title",
    "contact.title", "contact.success.title", "public.auth.error.oauthCallback",
  ] as const;
  for (const locale of locales.filter(locale => locale !== "en")) {
    const own = PARTIAL[locale]!;
    for (const key of required) assert.ok(Object.prototype.hasOwnProperty.call(own, key), `${locale} falls back for ${key}`);
  }
});

test("catalogs resolve localized prose rather than a headline-only fallback", () => {
  assert.notEqual(getMessages("en")["public.document.privacy.body"], getMessages("zh-CN")["public.document.privacy.body"]);
  assert.notEqual(getMessages("en")["public.auth.error.authenticationFailed"], getMessages("vi")["public.auth.error.authenticationFailed"]);
});

test("stored callback codes resolve at render time when the locale changes", () => {
  const callbackKey = "public.auth.error.oauthCallback";
  assert.notEqual(getMessages("en")[callbackKey], getMessages("zh-CN")[callbackKey]);
  assert.notEqual(getMessages("en")[callbackKey], getMessages("zh-TW")[callbackKey]);
  assert.notEqual(getMessages("en")[callbackKey], getMessages("vi")[callbackKey]);
});

const routesToRender = [
  ["about", AboutPage], ["privacy", PrivacyPage], ["terms", TermsPage], ["refund", RefundPolicyPage],
  ["acceptable use", AcceptableUsePolicyPage], ["Pinterest app", PinterestAppPage], ["careers", CareersPage], ["welcome", WelcomePage],
] as const;

for (const [name, Page] of routesToRender) test(`${name} SSR renders catalog content inside the shared shell`, () => {
  const markup = renderToStaticMarkup(React.createElement(Page));
  assert.match(markup, /public-shell/);
  assert.doesNotMatch(markup, /public\.route\./);
});

console.log(`\nPublic locale routes: ${passed} passed`);
