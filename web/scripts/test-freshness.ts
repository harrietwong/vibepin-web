import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatUpdatedAgo, isDataStale, hoursSince } from "../src/lib/freshness";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  OK ${name}`);
    passed++;
  } catch (error) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${(error as Error).message}`);
    failed++;
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const pickerSource = readFileSync(join(process.cwd(), "src/components/studio/InlineCreateAssetPicker.tsx"), "utf8");
const productsApi = readFileSync(join(process.cwd(), "src/app/api/products/top/route.ts"), "utf8");
const pinsApi = readFileSync(join(process.cwd(), "src/app/api/viral-pins/route.ts"), "utf8");

test("hoursSince returns null for missing date", () => {
  assert(hoursSince(null) === null, "expected null");
});

test("isDataStale true after 48h", () => {
  const old = new Date(Date.now() - 50 * 3_600_000).toISOString();
  assert(isDataStale(old) === true, "should be stale");
});

test("isDataStale false for recent data", () => {
  const recent = new Date(Date.now() - 2 * 3_600_000).toISOString();
  assert(isDataStale(recent) === false, "should be fresh");
});

test("formatUpdatedAgo returns readable string", () => {
  const recent = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const text = formatUpdatedAgo(recent);
  assert(!!text && text.includes("Updated"), "missing prefix");
});

test("Product Ideas API includes freshness metadata", () => {
  assert(productsApi.includes("lastUpdatedAt"), "products API missing lastUpdatedAt");
  assert(productsApi.includes("itemCount"), "products API missing itemCount");
  assert(productsApi.includes("product_ideas_api"), "products API missing source");
});

test("Pin Ideas API includes freshness metadata", () => {
  assert(pinsApi.includes("lastUpdatedAt"), "viral-pins API missing lastUpdatedAt");
  assert(pinsApi.includes("pin_ideas_api"), "viral-pins API missing source");
});

test("Picker shows freshness and stale warning", () => {
  assert(pickerSource.includes("product-ideas-freshness"), "missing product freshness");
  assert(pickerSource.includes("pin-ideas-freshness"), "missing pin freshness");
  assert(pickerSource.includes("Data may be stale"), "missing stale warning");
  assert(pickerSource.includes("productMeta?.products"), "picker should use API meta products");
  assert(pickerSource.includes("pinMeta?.pins"), "picker should use API meta pins");
});

console.log(`\nFreshness tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
