/**
 * probe-v82-child-redemption.ts — E1-E4: the v82 `delivery_unknown` retry is
 * actually REDEEMED against real SQL (design §2.2 G, §5.4 point 3).
 *
 * TEST DATABASE ONLY (snulmwprsahzqvdbyenc). The target ref is asserted against
 * production before the first statement is sent.
 *
 * ── WHAT WAS MISSING, AND WHY IT WAS MISSING ────────────────────────────────
 * 16f1422b verified the REFUSAL paths (E5/E6/E7) against real SQL and said
 * plainly that E1-E4 — redemption accepted, lineage bound, attempt inherited,
 * replay collapsed — were not verified. The blocker it named was fixture
 * construction, not the feature: parking a parent destination at
 * `delivery_unknown` means walking prepared → materialized → claimed →
 * attempt(unknown), and `v76_legacy_transition_guard` refuses the `claimed` step
 * with `materialization_required` until a complete publish_assets /
 * publish_asset_deliveries / publish_asset_delivery_items graph exists.
 *
 * That diagnosis was right and the missing step is small: M6
 * (probe-m6-v78-child-intent.ts) already solved exactly this, by ADVANCING the
 * graph `publish_intent_confirm_prepare` has already created — assets to `ready`,
 * delivery items to `ready`, the delivery to `ready`, destinations to
 * `materialized` — which is what the real materializer does. This probe reuses
 * that, and is otherwise M6's shape with one substitution: the provider attempt
 * is settled `unknown` rather than `failed`, so the parent lands on
 * `delivery_unknown` instead of `failed`.
 *
 * ★ NO GUARD IS BYPASSED, AND THAT IS THE POINT. Every state this probe puts the
 * database in is reached by the same RPCs production calls —
 * `publish_intent_confirm_prepare`, `publish_provider_attempt_start`,
 * `publish_provider_attempt_settle_v81`, `publish_reconcile_record_v82`,
 * `publish_intent_confirm_prepare_v82`. The `v76_frozen_legacy` escape hatch is
 * NOT used: its meaning is "pre-v76 historical row, exempt from the transition
 * guard", and setting it on a row created seconds ago would falsify lineage to
 * dodge the very protection under test. Ruled out by the coordinator, correctly.
 *
 * ── WHY THIS IS TYPESCRIPT AND NOT THE EXISTING PYTHON PROBE ────────────────
 * The receipts must come from the production builders — the receipt carries a
 * fingerprint that must equal the SHA-256 of its own canonical serialization, so
 * hand-written JSON cannot pass and a Python reimplementation would be a second
 * copy to keep in sync. The Python probe therefore shells out to `npx tsx` to
 * generate them anyway. Running the whole thing in TypeScript removes that hop,
 * and matches M6 — the probe that already proved this fixture path works.
 *
 * ── THE ORDER IS FORCED BY THE PROOF'S OWN ID ───────────────────────────────
 * `publish_reconcile_record_v82` mints its own `id` (`gen_random_uuid()`), and
 * the child receipt DERIVES its action id from that value. So the proof must be
 * recorded BEFORE the child receipt can be built, and the child receipt cannot
 * be generated up front alongside the parent. Sequence:
 *   fixture → parent receipt → parent prepare → park at delivery_unknown →
 *   reconcile_record_v82 (capture id) → child receipt → E1-E4.
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

console.log("=".repeat(70));
console.log(`TARGET project_ref : ${TEST_REF}`);
console.log(`PRODUCTION ref     : ${PROD_REF}`);
assert.notEqual(TEST_REF, PROD_REF, "ABORT: target is production");
console.log("ASSERTION OK: target != production. Proceeding.");
console.log("=".repeat(70));

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
const rows = (b: unknown) => (b as Array<Record<string, unknown>>) ?? [];

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? `\n        ${detail}` : ""}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        ${detail}`); }
}

const RUN = randomUUID().slice(0, 8);
const USER_ID = randomUUID();
const CONNECTION_ID = randomUUID();
const DRAFT_ID = `e2edraft${RUN}`;
const BOARD_ID = `e2eboard${RUN}`;
const SCHEDULED_AT = "2026-09-01T09:00:00.000Z";
const UPDATED_AT = "2026-09-01T08:55:00.000Z";
const DEST_KEY = `pinterest:${CONNECTION_ID}`;

/** M6's cleanup list. The FULL graph gets built here, so the three-table version
 *  the Python probe carried would leave residue behind on every run. */
