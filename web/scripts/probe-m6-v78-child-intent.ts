/**
 * probe-m6-v78-child-intent.ts — M6: after v82, a full v78 child-intent manual
 * retry still works (design §8.2 M6).
 *
 * TEST DATABASE ONLY (snulmwprsahzqvdbyenc). The target ref is asserted against
 * production before the first statement is sent.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS DRIVEN BY REAL APPLICATION CODE ───────────
 * Task 1 could not run M6: it tried to hand-build the confirmation receipt as
 * JSON and was rejected twice by v76's validator (`invalid_publish_receipt`),
 * and stopped rather than keep guessing. That was the right call, and the
 * reason it failed is instructive — the receipt is not a loose bag of fields,
 * it is a fingerprinted structure whose `fingerprint` must equal a SHA-256 over
 * a canonical serialization of its own contents. No hand-written fixture will
 * ever satisfy that except by accident.
 *
 * So this probe does not write a receipt. It calls the SAME function the cron
 * calls — `buildDueVideoReceipt` — which internally runs
 * `buildPublishConfirmation` + `confirmPublishSnapshot` and produces a receipt
 * that is correct by construction. That also makes the test stronger than the
 * one originally specified: it proves the real application path still works
 * against a v82 database, not merely that some JSON is accepted.
 *
 * WHAT IS PROVEN: v78's `publish_intent_confirm_prepare_v78` still creates a
 * parent intent, still refuses a child when the parent destination is not
 * `failed + retry_allowed`, and still creates one when it is — with the child
 * bound by `prior_intent_id` and `attempt = parent + 1` — all AFTER v82 added
 * its constraints and its own `_v82` RPC. If v82 had broken the v78 lineage,
 * this is where it would show.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

const PROD_REF = "jaxteelkecvlozdrdoog";
const TEST_REF = "snulmwprsahzqvdbyenc";

const ROOT = join(import.meta.dirname, "..", "..");
function loadEnv(path: string, key: string): string {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const [k, ...rest] = t.split("=");
      if (k.trim() === key) return rest.join("=").trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* missing file */ }
  return "";
}
const TOKEN = loadEnv(join(ROOT, "backend", ".env.migration"), "SUPABASE_MIGRATION_TOKEN");
if (!TOKEN) {
  console.error("SUPABASE_MIGRATION_TOKEN missing (backend/.env.migration)");
  process.exit(1);
}

console.log("=".repeat(66));
console.log(`TARGET project_ref : ${TEST_REF}`);
console.log(`PRODUCTION ref     : ${PROD_REF}`);
assert.notEqual(TEST_REF, PROD_REF, "ABORT: target is production");
console.log("ASSERTION OK: target != production. Proceeding.");
console.log("=".repeat(66));

async function q(sql: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${TEST_REF}/database/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql }),
    },
  );
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text || "[]"); } catch { body = text; }
  return { status: res.status, body };
}

