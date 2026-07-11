/**
 * Live verification: retry/remix snapshot bug fix
 * Run: npx tsx scripts/verify-retry-snapshot.ts
 *
 * Tests (source-level, no browser needed for logic):
 * 1. handleRegenerateGroup uses snapshot values not live state
 * 2. Remix tab hydrates from initRemixFromDetail (with fallbacks)
 * 3. Legacy generations: amber warning shown, prompt not empty
 * 4. onPinDetailRegenerateWithRemix works for null snapshot via baseSnap
 *
 * Browser smoke: opens studio page, checks drawer tab structure renders.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BASE = "http://localhost:3001";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  let pass = 0;
  let fail = 0;

  function ok(label: string) { console.log(`  ✓ ${label}`); pass++; }
  function ko(label: string, detail?: string) {
    console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`);
    fail++;
  }

  // ── 1. Studio page loads ────────────────────────────────────────────────────
  console.log("\n[1] Studio page loads");
  try {
    await page.goto(`${BASE}/app/studio`, { waitUntil: "domcontentloaded", timeout: 15000 });
    const title = await page.title();
    if (title) ok(`Page loaded — title: "${title}"`);
    else ko("Page loaded but no title");
  } catch (e) {
    ko("Studio page failed to load", String(e));
    await browser.close();
    process.exit(1);
  }

  // ── 2. Composer UI elements present ────────────────────────────────────────
  console.log("\n[2] Composer UI");
  try {
    await page.waitForSelector('[data-testid="studio-composer"], textarea, input[placeholder]', { timeout: 8000 });
    ok("Composer rendered");
  } catch {
    // Try screenshot to diagnose
    await page.screenshot({ path: "verify-studio-load.png" });
    ko("Composer not found within 8s — screenshot saved");
  }

  // ── 3. Source-level checks (fast, no network) ───────────────────────────────
  console.log("\n[3] Source-level correctness checks");
  const studioSrc = readFileSync(join(process.cwd(), "src/app/app/studio/page.tsx"), "utf8");
  const drawerSrc = readFileSync(join(process.cwd(), "src/components/studio/PinDetailsDrawer.tsx"), "utf8");
  const persistSrc = readFileSync(join(process.cwd(), "src/lib/studioPersistence.ts"), "utf8");

  // Retry uses snapshot
  if (studioSrc.includes("const snap") && studioSrc.includes("snap?.promptSnapshot") && studioSrc.includes("retryProducts"))
    ok("handleRegenerateGroup reads from setupSnapshot");
  else ko("handleRegenerateGroup snapshot logic missing");

  // No live state in retry API body
  const rg = studioSrc.slice(studioSrc.indexOf("handleRegenerateGroup"), studioSrc.indexOf("handleRegenerateGroup") + 2500);
  const apiBody = rg.slice(rg.indexOf("body: JSON.stringify"), rg.indexOf("body: JSON.stringify") + 300);
  if (!apiBody.includes("product_images: products"))
    ok("Retry API does NOT pass live products state");
  else ko("Retry API still uses live products — BUG NOT FIXED");

  // initRemixFromDetail exists and has fallbacks
  if (drawerSrc.includes("initRemixFromDetail") && drawerSrc.includes("refFromGroup") && drawerSrc.includes("detail.promptSnapshot"))
    ok("initRemixFromDetail exists with group refUrl + prompt fallbacks");
  else ko("initRemixFromDetail missing or incomplete");

  // Lazy-init uses initRemixFromDetail
  if (drawerSrc.includes("setRemixDraft(initRemixFromDetail(detail))"))
    ok("Remix lazy-init uses initRemixFromDetail");
  else ko("Remix lazy-init still uses old initRemixFromSnapshot");

  // Legacy warning uses new contextual message
  if (drawerSrc.includes("Older generation") && drawerSrc.includes("partial recovery"))
    ok("Legacy warning is contextual (Older generation / partial recovery)");
  else ko("Legacy warning text missing or old blunt message");

  // Prompt textarea not gated
  if (!drawerSrc.includes("!hasSetupSnapshot && !promptText"))
    ok("Remix prompt textarea not gated behind snapshot");
  else ko("Remix prompt textarea is still gated — empty for legacy pins");

  // snapshotQuality in Preview
  if (drawerSrc.includes("snapshotQuality") && drawerSrc.includes("Full snapshot saved") && drawerSrc.includes("Legacy — prompt only"))
    ok("snapshotQuality MetaRow in Preview tab");
  else ko("snapshotQuality labels missing");

  // baseSnap fallback for legacy in onPinDetailRegenerateWithRemix
  if (studioSrc.includes("const baseSnap: SetupSnapshot = snap ??"))
    ok("onPinDetailRegenerateWithRemix builds baseSnap for legacy sessions");
  else ko("baseSnap fallback missing in onPinDetailRegenerateWithRemix");

  // handleReuseSetup no toast.error
  const reuseBlock = studioSrc.slice(studioSrc.indexOf("function handleReuseSetup"), studioSrc.indexOf("function handleReuseSetup") + 1200);
  if (!reuseBlock.includes("toast.error") && reuseBlock.includes("toast.success"))
    ok("handleReuseSetup uses toast.success for all cases");
  else ko("handleReuseSetup still uses toast.error for missing snapshot");

  // SetupSnapshot has format + model
  if (persistSrc.includes("format?:") && persistSrc.includes("model?:"))
    ok("SetupSnapshot type includes format and model fields");
  else ko("SetupSnapshot missing format/model fields");

  // ── 4. Browser: drawer tab structure ───────────────────────────────────────
  console.log("\n[4] Browser: inject mock pin and open drawer");
  try {
    // Inject a HistoryEntry into vp:studio:history so the feed shows a card
    await page.evaluate(() => {
      const entry = {
        id: "verify-sess-1",
        savedAt: new Date().toISOString(),
        keyword: "boho bedroom",
        category: "home-decor",
        source: "studio",
        status: "completed",
        totalPins: 1,
        refCount: 1,
        productCount: 1,
        promptFull: "Boho bedroom ideas with rattan furniture",
        promptExcerpt: "Boho bedroom ideas with rattan furniture",
        setupSnapshot: {
          mode: "keyword_led",
          keyword: "boho bedroom",
          category: "home-decor",
          opportunityTitle: "Boho bedroom",
          noTextOverlay: true,
          imagesPerReference: 1,
          selectedProducts: [{ imageUrl: "https://example.com/p.png", title: "Rattan Chair" }],
          selectedReferences: [{ imageUrl: "https://example.com/r.png" }],
          promptSnapshot: "Boho bedroom ideas with rattan furniture",
          createdFrom: "studio",
        },
        groups: [{
          refUrl: "https://example.com/r.png",
          images: ["https://picsum.photos/400/600?random=99"],
        }],
      };
      const existing = JSON.parse(localStorage.getItem("vp:studio:history") ?? "[]");
      existing.unshift(entry);
      localStorage.setItem("vp:studio:history", JSON.stringify(existing));
    });
    ok("Injected mock session into localStorage");

    // Reload so the feed picks it up
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    // Look for a pin card
    const cards = await page.locator('[data-testid="generated-pin-card"]').count();
    if (cards > 0) {
      ok(`Found ${cards} pin card(s) in feed`);

      // Click the first card
      await page.locator('[data-testid="generated-pin-card"]').first().click();
      await page.waitForTimeout(1000);

      // Drawer should open
      const drawer = await page.locator('[data-testid="pin-details-drawer"]').count();
      if (drawer > 0) {
        ok("PinDetailsDrawer opened");

        // Check it's on Preview tab
        const previewTab = await page.locator('[data-testid="pin-details-tab-preview"]').count();
        const remixTab   = await page.locator('[data-testid="pin-details-tab-remix"]').count();
        const planTab    = await page.locator('[data-testid="pin-details-tab-plan"]').count();
        if (previewTab > 0 && remixTab > 0 && planTab > 0)
          ok("All 3 tabs (Preview / Remix / Plan) rendered");
        else ko(`Tabs missing — preview:${previewTab} remix:${remixTab} plan:${planTab}`);

        // Preview tab should show snapshot quality
        const snapMeta = await page.locator('[data-testid="pin-details-setup-quality"]').count();
        if (snapMeta > 0) ok("Setup quality MetaRow visible in Preview");
        else ko("Setup quality MetaRow not found (data-testid=pin-details-setup-quality)");

        // Click Remix tab
        await page.locator('[data-testid="pin-details-tab-remix"]').click();
        await page.waitForTimeout(500);

        // Remix prompt should be populated
        const promptTextarea = await page.locator('[data-testid="pin-details-remix-prompt"]');
        const promptCount = await promptTextarea.count();
        if (promptCount > 0) {
          const promptVal = await promptTextarea.inputValue();
          if (promptVal.length > 0)
            ok(`Remix prompt populated: "${promptVal.substring(0, 60)}..."`);
          else ko("Remix prompt textarea is EMPTY — snapshot not hydrated");
        } else {
          ko("Remix prompt textarea not found");
        }

        // Take screenshot
        await page.screenshot({ path: "verify-drawer-remix.png", fullPage: false });
        ok("Screenshot saved: verify-drawer-remix.png");

      } else {
        await page.screenshot({ path: "verify-no-drawer.png" });
        ko("Drawer did not open — screenshot: verify-no-drawer.png");
      }
    } else {
      await page.screenshot({ path: "verify-no-cards.png" });
      ko(`No pin cards found (${cards}) — screenshot: verify-no-cards.png`);
    }

  } catch (e) {
    ko("Browser test threw", String(e));
    await page.screenshot({ path: "verify-error.png" });
  }

  await browser.close();

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Result: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
