import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const outDir = "artifacts/create-pins-selected-asset-preview";
mkdirSync(outDir, { recursive: true });

const productUrls = [
  "https://asset-preview.local/product-1.svg",
  "https://asset-preview.local/product-2.svg",
  "https://asset-preview.local/product-3.svg",
];
const referenceUrls = [
  "https://asset-preview.local/reference-1.svg",
  "https://asset-preview.local/reference-2.svg",
];

function svgFor(url) {
  const isReference = url.includes("reference");
  const match = url.match(/-(\d)\.svg/);
  const idx = match ? Number(match[1]) : 1;
  const colors = isReference
    ? [["#0F766E", "#CCFBF1"], ["#6D28D9", "#EDE9FE"]]
    : [["#BE123C", "#FFE4E6"], ["#0369A1", "#E0F2FE"], ["#A16207", "#FEF3C7"]];
  const [bg, fg] = colors[(idx - 1) % colors.length];
  const label = `${isReference ? "Reference" : "Product"} ${idx}`;
  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="420" height="560" viewBox="0 0 420 560">
      <rect width="420" height="560" fill="${bg}"/>
      <circle cx="330" cy="94" r="56" fill="${fg}" opacity="0.28"/>
      <rect x="54" y="142" width="312" height="276" rx="28" fill="${fg}" opacity="0.22"/>
      <text x="210" y="284" text-anchor="middle" font-family="Arial, sans-serif" font-size="38" font-weight="800" fill="${fg}">${label}</text>
      <text x="210" y="330" text-anchor="middle" font-family="Arial, sans-serif" font-size="18" font-weight="700" fill="${fg}" opacity="0.8">Selected preview</text>
    </svg>
  `);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  baseURL: "http://127.0.0.1:3000",
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});
page.setDefaultTimeout(45_000);

await page.route("**/rest/v1/**", async route => {
  if (route.request().method() !== "GET") {
    await route.continue();
    return;
  }
  await route.fulfill({
    status: 200,
    headers: { "Content-Type": "application/json", "Content-Range": "0-0/0" },
    body: "[]",
  });
});
await page.route("**/api/history-storage", async route => {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries: [] }) });
});
await page.route("**/api/products/top**", async route => {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], data: [] }) });
});
await page.route("**/api/viral-pins**", async route => {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], data: [] }) });
});
await page.route("**/api/proxy-image**", async route => {
  const requestUrl = new URL(route.request().url());
  const imageUrl = requestUrl.searchParams.get("url") ?? "";
  await route.fulfill({ status: 200, contentType: "image/svg+xml", body: svgFor(imageUrl) });
});
await page.route("https://asset-preview.local/**", async route => {
  await route.fulfill({ status: 200, contentType: "image/svg+xml", body: svgFor(route.request().url()) });
});

await page.addInitScript(({ productUrls, referenceUrls }) => {
  localStorage.clear();
  sessionStorage.clear();
  const now = new Date().toISOString();
  const assets = [
    ...productUrls.map((url, index) => ({
      id: `product-${index + 1}`,
      role: "product",
      source: index === 0 ? "product_ideas" : "upload",
      imageUrl: url,
      title: index === 0 ? "Amazon ceramic table lamp" : `Uploaded product ${index + 1}`,
      sourceDomain: index === 0 ? "amazon.com" : "local upload",
      productUrl: index === 0 ? "https://www.amazon.com/dp/B08N5WRWNW" : undefined,
      createdAt: now,
      lastUsedAt: now,
    })),
    ...referenceUrls.map((url, index) => ({
      id: `reference-${index + 1}`,
      role: "style_reference",
      source: "viral_pin",
      imageUrl: url,
      title: `Reference mood ${index + 1}`,
      sourceDomain: "pinterest.com",
      createdAt: now,
      lastUsedAt: now,
    })),
  ];
  localStorage.setItem("vp_assets_v1", JSON.stringify(assets));
  localStorage.setItem("vibepin_composer_v1", JSON.stringify({
    products: productUrls,
    refs: referenceUrls,
    prompt: "Create a polished Pinterest pin using the selected products and references.",
    count: 2,
    variationMode: "distinct",
    opportunity: null,
  }));
}, { productUrls, referenceUrls });

await page.goto("/app/studio", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.getByTestId("composer-panel").waitFor();
await page.getByTestId("selected-product-thumbnail").first().waitFor();
await page.getByTestId("selected-reference-thumbnail").first().waitFor();
await page.waitForTimeout(800);
await page.screenshot({ path: `${outDir}/01-compact-selected-thumbnails.png`, fullPage: true });

await page.getByTestId("selected-product-thumbnail").nth(1).hover();
await page.getByTestId("selected-asset-hover-preview").waitFor();
await page.waitForTimeout(250);
await page.screenshot({ path: `${outDir}/02-product-hover-preview.png`, fullPage: true });

await page.getByTestId("selected-reference-thumbnail").first().hover();
await page.getByTestId("selected-asset-hover-preview").waitFor();
await page.waitForTimeout(250);
await page.screenshot({ path: `${outDir}/03-reference-hover-preview.png`, fullPage: true });

await page.getByTestId("selected-product-thumbnail").first().click();
await page.getByTestId("selected-asset-gallery").waitFor();
await page.waitForTimeout(250);
await page.screenshot({ path: `${outDir}/04-click-gallery.png`, fullPage: true });
await page.keyboard.press("Escape");
await page.getByTestId("selected-asset-gallery").waitFor({ state: "detached" });

const metrics = await page.evaluate(() => ({
  productThumbs: document.querySelectorAll('[data-testid="selected-product-thumbnail"]').length,
  referenceThumbs: document.querySelectorAll('[data-testid="selected-reference-thumbnail"]').length,
  galleryOpenAfterEscape: !!document.querySelector('[data-testid="selected-asset-gallery"]'),
}));
console.log(JSON.stringify(metrics, null, 2));
await browser.close();
