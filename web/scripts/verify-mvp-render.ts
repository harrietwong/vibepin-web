#!/usr/bin/env tsx
/**
 * verify-mvp-render.ts — read-only render verification for the MVP taxonomy cleanup.
 * Drives a real Chromium against the running dev server (http://127.0.0.1:3000),
 * mocking the data layer so we can inspect the ACTUAL rendered filter lists + cards.
 *
 * No DB writes, no code changes. Run: npx tsx scripts/verify-mvp-render.ts
 */
import { chromium, type Route } from "@playwright/test";

const BASE = "http://127.0.0.1:3000";
const SUPA = "https://jaxteelkecvlozdrdoog.supabase.co";
const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

// ── Mock product rows (server already returns raw category on the row) ──────────
function prod(i: number, category: string, sourceUrl: string, extra: Record<string, unknown> = {}) {
  return {
    id: `p${i}`, product_name: `Test Item ${i}`, price: 20 + i, currency: "USD",
    source_url: sourceUrl, domain: new URL(sourceUrl).hostname, merchant: "Shop",
    image_url: `https://placehold.co/300x375/8B5CF6/white?text=${i}`,
    save_count: 500 + i, source_pin_save_count: 4000 + i, product_pin_id: null,
    seed_keyword: category, category, parent_pin_id: String(1_000_000_000_000 + i),
    scraped_at: null, created_at: null, item_type: "product", ...extra,
  };
}
const productRows: Record<string, unknown>[] = [];
let n = 0;
for (let i = 0; i < 30; i++) productRows.push(prod(n++, "home-decor", "https://www.etsy.com/listing/x"));
for (let i = 0; i < 30; i++) productRows.push(prod(n++, "beauty", "https://www.amazon.com/dp/x"));
for (let i = 0; i < 12; i++) productRows.push(prod(n++, "fashion", "https://www.instagram.com/p/x")); // hidden platform
for (let i = 0; i < 35; i++) productRows.push(prod(n++, "gardening", "https://someblog.example.org/p")); // Other
// E2E fixture — parent_pin_id '0' → MUST be excluded from the UI.
productRows.push({ ...prod(9999, "home-decor", "https://etsy.com/listing/e2e1"),
  product_name: "FIXTURE_SHOULD_NOT_APPEAR", parent_pin_id: "0" });

// ── Mock pin rows for /app/discover (raw pin_samples categories, incl. hidden) ──
function pin(i: number, category: string) {
  return {
    id: `v${i}`, pin_id: String(2_000_000_000_000 + i), image_url: `https://placehold.co/200x300/D946EF/white?text=${i}`,
    category, title: `Pin ${category} ${i}`, description: "", save_count: 8000 - i * 10,
    reaction_count: 5, source_url: "https://www.pinterest.com/search/", outbound_link: null,
    pin_created_at: "2026-05-01T00:00:00Z", scraped_at: "2026-06-01T00:00:00Z",
    save_velocity: 50, days_since_creation: 30,
  };
}
const pinRows: Record<string, unknown>[] = [];
let m = 0;
for (const c of ["home-decor", "beauty", "womens-fashion", "gardening"]) for (let i = 0; i < 8; i++) pinRows.push(pin(m++, c));
for (const c of ["quotes", "entertainment", "animals"]) for (let i = 0; i < 8; i++) pinRows.push(pin(m++, c)); // hidden

