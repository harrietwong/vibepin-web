/** Focused production-blocker contracts for durable multichannel publish intents. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildPublishConfirmation,
  confirmPublishSnapshot,
  sha256Hex,
} from "../src/lib/studio/publishConfirmation";
import {
  validateImmediatePublishReceipt,
  validateStoredImmediatePublishReceipt,
} from "../src/lib/server/publish/confirmationReceipt";
import {
  PublishIntentLedgerError,
  claimPublishIntentDestinations,
  reconcilePublishIntent,
} from "../src/lib/server/publish/publishIntentLedger";
import { requiredScheduleDestinations } from "../src/app/api/pin-drafts/promote";
import type { PinDraft } from "../src/lib/pinDraftStore";
import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyDispatchSettlement } from "../src/lib/social/publishRules";

let passed = 0;
let failed = 0;
async function test(name: string, run: () => void | Promise<void>) {
  try { await run(); passed += 1; console.log(`  OK   ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL ${name}\n       ${(error as Error).message}`); }
}

const NOW = "2026-09-01T12:00:00.000Z";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const draft: PinDraft = {
  id: "pd-durable-1",
  contentId: "content-durable-1",
  imageUrl: "https://cdn.test/cover.jpg",
  media: [{ id: "media-1", kind: "image", url: "https://cdn.test/cover.jpg", source: "upload" }],
  title: "Durable title",
  description: "Durable caption",
  altText: "Durable alt",
  destinationUrl: "https://shop.test/item",
  boardId: "legacy-must-not-be-used",
  boardName: "Legacy",
  keyword: "", category: "", weeklyPlanItemId: "", generationSessionId: "",
  scheduledDate: "", status: "ready", createdAt: NOW, updatedAt: NOW,
  scheduledDestinations: [
    { provider: "pinterest", socialConnectionId: "pin-connection", accountLabel: "vibepin", boardId: "board-42", boardName: "Launches", capturedAt: NOW },
    { provider: "instagram", socialConnectionId: "ig-connection", accountLabel: "sensalab__", capturedAt: NOW },
    { provider: "facebook", socialConnectionId: "fb-connection", accountLabel: "vibepin.co", capturedAt: NOW },
  ],
};
const snapshot = buildPublishConfirmation(draft, { onlyPending: false, actionId: "durabletest01" });
const receipt = confirmPublishSnapshot(snapshot, NOW);

function storedDb(input: { row?: unknown; error?: { code?: string; message: string } | null }) {
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.maybeSingle = async () => ({ data: input.row ?? null, error: input.error ?? null });
  return { from: () => builder } as unknown as SupabaseClient;
}

async function main() {
  console.log("\n=== canonical receipt ===");
  await test("SHA-256 matches FIPS known vectors", () => {
    assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  await test("exact immediate bytes/account/Board validate", () => {
    const validation = validateImmediatePublishReceipt(receipt, {
      draftId: draft.id, title: draft.title, description: draft.description,
      destinationUrl: draft.destinationUrl, altText: draft.altText,
      imageUrls: [draft.imageUrl],
    }, snapshot.publishableDestinations.map(item => item.id), Date.parse(NOW));
    assert.equal(validation.ok, true);
  });
  await test("tampering both dispatch bytes and destination subset fails closed", () => {
    const content = validateImmediatePublishReceipt(receipt, {
      draftId: draft.id, title: "changed", description: draft.description,
      destinationUrl: draft.destinationUrl, altText: draft.altText,
      imageUrls: [draft.imageUrl],
    }, ["pinterest:pin-connection"], Date.parse(NOW));
    assert.deepEqual(content, { ok: false, code: "invalid_confirmation", error: "The submitted content no longer matches the confirmation." });
    const widened = validateImmediatePublishReceipt(receipt, {
      draftId: draft.id, title: draft.title, description: draft.description,
      destinationUrl: draft.destinationUrl, altText: draft.altText,
      imageUrls: [draft.imageUrl],
    }, ["pinterest:not-confirmed"], Date.parse(NOW));
    assert.equal(widened.ok, false);
  });

  console.log("\n=== durable owner revision ===");
  const storedRow = { draft_id: draft.id, updated_at: NOW, payload: draft, deleted_at: null };
  await test("server recomputes fingerprint from the owner's current stored draft", async () => {
    assert.deepEqual(await validateStoredImmediatePublishReceipt(storedDb({ row: storedRow }), OWNER, receipt), { ok: true });
    assert.deepEqual(await validateStoredImmediatePublishReceipt(storedDb({
      row: { ...storedRow, updated_at: "2026-09-01T12:00:00+00:00" },
    }), OWNER, receipt), { ok: true }, "equivalent Postgres timestamptz serialization must not make a valid receipt stale");
  });
  await test("stale revision and changed destination fail before claim/usage/provider", async () => {
    const stale = await validateStoredImmediatePublishReceipt(storedDb({ row: { ...storedRow, updated_at: "2026-09-01T12:01:00.000Z" } }), OWNER, receipt);
    assert.equal(stale.ok, false);
    const changed = await validateStoredImmediatePublishReceipt(storedDb({ row: { ...storedRow, payload: { ...draft, scheduledDestinations: [] } } }), OWNER, receipt);
    assert.equal(changed.ok, false);
  });
  await test("missing owner row is invalid; unavailable schema is a 503-class error", async () => {
    assert.deepEqual(await validateStoredImmediatePublishReceipt(storedDb({}), OWNER, receipt), {
      ok: false, code: "invalid_confirmation", error: "This Content is no longer available.",
    });
    const unavailable = await validateStoredImmediatePublishReceipt(storedDb({ error: { code: "42P01", message: "missing" } }), OWNER, receipt);
    assert.equal(unavailable.ok, false);
    if (!unavailable.ok) assert.equal(unavailable.code, "publish_intent_unavailable");
  });

  console.log("\n=== atomic intent ledger ===");
  await test("fan-out claims one atomic RPC with exact sorted destinations", async () => {
    let call: { name: string; args: Record<string, unknown> } | null = null;
    const db = { rpc: async (name: string, args: Record<string, unknown>) => {
      call = { name, args };
      const destinations = args.p_destinations as Array<{ id: string }>;
      return { data: destinations.map((item, index) => ({ claimed: true, replayed: false, intentJobId: "intent-job", destinationJobId: `destination-${index}`, claimToken: `token-${index}`, status: "claimed", attempt: 1, retryAllowed: false, providerJobId: null, remoteId: null, remoteUrl: null, providerStatus: null, evidence: {}, id: item.id })), error: null };
    } } as unknown as SupabaseClient;
    const claimed = await claimPublishIntentDestinations(db, OWNER, receipt, snapshot.publishableDestinations);
    assert.equal(claimed.length, 3);
    const recorded = call as { name: string; args: Record<string, unknown> } | null;
    assert.ok(recorded);
    assert.equal(recorded.name, "publish_intent_claim_destinations");
    const ids = (recorded.args.p_destinations as Array<{ id: string }>).map(item => item.id);
    assert.deepEqual(ids, [...ids].sort());
  });
  await test("v72/RPC unavailable fails closed and never fabricates a claim", async () => {
    const db = { rpc: async () => ({ data: null, error: { code: "PGRST202", message: "function not found" } }) } as unknown as SupabaseClient;
    await assert.rejects(
      claimPublishIntentDestinations(db, OWNER, receipt, snapshot.publishableDestinations),
      (error: unknown) => error instanceof PublishIntentLedgerError && error.code === "unavailable",
    );
  });
  await test("reconcile is owner-scoped and missing v72 is unavailable", async () => {
    const calls: Array<[string, unknown]> = [];
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (key: string, value: unknown) => { calls.push([key, value]); return builder; };
    builder.maybeSingle = async () => ({ data: null, error: { code: "42P01", message: "missing" } });
    const db = { from: () => builder } as unknown as SupabaseClient;
    await assert.rejects(reconcilePublishIntent(db, OWNER, receipt.intentId), PublishIntentLedgerError);
    assert(calls.some(([key, value]) => key === "user_id" && value === OWNER));
  });

  console.log("\n=== schedule and source ordering ===");
  await test("scheduled intent retains exact provider/account/Board and no legacy fallback", () => {
    assert.deepEqual(requiredScheduleDestinations({ scheduledDestinations: draft.scheduledDestinations }), [
      { provider: "pinterest", socialConnectionId: "pin-connection", boardId: "board-42" },
      { provider: "instagram", socialConnectionId: "ig-connection" },
      { provider: "facebook", socialConnectionId: "fb-connection" },
    ]);
    assert.deepEqual(requiredScheduleDestinations({ targetConnectionId: "legacy", boardId: "legacy" }), []);
  });
  await test("zero-destination schedule rejects before quota and upsert", () => {
    const route = readFileSync("src/app/api/pin-drafts/route.ts", "utf8");
    const zero = route.indexOf("if (!destinations.length)");
    assert(zero > 0 && zero < route.indexOf("await checkAllowance(") && zero < route.indexOf(".upsert("));
    assert.match(route.slice(zero, zero + 500), /code: "no_destinations"/);
  });
  await test("both immediate routes bind stored revision and durable claim before usage/provider", () => {
    for (const file of ["src/app/api/pinterest/pins/route.ts", "src/app/api/publish/social/route.ts"]) {
      const source = readFileSync(file, "utf8");
      const stored = source.indexOf("validateStoredImmediatePublishReceipt(");
      const claim = source.includes("await claimPublishIntentDestinations(")
        ? source.indexOf("await claimPublishIntentDestinations(")
        : source.indexOf("await claimPublishIntentDestination(");
      const usage = source.indexOf("consumeScheduledPost(");
      const provider = source.includes("publishPost({") ? source.indexOf("publishPost({") : source.indexOf("publishPinForUser({");
      assert(stored > 0 && claim > stored && usage > claim && provider > claim, file);
    }
  });
  await test("quota/local-lock exits settle fresh claims and social dispatch cannot narrow the confirmed set", () => {
    const pins = readFileSync("src/app/api/pinterest/pins/route.ts", "utf8");
    const social = readFileSync("src/app/api/publish/social/route.ts", "utf8");
    const pinQuota = pins.slice(pins.indexOf('consumed.kind === "insufficient"'), pins.indexOf("const settleMetering"));
    assert.match(pinQuota, /settleDurableClaim\(/);
    const socialQuota = social.slice(social.indexOf('consumed.kind === "insufficient"'), social.indexOf("const outcomes"));
    assert.match(socialQuota, /settleFreshClaimsNotSent\("scheduled_post_limit_reached"\)/);
    assert.match(social, /expectedSocialDestinationIds\.length !== exactRequestedIds\.length/);
    assert.match(social, /The social destination set no longer matches the confirmation/);
  });
  await test("v72 source owns atomic claim, recovery evidence, RLS and data-safe rollback", () => {
    const migration = readFileSync("../backend/db/migrate_v72_publish_intent_idempotency.sql", "utf8");
    const rollback = readFileSync("../backend/db/rollback_v72_publish_intent_idempotency.sql", "utf8");
    assert.match(migration, /create or replace function publish_intent_claim_destinations/);
    assert.match(migration, /unique \(publish_intent_id, destination_id\)/);
    assert.match(migration, /delivery_unknown/);
    assert.match(migration, /enable row level security/);
    assert.match(migration, /revoke all .* authenticated/);
    assert.match(migration, /social_publish_job_destinations_exact_unique/);
    assert.match(migration, /historical non-null duplicates exist/);
    assert.match(migration, /social_publish_job_destinations_null_connection_unique/);
    assert.match(rollback, /Refusing v72 rollback: durable publish intent receipts exist/);
  });
  await test("same intent binds confirmed time, mode and receipt immutably", () => {
    const migration = readFileSync("../backend/db/migrate_v72_publish_intent_idempotency.sql", "utf8");
    const conflict = migration.slice(migration.indexOf("if v_intent.fingerprint"), migration.indexOf("insert into publish_intent_destinations"));
    assert.match(conflict, /v_intent\.confirmed_at is distinct from p_confirmed_at/);
    assert.match(conflict, /v_intent\.mode is distinct from p_mode/);
    assert.match(conflict, /v_intent\.receipt - 'confirmedAt'/);
    const comparable = (value: Record<string, unknown>) => {
      const copy = { ...value };
      delete copy.confirmedAt;
      return JSON.stringify(copy);
    };
    const original = { confirmedAt: "2026-09-01T12:00:00.000Z", mode: { kind: "now" }, destinations: ["ig"] };
    const equivalent = { ...original, confirmedAt: "2026-09-01T12:00:00+00:00" };
    assert.equal(comparable(original), comparable(equivalent), "same instant differs only in JSON timestamp text");
    assert.notEqual(comparable(original), comparable({ ...original, destinations: ["fb"] }));
    assert.notEqual(comparable(original), comparable({ ...original, mode: { kind: "scheduled" } }));
  });
  await test("pre-dispatch settlement failure is surfaced and never reported as released", () => {
    const route = readFileSync("src/app/api/publish/social/route.ts", "utf8");
    const start = route.indexOf("const settleFreshClaimsNotSent");
    const end = route.indexOf("const dispatchDestinationIds", start);
    const source = route.slice(start, end);
    assert.match(source, /Promise\.all/);
    assert.match(source, /\.then\(\(\) => true\)\.catch\(\(\) => false\)/);
    assert.match(source, /publish_intent_settlement_unavailable/);
  });
  await test("post-dispatch settlement failure keeps delivery evidence and blocks retry", () => {
    const route = readFileSync("src/app/api/publish/social/route.ts", "utf8");
    const start = route.indexOf("const settlementResults");
    const source = route.slice(start, start + 5000);
    assert.match(source, /settlementResults\.every\(Boolean\)/);
    assert.match(source, /publish_intent_settlement_unavailable/);
    assert.match(source, /dispatchStarted/);
    assert.match(source, /remoteEvidence/);
  });
  await test("dispatch settlement classifies pre-dispatch, known and unknown legs independently", () => {
    const ig = { provider: "instagram" as const, socialConnectionId: "ig-1" };
    const fb = { provider: "facebook" as const, socialConnectionId: "fb-1" };
    const published = [{ provider: "instagram" as const, socialConnectionId: "ig-1", status: "published" as const, externalPostId: "ig-remote", externalPostUrl: "https://ig/p/1" }];
    const preNetwork = [{ provider: "facebook" as const, socialConnectionId: "fb-1", status: "failed" as const, preNetwork: true }];
    const known = classifyDispatchSettlement(ig, published, true);
    assert.deepEqual({ status: known.status, retryAllowed: known.retryAllowed, remoteId: known.outcome?.externalPostId }, { status: "published", retryAllowed: false, remoteId: "ig-remote" });
    const retryable = classifyDispatchSettlement(fb, preNetwork, true);
    assert.equal(retryable.status, "failed");
    assert.equal(retryable.retryAllowed, true);
    const unknown = classifyDispatchSettlement(fb, [], true);
    assert.deepEqual({ status: unknown.status, retryAllowed: unknown.retryAllowed }, { status: "delivery_unknown", retryAllowed: false });
    const notSent = classifyDispatchSettlement(fb, [], false);
    assert.deepEqual({ status: notSent.status, retryAllowed: notSent.retryAllowed }, { status: "failed", retryAllowed: true });
  });
  await test("retrying a partial job upserts one exact destination row", () => {
    const fanout = readFileSync("src/lib/social/publishFanout.ts", "utf8");
    assert.match(fanout, /resolve by the exact key/i);
    assert.match(fanout, /persistenceOk/);
    assert.match(fanout, /null connection/);
    assert.match(fanout, /\.is\("social_connection_id", null\)/);
    assert.match(fanout, /return persistenceOk/);
  });

  console.log(`\nPublish durable intent: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(1); });
