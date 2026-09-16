// Independent Round 4 review evidence. Real production callbacks/store and isolated PGlite.
// No external requests, production writes, or live database operations.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import ts from "typescript";
import * as batch from "../src/lib/studio/videoBatchUpload";
import * as recovery from "../src/lib/studio/videoBatchRecovery";
import * as store from "../src/lib/pinDraftStore";
import * as browserMedia from "../src/lib/studio/videoBrowserMedia";
import * as cleanup from "../src/app/api/studio/upload/handler";
import { createVideoPosterOperationStore } from "../src/lib/server/media/videoPosterOperationStore";

const formal = readFileSync("scripts/test-video-batch-safety.ts", "utf8");
const helpers = formal.slice(0, formal.indexOf("async function main()"));
const compiled = ts.transpileModule(helpers + "\nreturn { callbacks, reset, memory, A, B, item, photo, inspection, finalize, prepare, deferred };", { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const modules: Record<string, unknown> = { "node:assert/strict": assert, "node:fs": { readFileSync }, typescript: ts,
  "../src/lib/studio/videoBatchUpload": batch, "../src/lib/studio/videoBatchRecovery": recovery, "../src/lib/pinDraftStore": store,
  "../src/lib/studio/videoBrowserMedia": browserMedia, "../src/app/api/studio/upload/handler": cleanup };
const h = new Function("require", "exports", compiled)((name: string) => { assert(name in modules); return modules[name]; }, {});
const root = resolve(process.cwd(), "..");
const load = (path: string) => readFileSync(resolve(root, path), "utf8").replace(/\r\n?/g, "\n");
const migration = load("backend/db/migrate_v80_video_poster_operations.sql");
const verifier = load("backend/tests/pglite_v37/verify-v80-video-poster-operations.mjs");
const bootstrap = new Function("load", verifier.slice(verifier.indexOf("async function bootstrap("), verifier.indexOf("async function asRole(")) + "\nreturn bootstrap;")(load);
const results: { name: string; passed: boolean; evidence?: string }[] = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { const evidence = String((error as Error).message); results.push({ name, passed: false, evidence }); console.log(`FAIL ${name}: ${evidence}`); }
}
async function main() {
  await check("D1 retain failure cannot be bypassed by finalized-receipt reload", async () => {
    h.reset(); let retains = 0;
    const ui = h.callbacks({ retainVideoPosterOperation: async () => { retains++; throw new Error("retain unavailable"); } });
    await ui.executeVideoBatch(batch.createVideoBatchState("retain-failure", [{ ...h.item(), posterFile: h.photo() }]));
    assert.equal(ui.state().status, "failed"); assert.equal(store.getAllDrafts().length, 0);
    assert.ok(recovery.listVideoRecovery(h.A)[0].finalized);
    await ui.recover();
    console.log(`  retain calls=${retains}, recovered drafts=${store.getAllDrafts().length}`);
    assert.equal(store.getAllDrafts().length, 0, "recovery must retry retain and fail closed before draft attachment");
  });
  await check("D3 recovery rejects absolute external origin even with an own-owner proxy path", async () => {
    h.reset(); const record = { version: 1 as const, owner: h.A, logicalId: "external", draftIdempotencyKey: "external", filename: "x.mp4", title: "x", inspection: h.inspection,
      finalized: { proxyUrl: `https://foreign.invalid/api/storage-media?path=${h.A.ownerUserId}%2Fx.mp4`, requestId: "request" }, createdAt: "2026-09-16" };
    assert.equal(recovery.saveVideoRecovery(record), false);
  });
  await check("D3 recovery rejects a foreign poster and mismatched poster-path identity", async () => {
    h.reset(); const record = { version: 1 as const, owner: h.A, logicalId: "poster-owner", draftIdempotencyKey: "poster-owner", filename: "x.mp4", title: "x",
      inspection: { ...h.inspection, posterUrl: `/api/storage-image?path=studio%2Fuploads%2F${h.B.ownerUserId}%2Fforeign.png` },
      posterPath: `studio/uploads/${h.A.ownerUserId}/different.png`, finalized: await h.finalize("x", 0), createdAt: "2026-09-16" };
    assert.equal(recovery.saveVideoRecovery(record), false);
  });

  const originalWindow = globalThis.window;
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
  const backendRequire = createRequire(resolve(root, "backend/tests/pglite_v37/package.json"));
  const { PGlite } = backendRequire("@electric-sql/pglite");
  const db = new PGlite();
  await bootstrap(db); await db.exec(load("backend/db/migrate_v77_video_media.sql")); await db.exec(migration);
  Object.assign(globalThis, { window: originalWindow });
  const posterStore = createVideoPosterOperationStore({ rpc: async (name, args) => {
    try { return { data: (await db.query(`select public.${name}(${Object.keys(args).map((_, i) => `$${i + 1}`).join(",")}) as v`, Object.values(args))).rows[0].v, error: null }; }
    catch (error) { return { data: null, error }; }
  } });
  let serial = 0;
  const seed = async () => {
    const key = `independent_round4_${++serial}`;
    const batchId = (await db.query("select public.video_upload_batch_prepare($1,$2,now()+interval '1 hour') as v", [h.A.ownerUserId, key])).rows[0].v.batchId;
    await db.query("select public.video_upload_item_prepare($1,$2,0,$3,$4,'video/mp4',1024,$5,1080,1920,5000)", [h.A.ownerUserId, batchId, key, `${h.A.ownerUserId}/uploads/${batchId}/0.mp4`, "a".repeat(64)]);
    const path = `studio/uploads/${h.A.ownerUserId}/review_${serial}.png`;
    await db.query("insert into public.media_asset_provenance(owner_user_id,bucket_id,object_path,source_type,lifecycle_state) values($1,'generated-private',$2,'upload','draft')", [h.A.ownerUserId, path]);
    return { ownerUserId: h.A.ownerUserId, batchId, ordinal: 0, bucketId: "generated-private", objectPath: path };
  };
  const finalized = async (id: string) => db.query("update public.video_upload_items set status='finalized',verified_content_type='video/mp4',verified_byte_size=1024 where batch_id=$1", [id]);
  try {
    await check("same-request image handler associates a real v80 operation before acknowledging the poster", async () => {
      const op = await seed(); const form = new FormData();
      form.append("file", h.photo()); form.append("videoBatchId", op.batchId); form.append("videoOrdinal", "0");
      const events: string[] = [];
      const response = await cleanup.handleStudioUpload(new Request("https://app.invalid/upload", { method: "POST", body: form }), {
        getUserId: async () => h.A.ownerUserId, configured: true, pathFactory: () => op.objectPath,
        uploadObject: async () => { events.push("upload"); return { error: null }; },
        registerProvenance: async () => { events.push("provenance"); return true; },
        associatePosterOperation: async input => { await posterStore.associate({ ownerUserId: input.owner_user_id, batchId: input.batch_id, ordinal: input.ordinal, bucketId: input.bucket_id, objectPath: input.object_path }); events.push("associated"); return true; },
        removeObject: async () => { events.push("removed"); },
      });
      assert.equal(response.status, 201); assert.deepEqual(events, ["upload", "provenance", "associated"]);
      assert.equal(await posterStore.canCleanup(op), false);
    });
    await check("v80 real service RPC owner/terminal/raw and canonical-encoded reference gates", async () => {
      const op = await seed(); await posterStore.associate(op);
      assert.equal(await posterStore.canCleanup(op), false);
      await assert.rejects(() => posterStore.associate({ ...op, ownerUserId: h.B.ownerUserId }));
      assert.equal(await posterStore.canCleanup({ ...op, ownerUserId: h.B.ownerUserId }), false);
      await db.query("update public.video_upload_items set status='canceled' where batch_id=$1", [op.batchId]);
      assert.equal(await posterStore.canCleanup(op), true);
      for (const url of [op.objectPath, `/api/storage-image?path=${encodeURIComponent(op.objectPath)}`]) {
        await db.query("insert into public.pin_drafts(draft_id,vibepin_user_id,updated_at,payload) values('reference',$1,now(),jsonb_build_object('posterUrl',$2::text))", [h.A.ownerUserId, url]);
        assert.equal(await posterStore.canCleanup(op), false);
        await db.query("delete from public.pin_drafts where draft_id='reference'");
      }
      for (const role of ["anon", "authenticated"]) {
        for (const signature of ["video_poster_operation_associate(uuid,uuid,integer,text,text)", "video_poster_operation_retain(uuid,uuid,integer,text,text)", "video_poster_cleanup_authorize(uuid,text,text)"]) {
          assert.equal((await db.query("select has_function_privilege($1,$2,'execute') as v", [role, `public.${signature}`])).rows[0].v, false);
        }
        await db.exec(`set role ${role}`);
        try { await assert.rejects(() => db.query("select public.video_poster_cleanup_authorize($1,'generated-private',$2)", [h.A.ownerUserId, op.objectPath]), /permission denied/); }
        finally { await db.exec("reset role"); }
      }
    });
    await check("D2 fresh retry must not reuse an old terminal operation's cleanable poster", async () => {
      h.reset(); const old = await seed(); const fresh = await seed(); await posterStore.associate(old);
      await db.query("update public.video_upload_items set status='failed' where batch_id=$1", [old.batchId]);
      let retains = 0;
      const ui = h.callbacks({
        prepareVideoDirectUpload: async (_key: string, ds: batch.VideoUploadDescriptor[]) => ({ ...await h.prepare(ds), batchId: fresh.batchId }),
        finalizeVideoDirectUpload: async (id: string, ordinal: number) => { if (id === old.batchId) throw Object.assign(new Error("terminal"), { code: "video_upload_not_finalizable" }); await finalized(id); return h.finalize(id, ordinal); },
        retainVideoPosterOperation: async (batchId: string, ordinal: number, path: string) => { retains++; await posterStore.retain({ ...fresh, batchId, ordinal, objectPath: path }); },
      });
      const initial = { ...h.item(), posterFile: h.photo(), posterPath: old.objectPath,
        inspection: { ...h.inspection, posterUrl: `/api/storage-image?path=${encodeURIComponent(old.objectPath)}` },
        attempt: { id: "old", batchId: old.batchId, ordinal: 0, phase: "finalize_pending" as const } };
      await ui.executeVideoBatch(batch.createVideoBatchState("terminal-with-poster", [initial]));
      console.log(`  before reload=${ui.state().status}, error=${ui.state().items[0].error?.code}`);
      await ui.recover();
      const attached = store.getAllDrafts(); const cleanable = await posterStore.canCleanup(old);
      console.log(`  retain calls=${retains}, attached=${attached.length}, old poster cleanable=${cleanable}`);
      assert.equal(attached.length > 0 && cleanable, false, "actual local draft cannot reference a poster the real server authorizes for deletion");
    });
    await check("D4 retain idempotency must bind batch and ordinal, not only owner/path", async () => {
      const op = await seed(); await posterStore.associate(op); await finalized(op.batchId); await posterStore.retain(op);
      await assert.rejects(() => posterStore.retain({ ...op, batchId: "33333333-3333-4333-8333-333333333333", ordinal: 19 }), /not_retainable/);
    });
    await check("D5 any valid lowercase-percent-encoded live reference blocks cleanup", async () => {
      const op = await seed(); await posterStore.associate(op); await db.query("update public.video_upload_items set status='failed' where batch_id=$1", [op.batchId]);
      const lower = `/api/storage-image?path=${encodeURIComponent(op.objectPath).replace(/%2F/g, "%2f")}`;
      await db.query("insert into public.pin_drafts(draft_id,vibepin_user_id,updated_at,payload) values('lower-reference',$1,now(),jsonb_build_object('posterUrl',$2::text))", [h.A.ownerUserId, lower]);
      assert.equal(new URL(lower, "https://app.invalid").searchParams.get("path"), op.objectPath);
      assert.equal(await posterStore.canCleanup(op), false);
    });
    await check("D6 migration must reject or repair missing owned path constraint", async () => {
      await db.exec("alter table public.video_poster_operations drop constraint video_poster_operations_path_check");
      let rejected = false; try { await db.exec(migration); } catch { rejected = true; await db.exec("rollback"); }
      const count = (await db.query("select count(*)::int as n from pg_constraint where conrelid='public.video_poster_operations'::regclass and conname='video_poster_operations_path_check'")).rows[0].n;
      assert.ok(rejected || count === 1, "reapply silently succeeds with its safety constraint absent");
    });
    await check("D6 migration must reject or revoke an exposed shadow RPC overload", async () => {
      await db.exec("create function public.video_poster_cleanup_authorize(p_owner_user_id text,p_bucket_id text,p_object_path text) returns jsonb language sql security definer as $$ select '{\"allowed\":true}'::jsonb $$; grant execute on function public.video_poster_cleanup_authorize(text,text,text) to authenticated");
      let rejected = false; try { await db.exec(migration); } catch { rejected = true; await db.exec("rollback"); }
      const exposed = (await db.query("select has_function_privilege('authenticated','public.video_poster_cleanup_authorize(text,text,text)','execute') as v")).rows[0].v;
      assert.ok(rejected || !exposed, "fresh-only overload test misses callable shadow overload surviving reapply");
    });
    await check("new mutation: removing terminal cleanup guard is killed against prepared operation", async () => {
      const op = await seed(); await posterStore.associate(op);
      // Explicit signature isolates the mutation from the earlier hostile overload fixture.
      const exact = async () => (await db.query("select public.video_poster_cleanup_authorize($1::uuid,$2::text,$3::text) as v", [op.ownerUserId, op.bucketId, op.objectPath])).rows[0].v.allowed;
      assert.equal(await exact(), false);
      const definition = (await db.query("select pg_get_functiondef('public.video_poster_cleanup_authorize(uuid,text,text)'::regprocedure) as v")).rows[0].v as string;
      const needle = "if v_status not in ('failed','canceled') then"; assert.ok(definition.includes(needle));
      await db.exec(definition.replace(needle, "if false then"));
      assert.equal(await exact(), true, "mutant must actually reach the unsafe acceptance");
      await db.exec(definition); assert.equal(await exact(), false);
    });
  } finally { await db.close(); }
  console.log(JSON.stringify({ passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).length, results }, null, 2));
  if (results.some(r => !r.passed)) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
