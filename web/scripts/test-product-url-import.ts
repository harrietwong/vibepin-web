import {
  extractCandidatesFromHtml,
  extractProductImagesFromUrl,
  finalizeCandidates,
  importProductUrls,
  importUrl,
  validateImportUrl,
} from "../src/lib/productUrlImport";
import { parseProductImportUrls, autoSelectTopCandidates } from "../src/lib/productUrlImportClient";
import { createGuardedDnsLookup, isPublicIpAddress, safeOutboundUrl } from "../src/app/api/fetch-og/safeOutboundUrl";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve(fn()).then(
    () => { console.log(`  OK ${name}`); passed++; },
    (error) => { console.error(`  FAIL ${name}`); console.error(`       ${(error as Error).message}`); failed++; },
  );
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const pickerSource = readFileSync(join(process.cwd(), "src/components/studio/InlineCreateAssetPicker.tsx"), "utf8");
const panelSource  = readFileSync(join(process.cwd(), "src/components/studio/ProductUrlImportPanel.tsx"), "utf8");

// ── HTML fixtures ────────────────────────────────────────────────────────────

const JSONLD_HTML = `<!DOCTYPE html><html><head>
<script type="application/ld+json">{"@type":"Product","name":"Wicker Basket","image":"https://cdn.example.com/basket.jpg"}</script>
</head><body></body></html>`;

const OG_HTML = `<!DOCTYPE html><html><head>
<meta property="og:image" content="https://cdn.example.com/og-main.jpg" />
<meta property="og:title" content="Vanilla Candle" />
</head><body></body></html>`;

const TWITTER_HTML = `<!DOCTYPE html><html><head>
<meta name="twitter:image" content="https://cdn.example.com/tw-main.jpg" />
<meta name="twitter:title" content="Silk Dress" />
</head><body></body></html>`;

const DUPLICATE_HTML = `<!DOCTYPE html><html><head>
<meta property="og:image" content="https://cdn.example.com/same.jpg" />
<meta name="twitter:image" content="https://cdn.example.com/same.jpg" />
</head><body><img src="https://cdn.example.com/same.jpg" width="800" height="800" /></body></html>`;

const MANY_IMAGES_HTML = `<!DOCTYPE html><html><body>${
  Array.from({ length: 12 }, (_, i) => `<img src="https://cdn.example.com/p${i}.jpg" width="600" height="600" />`).join("")
}</body></html>`;

const SHOPIFY_JSON_BODY = JSON.stringify({
  product: {
    title: "Boho Vase",
    images: [
      { src: "https://cdn.shopify.com/products/vase-1.jpg", width: 1200, height: 1200 },
      { src: "https://cdn.shopify.com/products/vase-2.jpg", width: 1200, height: 1200 },
    ],
  },
});

const SHOPIFY_HTML = `<!DOCTYPE html><html><head>
<meta property="og:image" content="https://cdn.shopify.com/products/vase-og.jpg" />
<meta property="og:title" content="Boho Vase" />
</head><body>
<img src="https://cdn.shopify.com/products/vase-gallery.jpg" width="800" height="800" />
</body></html>`;

const WOOCOMMERCE_HTML = `<!DOCTYPE html><html><head>
<meta property="og:image" content="https://shop.example.com/wp-content/uploads/vase-og.jpg" />
<meta property="og:title" content="Ceramic Vase" />
</head><body>
<div class="woocommerce-product-gallery__image" data-large_image="https://shop.example.com/wp-content/uploads/vase-large.jpg">
  <img src="https://shop.example.com/wp-content/uploads/vase-thumb.jpg" />
</div>
</body></html>`;

// ── Original tests (kept) ─────────────────────────────────────────────────────

