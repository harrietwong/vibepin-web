/**
 * audit-board-names-readonly.ts — READ ONLY: the actual board names, account
 * handles, and exactly which drafts would be affected by a cleanup.
 *
 * The earlier audits masked every identifier. This prints the real names so the
 * owner can decide what the board is and which Pins are safe to remove. It is
 * still SELECT-only: no insert/update/delete/rpc, no Pinterest API call.
 *
 * Run: npx tsx scripts/audit-board-names-readonly.ts
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

async function main() {
  const env = loadEnv(".env.local");
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const ref = refFromKey(key);
  console.log("=".repeat(78));
  console.log("READ-ONLY — board names / account handles / cleanup candidates");
  console.log("=".repeat(78));
  console.log(`target ref: ${ref}`);
  if (ref !== PROD_REF) { console.error("ABORT"); process.exit(1); }
  console.log("SELECT ONLY. No Pinterest API calls.\n");

  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await db
    .from("pin_drafts")
    .select("draft_id, payload, scheduled_at")
    .is("deleted_at", null)
    .limit(3000);
  if (error) { console.log(`QUERY ERROR: ${error.message}`); process.exit(0); }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const pl = (r: Record<string, unknown>) => (r.payload ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  // ── every board id → the names it has been saved under ───────────────────
  console.log("── boards seen on drafts (REAL names) ─────────────────────────────────");
  const byBoard = new Map<string, { names: Set<string>; posted: number; failed: number; other: number }>();
  for (const r of rows) {
    const b = s(pl(r).boardId);
    if (!b) continue;
    if (!byBoard.has(b)) byBoard.set(b, { names: new Set(), posted: 0, failed: 0, other: 0 });
    const e = byBoard.get(b)!;
    const n = s(pl(r).boardName);
    if (n) e.names.add(n);
    if (s(pl(r).postedAt)) e.posted++;
    else if (s(pl(r).failureType) === "publish" && s(pl(r).publishError)) e.failed++;
    else e.other++;
  }
  [...byBoard.entries()]
    .sort((a, b) => (b[1].posted + b[1].failed) - (a[1].posted + a[1].failed))
    .forEach(([id, e]) => {
      console.log(`  board_id ${id}`);
      console.log(`     name(s): ${[...e.names].map(n => `"${n}"`).join(" | ") || "(no name stored)"}`);
      console.log(`     posted ${e.posted}   failed ${e.failed}   other ${e.other}`);
    });

  // ── the accounts ─────────────────────────────────────────────────────────
  console.log("\n── connected Pinterest accounts (REAL handles) ────────────────────────");
  const { data: conns } = await db
    .from("social_connections")
    .select("id, provider_account_username, provider_account_name, connection_status, created_at")
    .eq("provider", "pinterest");
  (conns ?? []).forEach(c => {
    const r = c as Record<string, unknown>;
    console.log(`  ${r.id}`);
    console.log(`     @${r.provider_account_username ?? "?"}   name="${r.provider_account_name ?? ""}"   ${r.connection_status}   created ${String(r.created_at).slice(0, 10)}`);
  });

  console.log("\n── which account is each failing draft pinned to? ─────────────────────");
  const failed = rows.filter(r => s(pl(r).failureType) === "publish" && s(pl(r).publishError));
  const acct = new Map<string, number>();
  failed.forEach(r => {
    const a = s(pl(r).targetConnectionId) || "(none pinned)";
    acct.set(a, (acct.get(a) ?? 0) + 1);
  });
  [...acct.entries()].sort((a, b) => b[1] - a[1]).forEach(([a, n]) =>
    console.log(`  ${a.padEnd(40)} ${n} failed drafts`));

  // ── cleanup candidates, listed individually ──────────────────────────────
  console.log("\n── CLEANUP CANDIDATES (nothing is deleted by this script) ─────────────");
  const classify = (r: Record<string, unknown>) => {
    const t = `${s(pl(r).title)} ${s(pl(r).keyword)} ${s(pl(r).boardName)}`.toLowerCase();
    if (/sandbox/.test(t)) return "SANDBOX";
    if (/\bqa\b|fixture|tcpin|tc_pin/.test(t)) return "QA";
    if (/demo/.test(t)) return "DEMO";
    return "REAL";
  };
  const groups: Record<string, Array<Record<string, unknown>>> = {};
  failed.forEach(r => { const c = classify(r); (groups[c] ??= []).push(r); });

  for (const [g, list] of Object.entries(groups).sort()) {
    console.log(`\n  [${g}] ${list.length} draft(s)`);
    list.forEach(r => {
      const stillDue = r.scheduled_at ? ` SCHEDULED@${String(r.scheduled_at).slice(0, 16)}` : "";
      console.log(`     ${String(r.draft_id).padEnd(26)} "${s(pl(r).title).slice(0, 40)}"${stillDue}`);
      console.log(`        board="${s(pl(r).boardName) || "(none)"}"  err="${s(pl(r).publishError).slice(0, 55)}"`);
    });
  }

  // ── how many are still armed for the cron? ───────────────────────────────
  const armed = failed.filter(r => r.scheduled_at);
  console.log("\n── why the count keeps growing ───────────────────────────────────────");
  console.log(`  failed drafts still carrying scheduled_at: ${armed.length}`);
  console.log("  (these are re-picked by the due scan and fail again on every run)");

  console.log("\n" + "=".repeat(78));
  console.log("READ ONLY — no INSERT / UPDATE / DELETE / DDL was issued.");
  console.log("=".repeat(78));
}
main().catch(e => { console.error("AUDIT FAILED:", e); process.exit(1); });
