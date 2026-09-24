/**
 * Proves a RESTORED draft can pass the v78 publish-receipt gate.
 *
 * Context. A neighbouring session hit `invalid_publish_receipt` (SQLSTATE 22023)
 * from `publish_intent_confirm_prepare_v78` while publishing a canary whose media
 * was correctly registered. That rejection comes from the RPC's own
 * fingerprint/structure validation, not from provenance, so registering media
 * does not by itself prove a draft is publishable. Their canary hand-assembled
 * its receipt; the cron does not. If the restored batch shared the defect it
 * would surface as a mass failure starting 2026-09-25T01:00Z, so it is worth an
 * hour of certainty now rather than a queue-wide failure then.
 *
 * What this checks. One already-restored draft is read from the database and run
 * through the exact path the cron uses — `buildDueVideoReceipt` with the real
 * `draft_id` / `updated_at` / `scheduled_at` / `payload`, then
 * `videoPublishSourceIdentityFingerprint`, then
 * `publish_intent_confirm_prepare_v78`. Nothing about the receipt is
 * hand-written, because a hand-written receipt is the very thing that failed for
 * the canary and would make a pass here meaningless.
 *
 * What this is NOT. No provider call, no Pinterest request, no publish. The probe
 * stops at `prepared`, which is the gate in question.
 *
 * Side effects. `confirm_prepare` durably creates an intent graph, so this leaves
 * the database dirty unless cleaned. Cleanup is scoped to the single intent id
 * this run creates — never by owner, because the owner is the real production-like
 * account whose other rows must survive untouched. Cleanup runs even on failure,
 * and the probe re-reads afterwards to prove zero residue.
 *
 * Read-only with respect to the draft itself: the draft row is never modified.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROD_REF = "jaxteelkecvlozdrdoog";
const TEST_REF = "snulmwprsahzqvdbyenc";
const OWNER_USER_ID = "4cf569cd-1f20-404d-93d7-1e2c0b8a7251";
/** One of the eleven restored drafts; the earliest to fire, so the most urgent. */
const PROBE_DRAFT_ID = process.argv.includes("--draft-id")
  ? process.argv[process.argv.indexOf("--draft-id") + 1]
  : "cheerish_ba6243a97914b7cd27ee67b91fdd7a0ff00136fa1fac0ad3164e9165";

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
// A worktree usually has no `backend/.env.migration` of its own (it is
// gitignored and lives in the primary checkout), so allow an explicit path.
const tokenPathArg = process.argv.includes("--migration-env")
  ? process.argv[process.argv.indexOf("--migration-env") + 1]
  : "";
const TOKEN = loadEnv(tokenPathArg || join(ROOT, "backend", ".env.migration"), "SUPABASE_MIGRATION_TOKEN")
  || loadEnv("D:/代码/Pinterest flow/backend/.env.migration", "SUPABASE_MIGRATION_TOKEN");
if (!TOKEN) { console.error("SUPABASE_MIGRATION_TOKEN missing (pass --migration-env <path>)"); process.exit(1); }

console.log("=".repeat(70));
console.log(`TARGET project_ref : ${TEST_REF}`);
console.log(`PRODUCTION ref     : ${PROD_REF}`);
assert.notEqual(TEST_REF, PROD_REF, "ABORT: target is production");
console.log("ASSERTION OK: target != production. Proceeding.");
console.log(`probe draft        : ${PROBE_DRAFT_ID}`);
console.log("=".repeat(70));

