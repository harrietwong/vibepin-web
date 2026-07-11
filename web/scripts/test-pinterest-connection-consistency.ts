/**
 * Pinterest connected-state consistency (P0 state-sync fix).
 *
 * Guards the invariant that Settings → Pinterest, Settings → Social accounts, and
 * Publish destinations all agree on ONE user-facing connection record:
 *
 *   - The OAuth callback persists the connection to the canonical shared source
 *     (pinterest_connections), which socialConnectionStore unifies into the social
 *     view — so there is exactly one user-facing "connected" record, no duplicate
 *     Pinterest row written into social_connections.
 *   - When the Pinterest-specific /api/pinterest/status read fails transiently, the
 *     Settings Pinterest panel cross-checks the SHARED social-connections source
 *     before dropping the user to "not connected" — so a status blip can never hide a
 *     live connection or surface "Could not refresh connection status" over a real one.
 *   - A sandbox token alone never renders as connected in Settings.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.PINTEREST_TOKEN_ENC_KEY = "dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXk=";
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
const callbackRoute = readFileSync(join(root, "src/app/api/auth/pinterest/callback/route.ts"), "utf8");
const socialStore = readFileSync(join(root, "src/lib/social/server/socialConnectionStore.ts"), "utf8");
const statusRoute = readFileSync(join(root, "src/app/api/pinterest/status/route.ts"), "utf8");
const panel = readFileSync(join(root, "src/components/pinterest/PinterestSettingsPanel.tsx"), "utf8");
const connectionStore = readFileSync(join(root, "src/lib/server/pinterest/connectionStore.ts"), "utf8");

async function main() {
  console.log("\nPinterest connected-state consistency\n");

  await test("OAuth callback persists the connection to the shared Pinterest source", () => {
    assert(callbackRoute.includes("upsertConnection"), "callback must upsert the connection on success");
    // Success path returns connected only AFTER a successful persist.
    assert(/persist_failed/.test(callbackRoute), "callback must fail closed if persistence fails");
  });

  await test("social-connections unifies Pinterest from its dedicated table (one record, no dup row)", () => {
    // Pinterest connected-state is read from pinterest_connections via getActiveConnection…
    assert(socialStore.includes("getActiveConnection"), "social store must read the Pinterest connection record");
    assert(/readPinterestConnection/.test(socialStore), "social store must map the Pinterest connection");
    // …and any pinterest row that might exist in social_connections is filtered out so
    // the two never double-count / disagree.
    assert(/provider !== "pinterest"/.test(socialStore), "social store must not double-count a pinterest row in social_connections");
  });

  await test("Settings Pinterest panel cross-checks the shared source when status fails", () => {
    assert(panel.includes("fetchSocialConnections"), "panel must import the shared social-connections reader");
    assert(panel.includes("pinterestStatusFromSocialFallback"), "panel must define a shared-source fallback");
    // The fallback is used inside the status-failure path, not the happy path.
    assert(/const fallback = await pinterestStatusFromSocialFallback\(\)/.test(panel), "fallback must run on status failure");
    assert(/if \(fallback\) \{[\s\S]*?setRefreshFailed\(false\)/.test(panel), "a confirmed fallback must clear the refresh-failed note");
  });

  await test("shared-source fallback is sandbox-safe (tags connectionSource db, reads real connection only)", () => {
    // The fallback synthesizes a db-sourced status; social/connections never reports
    // the sandbox token as connected, so this can't fake a connection.
    const idx = panel.indexOf("pinterestStatusFromSocialFallback");
    const body = panel.slice(idx, idx + 1400);
    assert(/connectionSource: "db"/.test(body), "fallback status must be tagged connectionSource db");
    assert(/pin\?\.connected/.test(body) || /pin\.connected/.test(body), "fallback must require the shared source to report connected");
  });

  await test("status route prioritizes a real DB connection over the sandbox fallback", () => {
    assert(/connectionSource: "db"/.test(statusRoute), "status must report db source for a real connection");
    assert(/connectionSource: "sandbox_demo"/.test(statusRoute), "status must tag sandbox separately");
    // db branch appears before the sandbox branch (real connection always wins).
    assert(
      statusRoute.indexOf('connectionSource: "db"') < statusRoute.indexOf('connectionSource: "sandbox_demo"'),
      "a real DB connection must take priority over sandbox",
    );
  });

  await test("disconnect nulls tokens + marks the row disconnected (all surfaces reflect it)", () => {
    const idx = connectionStore.indexOf("export async function disconnect");
    const body = connectionStore.slice(idx, idx + 500);
    assert(/access_token_encrypted: null/.test(body), "disconnect must null the access token");
    assert(/disconnected_at: new Date/.test(body), "disconnect must set disconnected_at");
  });

  await test("derivePinterestSettingsState treats sandbox_demo as not connected", async () => {
    const { derivePinterestSettingsState } = await import("../src/lib/pinterest/pinterestSettingsState");
    assert(
      derivePinterestSettingsState({
        connected: true,
        account: { id: "sandbox", username: "sandbox", accountType: "SANDBOX" },
        scopes: ["pins:write", "boards:read"],
        needsReconnect: false,
        connectionSource: "sandbox_demo",
      }) === "not_connected",
      "sandbox_demo must never render as connected in Settings",
    );
    assert(
      derivePinterestSettingsState({
        connected: true,
        account: { id: "1", username: "demo", accountType: null },
        scopes: ["pins:write", "boards:read"],
        needsReconnect: false,
        connectionSource: "db",
      }) === "connected",
      "a real db connection with publish scope must render connected",
    );
  });

  await test("shared helpers: strict merchant check vs publish capability (sandbox never 'real')", async () => {
    const { isRealPinterestConnection, canPublishWithPinterest } = await import("../src/lib/pinterest/connection");
    const base = { connected: true, account: null, scopes: [], needsReconnect: false };
    // Strict merchant check: ONLY an explicit db source — no `?? "db"` default.
    assert(isRealPinterestConnection({ ...base, connectionSource: "db" }), "db must be a real connection");
    assert(!isRealPinterestConnection({ ...base, connectionSource: "sandbox_demo" }), "sandbox_demo must not be a real connection");
    assert(!isRealPinterestConnection({ ...base, connectionSource: "none" }), "none must not be a real connection");
    assert(!isRealPinterestConnection({ ...base }), "a status missing connectionSource must never default to db");
    assert(!isRealPinterestConnection({ ...base, connectionSource: "db", needsReconnect: true }), "needsReconnect must block the real-connection check");
    // Publish capability: db OR sandbox_demo unblock the publish flow; nothing else.
    assert(canPublishWithPinterest({ ...base, connectionSource: "db" }), "db must allow the publish path");
    assert(canPublishWithPinterest({ ...base, connectionSource: "sandbox_demo" }), "sandbox_demo must allow the publish path");
    assert(!canPublishWithPinterest({ ...base, connectionSource: "none" }), "none must not allow the publish path");
    assert(!canPublishWithPinterest({ ...base }), "missing connectionSource must not allow the publish path");
    assert(!canPublishWithPinterest({ ...base, connectionSource: "db", needsReconnect: true }), "needsReconnect must block the publish path");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
