/** Focused contracts for the remaining 0901 Multichannel/OAuth PRD gates. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveDestinationCapability, normalizePublishSchedule, soleConnectedAccount } from "../src/lib/social/destinationCapability";
import { decideReconnect } from "../src/lib/server/social/reconnectIdentity";
import type { SocialConnection } from "../src/lib/social/types";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log(`  OK  ${name}`); }
function connection(over: Partial<SocialConnection> = {}): SocialConnection {
  return {
    id: "ig-1", provider: "instagram", workspaceId: null,
    providerAccountId: "1784", providerAccountName: "Sensa", providerAccountUsername: "sensalab__",
    providerAccountAvatarUrl: null, connectionStatus: "connected", authProvider: "official",
    externalConnectionId: null, scopes: [], tokenExpiresAt: null, metadata: null,
    createdAt: null, updatedAt: null, ...over,
  };
}

test("exact owner-scoped connection exposes canonical identity and capability", () => {
  const account = connection();
  const result = resolveDestinationCapability({ provider: "instagram", connection: account, connectionId: account.id, mediaCount: 1, mode: "scheduled" });
  assert.equal(result.publishNow, true);
  assert.equal(result.schedule, true);
  assert.equal(result.displayIdentity, "sensalab__");
  assert.equal(result.providerAccountId, "1784");
});

test("missing or mismatched exact connection fails closed", () => {
  assert.equal(resolveDestinationCapability({ provider: "instagram", connectionId: "ig-1" }).unavailableReason, "not_connected");
  assert.equal(resolveDestinationCapability({ provider: "instagram", connection: connection(), connectionId: "ig-other" }).unavailableReason, "owner_mismatch");
});

test("Pinterest requires the exact Board and TikTok remains unsupported", () => {
  const pin = connection({ id: "pin-1", provider: "pinterest", authProvider: "official", scopes: ["boards:read", "boards:write", "pins:read", "pins:write"] });
  assert.equal(resolveDestinationCapability({ provider: "pinterest", connection: pin, connectionId: pin.id, mediaCount: 1 }).unavailableReason, "subdestination_required");
  assert.equal(resolveDestinationCapability({ provider: "pinterest", connection: pin, connectionId: pin.id, subdestinationId: "board-1", mediaCount: 1 }).publishNow, true);
  const tik = connection({ id: "tik-1", provider: "tiktok", authProvider: null });
  assert.equal(resolveDestinationCapability({ provider: "tiktok", connection: tik, connectionId: tik.id }).unavailableReason, "unsupported_provider");
});

test("sole-account resolution exists only at explicit UI selection time", () => {
  assert.equal(soleConnectedAccount([connection()])?.id, "ig-1");
  assert.equal(soleConnectedAccount([connection(), connection({ id: "ig-2" })]), null);
});

test("Publish now clears hidden stale schedule values", () => {
  assert.deepEqual(normalizePublishSchedule({ publishMode: "now", scheduledAt: "2099-01-01T10:00:00Z", timezone: "UTC" }), { publishMode: "now", scheduledAt: null, timezone: null });
  assert.throws(() => normalizePublishSchedule({ publishMode: "scheduled", scheduledAt: "", timezone: "UTC" }), /scheduled_time_required/);
});

test("reconnect target loss and identity loss are zero-write decisions", () => {
  const gone = decideReconnect({ reconnectTargetId: "gone", target: null, authorizedAccountId: "A", authorizedLabel: "A" });
  assert.equal(gone.action, "reject");
  assert.equal(gone.action === "reject" ? gone.reason : "", "reconnect_target_missing");
  const unidentified = decideReconnect({ reconnectTargetId: "c1", target: { connectionId: "c1", accountId: null, label: null }, authorizedAccountId: null, authorizedLabel: null });
  assert.equal(unidentified.action === "reject" ? unidentified.reason : "", "identity_unavailable");
});

const batch = readFileSync(new URL("../src/components/studio/BatchEditDrawer.tsx", import.meta.url), "utf8");
const picker = readFileSync(new URL("../src/components/social/PublishDestinations.tsx", import.meta.url), "utf8");
const validate = readFileSync(new URL("../src/app/api/publish/destinations/validate/route.ts", import.meta.url), "utf8");
const social = readFileSync(new URL("../src/app/api/publish/social/route.ts", import.meta.url), "utf8");
const cron = readFileSync(new URL("../src/app/api/cron/publish-due/publishDueLogic.ts", import.meta.url), "utf8");
const plan = readFileSync(new URL("../src/components/plan/DraftDetailsDrawer.tsx", import.meta.url), "utf8");

test("single card and Batch share PublishDestinations and persist the same intent", () => {
  assert.match(batch, /<PublishDestinations/);
  assert.match(batch, /scheduledDestinations: destinations\.map/);
  assert.match(batch, /batch-edit-bulk-publish-destinations/);
  assert.doesNotMatch(batch, /p\.publishTo \|\| platformName\("pinterest"\)/);
});

test("destination picker has no remembered Board or automatic Pinterest default", () => {
  assert.doesNotMatch(picker, /fetchPinterestDefaultBoard|savePinterestDefaultBoard/);
  assert.doesNotMatch(picker, /onSelectedChange\(\["pinterest"\]\)/);
});

test("Plan consumes the same exact account model and never loads a default target or Board", () => {
  assert.match(plan, /<PublishDestinations/);
  assert.match(plan, /onSelectedAccountIdsChange=\{handleSelectedAccountsChange\}/);
  assert.match(plan, /socialDestinations\.flatMap\(provider => socialAccountIds/);
  assert.match(plan, /selectedTargetConnection\(targetedDraft, pinterestConnections, null\)/);
  assert.doesNotMatch(plan, /fetchPinterestDefaultBoard|fallbackConnection/);
  assert.doesNotMatch(plan, /items\.length === 1 \? items\[0\]\.id/);
});

test("validation and dispatch require exact ids before meter/job/provider calls", () => {
  assert.match(validate, /accounts\.find\(account => account\.id === connectionId\)/);
  assert.doesNotMatch(validate, /accounts\.find\(account => account\.connectionStatus === "connected"\)/);
  const preflight = social.indexOf("const validation = requested.map");
  assert(preflight > 0 && preflight < social.indexOf("consumeScheduledPost({") && preflight < social.indexOf("createPublishJob(db"));
  assert.doesNotMatch(social, /resolveDestinationConnection/);
});

test("cron has no synthetic Pinterest destination fallback", () => {
  assert.doesNotMatch(cron, /socialConnectionId:\s*""/);
  assert.match(cron, /return \[\];/);
});

test("Batch schedule is optional and clears stale date plus time", () => {
  assert.match(batch, /batch-edit-schedule-clear/);
  assert.match(batch, /onApply\("", ""\)/);
  assert.match(batch, /disabled=\{!date \|\| !time\}/);
});

console.log(`\nMultichannel PRD remaining: ${passed} passed, 0 failed\n`);