async function q(sql: string): Promise<{ status: number; body: unknown }> {
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const res = await fetch(`https://api.supabase.com/v1/projects/${TEST_REF}/database/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: sql }),
      });
      const text = await res.text();
      let body: unknown;
      try { body = JSON.parse(text || "[]"); } catch { body = text; }
      return { status: res.status, body };
    } catch (error) { last = error; await new Promise((r) => setTimeout(r, 1_500 * (attempt + 1))); }
  }
  throw new Error(`query_failed:${last instanceof Error ? last.message : String(last)}`);
}
const lit = (v: string) => `'${v.replaceAll("'", "''")}'`;
const jsonLit = (v: unknown) => `${lit(JSON.stringify(v))}::jsonb`;

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? `\n        ${detail}` : ""}`); }
  else { failed += 1; console.log(`  FAIL  ${name}\n        ${detail}`); }
}

/**
 * Removes only the graph this probe created, keyed on the single intent id.
 * Children first — the FKs are ON DELETE RESTRICT. Deliberately never scoped by
 * owner_user_id: this account owns the real restored drafts and their history.
 */
async function cleanupIntent(intentId: string): Promise<{ status: number; body: unknown }> {
  return q(`
    delete from public.pinterest_publish_evidence
     where publish_intent_id in (select id from public.publish_intents where intent_id=${lit(intentId)});
    delete from public.provider_publish_attempts
     where publish_intent_id in (select id from public.publish_intents where intent_id=${lit(intentId)});
    delete from public.publish_asset_delivery_items
     where delivery_id in (select id from public.publish_asset_deliveries
       where publish_intent_id in (select id from public.publish_intents where intent_id=${lit(intentId)}));
    delete from public.publish_asset_deliveries
     where publish_intent_id in (select id from public.publish_intents where intent_id=${lit(intentId)});
    delete from public.publish_assets
     where publish_intent_id in (select id from public.publish_intents where intent_id=${lit(intentId)});
    delete from public.publish_intent_destinations
     where publish_intent_id in (select id from public.publish_intents where intent_id=${lit(intentId)});
    delete from public.publish_intents where intent_id=${lit(intentId)};
  `);
}

(async () => {
  // ── Read the real restored draft; never modify it ─────────────────────────
  const draftRow = await q(`
    select draft_id, updated_at, scheduled_at, payload
      from public.pin_drafts
     where vibepin_user_id=${lit(OWNER_USER_ID)}::uuid
       and draft_id=${lit(PROBE_DRAFT_ID)}
     limit 1;
  `);
  const row = (draftRow.body as Array<Record<string, unknown>>)?.[0];
  check("probe draft found in the database", !!row, `status=${draftRow.status}`);
  if (!row) { console.log("\nBLOCKED: probe draft not found."); process.exit(1); }
  // Control mode: a draft that ALREADY published successfully has had its
  // scheduled_at cleared, so one must be supplied to rebuild the receipt the
  // cron built at the time. If the same probe rejects a known-good draft, the
  // defect is in this probe, not in the restored batch.
  const scheduledOverride = process.argv.includes("--scheduled-at")
    ? process.argv[process.argv.indexOf("--scheduled-at") + 1]
    : "";
  const effectiveScheduledAt = String(row.scheduled_at ?? "") || scheduledOverride;
  check("draft has a scheduled_at to build a receipt from",
    !!effectiveScheduledAt,
    `scheduled_at=${row.scheduled_at ?? "null"}${scheduledOverride ? ` override=${scheduledOverride}` : ""}`);
  if (!effectiveScheduledAt) { console.log("\nBLOCKED: no scheduled_at (pass --scheduled-at for a published control)."); process.exit(1); }

  // ── Build the receipt with the REAL cron code path ────────────────────────
  const { buildDueVideoReceipt } = await import("../src/lib/server/publish/v76PinterestVideoBindings");
  const { videoPublishSourceIdentityFingerprint } = await import("../src/lib/server/publish/v76PinterestVideoPublish");

  let receipt: Record<string, unknown>;
  try {
    receipt = buildDueVideoReceipt({
      draftId: String(row.draft_id),
      updatedAt: String(row.updated_at),
      scheduledAt: effectiveScheduledAt,
      payload: row.payload as Record<string, unknown>,
    }) as unknown as Record<string, unknown>;
  } catch (error) {
    check("receipt construction via buildDueVideoReceipt", false, (error as Error).message);
    console.log("\nBLOCKED before reaching the database.");
    process.exit(1);
  }
  const destinations = receipt.publishableDestinations as Array<Record<string, unknown>> | undefined;
  check("receipt built by real cron code and names a publishable destination",
    Array.isArray(destinations) && destinations.length > 0,
    `intentId=${receipt.intentId} destinations=${JSON.stringify(destinations?.map((d) => d.id))}`);
  if (!destinations?.length) { console.log("\nBLOCKED: no publishable destination."); process.exit(1); }

  const fingerprint = videoPublishSourceIdentityFingerprint(receipt as never);
  const intentId = String(receipt.intentId);

  // Start clean in case an earlier interrupted run left this exact intent behind.
  await cleanupIntent(intentId);

  let prepared: { status: number; body: unknown } | null = null;
  try {
    // ── The gate under test ─────────────────────────────────────────────────
    prepared = await q(`
      select public.publish_intent_confirm_prepare_v78(
        ${lit(OWNER_USER_ID)}::uuid, ${jsonLit(receipt)}, ${lit(fingerprint)}) as result;
    `);
    const text = JSON.stringify(prepared.body);
    const rejectedAsInvalid = text.includes("invalid_publish_receipt") || text.includes("22023");
    check("v78 confirm_prepare ACCEPTS the restored draft's receipt",
      prepared.status === 201 && !rejectedAsInvalid,
      `status=${prepared.status} ${text.slice(0, 320)}`);
    check("not rejected with invalid_publish_receipt (the canary's failure mode)",
      !rejectedAsInvalid, rejectedAsInvalid ? text.slice(0, 320) : "no 22023 / invalid_publish_receipt in response");
  } finally {
    // ── Zero residue, even if the gate rejected ─────────────────────────────
    const cleaned = await cleanupIntent(intentId);
    const leftover = await q(`
      select
        (select count(*) from public.publish_intents where intent_id=${lit(intentId)}) as intents,
        (select count(*) from public.publish_assets
          where publish_intent_id in (select id from public.publish_intents where intent_id=${lit(intentId)})) as assets;
    `);
    const counts = (leftover.body as Array<Record<string, unknown>>)?.[0];
    const zero = Number(counts?.intents ?? -1) === 0 && Number(counts?.assets ?? -1) === 0;
    check("cleanup left zero residue for this probe's intent", zero,
      `cleanup_status=${cleaned.status} leftover=${JSON.stringify(counts)}`);
    // The draft itself must be exactly as we found it.
    const after = await q(`
      select scheduled_at, updated_at from public.pin_drafts
       where vibepin_user_id=${lit(OWNER_USER_ID)}::uuid and draft_id=${lit(PROBE_DRAFT_ID)} limit 1;
    `);
    const afterRow = (after.body as Array<Record<string, unknown>>)?.[0];
    const untouched = String(afterRow?.scheduled_at) === String(row.scheduled_at)
      && String(afterRow?.updated_at) === String(row.updated_at);
    check("probe did not modify the draft", untouched,
      `scheduled_at=${afterRow?.scheduled_at} updated_at=${afterRow?.updated_at}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log("\nSTOP: the restored batch may share the canary's receipt defect.");
    console.log("Do not let 2026-09-25T01:00Z arrive before this is understood.");
  }
  process.exit(failed ? 1 : 0);
})();
