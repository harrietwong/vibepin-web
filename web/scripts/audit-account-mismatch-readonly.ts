/**
 * audit-account-mismatch-readonly.ts — READ ONLY: the decisive comparison.
 *
 * The board audit found the SAME board id on 22 failed drafts and 26 posted
 * ones. A board that is genuinely missing cannot also be publishing, so
 * "board_not_owned" is not really about the board — it is about which ACCOUNT
 * the request was made as.
 *
 * This compares, for the same board, the account pinned on the drafts that
 * failed versus the ones that succeeded, and checks the connection rows those
 * accounts point at.
 *
 * SELECT-only: no insert/update/delete/rpc, and no Pinterest API call.
 *
 * Run: npx tsx scripts/audit-account-mismatch-readonly.ts
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

async function main() {
  const env = loadEnv(".env.local");
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const ref = refFromKey(key);
  console.log("=".repeat(74));
  console.log("READ-ONLY — same board, different outcome: which account?");
  console.log("=".repeat(74));
  console.log(`target ref: ${ref}`);
  if (ref !== PROD_REF) { console.error("ABORT"); process.exit(1); }
  console.log("SELECT ONLY. No Pinterest API calls.\n");

  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await db
    .from("pin_drafts")
    .select("draft_id, payload")
    .is("deleted_at", null)
    .limit(3000);
  if (error) { console.log(`QUERY ERROR: ${error.message}`); process.exit(0); }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const pl = (r: Record<string, unknown>) => (r.payload ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  // The board that dominates BOTH sides.
  const counts: Record<string, { ok: number; bad: number }> = {};
  for (const r of rows) {
    const b = str(pl(r).boardId);
    if (!b) continue;
    counts[b] ??= { ok: 0, bad: 0 };
    if (str(pl(r).postedAt)) counts[b].ok++;
    else if (str(pl(r).failureType) === "publish" && str(pl(r).publishError)) counts[b].bad++;
  }
  const contested = Object.entries(counts)
    .filter(([, c]) => c.ok > 0 && c.bad > 0)
    .sort((a, b) => (b[1].ok + b[1].bad) - (a[1].ok + a[1].bad));

  console.log("── boards with BOTH successes and failures ───────────────────────────");
  if (!contested.length) console.log("  (none — the failing boards never published)");
  contested.forEach(([b, c]) =>
    console.log(`  board ${mask(b).padEnd(12)} posted ${String(c.ok).padStart(3)}   failed ${String(c.bad).padStart(3)}`));

  for (const [board] of contested.slice(0, 2)) {
    console.log(`\n── board ${mask(board)}: account on each side ─────────────────────`);
    const on = rows.filter(r => str(pl(r).boardId) === board);
    const ok = on.filter(r => str(pl(r).postedAt));
    const bad = on.filter(r => str(pl(r).failureType) === "publish" && str(pl(r).publishError));
    const acctOf = (rs: Array<Record<string, unknown>>) => {
      const o: Record<string, number> = {};
      for (const r of rs) { const a = mask(pl(r).targetConnectionId); o[a] = (o[a] ?? 0) + 1; }
      return o;
    };
    console.log(`  POSTED  accounts: ${JSON.stringify(acctOf(ok))}`);
    console.log(`  FAILED  accounts: ${JSON.stringify(acctOf(bad))}`);

    // When did each side happen? A board can be deleted between them.
    const times = (rs: Array<Record<string, unknown>>, f: (r: Record<string, unknown>) => string) =>
      rs.map(f).filter(Boolean).sort();
    const okT = times(ok, r => str(pl(r).postedAt));
    const badT = times(bad, r => str(pl(r).updatedAt));
    console.log(`  last SUCCESS on this board: ${okT[okT.length - 1]?.slice(0, 19) ?? "(none)"}`);
    console.log(`  last FAILURE on this board: ${badT[badT.length - 1]?.slice(0, 19) ?? "(none)"}`);
    console.log(`  first FAILURE on this board: ${badT[0]?.slice(0, 19) ?? "(none)"}`);
  }

  // ── the connection rows themselves ──────────────────────────────────────
  console.log("\n── connected Pinterest accounts (masked) ─────────────────────────────");
  const { data: conns, error: cErr } = await db
    .from("social_connections")
    .select("id, provider, connection_status, provider_account_username, scopes, token_expires_at, created_at")
    .eq("provider", "pinterest");
  if (cErr) {
    console.log(`  connection query error: ${cErr.message}`);
  } else {
    (conns ?? []).forEach(c => {
      const r = c as Record<string, unknown>;
      const sc = Array.isArray(r.scopes) ? (r.scopes as string[]) : String(r.scopes ?? "").split(/[,\s]+/).filter(Boolean);
      const need = ["boards:read", "pins:write"];
      const missing = need.filter(n => !sc.some(s => s.includes(n.split(":")[0])));
      console.log(`  ${mask(r.id).padEnd(12)} @${String(r.provider_account_username ?? "?").slice(0, 14).padEnd(15)} ` +
        `${String(r.connection_status).padEnd(14)} scopes=${sc.length}${missing.length ? ` MISSING:${missing.join(",")}` : ""}`);
      console.log(`     token_expires_at: ${r.token_expires_at ?? "(null)"}   created: ${String(r.created_at).slice(0, 10)}`);
    });
  }

  console.log("\n" + "=".repeat(74));
  console.log("READ ONLY — no INSERT / UPDATE / DELETE / DDL was issued.");
  console.log("=".repeat(74));
}
main().catch(e => { console.error("AUDIT FAILED:", e); process.exit(1); });
