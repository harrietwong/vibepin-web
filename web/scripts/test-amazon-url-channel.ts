/**
 * Dual-channel URL security: generic import blocks ALL of Amazon (retail + short
 * links), the dedicated Amazon channel accepts only the exact fetchable whitelist.
 *
 * Run: npx tsx scripts/test-amazon-url-channel.ts
 */
import { isBlockedMarketplace, validateAmazonUrl, validateImportUrl } from "../src/lib/productUrlImport/urlSecurity";
import { AMAZON_RETAIL_HOSTS, AMAZON_SHORT_HOSTS } from "../src/lib/affiliate/amazonHosts";

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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

console.log("\n-- generic channel: Amazon family fully blocked --");

const genericBlocked = [
  "https://www.amazon.com/dp/B08N5WRWNW",
  "https://www.amazon.it/dp/B08N5WRWNW",       // previously leaked through
  "https://www.amazon.co.jp/dp/B08N5WRWNW",    // previously leaked through
  "https://www.amazon.es/dp/B08N5WRWNW",
  "https://amazon.nl/dp/B08N5WRWNW",
  "https://amzn.to/3abcDEF",                    // previously leaked through
  "https://a.co/d/abc123",
  "https://amzn.eu/d/abc",
  "https://amzn.asia/d/abc",
  "https://smile.amazon.co.uk/dp/B08N5WRWNW",
  "https://sellercentral.amazon.de/x",
];
for (const raw of genericBlocked) {
  test(`generic rejects ${raw}`, () => {
    const v = validateImportUrl(raw);
    assert(!v.ok, `${raw} passed the generic channel`);
  });
}

test("blocklist covers every known Amazon host (derived, not hand-copied)", () => {
  for (const host of [...Object.keys(AMAZON_RETAIL_HOSTS), ...AMAZON_SHORT_HOSTS]) {
    assert(isBlockedMarketplace(host), `${host} not blocked`);
    assert(isBlockedMarketplace(`www.${host}`), `www.${host} not blocked`);
  }
});

test("generic channel still accepts non-marketplace hosts (incl. look-alikes)", () => {
  for (const raw of ["https://example.com/p", "https://amazon.com.evil.io/x", "https://myamazon.com/x", "https://shop.example.com/products/vase"]) {
    assert(validateImportUrl(raw).ok, `${raw} should pass generic`);
  }
});

console.log("\n-- amazon channel: exact whitelist --");

const amazonOk: Array<[string, "retail" | "short", string]> = [
  ["https://www.amazon.com/dp/B08N5WRWNW", "retail", "amazon.com"],
  ["https://amazon.co.uk/dp/B08N5WRWNW", "retail", "amazon.co.uk"],
  ["https://www.amazon.de/dp/B08N5WRWNW", "retail", "amazon.de"],
  ["https://www.amazon.fr/dp/B08N5WRWNW", "retail", "amazon.fr"],
  ["https://www.amazon.ca/dp/B08N5WRWNW", "retail", "amazon.ca"],
  ["https://www.amazon.com.au/dp/B08N5WRWNW", "retail", "amazon.com.au"],
  ["https://www.amazon.it/dp/B08N5WRWNW", "retail", "amazon.it"],
  ["https://www.amazon.es/dp/B08N5WRWNW", "retail", "amazon.es"],
  ["https://www.amazon.co.jp/dp/B08N5WRWNW", "retail", "amazon.co.jp"],
  ["https://m.amazon.com/dp/B08N5WRWNW", "retail", "amazon.com"],
  ["https://AMZN.TO/3abc", "short", "amzn.to"],
  ["https://a.co/d/abc123", "short", "a.co"],
];
for (const [raw, kind, host] of amazonOk) {
  test(`amazon channel accepts ${raw}`, () => {
    const v = validateAmazonUrl(raw);
    assert(v.ok, `${raw} rejected: ${v.ok ? "" : v.error}`);
    assert(v.kind === kind && v.host === host, `classified ${v.kind}/${v.host}`);
    assert(v.url.protocol === "https:", "must be https");
  });
}

test("http is upgraded to https", () => {
  const v = validateAmazonUrl("http://www.amazon.com/dp/B08N5WRWNW");
  assert(v.ok && v.url.href === "https://www.amazon.com/dp/B08N5WRWNW", `got ${v.ok ? v.url.href : v.error}`);
});

const amazonReject = [
  "https://amazon.com.evil.io/dp/B08N5WRWNW",
  "https://evil.io/?r=amzn.to",
  "https://amazon.com@evil.io/dp/B08N5WRWNW",
  "https://user:pw@www.amazon.com/dp/B08N5WRWNW",
  "https://www.amazon.com:8443/dp/B08N5WRWNW",
  "https://sellercentral.amazon.com/x",
  "https://aws.amazon.com/",
  "https://www.amazon.nl/dp/B08N5WRWNW",   // recognised, but not a fetchable marketplace
  "https://amzn.eu/d/abc",                 // recognised short host, not fetchable
  "https://www.a.co/d/abc",
  "ftp://www.amazon.com/dp/B08N5WRWNW",
  "javascript:alert(1)",
  "https://[::ffff:127.0.0.1]/",
  "http://localhost/",
  "not a url",
  "",
  `https://www.amazon.com/dp/B08N5WRWNW?${"x".repeat(3000)}`,
];
for (const raw of amazonReject) {
  test(`amazon channel rejects ${raw.slice(0, 60)}`, () => {
    assert(!validateAmazonUrl(raw).ok, `${raw.slice(0, 60)} accepted`);
  });
}

console.log(`\nAmazon URL channel: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
