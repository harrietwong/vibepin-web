/**
 * clear-stale-publish-errors.ts — clear a failure record whose CAUSE is already
 * fixed, so the Pin returns to a normal unscheduled state.
 *
 * Context: five drafts failed with "imageUrl is not a valid URL" because they
 * stored a relative proxy path. The URL has since been repaired and HEAD-verified,
 * but the old publishError text still sits on the draft, so the UI keeps counting
 * them as failures and the customer still sees "failed".
 *
 * This clears ONLY the failure framing. It does not publish, does not schedule,
 * and does not touch the image, board or account.
 *
 * Safety:
 *   - DRY RUN by default; writes only with an explicit --apply.
 *   - Asserts the production project ref first.
 *   - Refuses to clear a draft whose imageUrl is STILL relative — the failure
 *     would be real and hiding it would be a lie.
 *   - Refuses to clear anything that is not the specific error being resolved,
 *     so a genuine board/auth failure can never be swept away by this script.
 *   - Leaves postedAt / scheduledAt / boardId / targetConnectionId untouched.
 *
 * Run:  npx tsx scripts/clear-stale-publish-errors.ts           (dry run)
 *       npx tsx scripts/clear-stale-publish-errors.ts --apply   (writes)
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PROD_REF = "jaxteelkecvlozdrdoog";
const APPLY = process.argv.includes("--apply");

/** The one failure this script is allowed to resolve. */
const RESOLVED_ERROR = /imageUrl is not a valid URL/i;

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

async function main() {
  const env = loadEnv(".env.local");
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const ref = refFromKey(key);

  console.log("=".repeat(78));
  console.log(`Clear resolved publish errors — ${APPLY ? "APPLY (WRITES)" : "DRY RUN"}`);
  console.log("=".repeat(78));
  console.log(`target ref: ${ref}`);
  if (ref !== PROD_REF) { console.error("ABORT"); process.exit(1); }
  console.log(`only clearing failures matching: ${RESOLVED_ERROR}\n`);

  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await db
    .from("pin_drafts")
    .select("vibepin_user_id, draft_id, payload, scheduled_at")
    .is("deleted_at", null)
    .limit(3000);
  if (error) { console.error(`QUERY ERROR: ${error.message}`); process.exit(1); }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const targets = rows.filter(r => {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    return RESOLVED_ERROR.test(str(p.publishError));
  });

  console.log(`drafts still carrying the resolved error: ${targets.length}\n`);
  let cleared = 0, refused = 0;

  for (const r of targets) {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    const id = String(r.draft_id);
    const img = str(p.imageUrl);

    // The cause must actually be fixed. If the URL is still relative, the
    // failure is current and clearing it would hide a real problem.
    if (!/^https?:\/\//i.test(img)) {
      refused++;
      console.log(`  REFUSE ${id.padEnd(26)} imageUrl is still not absolute: "${img.slice(0, 46)}"`);
      continue;
    }

    console.log(`  ${APPLY ? "CLEAR" : "WOULD"}  ${id.padEnd(26)} "${str(p.title).slice(0, 34)}"`);
    console.log(`         was: ${str(p.publishError).slice(0, 60)}`);
    console.log(`         img: ${img.slice(0, 72)}`);
    console.log(`         scheduled_at: ${r.scheduled_at ?? "(none)"} (unchanged)`);

    if (APPLY) {
      const next: Record<string, unknown> = { ...p, updatedAt: new Date().toISOString() };
      // Remove only the failure framing — the lifecycle then derives from the
      // remaining fields exactly as it would for a Pin that never failed.
      delete next.publishError;
      delete next.failureType;
      delete next.errorCategory;
      delete next.publishErrorCode;
      const { error: upErr } = await db
        .from("pin_drafts")
        .update({ payload: next, updated_at: next.updatedAt as string })
        .eq("vibepin_user_id", r.vibepin_user_id as string)
        .eq("draft_id", id);
      if (upErr) { console.log(`         WRITE FAILED: ${upErr.message}`); continue; }
    }
    cleared++;
  }

  console.log(`\n${"─".repeat(78)}`);
  console.log(`  ${APPLY ? "cleared" : "would clear"}: ${cleared}`);
  console.log(`  refused (cause not fixed): ${refused}`);
  if (!APPLY) console.log("\n  DRY RUN — nothing was written.");

  if (APPLY) {
    const { data: after } = await db
      .from("pin_drafts").select("payload").is("deleted_at", null).limit(3000);
    const failing = (after ?? []).filter(r => {
      const p = ((r as Record<string, unknown>).payload ?? {}) as Record<string, unknown>;
      return str(p.failureType) === "publish" && str(p.publishError) && !str(p.archivedAt);
    });
    const byErr: Record<string, number> = {};
    failing.forEach(r => {
      const p = ((r as Record<string, unknown>).payload ?? {}) as Record<string, unknown>;
      const k = str(p.publishError).slice(0, 52);
      byErr[k] = (byErr[k] ?? 0) + 1;
    });
    console.log(`\n  VERIFY — publish failures now: ${failing.length}`);
    Object.entries(byErr).sort((a, b) => b[1] - a[1])
      .forEach(([k, n]) => console.log(`     ${String(n).padStart(3)}  ${k}`));
  }
  console.log("=".repeat(78));
}
main().catch(e => { console.error("FAILED:", e); process.exit(1); });
