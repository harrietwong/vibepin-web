import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const outDir = "artifacts/product-picker-ui-hierarchy";
mkdirSync(outDir, { recursive: true });
const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==", "base64");
const rows = [
  { id: "amz-home-1", product_name: "Amazon Woven Storage Basket", image_url: "https://placehold.co/300x300/FF9900/white?text=Amazon+Home+1", seed_keyword: "home decor", category: "home-decor", save_count: 100, source_pin_save_count: 80, source_url: "https://www.amazon.com/dp/B08N5WRWNW", domain: "amazon.com", merchant: "Amazon", price: 29, currency: "USD", scraped_at: null, opportunity_score: 82, trend_score: null, save_velocity_score: null, item_type: "product" },
  { id: "amz-home-2", product_name: "Amazon Gold Desk Lamp", image_url: "https://placehold.co/300x300/FF9900/white?text=Amazon+Home+2", seed_keyword: "home decor", category: "home-decor", save_count: 96, source_pin_save_count: 76, source_url: "https://www.amazon.com/dp/B08N5WRWN1", domain: "amazon.com", merchant: "Amazon", price: 35, currency: "USD", scraped_at: null, opportunity_score: 79, trend_score: null, save_velocity_score: null, item_type: "product" },
  { id: "amz-fashion-1", product_name: "Amazon Silk Scarf", image_url: "https://placehold.co/300x300/D946EF/white?text=Amazon+Fashion", seed_keyword: "fashion outfit", category: "fashion", save_count: 92, source_pin_save_count: 72, source_url: "https://www.amazon.com/dp/B08N5WRWN2", domain: "amazon.com", merchant: "Amazon", price: 19, currency: "USD", scraped_at: null, opportunity_score: 77, trend_score: null, save_velocity_score: null, item_type: "product" },
  { id: "amz-beauty-1", product_name: "Amazon Makeup Organizer", image_url: "https://placehold.co/300x300/60A5FA/white?text=Amazon+Beauty", seed_keyword: "beauty", category: "beauty", save_count: 88, source_pin_save_count: 70, source_url: "https://www.amazon.com/dp/B08N5WRWN3", domain: "amazon.com", merchant: "Amazon", price: 22, currency: "USD", scraped_at: null, opportunity_score: 75, trend_score: null, save_velocity_score: null, item_type: "product" },
  { id: "amz-travel-1", product_name: "Amazon Packing Cubes", image_url: "https://placehold.co/300x300/10B981/white?text=Amazon+Travel", seed_keyword: "travel", category: "travel", save_count: 84, source_pin_save_count: 68, source_url: "https://www.amazon.com/dp/B08N5WRWN4", domain: "amazon.com", merchant: "Amazon", price: 18, currency: "USD", scraped_at: null, opportunity_score: 73, trend_score: null, save_velocity_score: null, item_type: "product" },
  { id: "etsy-home-1", product_name: "Etsy Floral Wall Print", image_url: "https://placehold.co/300x300/4ADE80/white?text=Etsy+Home", seed_keyword: "home decor", category: "home-decor", save_count: 72, source_pin_save_count: 50, source_url: "https://etsy.com/listing/1", domain: "etsy.com", merchant: "Etsy", price: 18, currency: "USD", scraped_at: null, opportunity_score: 65, trend_score: null, save_velocity_score: null, item_type: "product" },
];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, baseURL: "http://127.0.0.1:3000" });
page.setDefaultTimeout(45000);
await page.route("**/api/products/top**", async route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: rows, data: rows, itemCount: rows.length, source: "product_ideas_api", lastUpdatedAt: new Date().toISOString() }) }));
await page.route("**/api/viral-pins**", async route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], data: [], itemCount: 0, source: "pin_ideas_api", lastUpdatedAt: new Date().toISOString() }) }));
await page.route("https://placehold.co/**", async route => route.fulfill({ status: 200, contentType: "image/png", body: tinyPng }));
await page.route("**/api/history-storage", async route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries: [] }) }));

await page.goto("/app/studio", { waitUntil: "networkidle", timeout: 60000 });
await page.getByTestId("composer-panel").waitFor();
await page.waitForTimeout(2500);
for (let attempt = 0; attempt < 4; attempt++) {
  await page.getByTestId("add-product-images").click({ force: true });
  if (await page.getByTestId("product-picker").isVisible().catch(() => false)) break;
  await page.waitForTimeout(1000);
}
await page.getByTestId("product-picker").waitFor();
await page.getByTestId("picker-tab-product_ideas").click();
await page.getByTestId("product-ideas-grid").waitFor();
await page.getByTestId("product-idea-skeleton").waitFor({ state: "detached" }).catch(() => {});
await page.screenshot({ path: `${outDir}/01-separated-source-category.png`, fullPage: true });
await page.getByTestId("product-ideas-source-amazon").click();
await page.screenshot({ path: `${outDir}/02-source-amazon.png`, fullPage: true });
await page.getByTestId("product-ideas-category-home-decor").click();
await page.screenshot({ path: `${outDir}/03-source-amazon-category-home-decor.png`, fullPage: true });

const info = {
  topTabs: await page.getByTestId("asset-picker-top-tabs").locator("button").allTextContents(),
  sourceTexts: await page.getByTestId("product-ideas-source-filters").locator("button").allTextContents(),
  categoryTexts: await page.getByTestId("product-ideas-category-filters").locator("button").allTextContents(),
  amazonHomeCount: await page.getByTestId("product-ideas-grid").getByTestId("asset-card").count(),
};
await page.getByTestId("product-ideas-grid").getByTestId("asset-card").first().click();
const selectedAfter = await page.getByTestId("asset-picker-selected-count").textContent();
await page.getByTestId("asset-picker-confirm").click();
await page.getByTestId("product-picker").waitFor({ state: "detached" });
await page.getByTestId("add-product-images").click({ force: true });
await page.getByTestId("product-picker").waitFor();
info.selectedAfter = selectedAfter;
info.myProductsCountText = await page.getByTestId("my-products-count").textContent();
console.log(JSON.stringify(info, null, 2));
await browser.close();