async function runOriginalTests() {
  await test("Direct image URL returns one candidate", async () => {
    const result = await extractProductImagesFromUrl("https://cdn.example.com/photo.jpg");
    assert(result.status === "success", "expected success");
    assert(result.candidates?.length === 1, "expected one candidate");
    assert(result.candidates![0].reason === "direct_image_url", "expected direct_image_url reason");
  });

  await test("JSON-LD Product.image extraction works", async () => {
    const extracted = extractCandidatesFromHtml(JSONLD_HTML, "https://shop.example.com/products/basket");
    assert(extracted.title === "Wicker Basket", "title from JSON-LD");
    assert(extracted.candidates.some(c => c.reason === "jsonld_product_image"), "jsonld candidate missing");
  });

  await test("og:image extraction works", async () => {
    const extracted = extractCandidatesFromHtml(OG_HTML, "https://shop.example.com/products/candle");
    assert(extracted.title === "Vanilla Candle", "title from og:title");
    assert(extracted.candidates.some(c => c.reason === "og_image"), "og candidate missing");
  });

  await test("twitter:image extraction works", async () => {
    const extracted = extractCandidatesFromHtml(TWITTER_HTML, "https://shop.example.com/products/dress");
    assert(extracted.title === "Silk Dress", "title from twitter:title");
    assert(extracted.candidates.some(c => c.reason === "twitter_image"), "twitter candidate missing");
  });

  await test("Duplicate images are removed", async () => {
    const extracted = extractCandidatesFromHtml(DUPLICATE_HTML, "https://shop.example.com/products/item");
    const urls = extracted.candidates.map(c => c.imageUrl);
    assert(new Set(urls).size === urls.length, "duplicate image URLs remain");
  });

  await test("More than 8 candidates are capped", async () => {
    const extracted = extractCandidatesFromHtml(MANY_IMAGES_HTML, "https://shop.example.com/products/many");
    assert(extracted.candidates.length <= 8, `expected max 8 candidates, got ${extracted.candidates.length}`);
  });

  await test("Invalid URL returns failed result", async () => {
    const result = await extractProductImagesFromUrl("not-a-url");
    assert(result.status === "failed", "expected failed status");
  });

  await test("Private/internal URL is blocked", async () => {
    const v = validateImportUrl("http://127.0.0.1/product");
    assert(!v.ok, "localhost should be blocked");
    const result = await extractProductImagesFromUrl("http://127.0.0.1/product");
    assert(result.status === "failed", "expected failed status");
  });

  await test("Timeout returns failed result", async () => {
    const result = await extractProductImagesFromUrl("https://shop.example.com/slow", async () => {
      throw new Error("Request timed out");
    });
    assert(result.status === "failed", "expected failed on timeout");
    assert(result.error != null && result.error.includes("timed out"), "expected timeout message");
  });

  await test("Batch with mixed success/failure returns partial results", async () => {
    const fetchPage = async (url: string) => {
      if (url.includes("good")) return { html: OG_HTML, finalUrl: url };
      throw new Error("Could not extract product images");
    };
    const results = await importProductUrls(
      ["https://shop.example.com/good-1", "https://shop.example.com/bad-1"],
      fetchPage,
    );
    assert(results.length === 2, "expected two results");
    assert(results.some(r => r.status === "success"), "expected one success");
    assert(results.some(r => r.status === "failed"), "expected one failure");
  });

  await test("finalizeCandidates deduplicates and sorts by score", () => {
    const out = finalizeCandidates([
      { imageUrl: "/a.jpg", score: 0.5, reason: "html_img_fallback", width: 600, height: 600 },
      { imageUrl: "/a.jpg", score: 0.9, reason: "og_image",           width: 600, height: 600 },
      { imageUrl: "/b.jpg", score: 0.4, reason: "html_img_fallback", width: 600, height: 600 },
    ], "https://example.com/page");
    assert(out.length === 2, "expected two unique candidates");
    assert(out[0].score >= out[1].score, "expected descending score sort");
  });

  // Frontend unit tests (source checks)
  await test("Import from URL is inside My Products, not a top-level tab", () => {
    assert(pickerSource.includes("ProductUrlImportPanel"), "ProductUrlImportPanel missing");
    assert(!pickerSource.includes('label: "URL Import"'), "URL Import top-level tab found");
    assert(pickerSource.includes('productTab === "my_products"'), "my_products tab guard missing");
  });

  await test("Pasting more than 10 URLs shows a limit warning", () => {
    assert(panelSource.includes("url-import-limit-warning"), "limit warning test id missing");
    const parsed = parseProductImportUrls(
      Array.from({ length: 12 }, (_, i) => `https://shop.example.com/p${i}`).join("\n"),
    );
    assert(parsed.overBatchLimit, "expected overBatchLimit");
    assert(parsed.urls.length === 10, "expected 10 urls after cap");
  });

  await test("Duplicate pasted URLs are deduplicated", () => {
    const parsed = parseProductImportUrls("https://a.com/1\nhttps://a.com/1\nhttps://b.com/2");
    assert(parsed.urls.length === 2, "expected two unique urls");
    assert(parsed.dedupedCount === 1, "expected one duplicate removed");
  });

  await test("Extract images calls /api/import/product-urls", () => {
    const clientSource = readFileSync(join(process.cwd(), "src/lib/productUrlImportClient.ts"), "utf8");
    assert(clientSource.includes("/api/import/product-urls"), "API endpoint missing in client");
    assert(panelSource.includes("fetchProductUrlImport"), "panel must call fetchProductUrlImport");
  });

  await test("Successful results render grouped by URL", () => {
    assert(panelSource.includes("url-import-result-group"), "result group test id missing");
  });

  await test("Highest-scoring candidate is preselected", () => {
    const selected = autoSelectTopCandidates([
      {
        sourceUrl: "https://a.com", sourceDomain: "a.com", status: "success",
        candidates: [
          { id: "low",  imageUrl: "https://img/a-low.jpg",  score: 0.5,  reason: "html_img_fallback" },
          { id: "high", imageUrl: "https://img/a-high.jpg", score: 0.95, reason: "jsonld_product_image" },
        ],
      },
    ]);
    assert(selected.has("https://a.com::high"), "expected highest score preselected");
  });

  await test("Save selected saves to My Products URL Imported via picker handler", () => {
    assert(pickerSource.includes("saveUrlImportedProducts"), "saveUrlImportedProducts missing");
    assert(pickerSource.includes('source:           "url"'), "url source save missing");
    assert(pickerSource.includes('role:             "product"'), "product role save missing");
  });

  await test("Product imports do not appear in Pin References", () => {
    assert(pickerSource.includes('role:             "product"'), "url import must save as product role");
    assert(!panelSource.includes("style_reference"), "import panel must not touch reference pool");
  });
}

