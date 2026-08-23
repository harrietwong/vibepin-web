/**
 * repair-relative-image-urls.ts — rewrite the stored relative proxy path to the
 * absolute public URL, for drafts that cannot publish because of it.
 *
 * Some drafts store `/api/storage-image?path=studio/<file>` — written when
 * NEXT_PUBLIC_SUPABASE_URL was unset at generation time. Pinterest fetches the
 * image itself and cannot resolve a relative path, so the publish is rejected
 * with "imageUrl is not a valid URL". The image file itself is fine.
 *
 * Safety:
 *   - DRY RUN by default. Writes only with an explicit --apply.
 *   - Asserts the production project ref before touching anything.
 *   - Only touches drafts whose imageUrl starts with the relative proxy path.
 *   - HEAD-checks the rebuilt URL first: a draft whose object is missing is
 *     SKIPPED, never rewritten to a URL that would fail differently.
 *   - Leaves scheduled_at, boardId, targetConnectionId and every other field
 *     untouched. It does not publish and does not schedule anything.
 *   - Rewrites only the payload's imageUrl. postedAt drafts are skipped: their
 *     publish already happened and rewriting history serves nothing.
 *
 * Run:  npx tsx scripts/repair-relative-image-urls.ts            (dry run)
 *       npx tsx scripts/repair-relative-image-urls.ts --apply    (writes)
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PROD_REF = "jaxteelkecvlozdrdoog";
const APPLY = process.argv.includes("--apply");
const RELATIVE_PREFIX = "/api/storage-image";

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

/** Pull the studio filename out of the relative proxy path. */
function filenameFrom(rel: string): string | null {
  const qs = rel.includes("?") ? rel.slice(rel.indexOf("?")) : "";
  const path = new URLSearchParams(qs).get("path");
  if (!path?.startsWith("studio/")) return null;
  return path.slice("studio/".length) || null;
}

async function main() {
  const env = loadEnv(".env.local");
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const ref = refFromKey(key);

  console.log("=".repeat(78));
  console.log(`Relative image URL repair — ${APPLY ? "APPLY (WRITES)" : "DRY RUN (no writes)"}`);
  console.log("=".repeat(78));
  console.log(`target ref: ${ref}`);
  if (ref !== PROD_REF) { console.error(`ABORT: expected ${PROD_REF}`); process.exit(1); }
  if (!url) { console.error("ABORT: NEXT_PUBLIC_SUPABASE_URL is empty — cannot build absolute URLs"); process.exit(1); }
  console.log(`public base: ${url}/storage/v1/object/public/generated/studio/\n`);

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
    return str(p.imageUrl).startsWith(RELATIVE_PREFIX);
  });

  console.log(`candidates (imageUrl starts with ${RELATIVE_PREFIX}): ${targets.length}\n`);

  let repaired = 0, skippedPosted = 0, skippedMissing = 0, skippedUnparsable = 0;

  for (const r of targets) {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    const id = String(r.draft_id);
    const title = str(p.title).slice(0, 38);
    const stored = str(p.imageUrl);

    if (str(p.postedAt)) {
      skippedPosted++;
      console.log(`  SKIP  ${id.padEnd(26)} already POSTED — history left alone`);
      continue;
    }

    const filename = filenameFrom(stored);
    if (!filename) {
      skippedUnparsable++;
      console.log(`  SKIP  ${id.padEnd(26)} cannot recover filename from "${stored.slice(0, 44)}"`);
      continue;
    }

    const absolute = `${url}/storage/v1/object/public/generated/studio/${filename}`;

    // Never rewrite to a URL that does not resolve — that would swap one failure
    // for another and look like a fix.
    let head = 0;
    try { head = (await fetch(absolute, { method: "HEAD" })).status; } catch { head = 0; }
    if (head !== 200) {
      skippedMissing++;
      console.log(`  SKIP  ${id.padEnd(26)} object not reachable (HTTP ${head}) — left untouched`);
      continue;
    }

    console.log(`  ${APPLY ? "FIX " : "WOULD"}  ${id.padEnd(26)} "${title}"`);
    console.log(`         from: ${stored}`);
    console.log(`         to:   ${absolute}`);
    console.log(`         scheduled_at: ${r.scheduled_at ?? "(none)"}  (unchanged)`);

    if (APPLY) {
      const next = { ...p, imageUrl: absolute, updatedAt: new Date().toISOString() };
      const { error: upErr } = await db
        .from("pin_drafts")
        .update({ payload: next, updated_at: next.updatedAt as string })
        .eq("vibepin_user_id", r.vibepin_user_id as string)
        .eq("draft_id", id);
      if (upErr) { console.log(`         WRITE FAILED: ${upErr.message}`); continue; }
      repaired++;
    } else {
      repaired++;
    }
  }

  console.log(`\n${"─".repeat(78)}`);
  console.log(`  ${APPLY ? "repaired" : "would repair"}: ${repaired}`);
  console.log(`  skipped (already posted):  ${skippedPosted}`);
  console.log(`  skipped (object missing):  ${skippedMissing}`);
  console.log(`  skipped (unparsable):      ${skippedUnparsable}`);
  if (!APPLY) console.log("\n  DRY RUN — nothing was written. Re-run with --apply to write.");

  // Verify after writing.
  if (APPLY) {
    const { data: after } = await db
      .from("pin_drafts").select("draft_id, payload").is("deleted_at", null).limit(3000);
    const left = (after ?? []).filter(r => {
      const p = ((r as Record<string, unknown>).payload ?? {}) as Record<string, unknown>;
      return str(p.imageUrl).startsWith(RELATIVE_PREFIX) && !str(p.postedAt);
    });
    console.log(`\n  VERIFY: unpublished drafts still holding a relative path: ${left.length}`);
    left.forEach(r => console.log(`     ${String((r as Record<string, unknown>).draft_id)}`));
  }
  console.log("=".repeat(78));
}
main().catch(e => { console.error("REPAIR FAILED:", e); process.exit(1); });
