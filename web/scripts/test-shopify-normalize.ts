/**
 * Shopify normalize.ts unit tests (WP3).
 * Run: npx tsx scripts/test-shopify-normalize.ts
 *
 * Pure functions — no mocks. Covers GID parsing, HTML→text (entities / nested
 * tags / truncation), the product_url three-level fallback, the status +
 * availability derivation matrix, price/currency selection, image/variant child
 * rows (association + featuredImage fallback), and raw_source preservation.
 */

export {};

import {
  gidToId,
  htmlToText,
  normalizeProduct,
  type ShopifyProductNode,
} from "../src/lib/server/shopify/normalize";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
function assertEq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}

const CTX = { shopDomain: "demo-store.myshopify.com", primaryDomain: "shop.demo.com", shopCurrency: "USD" };

function node(overrides: Partial<ShopifyProductNode> = {}): ShopifyProductNode {
  return {
    id: "gid://shopify/Product/1234567890",
    handle: "cool-thing",
    title: "Cool Thing",
    descriptionHtml: "<p>Hello</p>",
    status: "ACTIVE",
    vendor: "Acme",
    productType: "Widget",
    tags: ["a", "b"],
    onlineStoreUrl: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
    priceRangeV2: {
      minVariantPrice: { amount: "19.99", currencyCode: "EUR" },
      maxVariantPrice: { amount: "29.99", currencyCode: "EUR" },
    },
    featuredImage: { id: "gid://shopify/ProductImage/9001", url: "https://cdn/img1.jpg", width: 800, height: 600, altText: "front" },
    images: {
      edges: [
        { node: { id: "gid://shopify/ProductImage/9001", url: "https://cdn/img1.jpg", width: 800, height: 600, altText: "front" } },
        { node: { id: "gid://shopify/ProductImage/9002", url: "https://cdn/img2.jpg", width: 400, height: 300, altText: "back" } },
      ],
    },
    variants: {
      edges: [
        { node: { id: "gid://shopify/ProductVariant/5001", title: "S", price: "19.99", sku: "SKU-S", availableForSale: true, compareAtPrice: "24.99", image: { id: "gid://shopify/ProductImage/9002" } } },
        { node: { id: "gid://shopify/ProductVariant/5002", title: "M", price: "21.99", sku: "SKU-M", availableForSale: false, compareAtPrice: null, image: null } },
      ],
    },
    ...overrides,
  };
}

