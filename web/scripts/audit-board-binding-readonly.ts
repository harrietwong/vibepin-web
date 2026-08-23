/**
 * audit-board-binding-readonly.ts — READ ONLY: which board are the failing
 * scheduled Pins pointing at, and is it reachable by the account they name?
 *
 * The timeline audit isolated 96 of 97 scheduled failures onto ONE board id,
 * currently failing as `board_not_owned`. This checks the stored drafts to see
 * whether that board is still what they are scheduled to, and whether the
 * account pinned on those drafts is the same one that owns the working board.
 *
 * SELECT-only: no insert/update/delete/rpc appears in this file, and no
 * Pinterest API call is made (that would be a side effect on a live account).
 *
 * Run: npx tsx scripts/audit-board-binding-readonly.ts
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PROD_REF = "jaxteelkecvlozdrdoog";

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
const mask = (v: unknown) => {
  const s = String(v ?? "");
  return !s ? "(empty)" : s.length <= 8 ? `${s.slice(0, 2)}…` : `${s.slice(0, 6)}…${s.slice(-2)}`;
};
function tally<T>(items: T[], k: (x: T) => string) {
  const o: Record<string, number> = {};
  for (const x of items) { const key = k(x); o[key] = (o[key] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
}

async function main() {
  const env = loadEnv(".env.local");
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const ref = refFromKey(key);
  console.log("=".repeat(74));
  console.log("READ-ONLY — board / account binding on scheduled Pins");
  console.log("=".repeat(74));
  console.log(`target ref: ${ref}`);
  if (ref !== PROD_REF) { console.error("ABORT: not production ref"); process.exit(1); }
  console.log("SELECT ONLY. No Pinterest API calls.\n");

  const db = createClient(url, key, { auth: { persistSession: false } });

  // ── the drafts themselves ────────────────────────────────────────────────
  const { data: drafts, error } = await db
    .from("pin_drafts")
    .select("draft_id, payload, scheduled_at, publish_claimed_at, deleted_at, archived_at")
    .is("deleted_at", null)
    .limit(3000);
  if (error) { console.log(`QUERY ERROR: ${error.code ?? ""} ${error.message}`); process.exit(0); }

  const rows = (drafts ?? []) as Array<Record<string, unknown>>;
  const pl = (r: Record<string, unknown>) => (r.payload ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  console.log("── draft population ───────────────────────────────────────────────────");
  console.log(`  live drafts                 ${rows.length}`);

  const failedDrafts = rows.filter(r => str(pl(r).failureType) === "publish" && str(pl(r).publishError));
  const posted = rows.filter(r => str(pl(r).postedAt));
  const stillScheduled = rows.filter(r => r.scheduled_at && !str(pl(r).postedAt));
  console.log(`  publish-failed (UI counts)  ${failedDrafts.length}`);
  console.log(`  posted                      ${posted.length}`);
  console.log(`  still scheduled (due scan)  ${stillScheduled.length}`);

  // ── §1.6: does the UI count Pins or attempts? ───────────────────────────
  console.log("\n── does the failed count double-count retries? ────────────────────────");
  console.log(`  distinct failed DRAFTS      ${new Set(failedDrafts.map(r => r.draft_id)).size}`);
  console.log("  (the UI predicate reads one draft's current failureType/publishError,");
  console.log("   so a Pin retried 6 times still contributes exactly 1)");

  // ── which board do the failing drafts name? ─────────────────────────────
  console.log("\n── boards named by publish-failed drafts ──────────────────────────────");
  Object.entries(tally(failedDrafts, r => mask(pl(r).boardId))).forEach(([b, n]) =>
    console.log(`  board ${b.padEnd(12)} ${String(n).padStart(3)} drafts`));

  console.log("\n── accounts pinned on publish-failed drafts ───────────────────────────");
  Object.entries(tally(failedDrafts, r => mask(pl(r).targetConnectionId))).forEach(([a, n]) =>
    console.log(`  account ${a.padEnd(12)} ${String(n).padStart(3)} drafts`));

  // ── the working board, for contrast ─────────────────────────────────────
  console.log("\n── boards on drafts that DID publish ──────────────────────────────────");
  Object.entries(tally(posted, r => mask(pl(r).boardId))).slice(0, 6).forEach(([b, n]) =>
    console.log(`  board ${b.padEnd(12)} ${String(n).padStart(3)} drafts`));

  // ── §4.8: are the failing drafts' images still resolvable? ──────────────
  console.log("\n── image field on publish-failed drafts (expiry hypothesis) ───────────");
  const shape = (u: string) =>
    !u ? "(empty)"
      : u.startsWith("data:") ? "data:"
      : u.startsWith("blob:") ? "blob:"
      : u.includes("/storage/v1/object/public/") ? "supabase public (durable)"
      : u.includes("token=") || u.includes("X-Amz-") || u.includes("Expires=") ? "SIGNED / EXPIRING"
      : u.includes("i.pinimg.com") ? "pinterest CDN"
      : u.startsWith("http") ? "other http"
      : "other";
  Object.entries(tally(failedDrafts, r => shape(str(pl(r).imageUrl)))).forEach(([s, n]) =>
    console.log(`  ${s.padEnd(28)} ${String(n).padStart(3)} drafts`));

  // ── §7: QA / demo contamination ─────────────────────────────────────────
  console.log("\n── QA / demo contamination check ──────────────────────────────────────");
  const marker = (r: Record<string, unknown>) => {
    const t = `${str(pl(r).title)} ${str(pl(r).keyword)} ${str(pl(r).boardName)}`.toLowerCase();
    if (/sandbox/.test(t)) return "sandbox-named";
    if (/^qa|qa /.test(t) || /fixture/.test(t)) return "QA fixture";
    if (/demo/.test(t)) return "demo";
    if (/^tc_?pin|tcpin/.test(t)) return "test-case fixture";
    return "real content";
  };
  Object.entries(tally(failedDrafts, marker)).forEach(([m, n]) =>
    console.log(`  ${m.padEnd(20)} ${String(n).padStart(3)} drafts`));
  const sandboxErr = failedDrafts.filter(r => /sandbox/i.test(str(pl(r).publishError)));
  console.log(`  drafts whose ERROR mentions sandbox: ${sandboxErr.length}`);

  // ── current error text on the failed drafts ─────────────────────────────
  console.log("\n── current publishError on failed drafts ──────────────────────────────");
  Object.entries(tally(failedDrafts, r => str(pl(r).publishError).slice(0, 70) || "(empty)"))
    .forEach(([m, n]) => console.log(`  ${String(n).padStart(3)}  ${m}`));

  console.log("\n" + "=".repeat(74));
  console.log("READ ONLY — no INSERT / UPDATE / DELETE / DDL was issued.");
  console.log("=".repeat(74));
}
main().catch(e => { console.error("AUDIT FAILED:", e); process.exit(1); });
