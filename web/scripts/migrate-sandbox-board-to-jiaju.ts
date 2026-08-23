/**
 * migrate-sandbox-board-to-jiaju.ts — retire the Sandbox Demo Board.
 *
 * AUTHORIZED PRODUCTION WRITE (owner instruction, 2026-08-22). Two operations:
 *
 *   1. DELETE 7 named QA/demo drafts (explicit allow-list, no pattern matching).
 *   2. UPDATE the board on FUTURE-PUBLISHABLE drafts still pointing at the
 *      Sandbox Demo Board → 家居 (813814663854885698).
 *
 * Deliberate exclusions, per instruction:
 *   - Anything already POSTED is untouched. Those Pins are live on Pinterest;
 *     rewriting their board would falsify history and cannot move the real post.
 *   - `scheduled_at` is preserved exactly. The Pins publish at their original
 *     time, to 家居.
 *   - targetConnectionId is NOT changed. harrietstudio already owns 家居, so the
 *     account was never the thing that was wrong.
 *   - The 4 drafts failing on a relative imageUrl are NOT board-migrated. Their
 *     defect is the image, not the board, and moving them would dress an
 *     unfixed Pin up as repaired. They carry no scheduled_at, so they are not
 *     retried by the cron either way.
 *
 * Run `--dry-run` first (default). Pass `--apply` to write.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PROD_REF = "jaxteelkecvlozdrdoog";
const SANDBOX_BOARD = "804455620879831103";
const JIAJU_BOARD = "813814663854885698";
const JIAJU_NAME = "家居";

/** Exact ids only — never a pattern, so nothing real can be swept up. */
const DELETE_IDS = [
  "seed_publish_last_week",
  "seed_publish_plan",
  "seed_publish_content",
  "seed_publish_auth",
  "seed_publish_archived",
  "fpt",
  "fpc",
] as const;

const APPLY = process.argv.includes("--apply");

function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw = "";
  try { raw = readFileSync(resolve(process.cwd(), file), "utf8"); } catch { return out; }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !(m[1] in out)) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
