/**
 * Pinterest integrations + Settings IA tests.
 * Run: npx tsx scripts/test-pinterest-integrations-repair.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.PINTEREST_TOKEN_ENC_KEY = "dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXk=";
process.env.PINTEREST_APP_ID = "test-app-id";
process.env.PINTEREST_APP_SECRET = "test-app-secret";
process.env.PINTEREST_REDIRECT_URI = "http://localhost:3000/api/auth/pinterest/callback";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

export {};

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${(e as Error).message}`);
  }
}

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const root = process.cwd();
const layoutSource = readFileSync(join(root, "src/app/app/layout.tsx"), "utf8");
const integrationsPage = readFileSync(join(root, "src/app/app/settings/integrations/page.tsx"), "utf8");
const pinterestPage = readFileSync(join(root, "src/app/app/settings/pinterest/page.tsx"), "utf8");
const settingsIndex = readFileSync(join(root, "src/app/app/settings/page.tsx"), "utf8");
const settingsPaths = readFileSync(join(root, "src/lib/settingsPaths.ts"), "utf8");
const settingsLayout = readFileSync(join(root, "src/components/settings/SettingsLayout.tsx"), "utf8");
const panelSource = readFileSync(join(root, "src/components/pinterest/PinterestSettingsPanel.tsx"), "utf8");
const connectRoute = readFileSync(join(root, "src/app/api/auth/pinterest/connect/route.ts"), "utf8");
const callbackRoute = readFileSync(join(root, "src/app/api/auth/pinterest/callback/route.ts"), "utf8");
const dialogSource = readFileSync(join(root, "src/components/plan/DraftDetailsDrawer.tsx"), "utf8");
// Phase 2: board controls extracted into PinBoardSection
const boardSectionSource = readFileSync(join(root, "src/components/pin-details/PinBoardSection.tsx"), "utf8");
const legacySettings = readFileSync(join(root, "src/app/settings/page.tsx"), "utf8");
const pathsSource = readFileSync(join(root, "src/lib/pinterestPaths.ts"), "utf8");

async function main() {
  console.log("\nPinterest integrations + Settings IA tests\n");

  await test("sidebar Settings defaults to Pinterest settings", () => {
    assert(layoutSource.includes("SETTINGS_DEFAULT_PATH"), "settings default path import missing");
    assert(settingsPaths.includes('"/app/settings/pinterest"'), "pinterest path missing");
  });

  await test("account dropdown opens settings modal tabs", () => {
    // New modal-based architecture: dropdown opens SettingsModal on specific tabs
    assert(layoutSource.includes("account-menu-trigger"), "account menu trigger testid missing");
    assert(layoutSource.includes("account-menu-account"), "account tab testid missing in layout");
    assert(layoutSource.includes("account-menu-billing"), "billing tab testid missing in layout");
    assert(layoutSource.includes("account-menu-pinterest"), "pinterest tab testid missing in layout");
    assert(layoutSource.includes("SETTINGS_SUPPORT_PATH"), "support path missing in layout");
    assert(layoutSource.includes("SettingsModal"), "SettingsModal missing from layout");
    assert(!layoutSource.includes('navigate("/settings")'), "legacy /settings dropdown link remains");
  });

  await test("Settings index shows modal via AppLayout route detection", () => {
    // New: settings pages return null; AppLayout detects /app/settings* and opens modal
    assert(layoutSource.includes("/app/settings/billing"), "billing path detection missing in layout");
    assert(layoutSource.includes("/app/settings/pinterest"), "pinterest path detection missing in layout");
    assert(layoutSource.includes("setSettingsOpen"), "modal open state missing in layout");
  });

  await test("legacy integrations route redirects to Pinterest", () => {
    assert(integrationsPage.includes("SETTINGS_PINTEREST_PATH"), "integrations redirect missing");
    assert(!integrationsPage.includes("SettingsSubNav"), "old subnav should be removed");
  });

  await test("Pinterest settings panel is embedded in SettingsModal", () => {
    // New: PinterestSettingsPanel lives inside SettingsModal (not in the route page)
    const modalSource = readFileSync(join(root, "src/components/settings/SettingsModal.tsx"), "utf8");
    assert(modalSource.includes("PinterestSettingsPanel"), "PinterestSettingsPanel missing from SettingsModal");
    assert(modalSource.includes("settings-tab-pinterest"), "pinterest tab testid missing from modal");
    assert(panelSource.includes("pinterest-state-connected"), "connected state missing from panel");
  });

  await test("Settings local nav has six sections", () => {
    assert(settingsPaths.includes('"Profile"'), "profile nav missing");
    assert(settingsPaths.includes("Billing & Credits"), "billing nav missing");
    assert(settingsPaths.includes('"Pinterest"'), "pinterest nav missing");
    assert(settingsPaths.includes("Language & Region"), "language nav missing");
    assert(settingsPaths.includes('"Workspace"'), "workspace nav missing");
    assert(settingsPaths.includes('"Support"'), "support nav missing");
  });

  await test("Pinterest panel implements three visual states", () => {
    assert(panelSource.includes("pinterest-state-not-connected"), "not connected state missing");
    assert(panelSource.includes("pinterest-state-connected"), "connected state missing");
    assert(panelSource.includes("pinterest-state-limited-access"), "limited access state missing");
    assert(panelSource.includes("Connect Pinterest"), "connect CTA missing");
    // Board sync is intentionally NOT a user-facing action here — boards load
    // automatically wherever they're needed (e.g. the publish drawer), so the panel
    // must not resurrect a manual "Sync boards" button.
    assert(!panelSource.includes("Sync boards"), "board sync must not be a user-facing action in the panel");
  });

  await test("OAuth connect uses Pinterest settings post-login destination", () => {
    assert(connectRoute.includes("PINTEREST_INTEGRATIONS_PATH"), "integrations path constant missing");
    assert(connectRoute.includes("sanitizeReturnTo"), "safe return path sanitizer missing");
    assert(!connectRoute.includes('pathname = "/settings"'), "legacy /settings redirect remains");
  });

  await test("OAuth callback redirects to Pinterest settings route", () => {
    assert(callbackRoute.includes("PINTEREST_INTEGRATIONS_PATH"), "callback pinterest path missing");
    assert(callbackRoute.includes('searchParams.set("pinterest", status)'), "callback status param missing");
  });

  await test("legacy settings links to Pinterest settings", () => {
    assert(!legacySettings.includes("PinterestIntegrationCard"), "duplicate card on legacy page");
    assert(legacySettings.includes("/app/settings/pinterest"), "legacy page should link to pinterest");
  });

  await test("Shared Pin Details modal distinguishes board states", () => {
    assert(!dialogSource.includes("No boards available"), "misleading empty-board placeholder remains");
    // draft-board-field extracted to PinBoardSection (Phase 2) — still rendered by the modal
    assert(boardSectionSource.includes("draft-board-field"), "disconnected board field missing from PinBoardSection");
  });

  await test("pinterest path constant points to /app/settings/pinterest", () => {
    assert(pathsSource.includes("SETTINGS_PINTEREST_PATH"), "path should alias settings pinterest");
  });

  await test("routeHelpers maps database errors to database_error code", async () => {
    const routeHelpers = await import("../src/lib/server/pinterest/routeHelpers");
    const { DatabaseError } = await import("../src/lib/server/pinterest/errors");
    const res = routeHelpers.pinterestErrorResponse(new DatabaseError());
    assert(res.status === 503, `expected 503, got ${res.status}`);
    const body = await res.json();
    assert(body.code === "database_error", "code not database_error");
  });

  await test("toSafeStatus never includes tokens", async () => {
    const connectionStore = await import("../src/lib/server/pinterest/connectionStore");
    const safe = connectionStore.toSafeStatus({
      id: "1", vibepin_user_id: "u", provider: "pinterest",
      pinterest_user_id: "p", pinterest_username: "u", pinterest_account_type: null,
      access_token_encrypted: "v1:secret", refresh_token_encrypted: "v1:secret",
      access_token_expires_at: null, refresh_token_expires_at: null,
      scopes: [], needs_reconnect: false,
      created_at: "", updated_at: "2026-06-22T10:30:00Z", disconnected_at: null,
    });
    const json = JSON.stringify(safe);
    assert(!json.includes("secret"), "token leaked in status");
    assert(safe.needsReconnect === true, "old/missing scopes should request reconnect");
    assert(safe.lastSyncedAt === "2026-06-22T10:30:00Z", "lastSyncedAt missing");
  });

  await test("derivePinterestSettingsState maps limited publish access", async () => {
    const { derivePinterestSettingsState } = await import("../src/lib/pinterest/pinterestSettingsState");
    assert(
      derivePinterestSettingsState({
        connected: true,
        account: { id: "1", username: "demo", accountType: null },
        scopes: ["boards:read"],
        needsReconnect: false,
      }) === "limited_access",
      "boards-only should be limited_access",
    );
    assert(
      derivePinterestSettingsState({
        connected: false,
        account: null,
        scopes: [],
        needsReconnect: false,
      }) === "not_connected",
      "disconnected should be not_connected",
    );
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
