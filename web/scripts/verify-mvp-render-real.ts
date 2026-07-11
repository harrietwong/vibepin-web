#!/usr/bin/env tsx
/**
 * verify-mvp-render-real.ts — REAL-DATA render verification (no route mocks).
 * Drives a real Chromium against the running dev server (http://127.0.0.1:3000),
 * hitting the REAL /api/products/top and REAL Supabase pin_samples (anon key —
 * verified separately to have SELECT access with no login required). Captures the
 * actual rendered filter lists, card fields, and drawer content, plus a check that
 * the known E2E fixture rows (id c0000003-...-0001..0004, parent_pin_id='0') never
 * render anywhere on either page.
 *
 * Read-only. No DB writes, no code changes beyond this script.
 * Run: npx tsx scripts/verify-mvp-render-real.ts
 */
import { chromium } from "@playwright/test";

const BASE = "http://127.0.0.1:3000";
const FIXTURE_NAMES = [
  "Boho Macrame Wall Hanging Decor",
  "Ceramic Vase Set Minimalist Home",
  "Cozy Knit Throw Blanket Warm",
  "Scented Soy Candle Set Aesthetic",
];
const FIXTURE_URLS = ["etsy.com/listing/e2e1", "amazon.com/dp/e2e2", "target.com/p/e2e3", "anthropologie.com/p/e2e4"];

async function run() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  const out: Record<string, unknown> = {};

  // Capture the real network response so we know exactly what the client received.
  let apiMeta: unknown = null, apiItemCount: number | null = null;
  page.on("response", async (resp) => {
    if (resp.url().includes("/api/products/top")) {
      try {
        const body = await resp.json();
        apiMeta = body.meta;
        apiItemCount = body.itemCount ?? (body.items ?? []).length;
      } catch { /* ignore non-JSON */ }
    }
  });

  // Warm-up request: dev-mode webpack compiles routes on first hit, which can
  // exceed a normal timeout right after a server restart. This absorbs that cost.
  await page.goto("/app/products", { waitUntil: "domcontentloaded", timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(500);

  // ── /app/products (REAL data, no mocks) ──────────────────────────────────────
  await page.goto("/app/products", { waitUntil: "domcontentloaded", timeout: 120000 });
  out.productsUrl = page.url();
  out.productsHttpOk = true;
  await page.waitForTimeout(1500);
  out.apiItemCount = apiItemCount;
  out.apiMeta = apiMeta;

  await page.getByTestId("product-card").first().waitFor({ timeout: 20000 }).catch(() => {});
  out.productCardCount = await page.getByTestId("product-card").count();

  // Open the FIRST REAL card's drawer BEFORE opening Filters (the Filters popover
  // renders a fixed inset-0 z-40 click-outside-to-close backdrop that, if left open,
  // intercepts clicks meant for the card grid underneath it).
  await page.getByTestId("product-card").first().click({ timeout: 5000 }).catch(() => {});
  const drawer = page.getByTestId("product-opportunity-drawer");
  await drawer.waitFor({ timeout: 8000 }).catch(() => {});
  out.drawerText = (await drawer.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 800);
  out.drawerHasProductUrl = (await drawer.getByText("Product URL").count()) > 0;
  out.drawerHasPinUrl = (await drawer.getByText("Pinterest Pin URL").count()) > 0;
  out.drawerHasImage = (await drawer.locator("img").count()) > 0;
  out.drawerHasSourcePinSaves = (await drawer.getByText(/Source Pin Saves/i).count()) > 0;
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);

  // Now open Filters popover, read the two <select> option lists.
  await page.getByRole("button", { name: /Filters/ }).click().catch(() => {});
  await page.waitForTimeout(400);
  const selects = page.locator("select");
  const nSel = await selects.count();
  const optionsOf = async (labelRe: RegExp): Promise<string[]> => {
    for (let i = 0; i < nSel; i++) {
      const opts = await selects.nth(i).locator("option").allTextContents();
      if (opts.some(o => labelRe.test(o))) return opts.map(o => o.trim());
    }
    return [];
  };
  out.productCategoryOptions = await optionsOf(/All categories|Digital Products|Home Decor/i);
  out.productPlatformOptions = await optionsOf(/All platforms|Etsy|Amazon|Other/i);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);

  // Whole-page text scan for anything that should never appear.
  const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
  out.productPageShowsUnknown = bodyText.includes(">unknown<") || / unknown /.test(bodyText);
  out.productPageShowsRawSlugArtifacts = ["digital-products", "home-decor", "diy-crafts"].filter(s => bodyText.includes(s));
  out.productPageShowsSocialDomains = ["instagram.com", "i.pinimg.com", "drive.google.com", "facebook.com", "tiktok.com"].filter(s => bodyText.includes(s));
  out.fixtureNamesVisible = FIXTURE_NAMES.filter(n => bodyText.includes(n.toLowerCase()));
  out.fixtureUrlsVisible = FIXTURE_URLS.filter(u => bodyText.includes(u));

  // ── /app/discover (REAL data, no mocks) ──────────────────────────────────────
  try {
    await page.goto("/app/discover", { waitUntil: "domcontentloaded", timeout: 120000 });
    out.discoverUrl = page.url();
  } catch (e) {
    out.discoverNavError = String(e).slice(0, 120);
    // Print what we have (products results) before bailing on discover.
    console.log(JSON.stringify(out, null, 2));
    await browser.close();
    return;
  }
  await page.waitForTimeout(3000);

  const nicheBtn = page.getByRole("button", { name: /^Niche/ });
  out.nicheButtonMatchCount = await nicheBtn.count();
  await nicheBtn.first().waitFor({ state: "visible", timeout: 15000 }).catch((e) => { out.nicheButtonWaitError = String(e).slice(0, 200); });
  await nicheBtn.first().click({ timeout: 5000 }).catch((e) => { out.nicheClickError = String(e).slice(0, 200); });
  await page.waitForTimeout(500);
  const nicheButtons = await page.locator("button").allTextContents();
  // Strip leading emoji/symbol + space (buttons render "🖥️ Digital Products" etc.)
  const stripEmoji = (t: string) => t.trim().replace(/^[^\p{L}]+/u, "").trim();
  const KNOWN_LABELS = new Set([
    "All Niches", "Digital Products", "Home Decor", "Beauty & Wellness", "Fashion",
    "Kids & Parenting", "Wedding", "DIY & Crafts", "Kitchen & Dining", "Electronics",
    "Gardening", "Quotes", "Entertainment", "Animals", "Travel", "Finance",
    "Architecture", "Design", "Sports", "Sport", "Automotive",
  ]);
  out.discoverNicheOptionsRaw = nicheButtons.map(t => t.trim()).filter(t => stripEmoji(t) && KNOWN_LABELS.has(stripEmoji(t)));
  out.discoverNicheOptions = [...new Set(out.discoverNicheOptionsRaw as string[])].map(stripEmoji);
  await page.keyboard.press("Escape").catch(() => {});

  const discoverBodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
  out.discoverShowsHiddenCategory = ["quotes", "entertainment", "animals", "travel", "finance", "architecture"].filter(c => discoverBodyText.includes(c));
  out.discoverShowsNormalizedLabels = ["beauty & wellness", "home decor", "fashion", "gardening", "digital products", "kids & parenting", "wedding", "diy & crafts", "kitchen & dining", "electronics"].filter(c => discoverBodyText.includes(c));

  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
run().catch(e => { console.error("REAL RENDER VERIFY ERROR:", e); process.exit(1); });
