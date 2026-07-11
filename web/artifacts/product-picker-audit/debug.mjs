import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, baseURL: "http://127.0.0.1:3000" });
await page.goto("/app/studio", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.screenshot({ path: "artifacts/product-picker-audit/debug-page.png", fullPage: true });
console.log({ url: page.url(), title: await page.title(), body: (await page.locator('body').innerText()).slice(0,1000), testids: await page.locator('[data-testid]').evaluateAll(els => els.slice(0,50).map(e => e.getAttribute('data-testid'))) });
await browser.close();
