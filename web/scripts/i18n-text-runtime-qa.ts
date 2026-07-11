import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright";

const BASE_URL = process.env.I18N_QA_BASE_URL ?? "http://127.0.0.1:3000";
const OUT_DIR = join(process.cwd(), "tmp/i18n-text-qa/screenshots");

const BAD_TEXT_RE = new RegExp([
  "\\uFFFD",
  "\\u00C3",
  "\\u00C2",
  "\\u00E2\\u20AC",
  "\\u00E4\\u00B8",
  "\\u00F0\\u0178",
  "\\u00E5\\u0160",
  "\\u00E5\\u00A5",
  "\\u00E6\\u20AC",
  "\\u00E6\\u0153",
  "\\u00E7\\u0161",
  "\\u00E8\\u00AF",
  "\\u00E9\\u20AC",
  "\\u00E3\\u20AC",
  "\\u9593",
  "\\u9225",
  "\\u922B",
  "\\u9239",
  "\\u9397",
  "\\u9983",
  "\\u9241",
  "\\u9514",
  "\\bundefined\\b",
  "\\bnull\\b",
  "\\[object Object\\]",
  "page\\.[a-z0-9_.-]+",
].join("|"), "i");

const products = [
  {
    id: "qa-etsy-home-1",
    product_name: "Personalized Wooden Recipe Box",
    price: 32,
    currency: "USD",
    source_url: "https://www.etsy.com/listing/qa-recipe-box",
    domain: "etsy.com",
    merchant: "Etsy",
    image_url: "https://qa-assets.local/product-1.svg",
    save_count: 40000,
    source_pin_save_count: 2481000,
    seed_keyword: "home decor",
    category: "home-decor",
    parent_pin_id: "111111111111111111",
    scraped_at: new Date().toISOString(),
    opportunity_score: 86,
    trend_score: 78,
    save_velocity_score: 80,
    item_type: "product",
    product_type: "physical_product",
    product_subtype: "unknown",
    destination_type: "product_page",
    risk_flags: [],
  },
  ...Array.from({ length: 8 }, (_, index) => ({
    id: `qa-amazon-${index + 1}`,
    product_name: [
      "Amazon Woven Storage Basket",
      "Amazon Ceramic Vase Set",
      "Amazon Silk Scarf",
      "Amazon Rose Face Serum",
      "Amazon Wedding Welcome Sign",
      "Amazon Travel Packing Cubes",
      "Amazon Printable Planner Bundle",
      "Amazon Candle Making Kit",
    ][index],
    price: [24, 38, 19, 21, 29, 18, 12, 34][index],
    currency: "USD",
    source_url: `https://www.amazon.com/dp/B0QA${index}TEXT`,
    domain: "amazon.com",
    merchant: "Amazon",
    image_url: `https://qa-assets.local/amazon-${index + 1}.svg`,
    save_count: [1260, 982, 860, 740, 680, 620, 510, 450][index],
    source_pin_save_count: [84000, 62000, 54000, 48000, 42000, 36000, 28000, 22000][index],
    seed_keyword: [
      "home decor",
      "home decor",
      "fashion outfit",
      "beauty routine",
      "wedding decor",
      "travel essentials",
      "digital planner",
      "diy crafts",
    ][index],
    category: [
      "home-decor",
      "home-decor",
      "fashion",
      "beauty",
      "wedding",
      "travel",
      "digital-products",
      "diy-crafts",
    ][index],
    parent_pin_id: `22222222222222222${index}`,
    scraped_at: new Date(Date.now() - index * 3600_000).toISOString(),
    opportunity_score: [82, 80, 76, 74, 72, 70, 68, 66][index],
    trend_score: 66,
    save_velocity_score: 70,
    item_type: "product",
    product_type: index === 6 ? "digital_product" : "physical_product",
    product_subtype: index === 6 ? "template" : "unknown",
    destination_type: "product_page",
    risk_flags: [],
  })),
];

