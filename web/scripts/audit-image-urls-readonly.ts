/**
 * audit-image-urls-readonly.ts — READ ONLY: the 4 "imageUrl is not a valid URL"
 * drafts. What is actually stored, and can the real file be recovered?
 *
 * SELECT-only. No insert/update/delete/rpc. Does a HEAD request against the
 * candidate public URL to see whether the underlying object still exists — that
 * is a read of our own public storage bucket, not a write and not a provider call.
 *
 * Run: npx tsx scripts/audit-image-urls-readonly.ts
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
  console.log("READ-ONLY — image URL root cause on the 4 failing drafts");
  console.log("=".repeat(78));
  if (ref !== PROD_REF) { console.error("ABORT"); process.exit(1); }
  console.log(`ref ${ref} — SELECT ONLY.\n`);

  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await db
    .from("pin_drafts").select("draft_id, payload, scheduled_at").is("deleted_at", null).limit(3000);
  if (error) { console.log(`QUERY ERROR: ${error.message}`); process.exit(0); }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const pl = (r: Record<string, unknown>) => (r.payload ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  const broken = rows.filter(r => /not a valid URL/i.test(s(pl(r).publishError)));
  console.log(`── drafts with "imageUrl is not a valid URL": ${broken.length}\n`);

  // The public bucket base, used to rebuild an absolute URL from a filename.
  const PUBLIC_BASE = `${url}/storage/v1/object/public/generated/studio/`;

  for (const r of broken) {
    const p = pl(r);
    const stored = s(p.imageUrl);
    console.log(`  ${r.draft_id}   "${s(p.title).slice(0, 44)}"`);
    console.log(`     stored imageUrl : ${stored || "(EMPTY)"}`);
    console.log(`     sourceImageUrl  : ${s(p.sourceImageUrl) || "(none)"}`);
    console.log(`     board           : ${s(p.boardName) || "(none)"}  scheduled_at=${r.scheduled_at ?? "(none)"}`);
    console.log(`     lifecycle       : ${s(p.postedAt) ? "POSTED" : s(p.publishError) ? "FAILED" : "other"}`);

    // Can we recover a filename from what is stored?
    let filename: string | null = null;
    const m = /path=studio%2F([^&]+)|path=studio\/([^&]+)/.exec(stored);
    if (m) filename = decodeURIComponent(m[1] ?? m[2] ?? "");
    else {
      const pub = stored.indexOf("/generated/studio/");
      if (pub !== -1) filename = stored.slice(pub + "/generated/studio/".length).split("?")[0];
    }
    console.log(`     recovered file  : ${filename ?? "(cannot recover)"}`);

    if (filename) {
      const candidate = PUBLIC_BASE + filename;
      try {
        const res = await fetch(candidate, { method: "HEAD" });
        console.log(`     object exists?  : HTTP ${res.status} ${res.status === 200 ? "← RECOVERABLE" : "← gone"}`);
        console.log(`     would become    : ${candidate.slice(0, 100)}`);
      } catch (e) {
        console.log(`     object exists?  : probe failed (${(e as Error).message})`);
      }
    }
    console.log("");
  }

  // How many OTHER drafts carry the same relative-path shape (latent, not yet failed)?
  const relative = rows.filter(r => {
    const u = s(pl(r).imageUrl);
    return u.startsWith("/api/storage-image");
  });
  console.log("── latent exposure: drafts storing a RELATIVE proxy path ──────────────");
  console.log(`  total: ${relative.length}`);
  relative.forEach(r => {
    const st = s(pl(r).postedAt) ? "POSTED" : s(pl(r).publishError) ? "FAILED" : "pending";
    console.log(`     ${String(r.draft_id).padEnd(26)} ${st.padEnd(8)} sched=${r.scheduled_at ? String(r.scheduled_at).slice(0, 16) : "-"}`);
  });

  console.log("\n" + "=".repeat(78));
  console.log("READ ONLY — no INSERT / UPDATE / DELETE / DDL was issued.");
  console.log("=".repeat(78));
}
main().catch(e => { console.error("AUDIT FAILED:", e); process.exit(1); });
