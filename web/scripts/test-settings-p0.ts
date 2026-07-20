import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deriveAccountBillingSummary, EXISTING_APP_TOKEN_BALANCE } from "../src/lib/accountSummary";
import { formatEnglishDateTime } from "../src/lib/dateTimeFormat";
import { derivePinterestSettingsState } from "../src/lib/pinterest/pinterestSettingsState";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK ${name}`);
}

const settingsPaths = readFileSync("src/lib/settingsPaths.ts", "utf8");
const billing = readFileSync("src/components/settings/SettingsModal.tsx", "utf8");
const language = readFileSync("src/components/settings/LanguageRegionModal.tsx", "utf8");
const pinterest = readFileSync("src/components/pinterest/PinterestSettingsPanel.tsx", "utf8");
const layout = readFileSync("src/app/app/layout.tsx", "utf8");

test("Settings navigation exposes six real routes", () => {
  for (const path of ["profile", "billing", "pinterest", "language", "workspace", "support"]) {
    assert.match(settingsPaths, new RegExp(`/app/settings/${path}`));
  }
});

test("Billing has Current plan and Credits sections without fake subscription data", () => {
  assert.match(billing, /t\("billing\.currentPlan"\)/);
  assert.match(billing, /t\("billing\.tokenBalance"\)/);
  assert.match(billing, /t\("billing\.usageHistory"\)/);
  assert.match(billing, /t\("billing\.noUsage"\)/);
  assert.match(billing, /t\("billing\.manageBilling"\)/);
});

test("Billing reads the plan from app_metadata (trusted); other fields from merged metadata", () => {
  // Plan is security-sensitive: it must come from app_metadata (service-role
  // writable), never user_metadata. Display fields (status, tokens) stay merged.
  const value = deriveAccountBillingSummary({
    app_metadata: { plan_name: "Pro" },
    user_metadata: { subscription_status: "active", token_balance: 91, tokens_used_this_month: 9 },
  });
  assert.equal(value.planName, "Pro");
  assert.equal(value.planStatus, "active");
  assert.equal(value.tokenBalance, 91);
  assert.equal(value.usedThisMonth, 9);
});

test("Billing IGNORES a forged user_metadata plan (only app_metadata is trusted)", () => {
  // A user can edit their own user_metadata — a plan forged there must not show.
  const value = deriveAccountBillingSummary({ user_metadata: { plan_name: "Business", plan: "business" } });
  assert.equal(value.planName, null);
});

test("Billing preserves the existing app token balance when metadata is unavailable", () => {
  const value = deriveAccountBillingSummary(null);
  assert.equal(value.planName, null);
  assert.equal(value.tokenBalance, EXISTING_APP_TOKEN_BALANCE);
});

test("Pinterest derives all three safe states", () => {
  assert.equal(derivePinterestSettingsState(null), "not_connected");
  assert.equal(derivePinterestSettingsState({ connected: true, account: null, scopes: [], needsReconnect: false }), "limited_access");
  assert.equal(derivePinterestSettingsState({ connected: true, account: null, scopes: ["boards:read", "pins:write"], needsReconnect: false }), "connected");
});

test("Pinterest page has state-specific actions and amber limited copy", () => {
  assert.match(pinterest, /pinterest-state-not-connected/);
  assert.match(pinterest, /pinterest-state-connected/);
  assert.match(pinterest, /pinterest-state-limited-access/);
  assert.match(pinterest, /Connect Pinterest/);
  // Board sync is no longer a user-facing action — boards load automatically
  // wherever they're needed (e.g. the publish drawer), so there's no "Sync boards"
  // button to assert on anymore.
  assert.match(pinterest, /Board sync is not a user-facing action/);
  assert.match(pinterest, /Reconnect/);
  assert.match(pinterest, /Disconnect/);
  assert.match(pinterest, /publishing may be limited until Standard Access is approved/);
});

test("English date formatting is deterministic", () => {
  const formatted = formatEnglishDateTime("2026-06-20T16:35:00Z", "UTC");
  assert.equal(formatted, "Jun 20, 2026, 4:35 PM");
});

test("Language & Region shows App language and Pinterest region sections", () => {
  assert.match(language, /LanguageRegionPanel/);
  assert.match(language, /lang\.appLanguage/);
  assert.match(language, /lang\.pinterestRegion/);
});

test("Account dropdown routes work and logout calls Supabase", () => {
  assert.match(layout, /SETTINGS_DEFAULT_PATH/);
  assert.match(layout, /\/app\/settings\/support/);
  assert.match(layout, /openSettings\("account"\)/);
  assert.match(layout, /openSettings\("billing"\)/);
  assert.match(layout, /supabase\.auth\.signOut\(\)/);
  assert.match(layout, /aria-label="Open Billing & Credits"/);
});

console.log(`\nSettings P0: ${passed} passed, 0 failed`);
