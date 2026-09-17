/**
 * Product Opportunities 0905 P0/P1 contract.
 *
 * This is intentionally a small source contract test: it protects the
 * evidence boundary without requiring a browser, Supabase, or invented
 * fixture products.  The UI must keep service/auth failures separate from
 * truthful empty/partial/stale/syncing states.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const component = read("src/components/products/ProductOpportunitiesV1.tsx");
const styles = read("src/components/products/ProductOpportunitiesV1.module.css");
const client = read("src/lib/productOpportunitiesClient.ts");
const server = read("src/lib/server/productOpportunities.ts");
const route = read("src/app/api/product-opportunities/route.ts");
const response = read("src/lib/server/productOpportunityApiResponse.ts");
const enMessages = read("src/lib/i18n/messages/en/products.ts");
const zhCNMessages = read("src/lib/i18n/messages/zh-CN.ts");
const zhTWMessages = read("src/lib/i18n/messages/zh-TW.ts");

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  OK ${name}`);
}

test("Product state contract names every safe state", () => {
  for (const state of [
    "api-error",
    "auth-required",
    "catalog-empty",
    "filtered-empty",
    "partial",
    "stale",
    "syncing",
  ]) {
    assert.match(
      `${server}\n${client}\n${component}`,
      new RegExp(state.replace("-", "[-_]")),
      `missing Product state ${state}`,
    );
  }
});

test("Successful and failed responses carry request/runtime/deployment evidence", () => {
  assert.match(response, /requestId/);
  assert.match(response, /occurredAt/);
  assert.match(response, /runtime/);
  assert.match(response, /deployment/);
  assert.match(route, /productApiSuccess\([\s\S]*state/);
  assert.match(client, /evidence/);
  assert.match(route, /Product opportunities could not be loaded/);
  assert.doesNotMatch(route, /productApiError\([^\n]*error\.message[^\n]*CATALOG_UNAVAILABLE/);
});

test("Database/API errors cannot fall through to a normal empty catalog", () => {
  assert.match(component, /error\?\.[\s\S]*api-error|error[\s\S]*api-error/);
  assert.match(component, /dataRequestFailed[\s\S]*catalogRows\.length === 0/);
  const failureBranch = component.indexOf("dataRequestFailed && catalogRows.length === 0");
  const emptyBranch = component.indexOf("catalogRows.length === 0 && (mode !== \"saved\"");
  assert.ok(failureBranch >= 0 && emptyBranch > failureBranch, "error branch must render before empty branch");
  assert.match(component, /products\.opportunities\.apiErrorTitle/);
});

test("Auth-required is distinct from catalog-empty", () => {
  assert.match(client, /AUTH_REQUIRED/);
  assert.match(component, /auth-required/);
  assert.match(component, /products\.opportunities\.authRequiredTitle/);
});

test("Partial, stale, and syncing data stay visible as status, never fabricated products", () => {
  assert.match(component, /partial/);
  assert.match(component, /stale/);
  assert.match(component, /syncing/);
  assert.doesNotMatch(component, /\bProduct\s+\d+\b/);
  assert.doesNotMatch(component, /placeholder product|fake product|mock product/i);
  assert.match(server, /incomplete-count/);
  assert.match(component, /products\.opportunities\.statePartial/);
});

test("All, Physical, and Digital live in one filter bar", () => {
  assert.match(component, /className=\{styles\.filters\}/);
  assert.match(component, /All products/);
  assert.match(component, /Physical/);
  assert.match(component, /Digital/);
  assert.doesNotMatch(component, /className=\{styles\.toolbar\}/);
  assert.match(styles, /@media\(max-width:430px\)[\s\S]*filters/);
  assert.match(styles, /\.filters\{display:flex;flex-wrap:nowrap;/);
  assert.match(component, /clearFilters/);
});

test("Product Opportunities header is compact on mobile", () => {
  assert.match(styles, /\.header h1\{[^}]*font-size:clamp\(22px,2\.4vw,28px\)/);
  assert.match(styles, /@media\(max-width:430px\)[\s\S]*header h1\{font-size:24px/);
});

test("Desktop 1440 and mobile 390 filter contracts keep controls in-bounds", () => {
  assert.match(styles, /\.filters\{display:flex;flex-wrap:nowrap;/);
  assert.match(styles, /\.familyFilter\{[^}]*flex:[^;]*1 1 220px/);
  assert.match(styles, /\.searchField\{[^}]*flex:[^;]*1 1 190px/);
  assert.match(styles, /@media\(max-width:430px\)[\s\S]*\.filters\{display:grid;grid-template-columns:1fr/);
  assert.match(styles, /@media\(max-width:430px\)[\s\S]*\.filters>button\{width:100%/);
});

test("Error evidence explicitly reports every diagnostic field", () => {
  for (const key of ["evidenceMethod", "evidencePath", "evidenceStatus", "evidenceCode", "evidenceRequest", "evidenceTime", "evidenceRuntime", "evidenceDeployment", "notReported"]) {
    assert.match(component, new RegExp(`products\\.opportunities\\.${key}`));
    assert.match(enMessages, new RegExp(`products\\.opportunities\\.${key}`));
    assert.match(zhCNMessages, new RegExp(`products\\.opportunities\\.${key}`));
    assert.match(zhTWMessages, new RegExp(`products\\.opportunities\\.${key}`));
  }
  assert.match(component, /error\.method/);
  assert.match(component, /error\.path/);
  assert.match(component, /error\.status/);
  assert.match(component, /error\.code/);
  assert.match(component, /error\.requestId/);
  assert.match(component, /error\.occurredAt/);
  assert.match(component, /error\.runtime/);
  assert.match(component, /error\.deployment/);
  assert.match(component, /products\.opportunities\.retry/);
});

test("New Product UI copy is wired through LocaleProvider and has three-language keys", () => {
  assert.match(component, /useLocale/);
  const messageValue = (source: string, key: string) => {
    const match = source.match(new RegExp(`"${key.replaceAll(".", "\\.")}"\\s*:\\s*"([^"]+)"`));
    return match?.[1] ?? "";
  };
  const keys = [
    "products.opportunities.title",
    "products.opportunities.subtitle",
    "products.opportunities.typeAll",
    "products.opportunities.typePhysical",
    "products.opportunities.typeDigital",
    "products.opportunities.filterProductType",
    "products.opportunities.apply",
    "products.opportunities.clear",
    "products.opportunities.retry",
    "products.opportunities.stateSyncing",
    "products.opportunities.stateStale",
    "products.opportunities.statePartial",
    "products.opportunities.catalogEmptyTitle",
    "products.opportunities.filteredEmptyTitle",
    "products.opportunities.authRequiredTitle",
    "products.opportunities.apiErrorTitle",
    "products.opportunities.showAllSaved",
  ];
  for (const key of keys) {
    const escaped = key.replaceAll(".", "\\.");
    assert.match(enMessages, new RegExp(`"${escaped}"`), `English key missing: ${key}`);
    assert.match(zhCNMessages, new RegExp(`"${escaped}"`), `zh-CN key missing: ${key}`);
    assert.match(zhTWMessages, new RegExp(`"${escaped}"`), `zh-TW key missing: ${key}`);
    assert.ok(messageValue(enMessages, key).length >= 4, `English copy too short: ${key}`);
    assert.ok(messageValue(zhCNMessages, key).length >= 2, `zh-CN copy too short: ${key}`);
    assert.ok(messageValue(zhTWMessages, key).length >= 2, `zh-TW copy too short: ${key}`);
  }
});

async function runBehaviorTests() {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service";
  const { classifyProductOpportunityState } = await import("../src/lib/server/productOpportunities");
  const { productOpportunityViewState } = await import("../src/lib/productOpportunitiesClient");
  test("State classifier distinguishes empty, filtered-empty, and incomplete-count partial", () => {
    assert.equal(classifyProductOpportunityState({ itemCount: 0, filtered: false, totalCount: 0 }), "catalog-empty");
    assert.equal(classifyProductOpportunityState({ itemCount: 0, filtered: true, totalCount: 0 }), "filtered-empty");
    assert.equal(classifyProductOpportunityState({ itemCount: 2, filtered: false, totalCount: null }), "partial");
    assert.equal(classifyProductOpportunityState({ itemCount: 2, filtered: false, totalCount: 2 }), "ready");
  });
test("Client state distinguishes auth/api errors, stale, and syncing", () => {
    const base = {
      message: "Product opportunities could not be loaded",
      method: "GET",
      path: "/api/product-opportunities",
      status: 503,
      code: "CATALOG_UNAVAILABLE" as const,
      requestId: "req-test",
      occurredAt: "2026-09-17T00:00:00.000Z",
      runtime: "caf0ef06d860",
      deployment: "dpl_test",
    };
    assert.equal(productOpportunityViewState(null, base, true), "stale");
    assert.equal(productOpportunityViewState(null, base, false), "api-error");
    assert.equal(productOpportunityViewState(null, { ...base, code: "AUTH_REQUIRED" }, false), "auth-required");
  assert.equal(productOpportunityViewState(null, null, false, true), "syncing");
  assert.match(component, /productOpportunityViewState\(null, info, savedRecordsRef\.current\.length > 0\)/);
});
  console.log(`\nProduct Opportunities 0905 UI contract: ${passed} passed, 0 failed`);
}

void runBehaviorTests();
