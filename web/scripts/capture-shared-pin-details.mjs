import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const baseUrl = "http://127.0.0.1:3000";
const outputDir = path.resolve("artifacts", "shared-pin-details");
const imageUrl = `${baseUrl}/landing/boho-living-room/references/pin-ref-01.webp`;
const productUrl = `${baseUrl}/landing/boho-living-room/products/product-wicker-storage-basket.webp`;
const now = new Date().toISOString();

const setupSnapshot = {
  mode: "product_led",
  keyword: "Boho living room inspiration",
  category: "home-decor",
  opportunityTitle: "Boho living room inspiration",
  noTextOverlay: true,
  imagesPerReference: 1,
  selectedProducts: [{
    productId: "product-visual-test",
    imageUrl: productUrl,
    title: "Wicker storage basket",
    source: "product_ideas",
    productUrl: "https://example.com/products/wicker-storage-basket",
  }],
  selectedReferences: [{
    referenceId: "reference-visual-test",
    imageUrl,
    title: "Boho living room reference",
    source: "pin_ideas",
  }],
  promptSnapshot: "Create a Pinterest-native boho living room Pin with natural light and no text overlay.",
  createdFrom: "studio",
  format: "Pinterest 2:3",
  model: "GPT Image",
};

const historyEntry = {
  id: "session-visual-test",
  savedAt: now,
  keyword: "Boho living room inspiration",
  category: "home-decor",
  source: "studio",
  groups: [{ refUrl: imageUrl, images: [imageUrl] }],
  refCount: 1,
  productCount: 1,
  totalPins: 1,
  status: "completed",
  expectedTotal: 1,
  mode: "product_led",
  opportunity: "Boho living room inspiration",
  imagesPerRef: 1,
  productNames: ["Wicker storage basket"],
  promptFull: setupSnapshot.promptSnapshot,
  setupSnapshot,
};

const pinDraft = {
  id: "draft-visual-test",
  pinId: "session-visual-test-g0-p0",
  imageUrl,
  keyword: "Boho living room inspiration",
  category: "home-decor",
  title: "Boho Living Room Inspiration",
  description: "A warm Pinterest-ready boho living room with natural textures and practical storage ideas.",
  altText: "Boho living room with wicker storage, neutral textiles, and natural daylight.",
  destinationUrl: "https://example.com/products/wicker-storage-basket",
  boardId: "board-visual-test",
  boardName: "Home Decor Ideas",
  weeklyPlanItemId: "weekly-visual-test",
  generationSessionId: "session-visual-test",
  scheduledDate: "2026-06-24",
  scheduledTime: "11:30",
  status: "ready",
  planningStatus: "ready",
  generationStatus: "completed",
  createdAt: now,
  updatedAt: now,
  addedToPlanAt: now,
  setupSnapshot,
  promptSnapshot: setupSnapshot.promptSnapshot,
  opportunity: "Boho living room inspiration",
  source: "studio",
  format: "Pinterest 2:3",
  model: "GPT Image",
  linkedProducts: [{
    id: "product-visual-test",
    title: "Wicker storage basket",
    imageUrl: productUrl,
    productUrl: "https://example.com/products/wicker-storage-basket",
    isPrimary: true,
  }],
  primaryProductId: "product-visual-test",
};

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1536, height: 1024 } });
await context.addInitScript(({ historyEntry, pinDraft }) => {
  localStorage.setItem("vp:studio:history", JSON.stringify([historyEntry]));
  localStorage.setItem("vp:pin_drafts:v1", JSON.stringify({ drafts: { [pinDraft.id]: pinDraft } }));
}, { historyEntry, pinDraft });

const page = await context.newPage();

await page.goto(`${baseUrl}/app/studio`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(8_000);
const visualCard = page.locator('article[title="Generated Set ual-test"]');
if ((await visualCard.count()) !== 1) throw new Error("Visual test Pin card was not restored");
await visualCard.click();
await page.getByRole("heading", { name: "Pin Details", exact: true }).waitFor({ state: "visible" });
await page.screenshot({ path: path.join(outputDir, "create-pins-details.png"), fullPage: true });
await page.getByTestId("draft-details-close").click();

await visualCard.hover();
const regenerate = visualCard.getByRole("button", { name: "Regenerate", exact: true });
if ((await regenerate.count()) !== 1) throw new Error("Regenerate action is missing from the Pin card");
await regenerate.click();
await page.getByRole("button", { name: "Remix", exact: true }).waitFor({ state: "visible" });
if (await page.getByRole("button", { name: "Debug", exact: true }).count()) {
  throw new Error("Debug is visible to a normal user");
}
await page.screenshot({ path: path.join(outputDir, "normal-user-no-debug.png"), fullPage: true });

await page.goto(`${baseUrl}/app/plan`, { waitUntil: "domcontentloaded" });
const plannedCard = page.getByTestId("scheduled-draft-card").filter({ hasText: "Boho Living Room Inspiration" });
await plannedCard.waitFor({ state: "visible", timeout: 30_000 });
if ((await plannedCard.count()) !== 1) throw new Error("Expected one visual test Pin in Weekly Plan");
const plannedImage = plannedCard.locator(':scope > div[style*="aspect-ratio"]');
if ((await plannedImage.count()) !== 1) throw new Error("Expected one clickable image in Weekly Plan card");
await plannedImage.click();
await page.getByRole("heading", { name: "Pin Details", exact: true }).waitFor({ state: "visible" });
await page.screenshot({ path: path.join(outputDir, "weekly-plan-details.png"), fullPage: true });

console.log(`Screenshots written to ${outputDir}`);
await browser.close();
