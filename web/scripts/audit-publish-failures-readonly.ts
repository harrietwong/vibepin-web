/**
 * audit-publish-failures-readonly.ts — READ ONLY publish-failure root-cause audit.
 *
 * SELECT-only by construction: no insert/update/delete/rpc call appears in this
 * file, and it asserts the target project ref before issuing a query.
 *
 * Reads `analytics_events`, where the cron and the immediate path both record
 * attempted → succeeded/failed with a shared publishAttemptId, so the funnel can
 * be measured rather than guessed. Error messages are sanitized at WRITE time
 * (publishEvents.sanitizeErrorMessage), so what is printed here is already safe.
 *
 * Run:  npx tsx scripts/audit-publish-failures-readonly.ts
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

/** Never print a raw user/account id. */
function mask(v: unknown): string {
  const s = String(v ?? "");
  if (!s) return "(none)";
  return s.length <= 8 ? `${s.slice(0, 2)}…` : `${s.slice(0, 4)}…${s.slice(-2)}`;
}

function tally(rows: Array<Record<string, unknown>>, key: (r: Record<string, unknown>) => string) {
  const out: Record<string, number> = {};
  for (const r of rows) { const k = key(r); out[k] = (out[k] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(34)} ${typeof value === "object" ? JSON.stringify(value) : value}`);
}

async function main() {
  const env = loadEnv(".env.local");
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) { console.error("Missing supabase env in .env.local"); process.exit(1); }

  const ref = refFromKey(key);
  console.log("=".repeat(74));
  console.log("READ-ONLY AUDIT — scheduled publishing failures");
  console.log("=".repeat(74));
  console.log(`target ref (service-key JWT): ${ref}`);
  if (ref !== PROD_REF) { console.error(`ABORT: expected ${PROD_REF}, got ${ref}`); process.exit(1); }
  console.log("assertion: production, SELECT ONLY.\n");

  const db = createClient(url, key, { auth: { persistSession: false } });

  // ── the publish event trail ───────────────────────────────────────────────
  const { data, error, count } = await db
    .from("analytics_events")
    .select("event_name, draft_id, user_id, payload, created_at", { count: "exact" })
    .in("event_name", [
      "pinterest_publish_attempted",
      "pinterest_publish_succeeded",
      "pinterest_publish_failed",
    ])
    .order("created_at", { ascending: true })
    .limit(5000);

  if (error) {
    console.log(`QUERY ERROR: ${error.code ?? ""} ${error.message}`);
    if (error.code === "42P01") console.log("→ analytics_events does not exist: no publish telemetry at all.");
    process.exit(0);
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const p = (r: Record<string, unknown>) => (r.payload ?? {}) as Record<string, unknown>;

  console.log("── publish event trail ────────────────────────────────────────────────");
  line("total publish events", count ?? rows.length);
  if (!rows.length) {
    console.log("\n  NO PUBLISH EVENTS AT ALL.");
    console.log("  The cron records `attempted` before any provider call, so an empty");
    console.log("  trail means the due scan never reached a publish — not that publishing");
    console.log("  failed. That points at the scheduler, not the provider.\n");
  }

  const attempted = rows.filter(r => r.event_name === "pinterest_publish_attempted");
  const succeeded = rows.filter(r => r.event_name === "pinterest_publish_succeeded");
  const failed    = rows.filter(r => r.event_name === "pinterest_publish_failed");

  line("attempted", attempted.length);
  line("succeeded", succeeded.length);
  line("failed", failed.length);
  const unresolved = attempted.length - succeeded.length - failed.length;
  line("attempted w/o outcome", `${unresolved}${unresolved > 0 ? "  ← crashed / still running" : ""}`);
  if (rows.length) {
    line("first event", rows[0].created_at);
    line("last event", rows[rows.length - 1].created_at);
  }

  // ── source split: this is the question that matters ──────────────────────
  console.log("\n── by source (scheduled vs immediate) ─────────────────────────────────");
  line("attempted by source", tally(attempted, r => String(p(r).source ?? "unknown")));
  line("succeeded by source", tally(succeeded, r => String(p(r).source ?? "unknown")));
  line("FAILED by source", tally(failed, r => String(p(r).source ?? "unknown")));

  const schedFailed = failed.filter(r => String(p(r).source ?? "") === "scheduled-cron");
  const immedFailed = failed.filter(r => String(p(r).source ?? "") === "immediate");
  console.log("");
  line("failures from SCHEDULED execution", schedFailed.length);
  line("failures from Publish now", immedFailed.length);

  // ── failure reason breakdown ─────────────────────────────────────────────
  console.log("\n── failure reasons (errorCode) ────────────────────────────────────────");
  line("all failures", tally(failed, r => String(p(r).errorCode ?? "(none)")));
  if (schedFailed.length) line("scheduled only", tally(schedFailed, r => String(p(r).errorCode ?? "(none)")));

  console.log("\n── failure messages (sanitized at write time) ─────────────────────────");
  const msgs = tally(failed, r => String(p(r).errorMessage ?? "(none)").slice(0, 90));
  Object.entries(msgs).slice(0, 12).forEach(([m, n]) => console.log(`  ${String(n).padStart(4)}  ${m}`));

  // ── by day ───────────────────────────────────────────────────────────────
  console.log("\n── failures by day ────────────────────────────────────────────────────");
  const byDay = tally(failed, r => String(r.created_at ?? "").slice(0, 10));
  Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([d, n]) => console.log(`  ${d}  ${"█".repeat(Math.min(n, 40))} ${n}`));

  // ── distinct Pins vs attempts (does retry double-count?) ─────────────────
  console.log("\n── unique Pins vs attempts ────────────────────────────────────────────");
  const failedDrafts = new Set(failed.map(r => String(r.draft_id ?? "")).filter(Boolean));
  line("failure EVENTS", failed.length);
  line("distinct draft_ids in failures", failedDrafts.size);
  line("failures with NO draft_id", failed.filter(r => !r.draft_id).length);
  const repeats = Object.entries(tally(failed.filter(r => r.draft_id), r => String(r.draft_id)))
    .filter(([, n]) => n > 1);
  line("Pins that failed more than once", repeats.length);
  if (repeats.length) {
    repeats.slice(0, 8).forEach(([id, n]) => console.log(`     ${mask(id)}  ${n} failures`));
    console.log("     (the UI counts DRAFTS, not events — see report)");
  }

  // ── did a failed Pin later succeed? (retry resolution) ───────────────────
  console.log("\n── retry resolution ───────────────────────────────────────────────────");
  const succeededDrafts = new Set(succeeded.map(r => String(r.draft_id ?? "")).filter(Boolean));
  const failedThenSucceeded = [...failedDrafts].filter(d => succeededDrafts.has(d));
  line("Pins that failed AND later succeeded", failedThenSucceeded.length);
  line("Pins that only ever failed", failedDrafts.size - failedThenSucceeded.length);

  // ── accounts / boards ────────────────────────────────────────────────────
  console.log("\n── boards + accounts in failures (masked) ─────────────────────────────");
  line("distinct boards in failures", new Set(failed.map(r => String(p(r).boardId ?? ""))).size);
  line("failures with EMPTY boardId", failed.filter(r => !String(p(r).boardId ?? "").trim()).length);
  line("distinct users in failures", new Set(failed.map(r => String(r.user_id ?? ""))).size);

  // ── the funnel ───────────────────────────────────────────────────────────
  console.log("\n── FUNNEL (scheduled-cron only) ───────────────────────────────────────");
  const schedAttempted = attempted.filter(r => String(p(r).source ?? "") === "scheduled-cron");
  const schedSucceeded = succeeded.filter(r => String(p(r).source ?? "") === "scheduled-cron");
  console.log(`  cron attempted      ${schedAttempted.length}`);
  console.log(`  provider success    ${schedSucceeded.length}`);
  console.log(`  provider failed     ${schedFailed.length}`);
  console.log(`  no outcome recorded ${schedAttempted.length - schedSucceeded.length - schedFailed.length}`);

  console.log("\n" + "=".repeat(74));
  console.log("READ ONLY — no INSERT / UPDATE / DELETE / DDL was issued.");
  console.log("=".repeat(74));
}

main().catch(e => { console.error("AUDIT FAILED:", e); process.exit(1); });
