/**
 * Pinterest integrations + Settings IA tests.
 * Run: npx tsx scripts/test-pinterest-integrations-repair.ts
 *
 * Rewritten for the Phase A information architecture (PRD §2): Pinterest is one
 * platform inside Social accounts, not its own Settings section. The assertions
 * that used to pin the dedicated Pinterest tab/panel in place now pin the
 * opposite — that it is gone and every entry point lands on Social accounts —
 * while the transport-level guarantees (OAuth return, token safety, error
 * mapping) are unchanged and still asserted.
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
const panelSource = readFileSync(join(root, "src/components/social/SocialAccountsPanel.tsx"), "utf8");
const connectRoute = readFileSync(join(root, "src/app/api/auth/pinterest/connect/route.ts"), "utf8");
const callbackRoute = readFileSync(join(root, "src/app/api/auth/pinterest/callback/route.ts"), "utf8");
const dialogSource = readFileSync(join(root, "src/components/plan/DraftDetailsDrawer.tsx"), "utf8");
// Phase 2: board controls extracted into PinBoardSection
const boardSectionSource = readFileSync(join(root, "src/components/pin-details/PinBoardSection.tsx"), "utf8");
const legacySettings = readFileSync(join(root, "src/app/settings/page.tsx"), "utf8");
const pathsSource = readFileSync(join(root, "src/lib/pinterestPaths.ts"), "utf8");

async function main() {
  console.log("\nPinterest integrations + Settings IA tests\n");

  await test("sidebar Settings defaults to Social accounts", () => {
    assert(layoutSource.includes("SETTINGS_DEFAULT_PATH"), "settings default path import missing");
    assert(settingsPaths.includes("SETTINGS_DEFAULT_PATH = SETTINGS_SOCIAL_PATH"), "default settings path must be Social accounts");
  });

  await test("account dropdown opens settings modal tabs", () => {
    // Modal-based architecture: the dropdown opens SettingsModal on specific tabs.
    assert(layoutSource.includes("account-menu-trigger"), "account menu trigger testid missing");
    assert(layoutSource.includes("account-menu-account"), "account tab testid missing in layout");
    assert(layoutSource.includes("account-menu-billing"), "billing tab testid missing in layout");
    assert(layoutSource.includes("account-menu-social"), "social tab testid missing in layout");
    assert(!layoutSource.includes("account-menu-pinterest"), "retired Pinterest dropdown entry remains");
    assert(layoutSource.includes("/app/settings/support"), "support path missing in layout");
    assert(layoutSource.includes("SettingsModal"), "SettingsModal missing from layout");
    assert(!layoutSource.includes('navigate("/settings")'), "legacy /settings dropdown link remains");
  });

  await test("Settings index shows modal via AppLayout route detection", () => {
    // Settings pages return null; AppLayout detects /app/settings* and opens the modal.
    assert(layoutSource.includes("/app/settings/billing"), "billing path detection missing in layout");
    assert(layoutSource.includes("/app/settings/social"), "social path detection missing in layout");
    assert(layoutSource.includes("setSettingsOpen"), "modal open state missing in layout");
  });

  await test("legacy integrations route redirects to a live section (never to the retired Pinterest tab)", () => {
    assert(integrationsPage.includes("SETTINGS_SOCIAL_PATH"), "integrations redirect missing");
    assert(!integrationsPage.includes("SETTINGS_PINTEREST_PATH"), "integrations must not redirect to the retired route");
    assert(!integrationsPage.includes("SettingsSubNav"), "old subnav should be removed");
  });

  await test("SettingsModal no longer carries a Pinterest tab or panel", () => {
    const modalSource = readFileSync(join(root, "src/components/settings/SettingsModal.tsx"), "utf8");
    assert(!modalSource.includes("PinterestSettingsPanel"), "retired PinterestSettingsPanel still imported by SettingsModal");
    assert(!modalSource.includes("settings-tab-pinterest"), "retired pinterest tab testid still in the modal");
    assert(modalSource.includes("settings-tab-social"), "social tab testid missing from the modal");
  });

  await test("Settings local nav has six sections (Social accounts in place of Pinterest)", () => {
    assert(settingsPaths.includes('"Profile"'), "profile nav missing");
    assert(settingsPaths.includes("Billing & Credits"), "billing nav missing");
    assert(settingsPaths.includes("Social accounts"), "social nav missing");
    assert(!settingsPaths.includes('label: "Pinterest"'), "retired Pinterest nav entry remains");
    assert(settingsPaths.includes("Language & Region"), "language nav missing");
    assert(settingsPaths.includes('"Workspace"'), "workspace nav missing");
    assert(settingsPaths.includes('"Support"'), "support nav missing");
  });

  await test("Social accounts panel owns Pinterest connect/reconnect/disconnect", () => {
    assert(panelSource.includes("social-connect-"), "connect CTA missing");
    assert(panelSource.includes("social-reconnect-"), "reconnect CTA missing");
    assert(panelSource.includes("social-disconnect-"), "disconnect CTA missing");
    assert(panelSource.includes("startPinterestConnect"), "Pinterest connect handler missing");
    // Board sync is intentionally NOT a user-facing action — boards load automatically
    // wherever they're needed (e.g. the publish drawer).
    assert(!panelSource.includes("Sync boards"), "board sync must not be a user-facing action in the panel");
  });

  await test("legacy Pinterest settings route survives as a redirect (no 404 for old bookmarks)", () => {
    assert(pinterestPage.includes("redirect("), "legacy pinterest route must redirect");
    assert(pinterestPage.includes("SETTINGS_SOCIAL_PATH"), "legacy pinterest route must target Social accounts");
    // The OAuth `?pinterest=<status>` query must survive the hop or the returning
    // user silently loses the outcome of their authorization.
    assert(/searchParams/.test(pinterestPage), "legacy route must forward the OAuth query");
  });

  await test("OAuth connect uses the Social accounts post-login destination", () => {
    assert(connectRoute.includes("PINTEREST_INTEGRATIONS_PATH"), "integrations path constant missing");
    assert(connectRoute.includes("sanitizeReturnTo"), "safe return path sanitizer missing");
    assert(!connectRoute.includes('pathname = "/settings"'), "legacy /settings redirect remains");
  });

  await test("OAuth callback redirects to Pinterest settings route", () => {
    assert(callbackRoute.includes("PINTEREST_INTEGRATIONS_PATH"), "callback pinterest path missing");
    assert(callbackRoute.includes('searchParams.set("pinterest", status)'), "callback status param missing");
  });

  await test("legacy settings links to Social accounts", () => {
    assert(!legacySettings.includes("PinterestIntegrationCard"), "duplicate card on legacy page");
    assert(legacySettings.includes("SETTINGS_SOCIAL_PATH"), "legacy page should link to Social accounts");
  });

  await test("Shared Pin Details modal distinguishes board states", () => {
    assert(!dialogSource.includes("No boards available"), "misleading empty-board placeholder remains");
    // draft-board-field extracted to PinBoardSection (Phase 2) — still rendered by the modal
    assert(boardSectionSource.includes("draft-board-field"), "disconnected board field missing from PinBoardSection");
  });

  await test("pinterest OAuth path constant points at Social accounts", () => {
    assert(pathsSource.includes("SETTINGS_SOCIAL_PATH"), "path should alias Social accounts");
    assert(!pathsSource.includes("SETTINGS_PINTEREST_PATH"), "path must not alias the retired Pinterest route");
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
      created_at: "", updated_at: "2026-06-22T10:30:00Z", disconnected_at: null, token_version: 0,
    });
    const json = JSON.stringify(safe);
    assert(!json.includes("secret"), "token leaked in status");
    assert(safe.needsReconnect === true, "old/missing scopes should request reconnect");
    assert(safe.lastSyncedAt === "2026-06-22T10:30:00Z", "lastSyncedAt missing");
  });

  await test("a missing Pinterest scope resolves to needs_reconnect (not a dead-end 'limited' state)", async () => {
    const { accountUiState } = await import("../src/lib/social/accountUiState");
    assert(
      accountUiState({
        connectionStatus: "connected",
        enforcePinterestScopes: true,
        scopes: ["boards:read"],
      }) === "needs_reconnect",
      "boards-only should ask for a reconnect",
    );
    assert(
      accountUiState({ connectionStatus: "not_connected" }) === "disconnected",
      "an account record with no live connection is disconnected",
    );
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
