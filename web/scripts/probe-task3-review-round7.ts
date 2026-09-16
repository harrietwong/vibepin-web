// Round 7: null-safety of the exact state-default manifest. Local PGlite only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(process.cwd(), "..");
const load = (path: string) => readFileSync(resolve(root, path), "utf8").replace(/\r\n?/g, "\n");
const v80 = load("backend/db/migrate_v80_video_poster_operations.sql");
const verifier = load("backend/tests/pglite_v37/verify-v80-video-poster-operations.mjs");
const bootstrap = new Function("load", verifier.slice(verifier.indexOf("async function bootstrap("), verifier.indexOf("async function asRole(")) + "\nreturn bootstrap;")(load);
const owner = "11111111-1111-4111-8111-111111111111";
async function main() {
  const { PGlite } = createRequire(resolve(root, "backend/tests/pglite_v37/package.json"))("@electric-sql/pglite");
  const db = new PGlite();
  try {
    await bootstrap(db); await db.exec(load("backend/db/migrate_v77_video_media.sql")); await db.exec(v80);
    const seed = async (id: string) => {
      const batchId = (await db.query("select public.video_upload_batch_prepare($1,$2,now()+interval '1 hour') as v", [owner, id])).rows[0].v.batchId;
      await db.query("select public.video_upload_item_prepare($1,$2,0,$3,$4,'video/mp4',1024,$5,1080,1920,5000)", [owner, batchId, id, `${owner}/uploads/${batchId}/0.mp4`, "a".repeat(64)]);
      const path = `studio/uploads/${owner}/${id}.png`;
      await db.query("insert into public.media_asset_provenance(owner_user_id,bucket_id,object_path,source_type,lifecycle_state) values($1,'generated-private',$2,'upload','draft')", [owner, path]);
      return { batchId, path };
    };
    const associate = async (op: { batchId: string; path: string }) => (await db.query("select public.video_poster_operation_associate($1,$2,0,'generated-private',$3) as v", [owner, op.batchId, op.path])).rows[0].v;
    const before = await seed("round7_before"); assert.equal((await associate(before)).ok, true);
    await db.exec("alter table public.video_poster_operations alter column state drop default");
    let rejected = false;
    try { await db.exec(v80); } catch { rejected = true; await db.exec("rollback"); }
    const actualDefault = (await db.query("select pg_get_expr(adbin,adrelid) as v from pg_attrdef where adrelid='public.video_poster_operations'::regclass and adnum=(select attnum from pg_attribute where attrelid='public.video_poster_operations'::regclass and attname='state')")).rows[0]?.v ?? null;
    const after = await seed("round7_after"); let associationError = "";
    try { await associate(after); } catch (error) { associationError = (error as Error).message; }
    await db.exec("alter table public.video_poster_operations alter column state set default 'associated'"); await db.exec(v80);
    assert.equal((await associate(after)).ok, true, "the same operation succeeds when the default is restored");
    console.log(JSON.stringify({ reapplyRejected: rejected, stateDefault: actualDefault, associationError, restoredOperationSucceeds: true }));
    assert.equal(rejected, true, "a missing state default yields SQL NULL, not TRUE, in the current <> manifest check");
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
