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
});

test("Database/API errors cannot fall through to a normal empty catalog", () => {
  assert.match(component, /error\?\.[\s\S]*api-error|error[\s\S]*api-error/);
  assert.match(component, /dataRequestFailed[\s\S]*catalogRows\.length === 0/);
  const failureBranch = component.indexOf("dataRequestFailed && catalogRows.length === 0");
  const emptyBranch = component.indexOf("catalogRows.length === 0 && (mode !== \"saved\"");
  assert.ok(failureBranch >= 0 && emptyBranch > failureBranch, "error branch must render before empty branch");
  assert.match(component, /Product data could not be loaded|Product opportunities could not be loaded/);
});

test("Auth-required is distinct from catalog-empty", () => {
  assert.match(client, /AUTH_REQUIRED/);
  assert.match(component, /auth-required/);
  assert.match(component, /Please sign in|Sign in/);
});

test("Partial, stale, and syncing data stay visible as status, never fabricated products", () => {
  assert.match(component, /partial/);
  assert.match(component, /stale/);
  assert.match(component, /syncing/);
  assert.doesNotMatch(component, /\bProduct\s+\d+\b/);
  assert.doesNotMatch(component, /placeholder product|fake product|mock product/i);
});

test("All, Physical, and Digital live in one filter bar", () => {
  assert.match(component, /className=\{styles\.filters\}/);
  assert.match(component, /All products/);
  assert.match(component, /Physical/);
  assert.match(component, /Digital/);
  assert.doesNotMatch(component, /className=\{styles\.toolbar\}/);
  assert.match(styles, /@media\(max-width:430px\)[\s\S]*filters/);
});

test("Product Opportunities header is compact on mobile", () => {
  assert.match(styles, /\.header h1\{[^}]*font-size:clamp\(24px/);
  assert.match(styles, /@media\(max-width:430px\)[\s\S]*header h1/);
});

console.log(`\nProduct Opportunities 0905 UI contract: ${passed} passed, 0 failed`);