const kwCatMap = {
  "home decor": "home-decor",
  "fashion outfit": "fashion",
  "beauty routine": "beauty",
  "wedding decor": "wedding",
  "travel essentials": "travel",
  "digital planner": "digital-products",
  "diy crafts": "diy-crafts",
};

function svg(label: string, hue: number) {
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="500" height="650" viewBox="0 0 500 650">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop stop-color="hsl(${hue}, 78%, 62%)"/>
          <stop offset="1" stop-color="hsl(${(hue + 70) % 360}, 82%, 48%)"/>
        </linearGradient>
      </defs>
      <rect width="500" height="650" fill="url(#g)"/>
      <rect x="56" y="72" width="388" height="506" rx="34" fill="rgba(255,255,255,.84)"/>
      <text x="250" y="325" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#172033">${label}</text>
    </svg>`;
}

async function installRoutes(page: Page) {
  await page.route("**/api/**", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: [], data: [], entries: [], ok: true }),
  }));
  await page.route("**/api/products/top**", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: products, lastUpdatedAt: new Date().toISOString(), source: "qa_seeded_product_opportunities", itemCount: products.length }),
  }));
  await page.route("**/api/keywords/category-map**", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(kwCatMap),
  }));
  await page.route("https://qa-assets.local/**", route => {
    const name = route.request().url().split("/").pop()?.replace(".svg", "") ?? "asset";
    const hue = [...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 360;
    route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg(name, hue) });
  });
}

async function goto(page: Page, path: string) {
  const url = `${BASE_URL}${path}`;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ERR_ABORTED")) throw error;
    await page.waitForTimeout(500);
    if (!page.url().startsWith(url)) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }
  }
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
}

async function setLanguage(page: Page, code: string) {
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.getByTestId("topbar-language-button").evaluate((element: HTMLElement) => element.click());
  await page.getByTestId("topbar-language-menu").waitFor({ timeout: 5_000 });
  await page.getByTestId(`topbar-language-option-${code}`).click({ force: true });
  await page.waitForTimeout(400);
}

async function setStoredLanguage(page: Page, code: string) {
  await page.addInitScript(languageCode => {
    window.localStorage.setItem("vibepin-locale-prefs", JSON.stringify({
      appLanguage: languageCode,
      contentLanguage: "same",
      pinterestRegion: "US",
    }));
  }, code);
}

async function cleanBody(page: Page, label: string) {
  const text = await page.locator("body").innerText();
  if (BAD_TEXT_RE.test(text)) throw new Error(`${label}: corrupted/runtime placeholder text found: ${JSON.stringify(text.match(BAD_TEXT_RE)?.[0])}`);
}

async function screenshot(page: Page, file: string) {
  await page.screenshot({ path: join(OUT_DIR, file), fullPage: true });
}

async function openDrawer(page: Page) {
  await goto(page, "/app/products");
  await page.getByTestId("product-card").first().waitFor({ timeout: 20_000 });
  await page.getByTestId("product-card").first().click();
  await page.getByTestId("product-opportunity-drawer").waitFor({ timeout: 10_000 });
}

async function assertDrawer(page: Page, language: "en" | "zh-CN") {
  const drawer = page.getByTestId("product-opportunity-drawer");
  if (language === "zh-CN") {
    for (const text of ["产品机会", "产品评估", "预计月搜索量", "商业竞争度", "数据依据", "产品收藏", "来源 Pin 收藏", "机会评分", "在 Etsy 查看", "用于创建 Pin"]) {
      await drawer.getByText(text, { exact: false }).waitFor({ timeout: 5_000 });
    }
  } else {
    for (const text of ["Product Opportunity", "Product Assessment", "Est. Monthly Vol", "Commercial Density", "Evidence", "Product saves", "Source pin saves", "Opportunity score", "View on Etsy", "Use in Create Pins"]) {
      await drawer.getByText(text, { exact: false }).waitFor({ timeout: 5_000 });
    }
  }
  await cleanBody(page, `${language} drawer`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  await installRoutes(page);

  await goto(page, "/app/products");
  await setLanguage(page, "en");
  await page.getByTestId("product-card").first().waitFor({ timeout: 20_000 });
  await page.getByTestId("product-card").first().click();
  await page.getByTestId("product-opportunity-drawer").waitFor({ timeout: 10_000 });
  await assertDrawer(page, "en");
  await screenshot(page, "en-product-opportunity-drawer.png");
  await page.keyboard.press("Escape");
  await screenshot(page, "en-product-opportunities-grid.png");
  await goto(page, "/app/studio");
  await screenshot(page, "en-create-pins.png");
  await goto(page, "/app/settings/language");
  await screenshot(page, "en-settings-language.png");

  await goto(page, "/app/products");
  await setLanguage(page, "zh-CN");
  await page.getByTestId("product-card").first().click();
  await assertDrawer(page, "zh-CN");
  await screenshot(page, "zh-CN-product-opportunity-drawer.png");
  await page.keyboard.press("Escape");
  await screenshot(page, "zh-CN-product-opportunities-grid.png");

  await goto(page, "/app/studio");
  await cleanBody(page, "zh-CN Create Pins");
  await screenshot(page, "zh-CN-create-pins.png");
  await goto(page, "/app/plan");
  await cleanBody(page, "zh-CN Weekly Plan");
  await screenshot(page, "zh-CN-weekly-plan.png");
  await goto(page, "/app/dashboard");
  await cleanBody(page, "zh-CN Dashboard");
  await screenshot(page, "zh-CN-dashboard.png");
  await goto(page, "/app/settings/language");
  await cleanBody(page, "zh-CN Settings Language");
  await screenshot(page, "zh-CN-settings-language.png");
  await page.getByTestId("topbar-language-button").click({ force: true });
  await screenshot(page, "zh-CN-topbar-language-dropdown.png");
  await page.keyboard.press("Escape");
  await page.getByTestId("topbar-theme-button").click({ force: true });
  await screenshot(page, "zh-CN-theme-dropdown.png");
  await page.keyboard.press("Escape");

  for (const code of ["ja", "ko", "es", "ar"]) {
    const localePage = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
    await installRoutes(localePage);
    await setStoredLanguage(localePage, code);
    await goto(localePage, "/app/products");
    await localePage.getByTestId("product-card").first().click();
    await localePage.getByTestId("product-opportunity-drawer").waitFor({ timeout: 10_000 });
    await cleanBody(localePage, `${code} drawer`);
    await screenshot(localePage, `${code}-product-opportunity-drawer.png`);
    await localePage.close();
  }

  await browser.close();
  const summary = {
    baseUrl: BASE_URL,
    screenshots: [
      "en-product-opportunity-drawer.png",
      "en-product-opportunities-grid.png",
      "en-create-pins.png",
      "en-settings-language.png",
      "zh-CN-product-opportunity-drawer.png",
      "zh-CN-product-opportunities-grid.png",
      "zh-CN-create-pins.png",
      "zh-CN-weekly-plan.png",
      "zh-CN-dashboard.png",
      "zh-CN-settings-language.png",
      "zh-CN-topbar-language-dropdown.png",
      "zh-CN-theme-dropdown.png",
      "ja-product-opportunity-drawer.png",
      "ko-product-opportunity-drawer.png",
      "es-product-opportunity-drawer.png",
      "ar-product-opportunity-drawer.png",
    ],
    productCount: products.length,
    amazonProductCount: products.filter(p => p.merchant === "Amazon").length,
  };
  writeFileSync(join(process.cwd(), "tmp/i18n-text-qa/runtime-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`i18n runtime QA passed: ${summary.screenshots.length} screenshots, ${summary.amazonProductCount} Amazon opportunity records.`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
