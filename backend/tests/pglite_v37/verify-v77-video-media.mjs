import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const load = path => readFileSync(resolve(root, path), "utf8").replace(/\r\n?/g, "\n");
const migration = load("backend/db/migrate_v77_video_media.sql");
const rollback = load("backend/db/rollback_v77_video_media.sql");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const failures = [];
let assertions = 0;

function assert(value, message) {
  assertions += 1;
  if (!value) throw new Error(message);
}
async function rejected(action) {
  try { await action(); return null; }
  catch (error) { return { message: String(error?.message ?? error).replace(/\s+/g, " ").trim(), code: error?.code ?? null }; }
}
async function bootstrap(db) {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    create schema storage;
    create table storage.buckets(id text primary key,name text not null,public boolean not null);
    create table storage.objects(id uuid primary key,bucket_id text not null,name text not null,owner_id uuid);
    grant usage on schema storage to authenticated,service_role;
    grant select on storage.buckets,storage.objects to authenticated;
    grant select,insert,update,delete on storage.buckets,storage.objects to service_role;
    alter table storage.objects enable row level security;
    alter table storage.objects force row level security;
    create function public.uuid_generate_v4() returns uuid language sql volatile as $$ select gen_random_uuid() $$;
    alter default privileges in schema public grant execute on functions to service_role;
  `);
}
async function dbWithV76() {
  const db = new PGlite();
  await bootstrap(db);
  const pinterest = load("api/migrations/001_pinterest_connections.sql").replace(/create extension if not exists "uuid-ossp";?/gi, "");
  await db.exec(pinterest);
  await db.exec(load("backend/db/migrate_v49_pinterest_token_version.sql"));
  for (const path of [
    "backend/db/migrate_v32_social_connections.sql",
    "backend/db/migrate_v59_social_pinterest_unify.sql",
    "backend/db/migrate_v72_publish_intent_idempotency.sql",
    "backend/db/migrate_v73_publish_intent_retry_lineage.sql",
    "backend/db/migrate_v75_media_provenance.sql",
    "backend/db/migrate_v76_publish_asset_materializer.sql",
  ]) await db.exec(path.includes("v32") ? load(path).replace(/create extension if not exists "uuid-ossp";?/gi, "") : load(path));
  return db;
}
async function asRole(db, role, action) {
  await db.exec(`set role ${role}`);
  try { return await action(); }
  finally { await db.exec("reset role"); }
}
async function prepareBatch(db, owner, key) {
  return (await db.query("select public.video_upload_batch_prepare($1,$2,now()+interval '1 hour') as value", [owner, key])).rows[0].value;
}
async function prepareItem(db, owner, batchId, ordinal, key, mime = "video/mp4", bytes = 1024) {
  return (await db.query(`select public.video_upload_item_prepare(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as value`, [
    owner, batchId, ordinal, key, `${owner}/uploads/${batchId}/${ordinal}.mp4`, mime, bytes,
    "a".repeat(64), 1080, 1920, 15_000,
  ])).rows[0].value;
}
async function run() {
  const db = await dbWithV76();
  try {
    await db.exec(migration);
    await db.exec(migration);
    const schema = await db.query(`select
      to_regclass('public.video_upload_batches')::text as batches,
      to_regclass('public.video_upload_items')::text as items,
      (select relrowsecurity from pg_class where oid='public.video_upload_batches'::regclass) as batch_rls,
      (select relrowsecurity from pg_class where oid='public.video_upload_items'::regclass) as item_rls`);
    assert(schema.rows[0].batches && schema.rows[0].items && schema.rows[0].batch_rls && schema.rows[0].item_rls,
      "apply twice creates RLS-protected batch/item ledgers exactly once");

    const provenanceColumns = (await db.query(`select attname from pg_attribute
      where attrelid='public.media_asset_provenance'::regclass and not attisdropped`)).rows.map(row => row.attname);
    for (const column of ["media_kind", "content_type", "byte_size", "checksum_sha256", "width", "height", "duration_ms"]) {
      assert(provenanceColumns.includes(column), `v77 adds provenance ${column}`);
    }
    await db.query(`insert into public.media_asset_provenance(
      owner_user_id,bucket_id,object_path,source_type,lifecycle_state)
      values($1,'generated-private','${A}/legacy.png','legacy','draft')`, [A]);
    const legacy = await db.query("select media_kind,content_type,byte_size,duration_ms from public.media_asset_provenance where object_path=$1", [`${A}/legacy.png`]);
    assert(JSON.stringify(legacy.rows[0]) === JSON.stringify({ media_kind: "image", content_type: null, byte_size: null, duration_ms: null }),
      "old provenance rows remain valid images without historical data loss");

    const one = await asRole(db, "service_role", () => prepareBatch(db, A, "batch-key"));
    const again = await asRole(db, "service_role", () => prepareBatch(db, A, "batch-key"));
    const otherOwner = await asRole(db, "service_role", () => prepareBatch(db, B, "batch-key"));
    assert(one.batchId === again.batchId && one.batchId !== otherOwner.batchId, "batch idempotency is owner-scoped");
    const item = await asRole(db, "service_role", () => prepareItem(db, A, one.batchId, 0, "item-key"));
    const itemAgain = await asRole(db, "service_role", () => prepareItem(db, A, one.batchId, 0, "item-key"));
    assert(item.itemId === itemAgain.itemId && item.status === "prepared", "item prepare is idempotent and starts prepared");
    const finalized = await asRole(db, "service_role", async () => (await db.query(`select public.video_upload_item_finalize(
      $1,$2,$3,$4,$5,$6,$7,$8,$9) as value`, [A, one.batchId, 0, "video/mp4", 1024, "a".repeat(64), 1080, 1920, 15_000])).rows[0].value);
    assert(finalized.status === "finalized" && finalized.batchStatus === "finalized", "finalize records verified facts and advances the batch lifecycle");

    const crossOwner = await asRole(db, "service_role", () => rejected(() => prepareItem(db, B, one.batchId, 1, "foreign-item")));
    assert(crossOwner?.message === "video_upload_batch_not_found", "a service parent cannot write another owner's batch");
    const tooMany = await asRole(db, "service_role", () => rejected(() => prepareItem(db, A, one.batchId, 20, "ordinal-20")));
    assert(tooMany?.message === "video_upload_batch_limit_exceeded", "a batch permits no more than twenty videos");
    const oversize = await asRole(db, "service_role", () => rejected(() => prepareItem(db, A, one.batchId, 1, "oversize", "video/mp4", 104857601)));
    assert(oversize?.message === "video_upload_too_large", "a video declaration over 100 MiB is rejected with a stable code");
    const badMime = await asRole(db, "service_role", () => rejected(() => prepareItem(db, A, one.batchId, 1, "bad-mime", "video/webm")));
    assert(badMime?.message === "invalid_video_content_type", "only the frozen video MIME allowlist is accepted");

    await db.exec(`set role authenticated; set "request.jwt.claim.sub"='${A}';`);
    const directBatchWrite = await rejected(() => db.query("insert into public.video_upload_batches(owner_user_id,idempotency_key,expires_at) values($1,'client-write',now())", [A]));
    const directItemWrite = await rejected(() => db.query("insert into public.video_upload_items(batch_id,owner_user_id,ordinal,idempotency_key,private_path,declared_content_type,declared_byte_size) values($1,$2,1,'client-item','x','video/mp4',1)", [one.batchId, A]));
    const clientRpc = await rejected(() => db.query("select public.video_upload_batch_prepare($1,'client-rpc',now())", [A]));
    await db.exec("reset role; reset \"request.jwt.claim.sub\";");
    assert(directBatchWrite && directItemWrite && clientRpc, "clients have neither direct writes nor RPC write access");

    for (const mime of ["video/mp4", "video/x-m4v", "video/quicktime"]) {
      const result = await asRole(db, "service_role", () => rejected(() => db.query(
        "select public.publish_asset_settle_item($1,'missing-intent','missing-destination',$2,'media-0',0,'generated-private',$3,$4,1,$5)",
        [A, "33333333-3333-4333-8333-333333333331", `${A}/missing.mp4`, mime, "b".repeat(64)],
      )));
      assert(result?.message === "publish_intent_not_found", `v76 settlement accepts ${mime} before enforcing its intent/lease chain`);
    }
    const v76Rejected = await asRole(db, "service_role", () => rejected(() => db.query(
      "select public.publish_asset_settle_item($1,'missing-intent','missing-destination',$2,'media-0',0,'generated-private',$3,'video/webm',1,$4)",
      [A, "33333333-3333-4333-8333-333333333331", `${A}/missing.webm`, "b".repeat(64)],
    )));
    assert(v76Rejected?.message === "invalid_content_type", "v76 settlement still rejects unapproved video content types before any bypassable state transition");
    const materializationVideo = await asRole(db, "service_role", () => rejected(() => db.query(
      "select public.publish_asset_settle_materialization($1,'missing-intent','missing-destination',$2,'ready','generated-private',$3,'video/quicktime',1,$4,null)",
      [A, "33333333-3333-4333-8333-333333333331", `${A}/missing.mov`, "b".repeat(64)],
    )));
    assert(materializationVideo?.message === "materialization_lease_lost", "the legacy single-item settlement also accepts approved video MIME before enforcing its lease");
    const materializationRejected = await asRole(db, "service_role", () => rejected(() => db.query(
      "select public.publish_asset_settle_materialization($1,'missing-intent','missing-destination',$2,'ready','generated-private',$3,'video/webm',1,$4,null)",
      [A, "33333333-3333-4333-8333-333333333331", `${A}/missing.webm`, "b".repeat(64)],
    )));
    assert(materializationRejected?.message === "invalid_content_type", "the legacy single-item settlement rejects unapproved video MIME before the lease check");

    const beforeRollback = await db.query("select count(*)::int as batches,(select count(*)::int from public.video_upload_items) as items from public.video_upload_batches");
    await db.exec(rollback); await db.exec(rollback); await db.exec(migration);
    const afterReapply = await db.query("select count(*)::int as batches,(select count(*)::int from public.video_upload_items) as items from public.video_upload_batches");
    assert(JSON.stringify(beforeRollback.rows) === JSON.stringify(afterReapply.rows), "rollback/reapply preserves all batch and item evidence");
  } finally { await db.close(); }
}
try { await run(); }
catch (error) { failures.push(String(error?.stack ?? error)); }
console.log(JSON.stringify({ verdict: failures.length ? "fail" : "pass", assertions, failures }, null, 2));
if (failures.length) process.exitCode = 1;
