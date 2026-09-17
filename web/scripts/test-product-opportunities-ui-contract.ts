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
  assert.match(component, /role="radio"/);
  assert.match(component, /aria-checked=\{family === value\}/);
  assert.match(enMessages, /products\.opportunities\.typeAll/);
  assert.match(zhCNMessages, /products\.opportunities\.typePhysical/);
  assert.match(zhTWMessages, /products\.opportunities\.typeDigital/);
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
  const {
    classifyProductOpportunityState,
    requireExactProductCatalogCount,
  } = await import("../src/lib/server/productOpportunities");
  const {
    metricFiltersAvailableForDraft,
    parseProductOpportunityFilterQuery,
    productOpportunityFiltersEqual,
    serializeProductOpportunityFilterQuery,
  } = await import("../src/lib/productOpportunityFilters");
  const {
    decodeProductOpportunityDetailResponse,
    decodeProductOpportunityListResponse,
    decodeSavedProductOpportunitiesResponse,
    decodeProductOpportunitySaveResponse,
    normalizeProductOpportunityOccurredAt,
    productOpportunityViewState,
  } = await import("../src/lib/productOpportunitiesClient");
  const {
    productFamilyKeyboardTarget,
    productFamilyTabIndex,
  } = await import("../src/lib/productOpportunityAccessibility");
  const { getMessages } = await import("../src/lib/i18n/messages");
  test("State classifier proves the base catalog exists before claiming filtered-empty", () => {
    assert.equal(classifyProductOpportunityState({ itemCount: 0, filtered: false, totalCount: 0, baseCatalogCount: 0 }), "catalog-empty");
    assert.equal(classifyProductOpportunityState({ itemCount: 0, filtered: true, totalCount: 0, baseCatalogCount: 0 }), "catalog-empty");
    assert.equal(classifyProductOpportunityState({ itemCount: 0, filtered: true, totalCount: 0, baseCatalogCount: 7 }), "filtered-empty");
    assert.equal(classifyProductOpportunityState({ itemCount: 2, filtered: false, totalCount: null, baseCatalogCount: 2 }), "partial");
    assert.equal(classifyProductOpportunityState({ itemCount: 2, filtered: false, totalCount: 2, baseCatalogCount: 2 }), "ready");
    assert.throws(() => requireExactProductCatalogCount(null), /exact count/i);
    assert.equal(requireExactProductCatalogCount(0), 0);
  });
  test("Draft family invalidates stale metric controls and exposes unapplied changes", () => {
    const controls = { available: true, family: "physical" as const, metricVersion: 7 };
    assert.equal(metricFiltersAvailableForDraft("physical", "physical", controls), true);
    assert.equal(metricFiltersAvailableForDraft("all", "physical", controls), false);
    assert.equal(metricFiltersAvailableForDraft("digital", "physical", controls), false);
    assert.equal(productOpportunityFiltersEqual(
      { family: "physical", search: "", category: "", platform: "", demand: "", trend: "", sort: "most_saved" },
      { family: "digital", search: "", category: "", platform: "", demand: "", trend: "", sort: "most_saved" },
    ), false);
    assert.match(component, /products\.opportunities\.filtersPending/);
  });
  test("Applying same-family filters retains proven metric controls until the response replaces them", () => {
    const applyStart = component.indexOf("  const applyFilters = () => {");
    const clearStart = component.indexOf("  const clearFilters = () => {", applyStart);
    assert.ok(applyStart >= 0 && clearStart > applyStart, "applyFilters source boundary is present");
    const applySource = component.slice(applyStart, clearStart);
    assert.doesNotMatch(applySource, /setMetricControls\(/);
    assert.equal(metricFiltersAvailableForDraft("physical", "physical", {
      available: true,
      family: "physical",
    }), true);
  });
  test("Product filter query parser is allowlisted, normalized, and round-trips Back/Forward state", () => {
    const parsed = parseProductOpportunityFilterQuery("?family=digital&q= planner &category=digital-products&platform=etsy.com&sort=newest&token=secret&selection=private");
    assert.deepEqual(parsed, {
      family: "digital", search: "planner", category: "digital-products", platform: "etsy.com",
      demand: "", trend: "", sort: "newest",
    });
    const serialized = serializeProductOpportunityFilterQuery(parsed);
    assert.match(serialized, /family=digital/);
    assert.match(serialized, /q=planner/);
    assert.doesNotMatch(serialized, /token|selection|private|secret/);
    assert.deepEqual(parseProductOpportunityFilterQuery(`?${serialized}`), parsed);
    assert.deepEqual(parseProductOpportunityFilterQuery("?family=bad&sort=bad&trend=bad"), {
      family: "all", search: "", category: "", platform: "", demand: "", trend: "", sort: "most_saved",
    });
  });
  test("Catalog UI respects the canonical empty state and applies all controls transactionally", () => {
    assert.doesNotMatch(component, /dataState === "filtered-empty" \|\| hasCatalogFilters/);
    assert.match(component, /applyProductFilters/);
    assert.match(component, /popstate/);
    assert.match(component, /serializeProductOpportunityFilterQuery/);
    assert.match(component, /<details[^>]*className=\{styles\.errorEvidence\}/);
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
  assert.equal(productOpportunityViewState(null, null, false), "loading");
  assert.equal(productOpportunityViewState({
    items: [], accessibleCount: 0, hasLockedCatalog: false,
    metricControls: { available: false, family: null, metricVersion: null },
    planAccess: "full", state: "catalog-empty", stateReason: null, evidence: {
      method: "GET", path: "/api/product-opportunities", status: 200,
      requestId: "req-test", occurredAt: "2026-09-17T00:00:00.000Z", runtime: null, deployment: null,
    },
  }, null, false), "catalog-empty");
  assert.equal(productOpportunityViewState(null, null, false, true), "syncing");
  assert.match(component, /productOpportunityViewState\(null, info, savedRecordsRef\.current\.length > 0\)/);
});
  test("Product opportunity copy is translated in the active locale", () => {
    const keys = [
      "products.opportunities.title",
      "products.opportunities.typeAll",
      "products.opportunities.createPin",
      "products.opportunities.catalogEmptyTitle",
      "products.opportunities.savedFilteredEmptyBody",
    ] as const;
    for (const key of keys) {
      const english = getMessages("en")[key];
      assert.notEqual(getMessages("zh-CN")[key], english, `zh-CN must translate ${key}`);
      assert.notEqual(getMessages("zh-TW")[key], english, `zh-TW must translate ${key}`);
    }
  });
  const evidence = {
    method: "GET",
    path: "/api/product-opportunities",
    status: 200,
    requestId: "req-test",
    occurredAt: "2026-09-17T00:00:00.000Z",
    runtime: "caf0ef06d860",
    deployment: "dpl_test",
  };
  const item = {
    id: "opp-1",
    productName: "Woven basket",
    productImageUrl: "https://example.com/product.jpg",
    productUrl: "https://example.com/product",
    merchant: "Example",
    domain: "example.com",
    category: "home-decor",
    productType: "basket",
    productFamily: "physical" as const,
    pinterestUrl: "https://www.pinterest.com/pin/1",
    pinterestEvidenceType: "product_pin" as const,
    additionalPinterestEvidence: [],
    latestPinterestSaves: null,
    latestPinterestSnapshotAt: null,
    savesGained30d: null,
    currentSavesGained7d: null,
    previousSavesGained7d: null,
    highRecentDemand: null,
    recentMomentum: null,
    momentumPercent: null,
  };
  const listPayload = {
    items: [item],
    accessibleCount: 1,
    hasLockedCatalog: false,
    metricControls: { available: false, family: null, metricVersion: null },
    planAccess: "full" as const,
    state: "ready" as const,
    stateReason: null,
    evidence,
  };
  test("2xx list/detail/saved payloads are decoded, not cast", () => {
    assert.deepEqual(decodeProductOpportunityListResponse(listPayload, "/api/product-opportunities", "GET", 200), listPayload);
    assert.deepEqual(decodeProductOpportunityDetailResponse({ item, evidence: { ...evidence, path: "/api/product-opportunities/opp-1" } }, "/api/product-opportunities/opp-1", "GET", 200).item, item);
    assert.deepEqual(decodeSavedProductOpportunitiesResponse({ items: [], evidence: { ...evidence, path: "/api/saved-product-opportunities" } }, "/api/saved-product-opportunities", "GET", 200).items, []);
    assert.deepEqual(decodeProductOpportunitySaveResponse({ saved: true, evidence: { ...evidence, method: "POST", path: "/api/saved-product-opportunities", status: 201 } }, "/api/saved-product-opportunities", "POST", 201, true).saved, true);
  });
  test("Contradictory successful list states fail closed as INVALID_RESPONSE", () => {
    for (const contradictory of [
      { ...listPayload, items: [], accessibleCount: 0, state: "ready" as const },
      { ...listPayload, items: [item], accessibleCount: 1, state: "catalog-empty" as const },
      { ...listPayload, items: [], accessibleCount: 0, state: "partial" as const, stateReason: "incomplete-count" as const },
      { ...listPayload, items: [], accessibleCount: 3, state: "filtered-empty" as const },
    ]) {
      assert.throws(
        () => decodeProductOpportunityListResponse(contradictory, "/api/product-opportunities", "GET", 200),
        (error: unknown) => error instanceof Error
          && (error as { info?: { code?: string } }).info?.code === "INVALID_RESPONSE",
      );
    }
  });
  test("Save and unsave responses must match the requested intent", () => {
    const saveEvidence = { ...evidence, method: "POST", path: "/api/saved-product-opportunities", status: 201 };
    const removeEvidence = { ...evidence, method: "DELETE", path: "/api/saved-product-opportunities", status: 200 };
    assert.throws(
      () => decodeProductOpportunitySaveResponse({ saved: false, evidence: saveEvidence }, "/api/saved-product-opportunities", "POST", 201, true),
      (error: unknown) => error instanceof Error
        && (error as { info?: { code?: string } }).info?.code === "INVALID_RESPONSE",
    );
    assert.throws(
      () => decodeProductOpportunitySaveResponse({ saved: true, evidence: removeEvidence }, "/api/saved-product-opportunities", "DELETE", 200, false),
      (error: unknown) => error instanceof Error
        && (error as { info?: { code?: string } }).info?.code === "INVALID_RESPONSE",
    );
  });
  test("Product family radios expose roving keyboard targets and one tab stop", () => {
    assert.equal(productFamilyKeyboardTarget("all", "ArrowRight"), "physical");
    assert.equal(productFamilyKeyboardTarget("physical", "ArrowLeft"), "all");
    assert.equal(productFamilyKeyboardTarget("all", "ArrowDown"), "physical");
    assert.equal(productFamilyKeyboardTarget("digital", "ArrowRight"), "all");
    assert.equal(productFamilyKeyboardTarget("physical", "Home"), "all");
    assert.equal(productFamilyKeyboardTarget("physical", "End"), "digital");
    assert.equal(productFamilyKeyboardTarget("all", "Enter"), null);
    assert.equal(productFamilyTabIndex("all", "all"), 0);
    assert.equal(productFamilyTabIndex("all", "physical"), -1);
    assert.match(component, /productFamilyKeyboardTarget/);
    assert.match(component, /tabIndex=\{productFamilyTabIndex\(family, value\)\}/);
    assert.match(component, /aria-label=\{optionLabel\}/);
  });
  test("invalid 2xx payloads fail closed as INVALID_RESPONSE", () => {
    assert.throws(
      () => decodeProductOpportunityListResponse({ ...listPayload, state: undefined }, "/api/product-opportunities?search=secret", "GET", 200),
      (error: unknown) => error instanceof Error && /invalid response/i.test(error.message) && (error as { info?: { code?: string; path?: string } }).info?.code === "INVALID_RESPONSE" && (error as { info?: { path?: string } }).info?.path === "/api/product-opportunities",
    );
    assert.throws(
      () => decodeProductOpportunityDetailResponse({ item }, "/api/product-opportunities/opp-1?token=secret", "GET", 200),
      (error: unknown) => error instanceof Error && (error as { info?: { code?: string } }).info?.code === "INVALID_RESPONSE",
    );
    assert.throws(
      () => decodeSavedProductOpportunitiesResponse({ items: {} }, "/api/saved-product-opportunities", "GET", 200),
      (error: unknown) => error instanceof Error && (error as { info?: { code?: string } }).info?.code === "INVALID_RESPONSE",
    );
  });
  test("Malformed error timestamps are discarded before localized rendering", () => {
    const normalized = normalizeProductOpportunityOccurredAt("not-a-date", "2026-09-17T00:00:00.000Z");
    assert.equal(normalized, "2026-09-17T00:00:00.000Z");
    assert.equal(
      normalizeProductOpportunityOccurredAt("2026-09-17T03:04:05.000Z", "2026-09-17T00:00:00.000Z"),
      "2026-09-17T03:04:05.000Z",
    );
  });
  test("evidence is real and request paths never expose query strings", () => {
    assert.throws(() => decodeProductOpportunityListResponse({ ...listPayload, evidence: { ...evidence, method: "", path: "/api/product-opportunities?secret=1" } }, "/api/product-opportunities", "GET", 200));
    assert.throws(() => decodeProductOpportunityListResponse({ ...listPayload, evidence: { ...evidence, status: 0 } }, "/api/product-opportunities", "GET", 200));
  });
  console.log(`\nProduct Opportunities 0905 UI contract: ${passed} passed, 0 failed`);
}

void runBehaviorTests();
