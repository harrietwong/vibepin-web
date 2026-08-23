/**
 * reschedule-repaired-drafts.ts — put the repaired drafts back on the calendar.
 *
 * Five drafts had their image URL repaired and their stale failure cleared. They
 * carry no scheduled_at, so the due scan will never pick them up. This assigns
 * the times the owner chose.
 *
 * Two of them go out today as a live test of whether auto-publish works after
 * the board migration; the rest are deliberately placed after the existing
 * 8/23-8/26 run, so the already-scheduled Pins prove the fix first.
 *
 * Safety:
 *   - DRY RUN by default; writes only with an explicit --apply.
 *   - Asserts the production project ref first.
 *   - Refuses any draft that is not actually ready: image must be an absolute
 *     http(s) URL, a board must be set, and it must not already be posted or
 *     carrying a failure. Scheduling a Pin that cannot publish would just
 *     manufacture a fresh failure.
 *   - Refuses a time in the past — that would fire on the very next scan
 *     instead of when intended.
 *   - Writes payload.scheduledDate/scheduledTime/plannedAt AND the promoted
 *     scheduled_at column, because the cron scans the column while the client
 *     reads the payload; setting only one leaves the two disagreeing.
 *
 * Run:  npx tsx scripts/reschedule-repaired-drafts.ts           (dry run)
 *       npx tsx scripts/reschedule-repaired-drafts.ts --apply   (writes)
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PROD_REF = "jaxteelkecvlozdrdoog";
const APPLY = process.argv.includes("--apply");

/** Retired: not owned by the publishing account. Nothing may be scheduled onto it. */
const SANDBOX_BOARD_ID = "804455620879831103";

/** draft_id → due instant (UTC). Chosen by the owner. */
const PLAN: Record<string, string> = {
  // Today — live test that auto-publish works end to end.
  pd_1780637912995_kt28x3: "2026-08-23T04:00:00.000Z", // Beijing 12:00
  pd_1780637912995_sq7gqn: "2026-08-23T13:31:00.000Z", // the free slot today
  // After the existing 8/23-8/26 run, on the established cadence.
  pd_1783415183899_6z92sp: "2026-08-27T01:38:00.000Z",
  pd_1783415183856_ds6obe: "2026-08-27T02:23:00.000Z",
  pd_1783817624468_ha0fj8: "2026-08-27T07:05:00.000Z",
};

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
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

async function main() {
  const env = loadEnv(".env.local");
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const ref = refFromKey(key);
  const now = Date.now();

  console.log("=".repeat(78));
  console.log(`Reschedule repaired drafts — ${APPLY ? "APPLY (WRITES)" : "DRY RUN"}`);
  console.log("=".repeat(78));
  console.log(`target ref: ${ref}`);
  if (ref !== PROD_REF) { console.error("ABORT"); process.exit(1); }
  console.log(`now: ${new Date(now).toISOString().slice(0, 16)} UTC\n`);

  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await db
    .from("pin_drafts")
    .select("vibepin_user_id, draft_id, payload, scheduled_at")
    .in("draft_id", Object.keys(PLAN));
  if (error) { console.error(`QUERY ERROR: ${error.message}`); process.exit(1); }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  console.log(`found ${rows.length} of ${Object.keys(PLAN).length} drafts\n`);

  let scheduled = 0, refused = 0;

  for (const r of rows) {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    const id = String(r.draft_id);
    const due = PLAN[id];
    const title = str(p.title).slice(0, 34);

    const problems: string[] = [];
    if (!/^https?:\/\//i.test(str(p.imageUrl))) problems.push("image is not an absolute URL");
    if (!str(p.boardId)) problems.push("no board");
    // The retired Sandbox board is not owned by the publishing account, so
    // scheduling onto it would guarantee board_not_owned at due time.
    if (str(p.boardId) === SANDBOX_BOARD_ID) problems.push("still points at the retired Sandbox board");
    if (str(p.postedAt)) problems.push("already posted");
    if (str(p.publishError)) problems.push(`still carries a failure: ${str(p.publishError).slice(0, 40)}`);
    if (Date.parse(due) <= now) problems.push("the chosen time is in the past");

    if (problems.length) {
      refused++;
      console.log(`  REFUSE ${id.padEnd(26)} "${title}"`);
      problems.forEach(x => console.log(`         - ${x}`));
      continue;
    }

    const d = new Date(due);
    const dateStr = due.slice(0, 10);
    const timeStr = due.slice(11, 16);

    console.log(`  ${APPLY ? "SET  " : "WOULD"}  ${id.padEnd(26)} "${title}"`);
    console.log(`         due:   ${due.slice(0, 16)} UTC  (Beijing ${new Date(d.getTime() + 8 * 3600e3).toISOString().slice(11, 16)})`);
    console.log(`         board: "${str(p.boardName)}"  ${str(p.boardId)}`);

    if (APPLY) {
      const next: Record<string, unknown> = {
        ...p,
        scheduledDate: dateStr,
        scheduledTime: timeStr,
        plannedAt: `${dateStr}T${timeStr}`,
        addedToPlanAt: str(p.addedToPlanAt) || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const { error: upErr } = await db
        .from("pin_drafts")
        .update({
          payload: next,
          updated_at: next.updatedAt as string,
          scheduled_at: due,          // the column the cron actually scans
          publish_claimed_at: null,   // a fresh schedule must not inherit an old claim
        })
        .eq("vibepin_user_id", r.vibepin_user_id as string)
        .eq("draft_id", id);
      if (upErr) { console.log(`         WRITE FAILED: ${upErr.message}`); continue; }
    }
    scheduled++;
  }

  console.log(`\n${"─".repeat(78)}`);
  console.log(`  ${APPLY ? "scheduled" : "would schedule"}: ${scheduled}`);
  console.log(`  refused: ${refused}`);
  if (!APPLY) console.log("\n  DRY RUN — nothing was written.");

  if (APPLY) {
    const { data: after } = await db
      .from("pin_drafts")
      .select("draft_id, scheduled_at, payload")
      .in("draft_id", Object.keys(PLAN));
    console.log("\n  VERIFY:");
    (after ?? []).forEach(r => {
      const row = r as Record<string, unknown>;
      const p = (row.payload ?? {}) as Record<string, unknown>;
      console.log(`     ${String(row.draft_id).padEnd(26)} scheduled_at=${row.scheduled_at ?? "(none)"}  payload.plannedAt=${str(p.plannedAt) || "(none)"}`);
    });
  }
  console.log("=".repeat(78));
}
main().catch(e => { console.error("FAILED:", e); process.exit(1); });
