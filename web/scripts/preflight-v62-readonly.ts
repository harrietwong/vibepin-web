/**
 * preflight-v62-readonly.ts — READ ONLY production preflight for migration v62
 * (social_publish_jobs.post_id uuid → text).
 *
 * SELECT-only by construction: this file contains no insert/update/delete/rpc
 * call, and asserts the target project ref before issuing a single query. It
 * answers whether v62 is safe to apply — row counts alone are not sufficient,
 * so it also reports status distribution, post_id nullability, destination
 * fan-out shape and orphan counts.
 *
 * Schema evidence (types, FKs, constraints, indexes) is NOT obtainable through
 * PostgREST — it lives in information_schema/pg_catalog, which the REST API does
 * not expose. Those rows are reported from the DDL in backend/db instead, and
 * clearly labelled as such.
 *
 * Run:  npx tsx scripts/preflight-v62-readonly.ts
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The production project. Asserted, never assumed. */
const PROD_REF = "jaxteelkecvlozdrdoog";

function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw = "";
  try { raw = readFileSync(resolve(process.cwd(), file), "utf8"); } catch { return out; }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    // First occurrence wins here, but note the real dotenv loader lets the LAST
    // duplicate win — a known past footgun in this repo. We only read, so either
    // way we verify the ref from the key itself below.
    if (m && !(m[1] in out)) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/** The project ref is a claim inside the JWT — the authoritative identifier. */
function refFromKey(key: string): string | null {
  try {
    const payload = key.split(".")[1];
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return (JSON.parse(json) as { ref?: string }).ref ?? null;
  } catch { return null; }
}

function pct(n: number, total: number): string {
  return total === 0 ? "—" : `${((n / total) * 100).toFixed(1)}%`;
}

