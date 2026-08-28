/**
 * Customer-visible account state (4 states) — mapping contract.
 * Run: npx tsx scripts/test-account-ui-state.ts
 *
 * Guards two invariants the PRD (§5/§6) makes load-bearing:
 *   1. Every internal signal maps to exactly the state the PRD table says.
 *   2. Any input produces EXACTLY ONE state — the "Connected + Limited Access +
 *      Could not sync boards" pile-up can never come back.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  accountUiState,
  missingRequiredPinterestScopes,
  ACCOUNT_UI_STATE_LABEL_KEY,
  ACCOUNT_UI_STATE_DESCRIPTION_KEY,
  ACCOUNT_UI_STATE_TONE,
  REQUIRED_PINTEREST_SCOPES_UI,
  type AccountUiState,
  type AccountUiStateInput,
} from "../src/lib/social/accountUiState";

export {};

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${(e as Error).message}`);
  }
}

const ALL_STATES: AccountUiState[] = ["connected", "needs_attention", "needs_reconnect", "disconnected"];
const FULL_SCOPES = ["user_accounts:read", "boards:read", "boards:write", "pins:read", "pins:write"];

console.log("\nAccount UI state (4 customer-visible states)\n");

// ── The PRD mapping table, row by row ────────────────────────────────────────

test("row 1 — pinterest needsReconnect=true → needs_reconnect", () => {
  assert.equal(
    accountUiState({
      connectionStatus: "connected",
      needsReconnect: true,
      scopes: FULL_SCOPES,
      enforcePinterestScopes: true,
    }),
    "needs_reconnect",
  );
});

test("row 2 — pinterest missing a required scope → needs_reconnect (a reconnect fixes it)", () => {
  assert.equal(
    accountUiState({
      connectionStatus: "connected",
      needsReconnect: false,
      scopes: ["boards:read", "pins:read"], // pins:write missing
      enforcePinterestScopes: true,
    }),
    "needs_reconnect",
  );
  // dba5753's exact shape: a connection that predates a scope requirement.
  assert.equal(
    accountUiState({
      connectionStatus: "connected",
      needsReconnect: false,
      scopes: [],
      enforcePinterestScopes: true,
    }),
    "needs_reconnect",
  );
});

test("row 3 — pinterest status fetch / sync failure → needs_attention", () => {
  assert.equal(
    accountUiState({
      connectionStatus: "connected",
      needsReconnect: false,
      scopes: FULL_SCOPES,
      enforcePinterestScopes: true,
      statusFetchFailed: true,
    }),
    "needs_attention",
  );
});

test("row 4 — pinterest connected with every required scope → connected", () => {
  assert.equal(
    accountUiState({
      connectionStatus: "connected",
      needsReconnect: false,
      scopes: FULL_SCOPES,
      enforcePinterestScopes: true,
    }),
    "connected",
  );
});

test("row 5 — pinterest disconnected_at set → disconnected", () => {
  assert.equal(
    accountUiState({
      connectionStatus: "connected",
      needsReconnect: false,
      scopes: FULL_SCOPES,
      enforcePinterestScopes: true,
      disconnectedAt: "2026-08-01T00:00:00Z",
    }),
    "disconnected",
  );
});

test("row 6 — social connected → connected", () => {
  assert.equal(accountUiState({ connectionStatus: "connected" }), "connected");
});

test("row 7 — social expired → needs_reconnect", () => {
  assert.equal(accountUiState({ connectionStatus: "expired" }), "needs_reconnect");
});

test("row 8 — social revoked → disconnected", () => {
  assert.equal(accountUiState({ connectionStatus: "revoked" }), "disconnected");
});

test("row 9 — social error → needs_attention", () => {
  assert.equal(accountUiState({ connectionStatus: "error" }), "needs_attention");
});

test("row 10 — not_connected is a platform slot, not an account; account-level it reads disconnected", () => {
  // The platform grid renders its own "Not connected" + Connect affordance; the
  // four account states never include it. If a caller does pass it, the honest
  // account-level statement is "this record is not currently connected".
  assert.equal(accountUiState({ connectionStatus: "not_connected" }), "disconnected");
  assert.ok(!ALL_STATES.includes("not_connected" as AccountUiState));
});

// ── One state at a time (PRD §6) ─────────────────────────────────────────────

test("any input produces exactly one state (never a combination)", () => {
  const statuses: Array<AccountUiStateInput["connectionStatus"]> = [
    "connected", "not_connected", "expired", "revoked", "error", null, undefined,
  ];
  const scopeSets: Array<readonly string[] | null> = [FULL_SCOPES, ["boards:read"], [], null];
  let checked = 0;
  for (const connectionStatus of statuses) {
    for (const needsReconnect of [true, false, null]) {
      for (const scopes of scopeSets) {
        for (const enforcePinterestScopes of [true, false]) {
          for (const statusFetchFailed of [true, false]) {
            for (const disconnectedAt of ["2026-08-01T00:00:00Z", null]) {
              const state = accountUiState({
                connectionStatus,
                needsReconnect,
                scopes,
                enforcePinterestScopes,
                statusFetchFailed,
                disconnectedAt,
              });
              assert.ok(ALL_STATES.includes(state), `unknown state ${state}`);
              // Exactly one match in the state list — a string return type can't be
              // two things, so this asserts the enum itself has no duplicates and
              // the function never returns something off-list.
              assert.equal(ALL_STATES.filter(s => s === state).length, 1);
              checked++;
            }
          }
        }
      }
    }
  }
  assert.ok(checked >= 600, `expected a broad sweep, only checked ${checked}`);
});

test("needs_reconnect outranks needs_attention, disconnected and connected", () => {
  // Every lower-priority signal on at once — reconnect still wins.
  assert.equal(
    accountUiState({
      connectionStatus: "error",
      needsReconnect: true,
      scopes: [],
      enforcePinterestScopes: true,
      statusFetchFailed: true,
      disconnectedAt: "2026-08-01T00:00:00Z",
    }),
    "needs_reconnect",
  );
});

test("needs_attention outranks disconnected", () => {
  assert.equal(
    accountUiState({
      connectionStatus: "error",
      disconnectedAt: "2026-08-01T00:00:00Z",
    }),
    "needs_attention",
  );
});

test("a revoked/disconnected record is never re-labelled needs_reconnect by a scope gap", () => {
  // A removed connection has no scopes; that must read as disconnected, not as
  // "you're missing permissions".
  assert.equal(
    accountUiState({ connectionStatus: "revoked", scopes: [], enforcePinterestScopes: true }),
    "disconnected",
  );
  assert.equal(
    accountUiState({
      connectionStatus: "connected",
      scopes: [],
      enforcePinterestScopes: true,
      disconnectedAt: "2026-08-01T00:00:00Z",
    }),
    "disconnected",
  );
});

test("scope enforcement is Pinterest-only (other platforms keep their own status)", () => {
  assert.equal(
    accountUiState({ connectionStatus: "connected", scopes: [], enforcePinterestScopes: false }),
    "connected",
  );
});

// ── Required-scope list must not drift from the server's ─────────────────────

test("REQUIRED_PINTEREST_SCOPES_UI matches the server's PINTEREST_REQUIRED_SCOPES", () => {
  const serverConfig = readFileSync(
    join(process.cwd(), "src/lib/server/pinterest/config.ts"),
    "utf8",
  );
  const block = serverConfig.match(/PINTEREST_REQUIRED_SCOPES\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(block, "PINTEREST_REQUIRED_SCOPES not found in server config");
  const serverScopes = [...block[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(
    [...REQUIRED_PINTEREST_SCOPES_UI].sort(),
    serverScopes.sort(),
    "client-side required scopes drifted from the server's",
  );
});

test("missingRequiredPinterestScopes reports precisely what is absent", () => {
  assert.deepEqual(missingRequiredPinterestScopes(FULL_SCOPES), []);
  assert.deepEqual(missingRequiredPinterestScopes(["boards:read", "pins:read"]), [
    "boards:write",
    "pins:write",
  ]);
  // boards:write belongs to the floor: POST /pins 401s without it, so a connection
  // holding everything else still cannot publish and must say needs_reconnect.
  assert.deepEqual(
    missingRequiredPinterestScopes(["boards:read", "pins:read", "pins:write"]),
    ["boards:write"],
  );
  assert.deepEqual(missingRequiredPinterestScopes(null), [
    "boards:read",
    "boards:write",
    "pins:read",
    "pins:write",
  ]);
});

// ── Presentation tables stay complete ────────────────────────────────────────

test("every state has a label key, a description key and a tone", () => {
  for (const state of ALL_STATES) {
    assert.ok(ACCOUNT_UI_STATE_LABEL_KEY[state], `missing label key for ${state}`);
    assert.ok(ACCOUNT_UI_STATE_DESCRIPTION_KEY[state], `missing description key for ${state}`);
    assert.ok(ACCOUNT_UI_STATE_TONE[state], `missing tone for ${state}`);
  }
  assert.equal(ACCOUNT_UI_STATE_TONE.connected, "green");
  assert.equal(ACCOUNT_UI_STATE_TONE.needs_attention, "amber");
  assert.equal(ACCOUNT_UI_STATE_TONE.needs_reconnect, "amber");
  assert.equal(ACCOUNT_UI_STATE_TONE.disconnected, "grey");
});

test("the English catalog carries every label and description key", async () => {
  const { en } = await import("../src/lib/i18n/messages");
  const catalog = en as Record<string, string>;
  for (const state of ALL_STATES) {
    const labelKey = ACCOUNT_UI_STATE_LABEL_KEY[state];
    const descKey = ACCOUNT_UI_STATE_DESCRIPTION_KEY[state];
    assert.ok(catalog[labelKey]?.trim(), `en catalog missing ${labelKey}`);
    assert.ok(catalog[descKey]?.trim(), `en catalog missing ${descKey}`);
  }
  // PRD §5.3 copy is quoted verbatim in the spec — keep it byte-exact.
  assert.equal(
    catalog[ACCOUNT_UI_STATE_DESCRIPTION_KEY.needs_reconnect],
    "Reconnect this account to continue publishing. Your drafts and scheduled content will stay safe.",
  );
  assert.equal(catalog[ACCOUNT_UI_STATE_LABEL_KEY.connected], "Connected");
  assert.equal(catalog[ACCOUNT_UI_STATE_LABEL_KEY.needs_attention], "Needs attention");
  assert.equal(catalog[ACCOUNT_UI_STATE_LABEL_KEY.needs_reconnect], "Needs reconnect");
  assert.equal(catalog[ACCOUNT_UI_STATE_LABEL_KEY.disconnected], "Disconnected");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
