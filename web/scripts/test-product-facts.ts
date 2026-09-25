/**
 * FR-01 / FR-02: ProductFacts contract + structured extraction for Shopify JSON,
 * JSON-LD, WooCommerce, and og meta. Pure-function tests plus a couple of
 * end-to-end `importUrl` wiring checks (images filled from finalized candidates,
 * facts preserved across the "adapter had no images → fall back to generic"
 * branch, and the Amazon channel never carrying facts).
 *
 * Run: npx tsx scripts/test-product-facts.ts
 */
import {
  cleanDescription,
  factsFromJsonLd,
  factsFromOgMeta,
  factsFromShopifyProductJson,
  factsFromWooCommerce,
  importUrl,
  mergeFacts,
} from "../src/lib/productUrlImport";
import type { ProductFacts } from "../src/lib/productUrlImport";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
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

const FIXED_NOW = "2026-09-25T00:00:00.000Z";

/** Recursively fails if any string field/leaf in the object is an empty string. */
function assertNoEmptyStrings(value: unknown, path = "root"): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    assert(value.length > 0, `empty string found at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoEmptyStrings(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertNoEmptyStrings(v, `${path}.${k}`);
    }
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SHOPIFY_PRODUCT_JSON = {
  title:     "Boho Vase",
  body_html: "<p>Hand-thrown <strong>ceramic</strong> vase.</p>",
  vendor:    "Terra & Co",
  variants: [
    { price: "48.00", compare_at_price: "60.00", available: true },
  ],
};

const SHOPIFY_PAGE_HTML_WITH_CURRENCY = `<!DOCTYPE html><html><head>
<meta property="og:price:currency" content="USD" />
</head><body></body></html>`;

const SHOPIFY_PAGE_HTML_NO_CURRENCY = `<!DOCTYPE html><html><head></head><body></body></html>`;

// Real-store shape reported by the coordinator: compare_at_price == "0.00" means "no compareAt".
const SHOPIFY_PRODUCT_JSON_ZERO_COMPARE = {
  title:    "Lip Gloss",
  vendor:   "ColourPop",
  variants: [
    { price: "12.00", compare_at_price: "0.00", available: true },
  ],
};

// compare_at_price equal to price — also "no compareAt".
const SHOPIFY_PRODUCT_JSON_EQUAL_COMPARE = {
  title:    "Eyeliner",
  vendor:   "ColourPop",
  variants: [
    { price: "10.00", compare_at_price: "10.00", available: true },
  ],
};

// compare_at_price null — also "no compareAt".
const SHOPIFY_PRODUCT_JSON_NULL_COMPARE = {
  title:    "Blush",
  vendor:   "ColourPop",
  variants: [
    { price: "14.00", compare_at_price: null, available: false },
  ],
};

const JSONLD_SINGLE_OFFER_HTML = `<!DOCTYPE html><html><head>
<script type="application/ld+json">
{"@type":"Product","name":"Wool Throw","description":"<p>Soft &amp; warm 100% wool throw blanket for the living room.</p>",
"brand":{"name":"Nordic Home"},
"offers":{"@type":"Offer","price":"89.00","priceCurrency":"EUR","availability":"https://schema.org/InStock"}}
</script>
</head><body></body></html>`;

const JSONLD_GRAPH_MULTI_OFFER_HTML = `<!DOCTYPE html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
  {"@type":"WebPage","name":"Store page"},
  {"@type":"Product","name":"Canvas Tote","brand":"Fieldstone",
   "offers":[
     {"@type":"Offer","price":"22.00","priceCurrency":"USD","availability":"https://schema.org/OutOfStock"},
     {"@type":"Offer","price":"24.00","priceCurrency":"USD","availability":"https://schema.org/InStock"}
   ]}
]}
</script>
</head><body></body></html>`;

const WOOCOMMERCE_NO_JSONLD_HTML = `<!DOCTYPE html><html><head>
<meta property="og:title" content="Ceramic Vase" />
</head><body>
<p class="price"><span class="amount">$34.50</span></p>
</body></html>`;

const WOOCOMMERCE_WITH_JSONLD_HTML = `<!DOCTYPE html><html><head>
<script type="application/ld+json">
{"@type":"Product","name":"Oak Shelf","brand":"Millhouse",
"offers":{"price":"120","priceCurrency":"GBP","availability":"InStock"}}
</script>
</head><body>
<p class="price"><span class="amount">$999.00</span></p>
</body></html>`;

const PURE_OG_HTML = `<!DOCTYPE html><html><head>
<meta property="og:title" content="Linen Napkins" />
<meta property="og:description" content="Set of four linen napkins, naturally dyed." />
</head><body></body></html>`;

const PURE_OG_NO_PRICE_HTML = `<!DOCTYPE html><html><head>
<meta property="og:title" content="Clay Mug" />
</head><body></body></html>`;

const OG_PRICE_NO_CURRENCY_HTML = `<!DOCTYPE html><html><head>
<meta property="og:title" content="Wax Candle" />
<meta property="product:price:amount" content="18.00" />
</head><body></body></html>`;

const LONG_DESCRIPTION_HTML_BODY = "<p>" + "Hand-poured soy candle. ".repeat(60) + "</p>";

async function run() {
  // ── FR-02: Shopify JSON ─────────────────────────────────────────────────
  await test("Shopify JSON: title/description/brand/price/compareAt/availability, currency from html", () => {
    const facts = factsFromShopifyProductJson(
      SHOPIFY_PRODUCT_JSON, "https://shop.example.com/products/vase", SHOPIFY_PAGE_HTML_WITH_CURRENCY, FIXED_NOW,
    ) as ProductFacts;
    assert(facts !== undefined, "expected facts");
    assert(facts.source === "shopify_json", "expected source shopify_json");
    assert(facts.title === "Boho Vase", "expected title");
    assert(facts.description === "Hand-thrown ceramic vase.", `unexpected description: ${facts.description}`);
    assert(facts.brand === "Terra & Co", "expected brand from vendor");
    assert(facts.price?.amount === "48.00", "expected price amount");
    assert(facts.price?.currency === "USD", "expected currency from html meta");
    assert(facts.price?.compareAt === "60.00", "expected compareAt");
    assert(facts.availability === "in_stock", "expected in_stock");
    assert(facts.completeness === "full", "expected full completeness (has price + brand)");
    assertNoEmptyStrings(facts);
  });

  await test("Shopify JSON: missing currency in html => currency unknown, completeness still governed by price/brand", () => {
    const facts = factsFromShopifyProductJson(
      SHOPIFY_PRODUCT_JSON, "https://shop.example.com/products/vase", SHOPIFY_PAGE_HTML_NO_CURRENCY, FIXED_NOW,
    ) as ProductFacts;
    assert(facts.price?.currency === "unknown", `expected unknown currency, got ${facts.price?.currency}`);
    assert(facts.completeness === "full", "currency=unknown must not by itself demote completeness");
  });

  await test("Shopify JSON: compare_at_price '0.00' is treated as no compareAt", () => {
    const facts = factsFromShopifyProductJson(
      SHOPIFY_PRODUCT_JSON_ZERO_COMPARE, "https://shop.example.com/products/gloss", undefined, FIXED_NOW,
    ) as ProductFacts;
    assert(facts.price?.amount === "12.00", "expected price");
    assert(facts.price?.compareAt === undefined, `expected no compareAt, got ${facts.price?.compareAt}`);
  });

  await test("Shopify JSON: compare_at_price equal to price is treated as no compareAt", () => {
    const facts = factsFromShopifyProductJson(
      SHOPIFY_PRODUCT_JSON_EQUAL_COMPARE, "https://shop.example.com/products/eyeliner", undefined, FIXED_NOW,
    ) as ProductFacts;
    assert(facts.price?.compareAt === undefined, `expected no compareAt, got ${facts.price?.compareAt}`);
  });

  await test("Shopify JSON: compare_at_price null is treated as no compareAt; available=false => out_of_stock", () => {
    const facts = factsFromShopifyProductJson(
      SHOPIFY_PRODUCT_JSON_NULL_COMPARE, "https://shop.example.com/products/blush", undefined, FIXED_NOW,
    ) as ProductFacts;
    assert(facts.price?.compareAt === undefined, `expected no compareAt, got ${facts.price?.compareAt}`);
    assert(facts.availability === "out_of_stock", "expected out_of_stock");
  });

  await test("Shopify JSON: no variants/price => no price field, completeness partial, no empty strings", () => {
    const facts = factsFromShopifyProductJson(
      { title: "Bare Product", vendor: "Acme" }, "https://shop.example.com/products/bare", undefined, FIXED_NOW,
    ) as ProductFacts;
    assert(facts.price === undefined, "expected no price");
    assert(facts.completeness === "partial", "missing price => partial");
    assertNoEmptyStrings(facts);
  });

  await test("Shopify JSON: null product => undefined facts", () => {
    const facts = factsFromShopifyProductJson(null, "https://shop.example.com/products/x", undefined, FIXED_NOW);
    assert(facts === undefined, "expected undefined for null product");
  });

  await test("Shopify JSON: empty-string vendor/body_html are omitted, not passed through as empty", () => {
    const facts = factsFromShopifyProductJson(
      { title: "Widget", vendor: "", body_html: "" }, "https://shop.example.com/products/widget", undefined, FIXED_NOW,
    ) as ProductFacts;
    assert(facts !== undefined, "title alone should still produce facts");
    assert(facts.brand === undefined, "empty vendor must not become empty-string brand");
    assert(facts.description === undefined, "empty body_html must not become empty-string description");
    assertNoEmptyStrings(facts);
  });

  // ── FR-02: JSON-LD ──────────────────────────────────────────────────────
  await test("JSON-LD single Product/Offer: brand.name, price, currency, availability, description stripped", () => {
    const facts = factsFromJsonLd(JSONLD_SINGLE_OFFER_HTML, "https://store.example.com/p/throw", FIXED_NOW) as ProductFacts;
    assert(facts !== undefined, "expected facts");
    assert(facts.source === "jsonld", "expected source jsonld");
    assert(facts.title === "Wool Throw", "expected title");
    assert(facts.brand === "Nordic Home", "expected brand.name");
    assert(facts.price?.amount === "89.00", "expected price");
    assert(facts.price?.currency === "EUR", "expected currency");
    assert(facts.availability === "in_stock", "expected in_stock");
    assert(facts.description === "Soft & warm 100% wool throw blanket for the living room.", `unexpected description: ${facts.description}`);
    assert(facts.completeness === "full", "expected full");
    assertNoEmptyStrings(facts);
  });

  await test("JSON-LD @graph + multi-offer array: picks first InStock offer, brand as plain string", () => {
    const facts = factsFromJsonLd(JSONLD_GRAPH_MULTI_OFFER_HTML, "https://store.example.com/p/tote", FIXED_NOW) as ProductFacts;
    assert(facts !== undefined, "expected facts");
    assert(facts.title === "Canvas Tote", "expected title from @graph Product");
    assert(facts.brand === "Fieldstone", "expected brand string");
    assert(facts.price?.amount === "24.00", `expected the InStock offer's price, got ${facts.price?.amount}`);
    assert(facts.availability === "in_stock", "expected in_stock (the chosen offer)");
  });

  await test("JSON-LD: no Product node => undefined", () => {
    const html = `<script type="application/ld+json">{"@type":"WebPage","name":"Home"}</script>`;
    const facts = factsFromJsonLd(html, "https://store.example.com/", FIXED_NOW);
    assert(facts === undefined, "expected undefined when no Product node present");
  });

  await test("JSON-LD: malformed JSON does not throw, returns undefined", () => {
    const html = `<script type="application/ld+json">{not valid json</script>`;
    const facts = factsFromJsonLd(html, "https://store.example.com/", FIXED_NOW);
    assert(facts === undefined, "expected undefined for malformed JSON-LD");
  });

  // ── FR-02: WooCommerce ──────────────────────────────────────────────────
  await test("WooCommerce: no JSON-LD => .price .amount text fallback, currency unknown, partial", () => {
    const facts = factsFromWooCommerce(WOOCOMMERCE_NO_JSONLD_HTML, "https://shop.example.com/product/vase/", FIXED_NOW) as ProductFacts;
    assert(facts !== undefined, "expected facts");
    assert(facts.source === "woocommerce", "expected source woocommerce");
    assert(facts.price?.amount === "34.50", `expected numeric amount, got ${facts.price?.amount}`);
    assert(facts.price?.currency === "unknown", "$ symbol is not an ISO code => unknown");
    assert(facts.completeness === "partial", "text fallback is always partial");
    assertNoEmptyStrings(facts);
  });

  await test("WooCommerce: page has JSON-LD => JSON-LD wins, source reads jsonld (not woocommerce)", () => {
    const facts = factsFromWooCommerce(WOOCOMMERCE_WITH_JSONLD_HTML, "https://shop.example.com/product/shelf/", FIXED_NOW) as ProductFacts;
    assert(facts !== undefined, "expected facts");
    assert(facts.source === "jsonld", `expected jsonld to win, got ${facts.source}`);
    assert(facts.price?.amount === "120", `expected JSON-LD price 120, not the $999 dom fallback, got ${facts.price?.amount}`);
    assert(facts.price?.currency === "GBP", "expected JSON-LD currency GBP");
  });

  // ── FR-02: og meta ──────────────────────────────────────────────────────
  await test("Pure og meta: title/description only, no price => partial, no invented brand/price", () => {
    const facts = factsFromOgMeta(PURE_OG_HTML, "https://blog.example.com/product-page", FIXED_NOW) as ProductFacts;
    assert(facts !== undefined, "expected facts");
    assert(facts.source === "og_meta", "expected source og_meta");
    assert(facts.title === "Linen Napkins", "expected title");
    assert(facts.description === "Set of four linen napkins, naturally dyed.", "expected description");
    assert(facts.brand === undefined, "must not invent a brand");
    assert(facts.price === undefined, "must not invent a price");
    assert(facts.completeness === "partial", "missing price/brand => partial");
    assertNoEmptyStrings(facts);
  });

  await test("og meta: no price meta at all => no price field (not a guessed one)", () => {
    const facts = factsFromOgMeta(PURE_OG_NO_PRICE_HTML, "https://blog.example.com/mug", FIXED_NOW) as ProductFacts;
    assert(facts !== undefined, "expected facts (title present)");
    assert(facts.price === undefined, "expected no price field");
  });

  await test("og meta: product:price:amount present, currency absent => currency unknown, not omitted", () => {
    const facts = factsFromOgMeta(OG_PRICE_NO_CURRENCY_HTML, "https://blog.example.com/candle", FIXED_NOW) as ProductFacts;
    assert(facts.price?.amount === "18.00", "expected amount");
    assert(facts.price?.currency === "unknown", `expected unknown currency, got ${facts.price?.currency}`);
  });

  await test("og meta: neither title/description/price present => undefined (no empty shell)", () => {
    const facts = factsFromOgMeta(`<html><head></head><body></body></html>`, "https://blog.example.com/empty", FIXED_NOW);
    assert(facts === undefined, "expected undefined for a page with no usable meta");
  });

  // ── Description cleaning ────────────────────────────────────────────────
  await test("cleanDescription strips tags, collapses whitespace, decodes entities", () => {
    // decodeHtmlText (shared with the Amazon channel) turns every tag into a space
    // before collapsing runs of whitespace, so a tag immediately followed by
    // punctuation leaves a space before it — accepted shared behavior, not a bug
    // introduced here.
    const cleaned = cleanDescription("<p>Hand &amp; \n\n   made   <b>goods</b></p>");
    assert(cleaned === "Hand & made goods", `unexpected cleaned description: ${cleaned}`);
  });

  await test("cleanDescription truncates to 1000 chars", () => {
    const cleaned = cleanDescription(LONG_DESCRIPTION_HTML_BODY);
    assert(cleaned !== undefined, "expected a description");
    assert(cleaned!.length <= 1000, `expected <=1000 chars, got ${cleaned!.length}`);
  });

  await test("cleanDescription returns undefined for empty/whitespace-only input", () => {
    assert(cleanDescription("") === undefined, "expected undefined for empty string");
    assert(cleanDescription("   ") === undefined, "expected undefined for whitespace");
    assert(cleanDescription(undefined) === undefined, "expected undefined for undefined input");
    assert(cleanDescription("<p></p>") === undefined, "expected undefined for tags-only input");
  });

  // ── mergeFacts ──────────────────────────────────────────────────────────
  await test("mergeFacts: priority shopify_json > jsonld > woocommerce > og_meta, field by field", () => {
    const shopify = factsFromShopifyProductJson(
      { title: "Shopify Title", vendor: "Shopify Brand" }, "https://x.com/p", undefined, FIXED_NOW,
    );
    const jsonld: ProductFacts = {
      title: "JSONLD Title", price: { amount: "10.00", currency: "USD" },
      sourceUrl: "https://x.com/p", fetchedAt: FIXED_NOW, source: "jsonld", completeness: "partial",
    };
    const merged = mergeFacts([shopify, jsonld]) as ProductFacts;
    assert(merged.title === "Shopify Title", "higher-priority title should win");
    assert(merged.price?.amount === "10.00", "price only present on jsonld should still be merged in");
    assert(merged.brand === "Shopify Brand", "brand only on shopify should be merged in");
  });

  await test("mergeFacts: empty array / all-undefined => undefined", () => {
    assert(mergeFacts([]) === undefined, "expected undefined for empty array");
    assert(mergeFacts([undefined, undefined]) === undefined, "expected undefined for all-undefined");
  });

  await test("mergeFacts: no empty-string leaks through a merge of partials", () => {
    const a: ProductFacts = {
      brand: "Real Brand", sourceUrl: "https://x.com", fetchedAt: FIXED_NOW, source: "shopify_json", completeness: "partial",
    };
    const b: ProductFacts = {
      title: "Real Title", sourceUrl: "https://x.com", fetchedAt: FIXED_NOW, source: "og_meta", completeness: "partial",
    };
    const merged = mergeFacts([a, b]) as ProductFacts;
    assertNoEmptyStrings(merged);
  });

  // ── End-to-end importUrl wiring ─────────────────────────────────────────
  await test("importUrl: Shopify JSON path fills facts.images from finalized candidates", async () => {
    const jsonBody = JSON.stringify({
      product: {
        title: "Boho Vase",
        vendor: "Terra & Co",
        variants: [{ price: "48.00", compare_at_price: "60.00", available: true }],
        images: [
          { src: "https://cdn.shopify.com/products/vase-1.jpg", width: 1200, height: 1200 },
          { src: "https://cdn.shopify.com/products/vase-2.jpg", width: 1200, height: 1200 },
        ],
      },
    });
    const pageHtml = `<html><head><meta property="og:price:currency" content="USD" /></head><body></body></html>`;
    const fetchPage = async (url: string) => (url.endsWith(".json") ? { html: jsonBody, finalUrl: url } : { html: pageHtml, finalUrl: url });

    const result = await importUrl("https://myshop.myshopify.com/products/boho-vase", fetchPage);
    assert(result.status === "success", "expected success");
    assert(result.facts !== undefined, "expected facts on the result");
    assert(result.facts!.source === "shopify_json", "expected shopify_json source");
    assert(result.facts!.price?.amount === "48.00", "expected price on wired result");
    assert(result.facts!.price?.currency === "USD", "expected currency on wired result");
    const candidateUrls = (result.candidates ?? []).map(c => c.imageUrl);
    assert(candidateUrls.length > 0, "expected candidates");
    assert(
      JSON.stringify(result.facts!.images) === JSON.stringify(candidateUrls),
      `expected facts.images to equal candidate image urls: ${JSON.stringify(result.facts!.images)} vs ${JSON.stringify(candidateUrls)}`,
    );
  });

  await test("importUrl: Shopify JSON has no images but og:image gives candidates via fallback => facts merged, not lost", async () => {
    const jsonBody = JSON.stringify({
      product: {
        title: "No-Image Product",
        vendor: "Terra & Co",
        variants: [{ price: "22.00", available: true }],
        images: [],
      },
    });
    const pageHtml = `<!DOCTYPE html><html><head>
      <meta property="og:image" content="https://cdn.example.com/fallback.jpg" />
      <meta property="og:title" content="No-Image Product" />
    </head><body></body></html>`;
    const fetchPage = async (url: string) => (url.endsWith(".json") ? { html: jsonBody, finalUrl: url } : { html: pageHtml, finalUrl: url });

    const result = await importUrl("https://myshop.myshopify.com/products/no-image", fetchPage);
    assert(result.status === "success", "expected success via generic fallback candidates");
    assert(result.facts !== undefined, "expected facts to survive the fallback branch");
    assert(result.facts!.brand === "Terra & Co", "expected shopify_json brand to survive the merge, proving merge not overwrite");
    assert(result.facts!.price?.amount === "22.00", "expected shopify_json price to survive the merge");
    const candidateUrls = (result.candidates ?? []).map(c => c.imageUrl);
    assert(candidateUrls.length > 0, "expected fallback candidates from og:image");
    assert(
      JSON.stringify(result.facts!.images) === JSON.stringify(candidateUrls),
      "expected facts.images to equal the fallback candidate list",
    );
  });

  await test("importUrl: failed status (no candidates at all) does not attach facts", async () => {
    const fetchPage = async (url: string) => ({ html: `<html><head></head><body></body></html>`, finalUrl: url });
    const result = await importUrl("https://shop.example.com/products/nothing-here", fetchPage);
    assert(result.status === "failed", `expected failed, got ${result.status}`);
    assert(result.facts === undefined, "expected no facts on a failed result");
  });

  await test("importUrl: Amazon channel never carries facts", async () => {
    const html200 = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    const macbookLike = `<!DOCTYPE html><html><head><title>Amazon.com: Widget</title></head><body>
      <span id="productTitle">Great Widget</span>
      <div id="feature-bullets"><ul><li><span class="a-list-item">Bullet one</span></li></ul></div>
    </body></html>`;
    const amazonFetch = async () => html200(macbookLike);
    const noGenericFetch = async (): Promise<{ html: string; finalUrl: string }> => {
      throw new Error("generic fetch must not run for an Amazon URL");
    };
    const result = await importUrl("https://www.amazon.com/dp/B0BSHF7WHW", noGenericFetch, { amazonFetch });
    assert(result.provider === "amazon", "expected amazon provider");
    assert(result.facts === undefined, "Amazon channel must never carry facts");
  });

  console.log(`\nProduct facts tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