// ── New tests for provider-based adapter system ───────────────────────────────

async function runProviderTests() {
  // 1. Direct image URL
  await test("1. Direct image URL returns exactly one candidate with reason=direct_image_url", async () => {
    const result = await importUrl("https://cdn.example.com/product-photo.jpg");
    assert(result.status === "success",              "expected success");
    assert(result.provider === "direct_image",       "expected direct_image provider");
    assert(result.assetType === "product",           "expected product assetType");
    assert(result.candidates?.length === 1,          "expected one candidate");
    assert(result.candidates![0].reason === "direct_image_url", "expected direct_image_url reason");
  });

  // 2. Generic JSON-LD product page
  await test("2. Generic JSON-LD product page returns structured candidates", async () => {
    const fetchPage = async (url: string) => ({ html: JSONLD_HTML, finalUrl: url });
    const result = await importUrl("https://shop.example.com/products/basket", fetchPage);
    assert(result.status === "success",          "expected success");
    assert(result.provider === "generic" || result.provider === "shopify", "expected generic or shopify provider");
    assert(!!result.candidates?.some(c => c.reason === "jsonld_product_image"), "expected JSON-LD candidate");
    assert(result.title === "Wicker Basket",     "expected title from JSON-LD");
  });

  // 3. Shopify product.json returns structured data
  await test("3. Shopify adapter uses product.json endpoint", async () => {
    const fetchPage = async (url: string) => {
      if (url.endsWith(".json")) return { html: SHOPIFY_JSON_BODY, finalUrl: url };
      return { html: SHOPIFY_HTML, finalUrl: url };
    };
    const result = await importUrl("https://myshop.myshopify.com/products/boho-vase", fetchPage);
    assert(result.status === "success",            "expected success");
    assert(result.provider === "shopify",          "expected shopify provider");
    assert(!!result.candidates?.some(c => c.reason === "shopify_product_json"), "expected product_json candidate");
    assert(result.title === "Boho Vase",           "expected Shopify title");
  });

  // 4. WooCommerce gallery images
  await test("4. WooCommerce adapter extracts gallery images", async () => {
    const fetchPage = async (url: string) => ({ html: WOOCOMMERCE_HTML, finalUrl: url });
    const result = await importUrl("https://shop.example.com/product/ceramic-vase/", fetchPage);
    assert(result.status === "success",            "expected success");
    assert(result.provider === "woocommerce",      "expected woocommerce provider");
    assert(
      !!result.candidates?.some(c => c.reason === "woocommerce_gallery"),
      "expected woocommerce_gallery candidate",
    );
  });

  // 5. Etsy 403 → graceful blocked response, no raw "HTTP 403"
  await test("5. Etsy 403 returns blocked status with friendly message, not raw HTTP 403", async () => {
    const fetchPage = async (_url: string): Promise<{ html: string; finalUrl: string }> => {
      throw new Error("HTTP 403");
    };
    const result = await importUrl("https://www.etsy.com/listing/123456789/boho-vase", fetchPage);
    assert(result.status === "blocked",       "expected blocked status");
    assert(result.provider === "etsy",        "expected etsy provider");
    assert(result.assetType === "product",    "expected product assetType");
    assert(result.message != null,            "expected a friendly message");
    assert(!result.message!.includes("HTTP 403"), "message must not contain raw HTTP 403");
    assert(result.fallbackActions != null && result.fallbackActions.length > 0, "expected fallback actions");
    assert(result.fallbackActions!.includes("upload_image"), "expected upload_image fallback");
  });

  // 6. Pinterest URL → assetType = reference
  await test("6. Pinterest pin URL defaults to assetType=reference", async () => {
    const fetchPage = async (_url: string): Promise<{ html: string; finalUrl: string }> => {
      throw new Error("HTTP 403");
    };
    const result = await importUrl("https://www.pinterest.com/pin/123456789012345678/", fetchPage);
    assert(result.assetType === "reference", "expected reference assetType for Pinterest");
    assert(result.provider === "pinterest",  "expected pinterest provider");
  });

  // 7. Pinterest URL pasted into product picker → panel shows warning not candidate grid
  await test("7. ProductUrlImportPanel shows Pinterest warning when assetType=reference in product picker", () => {
    assert(panelSource.includes("url-import-pinterest-warning"), "Pinterest warning testid missing");
    assert(panelSource.includes("assetType"), "panel must handle assetType field");
    assert(panelSource.includes('role === "product"'), "panel must check role for reference warning");
  });

  // 8. SSRF protection blocks localhost / private IPs / file / data / javascript
  await test("8. SSRF guard blocks private IPs and non-http protocols", () => {
    const shouldBlock = [
      "http://127.0.0.1/secret",
      "http://10.0.0.1/internal",
      "http://192.168.1.1/admin",
      "http://localhost/api",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:image/png;base64,abc",
      "ftp://files.example.com/photo.jpg",
    ];
    for (const url of shouldBlock) {
      const v = validateImportUrl(url);
      assert(!v.ok, `Expected ${url} to be blocked but it was allowed`);
    }
  });

  // 9. Duplicate candidates after extraction are deduped
  await test("9. Duplicate image URLs across sources are deduped in finalizeCandidates", () => {
    const raw = [
      { imageUrl: "https://cdn.example.com/img.jpg", score: 0.9, reason: "og_image"          as const },
      { imageUrl: "https://cdn.example.com/img.jpg", score: 0.5, reason: "html_img_fallback" as const },
    ];
    const result = finalizeCandidates(raw, "https://example.com/page");
    const urls = result.map(c => c.imageUrl);
    assert(new Set(urls).size === urls.length, "expected deduped candidates");
    assert(result.length === 1, `expected 1 unique candidate, got ${result.length}`);
  });

  // 10. Tiny / logo / icon images are filtered out
  await test("10. finalizeCandidates filters out icon/logo/tiny images", () => {
    const raw = [
      { imageUrl: "https://example.com/logo.png",    score: 0.5, reason: "html_img_fallback" as const, width: 50, height: 50 },
      { imageUrl: "https://example.com/icon.png",    score: 0.5, reason: "html_img_fallback" as const },
      { imageUrl: "https://example.com/product.jpg", score: 0.7, reason: "og_image"          as const, width: 800, height: 800 },
    ];
    const result = finalizeCandidates(raw, "https://example.com/page");
    assert(!result.some(c => c.imageUrl.includes("logo.png")), "logo should be filtered out");
    assert(!result.some(c => c.imageUrl.includes("icon.png")), "icon should be filtered out");
    assert(result.some(c => c.imageUrl.includes("product.jpg")), "product image should pass");
  });

  // 11. Multi-URL import: one blocked URL does not fail the entire batch
  await test("11. Multi-URL batch: one Etsy block does not fail other URLs", async () => {
    const fetchPage = async (url: string) => {
      if (url.includes("etsy.com")) throw new Error("HTTP 403");
      if (url.includes("good"))    return { html: OG_HTML, finalUrl: url };
      throw new Error("unknown");
    };
    const results = await importProductUrls([
      "https://www.etsy.com/listing/999/ring",
      "https://shop.example.com/good/candle",
    ], fetchPage);
    assert(results.length === 2, "expected 2 results");
    const etsyResult = results.find(r => r.sourceUrl.includes("etsy.com"));
    const goodResult = results.find(r => r.sourceUrl.includes("good"));
    assert(etsyResult?.status === "blocked",  "Etsy should be blocked, not global fail");
    assert(goodResult?.status === "success",  "good URL should still succeed");
    assert(etsyResult?.provider === "etsy",   "Etsy result should have etsy provider");
    assert(goodResult?.assetType === "product", "product URLs should have product assetType");
  });
}

