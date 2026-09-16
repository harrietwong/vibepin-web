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
async function claimItem(db, owner, batchId, ordinal, token, leaseSeconds = 60) {
  return (await db.query(`select public.video_upload_item_claim(
    $1,$2,$3,$4,now()+($5::text || ' seconds')::interval) as value`, [
    owner, batchId, ordinal, token, leaseSeconds,
  ])).rows[0].value;
}
async function finalizeItem(db, owner, batchId, ordinal, token, checksum = null) {
  return (await db.query(`select public.video_upload_item_finalize(
    $1,$2,$3,$4,'generated-private','video/mp4',1024,$5) as value`, [
    owner, batchId, ordinal, token, checksum,
  ])).rows[0].value;
}
async function failItem(db, owner, batchId, ordinal, token, code = "invalid_video_container") {
  return (await db.query(`select public.video_upload_item_fail($1,$2,$3,$4,$5) as value`, [
    owner, batchId, ordinal, token, code,
  ])).rows[0].value;
}
async function run() {
  const db = await dbWithV76();
  try {
    await db.query(`insert into public.media_asset_provenance(
      owner_user_id,bucket_id,object_path,source_type,lifecycle_state)
      values($1,'generated-private','${A}/legacy.png','legacy','draft')`, [A]);
    const v76Before = (await db.query("select pg_get_functiondef(to_regprocedure($1)) as definition", [
      "public.publish_asset_settle_item(uuid,text,text,uuid,text,integer,text,text,text,bigint,text)",
    ])).rows[0].definition;
    await db.exec(migration);
    await db.exec(migration);
    const schema = await db.query(`select
      to_regclass('public.video_upload_batches')::text as batches,
      to_regclass('public.video_upload_items')::text as items,
      (select relrowsecurity from pg_class where oid='public.video_upload_batches'::regclass) as batch_rls,
      (select relrowsecurity from pg_class where oid='public.video_upload_items'::regclass) as item_rls`);
    assert(schema.rows[0].batches && schema.rows[0].items && schema.rows[0].batch_rls && schema.rows[0].item_rls,
      "apply twice creates RLS-protected batch/item ledgers exactly once");

    // This is deliberately table-driven: v77 reapply owns the complete shape of
    // its ledgers, rather than only a hand-picked set of columns.
    const expectedColumns = [
      ["video_upload_batches", "id", "uuid", true, "gen_random_uuid()"],
      ["video_upload_batches", "owner_user_id", "uuid", true, null],
      ["video_upload_batches", "idempotency_key", "text", true, null],
      ["video_upload_batches", "status", "text", true, "'prepared'::text"],
      ["video_upload_batches", "error_code", "text", false, null],
      ["video_upload_batches", "prepared_at", "timestamp with time zone", true, "now()"],
      ["video_upload_batches", "finalized_at", "timestamp with time zone", false, null],
      ["video_upload_batches", "expires_at", "timestamp with time zone", true, null],
      ["video_upload_batches", "created_at", "timestamp with time zone", true, "now()"],
      ["video_upload_batches", "updated_at", "timestamp with time zone", true, "now()"],
      ["video_upload_items", "id", "uuid", true, "gen_random_uuid()"],
      ["video_upload_items", "batch_id", "uuid", true, null],
      ["video_upload_items", "owner_user_id", "uuid", true, null],
      ["video_upload_items", "ordinal", "integer", true, null],
      ["video_upload_items", "idempotency_key", "text", true, null],
      ["video_upload_items", "private_path", "text", true, null],
      ["video_upload_items", "declared_content_type", "text", true, null],
      ["video_upload_items", "declared_byte_size", "bigint", true, null],
      ["video_upload_items", "declared_checksum_sha256", "text", false, null],
      ["video_upload_items", "declared_width", "integer", false, null],
      ["video_upload_items", "declared_height", "integer", false, null],
      ["video_upload_items", "declared_duration_ms", "bigint", false, null],
      ["video_upload_items", "verified_content_type", "text", false, null],
      ["video_upload_items", "verified_byte_size", "bigint", false, null],
      ["video_upload_items", "verified_checksum_sha256", "text", false, null],
      ["video_upload_items", "verified_width", "integer", false, null],
      ["video_upload_items", "verified_height", "integer", false, null],
      ["video_upload_items", "verified_duration_ms", "bigint", false, null],
      ["video_upload_items", "finalize_claim_token", "uuid", false, null],
      ["video_upload_items", "finalize_claim_expires_at", "timestamp with time zone", false, null],
      ["video_upload_items", "status", "text", true, "'prepared'::text"],
      ["video_upload_items", "error_code", "text", false, null],
      ["video_upload_items", "prepared_at", "timestamp with time zone", true, "now()"],
      ["video_upload_items", "finalized_at", "timestamp with time zone", false, null],
      ["video_upload_items", "expires_at", "timestamp with time zone", true, null],
      ["video_upload_items", "created_at", "timestamp with time zone", true, "now()"],
      ["video_upload_items", "updated_at", "timestamp with time zone", true, "now()"],
      ["media_asset_provenance", "media_kind", "text", true, "'image'::text"],
      ["media_asset_provenance", "content_type", "text", false, null],
      ["media_asset_provenance", "byte_size", "bigint", false, null],
      ["media_asset_provenance", "checksum_sha256", "text", false, null],
      ["media_asset_provenance", "width", "integer", false, null],
      ["media_asset_provenance", "height", "integer", false, null],
      ["media_asset_provenance", "duration_ms", "bigint", false, null],
      ["media_asset_provenance", "content_type_source", "text", false, null],
      ["media_asset_provenance", "byte_size_source", "text", false, null],
      ["media_asset_provenance", "checksum_source", "text", false, null],
      ["media_asset_provenance", "dimensions_source", "text", false, null],
      ["media_asset_provenance", "duration_source", "text", false, null],
    ];
    const actualColumns = await db.query(`select c.relname as table_name,a.attname,
      format_type(a.atttypid,a.atttypmod) as type,a.attnotnull,
      pg_get_expr(d.adbin,d.adrelid) as default_value
      from pg_attribute a join pg_class c on c.oid=a.attrelid
      left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where c.relnamespace='public'::regnamespace and c.relname in
        ('video_upload_batches','video_upload_items','media_asset_provenance')
        and not a.attisdropped and a.attnum>0 order by c.relname,a.attnum`);
    for (const [table, column, type, required, defaultValue] of expectedColumns) {
      assert(actualColumns.rows.some(row => row.table_name === table && row.attname === column
        && row.type === type && row.attnotnull === required && row.default_value === defaultValue),
      `schema inventory owns ${table}.${column} type/nullability/default`);
    }

    const provenanceColumns = (await db.query(`select attname from pg_attribute
      where attrelid='public.media_asset_provenance'::regclass and not attisdropped`)).rows.map(row => row.attname);
    for (const column of ["media_kind", "content_type", "byte_size", "checksum_sha256", "width", "height", "duration_ms",
      "content_type_source", "byte_size_source", "checksum_source", "dimensions_source", "duration_source"]) {
      assert(provenanceColumns.includes(column), `v77 adds provenance ${column}`);
    }
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
    const changedPrepare = await asRole(db, "service_role", () => rejected(() => db.query(`select public.video_upload_item_prepare(
      $1,$2,0,'item-key',$3,'video/mp4',1024,$4,720,1280,10_000)`,
      [A, one.batchId, `${A}/uploads/${one.batchId}/0.mp4`, "d".repeat(64)])));
    assert(changedPrepare?.message === "video_upload_item_idempotency_conflict", "replay conflicts whenever immutable declared facts differ");

    const claimToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const competingToken = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const claimed = await asRole(db, "service_role", () => claimItem(db, A, one.batchId, 0, claimToken));
    const competingClaim = await asRole(db, "service_role", () => rejected(() => claimItem(db, A, one.batchId, 0, competingToken)));
    assert(claimed.status === "finalizing" && claimed.claimToken === claimToken && competingClaim?.message === "video_upload_item_claimed",
      "an owner-scoped atomic claim admits one finalizer and rejects a concurrent claimant");
    const wrongClaimFailure = await asRole(db, "service_role", () => rejected(() => failItem(db, A, one.batchId, 0, competingToken)));
    const stillClaimed = (await db.query("select status,finalize_claim_token from public.video_upload_items where id=$1", [item.itemId])).rows[0];
    assert(wrongClaimFailure?.message === "video_upload_claim_lost" && stillClaimed.status === "finalizing" && stillClaimed.finalize_claim_token === claimToken,
      "a losing claimant cannot mark or clean up the winner's item");

    const finalized = await asRole(db, "service_role", () => finalizeItem(db, A, one.batchId, 0, claimToken, null));
    const finalizedFacts = (await db.query(`select status,verified_content_type,verified_byte_size,verified_checksum_sha256,
      verified_width,verified_height,verified_duration_ms,finalize_claim_token from public.video_upload_items where id=$1`, [item.itemId])).rows[0];
    const provenance = (await db.query(`select owner_user_id,media_kind,content_type,byte_size,checksum_sha256,width,height,duration_ms,
      content_type_source,byte_size_source,checksum_source,dimensions_source,duration_source
      from public.media_asset_provenance where bucket_id='generated-private' and object_path=$1`, [`${A}/uploads/${one.batchId}/0.mp4`])).rows[0];
    assert(finalized.status === "finalized" && finalized.provenanceReady === true
      && JSON.stringify(finalizedFacts) === JSON.stringify({ status: "finalized", verified_content_type: "video/mp4", verified_byte_size: 1024,
        verified_checksum_sha256: null, verified_width: null, verified_height: null, verified_duration_ms: null, finalize_claim_token: null }),
      "atomic finalization records only storage-verified facts and clears the claim");
    assert(JSON.stringify(provenance) === JSON.stringify({ owner_user_id: A, media_kind: "video", content_type: "video/mp4", byte_size: 1024,
      checksum_sha256: null, width: 1080, height: 1920, duration_ms: 15_000, content_type_source: "storage_head_verified",
      byte_size_source: "storage_head_verified", checksum_source: "unavailable", dimensions_source: "browser_declared", duration_source: "browser_declared" }),
      "the same transaction registers provenance with explicit source/trust labels for observed facts");

    await db.query("delete from public.media_asset_provenance where bucket_id='generated-private' and object_path=$1", [`${A}/uploads/${one.batchId}/0.mp4`]);
    const incompleteReplay = await asRole(db, "service_role", () => rejected(() => claimItem(db, A, one.batchId, 0, competingToken)));
    assert(incompleteReplay?.message === "video_upload_provenance_incomplete", `finalized replay fails closed when complete provenance is missing: ${incompleteReplay?.message}`);
    await db.query(`insert into public.media_asset_provenance(owner_user_id,bucket_id,object_path,source_type,lifecycle_state,media_kind,
      content_type,byte_size,width,height,duration_ms,content_type_source,byte_size_source,checksum_source,dimensions_source,duration_source)
      values($1,'generated-private',$2,'upload','draft','video','video/mp4',1024,1080,1920,15000,
      'storage_head_verified','storage_head_verified','unavailable','browser_declared','browser_declared')`, [A, `${A}/uploads/${one.batchId}/0.mp4`]);

    const conflictBatch = await asRole(db, "service_role", () => prepareBatch(db, A, "conflict-batch"));
    const conflictItem = await asRole(db, "service_role", () => prepareItem(db, A, conflictBatch.batchId, 0, "conflict-item"));
    await db.query(`insert into public.media_asset_provenance(owner_user_id,bucket_id,object_path,source_type,lifecycle_state)
      values($1,'generated-private',$2,'legacy','draft')`, [B, `${A}/uploads/${conflictBatch.batchId}/0.mp4`]);
    await asRole(db, "service_role", () => claimItem(db, A, conflictBatch.batchId, 0, competingToken));
    const atomicConflict = await asRole(db, "service_role", () => rejected(() => finalizeItem(db, A, conflictBatch.batchId, 0, competingToken, "a".repeat(64))));
    const conflictState = (await db.query("select status,verified_content_type from public.video_upload_items where id=$1", [conflictItem.itemId])).rows[0];
    assert(atomicConflict?.message === "video_provenance_conflict" && conflictState.status === "finalizing" && conflictState.verified_content_type === null,
      "provenance conflict rolls back final facts and lifecycle in the same database transaction");

    const failureBatch = await asRole(db, "service_role", () => prepareBatch(db, A, "failure-batch"));
    const failureItem = await asRole(db, "service_role", () => prepareItem(db, A, failureBatch.batchId, 0, "failure-item"));
    await asRole(db, "service_role", () => claimItem(db, A, failureBatch.batchId, 0, claimToken));
    const failed = await asRole(db, "service_role", () => failItem(db, A, failureBatch.batchId, 0, claimToken));
    const failedState = (await db.query("select status,finalize_claim_token from public.video_upload_items where id=$1", [failureItem.itemId])).rows[0];
    assert(failed.cleanupAllowed === true && failed.status === "failed" && failedState.status === "failed" && failedState.finalize_claim_token === null,
      "only the current claim owner receives cleanup authority after atomically recording failure");

    const partialBatch = await asRole(db, "service_role", () => prepareBatch(db, A, "partial-batch"));
    const partialFailed = await asRole(db, "service_role", () => prepareItem(db, A, partialBatch.batchId, 0, "partial-failed"));
    const partialWinner = await asRole(db, "service_role", () => prepareItem(db, A, partialBatch.batchId, 1, "partial-winner"));
    await asRole(db, "service_role", () => claimItem(db, A, partialBatch.batchId, 0, claimToken));
    await asRole(db, "service_role", () => failItem(db, A, partialBatch.batchId, 0, claimToken));
    await asRole(db, "service_role", () => claimItem(db, A, partialBatch.batchId, 1, competingToken));
    await asRole(db, "service_role", () => finalizeItem(db, A, partialBatch.batchId, 1, competingToken, null));
    const partialState = await db.query("select id,status from public.video_upload_items where id in ($1,$2) order by ordinal", [partialFailed.itemId, partialWinner.itemId]);
    const partialBatchState = (await db.query("select status from public.video_upload_batches where id=$1", [partialBatch.batchId])).rows[0];
    assert(partialState.rows[0].status === "failed" && partialState.rows[1].status === "finalized" && partialBatchState.status === "failed",
      "one failed item does not block an independently claimed sibling from atomically finalizing");

    const takeoverBatch = await asRole(db, "service_role", () => prepareBatch(db, A, "takeover-batch"));
    const takeoverItem = await asRole(db, "service_role", () => prepareItem(db, A, takeoverBatch.batchId, 0, "takeover-item"));
    await asRole(db, "service_role", () => claimItem(db, A, takeoverBatch.batchId, 0, claimToken));
    await db.query("update public.video_upload_items set finalize_claim_expires_at=now()-interval '1 second' where id=$1", [takeoverItem.itemId]);
    const takeover = await asRole(db, "service_role", () => claimItem(db, A, takeoverBatch.batchId, 0, competingToken));
    const staleCleanup = await asRole(db, "service_role", () => rejected(() => failItem(db, A, takeoverBatch.batchId, 0, claimToken)));
    const takeoverCleanup = await asRole(db, "service_role", () => failItem(db, A, takeoverBatch.batchId, 0, competingToken));
    assert(takeover.claimToken === competingToken && staleCleanup?.message === "video_upload_claim_lost" && takeoverCleanup.cleanupAllowed === true,
      "an expired lease can be recovered while the stale owner permanently loses cleanup authority");

    const terminalBatch = await asRole(db, "service_role", () => prepareBatch(db, A, "terminal-batch"));
    const terminalItem = await asRole(db, "service_role", () => prepareItem(db, A, terminalBatch.batchId, 0, "terminal-item"));
    const directFinalizedUpdate = await asRole(db, "service_role", () => rejected(() => db.query(
      "update public.video_upload_items set status='finalized',verified_checksum_sha256='direct' where id=$1", [terminalItem.itemId],
    )));
    const directFinalizedInsert = await asRole(db, "service_role", () => rejected(() => db.query(`insert into public.video_upload_items(
      batch_id,owner_user_id,ordinal,idempotency_key,private_path,declared_content_type,declared_byte_size,
      declared_width,declared_height,declared_duration_ms,status,expires_at
    ) values($1,$2,1,'direct-final','${A}/direct.mp4','video/mp4',1,1,1,4000,'finalized',now()+interval '1 hour')`, [terminalBatch.batchId, A])));
    assert(directFinalizedUpdate && directFinalizedInsert, "service-role direct INSERT/UPDATE cannot create a finalized item with NULL verified facts");
    await db.query("update public.video_upload_batches set status='canceled' where id=$1", [terminalBatch.batchId]);
    const canceledClaim = await asRole(db, "service_role", () => rejected(() => claimItem(db, A, terminalBatch.batchId, 0, claimToken)));
    assert(canceledClaim?.message === "video_upload_batch_not_finalizable", "claim cannot revive a canceled batch");

    const crossOwner = await asRole(db, "service_role", () => rejected(() => prepareItem(db, B, one.batchId, 1, "foreign-item")));
    assert(crossOwner?.message === "video_upload_batch_not_found", "a service parent cannot write another owner's batch");
    const tooMany = await asRole(db, "service_role", () => rejected(() => prepareItem(db, A, one.batchId, 20, "ordinal-20")));
    assert(tooMany?.message === "video_upload_batch_limit_exceeded", "a batch permits no more than twenty videos");
    const oversize = await asRole(db, "service_role", () => rejected(() => prepareItem(db, A, one.batchId, 1, "oversize", "video/mp4", 104857601)));
    assert(oversize?.message === "video_upload_too_large", "a video declaration over 100 MiB is rejected with a stable code");
    const badMime = await asRole(db, "service_role", () => rejected(() => prepareItem(db, A, one.batchId, 1, "bad-mime", "video/webm")));
    assert(badMime?.message === "invalid_video_content_type", "only the frozen video MIME allowlist is accepted");
    const durationBatch = await asRole(db, "service_role", () => prepareBatch(db, A, "duration-batch"));
    const shortDuration = await asRole(db, "service_role", () => rejected(() => db.query(`select public.video_upload_item_prepare(
      $1,$2,1,'too-short',$3,'video/mp4',1024,$4,1080,1920,3999)`, [A, durationBatch.batchId, `${A}/short.mp4`, "a".repeat(64)])));
    const longDuration = await asRole(db, "service_role", () => rejected(() => db.query(`select public.video_upload_item_prepare(
      $1,$2,1,'too-long',$3,'video/mp4',1024,$4,1080,1920,300001)`, [A, durationBatch.batchId, `${A}/long.mp4`, "a".repeat(64)])));
    assert(shortDuration?.message === "invalid_declared_video_facts" && longDuration?.message === "invalid_declared_video_facts",
      "the database shares the 4-second through 5-minute declared duration boundary");

    await db.exec(`set role authenticated; set "request.jwt.claim.sub"='${A}';`);
    const directBatchWrite = await rejected(() => db.query("insert into public.video_upload_batches(owner_user_id,idempotency_key,expires_at) values($1,'client-write',now())", [A]));
    const directItemWrite = await rejected(() => db.query("insert into public.video_upload_items(batch_id,owner_user_id,ordinal,idempotency_key,private_path,declared_content_type,declared_byte_size) values($1,$2,1,'client-item','x','video/mp4',1)", [one.batchId, A]));
    const clientRpc = await rejected(() => db.query("select public.video_upload_batch_prepare($1,'client-rpc',now())", [A]));
    const clientClaimRpc = await rejected(() => db.query("select public.video_upload_item_claim($1,$2,0,$3,now()+interval '1 minute')", [A, one.batchId, claimToken]));
    const clientFinalizeRpc = await rejected(() => db.query("select public.video_upload_item_finalize($1,$2,0,$3,'generated-private','video/mp4',1024,null)", [A, one.batchId, claimToken]));
    const clientFailRpc = await rejected(() => db.query("select public.video_upload_item_fail($1,$2,0,$3,'x')", [A, one.batchId, claimToken]));
    await db.exec("reset role; reset \"request.jwt.claim.sub\";");
    assert(directBatchWrite && directItemWrite && clientRpc && clientClaimRpc && clientFinalizeRpc && clientFailRpc,
      "clients have neither direct writes nor any claim/finalize/fail RPC write access");

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

    const beforeRollback = await db.query(`select jsonb_build_object(
      'batches',(select coalesce(jsonb_agg(to_jsonb(b) order by b.id),'[]'::jsonb) from public.video_upload_batches b),
      'items',(select coalesce(jsonb_agg(to_jsonb(i) order by i.id),'[]'::jsonb) from public.video_upload_items i),
      'provenance',(select coalesce(jsonb_agg(to_jsonb(p) order by p.object_path),'[]'::jsonb) from public.media_asset_provenance p)
    ) as state`);
    await db.exec(rollback); await db.exec(rollback);
    const rollbackTableWrite = await asRole(db, "service_role", () => rejected(() => db.query(
      "insert into public.video_upload_batches(owner_user_id,idempotency_key,expires_at) values($1,'rollback-write',now()+interval '1 hour')", [A],
    )));
    const rollbackRpc = await asRole(db, "service_role", () => rejected(() => db.query(
      "select public.video_upload_batch_prepare($1,'rollback-rpc',now()+interval '1 hour')", [A],
    )));
    const rollbackPrivileges = (await db.query(`select
      has_function_privilege('service_role',to_regprocedure('public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz)'),'execute') as claim_execute,
      has_function_privilege('service_role',to_regprocedure('public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text)'),'execute') as finalize_execute,
      has_function_privilege('service_role',to_regprocedure('public.video_upload_item_fail(uuid,uuid,integer,uuid,text)'),'execute') as fail_execute`)).rows[0];
    assert(rollbackTableWrite && rollbackRpc && !rollbackPrivileges.claim_execute && !rollbackPrivileges.finalize_execute && !rollbackPrivileges.fail_execute,
      "rollback leaves service_role read-only and removes every v77 claim/finalize/fail execute grant");
    const v76Restored = (await db.query("select pg_get_functiondef(to_regprocedure($1)) as definition", [
      "public.publish_asset_settle_item(uuid,text,text,uuid,text,integer,text,text,text,bigint,text)",
    ])).rows[0].definition;
    await db.exec(migration);
    const activePrivileges = await db.query(`select
      has_table_privilege('service_role','public.video_upload_items','select') as service_select,
      has_table_privilege('service_role','public.video_upload_items','insert') as service_insert,
      has_table_privilege('service_role','public.video_upload_items','truncate') as service_truncate,
      has_table_privilege('authenticated','public.video_upload_items','select') as authenticated_select,
      has_function_privilege('service_role',to_regprocedure('public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz)'),'execute') as service_claim,
      has_function_privilege('service_role',to_regprocedure('public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text)'),'execute') as service_finalize,
      has_function_privilege('service_role',to_regprocedure('public.video_upload_item_fail(uuid,uuid,integer,uuid,text)'),'execute') as service_fail,
      has_function_privilege('authenticated',to_regprocedure('public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz)'),'execute') as authenticated_claim,
      has_function_privilege('authenticated',to_regprocedure('public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text)'),'execute') as authenticated_finalize,
      has_function_privilege('authenticated',to_regprocedure('public.video_upload_item_fail(uuid,uuid,integer,uuid,text)'),'execute') as authenticated_fail`);
    assert(activePrivileges.rows[0].service_select && activePrivileges.rows[0].service_insert
      && !activePrivileges.rows[0].service_truncate && !activePrivileges.rows[0].authenticated_select
      && activePrivileges.rows[0].service_claim && activePrivileges.rows[0].service_finalize && activePrivileges.rows[0].service_fail
      && !activePrivileges.rows[0].authenticated_claim && !activePrivileges.rows[0].authenticated_finalize && !activePrivileges.rows[0].authenticated_fail,
    "ordered rollback/reapply restores exactly the active service-only privilege manifest");
    const afterReapply = await db.query(`select jsonb_build_object(
      'batches',(select coalesce(jsonb_agg(to_jsonb(b) order by b.id),'[]'::jsonb) from public.video_upload_batches b),
      'items',(select coalesce(jsonb_agg(to_jsonb(i) order by i.id),'[]'::jsonb) from public.video_upload_items i),
      'provenance',(select coalesce(jsonb_agg(to_jsonb(p) order by p.object_path),'[]'::jsonb) from public.media_asset_provenance p)
    ) as state`);
    const v76After = (await db.query("select pg_get_functiondef(to_regprocedure($1)) as definition", [
      "public.publish_asset_settle_item(uuid,text,text,uuid,text,integer,text,text,text,bigint,text)",
    ])).rows[0].definition;
    assert(JSON.stringify(beforeRollback.rows) === JSON.stringify(afterReapply.rows) && v76Restored === v76Before && v76After !== v76Before,
      "rollback exactly restores v76 and reapply preserves complete evidence with the v77 video guard");
  } finally { await db.close(); }
}
async function collisionRejections() {
  const cases = [
    {
      name: "wrong provenance type",
      setup: db => db.exec("alter table public.media_asset_provenance add column content_type integer"),
      apply: db => db.exec(migration),
      expected: "v77_schema_collision",
    },
    {
      name: "unmarked v77 RPC",
      setup: db => db.exec(`create function public.video_upload_batch_prepare(uuid,text,timestamptz)
        returns jsonb language sql as $$ select '{}'::jsonb $$`),
      apply: db => db.exec(migration),
      expected: "v77_schema_collision",
    },
  ];
  for (const scenario of cases) {
    const db = await dbWithV76();
    try {
      await scenario.setup(db);
      const before = (await db.query("select count(*)::int as rows from public.media_asset_provenance")).rows[0];
      const error = await rejected(() => scenario.apply(db));
      await db.exec("rollback");
      const after = (await db.query("select count(*)::int as rows from public.media_asset_provenance")).rows[0];
      assert(error?.message === scenario.expected && JSON.stringify(before) === JSON.stringify(after), `${scenario.name} is rejected without data mutation`);
    } finally { await db.close(); }
  }
  {
    const db = await dbWithV76();
    try {
      await db.exec(migration);
      await db.exec("alter table public.video_upload_items drop constraint video_upload_items_ordinal_check");
      const before = (await db.query("select count(*)::int as rows from public.video_upload_items")).rows[0];
      const error = await rejected(() => db.exec(migration));
      await db.exec("rollback");
      const after = (await db.query("select count(*)::int as rows from public.video_upload_items")).rows[0];
      assert(error?.message === "v77_schema_collision" && JSON.stringify(before) === JSON.stringify(after), "dropped owned ordinal constraint rejects reapply without row mutation");
    } finally { await db.close(); }
  }
  for (const scenario of [
    {
      name: "same-name altered ordinal constraint",
      alter: db => db.exec("alter table public.video_upload_items drop constraint video_upload_items_ordinal_check; alter table public.video_upload_items add constraint video_upload_items_ordinal_check check (true)"),
    },
    {
      name: "media kind default drift",
      alter: db => db.exec("alter table public.media_asset_provenance alter column media_kind set default 'video'"),
    },
    {
      name: "item owner nullability drift",
      alter: db => db.exec("alter table public.video_upload_items alter column owner_user_id drop not null"),
    },
    {
      name: "marked modified v77 RPC",
      alter: async db => {
        const definition = (await db.query("select pg_get_functiondef(to_regprocedure($1)) as definition", [
          "public.video_upload_batch_prepare(uuid,text,timestamptz)",
        ])).rows[0].definition;
        await db.exec(definition.replace("if p_owner_user_id is null", "if false and p_owner_user_id is null"));
      },
    },
    {
      name: "batch owner nullability drift",
      alter: db => db.exec("alter table public.video_upload_batches alter column owner_user_id drop not null"),
    },
    {
      name: "provenance content type default drift",
      alter: db => db.exec("alter table public.media_asset_provenance alter column content_type set default 'video/mp4'"),
    },
    {
      name: "provenance byte size required drift",
      alter: db => db.exec("alter table public.media_asset_provenance alter column byte_size set not null"),
    },
    {
      name: "declared byte size type drift",
      alter: db => db.exec("alter table public.video_upload_items alter column declared_byte_size type numeric"),
    },
    {
      name: "same-name altered finalized facts constraint",
      alter: db => db.exec("alter table public.video_upload_items drop constraint video_upload_items_finalized_facts_check; alter table public.video_upload_items add constraint video_upload_items_finalized_facts_check check (true)"),
    },
    {
      name: "same-name altered item status constraint",
      alter: db => db.exec("alter table public.video_upload_items drop constraint video_upload_items_status_check; alter table public.video_upload_items add constraint video_upload_items_status_check check (true)"),
    },
    {
      name: "client upload privilege drift",
      alter: db => db.exec("grant insert on public.video_upload_items to authenticated"),
    },
    {
      name: "authenticated truncate privilege drift",
      alter: db => db.exec("grant truncate on public.video_upload_items to authenticated"),
    },
    {
      name: "authenticated column update privilege drift",
      alter: db => db.exec("grant update(verified_content_type) on public.video_upload_items to authenticated"),
    },
    {
      name: "authenticated upload finalize execute drift",
      alter: db => db.exec("grant execute on function public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text) to authenticated"),
    },
    {
      name: "service grant option drift",
      alter: db => db.exec("grant select on public.video_upload_items to service_role with grant option"),
    },
  ]) {
    const db = await dbWithV76();
    try {
      await db.exec(migration);
      await scenario.alter(db);
      const before = (await db.query("select count(*)::int as rows from public.video_upload_items")).rows[0];
      const error = await rejected(() => db.exec(migration));
      await db.exec("rollback");
      const after = (await db.query("select count(*)::int as rows from public.video_upload_items")).rows[0];
      assert(error?.message === "v77_schema_collision" && JSON.stringify(before) === JSON.stringify(after), `${scenario.name} rejects a marked/same-name collision without row mutation`);
    } finally { await db.close(); }
  }
  {
    const db = await dbWithV76();
    try {
      const signature = "public.publish_asset_settle_item(uuid,text,text,uuid,text,integer,text,text,text,bigint,text)";
      const original = (await db.query("select pg_get_functiondef(to_regprocedure($1)) as definition", [signature])).rows[0].definition;
      await db.exec(original.replace("if coalesce(p_content_type,'') not in", "if false and coalesce(p_content_type,'') not in"));
      const tampered = (await db.query("select pg_get_functiondef(to_regprocedure($1)) as definition", [signature])).rows[0].definition;
      const error = await rejected(() => db.exec(migration));
      await db.exec("rollback");
      const after = (await db.query("select pg_get_functiondef(to_regprocedure($1)) as definition", [signature])).rows[0].definition;
      assert(error?.message === "v77_v76_function_collision" && tampered === after,
        "a body-tampered but still marked v76 function is never adopted or overwritten");
    } finally { await db.close(); }
  }
  {
    const db = await dbWithV76();
    try {
      await db.exec(migration);
      const signature = "public.publish_asset_settle_item(uuid,text,text,uuid,text,integer,text,text,text,bigint,text)";
      const before = (await db.query("select pg_get_functiondef(to_regprocedure($1)) as definition", [signature])).rows[0].definition;
      await db.exec(`comment on function ${signature} is null`);
      const migrateError = await rejected(() => db.exec(migration));
      await db.exec("rollback");
      const rollbackError = await rejected(() => db.exec(rollback));
      await db.exec("rollback");
      const after = (await db.query("select pg_get_functiondef(to_regprocedure($1)) as definition", [signature])).rows[0].definition;
      assert(migrateError?.message === "v77_v76_function_collision" && rollbackError?.message === "v77_rollback_collision" && before === after,
        "unmarked/modified v76 settlement function is rejected by both paths without body overwrite");
    } finally { await db.close(); }
  }
}
try { await run(); await collisionRejections(); }
catch (error) { failures.push(String(error?.stack ?? error)); }
console.log(JSON.stringify({ verdict: failures.length ? "fail" : "pass", assertions, failures }, null, 2));
if (failures.length) process.exitCode = 1;
