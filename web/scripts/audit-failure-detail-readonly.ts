/**
 * audit-failure-detail-readonly.ts — READ ONLY. Drills into the dominant failure
 * message so the root cause is read off the provider's own words rather than
 * inferred from a count.
 *
 * Run: npx tsx scripts/audit-failure-detail-readonly.ts
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
    const json = Buffer.from(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return (JSON.parse(json) as { ref?: string }).ref ?? null;
  } catch { return null; }
}
const mask = (v: unknown) => {
  const s = String(v ?? "");
  return !s ? "(none)" : s.length <= 8 ? `${s.slice(0, 2)}…` : `${s.slice(0, 5)}…${s.slice(-2)}`;
};

async function main() {
  const env = loadEnv(".env.local");
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const ref = refFromKey(key);
  console.log(`target ref: ${ref}`);
  if (ref !== PROD_REF) { console.error("ABORT: not the expected production ref"); process.exit(1); }
  console.log("SELECT ONLY.\n");

  const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL ?? "", key, { auth: { persistSession: false } });

  const { data, error } = await db
    .from("analytics_events")
    .select("draft_id, payload, created_at")
    .eq("event_name", "pinterest_publish_failed")
    .order("created_at", { ascending: false })
    .limit(2000);

  if (error) { console.log(`QUERY ERROR: ${error.code ?? ""} ${error.message}`); process.exit(0); }
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const p = (r: Record<string, unknown>) => (r.payload ?? {}) as Record<string, unknown>;

  console.log("── FULL text of each distinct failure message ─────────────────────────");
  const byMsg = new Map<string, { n: number; code: string; sources: Set<string>; first: string; last: string }>();
  for (const r of rows) {
    const m = String(p(r).errorMessage ?? "(none)");
    const e = byMsg.get(m) ?? { n: 0, code: String(p(r).errorCode ?? ""), sources: new Set<string>(), first: "", last: "" };
    e.n++;
    e.sources.add(String(p(r).source ?? "unknown"));
    const at = String(r.created_at ?? "");
    if (!e.first || at < e.first) e.first = at;
    if (!e.last || at > e.last) e.last = at;
    byMsg.set(m, e);
  }
  [...byMsg.entries()].sort((a, b) => b[1].n - a[1].n).forEach(([m, e]) => {
    console.log(`\n  [${e.n}]  code=${e.code}  sources=${[...e.sources].join(",")}`);
    console.log(`        window: ${e.first.slice(0, 10)} → ${e.last.slice(0, 10)}`);
    console.log(`        "${m}"`);
  });

  // Scheduled failures only: which board / when.
  const sched = rows.filter(r => String(p(r).source ?? "") === "scheduled-cron");
  console.log(`\n── scheduled-cron failures: ${sched.length} ──────────────────────────────`);
  const byBoard = new Map<string, number>();
  for (const r of sched) {
    const b = String(p(r).boardId ?? "(empty)");
    byBoard.set(b, (byBoard.get(b) ?? 0) + 1);
  }
  [...byBoard.entries()].sort((a, b) => b[1] - a[1])
    .forEach(([b, n]) => console.log(`  board ${mask(b).padEnd(12)} ${n} failures`));

  // Most recent scheduled failures, to see whether this is still happening now.
  console.log("\n── 8 most recent scheduled failures ───────────────────────────────────");
  sched.slice(0, 8).forEach(r => {
    console.log(`  ${String(r.created_at).slice(0, 19)}  draft=${mask(r.draft_id)}  code=${p(r).errorCode}`);
  });

  console.log("\nREAD ONLY — no writes issued.");
}
main().catch(e => { console.error("FAILED:", e); process.exit(1); });
