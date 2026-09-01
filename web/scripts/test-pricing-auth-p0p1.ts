/** Focused PRD 0901 contracts: OAuth safety, billing honesty and Creem Test mapping. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  authFailureRedirect,
  authUiErrorMessage,
  safeNextPath,
} from "../src/lib/authRedirects";
import { CREEM_PRODUCT_REQUIREMENTS } from "../src/lib/server/creem/creemProducts";
import {
  assertBillingModeUsable,
  BillingMisconfiguredError,
} from "../src/lib/server/creem/billingMode";
import { EXTRA_ACCOUNT_PRICE_USD, PRICING_TIERS } from "../src/lib/pricingPlans";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}\n      ${(error as Error).message}`);
  }
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

console.log("\nPricing/Auth P0-P1 focused contracts\n");

test("safe next keeps an in-app billing path", () => {
  eq(safeNextPath("/app/settings/billing"), "/app/settings/billing", "billing next");
});

for (const unsafe of [null, "", "https://evil.example", "//evil.example", "/auth/callback", "/login", "/signup", "/app\\evil"]) {
  test(`unsafe next ${JSON.stringify(unsafe)} falls back to Studio`, () => {
    eq(safeNextPath(unsafe), "/app/studio", "safe fallback");
  });
}

test("callback failure preserves only the validated next path", () => {
  const href = authFailureRedirect("/pricing?checkout=pro&period=year");
  const parsed = new URL(href, "https://vibepin.co");
  eq(parsed.pathname, "/login", "failure route");
  eq(parsed.searchParams.get("error"), "oauth_callback", "safe error code");
  eq(parsed.searchParams.get("next"), "/pricing?checkout=pro&period=year", "purchase intent");
});

test("OAuth UI messages are static, actionable and secret-free", () => {
  const unavailable = authUiErrorMessage("oauth_unavailable") ?? "";
  assert(unavailable.includes("email and password"), "offers the email/password path");
  assert(unavailable.includes("contact support"), "offers support");
  assert(!/token|client secret|oauth code|supabase/i.test(unavailable), "does not expose configuration detail");
});

test("login and signup handle returned and thrown OAuth start errors", () => {
  for (const file of ["src/app/login/page.tsx", "src/app/signup/page.tsx"]) {
    const text = source(file);
    assert(text.includes("error: oauthError"), `${file} checks the returned OAuth error`);
    assert(text.includes("catch {"), `${file} handles thrown OAuth errors`);
    assert(text.includes("setLoading(false)"), `${file} releases the loading state`);
    assert(!text.includes("oauthError.message"), `${file} never reflects a raw provider message`);
  }
});

test("callback clears transient next state and uses the safe failure redirect", () => {
  const text = source("src/app/auth/callback/route.ts");
  assert(text.includes("authFailureRedirect(next)"), "safe failure redirect used");
  assert(text.includes('response.cookies.set("vp_next", ""'), "transient next cookie cleared");
});

test("Billing Usage API exposes explicit metered/unmetered success states", () => {
  const text = source("src/app/api/billing/usage/route.ts");
  assert(text.includes('state: "metered" as const'), "metered state");
  assert(text.includes('state: "unmetered" as const'), "unmetered state");
  assert(text.includes('error: "usage_unavailable"'), "unavailable remains a non-2xx state");
});

test("Billing UI does not present inferred plan or upgrade while sync is unavailable", () => {
  const text = source("src/components/settings/SettingsModal.tsx");
  assert(text.includes('billingState: "loading" | "available" | "unavailable"'), "billing tri-state");
  assert(text.includes('usageState: "loading" | "metered" | "unmetered" | "unavailable"'), "usage tri-state");
  assert(text.includes('billingState !== "available" ? null : hasBillingAccount'), "actions hidden without billing truth");
  assert(text.includes('state === "metered" && used !== null'), "unmetered cannot render a fake zero");
  assert(text.includes("isCreemBillingStatus(json)"), "malformed billing success is unavailable");
  assert(text.includes("isBillingUsage(json)"), "malformed usage success is unavailable");
});

test("Creem contract contains exactly six plans and two extra-account products", () => {
  eq(CREEM_PRODUCT_REQUIREMENTS.length, 8, "product contract count");
  eq(CREEM_PRODUCT_REQUIREMENTS.filter(p => p.kind === "plan").length, 6, "plan products");
  eq(CREEM_PRODUCT_REQUIREMENTS.filter(p => p.kind === "extra_account").length, 2, "add-on products");
});

test("Creem contract amounts match public monthly/yearly and extra-account prices", () => {
  const expected = new Map<string, number>();
  for (const tier of PRICING_TIERS.filter(t => t.id !== "free")) {
    expected.set(`${tier.id}:month`, tier.priceMonthly * 100);
    expected.set(`${tier.id}:year`, tier.priceYearly * 12 * 100);
  }
  expected.set("extra_account:month", EXTRA_ACCOUNT_PRICE_USD.monthly * 100);
  expected.set("extra_account:year", EXTRA_ACCOUNT_PRICE_USD.yearlyPerMonth * 12 * 100);
  for (const product of CREEM_PRODUCT_REQUIREMENTS) {
    const key = product.kind === "plan" ? `${product.plan}:${product.interval}` : `extra_account:${product.interval}`;
    eq(product.expectedUsdCents, expected.get(key), `${key} cents`);
  }
});

test("Preview test mode rejects a non-test Creem key", () => {
  const saved = {
    mode: process.env.CREEM_MODE,
    key: process.env.CREEM_API_KEY,
    vercel: process.env.VERCEL_ENV,
  };
  process.env.CREEM_MODE = "test";
  process.env.CREEM_API_KEY = "creem_live_sentinel";
  process.env.VERCEL_ENV = "preview";
  try {
    let thrown: unknown;
    try { assertBillingModeUsable(); } catch (error) { thrown = error; }
    assert(thrown instanceof BillingMisconfiguredError, "non-test key must fail closed");
  } finally {
    if (saved.mode === undefined) delete process.env.CREEM_MODE; else process.env.CREEM_MODE = saved.mode;
    if (saved.key === undefined) delete process.env.CREEM_API_KEY; else process.env.CREEM_API_KEY = saved.key;
    if (saved.vercel === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = saved.vercel;
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