function refFromKey(key: string): string | null {
  try {
    const j = Buffer.from(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return (JSON.parse(j) as { ref?: string }).ref ?? null;
  } catch { return null; }
}

async function main() {
  const env = loadEnv(".env.local");
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const ref = refFromKey(key);

  console.log("=".repeat(78));
  console.log(`Sandbox Demo Board retirement — ${APPLY ? "APPLY (writes)" : "DRY RUN (no writes)"}`);
  console.log("=".repeat(78));
  console.log(`target ref: ${ref}`);
  if (ref !== PROD_REF) { console.error(`ABORT: expected ${PROD_REF}`); process.exit(1); }
  console.log("");

  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await db
    .from("pin_drafts")
    .select("vibepin_user_id, draft_id, payload, scheduled_at")
    .is("deleted_at", null)
    .limit(3000);
  if (error) { console.error(`READ FAILED: ${error.message}`); process.exit(1); }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const pl = (r: Record<string, unknown>) => (r.payload ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  // ── 1. deletions ────────────────────────────────────────────────────────
  console.log("── 1. test records to delete ─────────────────────────────────────────");
  const toDelete = rows.filter(r => (DELETE_IDS as readonly string[]).includes(String(r.draft_id)));
  toDelete.forEach(r =>
    console.log(`  ${String(r.draft_id).padEnd(24)} "${s(pl(r).title).slice(0, 40)}"  board="${s(pl(r).boardName)}"`));
  const missing = DELETE_IDS.filter(id => !toDelete.some(r => String(r.draft_id) === id));
  if (missing.length) console.log(`  (not present, nothing to delete: ${missing.join(", ")})`);
  console.log(`  → ${toDelete.length} row(s)`);

  // ── 2. board migration ──────────────────────────────────────────────────
  const deleteSet = new Set(toDelete.map(r => String(r.draft_id)));
  const onSandbox = rows.filter(r => s(pl(r).boardId) === SANDBOX_BOARD && !deleteSet.has(String(r.draft_id)));
  const posted = onSandbox.filter(r => s(pl(r).postedAt));
  const brokenImage = onSandbox.filter(r =>
    !s(pl(r).postedAt) && /imageUrl is not a valid URL/i.test(s(pl(r).publishError)));
  const brokenIds = new Set(brokenImage.map(r => String(r.draft_id)));
  const toMigrate = onSandbox.filter(r => !s(pl(r).postedAt) && !brokenIds.has(String(r.draft_id)));

  console.log("\n── 2. board migration ────────────────────────────────────────────────");
  console.log(`  drafts on Sandbox Demo Board:     ${onSandbox.length}`);
  console.log(`    already POSTED (UNTOUCHED):     ${posted.length}`);
  console.log(`    broken imageUrl (EXCLUDED):     ${brokenImage.length}`);
  console.log(`    → to migrate to 家居:            ${toMigrate.length}`);
  console.log("");
  toMigrate.forEach(r => {
    const acct = s(pl(r).targetAccountLabel) || s(pl(r).targetConnectionId) || "(none pinned)";
    console.log(`  ${String(r.draft_id).padEnd(26)} "${s(pl(r).title).slice(0, 34)}"`);
    console.log(`     acct=${acct}  scheduled_at=${r.scheduled_at ?? "(none)"}`);
  });
  const keepSchedule = toMigrate.filter(r => r.scheduled_at).length;
  console.log(`\n  scheduled_at preserved on: ${keepSchedule} of ${toMigrate.length}`);

  if (!APPLY) {
    console.log("\n" + "=".repeat(78));
    console.log("DRY RUN — nothing was written. Re-run with --apply to execute.");
    console.log("=".repeat(78));
    return;
  }

  // ── execute ─────────────────────────────────────────────────────────────
  console.log("\n── EXECUTING ─────────────────────────────────────────────────────────");

  let deleted = 0;
  for (const r of toDelete) {
    // Soft delete via the tombstone the sync already understands, so the client
    // converges instead of resurrecting the row from local storage on next push.
    const { error: e } = await db
      .from("pin_drafts")
      .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("vibepin_user_id", r.vibepin_user_id)
      .eq("draft_id", r.draft_id);
    if (e) console.error(`  DELETE FAILED ${r.draft_id}: ${e.message}`);
    else { deleted++; console.log(`  tombstoned ${r.draft_id}`); }
  }

  let migrated = 0;
  for (const r of toMigrate) {
    const nowIso = new Date().toISOString();
    // Whole-object payload write: bump updatedAt so the client's LWW merge takes
    // this version instead of pushing the stale board back.
    const next = { ...pl(r), boardId: JIAJU_BOARD, boardName: JIAJU_NAME, updatedAt: nowIso };
    const { error: e } = await db
      .from("pin_drafts")
      .update({ payload: next, updated_at: nowIso })   // scheduled_at deliberately NOT touched
      .eq("vibepin_user_id", r.vibepin_user_id)
      .eq("draft_id", r.draft_id);
    if (e) console.error(`  MIGRATE FAILED ${r.draft_id}: ${e.message}`);
    else { migrated++; console.log(`  ${r.draft_id} → 家居`); }
  }

  console.log(`\n  deleted(tombstoned): ${deleted}   migrated: ${migrated}`);

  // ── verify ──────────────────────────────────────────────────────────────
  console.log("\n── VERIFY (re-read) ──────────────────────────────────────────────────");
  const { data: after } = await db
    .from("pin_drafts").select("draft_id, payload, scheduled_at").is("deleted_at", null).limit(3000);
  const a = (after ?? []) as Array<Record<string, unknown>>;
  const stillSandboxFuture = a.filter(r =>
    s(pl(r).boardId) === SANDBOX_BOARD && !s(pl(r).postedAt) && r.scheduled_at);
  console.log(`  future scheduled Pins STILL on Sandbox board: ${stillSandboxFuture.length}`);
  stillSandboxFuture.forEach(r => console.log(`     !! ${r.draft_id} ${r.scheduled_at}`));
  const nowJiaju = a.filter(r => s(pl(r).boardId) === JIAJU_BOARD);
  console.log(`  drafts now on 家居: ${nowJiaju.length}`);
  console.log(`  of which still scheduled: ${nowJiaju.filter(r => r.scheduled_at && !s(pl(r).postedAt)).length}`);
  const gone = DELETE_IDS.filter(id => !a.some(r => String(r.draft_id) === id));
  console.log(`  test records confirmed gone: ${gone.length}/${DELETE_IDS.length}`);

  console.log("\n" + "=".repeat(78));
  console.log("DONE. Posted Pins and their live Pinterest posts were not touched.");
  console.log("=".repeat(78));
}
main().catch(e => { console.error("FAILED:", e); process.exit(1); });
