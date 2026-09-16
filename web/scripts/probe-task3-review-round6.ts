// Round 6 independent migration-contract mutations. Ephemeral local PGlite only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import ts from "typescript";
import { createVideoPosterOperationStore } from "../src/lib/server/media/videoPosterOperationStore";

const root = resolve(process.cwd(), "..");
const load = (path: string) => readFileSync(resolve(root, path), "utf8").replace(/\r\n?/g, "\n");
const v80 = load("backend/db/migrate_v80_video_poster_operations.sql");
const verifier = load("backend/tests/pglite_v37/verify-v80-video-poster-operations.mjs");
const bootstrap = new Function("load", verifier.slice(verifier.indexOf("async function bootstrap("), verifier.indexOf("async function asRole(")) + "\nreturn bootstrap;")(load);
const A = "11111111-1111-4111-8111-111111111111";
const results: { name: string; passed: boolean; evidence?: string }[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { const evidence = (error as Error).message; results.push({ name, passed: false, evidence }); console.log(`FAIL ${name}: ${evidence}`); }
}
async function main() {
  await check("F2 same-page quota Retry must invoke actual store persistence, not only return its cached draft", async () => {
    const round5 = readFileSync("scripts/probe-task3-review-round5.ts", "utf8");
    const prefix = round5.slice(0, round5.indexOf("const root = resolve"));
    const js = ts.transpileModule(prefix + "\nreturn { h, batch, recovery, store };", { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const c = new Function("require", "exports", js)(createRequire(resolve(process.cwd(), "scripts/probe-task3-review-round6.ts")), {});
    c.h.reset(); c.h.setQuota(true); let transfers = 0;
    const ui = c.h.callbacks({ uploadVideoToSignedStorage: async () => { transfers++; } });
    await ui.executeVideoBatch(c.batch.createVideoBatchState("quota-store", [{ ...c.h.item(), posterFile: c.h.photo() }]));
    const draftId = c.store.getAllDrafts()[0].id;
    c.h.setQuota(false); await ui.executeVideoBatch(c.batch.queueFailedVideoItems(ui.state()));
    const beforeExplicitPersist = ui.state().status; const error = ui.state().items[0].error?.code;
    assert.equal(c.store.retryPersist(), true, "storage is available and the store's real retry works");
    await ui.executeVideoBatch(c.batch.queueFailedVideoItems(ui.state()));
    assert.equal(ui.state().status, "completed"); assert.equal(transfers, 1); assert.equal(c.store.getAllDrafts()[0].id, draftId);
    c.store.__resetMemoryCacheForTests(); c.store.setPinDraftOwnerScope(c.h.A.ownerUserId);
    assert.equal(c.store.getAllDrafts().length, 1); assert.equal(c.store.getAllDrafts()[0].id, draftId);
    console.log(JSON.stringify({ beforeExplicitPersist, error, afterExplicitPersist: ui.state().status, transfers, durableDrafts: 1 }));
    assert.equal(beforeExplicitPersist, "completed");
  });
  Reflect.deleteProperty(globalThis, "window"); Reflect.deleteProperty(globalThis, "document");
  const { PGlite } = createRequire(resolve(root, "backend/tests/pglite_v37/package.json"))("@electric-sql/pglite");
  const db = new PGlite();
  await bootstrap(db); await db.exec(load("backend/db/migrate_v77_video_media.sql")); await db.exec(v80);
  let sequence = 0;
  const seed = async () => {
    const key = `round6_${++sequence}`;
    const batchId = (await db.query("select public.video_upload_batch_prepare($1,$2,now()+interval '1 hour') as v", [A, key])).rows[0].v.batchId;
    await db.query("select public.video_upload_item_prepare($1,$2,0,$3,$4,'video/mp4',1024,$5,1080,1920,5000)", [A, batchId, key, `${A}/uploads/${batchId}/0.mp4`, "a".repeat(64)]);
    const objectPath = `studio/uploads/${A}/round6_${sequence}.png`;
    await db.query("insert into public.media_asset_provenance(owner_user_id,bucket_id,object_path,source_type,lifecycle_state) values($1,'generated-private',$2,'upload','draft')", [A, objectPath]);
    return { ownerUserId: A, batchId, ordinal: 0, bucketId: "generated-private", objectPath };
  };
  const poster = createVideoPosterOperationStore({ rpc: async (name, args) => {
    try { return { data: (await db.query(`select public.${name}(${Object.keys(args).map((_, i) => `$${i + 1}`).join(",")}) as v`, Object.values(args))).rows[0].v, error: null }; }
    catch (error) { return { data: null, error }; }
  } });
  const reapplyRejected = async () => { try { await db.exec(v80); return false; } catch { await db.exec("rollback"); return true; } };
  const constraint = async (name: string) => (await db.query("select pg_get_constraintdef(oid) as v from pg_constraint where conrelid='public.video_poster_operations'::regclass and conname=$1", [name])).rows[0].v;
  const replaceConstraint = async (name: string, definition: string) => db.exec(`alter table public.video_poster_operations drop constraint ${name}; alter table public.video_poster_operations add constraint ${name} ${definition}`);
  try {
    await check("F1 unique manifest validates its actual columns and prevents duplicate-poster cleanup", async () => {
      const name = "video_poster_operations_bucket_id_object_path_key"; const original = await constraint(name);
      const first = await seed(); const second = await seed(); const same = { ...second, objectPath: first.objectPath };
      let rejected = false; let cleanable = false;
      try {
        await replaceConstraint(name, "UNIQUE (video_item_id)"); rejected = await reapplyRejected();
        if (!rejected) {
          await poster.associate(first); await db.query("update public.video_upload_items set status='failed' where batch_id=$1", [first.batchId]);
          await poster.associate(same); await db.query("update public.video_upload_items set status='finalized',verified_content_type='video/mp4',verified_byte_size=1024 where batch_id=$1", [second.batchId]);
          await poster.retain(same); cleanable = await poster.canCleanup(first);
          const states = (await db.query("select o.state,i.status from public.video_poster_operations o join public.video_upload_items i on i.id=o.video_item_id where o.object_path=$1 order by o.created_at", [first.objectPath])).rows;
          console.log(JSON.stringify({ reapplyRejected: rejected, cleanable, associations: states }));
        }
      } finally {
        await db.query("delete from public.video_poster_operations where object_path=$1", [first.objectPath]); await replaceConstraint(name, original);
      }
      assert.equal(rejected, true, `same-name wrong-column UNIQUE was adopted; retained path cleanable=${cleanable}`);
    });
    await check("F1 exact manifest refuses a different foreign-key target", async () => {
      const name = "video_poster_operations_video_item_id_fkey"; const original = await constraint(name);
      let rejected = false;
      try { await replaceConstraint(name, "FOREIGN KEY (video_item_id) REFERENCES public.video_upload_batches(id) ON DELETE RESTRICT"); rejected = await reapplyRejected(); }
      finally { await replaceConstraint(name, original); }
      assert.equal(rejected, true, "v80 silently adopts an FK to batches instead of video items");
    });
    await check("F1 exact manifest refuses a different primary-key column set", async () => {
      const name = "video_poster_operations_pkey"; const original = await constraint(name);
      let rejected = false;
      try { await replaceConstraint(name, "PRIMARY KEY (bucket_id, object_path)"); rejected = await reapplyRejected(); }
      finally { await replaceConstraint(name, original); }
      assert.equal(rejected, true, "v80 silently adopts a PK that no longer enforces one poster row per video item");
    });
    await check("F1 exact manifest refuses an altered lifecycle default", async () => {
      let rejected = false;
      try { await db.exec("alter table public.video_poster_operations alter column state set default 'retained'"); rejected = await reapplyRejected(); }
      finally { await db.exec("alter table public.video_poster_operations alter column state set default 'associated'"); }
      assert.equal(rejected, true, "new uploads can silently start in retained state after a drifted default");
    });
    await check("F1 normalizing SQL whitespace must not erase semantic regex whitespace", async () => {
      const name = "video_poster_operations_path_check"; const original = await constraint(name);
      const weakened = original.replace("[A-Za-z0-9_.-]", "[A-Za-z0-9_. -]"); assert.notEqual(weakened, original);
      let rejected = false;
      try { await replaceConstraint(name, weakened); rejected = await reapplyRejected(); }
      finally { await replaceConstraint(name, original); }
      assert.equal(rejected, true, "whitespace inside the regexp literal changes the accepted object paths");
    });
    await check("exact path tautology and independent shadow overload are rejected", async () => {
      const name = "video_poster_operations_path_check"; const original = await constraint(name);
      try { await replaceConstraint(name, "CHECK (object_path IS NOT NULL OR object_path = 'studio/uploads png|jpg|jpeg|webp|gif')"); assert.equal(await reapplyRejected(), true); }
      finally { await replaceConstraint(name, original); }
      try {
        await db.exec("create function public.video_poster_cleanup_authorize(p_owner_user_id text,p_bucket_id text,p_object_path text) returns jsonb language sql as $$ select '{\"allowed\":true}'::jsonb $$; grant execute on function public.video_poster_cleanup_authorize(text,text,text) to authenticated");
        assert.equal(await reapplyRejected(), true);
      } finally { await db.exec("drop function public.video_poster_cleanup_authorize(text,text,text)"); }
    });
    await check("column ACL and RLS drift does not leave readable association rows", async () => {
      const op = await seed(); await poster.associate(op);
      let rejected = false; let rows = 0;
      try {
        await db.exec("grant select(object_path) on public.video_poster_operations to authenticated; create policy review_round6 on public.video_poster_operations for select to authenticated using (true)");
        rejected = await reapplyRejected();
        if (!rejected) {
          await db.exec("set role authenticated");
          try { rows = (await db.query("select object_path from public.video_poster_operations")).rows.length; } catch { rows = 0; }
          finally { await db.exec("reset role"); }
        }
        console.log(JSON.stringify({ reapplyRejected: rejected, authenticatedRows: rows, retainedPolicies: (await db.query("select count(*)::int as n from pg_policy where polrelid='public.video_poster_operations'::regclass")).rows[0].n }));
      } finally { await db.exec("revoke select(object_path) on public.video_poster_operations from authenticated; drop policy review_round6 on public.video_poster_operations"); }
      assert.ok(rejected || rows === 0);
    });
    await check("all isolated drift fixtures restore a valid reapply state", async () => { await db.exec(v80); });
  } finally { await db.close(); }
  console.log(JSON.stringify({ passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).length, results }, null, 2));
  if (results.some(r => !r.passed)) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