async function cleanup(): Promise<void> {
  await q(`
    delete from public.publish_reconcile_checks
      where owner_user_id=${lit(USER_ID)}::uuid;
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
  const { buildDueVideoReceipt, buildReconcileChildVideoReceipt } = await import(
    "../src/lib/server/publish/v76PinterestVideoBindings");

  const payload: Record<string, unknown> = {
    contentId: `e2econtent${RUN}`,
    title: "E2E autumn clip",
    description: "v82 delivery_unknown redemption",
    altText: "clip",
    destinationUrl: "https://shop.example.com/e2e",
    boardId: BOARD_ID,
    media: [{
      id: `e2emedia${RUN}`, kind: "video", url: "https://example.com/clip.mp4",
      width: 1080, height: 1920, durationMs: 8000,
      posterUrl: "https://example.com/poster.jpg",
    }],
    scheduledDestinations: [{
      provider: "pinterest", socialConnectionId: CONNECTION_ID,
      boardId: BOARD_ID, boardName: "E2E board", capturedAt: SCHEDULED_AT,
    }],
    socialDestinations: [{
      id: DEST_KEY, provider: "pinterest", socialConnectionId: CONNECTION_ID,
      boardId: BOARD_ID, boardName: "E2E board",
    }],
    // The stored result row reconciliation was called in to settle. The child
    // builder drops exactly this row (see its header) — carried over, `onlyPending`
    // would filter out the one destination being retried.
    destinationResults: [{
      destinationId: DEST_KEY, provider: "pinterest", socialConnectionId: CONNECTION_ID,
      status: "delivery_unknown", submittedAt: SCHEDULED_AT,
    }],
  };

  const base = { draftId: DRAFT_ID, updatedAt: UPDATED_AT, scheduledAt: SCHEDULED_AT, payload };
  const parent = buildDueVideoReceipt(base) as unknown as Record<string, unknown>;
  const parentDestinations = parent.publishableDestinations as Array<Record<string, unknown>>;
  check("parent receipt built by the production builder",
    Array.isArray(parentDestinations) && parentDestinations.length === 1,
    `intentId=${parent.intentId} dispatch=${JSON.stringify(parent.dispatchDestinationIds)}`);
  const DESTINATION_ID = String(parentDestinations[0].id);
  check("the destination key is the one the proof will name",
    DESTINATION_ID === DEST_KEY, `${DESTINATION_ID} vs ${DEST_KEY}`);
  const parentFingerprint = createHash("sha256")
    .update(String(parent.fingerprint ?? "")).digest("hex");

  await cleanup();
  try {
    // ── Fixture: the connected Pinterest account the receipt names ───────────
    const seed = await q(`
      insert into public.social_connections
        (id, user_id, provider, connection_status, disconnected_at, external_account_id)
      values (${lit(CONNECTION_ID)}::uuid, ${lit(USER_ID)}::uuid, 'pinterest',
              'connected', null, ${lit(`e2eacct${RUN}`)})
      on conflict (id) do nothing;
    `);
    check("fixture: connected pinterest account seeded", seed.status === 201,
      `${seed.status} ${JSON.stringify(seed.body).slice(0, 200)}`);
    if (seed.status !== 201) throw new Error("fixture seed failed");

    // ── 1. The PARENT intent, through v76's own prepare ──────────────────────
    const prep = await q(`
      select public.publish_intent_confirm_prepare(
        ${lit(USER_ID)}::uuid, ${jsonLit(parent)}) as result;
    `);
    check("parent intent created by the real v76 prepare", prep.status === 201,
      `${prep.status} ${JSON.stringify(prep.body).slice(0, 300)}`);
    if (prep.status !== 201) throw new Error("parent prepare failed");

    // ── 2. Advance the materialization graph (M6's step, verbatim) ───────────
    // `v76_legacy_transition_guard` demands a COMPLETE ready graph before a
    // destination may become `claimed` (migrate_v76:630-671): every asset ready at
    // the right source revision, the delivery ready, one ready item per asset.
    // `publish_intent_confirm_prepare` created that graph in `prepared`; this
    // advances it, which is exactly what the real materializer does. THIS IS THE
    // STEP 16f1422b WAS MISSING — it went straight to `claimed` and was refused
    // with `materialization_required`.
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

    const CLAIM_TOKEN = randomUUID();
    const claimed = await q(`
      update public.publish_intent_destinations
         set status='claimed', claim_token=${lit(CLAIM_TOKEN)}::uuid,
             claimed_at=now(), updated_at=now()
       where destination_id=${lit(DESTINATION_ID)}
         and publish_intent_id=(select id from public.publish_intents
            where user_id=${lit(USER_ID)}::uuid and intent_id=${lit(String(parent.intentId))})
      returning status, claim_token;
    `);
    check("fixture: parent destination claimed with a token (the guard is satisfied, "
      + "not bypassed)",
      claimed.status === 201 && rows(claimed.body).length === 1,
      `${claimed.status} ${JSON.stringify(claimed.body).slice(0, 220)}`);
    if (claimed.status !== 201) throw new Error("claim failed");

    // ── 3. Settle the attempt UNKNOWN ⇒ the parent lands on delivery_unknown ──
    // The one substitution from M6. `p_status='unknown'` is what v76's settle maps
    // to `delivery_unknown` (migrate_v76:1821), and it is what production sends
    // when the provider call could have created a Pin and we cannot prove
    // otherwise. The evidence triple is copied from what production actually
    // passes on this path (v76PinterestVideoPublish.ts:295-303 — reason
    // `unknown_outcome`, and `classification:'unknown'` / `stage:'created'` from
    // the adapter), all three inside v81's byte-checked whitelist.
    const started = await q(`
      select public.publish_provider_attempt_start(
        ${lit(USER_ID)}::uuid, ${lit(String(parent.intentId))}, ${lit(DESTINATION_ID)},
        ${lit(CLAIM_TOKEN)}::uuid, 1) as result;
    `);
    const startBody = rows(started.body)[0]?.result as Record<string, unknown> | undefined;
    const attemptId = typeof startBody?.attemptId === "string" ? startBody.attemptId : "";
    check("fixture: provider attempt started through the real v76 RPC",
      started.status === 201 && !!attemptId,
      `${started.status} ${JSON.stringify(started.body).slice(0, 240)}`);
    if (!attemptId) throw new Error("attempt start failed");

    const settled = await q(`
      select public.publish_provider_attempt_settle_v81(
        ${lit(USER_ID)}::uuid, ${lit(attemptId)}::uuid, ${lit(CLAIM_TOKEN)}::uuid,
        'unknown', null, null, null,
        ${jsonLit({
          provider: "pinterest", reason: "unknown_outcome",
          classification: "unknown", stage: "created",
        })}) as result;
    `);
    check("fixture: attempt settled UNKNOWN through the real v81 RPC",
      settled.status === 201,
      `${settled.status} ${JSON.stringify(settled.body).slice(0, 300)}`);

    // Read back rather than assume: the settle is what performs the transition.
    const parked = await q(`
      select d.status, d.attempt, d.retry_allowed, i.lifecycle_status
        from public.publish_intent_destinations d
        join public.publish_intents i on i.id=d.publish_intent_id
       where i.user_id=${lit(USER_ID)}::uuid
         and i.intent_id=${lit(String(parent.intentId))}
         and d.destination_id=${lit(DESTINATION_ID)};
    `);
    const parkedRow = rows(parked.body)[0];
    check("the parent destination is parked at delivery_unknown by the REAL state machine",
      parkedRow?.status === "delivery_unknown", JSON.stringify(parkedRow));
    if (parkedRow?.status !== "delivery_unknown") {
      throw new Error(`parent did not reach delivery_unknown: ${JSON.stringify(parkedRow)}`);
    }
    const parentAttempt = Number(parkedRow.attempt);

    // ── 4. The confirmed_absent proof, through the v82 RPC ───────────────────
    // Recorded by `publish_reconcile_record_v82`, not by a direct INSERT: that RPC
    // is the table's only write path in production, and it is what stamps
    // `reconciled_at` on the attempt ledger. Its `id` is minted here and the child
    // receipt is derived FROM it, which is why the child could not be built earlier.
    const proof = await q(`
      select public.publish_reconcile_record_v82(
        ${lit(USER_ID)}::uuid, ${lit(DRAFT_ID)}, ${lit(SCHEDULED_AT)}::timestamptz,
        'pinterest', ${lit(CONNECTION_ID)}, 1,
        'confirmed_absent', null, null,
        (select id from public.publish_intents
          where user_id=${lit(USER_ID)}::uuid and intent_id=${lit(String(parent.intentId))}),
        ${lit(DESTINATION_ID)}, null, '{}'::jsonb) as result;
    `);
    const proofBody = rows(proof.body)[0]?.result as Record<string, unknown> | undefined;
    const CHECK_ID = typeof proofBody?.id === "string" ? proofBody.id : "";
    check("confirmed_absent proof recorded through publish_reconcile_record_v82",
      proof.status === 201 && !!CHECK_ID && proofBody?.outcome === "confirmed_absent",
      `${proof.status} ${JSON.stringify(proof.body).slice(0, 300)}`);
    if (!CHECK_ID) throw new Error("reconcile record failed");

    const bound = await q(`
      select c.outcome, (c.publish_intent_id = i.id) as intent_bound, c.destination_id
        from public.publish_reconcile_checks c
        join public.publish_intents i on i.user_id=c.owner_user_id
         and i.intent_id=${lit(String(parent.intentId))}
       where c.id=${lit(CHECK_ID)}::uuid;
    `);
    check("the proof carries the PARENT intent's row id and its own destination",
      rows(bound.body)[0]?.intent_bound === true
        && rows(bound.body)[0]?.destination_id === DESTINATION_ID,
      JSON.stringify(rows(bound.body)[0]));

    // ── 5. Now the child receipt can be built — it derives from the proof id ──
    const child = buildReconcileChildVideoReceipt({
      ...base,
      reconcileCheckId: CHECK_ID,
      parentIntentId: String(parent.intentId),
      destinationId: DESTINATION_ID,
    }) as unknown as Record<string, unknown>;
    const childFingerprint = createHash("sha256")
      .update(String(child.fingerprint ?? "")).digest("hex");
    check("child receipt built by the production builder, lineage and dispatch correct",
      child.priorIntentId === parent.intentId
        && child.onlyPending === true
        && JSON.stringify(child.dispatchDestinationIds) === JSON.stringify([DESTINATION_ID]),
      `child=${child.intentId} prior=${child.priorIntentId} `
      + `dispatch=${JSON.stringify(child.dispatchDestinationIds)}`);

    // ── E1: the redemption is ACCEPTED ───────────────────────────────────────
    const redeem = await q(`
      select public.publish_intent_confirm_prepare_v82(
        ${lit(USER_ID)}::uuid, ${jsonLit(child)}, ${lit(childFingerprint)},
        ${lit(CHECK_ID)}::uuid) as result;
    `);
    check("E1 redemption ACCEPTED: a confirmed_absent proof opens a child intent "
      + "from a delivery_unknown parent",
      redeem.status === 201,
      `${redeem.status} ${JSON.stringify(redeem.body).slice(0, 500)}`);
    if (redeem.status !== 201) throw new Error("E1 failed — later cases depend on it");

    // ── E2: lineage is bound in the DATABASE, not merely requested ───────────
    const lineage = await q(`
      select c.intent_id as child_intent,
             (c.prior_intent_id = p.id) as prior_bound,
             (c.source_identity_fingerprint = ${lit(childFingerprint)}) as fp_bound
        from public.publish_intents c
        join public.publish_intents p on p.user_id=c.user_id
         and p.intent_id=${lit(String(parent.intentId))}
       where c.user_id=${lit(USER_ID)}::uuid and c.intent_id=${lit(String(child.intentId))};
    `);
    const lineageRow = rows(lineage.body)[0];
    check("E2 child.prior_intent_id points at the parent row and the fingerprint is stored",
      lineageRow?.prior_bound === true && lineageRow?.fp_bound === true,
      JSON.stringify(lineageRow));

    // ── E3: destination lineage + attempt inheritance ────────────────────────
    const inherit = await q(`
      select cd.attempt as child_attempt, pd.attempt as parent_attempt,
             (cd.retry_of_destination_id = pd.id) as retry_bound
        from public.publish_intents c
        join public.publish_intent_destinations cd on cd.publish_intent_id=c.id
        join public.publish_intents p on p.user_id=c.user_id
         and p.intent_id=${lit(String(parent.intentId))}
        join public.publish_intent_destinations pd on pd.publish_intent_id=p.id
         and pd.destination_id=cd.destination_id
       where c.user_id=${lit(USER_ID)}::uuid and c.intent_id=${lit(String(child.intentId))}
         and cd.destination_id=${lit(DESTINATION_ID)};
    `);
    const inheritRow = rows(inherit.body)[0];
    check("E3 child destination binds retry_of_destination_id and inherits attempt + 1",
      inheritRow?.retry_bound === true
        && Number(inheritRow.child_attempt) === Number(inheritRow.parent_attempt) + 1
        && Number(inheritRow.parent_attempt) === parentAttempt,
      `${JSON.stringify(inheritRow)} (parent observed earlier: ${parentAttempt})`);

    // ── E4: replaying the IDENTICAL receipt converges on the SAME child ──────
    // The child intent id is derived deterministically from the proof id, so a
    // crash between prepare and dispatch re-sends exactly this receipt. It must
    // SUCCEED rather than be refused — refusing would strand the destination
    // forever, which is why migrate_v82 excludes the receipt's own child from the
    // single-use check.
    const replay = await q(`
      select public.publish_intent_confirm_prepare_v82(
        ${lit(USER_ID)}::uuid, ${jsonLit(child)}, ${lit(childFingerprint)},
        ${lit(CHECK_ID)}::uuid) as result;
    `);
    check("E4 replaying the identical receipt is ACCEPTED (crash-replay safe)",
      replay.status === 201,
      `${replay.status} ${JSON.stringify(replay.body).slice(0, 400)}`);

    const childCount = await q(`
      select count(*)::int as n from public.publish_intents
       where user_id=${lit(USER_ID)}::uuid
         and prior_intent_id=(select id from public.publish_intents
           where user_id=${lit(USER_ID)}::uuid and intent_id=${lit(String(parent.intentId))});
    `);
    check("E4b and the replay collapsed onto ONE child, not a second",
      Number(rows(childCount.body)[0]?.n) === 1,
      JSON.stringify(rows(childCount.body)[0]));

    // ── E4c: a DIFFERENT second redemption of the same spent proof is refused ─
    // The other half of single-use, and the one that matters for duplicate Pins.
    const secondChild = { ...child, intentId: `${String(child.intentId)}x2` };
    const second = await q(`
      select public.publish_intent_confirm_prepare_v82(
        ${lit(USER_ID)}::uuid, ${jsonLit(secondChild)}, ${lit(childFingerprint)},
        ${lit(CHECK_ID)}::uuid) as result;
    `);
    check("E4c a SECOND, different redemption of the same proof ⇒ retry_not_allowed",
      second.status !== 201 && JSON.stringify(second.body).includes("retry_not_allowed"),
      `${second.status} ${JSON.stringify(second.body).slice(0, 300)}`);
  } finally {
    await cleanup();
    const leftover = await q(`
      select (select count(*) from public.publish_intents
               where user_id=${lit(USER_ID)}::uuid) as intents,
             (select count(*) from public.social_connections
               where user_id=${lit(USER_ID)}::uuid) as connections,
             (select count(*) from public.publish_reconcile_checks
               where owner_user_id=${lit(USER_ID)}::uuid) as checks;`);
    console.log(`\ncleanup: ${JSON.stringify(rows(leftover.body)[0])}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
