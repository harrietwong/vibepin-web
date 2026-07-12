import { test, expect, type Page, type BrowserContext, type Route } from "@playwright/test";

/**
 * WP-F: cross-device account-level sync E2E.
 *
 * Two independent BrowserContexts (= two devices, each starting with empty
 * localStorage) are pointed at ONE shared in-memory /api/user-store mock server
 * (a plain Map<storeKey, Map<docId, row>> living in this test process — GET/PUT
 * LWW-upsert/DELETE-tombstone semantics copied from the mock server in
 * scripts/test-user-store-sync.ts, and shaped to match the real contract in
 * src/app/api/user-store/route.ts).
 *
 * Auth: E2E_TEST_MODE=true (.env.local) makes src/proxy.ts a no-op for /app/**,
 * so no login is needed to reach the page. But the client-side sync engine
 * (userStoreSync.ts, mounted from src/app/app/layout.tsx) still needs a REAL
 * (non-null) access token from `getToken()`, and every client-side call site
 * that matters here (layout.tsx, SettingsModal.tsx, useSessionUser.ts) uses the
 * same `@supabase/ssr` createBrowserClient() SINGLETON, which persists its
 * session in a COOKIE (not localStorage) named `sb-<project-ref>-auth-token`,
 * base64url-encoded with a `base64-` prefix (see
 * node_modules/@supabase/ssr/dist/module/cookies.js). We seed that cookie per
 * context via context.addCookies() so getSession() resolves locally (no
 * network) with a valid, non-expired session — see buildFakeSessionCookie().
 *
 * Notification preferences (a SINGLETON user-store doc, storeKey
 * "notification_prefs") drives the "device B's startup pull sees device A's
 * write" scenario end-to-end through the real Settings UI — Account tab already
 * works under E2E_TEST_MODE with just the same background mocks the existing
 * shopify-settings.spec.ts / shopify-picker.spec.ts specs use.
 *
 * Bookmarks (a COLLECTION doc, storeKey "bookmarks") drives the tombstone
 * scenario. Its only UI (BookmarkButton on the Discover page / OpportunityCard)
 * needs several unrelated SWR data endpoints mocked to even render a card, which
 * is disproportionately fragile for what this test needs to prove. Per the task
 * brief's fallback allowance, device A instead writes through the store's exact
 * public persistence contract — `localStorage.setItem(BOOKMARKS_KEY, ...)` +
 * `window.dispatchEvent(new Event(BOOKMARKS_EVENT))`, the same two calls
 * saveBookmarks() (src/lib/useBookmarks.ts) makes — while device B's assertion
 * reads the real, merged localStorage state (not a mock) after a genuine
 * navigation + startup pull.
 *
 * Run:  npx playwright test tests/e2e/account-sync.spec.ts --project=chromium
 */

const SUPABASE_URL = "https://jaxteelkecvlozdrdoog.supabase.co";
const SUPABASE_REF = "jaxteelkecvlozdrdoog";
const AUTH_COOKIE_NAME = `sb-${SUPABASE_REF}-auth-token`;
const APP_ORIGIN = "http://localhost:3000";

const FAKE_USER_ID = "e2e00000-0000-4000-8000-000000000001";
const FAKE_EMAIL = "e2e-account-sync@example.com";

const BOOKMARKS_KEY = "pf_bookmarks_v1";
const BOOKMARKS_EVENT = "pf_bookmarks_changed";

// ── Fake Supabase session cookie (see file header for why a cookie, not localStorage) ──

function buildFakeSessionCookie(deviceSuffix: string): { name: string; value: string } {
  const session = {
    access_token: `e2e-fake-access-token-${deviceSuffix}`,
    refresh_token: `e2e-fake-refresh-token-${deviceSuffix}`,
    token_type: "bearer",
    expires_at: Math.floor(Date.now() / 1000) + 3600, // 1h out — never triggers a refresh
    expires_in: 3600,
    user: {
      id: FAKE_USER_ID, aud: "authenticated", role: "authenticated", email: FAKE_EMAIL,
      app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString(),
    },
  };
  const encoded = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return { name: AUTH_COOKIE_NAME, value: `base64-${encoded}` };
}

