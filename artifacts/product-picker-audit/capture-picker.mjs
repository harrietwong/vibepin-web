import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const outDir = "artifacts/product-picker-audit";
mkdirSync(outDir, { recursive: true });

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const amazonRows = Array.from({ length: 5 }, (_, i) => ({
  id: `amz-${i + 1}`,
  product_name: [`Amazon Woven Storage Basket`, `Amazon Ceramic Mug Set`, `Amazon LED Vanity Mirror`, `Amazon Linen Throw Pillow`, `Amazon Gold Desk Lamp`][i],
  image_url: `https://placehold.co/300x300/${["FF9900", "8B5CF6", "D946EF", "10B981", "60A5FA"][i]}/white?text=Amazon+${i + 1}`,
  seed_keyword: i < 2 ? "home decor" : "fashion outfit",
  save_count: 100 - i,
  source_pin_save_count: 80 - i,
  source_url: `https://www.amazon.com/dp/B08N5WRWN${i}`,
  domain: "amazon.com",
  merchant: "Amazon",
  price: 20 + i,
  currency: "USD",
  scraped_at: null,
  opportunity_score: 80 - i,
  trend_score: null,
  save_velocity_score: null,
  item_type: "product",
}));
const nonAmazonRows = [
  {
    id: "etsy-1",
    product_name: "Etsy Floral Wall Print",
    image_url: "https://placehold.co/300x300/4ADE80/white?text=Etsy+1",
    seed_keyword: "home decor",
    save_count: 72,
    source_pin_save_count: 50,
    source_url: "https://etsy.com/listing/1",
    domain: "etsy.com",
    merchant: "Etsy",
    price: 18,
    currency: "USD",
    scraped_at: null,
    opportunity_score: 65,
    trend_score: null,
    save_velocity_score: null,
    item_type: "product",
  },
];
const productRows = [...amazonRows, ...nonAmazonRows];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, baseURL: "http://127.0.0.1:3000" });
page.setDefaultTimeout(30000);
await page.route("**/api/products/top**", async route => {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: productRows, data: productRows, itemCount: productRows.length, source: "product_ideas_api", lastUpdatedAt: new Date().toISOString() }),
  });
});
await page.route("**/api/viral-pins**", async route => {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], data: [], itemCount: 0, source: "pin_ideas_api", lastUpdatedAt: new Date().toISOString() }) });
});
await page.route("https://placehold.co/**", async route => {
  await route.fulfill({ status: 200, contentType: "image/png", body: tinyPng });
});
await page.route("**/api/history-storage", async route => {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries: [] }) });
});

await page.goto("/app/studio", { waitUntil: "networkidle", timeout: 45000 });
await page.getByTestId("composer-panel").waitFor();
await page.getByTestId("add-product-images").click({ force: true });
await page.getByTestId("product-picker").waitFor();
await page.screenshot({ path: `${outDir}/01-top-tabs.png`, fullPage: true });

await page.getByTestId("picker-tab-product_ideas").click();
await page.getByTestId("product-ideas-grid").waitFor();
await page.getByTestId("product-idea-skeleton").waitFor({ state: "detached" }).catch(() => {});
await page.screenshot({ path: `${outDir}/02-product-ideas-filters.png`, fullPage: true });

await page.getByTestId("product-ideas-filter-amazon").click();
await page.getByTestId("product-ideas-grid").waitFor();
await page.screenshot({ path: `${outDir}/03-amazon-filter-results.png`, fullPage: true });

const topTabs = await page.getByTestId("asset-picker-top-tabs").locator("button").allTextContents();
const amazonCount = await page.getByTestId("product-ideas-grid").getByTestId("asset-card").count();
const selectedBefore = await page.getByTestId("asset-picker-selected-count").textContent();
await page.getByTestId("product-ideas-grid").getByTestId("asset-card").first().click();
const selectedAfter = await page.getByTestId("asset-picker-selected-count").textContent();
await page.getByTestId("asset-picker-confirm").click();
await page.getByTestId("product-picker").waitFor({ state: "detached" });
await page.getByTestId("add-product-images").click({ force: true });
await page.getByTestId("product-picker").waitFor();
const myProductsCountText = await page.getByTestId("my-products-count").textContent();

console.log(JSON.stringify({ topTabs, amazonCount, selectedBefore, selectedAfter, myProductsCountText }, null, 2));
await browser.close();

