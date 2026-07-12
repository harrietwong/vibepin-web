const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://localhost:3000/app/studio', { waitUntil: 'domcontentloaded', timeout: 15000 });
  // Inject session
  await page.evaluate(() => {
    const entry = {
      id: "verify-sess-2", savedAt: new Date().toISOString(),
      keyword: "boho bedroom", category: "home-decor", source: "studio", status: "completed",
      totalPins: 1, refCount: 1, productCount: 1,
      promptFull: "Boho bedroom ideas with rattan furniture",
      setupSnapshot: {
        mode: "keyword_led", keyword: "boho bedroom", category: "home-decor",
        opportunityTitle: "Boho bedroom", noTextOverlay: true, imagesPerReference: 1,
        selectedProducts: [{ imageUrl: "https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=200", title: "Sofa" }],
        selectedReferences: [{ imageUrl: "https://images.unsplash.com/photo-1616594039964-ae9021a400a0?w=200" }],
        promptSnapshot: "Boho bedroom ideas with rattan furniture", createdFrom: "studio",
      },
      groups: [{ refUrl: "https://images.unsplash.com/photo-1616594039964-ae9021a400a0?w=200", images: ["https://picsum.photos/400/600?random=10"] }],
    };
    const existing = JSON.parse(localStorage.getItem("vp:studio:history") || "[]");
    existing.unshift(entry);
    localStorage.setItem("vp:studio:history", JSON.stringify(existing));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  // Open drawer
  const card = await page.$('[data-testid="generated-pin-card"]');
  if (card) {
    await card.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'drawer-preview.png' });
    // Switch to Remix
    const remix = await page.$('[data-testid="pin-details-tab-remix"]');
    if (remix) { await remix.click(); await page.waitForTimeout(500); }
    await page.screenshot({ path: 'drawer-remix.png' });
    // Switch to Plan
    const plan = await page.$('[data-testid="pin-details-tab-plan"]');
    if (plan) { await plan.click(); await page.waitForTimeout(500); }
    await page.screenshot({ path: 'drawer-plan.png' });
  }
  await browser.close();
  console.log('Done');
})();