async function seedFakeSession(context: BrowserContext, deviceSuffix: string): Promise<void> {
  const cookie = buildFakeSessionCookie(deviceSuffix);
  await context.addCookies([{ ...cookie, url: APP_ORIGIN, sameSite: "Lax" }]);
}

// ── Shared in-memory /api/user-store mock server (one per test; both "devices" -
//    BrowserContexts - route their /api/user-store traffic through the SAME
//    instance, standing in for one server-side account) ─────────────────────────

type Row = { docId: string; updatedAt: string; deletedAt?: string; payload: Record<string, unknown> };

function createSharedUserStoreServer() {
  const byKey = new Map<string, Map<string, Row>>();
  const rowsFor = (k: string) => {
    let m = byKey.get(k);
    if (!m) { m = new Map(); byKey.set(k, m); }
    return m;
  };

  return {
    live: (k: string) => [...rowsFor(k).values()].filter(r => !r.deletedAt),
    row: (k: string, id: string) => rowsFor(k).get(id),

    async handle(route: Route): Promise<void> {
      const req = route.request();
      const method = req.method();
      const url = new URL(req.url());

      if (method === "GET") {
        const storeKey = url.searchParams.get("storeKey") ?? "";
        const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
        const offset = parseInt(url.searchParams.get("cursor") ?? "0", 10) || 0;
        const all = [...rowsFor(storeKey).values()].sort(
          (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.docId.localeCompare(b.docId),
        );
        const page = all.slice(offset, offset + limit);
        const next = offset + limit < all.length ? String(offset + limit) : undefined;
        await route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({ docs: page, ...(next ? { nextCursor: next } : {}) }),
        });
        return;
      }

      const body = req.postDataJSON() as {
        storeKey?: string;
        docs?: Array<{ docId: string; updatedAt: string; payload: Record<string, unknown> }>;
        docIds?: string[];
        deletedAt?: string;
      };
      const storeKey = body.storeKey ?? "";
      const rows = rowsFor(storeKey);

      if (method === "PUT") {
        let applied = 0, skippedStale = 0;
        for (const d of body.docs ?? []) {
          const ex = rows.get(d.docId);
          if (ex && Date.parse(d.updatedAt) < Date.parse(ex.updatedAt)) { skippedStale++; continue; } // server LWW
          rows.set(d.docId, { docId: d.docId, updatedAt: d.updatedAt, payload: d.payload });
          applied++;
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ applied, skippedStale }) });
        return;
      }

      if (method === "DELETE") {
        let applied = 0;
        for (const id of body.docIds ?? []) {
          const ex = rows.get(id);
          if (ex && Date.parse(ex.updatedAt) > Date.parse(body.deletedAt as string)) continue; // server LWW
          rows.set(id, { docId: id, updatedAt: body.deletedAt as string, deletedAt: body.deletedAt as string, payload: ex?.payload ?? {} });
          applied++;
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ applied }) });
        return;
      }

      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found", code: "not_found" }) });
    },
  };
}
type SharedServer = ReturnType<typeof createSharedUserStoreServer>;

// ── Per-device page setup ───────────────────────────────────────────────────────

async function setupDevice(page: Page, server: SharedServer): Promise<void> {
  // Fresh device: empty localStorage/sessionStorage (the auth cookie lives
  // outside these, seeded separately via seedFakeSession before the page exists).
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  await page.route("**/api/user-store**", route => server.handle(route));

  // Background app-shell traffic — same pattern as shopify-*.spec.ts.
  await page.route("**/api/pin-drafts**", async route => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ drafts: [] }) });
    } else {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ applied: 0, skippedStale: 0 }) });
    }
  });
  await page.route(`${SUPABASE_URL}/rest/v1/**`, async route => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  // Account tab calls getUser() (profile load) and Save calls updateUser() — both
  // hit this endpoint over the network even with a valid local session cookie.
  const fakeUser = {
    id: FAKE_USER_ID, aud: "authenticated", role: "authenticated", email: FAKE_EMAIL,
    app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString(),
  };
  await page.route(`${SUPABASE_URL}/auth/v1/user**`, async route => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fakeUser) });
  });
}

