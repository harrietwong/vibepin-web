/**
 * assign-board-and-schedule.ts — give the remaining ready drafts a board and a
 * publish time.
 *
 * These drafts have a valid absolute image and no failure, but no board, so the
 * due scan can never publish them. The owner chose 家居 for all of them, on the
 * account the working Pins already use.
 *
 * Times follow the cadence already on the calendar (01:38 / 02:23 / 07:05 /
 * 13:31 UTC), starting after the last existing schedule so nothing collides.
 *
 * Safety:
 *   - DRY RUN by default; writes only with an explicit --apply.
 *   - Asserts the production project ref first.
 *   - Refuses anything not genuinely ready: image must be absolute http(s), and
 *     the draft must not be posted, failed, archived, or already scheduled.
 *   - Never assigns a time in the past.
 *   - Never overwrites a board that is already set — this only fills blanks.
 *   - Writes payload scheduling fields AND the promoted scheduled_at column,
 *     because the cron scans the column while the client reads the payload.
 *
 * Run:  npx tsx scripts/assign-board-and-schedule.ts           (dry run)
 *       npx tsx scripts/assign-board-and-schedule.ts --apply   (writes)
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PROD_REF = "jaxteelkecvlozdrdoog";
const APPLY = process.argv.includes("--apply");

const JIAJU_BOARD = "813814663854885698";
const JIAJU_NAME = "家居";
/** harrietstudio — the account every working Pin already publishes as. */
const ACCOUNT_ID = "6f932264-f184-4a94-8db2-722460422b77";
const ACCOUNT_LABEL = "5522278466b6972";

/** The established daily slots, UTC. */
const SLOTS = ["01:38", "02:23", "07:05", "13:31"];
/** First day to fill. The existing run ends 8/27 02:23, so start after it. */
const START_DATE = "2026-08-27";

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

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const env = loadEnv(".env.local");
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const ref = refFromKey(key);
  const now = Date.now();

  console.log("=".repeat(78));
  console.log(`Assign 家居 board + schedule — ${APPLY ? "APPLY (WRITES)" : "DRY RUN"}`);
  console.log("=".repeat(78));
  console.log(`target ref: ${ref}`);
  if (ref !== PROD_REF) { console.error("ABORT"); process.exit(1); }
  console.log(`board: "${JIAJU_NAME}" ${JIAJU_BOARD}   account: @${ACCOUNT_LABEL}\n`);

  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await db
    .from("pin_drafts")
    .select("vibepin_user_id, draft_id, payload, scheduled_at")
    .is("deleted_at", null)
    .limit(3000);
  if (error) { console.error(`QUERY ERROR: ${error.message}`); process.exit(1); }

  const rows = (data ?? []) as Array<Record<string, unknown>>;

  // Occupied slots, so new times never collide with an existing schedule.
  const taken = new Set(
    rows.filter(r => r.scheduled_at).map(r => String(r.scheduled_at).slice(0, 16)),
  );

  const candidates = rows.filter(r => {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    return !str(p.postedAt) && !str(p.publishError) && !str(p.archivedAt)
      && !r.scheduled_at && !str(p.boardId)
      && /^https?:\/\//i.test(str(p.imageUrl));
  });

  console.log(`drafts with a good image but no board and no schedule: ${candidates.length}\n`);

  // Build the next free slots.
  const slots: string[] = [];
  for (let day = 0; slots.length < candidates.length && day < 30; day++) {
    const date = addDays(START_DATE, day);
    for (const t of SLOTS) {
      const iso = `${date}T${t}:00.000Z`;
      if (taken.has(iso.slice(0, 16))) continue;
      if (Date.parse(iso) <= now) continue;
      slots.push(iso);
      if (slots.length >= candidates.length) break;
    }
  }

  let done = 0, refused = 0;

  for (let i = 0; i < candidates.length; i++) {
    const r = candidates[i];
    const p = (r.payload ?? {}) as Record<string, unknown>;
    const id = String(r.draft_id);
    const due = slots[i];
    const title = str(p.title).slice(0, 40);

    if (!due) {
      refused++;
      console.log(`  REFUSE ${id.padEnd(26)} no free slot could be allocated`);
      continue;
    }

    console.log(`  ${APPLY ? "SET  " : "WOULD"}  ${id.padEnd(26)} "${title}"`);
    console.log(`         due:   ${due.slice(0, 16)} UTC  (Beijing ${new Date(Date.parse(due) + 8 * 3600e3).toISOString().slice(11, 16)} ${new Date(Date.parse(due) + 8 * 3600e3).toISOString().slice(5, 10)})`);

    if (APPLY) {
      const next: Record<string, unknown> = {
        ...p,
        boardId: JIAJU_BOARD,
        boardName: JIAJU_NAME,
        targetConnectionId: str(p.targetConnectionId) || ACCOUNT_ID,
        targetAccountLabel: str(p.targetAccountLabel) || ACCOUNT_LABEL,
        scheduledDate: due.slice(0, 10),
        scheduledTime: due.slice(11, 16),
        plannedAt: `${due.slice(0, 10)}T${due.slice(11, 16)}`,
        addedToPlanAt: str(p.addedToPlanAt) || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const { error: upErr } = await db
        .from("pin_drafts")
        .update({
          payload: next,
          updated_at: next.updatedAt as string,
          scheduled_at: due,
          publish_claimed_at: null,
        })
        .eq("vibepin_user_id", r.vibepin_user_id as string)
        .eq("draft_id", id);
      if (upErr) { console.log(`         WRITE FAILED: ${upErr.message}`); continue; }
    }
    done++;
  }

  console.log(`\n${"─".repeat(78)}`);
  console.log(`  ${APPLY ? "scheduled" : "would schedule"}: ${done}`);
  console.log(`  refused: ${refused}`);
  if (!APPLY) console.log("\n  DRY RUN — nothing was written.");

  if (APPLY) {
    const { data: after } = await db
      .from("pin_drafts")
      .select("draft_id, payload, scheduled_at")
      .is("deleted_at", null)
      .not("scheduled_at", "is", null)
      .order("scheduled_at", { ascending: true });
    console.log("\n  VERIFY — full upcoming schedule:");
    (after ?? []).forEach(r => {
      const row = r as Record<string, unknown>;
      const p = (row.payload ?? {}) as Record<string, unknown>;
      console.log(`     ${String(row.scheduled_at).slice(0, 16)}  "${str(p.boardName)}"  ${str(p.title).slice(0, 34)}`);
    });
    const noBoard = (after ?? []).filter(r => {
      const p = ((r as Record<string, unknown>).payload ?? {}) as Record<string, unknown>;
      return !str(p.boardId);
    });
    console.log(`\n  scheduled Pins with NO board: ${noBoard.length}`);
  }
  console.log("=".repeat(78));
}
main().catch(e => { console.error("FAILED:", e); process.exit(1); });
