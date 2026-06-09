import {
  extractCandidatesFromHtml,
  extractProductImagesFromUrl,
  finalizeCandidates,
  importProductUrls,
  importUrl,
  validateImportUrl,
} from "../src/lib/productUrlImport";
import { parseProductImportUrls, autoSelectTopCandidates } from "../src/lib/productUrlImportClient";
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
  console.log("\n── Original tests ────────────────────────────────────────────────────────");
  await runOriginalTests();

  console.log("\n── Provider adapter tests ───────────────────────────────────────────────");
  await runProviderTests();

  console.log(`\nProduct URL import tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
