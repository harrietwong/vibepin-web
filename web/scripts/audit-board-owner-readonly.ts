/**
 * audit-board-owner-readonly.ts — READ ONLY: which ACCOUNT owns board 家居?
 *
 * The instruction is "move to 家居, and onto the other account (not
 * @vibepinvibepin)". Those two can conflict: if 家居 belongs to
 * @vibepinvibepin, then moving Pins to 家居 AND to the other account would
 * recreate the exact defect being fixed — a board the requesting account does
 * not own, which is what board_not_owned means.
 *
 * This checks, from our own publish history, which account actually published
 * to each board. SELECT-only, no Pinterest API call.
 *
 * Run: npx tsx scripts/audit-board-owner-readonly.ts
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
  console.log("READ-ONLY — which account published to which board?");
  console.log("=".repeat(78));
  if (ref !== PROD_REF) { console.error("ABORT"); process.exit(1); }
  console.log(`ref ${ref} — SELECT ONLY, no Pinterest API calls.\n`);

  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: conns } = await db
    .from("social_connections")
    .select("id, provider_account_username, provider_account_name, connection_status")
    .eq("provider", "pinterest");
  const nameOf = new Map<string, string>();
  (conns ?? []).forEach(c => {
    const r = c as Record<string, unknown>;
    nameOf.set(String(r.id), `@${r.provider_account_username} (${r.provider_account_name})`);
  });

  const { data, error } = await db
    .from("pin_drafts").select("draft_id, payload").is("deleted_at", null).limit(3000);
  if (error) { console.log(`QUERY ERROR: ${error.message}`); process.exit(0); }
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const pl = (r: Record<string, unknown>) => (r.payload ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  // Only POSTED drafts prove ownership: the publish actually went through.
  console.log("── proven by successful publishes ─────────────────────────────────────");
  const board = new Map<string, { name: string; accts: Map<string, number> }>();
  for (const r of rows) {
    if (!s(pl(r).postedAt)) continue;
    const b = s(pl(r).boardId);
    if (!b) continue;
    if (!board.has(b)) board.set(b, { name: s(pl(r).boardName), accts: new Map() });
    const e = board.get(b)!;
    if (!e.name) e.name = s(pl(r).boardName);
    const a = s(pl(r).targetConnectionId) || "(not pinned — used default)";
    e.accts.set(a, (e.accts.get(a) ?? 0) + 1);
  }
  for (const [id, e] of board) {
    console.log(`  "${e.name}"  (${id})`);
    for (const [a, n] of e.accts) {
      console.log(`     ${n.toString().padStart(3)} published as ${nameOf.get(a) ?? a}`);
    }
  }

  // Which account is the workspace default (what "not pinned" resolves to)?
  console.log("\n── the 家居 board specifically ────────────────────────────────────────");
  const jiaju = [...board.entries()].find(([, e]) => e.name.includes("家居"));
  if (!jiaju) {
    console.log("  no POSTED draft on 家居 — ownership cannot be proven from history");
  } else {
    const [id, e] = jiaju;
    console.log(`  board_id ${id}  name "${e.name}"`);
    console.log(`  published by: ${[...e.accts.keys()].map(a => nameOf.get(a) ?? a).join(", ")}`);
  }

  // What did the pins on 家居 look like — same user?
  console.log("\n── ALL drafts referencing 家居 (any status) ───────────────────────────");
  rows.filter(r => s(pl(r).boardName).includes("家居")).forEach(r => {
    const st = s(pl(r).postedAt) ? "POSTED" : s(pl(r).publishError) ? "FAILED" : "other";
    const rawAcct = s(pl(r).targetConnectionId);
    const acctLabel = nameOf.get(rawAcct) ?? (rawAcct || "(none)");
    console.log(`  ${String(r.draft_id).padEnd(26)} ${st.padEnd(7)} acct=${acctLabel}`);
  });

  console.log("\n" + "=".repeat(78));
  console.log("READ ONLY — no INSERT / UPDATE / DELETE / DDL was issued.");
  console.log("=".repeat(78));
}
main().catch(e => { console.error("AUDIT FAILED:", e); process.exit(1); });
