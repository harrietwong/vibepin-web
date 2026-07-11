import {
  classifyDestination,
  classifySourcePin,
  isProductPickerAsset,
  isReferencePickerAsset,
  shouldShowInPinIdeas,
  shouldShowInProductIdeas,
} from "../src/lib/assetClassification";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${error instanceof Error ? error.message : String(error)}`);
    failed++;
  }
}

function eq(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function ok(value: unknown, message: string): void {
  if (!value) throw new Error(message);
}

console.log("\nAsset classification tests");

test("1. Shopify/Etsy/WooCommerce/product schema page => product_image", () => {
  const c = classifyDestination({
    title: "Minimalist Wave Ring",
    domain: "etsy.com",
    sourceUrl: "https://etsy.com/listing/123",
    hasProductSchema: true,
    price: 24,
  });
  eq(c.item_type, "product");
  eq(c.destination_type, "product_page");
  eq(c.asset_role, "product_image");
});

test("2. Paid downloadable product page => digital product image", () => {
  const c = classifyDestination({
    title: "Weekly Planner Printable PDF",
    sourceUrl: "https://shop.example.com/products/weekly-planner",
    description: "Instant download files. Add to cart.",
    price: 12,
    hasDownloadSignals: true,
  });
  eq(c.item_type, "product");
  eq(c.product_type, "digital_product");
  eq(c.destination_type, "digital_download_product_page");
  eq(c.asset_role, "product_image");
});

test("3. Minecraft/game map paid download => game/map asset + IP-sensitive flag", () => {
  const c = classifyDestination({
    title: "CITY OF ORARIO 2.0 - Danmachi Anime Minecraft City Map",
    description: "$99 Add to cart downloadable map files",
    sourceUrl: "https://example.com/products/orario-city-map",
    price: 99,
    hasDownloadSignals: true,
  });
  eq(c.item_type, "product");
  ok(c.product_subtype === "map_asset" || c.product_subtype === "game_asset", "expected game/map subtype");
  ok(c.risk_flags.includes("ip_sensitive"), "expected ip_sensitive risk flag");
});

test("4. Blog article destination => pin/content idea reference", () => {
  const c = classifyDestination({
    title: "10 Small Balcony Ideas That Feel Like A Retreat",
    sourceUrl: "https://blog.example.com/small-balcony-ideas",
  });
  ok(c.item_type === "pin_idea" || c.item_type === "content_opportunity", "expected pin/content idea");
  eq(c.asset_role, "pin_reference");
});

test("5. Video/game guide destination => pin/content idea reference", () => {
  const c = classifyDestination({
    title: "Hidden Apps Guide",
    sourceUrl: "https://youtube.com/watch?v=abc",
    description: "Video tutorial and guide",
  });
  ok(c.item_type === "pin_idea" || c.item_type === "content_opportunity", "expected pin/content idea");
  eq(c.asset_role, "pin_reference");
});

test("6. Pinterest Pin with product destination keeps source pin as reference; destination extracts product", () => {
  const sourcePin = classifySourcePin({
    title: "Minimalist Wave Ring Pin",
    destinationUrl: "https://etsy.com/listing/123",
    isPinterestPin: true,
    price: 24,
  });
  const extractedProduct = classifyDestination({
    title: "Minimalist Wave Ring",
    destinationUrl: "https://etsy.com/listing/123",
    price: 24,
    hasProductSchema: true,
  });
  eq(sourcePin.asset_role, "pin_reference");
  eq(sourcePin.item_type, "pin_idea");
  eq(extractedProduct.asset_role, "product_image");
  eq(extractedProduct.item_type, "product");
});

test("7. Pinterest Pin with article/video destination is not product", () => {
  const c = classifySourcePin({
    title: "24 Hours in Provence",
    destinationUrl: "https://blog.example.com/24-hours-in-provence",
    isPinterestPin: true,
  });
  eq(c.asset_role, "pin_reference");
  ok(c.item_type === "pin_idea" || c.item_type === "content_opportunity", "expected pin/content idea");
  ok(c.item_type !== "product", "must not be product");
});

test("8. Product Ideas page filter excludes article/video/blog/tutorial-only items", () => {
  const article = classifyDestination({
    title: "Skincare Routine Steps",
    sourceUrl: "https://blog.example.com/skincare-routine-steps",
  });
  eq(shouldShowInProductIdeas(article), false);
});

test("9. Pin Ideas page filter includes article/video/tutorial/game content items", () => {
  const video = classifyDestination({
    title: "Game guide: build a fantasy city map",
    sourceUrl: "https://youtube.com/watch?v=map-guide",
  });
  eq(shouldShowInPinIdeas(video), true);
});

test("10. Product picker only shows product_image assets", () => {
  eq(isProductPickerAsset({ role: "product", assetRole: "product_image" }), true);
  eq(isProductPickerAsset({ role: "style_reference", assetRole: "pin_reference" }), false);
});

test("11. Reference picker only shows pin_reference assets", () => {
  eq(isReferencePickerAsset({ role: "style_reference", assetRole: "pin_reference" }), true);
  eq(isReferencePickerAsset({ role: "product", assetRole: "product_image" }), false);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