async function run() {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://test-placeholder.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "test-placeholder-anon-key";
  const { fetchWithSafeRedirects, handleGet, readLimitedText } = await import("../src/app/api/fetch-og/handler");
  console.log("\n── Original tests ────────────────────────────────────────────────────────");
  await runOriginalTests();

  console.log("\n── Provider adapter tests ───────────────────────────────────────────────");
  await runProviderTests();

  console.log("\n── Safe outbound URL tests ─────────────────────────────────────────────");
  const publicDns = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ];

  await test("12. safe outbound guard accepts hosts whose DNS answers are all public", async () => {
    const url = await safeOutboundUrl("https://example.com/path", publicDns);
    assert(url.hostname === "example.com", "expected public hostname to pass");
  });

  await test("13. safe outbound guard rejects credentials and non-HTTP schemes", async () => {
    for (const input of ["file:///etc/passwd", "https://user:pass@example.com"]) {
      let rejected = false;
      try { await safeOutboundUrl(input, publicDns); } catch { rejected = true; }
      assert(rejected, `expected rejection for ${input}`);
    }
  });

  await test("14. safe outbound guard rejects private and non-standard IP literals", async () => {
    for (const input of [
      "http://127.0.0.1",
      "http://10.0.0.1",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]",
      "http://[fe80::1]",
      "http://127.1",
      "http://0177.0.0.1",
      "http://2130706433",
    ]) {
      let rejected = false;
      try { await safeOutboundUrl(input, publicDns); } catch { rejected = true; }
      assert(rejected, `expected rejection for ${input}`);
    }
  });

  await test("15. safe outbound guard rejects mixed public/private DNS answers", async () => {
    let rejected = false;
    try {
      await safeOutboundUrl("https://example.com", async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]);
    } catch { rejected = true; }
    assert(rejected, "expected mixed DNS answers to be rejected");
  });

  await test("16. safe outbound IP classifier rejects mapped and private addresses", () => {
    assert(isPublicIpAddress("8.8.8.8"), "public IPv4 should pass");
    assert(isPublicIpAddress("2606:4700:4700::1111"), "public IPv6 should pass");
    assert(!isPublicIpAddress("192.168.1.1"), "private IPv4 should fail");
    assert(!isPublicIpAddress("::ffff:127.0.0.1"), "mapped loopback should fail");
    assert(!isPublicIpAddress("fc00::1"), "unique-local IPv6 should fail");
  });

  await test("17. only default/explicit HTTP(S) ports are allowed", async () => {
    for (const input of [
      "https://example.com:3000",
      "http://example.com:8080",
      "https://example.com:80",
      "http://example.com:443",
    ]) {
      let rejected = false;
      try { await safeOutboundUrl(input, publicDns); } catch { rejected = true; }
      assert(rejected, `expected non-web port rejection for ${input}`);
    }
    await safeOutboundUrl("https://example.com:443", publicDns);
    await safeOutboundUrl("http://example.com:80", publicDns);
  });

  const fakeResponse = (statusCode: number, headers: Record<string, string>, chunks: Uint8Array[] = []) => ({
    statusCode,
    headers,
    destroy: () => undefined,
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; },
  });
  const allowFetchOg = async () => ({ allowed: true as const, reason: "under_limit" as const, remaining: 59 });

  await test("18. auth is checked before any outbound request", async () => {
    let networkCalls = 0;
    const response = await handleGet(new Request("https://app.test/api/fetch-og?url=https://example.com"), {
      getUserId: async () => null,
      consumeRateLimit: allowFetchOg,
      fetchWithSafeRedirects: async () => { networkCalls++; throw new Error("network must not run"); },
    });
    assert(response.status === 401, "expected unauthorized response");
    assert(networkCalls === 0, "outbound request ran before auth");
  });

  await test("19. connection-time DNS rebinding is rejected", async () => {
    let resolutions = 0;
    const resolveRebinding = async () => (++resolutions === 1
      ? [{ address: "93.184.216.34", family: 4 }]
      : [{ address: "127.0.0.1", family: 4 }]);
    let rejected = false;
    try {
      await fetchWithSafeRedirects("https://example.com/start", {
        resolveHostname: resolveRebinding,
        requestUrl: async (_url, lookup) => new Promise((resolve, reject) => {
          lookup("example.com", {}, error => {
            if (error) reject(error);
            else resolve(fakeResponse(200, {}) as never);
          });
        }),
      });
    } catch { rejected = true; }
    assert(rejected, "private connection-time answer should be rejected after public preflight");
    assert(resolutions === 2, `expected preflight plus connection lookup, got ${resolutions}`);
  });

  await test("20. redirect to private host is rejected before second request", async () => {
    let calls = 0;
    let rejected = false;
    try {
      await fetchWithSafeRedirects("https://example.com/start", {
        resolveHostname: publicDns,
        requestUrl: async () => {
          calls++;
          return fakeResponse(302, { location: "http://127.0.0.1/secret" }) as never;
        },
      });
    } catch { rejected = true; }
    assert(rejected, "private redirect should be rejected");
    assert(calls === 1, "request was made after private redirect");
  });

  await test("21. redirect limit is enforced", async () => {
    let calls = 0;
    let rejected = false;
    try {
      await fetchWithSafeRedirects("https://example.com/start", {
        resolveHostname: publicDns,
        requestUrl: async () => {
          calls++;
          return fakeResponse(302, { location: "/again" }) as never;
        },
      });
    } catch { rejected = true; }
    assert(rejected, "redirect chain should fail at limit");
    assert(calls === 4, `expected 4 allowed requests, got ${calls}`);
  });

  await test("22. Content-Length and chunked bodies share a 256 KiB ceiling", async () => {
    const tooLarge = new Uint8Array(256 * 1024 + 1);
    let rejected = false;
    try { await readLimitedText(fakeResponse(200, { "content-length": String(tooLarge.byteLength) }) as never); } catch { rejected = true; }
    assert(rejected, "oversized Content-Length should fail before reading");
    rejected = false;
    try { await readLimitedText(fakeResponse(200, {}, [tooLarge]) as never); } catch { rejected = true; }
    assert(rejected, "oversized chunked body should fail while reading");
  });

  await test("23. handler errors use generic messages without upstream details", async () => {
    const response = await handleGet(new Request("https://app.test/api/fetch-og?url=https://example.com"), {
      getUserId: async () => "user-1",
      consumeRateLimit: allowFetchOg,
      fetchWithSafeRedirects: async () => { throw new Error("secret-host:5432 ECONNREFUSED"); },
    });
    const body = await response.json() as { error?: string };
    assert(response.status === 502, "expected upstream failure status");
    assert(body.error === "Unable to fetch URL", "unexpected error detail leaked");
    assert(!JSON.stringify(body).includes("secret-host"), "upstream host leaked");
  });

  await test("24. per-user limiter runs before outbound fetch and returns a bounded retry", async () => {
    let networkCalls = 0;
    const response = await handleGet(new Request("https://app.test/api/fetch-og?url=https://example.com"), {
      getUserId: async () => "user-1",
      consumeRateLimit: async userId => {
        assert(userId === "user-1", "limiter subject must be the authenticated user");
        return { allowed: false, reason: "limit_exceeded", retryAfterSeconds: 17, limit: 60, windowSeconds: 300 };
      },
      fetchWithSafeRedirects: async () => { networkCalls++; throw new Error("network must not run"); },
    });
    assert(response.status === 429, "expected rate-limited response");
    assert(response.headers.get("retry-after") === "17", "missing bounded Retry-After");
    assert(networkCalls === 0, "outbound request ran after rate-limit refusal");
  });

  console.log(`\nProduct URL import tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
