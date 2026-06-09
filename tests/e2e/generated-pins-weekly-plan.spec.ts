import { test, expect } from "@playwright/test";

/**
 * Generated Pins persistence test.
 *
 * Seeds a fake session into localStorage using the CORRECT keys:
 *   - "vp:studio:history"  (from studioPersistence.ts HISTORY_KEY)
 *   - "vp:pin_store:v1"    (from pinStore.ts STORE_KEY)
 *
 * Tests that pinStore status survives a full page reload.
 * Does NOT depend on Supabase auth or weekly_plan_items data.
 */

const HISTORY_KEY  = "vp:studio:history";
const PIN_STORE_KEY = "vp:pin_store:v1";

const IMAGES = [
  "https://placehold.co/400x600/FF4D8D/white?text=E2E+Pin+1",
  "https://placehold.co/400x600/D946EF/white?text=E2E+Pin+2",
];

test.describe("Generated Pins persistence (localStorage-based)", () => {

  test("pins added to plan show changed status and survive page refresh", async ({ page }) => {

    await page.goto("/app/history", { waitUntil: "domcontentloaded" });
    const url = page.url();
    expect(url, "Still on login — ensure E2E_TEST_MODE=true in .env.local and restart dev server").not.toContain("/login");

    // ── Seed both localStorage stores ─────────────────────────────────────────
    const sessionId = `e2e-${Date.now()}`;
    await page.evaluate(
      ({ sid, images, histKey, storeKey }) => {
        const now = new Date().toISOString();

        // 1. Seed history (vp:studio:history)
        const histEntry = {
          id: sid, savedAt: now,
          keyword: "E2E Bedroom Decor", category: "home-decor", source: "workspace",
          groups: [{ refUrl: null, images }],
          refCount: 1, productCount: 0, totalPins: images.length,
          promptExcerpt: "E2E test session",
        };
        const rawHist = localStorage.getItem(histKey);
        const hist = rawHist ? JSON.parse(rawHist) : [];
        hist.unshift(histEntry);
        localStorage.setItem(histKey, JSON.stringify(hist.slice(0, 50)));

        // 2. Seed pinStore (vp:pin_store:v1) — creates session + pin records
        const rawStore = localStorage.getItem(storeKey);
        const store = rawStore ? JSON.parse(rawStore) : { sessions: {}, pins: {} };
        const pinIds: string[] = [];
        for (let i = 0; i < images.length; i++) {
          const pinId = `${sid}_g0_i${i}`;
          store.pins[pinId] = {
            id: pinId, imageUrl: images[i], sessionId: sid,
            keyword: "E2E Bedroom Decor", category: "home-decor",
            groupIndex: 0, refUrl: null, status: "generated", createdAt: now,
          };
          pinIds.push(pinId);
        }
        store.sessions[sid] = {
          id: sid, keyword: "E2E Bedroom Decor", category: "home-decor",
          source: "workspace", status: "generated",
          pinIds, groups: [{ refUrl: null, pinIds }],
          totalPins: images.length, addedCount: 0,
          createdAt: now, updatedAt: now,
        };
        localStorage.setItem(storeKey, JSON.stringify(store));
      },
      { sid: sessionId, images: IMAGES, histKey: HISTORY_KEY, storeKey: PIN_STORE_KEY },
    );

    // ── Reload so the page picks up seeded data ────────────────────────────────
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("generated-pins-page")).toBeVisible({ timeout: 8000 });
    await page.waitForSelector('[data-testid="generated-pin-card"]', { timeout: 8000 });

    // ── Find our seeded card (most recent = first) ─────────────────────────────
    const firstCard = page.getByTestId("generated-pin-card").first();
    await expect(firstCard).toBeVisible();

    // Should start as "Not added"
    const textBefore = await firstCard.textContent() ?? "";
    expect(textBefore, "First card should contain 'Not added'").toMatch(/not added/i);

    // ── Click "Add all to Plan" ────────────────────────────────────────────────
    const addBtn = firstCard.locator("button", { hasText: /add all to plan/i });
    await expect(addBtn).toBeVisible({ timeout: 3000 });
    await addBtn.click();
    await page.waitForTimeout(500); // let pinStore emit + React re-render

    // ── Status should update immediately ──────────────────────────────────────
    const textAfter = await firstCard.textContent() ?? "";
    expect(textAfter, `Status didn't update after click. Text: "${textAfter}"`).toMatch(/added to plan|partially added/i);

    // ── Full page reload ───────────────────────────────────────────────────────
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="generated-pin-card"]', { timeout: 8000 });

    const firstAfter = page.getByTestId("generated-pin-card").first();
    const textAfterReload = await firstAfter.textContent() ?? "";

    expect(
      textAfterReload,
      `pinStore status lost after reload.\nBefore reload: "${textAfter}"\nAfter reload: "${textAfterReload}"`
    ).toMatch(/added to plan|partially added/i);
    expect(textAfterReload, "Card reverted to 'Not added' after reload").not.toMatch(/^not added$/i);

    // ── Cleanup ────────────────────────────────────────────────────────────────
    await page.evaluate(
      ({ sid, histKey, storeKey }) => {
        const h = localStorage.getItem(histKey);
        if (h) localStorage.setItem(histKey, JSON.stringify(JSON.parse(h).filter((e: {id:string}) => e.id !== sid)));
        const s = localStorage.getItem(storeKey);
        if (s) {
          try {
            const p = JSON.parse(s);
            delete p.sessions[sid];
            Object.keys(p.pins).filter(k => k.startsWith(sid)).forEach(k => delete p.pins[k]);
            localStorage.setItem(storeKey, JSON.stringify(p));
          } catch { /* ignore */ }
        }
      },
      { sid: sessionId, histKey: HISTORY_KEY, storeKey: PIN_STORE_KEY },
    );
  });

});
