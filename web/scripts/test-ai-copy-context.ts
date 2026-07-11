import { chromium } from "@playwright/test";
import { strict as assert } from "node:assert";

const now = new Date().toISOString();
const imageUrl = "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?w=900&auto=format&fit=crop";

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  let callCount = 0;
  let lastPayload: { mode?: string; previousCopy?: { title?: string; description?: string } } | null = null;

  await page.addInitScript(({ now, imageUrl }) => {
    localStorage.setItem("vp:studio_board_v2", "1");
    localStorage.setItem("vp:pin_drafts:v1", JSON.stringify({ drafts: {
      draft_copy_test: {
        id: "draft_copy_test",
        imageUrl,
        keyword: "cozy bedroom",
        category: "Home Decor",
        title: "Pink and green bedding",
        description: "",
        altText: "",
        destinationUrl: "https://shop.example.com/collections/green-striped-bedding",
        boardId: "b_home",
        boardName: "Home Decor Ideas",
        weeklyPlanItemId: "",
        generationSessionId: "",
        scheduledDate: "",
        status: "needs_review",
        createdAt: now,
        updatedAt: now,
        source: "uploaded_image",
        format: "Pinterest 2:3",
        tags: [],
      },
    }}));
  }, { now, imageUrl });

  await page.route("**/api/pinterest/boards**", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: [{ id: "b_home", name: "Home Decor Ideas", description: "Warm bedroom styling ideas" }], bookmark: null }),
  }));

  await page.route("**/api/ai-copy", async route => {
    callCount += 1;
    lastPayload = route.request().postDataJSON() as { mode?: string; previousCopy?: { title?: string; description?: string } };
    const regenerate = lastPayload.mode === "regenerate";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        requestId: `mock_copy_${callCount}`,
        output: regenerate ? {
          title: "Cozy Pink and Green Bedroom Styling",
          description: "Refresh a bedroom with layered pink and green striped bedding, soft color contrast, and a cozy decor palette that fits Home Decor Ideas.",
          tags: ["pink bedding", "green bedding", "cozy bedroom", "bedroom decor"],
          altText: "Pink and green striped bedding layered on a bed in a cozy bedroom.",
        } : {
          title: "Pink and Green Bedding Ideas for a Cozy Bedroom",
          description: "Layer pink and green striped bedding to create a cozy, colorful bedroom look. Use this idea for a bedroom refresh or home decor update.",
          tags: ["pink bedding", "green bedding", "striped bedding", "cozy bedroom", "bedroom decor"],
          altText: "Pink and green striped bedding layered on a bed in a cozy bedroom.",
        },
        context: {
          imageContext: {
            primarySubjects: ["pink and green striped bedding", "bed"],
            scene: "cozy bedroom",
            attributes: ["striped bedding", "layered textiles"],
            colors: ["pink", "green"],
            style: ["cozy", "colorful"],
            visibleText: [],
          },
          productContext: { category: "Home Decor", productUrl: "https://shop.example.com/collections/green-striped-bedding" },
          pageContext: { title: "green striped bedding", domain: "shop.example.com" },
          boardContext: { name: "Home Decor Ideas" },
          keywordContext: ["pink bedding", "green bedding", "cozy bedroom"],
          trendContext: [],
        },
        promptContext: { imageContext: { primarySubjects: ["pink and green striped bedding"] } },
        contextSourcesUsed: ["image", "product", "page", "Board", "keyword"],
        contextSummary: "Based on image, product, page, Board, and keyword context",
        contextDetails: [
          "Image: pink and green striped bedding, cozy bedroom, pink, green, cozy",
          "Product: Home Decor",
          "Board: Home Decor Ideas",
          "Page: green striped bedding, shop.example.com",
          "Keywords: pink bedding, green bedding, cozy bedroom",
          "Trend: none used",
        ],
        timingsMs: { localContext: 1, imageAccess: 20, imageAnalysis: 800, pageContext: 30, keywords: 1, trends: 0, llmGeneration: 900, total: 1752 },
        provider: "mock",
        model: "mock-copy-model",
        promptVersion: "ai_copy_v3_structured",
        fallbackUsed: false,
      }),
    });
  });

  await page.goto("http://127.0.0.1:3000/app/studio", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-testid='pin-board-card']");
  await page.locator("[data-testid='card-edit']").first().click();
  await page.locator("[data-testid='card-generate-copy']").click();
  await page.waitForFunction(() => document.querySelector("[data-testid='card-generate-copy']")?.textContent?.includes("Regenerate copy"));
  const title1 = await page.locator("[data-testid='board-field-title']").inputValue();
  const desc1 = await page.locator("[data-testid='board-field-description']").inputValue();
  assert.match(title1, /pink and green bedding/i);
  assert.doesNotMatch(desc1, /pinterest-ready idea|relevant ideas|product inspiration/i);
  assert.equal((lastPayload as { mode?: string } | null)?.mode, "initial");

  await page.locator("[data-testid='card-generate-copy']").click();
  await page.waitForFunction(() => window.localStorage.getItem("vp:pin_drafts:v1")?.includes("Cozy Pink and Green Bedroom Styling"));
  const title2 = await page.locator("[data-testid='board-field-title']").inputValue();
  assert.notEqual(title2, title1);
  assert.equal((lastPayload as { mode?: string } | null)?.mode, "regenerate");
  assert.ok((lastPayload as { previousCopy?: { title?: string } } | null)?.previousCopy?.title);
  assert.equal(callCount, 2);

  await browser.close();
  console.log("AI copy browser pipeline test passed", { title1, title2, callCount });
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