async function gotoSettings(page: Page): Promise<void> {
  // The local dev server is shared across work sessions and compiles routes
  // on demand — a first hit can take ~25s and an unlucky hit during a rebuild
  // can serve a truncated chunk (dev-overlay "Unexpected end of JSON input").
  // One reload after a generous wait recovers both cases; warm hits are <2s.
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto("/app/settings", { waitUntil: "domcontentloaded", timeout: 90_000 });
    await expect(page).not.toHaveURL(/\/login/);
    try {
      await expect(page.getByTestId("settings-modal")).toBeVisible({ timeout: 45_000 });
      break;
    } catch (e) {
      if (attempt === 1) throw e;
    }
  }
  await expect(page.getByTestId("settings-tab-account")).toBeVisible();
}

const WEEKLY_SUMMARY_LABEL = "Weekly plan summary"; // account.notif.weeklySummary (en)

function weeklySummaryToggle(page: Page) {
  return page.getByRole("switch", { name: WEEKLY_SUMMARY_LABEL });
}

test.describe("Account-level cross-device sync (WP-F)", () => {
  // Generous: two devices × (possible cold-compile navigation + one retry) on
  // the shared dev server. Warm, uncontended runs finish in well under a minute.
  test.describe.configure({ timeout: 300_000 });

  test("startup pull: device B sees a notification-prefs write made on device A", async ({ browser }) => {
    const server = createSharedUserStoreServer();

    const ctxA = await browser.newContext();
    await seedFakeSession(ctxA, "device-a");
    const pageA = await ctxA.newPage();
    await setupDevice(pageA, server);
    await gotoSettings(pageA);

    const toggleA = weeklySummaryToggle(pageA);
    await expect(toggleA).toBeVisible({ timeout: 15_000 });
    await expect(toggleA).toHaveAttribute("aria-checked", "false"); // default off (defaultNotificationPrefs)
    await toggleA.click();
    await expect(toggleA).toHaveAttribute("aria-checked", "true");

    await pageA.getByTestId("settings-save").click();
    await expect(pageA.getByText("Settings saved").first()).toBeVisible({ timeout: 10_000 });

    // Wait for the SHARED mock server to actually receive the PUT — no sleep.
    await expect.poll(() => {
      const row = server.row("notification_prefs", "prefs");
      return (row?.payload as { weeklySummary?: boolean } | undefined)?.weeklySummary ?? null;
    }, { timeout: 10_000 }).toBe(true);

    // Device B opens the SAME page for the very first time — its startup pull
    // (GET /api/user-store?storeKey=notification_prefs) must land the row A pushed.
    const ctxB = await browser.newContext();
    await seedFakeSession(ctxB, "device-b");
    const pageB = await ctxB.newPage();
    await setupDevice(pageB, server);
    await gotoSettings(pageB);

    // First, the REAL local store: B's startup pull must merge A's doc into
    // vp:notification_prefs:v1 (makeSingletonAdapter.mergeServer → localStorage).
    await expect.poll(async () => {
      const raw = await pageB.evaluate(() => localStorage.getItem("vp:notification_prefs:v1"));
      return raw ? (JSON.parse(raw) as { weeklySummary?: boolean }).weeklySummary ?? null : null;
    }, { timeout: 15_000 }).toBe(true);

    // Then the REAL UI. Note: AccountTab reads prefs once on mount and does not
    // subscribe to NOTIFICATION_PREFS_EVENT, so if it mounted before the startup
    // pull merged, it keeps showing the pre-merge value (known product-side
    // refresh gap, out of scope for WP-F). Remount the tab through a genuine UI
    // path — switch to Billing and back — and the merged value must render.
    await pageB.getByTestId("settings-tab-billing").click();
    await expect(pageB.getByTestId("settings-tab-account")).toBeVisible();
    await pageB.getByTestId("settings-tab-account").click();

    const toggleB = weeklySummaryToggle(pageB);
    await expect(toggleB).toBeVisible({ timeout: 15_000 });
    await expect(toggleB).toHaveAttribute("aria-checked", "true", { timeout: 15_000 });

    await ctxA.close();
    await ctxB.close();
  });

  test("tombstone: a delete on device A converges to device B after reload", async ({ browser }) => {
    const server = createSharedUserStoreServer();

    const ctxA = await browser.newContext();
    await seedFakeSession(ctxA, "device-a");
    const pageA = await ctxA.newPage();
    await setupDevice(pageA, server);
    // Any /app/** page mounts initAllUserStoreSync (registered from the app
    // layout), so Settings — already proven reachable above — is enough; we
    // don't need Discover for this write.
    await gotoSettings(pageA);

    // Two bookmarks: one is a positive control (proves B's startup pull actually
    // works, mirroring test-user-store-sync.ts's "alive" doc), the other is the
    // one we delete (the "dead" doc).
    const keepBookmark = { id: "e2e-bm-keep", type: "pin", title: "Kept bookmark", savedAt: Date.now(), updatedAt: new Date().toISOString() };
    const deleteBookmark = { id: "e2e-bm-delete", type: "pin", title: "Deleted bookmark", savedAt: Date.now(), updatedAt: new Date().toISOString() };
    await pageA.evaluate(([key, evt, a, b]) => {
      localStorage.setItem(key as string, JSON.stringify([a, b]));
      window.dispatchEvent(new Event(evt as string));
    }, [BOOKMARKS_KEY, BOOKMARKS_EVENT, keepBookmark, deleteBookmark]);

    await expect.poll(
      () => server.live("bookmarks").map(r => r.docId).sort(),
      { timeout: 10_000 },
    ).toEqual(["e2e-bm-delete", "e2e-bm-keep"]);

    // Delete just one, on device A (mirrors useBookmarks().remove()/saveBookmarks()).
    await pageA.evaluate(([key, evt, a]) => {
      localStorage.setItem(key as string, JSON.stringify([a]));
      window.dispatchEvent(new Event(evt as string));
    }, [BOOKMARKS_KEY, BOOKMARKS_EVENT, keepBookmark]);

    await expect.poll(() => !!server.row("bookmarks", "e2e-bm-delete")?.deletedAt, { timeout: 10_000 }).toBe(true);
    expect(server.live("bookmarks").map(r => r.docId)).toEqual(["e2e-bm-keep"]);

    // Device B: first load — its startup pull merges server state (live docs +
    // tombstones) into its own (empty) local store. Asserted via a real store
    // read: the actual persisted localStorage content after mergeServer runs,
    // not a mock — same contract loadBookmarks() reads from.
    const ctxB = await browser.newContext();
    await seedFakeSession(ctxB, "device-b");
    const pageB = await ctxB.newPage();
    await setupDevice(pageB, server);
    await gotoSettings(pageB);
    await expect(weeklySummaryToggle(pageB)).toBeVisible({ timeout: 15_000 }); // proves the sync engine mounted + settled

    await expect.poll(async () => {
      const raw = await pageB.evaluate((key) => localStorage.getItem(key as string), BOOKMARKS_KEY);
      const list = raw ? (JSON.parse(raw) as Array<{ id: string }>) : [];
      return list.map(b => b.id).sort();
    }, { timeout: 15_000 }).toEqual(["e2e-bm-keep"]);

    await ctxA.close();
    await ctxB.close();
  });
});
