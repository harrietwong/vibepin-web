/**
 * audit-failure-timeline-readonly.ts — READ ONLY follow-up to the failure audit.
 *
 * The first audit showed cron attempts and provider failures. This answers the
 * remaining questions: are the failures still happening, is any single Pin being
 * retried forever, and which error dominates in the RECENT window (as opposed to
 * the whole 4-week history, where an old fixed cause can drown out a live one).
 *
 * SELECT-only. No insert/update/delete/rpc appears in this file.
 *
 * Run: npx tsx scripts/audit-failure-timeline-readonly.ts
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
  return !s ? "(none)" : s.length <= 8 ? `${s.slice(0, 2)}…` : `${s.slice(0, 6)}…${s.slice(-2)}`;
};
function tally(rows: Array<Record<string, unknown>>, k: (r: Record<string, unknown>) => string) {
  const o: Record<string, number> = {};
  for (const r of rows) { const key = k(r); o[key] = (o[key] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
}

async function main() {
  const env = loadEnv(".env.local");
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const ref = refFromKey(key);
  console.log("=".repeat(74));
  console.log("READ-ONLY — failure timeline / recency");
  console.log("=".repeat(74));
  console.log(`target ref: ${ref}`);
  if (ref !== PROD_REF) { console.error("ABORT: not the production ref"); process.exit(1); }
  console.log("SELECT ONLY.\n");

  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await db
    .from("analytics_events")
    .select("event_name, draft_id, payload, created_at")
    .in("event_name", ["pinterest_publish_attempted", "pinterest_publish_succeeded", "pinterest_publish_failed"])
    .order("created_at", { ascending: true })
    .limit(5000);
  if (error) { console.log(`QUERY ERROR: ${error.code ?? ""} ${error.message}`); process.exit(0); }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const p = (r: Record<string, unknown>) => (r.payload ?? {}) as Record<string, unknown>;
  const failed = rows.filter(r => r.event_name === "pinterest_publish_failed");
  const sched = failed.filter(r => String(p(r).source ?? "") === "scheduled-cron");

  // ── recency: is this live or historical? ────────────────────────────────
  const now = Date.now();
  const within = (rs: Array<Record<string, unknown>>, days: number) =>
    rs.filter(r => now - Date.parse(String(r.created_at)) <= days * 864e5);

  console.log("── is this still happening? ───────────────────────────────────────────");
  for (const d of [1, 3, 7, 14]) {
    const f = within(failed, d);
    const s = within(sched, d);
    console.log(`  last ${String(d).padStart(2)}d: ${String(f.length).padStart(3)} failures  (${s.length} scheduled)`);
  }

  console.log("\n── error codes in the LAST 7 DAYS (scheduled only) ────────────────────");
  const recent = within(sched, 7);
  console.log(`  ${JSON.stringify(tally(recent, r => String(p(r).errorCode ?? "(none)")))}`);
  console.log("\n── error MESSAGES in the last 7 days (scheduled only) ─────────────────");
  Object.entries(tally(recent, r => String(p(r).errorMessage ?? "").slice(0, 95)))
    .forEach(([m, n]) => console.log(`  ${String(n).padStart(3)}  ${m}`));

  // ── per-Pin: is one Pin retried forever? ────────────────────────────────
  console.log("\n── worst offenders: scheduled failures per Pin ────────────────────────");
  const perPin = tally(sched.filter(r => r.draft_id), r => String(r.draft_id));
  Object.entries(perPin).slice(0, 10).forEach(([id, n]) => {
    const mine = sched.filter(r => String(r.draft_id) === id);
    const codes = [...new Set(mine.map(r => String(p(r).errorCode ?? "")))].join(",");
    const first = String(mine[0].created_at).slice(0, 10);
    const last = String(mine[mine.length - 1].created_at).slice(0, 10);
    console.log(`  ${mask(id)}  ${String(n).padStart(3)} fails  ${first} → ${last}  [${codes}]`);
  });

  // ── boards implicated ───────────────────────────────────────────────────
  console.log("\n── boards in scheduled failures (masked) ──────────────────────────────");
  Object.entries(tally(sched, r => mask(p(r).boardId))).forEach(([b, n]) => {
    const mine = sched.filter(r => mask(p(r).boardId) === b);
    const codes = [...new Set(mine.map(r => String(p(r).errorCode ?? "")))].join(",");
    console.log(`  board ${b.padEnd(12)} ${String(n).padStart(3)} fails  [${codes}]`);
  });

  // ── did the ONE scheduled success prove the path works? ─────────────────
  const schedOk = rows.filter(r =>
    r.event_name === "pinterest_publish_succeeded" && String(p(r).source ?? "") === "scheduled-cron");
  console.log("\n── scheduled successes ────────────────────────────────────────────────");
  console.log(`  count: ${schedOk.length}`);
  schedOk.forEach(r => console.log(`  ${String(r.created_at).slice(0, 19)}  draft ${mask(r.draft_id)}  board ${mask(p(r).boardId)}`));

  console.log("\n" + "=".repeat(74));
  console.log("READ ONLY — no INSERT / UPDATE / DELETE / DDL was issued.");
  console.log("=".repeat(74));
}
main().catch(e => { console.error("AUDIT FAILED:", e); process.exit(1); });