async function main() {
  const env = loadEnv(".env.local");
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE ?? "";
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }

  const ref = refFromKey(key);
  console.log("=".repeat(72));
  console.log("READ-ONLY PREFLIGHT — migration v62 (social_publish_jobs.post_id → text)");
  console.log("=".repeat(72));
  console.log(`target ref (from service-key JWT): ${ref}`);
  console.log(`url:                               ${url}`);
  if (ref !== PROD_REF) {
    console.error(`\nABORT: expected production ref ${PROD_REF}, got ${ref}.`);
    process.exit(1);
  }
  console.log(`assertion: ref === ${PROD_REF} (production) — SELECT ONLY from here.\n`);

  const db = createClient(url, key, { auth: { persistSession: false } });

  // ── social_publish_jobs ───────────────────────────────────────────────────
  console.log("── social_publish_jobs ──────────────────────────────────────────────");
  const jobsRes = await db
    .from("social_publish_jobs")
    .select("id,status,post_id,product_id,created_at", { count: "exact" });

  if (jobsRes.error) {
    console.log(`  QUERY ERROR: ${jobsRes.error.code ?? ""} ${jobsRes.error.message}`);
    if (jobsRes.error.code === "42P01") console.log("  → table does not exist (v32 never applied)");
  } else {
    const rows = jobsRes.data ?? [];
    const total = jobsRes.count ?? rows.length;
    console.log(`  total count:            ${total}`);

    const byStatus: Record<string, number> = {};
    let nullPost = 0, nonNullPost = 0;
    const nonUuid: string[] = [];
    let minAt = "", maxAt = "";
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    for (const r of rows as Array<Record<string, unknown>>) {
      const st = String(r.status ?? "(null)");
      byStatus[st] = (byStatus[st] ?? 0) + 1;
      const pid = r.post_id;
      if (pid === null || pid === undefined || pid === "") nullPost++;
      else {
        nonNullPost++;
        const s = String(pid);
        if (!UUID_RE.test(s)) nonUuid.push(s);
      }
      const at = String(r.created_at ?? "");
      if (at) {
        if (!minAt || at < minAt) minAt = at;
        if (!maxAt || at > maxAt) maxAt = at;
      }
    }

    console.log(`  status distribution:    ${total ? JSON.stringify(byStatus) : "(no rows)"}`);
    console.log(`  created_at min:         ${minAt || "(no rows)"}`);
    console.log(`  created_at max:         ${maxAt || "(no rows)"}`);
    console.log(`  post_id NULL:           ${nullPost} (${pct(nullPost, total)})`);
    console.log(`  post_id NON-NULL:       ${nonNullPost} (${pct(nonNullPost, total)})`);
    // The whole point of v62: uuid → text is lossless ONLY if nothing depends on
    // uuid-ness. Existing non-uuid values would already be impossible under the
    // uuid column, so any found here would mean the column is ALREADY text.
    console.log(`  non-uuid post_id values: ${nonUuid.length}${nonUuid.length ? ` e.g. ${JSON.stringify(nonUuid.slice(0, 3))}` : ""}`);
    console.log(`  → v62 widening safety:  ${total === 0
      ? "TRIVIALLY SAFE (no rows to convert)"
      : nonUuid.length > 0
        ? "column appears to ALREADY be text (non-uuid values present)"
        : "every value is uuid-shaped; ::text cast is lossless"}`);
  }

  // ── social_publish_job_destinations ───────────────────────────────────────
  console.log("\n── social_publish_job_destinations ──────────────────────────────────");
  const destRes = await db
    .from("social_publish_job_destinations")
    .select("id,publish_job_id,provider,status,external_post_id,external_post_url,published_at", { count: "exact" });

  const jobIds = new Set<string>(
    !jobsRes.error ? (jobsRes.data ?? []).map(r => String((r as { id: unknown }).id)) : [],
  );

  if (destRes.error) {
    console.log(`  QUERY ERROR: ${destRes.error.code ?? ""} ${destRes.error.message}`);
    if (destRes.error.code === "42P01") console.log("  → table does not exist (v32 never applied)");
  } else {
    const rows = (destRes.data ?? []) as Array<Record<string, unknown>>;
    const total = destRes.count ?? rows.length;
    console.log(`  total count:            ${total}`);

    const perJob: Record<string, number> = {};
    const byProvider: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let orphans = 0, publishedNoUrl = 0;

    for (const r of rows) {
      const jid = String(r.publish_job_id ?? "");
      perJob[jid] = (perJob[jid] ?? 0) + 1;
      byProvider[String(r.provider ?? "(null)")] = (byProvider[String(r.provider ?? "(null)")] ?? 0) + 1;
      byStatus[String(r.status ?? "(null)")] = (byStatus[String(r.status ?? "(null)")] ?? 0) + 1;
      if (jobIds.size > 0 && !jobIds.has(jid)) orphans++;
      if (String(r.status) === "published" && !String(r.external_post_url ?? "").startsWith("http")) publishedNoUrl++;
    }

    const fanout: Record<string, number> = {};
    for (const n of Object.values(perJob)) {
      const k = `${n} destination(s)`;
      fanout[k] = (fanout[k] ?? 0) + 1;
    }
    console.log(`  provider distribution:  ${total ? JSON.stringify(byProvider) : "(no rows)"}`);
    console.log(`  status distribution:    ${total ? JSON.stringify(byStatus) : "(no rows)"}`);
    console.log(`  destinations per job:   ${total ? JSON.stringify(fanout) : "(no rows)"}`);
    console.log(`  orphan rows:            ${orphans}${jobIds.size === 0 ? " (jobs unreadable — orphan check inconclusive)" : ""}`);
    console.log(`  published w/o real URL: ${publishedNoUrl} (TC-102 data-anomaly probe)`);
  }

  // ── schema evidence (from DDL — PostgREST cannot expose information_schema) ─
  console.log("\n── schema evidence (source: backend/db DDL, NOT a live catalog read) ──");
  console.log("  social_publish_jobs.post_id");
  console.log("    declared type      : uuid            (v32)  → text (v62, UNAPPLIED)");
  console.log("    FK target          : none");
  console.log("    FK behavior        : n/a");
  console.log("    nullability        : nullable");
  console.log("    unique constraints : none");
  console.log("    check constraints  : none on post_id (status has a CHECK)");
  console.log("    indexes            : none on post_id (only social_publish_jobs_user)");
  console.log("  social_publish_job_destinations");
  console.log("    publish_job_id FK  : → social_publish_jobs(id) ON DELETE CASCADE");
  console.log("    social_connection_id FK → social_connections(id) ON DELETE SET NULL");
  console.log("    unique constraints : NONE  ← repeated saves would duplicate silently");
  console.log("    check constraints  : provider IN (pinterest,instagram,facebook,tiktok)");
  console.log("                         status   IN (pending,skipped,publishing,published,failed)");
  console.log("    indexes            : social_publish_job_destinations_job (publish_job_id)");
  console.log("\n  v62 adds/modifies constraints? NO — it only widens a column type.");
  console.log("  Therefore no existing row can violate a new constraint.");

  console.log("\n" + "=".repeat(72));
  console.log("READ ONLY — no INSERT / UPDATE / DELETE / DDL was issued.");
  console.log("=".repeat(72));
}

main().catch(e => { console.error("PREFLIGHT FAILED:", e); process.exit(1); });
