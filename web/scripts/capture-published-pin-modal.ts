/**
 * Screenshot the Pin details modal in BOTH states after the published-Pin
 * read-only redesign: published (read-only summary + View on Pinterest) and
 * scheduled (unchanged editable form, regression reference).
 *
 * Prerequisites (same as capture-theme-screenshots.ts):
 *   • Server running with E2E_TEST_MODE=true (bypasses Supabase auth).
 *   • BASE_URL env (defaults to http://localhost:3100).
 *
 * Drafts are seeded straight into the pinDraftStore localStorage key before any
 * page script runs; the modal is opened via the same deep link the publish flow
 * itself uses (/app/plan?pinId=…&modal=publish).
 *
 * Output: web/tmp/published-pin-modal/{published,scheduled}-pin-modal.png
 */

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3100";
const OUT_DIR = path.join(process.cwd(), "tmp", "published-pin-modal");
const STORE_KEY = "vp:pin_drafts:v1";
const THEME_KEY = "vp:appearance_theme:v1";

const common = {
  imageUrl: "/landing/boho-living-room/references/pin-ref-01.jpg",
  keyword: "boho living room",
  category: "home-decor",
  title: "Ideas for your home",
  description: "Save these cozy boho living room ideas for your next refresh — natural textures, warm neutrals, and easy layers.",
  altText: "Cozy boho living room with rattan furniture",
  destinationUrl: "https://example.com/home-decor-guide",
  boardId: "b_home_decor",
  boardName: "Home Decor Ideas",
  weeklyPlanItemId: "wpi_shot",
  generationSessionId: "",
  scheduledDate: "2026-07-08",
  scheduledTime: "09:00",
  status: "ready",
  createdAt: "2026-07-01T08:00:00.000Z",
  updatedAt: "2026-07-08T09:00:00.000Z",
  addedToPlanAt: "2026-07-01T08:00:00.000Z",
};

const drafts = {
  pd_shot_published: {
    ...common,
    id: "pd_shot_published",
    postedAt: "2026-07-08T09:00:00.000Z",
    remotePinId: "1234567890123456789",
  },
  pd_shot_scheduled: {
    ...common,
    id: "pd_shot_scheduled",
    scheduledDate: "2026-07-12",
  },
};

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(
    ([storeKey, store, themeKey]) => {
      try {
        window.localStorage.setItem(storeKey, store);
        window.localStorage.setItem(themeKey, "dark");
      } catch { /* ignore */ }
    },
    [STORE_KEY, JSON.stringify({ drafts }), THEME_KEY],
  );

  let failed = false;
  for (const [id, file] of [
    ["pd_shot_published", "published-pin-modal.png"],
    ["pd_shot_scheduled", "scheduled-pin-modal.png"],
  ] as const) {
    const page = await context.newPage();
    try {
      await page.goto(`${BASE_URL}/app/plan?pinId=${id}&modal=publish&source=weekly_plan_publish_modal`, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      if (page.url().includes("/login")) throw new Error("redirected to /login — is E2E_TEST_MODE=true?");
      const drawer = page.getByTestId("draft-details-drawer");
      await drawer.waitFor({ state: "visible", timeout: 20_000 });
      await page.waitForTimeout(2000); // let boards/status fetches + image settle
      await drawer.screenshot({ path: path.join(OUT_DIR, file) });
      console.log(`  OK ${file}`);
    } catch (e) {
      failed = true;
      console.error(`  FAIL ${file}: ${(e as Error).message}`);
      await page.screenshot({ path: path.join(OUT_DIR, `debug-${file}`) }).catch(() => {});
    } finally {
      await page.close();
    }
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
}

void main();