async function main() {
  console.log("\nShopify normalize tests\n");

  // ── gidToId ─────────────────────────────────────────────────────────────────
  await test("gidToId takes the numeric tail and drops query strings", () => {
    assertEq(gidToId("gid://shopify/Product/1234567890"), "1234567890", "product gid");
    assertEq(gidToId("gid://shopify/ProductImage/9001?foo=1"), "9001", "image gid with query");
    assertEq(gidToId("gid://shopify/ProductVariant/42"), "42", "variant gid");
    assertEq(gidToId(null), "", "null → empty");
    assertEq(gidToId(undefined), "", "undefined → empty");
  });

  // ── htmlToText ──────────────────────────────────────────────────────────────
  await test("htmlToText decodes entities, strips nested tags, collapses whitespace", () => {
    assertEq(
      htmlToText("<div><p>Tom &amp; Jerry</p>  <b>Bold&#39;s</b>\n&nbsp;end &#x263A;</div>"),
      "Tom & Jerry Bold's end ☺",
      "entities + nesting + whitespace",
    );
  });
  await test("htmlToText drops <script>/<style> bodies", () => {
    assertEq(htmlToText("<style>.x{color:red}</style>Buy<script>alert(1)</script> now"), "Buy now", "script/style removed");
  });
  await test("htmlToText truncates to 5000 chars and returns null for empty", () => {
    const long = `<p>${"x".repeat(6000)}</p>`;
    assertEq(htmlToText(long)!.length, 5000, "capped at 5000");
    assertEq(htmlToText(""), null, "empty string → null");
    assertEq(htmlToText("<p></p>   "), null, "tags-only → null");
    assertEq(htmlToText(null), null, "null → null");
  });

  // ── product_url three-level fallback ────────────────────────────────────────
  await test("product_url prefers onlineStoreUrl", () => {
    const p = normalizeProduct(node({ onlineStoreUrl: "https://shop.demo.com/products/cool-thing?v=1" }), CTX);
    assertEq(p.productUrl, "https://shop.demo.com/products/cool-thing?v=1", "onlineStoreUrl wins");
  });
  await test("product_url falls back to primaryDomain, then shopDomain", () => {
    const withPrimary = normalizeProduct(node({ onlineStoreUrl: null }), CTX);
    assertEq(withPrimary.productUrl, "https://shop.demo.com/products/cool-thing", "primaryDomain fallback");
    const noPrimary = normalizeProduct(node({ onlineStoreUrl: null }), { shopDomain: "demo-store.myshopify.com" });
    assertEq(noPrimary.productUrl, "https://demo-store.myshopify.com/products/cool-thing", "shopDomain fallback");
  });
  await test("product_url is null when there is no url and no handle", () => {
    const p = normalizeProduct(node({ onlineStoreUrl: null, handle: null }), CTX);
    assertEq(p.productUrl, null, "no handle → null");
  });

  // ── status mapping ──────────────────────────────────────────────────────────
  await test("status maps ACTIVE/DRAFT/ARCHIVED and defaults safely", () => {
    assertEq(normalizeProduct(node({ status: "ACTIVE" }), CTX).status, "active", "active");
    assertEq(normalizeProduct(node({ status: "DRAFT" }), CTX).status, "draft", "draft");
    assertEq(normalizeProduct(node({ status: "ARCHIVED" }), CTX).status, "archived", "archived");
    assertEq(normalizeProduct(node({ status: "weird" }), CTX).status, "active", "unknown → active default");
  });

  // ── availability matrix ─────────────────────────────────────────────────────
  await test("availability: active + a sellable variant → in_stock", () => {
    assertEq(normalizeProduct(node({ status: "ACTIVE" }), CTX).availability, "in_stock", "in_stock");
  });
  await test("availability: active + no sellable variant → out_of_stock", () => {
    const allOut = node({
      status: "ACTIVE",
      variants: { edges: [{ node: { id: "gid://shopify/ProductVariant/1", availableForSale: false } }] },
    });
    assertEq(normalizeProduct(allOut, CTX).availability, "out_of_stock", "none sellable");
  });
  await test("availability: active + no variants at all → out_of_stock", () => {
    assertEq(normalizeProduct(node({ status: "ACTIVE", variants: { edges: [] } }), CTX).availability, "out_of_stock", "no variants");
  });
  await test("availability: draft / archived → unknown", () => {
    assertEq(normalizeProduct(node({ status: "DRAFT" }), CTX).availability, "unknown", "draft unknown");
    assertEq(normalizeProduct(node({ status: "ARCHIVED" }), CTX).availability, "unknown", "archived unknown");
  });

  // ── price / currency / compareAt ────────────────────────────────────────────
  await test("price/compareAt come from the first variant, currency from priceRangeV2", () => {
    const p = normalizeProduct(node(), CTX);
    assertEq(p.priceAmount, 19.99, "first variant price");
    assertEq(p.compareAtPrice, 24.99, "first variant compareAt");
    assertEq(p.currency, "EUR", "priceRangeV2 currency");
  });
  await test("price falls back to priceRangeV2 minimum, currency to shopCurrency", () => {
    const p = normalizeProduct(
      node({
        variants: { edges: [] },
        priceRangeV2: { minVariantPrice: { amount: "5.00", currencyCode: null }, maxVariantPrice: { amount: "9.00" } },
      }),
      CTX,
    );
    assertEq(p.priceAmount, 5, "priceRangeV2 min fallback");
    assertEq(p.compareAtPrice, null, "no variant compareAt → null");
    assertEq(p.currency, "USD", "shopCurrency fallback");
  });

  // ── image + variant child rows ──────────────────────────────────────────────
  await test("image rows keep order, associate variants, and set image_count / primaryImageUrl", () => {
    const p = normalizeProduct(node(), CTX);
    assertEq(p.images!.length, 2, "two image rows");
    assertEq(p.images![0].externalImageId, "9001", "first image id");
    assertEq(p.images![0].position, 0, "position 0");
    assertEq(p.images![1].externalImageId, "9002", "second image id");
    assert(p.images![1].variantExternalIds!.includes("5001"), "variant 5001 associated with image 9002");
    assertEq(p.images![0].variantExternalIds!.length, 0, "image 9001 has no variant association");
    assertEq(p.primaryImageUrl, "https://cdn/img1.jpg", "featuredImage is primary");
  });
  await test("images fall back to featuredImage when the images connection is empty", () => {
    const p = normalizeProduct(node({ images: { edges: [] } }), CTX);
    assertEq(p.images!.length, 1, "featuredImage becomes the sole image row");
    assertEq(p.images![0].externalImageId, "9001", "featuredImage id");
    assertEq(p.primaryImageUrl, "https://cdn/img1.jpg", "primary is featuredImage");
  });
  await test("images without a url are skipped (source_image_url is NOT NULL)", () => {
    const p = normalizeProduct(
      node({
        featuredImage: null,
        images: { edges: [{ node: { id: "gid://shopify/ProductImage/1", url: null } }, { node: { id: "gid://shopify/ProductImage/2", url: "https://cdn/ok.jpg" } }] },
      }),
      CTX,
    );
    assertEq(p.images!.length, 1, "urless image dropped");
    assertEq(p.primaryImageUrl, "https://cdn/ok.jpg", "primary is first valid image when no featuredImage");
  });
  await test("variant rows carry price, sku, availability and image association", () => {
    const p = normalizeProduct(node(), CTX);
    assertEq(p.variants!.length, 2, "two variants");
    assertEq(p.variants![0].externalVariantId, "5001", "variant id");
    assertEq(p.variants![0].priceAmount, 19.99, "variant price");
    assertEq(p.variants![0].sku, "SKU-S", "sku");
    assertEq(p.variants![0].availableForSale, true, "availableForSale");
    assertEq(p.variants![0].externalImageId, "9002", "variant image association");
    assertEq(p.variants![1].externalImageId, null, "variant without image → null");
  });

  // ── ids, tags, timestamps, raw_source ───────────────────────────────────────
  await test("scalar fields + raw_source are preserved verbatim", () => {
    const n = node();
    const p = normalizeProduct(n, CTX);
    assertEq(p.externalProductId, "1234567890", "external id from gid");
    assertEq(p.title, "Cool Thing", "title");
    assertEq(p.vendor, "Acme", "vendor");
    assertEq(p.productType, "Widget", "productType");
    assertEq(JSON.stringify(p.tags), JSON.stringify(["a", "b"]), "tags");
    assertEq(p.createdAtSource, "2026-01-01T00:00:00Z", "createdAt source");
    assertEq(p.updatedAtSource, "2026-02-01T00:00:00Z", "updatedAt source");
    assertEq(p.descriptionText, "Hello", "description text");
    assert(p.rawSource === n, "raw_source is the exact node reference");
  });
  await test("empty/missing title normalizes to an empty string (NOT NULL column)", () => {
    assertEq(normalizeProduct(node({ title: null }), CTX).title, "", "null title → ''");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