const lit = (v: string) => `'${v.replaceAll("'", "''")}'`;
const jsonLit = (v: unknown) => `${lit(JSON.stringify(v))}::jsonb`;

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? `\n        ${detail}` : ""}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        ${detail}`); }
}

// Unique per run so repeated runs never collide, and so cleanup is exact.
const RUN = randomUUID().slice(0, 8);
const USER_ID = randomUUID();
const CONNECTION_ID = randomUUID();
const DRAFT_ID = `m6draft${RUN}`;
const BOARD_ID = `m6board${RUN}`;
const MEDIA_ID = `m6media${RUN}`;
const SCHEDULED_AT = "2026-09-01T09:00:00.000Z";
const UPDATED_AT = "2026-09-01T08:00:00.000Z";

async function cleanup(): Promise<void> {
  // Order matters: every table here is FK-bound with ON DELETE RESTRICT, so
  // children must go first. `pinterest_publish_evidence` and the delivery items
  // are included because the v81 settle and the v76 prepare create them and the
  // first version of this cleanup left them behind (2 intents + 1 connection
  // survived every run).
  await q(`
    delete from public.pinterest_publish_evidence
      where owner_user_id=${lit(USER_ID)}::uuid;
    delete from public.provider_publish_attempts where publish_intent_id in
      (select id from public.publish_intents where user_id=${lit(USER_ID)}::uuid);
    delete from public.publish_asset_delivery_items
      where owner_user_id=${lit(USER_ID)}::uuid;
    delete from public.publish_asset_deliveries where publish_intent_id in
      (select id from public.publish_intents where user_id=${lit(USER_ID)}::uuid);
    delete from public.publish_assets where owner_user_id=${lit(USER_ID)}::uuid;
    delete from public.publish_intent_destinations where publish_intent_id in
      (select id from public.publish_intents where user_id=${lit(USER_ID)}::uuid);
    update public.publish_intents set prior_intent_id=null
      where user_id=${lit(USER_ID)}::uuid;
    delete from public.publish_intents where user_id=${lit(USER_ID)}::uuid;
    delete from public.social_connections where user_id=${lit(USER_ID)}::uuid;
  `);
}

(async () => {
  // ── Build the receipt with the REAL application code ──────────────────────
  const { buildDueVideoReceipt } = await import(
    "../src/lib/server/publish/v76PinterestVideoBindings");

  const payload: Record<string, unknown> = {
    contentId: `m6content${RUN}`,
    title: "M6 regression content",
    description: "v78 child-intent retry after v82",
    altText: "",
    destinationUrl: "https://example.com/m6",
    boardId: BOARD_ID,
    media: [{
      id: MEDIA_ID,
      url: "https://example.com/m6.mp4",
      kind: "video",
      width: 1080, height: 1920, durationMs: 8000,
      posterUrl: "https://example.com/m6.jpg",
    }],
    scheduledDestinations: [{
      provider: "pinterest", socialConnectionId: CONNECTION_ID,
      boardId: BOARD_ID, capturedAt: SCHEDULED_AT,
    }],
    socialDestinations: [{
      id: `pinterest:${CONNECTION_ID}`, provider: "pinterest",
      socialConnectionId: CONNECTION_ID, boardId: BOARD_ID, boardName: "M6 board",
    }],
  };

  let receipt: Record<string, unknown>;
  try {
    receipt = buildDueVideoReceipt({
      draftId: DRAFT_ID, updatedAt: UPDATED_AT,
      scheduledAt: SCHEDULED_AT, payload,
    }) as unknown as Record<string, unknown>;
  } catch (err) {
    console.log(`  BLOCKED  receipt construction threw: ${(err as Error).message}`);
    console.log("\n0 passed, 1 failed (blocked before reaching the database)");
    process.exit(1);
  }
  const destinations = receipt.publishableDestinations as Array<Record<string, unknown>>;
  check("receipt built by real application code",
    Array.isArray(destinations) && destinations.length === 1,
    `intentId=${receipt.intentId} destinations=${JSON.stringify(
      destinations?.map(d => d.id))} dispatch=${JSON.stringify(receipt.dispatchDestinationIds)}`);
  if (!destinations?.length) {
    console.log("\nBLOCKED: the receipt has no publishable destination; nothing to prepare.");
    process.exit(1);
  }
  const DESTINATION_ID = String(destinations[0].id);
  const fingerprint = createHash("sha256")
    .update(String(receipt.fingerprint ?? "")).digest("hex");

  await cleanup();
  try {
    // ── Fixtures: a connected Pinterest account the receipt names ───────────
    const seed = await q(`
      insert into public.social_connections
        (id, user_id, provider, connection_status, disconnected_at, external_account_id)
      values (${lit(CONNECTION_ID)}::uuid, ${lit(USER_ID)}::uuid, 'pinterest',
              'connected', null, ${lit(`m6acct${RUN}`)})
      on conflict (id) do nothing;
    `);
    check("fixture: connected pinterest account seeded", seed.status === 201,
      `${seed.status} ${JSON.stringify(seed.body).slice(0, 200)}`);
    if (seed.status !== 201) throw new Error("fixture seed failed");

    // ── 1. The PARENT intent, through v78 ───────────────────────────────────
    const parent = await q(`
      select public.publish_intent_confirm_prepare_v78(
        ${lit(USER_ID)}::uuid, ${jsonLit(receipt)}, ${lit(fingerprint)}) as result;
    `);
    check("M6.1 v78 creates the parent intent after v82", parent.status === 201,
      `${parent.status} ${JSON.stringify(parent.body).slice(0, 300)}`);
    if (parent.status !== 201) throw new Error("parent prepare failed");

    // ── 2. A child is REFUSED while the parent is not a failed retry ────────
    // v73's/v78's entitlement rule, unchanged by v82: only a `failed` parent
    // destination carrying `retry_allowed` may be retried.
    const childReceipt = {
      ...receipt,
      intentId: `publish:${receipt.contentId}:m6child${RUN}`,
      priorIntentId: receipt.intentId,
      onlyPending: true,
    };
    const tooEarly = await q(`
      select public.publish_intent_confirm_prepare_v78(
        ${lit(USER_ID)}::uuid, ${jsonLit(childReceipt)}, ${lit(fingerprint)}) as result;
    `);
    check("M6.2 child refused while the parent has not failed (entitlement intact)",
      tooEarly.status !== 201
        && JSON.stringify(tooEarly.body).includes("retry_not_allowed"),
      `${tooEarly.status} ${JSON.stringify(tooEarly.body).slice(0, 260)}`);

    // ── 3. Drive the parent destination to failed + retry_allowed ───────────
    //
    // ── THIS CANNOT BE A BARE UPDATE, AND THAT IS THE POINT ─────────────────
    // `v76_legacy_transition_guard` (migrate_v76:674-693) refuses ANY move to
    // published/failed/delivery_unknown unless the row was `claimed`, held a
    // claim token, and a matching `provider_publish_attempts` row records the
    // corresponding provider verdict. A direct `set status='failed'` is
    // rejected with `provider_failure_required` — which is the guard working.
    // So the fixture walks the real path: materialized → claimed (with a claim
    // token) → a failed provider attempt against that exact token → failed.
    // The fact that this is the only way in is itself a regression check on
    // v76, and v82 must not have loosened it.
    const CLAIM_TOKEN = randomUUID();
    // The guard also demands a COMPLETE materialization graph before `claimed`
    // (migrate_v76:630-671): every asset of the intent ready at the right source
    // revision, a delivery in `ready`, and one ready delivery item per asset.
    // `publish_intent_confirm_prepare` already created that graph in `prepared`;
    // this advances it, which is what the real materializer does.
    const materialize = await q(`
      update public.publish_assets set status='ready', materialized_at=now(), updated_at=now()
       where owner_user_id=${lit(USER_ID)}::uuid;
      update public.publish_asset_delivery_items set item_status='ready'
       where owner_user_id=${lit(USER_ID)}::uuid;
      update public.publish_asset_deliveries set status='ready', updated_at=now()
       where publish_intent_id in (select id from public.publish_intents
         where user_id=${lit(USER_ID)}::uuid);
      update public.publish_intent_destinations
         set materialization_status='materialized', updated_at=now()
       where publish_intent_id in (select id from public.publish_intents
         where user_id=${lit(USER_ID)}::uuid);
    `);
    check("fixture: materialization graph advanced to ready",
      materialize.status === 201, JSON.stringify(materialize.body).slice(0, 200));

    const prep = await q(`
      update public.publish_intent_destinations
         set status='claimed', claim_token=${lit(CLAIM_TOKEN)}::uuid,
             claimed_at=now(), updated_at=now()
       where destination_id=${lit(DESTINATION_ID)}
         and publish_intent_id=(select id from public.publish_intents
            where user_id=${lit(USER_ID)}::uuid and intent_id=${lit(String(receipt.intentId))})
      returning status, claim_token;
    `);
    check("fixture: parent destination claimed with a token",
      prep.status === 201 && (prep.body as unknown[])?.length === 1,
      JSON.stringify(prep.body).slice(0, 200));

    // The attempt cannot be hand-inserted in a terminal state either:
    // `v76_evidence_owner_guard` demands an INSERT be `started` with a live claim
    // token, and a settle be accompanied by a `v76_provider_settlement_context`
    // proof row created in the SAME transaction — which only the settle RPC
    // makes. So the fixture drives the real pair,
    // `publish_provider_attempt_start` + `publish_provider_attempt_settle_v81`.
    // Every guard in the v76/v81 lineage is exercised rather than bypassed,
    // which makes this a stronger M6 than the one originally specified.
    const started = await q(`
      select public.publish_provider_attempt_start(
        ${lit(USER_ID)}::uuid, ${lit(String(receipt.intentId))}, ${lit(DESTINATION_ID)},
        ${lit(CLAIM_TOKEN)}::uuid, 1) as result;
    `);
    const startBody = (started.body as Array<{ result?: Record<string, unknown> }>)?.[0]?.result;
    const attemptId = typeof startBody?.attemptId === "string" ? startBody.attemptId : "";
    check("fixture: provider attempt started through the real v76 RPC",
      started.status === 201 && !!attemptId,
      `${started.status} ${JSON.stringify(started.body).slice(0, 240)}`);

    const settled = await q(`
      select public.publish_provider_attempt_settle_v81(
        ${lit(USER_ID)}::uuid, ${lit(attemptId)}::uuid, ${lit(CLAIM_TOKEN)}::uuid,
        'failed', 400, null, null,
        ${jsonLit({
          // `reason` and `classification` are v81 whitelisted enums; the evidence
          // key set is checked byte-for-byte (migrate_v81:67-90), which is exactly
          // why the design forbids smuggling retryAfterSeconds in here.
          provider: "pinterest", reason: "provider_rejected",
          classification: "definite_rejection", providerStatus: 400,
        })}) as result;
    `);
    check("fixture: provider attempt settled FAILED through the real v81 RPC",
      settled.status === 201,
      `${settled.status} ${JSON.stringify(settled.body).slice(0, 240)}`);

    // ── The settle ALREADY moved the destination to `failed` ────────────────
    // Worth stating because the first version of this probe tried to UPDATE it
    // by hand afterwards and was refused with `provider_failure_required`: the
    // settle RPC is what performs that transition, under the guard, and a
    // second hand-written transition is both unnecessary and forbidden. Only
    // `retry_allowed` is set here — that is a v73 entitlement flag the settle
    // path does not own.
    // ── NO hand-written transition here, and that is a FINDING, not a gap ───
    // The first three versions of this probe tried to UPDATE the parent
    // destination into `failed` / `retry_allowed` and were refused every time
    // (`provider_failure_required`, then HTTP 400 from the v76 guards). The
    // reason is that `publish_provider_attempt_settle_v81` ALREADY performs the
    // whole transition — status AND the retry entitlement — under the guard.
    // The row is read back rather than written, so this asserts the settle
    // really produced a retryable parent instead of assuming it.
    const failState = await q(`
      select d.status, d.retry_allowed, d.attempt
        from public.publish_intent_destinations d
        join public.publish_intents i on i.id=d.publish_intent_id
       where i.user_id=${lit(USER_ID)}::uuid
         and i.intent_id=${lit(String(receipt.intentId))}
         and d.destination_id=${lit(DESTINATION_ID)};
    `);
    const failRow = (failState.body as Array<Record<string, unknown>>)?.[0];
    check("the v81 settle leaves the parent failed + retry_allowed (no hand-written "
      + "transition is possible, or needed)",
      failRow?.status === "failed" && failRow?.retry_allowed === true,
      JSON.stringify(failRow));

    // ── 4. The child intent is now created — the M6 claim itself ────────────
    const child = await q(`
      select public.publish_intent_confirm_prepare_v78(
        ${lit(USER_ID)}::uuid, ${jsonLit(childReceipt)}, ${lit(fingerprint)}) as result;
    `);
    check("M6.3 v78 child-intent retry SUCCEEDS after v82", child.status === 201,
      `${child.status} ${JSON.stringify(child.body).slice(0, 300)}`);

    // ── 5. Lineage and attempt inheritance ──────────────────────────────────
    const lineage = await q(`
      select c.intent_id as child_intent,
             (p.id = c.prior_intent_id) as bound_to_parent,
             cd.attempt as child_attempt, pd.attempt as parent_attempt,
             (cd.retry_of_destination_id = pd.id) as retry_bound
        from public.publish_intents c
        join public.publish_intents p
          on p.user_id=c.user_id and p.intent_id=${lit(String(receipt.intentId))}
        join public.publish_intent_destinations cd
          on cd.publish_intent_id=c.id and cd.destination_id=${lit(DESTINATION_ID)}
        join public.publish_intent_destinations pd
          on pd.publish_intent_id=p.id and pd.destination_id=${lit(DESTINATION_ID)}
       where c.user_id=${lit(USER_ID)}::uuid
         and c.intent_id=${lit(childReceipt.intentId)};
    `);
    const row = (lineage.body as Array<Record<string, unknown>>)?.[0];
    check("M6.4 child bound to parent, attempt = parent + 1",
      !!row && row.bound_to_parent === true && row.retry_bound === true
        && Number(row.child_attempt) === Number(row.parent_attempt) + 1,
      JSON.stringify(row));

    // ── 6. The entitlement is single-use ────────────────────────────────────
    const second = await q(`
      select public.publish_intent_confirm_prepare_v78(
        ${lit(USER_ID)}::uuid,
        ${jsonLit({ ...childReceipt, intentId: `publish:${receipt.contentId}:m6child2${RUN}` })},
        ${lit(fingerprint)}) as result;
    `);
    check("M6.5 the parent's retry entitlement is consumed exactly once",
      second.status !== 201
        && JSON.stringify(second.body).includes("retry_not_allowed"),
      `${second.status} ${JSON.stringify(second.body).slice(0, 260)}`);
  } finally {
    await cleanup();
    const leftover = await q(`
      select (select count(*) from public.publish_intents
               where user_id=${lit(USER_ID)}::uuid) as intents,
             (select count(*) from public.social_connections
               where user_id=${lit(USER_ID)}::uuid) as connections;`);
    console.log(`\ncleanup: ${JSON.stringify((leftover.body as unknown[])?.[0])}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
