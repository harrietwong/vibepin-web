/**
 * audit-today-outcome-readonly.ts — READ ONLY: did today's due Pins publish?
 *
 * The board migration moved 16 Pins off the Sandbox board onto 家居 while
 * keeping their original scheduled_at. This checks what actually happened at
 * each due time, rather than assuming the fix worked.
 *
 * SELECT-only. No insert/update/delete/rpc, no Pinterest API call.
 *
 * Run: npx tsx scripts/audit-today-outcome-readonly.ts
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
  const now = new Date();
  console.log("=".repeat(78));
  console.log(`READ-ONLY — today's scheduled outcomes   (now ${now.toISOString().slice(0, 16)} UTC)`);
  console.log("=".repeat(78));
  if (ref !== PROD_REF) { console.error("ABORT"); process.exit(1); }
  console.log(`ref ${ref} — SELECT ONLY.\n`);

  const db = createClient(url, key, { auth: { persistSession: false } });

  // ── publish events since the migration ──────────────────────────────────
  const since = new Date(now.getTime() - 36 * 3600e3).toISOString();
  const { data: ev } = await db
    .from("analytics_events")
    .select("event_name, draft_id, payload, created_at")
    .in("event_name", ["pinterest_publish_attempted", "pinterest_publish_succeeded", "pinterest_publish_failed"])
    .gte("created_at", since)
    .order("created_at", { ascending: true });

  const rows = (ev ?? []) as Array<Record<string, unknown>>;
  const p = (r: Record<string, unknown>) => (r.payload ?? {}) as Record<string, unknown>;
  console.log("── publish events in the last 36h ─────────────────────────────────────");
  if (!rows.length) console.log("  (none)");
  rows.forEach(r => {
    const kind = String(r.event_name).replace("pinterest_publish_", "").toUpperCase();
    const extra = kind === "FAILED"
      ? `  ${p(r).errorCode} — ${String(p(r).errorMessage ?? "").slice(0, 58)}`
      : kind === "SUCCEEDED" ? `  pin=${String(p(r).remotePinId ?? "")}` : "";
    console.log(`  ${String(r.created_at).slice(0, 19)}  ${kind.padEnd(10)} draft=${String(r.draft_id ?? "-").slice(0, 24).padEnd(24)} board=${String(p(r).boardId ?? "-")}${extra}`);
  });

  // ── the drafts that were migrated ───────────────────────────────────────
  const { data: drafts } = await db
    .from("pin_drafts")
    .select("draft_id, payload, scheduled_at, publish_claimed_at")
    .is("deleted_at", null)
    .not("scheduled_at", "is", null)
    .order("scheduled_at", { ascending: true });

  const ds = (drafts ?? []) as Array<Record<string, unknown>>;
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  console.log("\n── every Pin still carrying a schedule ────────────────────────────────");
  ds.forEach(r => {
    const pay = (r.payload ?? {}) as Record<string, unknown>;
    const due = String(r.scheduled_at);
    const past = Date.parse(due) <= now.getTime();
    const state = s(pay.postedAt) ? "POSTED" : s(pay.publishError) ? "FAILED" : "pending";
    console.log(`  ${due.slice(0, 16)}  ${past ? "DUE " : "future"}  ${state.padEnd(7)}  "${s(pay.boardName)}"  ${String(r.draft_id).slice(0, 24)}`);
    if (state === "FAILED") console.log(`        err: ${s(pay.publishError).slice(0, 66)}`);
    if (r.publish_claimed_at) console.log(`        claimed: ${String(r.publish_claimed_at).slice(0, 19)}`);
  });

  // ── the headline number ─────────────────────────────────────────────────
  const { data: all } = await db.from("pin_drafts").select("payload").is("deleted_at", null).limit(3000);
  const failedNow = (all ?? []).filter(r => {
    const pay = ((r as Record<string, unknown>).payload ?? {}) as Record<string, unknown>;
    return s(pay.failureType) === "publish" && s(pay.publishError) && !s(pay.archivedAt);
  });
  console.log("\n── the banner number right now ────────────────────────────────────────");
  console.log(`  publish failures: ${failedNow.length}   (was 26 before the cleanup)`);
  const byErr: Record<string, number> = {};
  failedNow.forEach(r => {
    const pay = ((r as Record<string, unknown>).payload ?? {}) as Record<string, unknown>;
    const k = s(pay.publishError).slice(0, 55) || "(none)";
    byErr[k] = (byErr[k] ?? 0) + 1;
  });
  Object.entries(byErr).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`     ${String(n).padStart(3)}  ${k}`));

  const sandboxLeft = (all ?? []).filter(r => {
    const pay = ((r as Record<string, unknown>).payload ?? {}) as Record<string, unknown>;
    return s(pay.boardId) === "804455620879831103" && !s(pay.postedAt);
  });
  console.log(`\n  unpublished Pins still pointing at Sandbox board: ${sandboxLeft.length}`);

  console.log("\n" + "=".repeat(78));
  console.log("READ ONLY — no INSERT / UPDATE / DELETE / DDL was issued.");
  console.log("=".repeat(78));
}
main().catch(e => { console.error("AUDIT FAILED:", e); process.exit(1); });
