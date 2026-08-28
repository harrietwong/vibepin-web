import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deriveAccountBillingSummary } from "../src/lib/accountSummary";
import * as accountSummaryModule from "../src/lib/accountSummary";
import { formatEnglishDateTime } from "../src/lib/dateTimeFormat";
import { accountUiState } from "../src/lib/social/accountUiState";
import { socialPanelMessages } from "../src/lib/i18n/messages/en/socialPanel";
import zhCN from "../src/lib/i18n/messages/zh-CN";
import zhTW from "../src/lib/i18n/messages/zh-TW";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK ${name}`);
}

const settingsPaths = readFileSync("src/lib/settingsPaths.ts", "utf8");
const billing = readFileSync("src/components/settings/SettingsModal.tsx", "utf8");
const language = readFileSync("src/components/settings/LanguageRegionModal.tsx", "utf8");
const social = readFileSync("src/components/social/SocialAccountsPanel.tsx", "utf8");
const layout = readFileSync("src/app/app/layout.tsx", "utf8");

test("Settings navigation exposes six real routes", () => {
  // Pinterest is no longer a section — Social accounts owns it (PRD §2).
  for (const path of ["profile", "billing", "social", "language", "workspace", "support"]) {
    assert.match(settingsPaths, new RegExp(`/app/settings/${path}`));
  }
  assert.doesNotMatch(settingsPaths, /id: "pinterest"/);
});

test("Billing has Current plan and the three-quota usage section without fake subscription data", () => {
  assert.match(billing, /t\("billing\.currentPlan"\)/);
  // The old "Token balance" card was replaced by three independent quota meters
  // (adapted from acb6810 onto the v55/v56 ledger). No aggregated token number
  // may reappear — that was the fake-34 lesson.
  assert.doesNotMatch(billing, /t\("billing\.tokenBalance"\)/);
  assert.match(billing, /t\("billing\.usageAiImages"\)/);
  assert.match(billing, /t\("billing\.usageAiText"\)/);
  assert.match(billing, /t\("billing\.usageScheduledPosts"\)/);
  assert.match(billing, /t\("billing\.noUsage"\)/);
  assert.match(billing, /t\("billing\.manageBilling"\)/);
  // The old fabricated token-balance card/keys must be gone.
  assert.doesNotMatch(billing, /billing\.tokenBalance/);
  assert.doesNotMatch(billing, /EXISTING_APP_TOKEN_BALANCE/);
});

test("Billing shows an explicit sync-error state and never falls back to Free on fetch failure", () => {
  assert.match(billing, /t\("billing\.usageSyncError"\)/);
  assert.match(billing, /t\("billing\.usageSyncErrorDesc"\)/);
  assert.match(billing, /setBillingSyncError\(true\)/);
  assert.match(billing, /setUsageSyncError\(true\)/);
  assert.match(billing, /\/api\/billing\/usage/);
});

test("Billing reads the plan from app_metadata (trusted); other fields from merged metadata", () => {
  // Plan is security-sensitive: it must come from app_metadata (service-role
  // writable), never user_metadata. Display fields (status) stay merged.
  const value = deriveAccountBillingSummary({
    app_metadata: { plan_name: "Pro" },
    user_metadata: { subscription_status: "active" },
  });
  assert.equal(value.planName, "Pro");
  assert.equal(value.planStatus, "active");
});

test("Billing IGNORES a forged user_metadata plan (only app_metadata is trusted)", () => {
  // A user can edit their own user_metadata — a plan forged there must not show.
  const value = deriveAccountBillingSummary({ user_metadata: { plan_name: "Business", plan: "business" } });
  assert.equal(value.planName, null);
});

test("Billing shows NO fabricated token balance when metadata is unavailable", () => {
  // The old fake-34 constant is gone: with no real metered value, tokenBalance
  // must be null (an honest "unavailable" state), never a placeholder number.
  const value = deriveAccountBillingSummary(null);
  assert.equal(value.planName, null);
  assert.equal("tokenBalance" in value, false, "tokenBalance must not be derived from metadata anymore");
});

test("The fabricated EXISTING_APP_TOKEN_BALANCE export no longer exists", () => {
  assert.equal(
    "EXISTING_APP_TOKEN_BALANCE" in accountSummaryModule,
    false,
    "EXISTING_APP_TOKEN_BALANCE must be deleted so no fake balance can reach the UI",
  );
});

test("Billing card never renders a metadata-derived balance number", () => {
  assert.doesNotMatch(billing, /summary\.tokenBalance/);
});

test("The app chrome no longer renders a fabricated token balance", () => {
  assert.doesNotMatch(layout, /EXISTING_APP_TOKEN_BALANCE/);
});


test("Pinterest account state comes from the unified 4-state map", () => {
  // The old 3-state Pinterest-only vocabulary is gone (PRD §5): every provider,
  // Pinterest included, resolves through accountUiState.
  assert.equal(accountUiState({ connectionStatus: "connected" }), "connected");
  assert.equal(
    accountUiState({
      connectionStatus: "connected",
      enforcePinterestScopes: true,
      scopes: ["boards:read"],
    }),
    "needs_reconnect",
  );
  assert.equal(accountUiState({ connectionStatus: "connected", statusFetchFailed: true }), "needs_attention");
  assert.equal(accountUiState({ connectionStatus: "revoked" }), "disconnected");
});

test("Social accounts panel drives Pinterest state + actions (no dedicated Pinterest section)", () => {
  assert.match(social, /accountUiState/);
  assert.match(social, /social-account-state-/);
  assert.match(social, /social-connect-/);
  // Reconnect and Disconnect moved from the platform card to the ACCOUNT ROW
  // (PRD 0809 §II): with two accounts connected, a platform-level "Disconnect
  // Pinterest" could not say which one it meant — and in fact disconnected both.
  // The CTAs still exist, keyed by connection id instead of by provider.
  assert.match(social, /social-account-\$\{action\}-\$\{account\.id\}/);
  assert.match(social, /accountRowActions\(state\)/);
  assert.doesNotMatch(social, /social-disconnect-\$\{summary\.provider\}/);
  // The retired panel's internal access-tier wording must not reappear customer-side.
  assert.doesNotMatch(social, /Standard Access/);
  assert.doesNotMatch(social, /limited_access/);
});

test("Extra-slot CTA quotes the interval the buyer will actually be billed on", () => {
  // Decision A. Slots follow the plan's billing interval, so the button cannot
  // hardcode one price: a yearly subscriber shown "$7 / month" is quoted a price
  // they will never pay. The client also must not CHOOSE the interval -- the server
  // derives it -- so the checkout call takes no interval argument any more.
  assert.match(social, /socialPanel\.limit\.addSlotMonthly/);
  assert.match(social, /socialPanel\.limit\.addSlotYearly/);
  assert.match(social, /planInterval === "year"/);
  assert.match(social, /EXTRA_ACCOUNT_PRICE_USD\.yearlyPerMonth/);
  assert.match(social, /startExtraAccountCheckout\(1\)/);
  assert.doesNotMatch(social, /startExtraAccountCheckout\(1,/);
  // The old single-price composition must be gone, or the yearly buyer keeps
  // seeing the monthly number next to it.
  assert.doesNotMatch(social, /tr\("socialPanel\.limit\.addSlot"\)/);
  for (const key of ["socialPanel.limit.addSlotMonthly", "socialPanel.limit.addSlotYearly"]) {
    assert.ok(socialPanelMessages[key as keyof typeof socialPanelMessages], `en missing ${key}`);
    assert.ok((zhCN as Record<string, string>)[key], `zh-CN missing ${key}`);
    assert.ok((zhTW as Record<string, string>)[key], `zh-TW missing ${key}`);
    // Both variants must carry the price placeholder the panel substitutes.
    assert.match(socialPanelMessages[key as keyof typeof socialPanelMessages], /\{price\}/);
  }
});

test("?addon=success is consumed, stripped, and answered with a notice + one re-read", () => {
  // Decision B. Creem returns a slot buyer HERE, not to /welcome. The flag is read
  // and then removed from the URL exactly like every other OAuth-return flag, so a
  // refresh cannot re-fire the notice.
  assert.match(social, /params\.get\("addon"\) !== "success"/);
  assert.match(social, /setAddonPurchased\(true\)/);
  assert.match(social, /router\.replace\(SETTINGS_SOCIAL_PATH\)/);
  assert.match(social, /data-testid="social-addon-success"/);
  // The webhook that provisions the slot can land after the redirect: re-read once
  // more a few seconds later. ONE retry -- a polling loop would not make the webhook
  // arrive any sooner and would hammer the endpoint.
  assert.match(social, /setTimeout\(\(\) => \{ void load\(\); \}, 5000\)/);
  assert.doesNotMatch(social, /setInterval\(/);
  // And the retry must NOT be cleaned up. router.replace strips the query, which
  // re-runs this effect within milliseconds; React runs the previous pass's cleanup
  // first, so a clearTimeout here would cancel the re-fetch before it ever fired --
  // leaving a test that passes on the source text while the retry is dead.
  assert.doesNotMatch(social, /return \(\) => clearTimeout/);
  // The banner must retire itself on the SERVER's allowance, not on "we saw the
  // flag" -- the money is not what unblocks the connect, the provisioned slot is.
  assert.match(social, /allowance\.slotsAvailable > 0\) setAccountLimitReached\(false\)/);
  for (const key of ["socialPanel.addon.successTitle", "socialPanel.addon.successBody", "socialPanel.addon.dismiss"]) {
    assert.ok(socialPanelMessages[key as keyof typeof socialPanelMessages], `en missing ${key}`);
    assert.ok((zhCN as Record<string, string>)[key], `zh-CN missing ${key}`);
    assert.ok((zhTW as Record<string, string>)[key], `zh-TW missing ${key}`);
  }
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
});

test("Sidebar no longer shows a fabricated token count", () => {
  assert.doesNotMatch(layout, /EXISTING_APP_TOKEN_BALANCE/);
  assert.doesNotMatch(layout, /\d+ Tokens/);
});

console.log(`\nSettings P0: ${passed} passed, 0 failed`);
