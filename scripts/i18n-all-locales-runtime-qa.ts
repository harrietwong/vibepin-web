import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { ALL_APP_LANGUAGES, LOCALE_STORAGE_KEY, languageDirection, type LanguageCode } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";

const BASE_URL = process.env.I18N_QA_BASE_URL ?? "http://127.0.0.1:3000";
const OUT_DIR = join(process.cwd(), "tmp/i18n-all-locales/screenshots");

const BAD_TEXT_RE = new RegExp([
  "\\uFFFD",
  "\\u00E2\\u20AC",
  "\\u9239",
  "\\u9225",
  "\\u922B",
  "\\u9397",
  "\\u9983",
  "\\u9241",
  "\\u9514",
  "\\bundefined\\b",
  "\\bnull\\b",
  "\\[object Object\\]",
  "page\\.[a-z0-9_.-]+",
].join("|"), "i");

const BLOCKED_ENGLISH = [
  "Product Opportunity",
  "Product Assessment",
  "EST. MONTHLY VOL",
  "COMMERCIAL DENSITY",
  "Evidence",
  "Product saves",
  "Source pin saves",
  "View on Etsy",
  "Use in Create Pins",
  "Settings",
  "Save changes",
  "Cancel",
  "Create Pins",
  "Weekly Plan",
];

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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="650" viewBox="0 0 500 650">
    <rect width="500" height="650" fill="hsl(${hue}, 78%, 58%)"/>
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
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ERR_ABORTED")) throw error;
    await page.waitForTimeout(500);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
  }
  await page.waitForTimeout(700);
}

async function switchLanguageViaTopbar(page: Page, locale: LanguageCode) {
  const button = page.getByTestId("topbar-language-button");
  await button.waitFor({ timeout: 15_000 });
  let usedMenu = true;
  try {
    await button.evaluate((element: HTMLElement) => element.click());
    await page.getByTestId("topbar-language-menu").waitFor({ timeout: 5_000 });
    const option = page.getByTestId(`topbar-language-option-${locale}`);
    await option.scrollIntoViewIfNeeded();
    await option.click({ force: true });
  } catch {
    usedMenu = false;
    await page.evaluate(({ key, language }) => {
      localStorage.setItem(key, JSON.stringify({ appLanguage: language, contentLanguage: "same", pinterestRegion: "US" }));
    }, { key: LOCALE_STORAGE_KEY, language: locale });
    await page.reload({ waitUntil: "domcontentloaded" });
  }
  await page.waitForTimeout(500);
  const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "{}").appLanguage, LOCALE_STORAGE_KEY);
  if (stored !== locale && !(locale === "en" && stored == null)) {
    throw new Error(`${locale}: language did not persist to localStorage; got ${stored}`);
  }
  if (!usedMenu) console.warn(`${locale}: topbar menu fallback used after automation click failed`);
}

async function assertClean(page: Page, locale: LanguageCode, label: string) {
  const text = await page.locator("body").innerText();
  if (BAD_TEXT_RE.test(text)) throw new Error(`${locale} ${label}: bad text ${JSON.stringify(text.match(BAD_TEXT_RE)?.[0])}`);
  if (locale !== "en") {
    for (const english of BLOCKED_ENGLISH) {
      if (text.includes(english)) throw new Error(`${locale} ${label}: blocked English UI label still visible: ${english}`);
    }
  }
}

async function assertDrawer(page: Page, locale: LanguageCode) {
  const messages = getMessages(locale);
  const drawer = page.getByTestId("product-opportunity-drawer");
  for (const key of [
    "page.products.drawer.productOpportunity",
    "page.products.drawer.productAssessment",
    "page.products.drawer.estMonthlyVol",
    "page.products.drawer.commercialDensity",
    "page.products.drawer.evidence",
    "page.products.drawer.productSaves",
    "page.products.drawer.sourcePinSaves",
    "page.products.drawer.opportunityScore",
    "page.products.drawer.useInCreatePins",
  ] as const) {
    await drawer.getByText(messages[key], { exact: false }).waitFor({ timeout: 5_000 });
  }
  await assertClean(page, locale, "drawer");
}

async function screenshot(page: Page, locale: LanguageCode, name: string, fullPage = false) {
  await page.screenshot({ path: join(OUT_DIR, `${locale}-${name}.png`), fullPage, animations: "disabled", timeout: 60_000 });
}

async function openFirstProductDrawer(page: Page) {
  const card = page.getByTestId("product-card").first();
  await card.waitFor({ timeout: 20_000 });
  const box = await card.boundingBox();
  if (!box) throw new Error("product card has no bounding box");
  await page.mouse.click(box.x + box.width * 0.72, box.y + box.height * 0.9);
  await page.getByTestId("product-opportunity-drawer").waitFor({ timeout: 10_000 });
}

async function runLocale(browser: Awaited<ReturnType<typeof chromium.launch>>, locale: LanguageCode) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await installRoutes(page);

  await goto(page, "/app/products");
  await switchLanguageViaTopbar(page, locale);
  await assertClean(page, locale, "topbar");
  await screenshot(page, locale, "topbar", false);

  if (documentDirectionCheckRequired(locale)) {
    const dir = await page.evaluate(() => document.documentElement.dir);
    if (dir !== languageDirection(locale)) throw new Error(`${locale}: expected dir=${languageDirection(locale)}, got ${dir}`);
  }

  await goto(page, "/app/settings/language");
  await assertClean(page, locale, "settings-language");
  await screenshot(page, locale, "settings-language");

  await goto(page, "/app/dashboard");
  await assertClean(page, locale, "dashboard");
  await screenshot(page, locale, "dashboard");

  await goto(page, "/app/products");
  await page.getByTestId("product-card").first().waitFor({ timeout: 20_000 });
  await assertClean(page, locale, "product-opportunities");
  await screenshot(page, locale, "product-opportunities", false);

  await openFirstProductDrawer(page);
  await assertDrawer(page, locale);
  await screenshot(page, locale, "product-opportunity-drawer");

  await context.close();
}

function documentDirectionCheckRequired(locale: LanguageCode) {
  return locale === "ar";
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const locales = ALL_APP_LANGUAGES.map(l => l.code);
  const failures: string[] = [];
  const browser = await chromium.launch({ headless: true });
  try {
    for (const locale of locales) {
      try {
        await runLocale(browser, locale);
        console.log(`OK ${locale}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${locale}: ${message}`);
        console.error(`FAIL ${locale}: ${message}`);
      }
    }
  } finally {
    await browser.close();
  }
  const screenshots = locales.flatMap(locale => [
    `${locale}-topbar.png`,
    `${locale}-settings-language.png`,
    `${locale}-dashboard.png`,
    `${locale}-product-opportunities.png`,
    `${locale}-product-opportunity-drawer.png`,
  ]);
  writeFileSync(join(process.cwd(), "tmp/i18n-all-locales/runtime-summary.json"), `${JSON.stringify({
    baseUrl: BASE_URL,
    locales,
    screenshotCount: screenshots.length,
    screenshots,
    productCount: products.length,
    amazonProductCount: products.filter(p => p.merchant === "Amazon").length,
    failures,
  }, null, 2)}\n`, "utf8");
  if (failures.length) {
    console.error("i18n all-locale runtime QA failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(`i18n all-locale runtime QA passed: ${screenshots.length} screenshots across ${locales.length} locales.`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
