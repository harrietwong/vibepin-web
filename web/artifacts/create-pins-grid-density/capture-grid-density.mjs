import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const outDir = "artifacts/create-pins-grid-density";
mkdirSync(outDir, { recursive: true });

const label = process.argv[2] ?? "grid";
const viewportWidth = Number(process.argv[3] ?? 1440);
const screenshotPath = `${outDir}/${label}.png`;
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const generatedUrls = Array.from({ length: 4 }, (_, i) =>
  `https://placehold.co/500x750/${["7C3AED", "0891B2", "DB2777", "16A34A"][i]}/ffffff?text=Pin+${i + 1}`,
);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  baseURL: "http://127.0.0.1:3000",
  viewport: { width: viewportWidth, height: 1000 },
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
await page.route("**/api/generate", async route => {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, urls: generatedUrls }),
  });
});
await page.route("**/api/storage-image**", async route => {
  await route.fulfill({ status: 200, contentType: "image/png", body: tinyPng });
});
await page.route("**/api/proxy-image**", async route => {
  await route.fulfill({ status: 200, contentType: "image/png", body: tinyPng });
});
await page.route("https://placehold.co/**", async route => {
  await route.fulfill({ status: 200, contentType: "image/png", body: tinyPng });
});

await page.addInitScript(() => {
  localStorage.clear();
  sessionStorage.clear();
  const now = new Date().toISOString();
  const images = Array.from({ length: 4 }, (_, i) =>
    `https://placehold.co/500x750/${["7C3AED", "0891B2", "DB2777", "16A34A"][i]}/ffffff?text=Pin+${i + 1}`,
  );
  localStorage.setItem("vp:studio:history", JSON.stringify([{
    id: "grid-density-session",
    savedAt: now,
    keyword: "grid density",
    category: "home-decor",
    source: "studio",
    groups: [{
      refUrl: null,
      images,
      productImages: ["https://placehold.co/300x300/111827/ffffff?text=Product"],
      promptSnapshot: "Create a polished Pinterest product pin for a desktop grid density check.",
      category: "home-decor",
      format: "2:3",
      model: "Gemini Image",
    }],
    refCount: 0,
    productCount: 1,
    totalPins: 4,
    status: "completed",
    expectedTotal: 4,
    mode: "product_led",
    imagesPerRef: 4,
    productNames: ["Screenshot product"],
    promptExcerpt: "Create a polished Pinterest product pin for a desktop grid density check.",
    promptFull: "Create a polished Pinterest product pin for a desktop grid density check.",
    setupSnapshot: {
      selectedProducts: [{ imageUrl: "https://placehold.co/300x300/111827/ffffff?text=Product", title: "Screenshot product" }],
      selectedReferences: [],
      prompt: "Create a polished Pinterest product pin for a desktop grid density check.",
      category: "home-decor",
      format: "2:3",
      model: "Gemini Image",
      productImageCount: 1,
      referenceImageCount: 0,
      count: 4,
    },
  }]));
});

await page.goto("/app/studio", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.getByTestId("composer-panel").waitFor();
await page.getByTestId("generate-btn").waitFor();
await page.getByTestId("generated-pin-card").first().waitFor();
await page.waitForTimeout(800);

const metrics = await page.evaluate(() => {
  const grid = document.querySelector('[data-testid="pin-feed-grid"]');
  const cards = Array.from(document.querySelectorAll('[data-testid="generated-pin-card"]'));
  const rects = cards.map(card => {
    const r = card.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  });
  const rows = new Map();
  for (const rect of rects) {
    rows.set(rect.y, (rows.get(rect.y) ?? 0) + 1);
  }
  const gridStyle = grid ? getComputedStyle(grid) : null;
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
    grid: grid ? grid.getBoundingClientRect().toJSON() : null,
    gridTemplateColumns: gridStyle?.gridTemplateColumns ?? null,
    gap: gridStyle?.gap ?? null,
    cards: rects,
    firstRowCount: rects.filter(rect => rect.y === rects[0]?.y).length,
    rows: Array.from(rows.entries()),
  };
});

await page.screenshot({ path: screenshotPath, fullPage: true });
console.log(JSON.stringify({ screenshotPath, ...metrics }, null, 2));
await browser.close();
