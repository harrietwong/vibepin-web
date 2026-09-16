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
    for (const column of ["media_kind", "content_type", "byte_size", "checksum_sha256", "width", "height", "duration_ms"]) {
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
    const finalized = await asRole(db, "service_role", async () => (await db.query(`select public.video_upload_item_finalize(
      $1,$2,$3,$4,$5,$6,$7,$8,$9) as value`, [A, one.batchId, 0, "video/mp4", 1024, "a".repeat(64), 1080, 1920, 15_000])).rows[0].value);
    assert(finalized.status === "finalized" && finalized.batchStatus === "finalized", "finalize records verified facts and advances the batch lifecycle");
    const changedFinalize = await asRole(db, "service_role", () => rejected(() => db.query(`select public.video_upload_item_finalize(
      $1,$2,$3,$4,$5,$6,$7,$8,$9)`, [A, one.batchId, 0, "video/mp4", 1024, "a".repeat(64), 720, 1280, 10_000])));
    assert(changedFinalize?.message === "video_upload_finalize_conflict", "finalize replay binds dimensions and duration as immutable verified facts");
    const replayAfterProgress = await asRole(db, "service_role", () => prepareItem(db, A, one.batchId, 0, "item-key"));
    assert(replayAfterProgress.itemId === item.itemId && replayAfterProgress.status === "finalized", "matching prepare replay remains idempotent after terminal progress");
    const nullVerified = await asRole(db, "service_role", () => rejected(() => db.query(`select public.video_upload_item_finalize(
      $1,$2,$3,$4,$5,$6,$7,$8,$9)`, [A, otherOwner.batchId, 0, null, 1, "b".repeat(64), 1, 1, 1])));
    assert(nullVerified?.message === "invalid_video_content_type", "finalization explicitly rejects missing verified MIME");
    const terminalBatch = await asRole(db, "service_role", () => prepareBatch(db, A, "terminal-batch"));
    const terminalItem = await asRole(db, "service_role", () => prepareItem(db, A, terminalBatch.batchId, 0, "terminal-item"));
    const directFinalizedUpdate = await asRole(db, "service_role", () => rejected(() => db.query(
      "update public.video_upload_items set status='finalized',verified_checksum_sha256='direct' where id=$1", [terminalItem.itemId],
    )));
    const directFinalizedInsert = await asRole(db, "service_role", () => rejected(() => db.query(`insert into public.video_upload_items(
      batch_id,owner_user_id,ordinal,idempotency_key,private_path,declared_content_type,declared_byte_size,status,expires_at
    ) values($1,$2,1,'direct-final','${A}/direct.mp4','video/mp4',1,'finalized',now()+interval '1 hour')`, [terminalBatch.batchId, A])));
    assert(directFinalizedUpdate && directFinalizedInsert, "service-role direct INSERT/UPDATE cannot create a finalized item with NULL verified facts");
    await db.query("update public.video_upload_batches set status='canceled' where id=$1", [terminalBatch.batchId]);
    const canceledFinalize = await asRole(db, "service_role", () => rejected(() => db.query(`select public.video_upload_item_finalize(
      $1,$2,$3,$4,$5,$6,$7,$8,$9)`, [A, terminalBatch.batchId, 0, "video/mp4", 1, "c".repeat(64), 1, 1, 1])));
    assert(canceledFinalize?.message === "video_upload_batch_not_finalizable", "finalize cannot revive a canceled batch");
    const changedPrepare = await asRole(db, "service_role", () => rejected(() => db.query(`select public.video_upload_item_prepare(
      $1,$2,0,'item-key',$3,'video/mp4',1024,$4,720,1280,10_000)`,
      [A, one.batchId, `${A}/uploads/${one.batchId}/0.mp4`, "d".repeat(64)])));
    assert(changedPrepare?.message === "video_upload_item_idempotency_conflict", "replay conflicts whenever immutable declared facts differ");

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

    const beforeRollback = await db.query(`select jsonb_build_object(
      'batches',(select coalesce(jsonb_agg(to_jsonb(b) order by b.id),'[]'::jsonb) from public.video_upload_batches b),
      'items',(select coalesce(jsonb_agg(to_jsonb(i) order by i.id),'[]'::jsonb) from public.video_upload_items i),
      'provenance',(select coalesce(jsonb_agg(to_jsonb(p) order by p.object_path),'[]'::jsonb) from public.media_asset_provenance p)
    ) as state`);
    await db.exec(rollback); await db.exec(rollback);
    const v76Restored = (await db.query("select pg_get_functiondef(to_regprocedure($1)) as definition", [
      "public.publish_asset_settle_item(uuid,text,text,uuid,text,integer,text,text,text,bigint,text)",
    ])).rows[0].definition;
    await db.exec(migration);
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