async function run() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  const out: Record<string, unknown> = {};

  // Route mocks (both /api and supabase REST used by the two pages).
  await page.route("**/api/products/top**", r => json(r, { items: productRows, meta: {} }));
  await page.route(`${SUPA}/rest/v1/trend_keywords*`, r => json(r, []));
  await page.route(`${SUPA}/rest/v1/keyword_expansions*`, r => json(r, []));
  await page.route(`${SUPA}/rest/v1/pin_products*`, r => json(r, []));
  await page.route(`${SUPA}/rest/v1/pin_samples*`, r => json(r, pinRows));
  await page.route("https://placehold.co/**", r =>
    r.fulfill({ status: 200, contentType: "image/png",
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==", "base64") }));

  // ── /app/products ──────────────────────────────────────────────────────────
  await page.goto("/app/products", { waitUntil: "domcontentloaded", timeout: 45000 });
  out.productsUrl = page.url();
  if (/\/login/.test(page.url())) { out.productsAuthGated = true; }
  else {
    await page.getByTestId("product-card").first().waitFor({ timeout: 20000 }).catch(() => {});
    // Open Filters popover
    await page.getByRole("button", { name: /Filters/ }).click().catch(() => {});
    await page.waitForTimeout(400);
    const selects = page.locator("select");
    const nSel = await selects.count();
    const optionsOf = async (labelRe: RegExp): Promise<string[]> => {
      for (let i = 0; i < nSel; i++) {
        const opts = await selects.nth(i).locator("option").allTextContents();
        if (opts.some(o => labelRe.test(o))) return opts;
      }
      return [];
    };
    out.productCategoryOptions = await optionsOf(/All categories|Digital Products|Home Decor/);
    out.productPlatformOptions = await optionsOf(/All platforms|Etsy|Amazon|Other/);
    out.productCardCount = await page.getByTestId("product-card").count();
    out.fixtureVisible = (await page.getByText("FIXTURE_SHOULD_NOT_APPEAR").count()) > 0;
    // Open a card drawer and read fields
    await page.getByTestId("product-card").first().click().catch(() => {});
    const drawer = page.getByTestId("product-opportunity-drawer");
    await drawer.waitFor({ timeout: 8000 }).catch(() => {});
    out.drawerText = (await drawer.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 600);
    out.drawerHasProductUrl = await drawer.getByText("Product URL").count() > 0;
    out.drawerHasPinUrl = await drawer.getByText("Pinterest Pin URL").count() > 0;
    out.drawerHasSourcePinSaves = await drawer.getByText(/Source Pin Saves|sourcePinSaves/i).count() > 0;
    // The drawer for a gardening/someblog product should now show normalized
    // "Gardening" + "Other", and must NOT show the raw slug tag alone.
    out.drawerHasNormalizedCategory = await drawer.getByText("Gardening", { exact: true }).count() > 0;
    out.drawerHasNormalizedPlatform = await drawer.getByText("Other", { exact: true }).count() > 0;
    out.drawerShowsRawSlug = await drawer.getByText("gardening", { exact: true }).count() > 0;
  }

  // ── /app/discover ──────────────────────────────────────────────────────────
  await page.goto("/app/discover", { waitUntil: "domcontentloaded", timeout: 45000 });
  out.discoverUrl = page.url();
  if (/\/login/.test(page.url())) { out.discoverAuthGated = true; }
  else {
    await page.waitForTimeout(1500);
    // Niche dropdown
    await page.getByRole("button", { name: /^Niche/ }).click().catch(() => {});
    await page.waitForTimeout(300);
    const nicheButtons = await page.locator("button").allTextContents();
    out.discoverNicheOptions = nicheButtons.filter(t =>
      /All Niches|Digital Products|Home Decor|Beauty & Wellness|Fashion|Kids & Parenting|Wedding|DIY & Crafts|Kitchen & Dining|Electronics|Gardening|Quotes|Entertainment|Animals/.test(t.trim())
    ).map(t => t.trim());
    await page.keyboard.press("Escape").catch(() => {});
    // Whole-page text scan: normalized visible labels should appear; hidden raw
    // categories (quotes/entertainment/animals) must NOT appear anywhere in the grid.
    const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    out.discoverShowsHiddenCategory = ["quotes", "entertainment", "animals"].filter(c => bodyText.includes(c));
    out.discoverShowsNormalizedLabels = ["beauty & wellness", "home decor", "fashion", "gardening"].filter(c => bodyText.includes(c));
  }

  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
run().catch(e => { console.error("RENDER VERIFY ERROR:", e); process.exit(1); });
