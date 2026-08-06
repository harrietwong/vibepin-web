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
 *   - Settings reads that unified source directly. Phase A retired the dedicated
 *     Pinterest panel and its /api/pinterest/status + social cross-check dance: with
 *     ONE read there is no second opinion to disagree with, so the class of bug the
 *     cross-check defended against (a status blip hiding a live connection) is gone
 *     by construction rather than by compensation.
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
const panel = readFileSync(join(root, "src/components/social/SocialAccountsPanel.tsx"), "utf8");
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

  await test("Settings reads Pinterest from the ONE shared source (no second, disagreeing read)", () => {
    assert(panel.includes("fetchSocialConnections"), "panel must read the shared social-connections source");
    // The retired panel polled /api/pinterest/status separately and then had to
    // reconcile the two. Social accounts must not reintroduce that second read —
    // it is exactly what let the two surfaces disagree.
    assert(!panel.includes("/api/pinterest/status"), "panel must not add a second Pinterest status read");
    assert(!panel.includes("pinterestStatusFromSocialFallback"), "the retired cross-check fallback must not return");
  });

  await test("a failed load never renders as disconnected (it renders as an explicit error)", () => {
    // A transient read failure must be visibly an error, not silently "not connected" —
    // the same invariant the old cross-check protected, now enforced at the load site.
    assert(/catch \{[\s\S]{0,120}setLoadError\(true\)/.test(panel), "load failure must set an explicit error state");
    assert(panel.includes("social-load-error"), "the error state must be rendered, not swallowed");
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

  await test("Settings never sees a sandbox connection at all (filtered server-side, not in the UI)", () => {
    // The old panel had to special-case connectionSource "sandbox_demo" so a sandbox
    // token could not masquerade as a merchant connection. Social accounts reads
    // socialConnectionStore, which only ever maps a real pinterest_connections row —
    // the sandbox path never reaches the client, so there is nothing to special-case.
    assert(/readPinterestConnection/.test(socialStore), "social store must map only the real Pinterest connection record");
    assert(!socialStore.includes("sandbox"), "the shared social source must never surface a sandbox connection");
    assert(!panel.includes("sandbox_demo"), "Social accounts must not need a sandbox special case");
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
