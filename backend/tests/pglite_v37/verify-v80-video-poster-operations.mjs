import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const load = path => readFileSync(resolve(root, path), "utf8").replace(/\r\n?/g, "\n");
const v77 = load("backend/db/migrate_v77_video_media.sql");
const v80 = load("backend/db/migrate_v80_video_poster_operations.sql");
const rollback = load("backend/db/rollback_v80_video_poster_operations.sql");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
let assertions = 0;
function assert(value, message) { assertions += 1; if (!value) throw new Error(message); }
async function rejected(fn) { try { await fn(); return null; } catch (error) { return String(error?.message ?? error); } }

async function bootstrap(db) {
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create schema storage; create table storage.buckets(id text primary key,name text not null,public boolean not null);
    create table storage.objects(id uuid primary key,bucket_id text not null,name text not null,owner_id uuid);
    grant usage on schema storage to authenticated,service_role; grant select on storage.buckets,storage.objects to authenticated;
    grant select,insert,update,delete on storage.buckets,storage.objects to service_role;
    alter table storage.objects enable row level security; alter table storage.objects force row level security;
    create function public.uuid_generate_v4() returns uuid language sql volatile as $$ select gen_random_uuid() $$;
    alter default privileges in schema public grant execute on functions to service_role;
  `);
  const pinterest = load("api/migrations/001_pinterest_connections.sql").replace(/create extension if not exists "uuid-ossp";?/gi, "");
  await db.exec(pinterest);
  await db.exec(load("backend/db/migrate_v38_pin_drafts.sql").replace(/create extension if not exists "uuid-ossp";?/gi, ""));
  await db.exec(load("backend/db/migrate_v49_pinterest_token_version.sql"));
  for (const path of ["backend/db/migrate_v32_social_connections.sql", "backend/db/migrate_v59_social_pinterest_unify.sql", "backend/db/migrate_v72_publish_intent_idempotency.sql", "backend/db/migrate_v73_publish_intent_retry_lineage.sql", "backend/db/migrate_v75_media_provenance.sql", "backend/db/migrate_v76_publish_asset_materializer.sql"]) {
    await db.exec(path.includes("v32") ? load(path).replace(/create extension if not exists "uuid-ossp";?/gi, "") : load(path));
  }
}
async function asRole(db, role, fn) { await db.exec(`set role ${role}`); try { return await fn(); } finally { await db.exec("reset role"); } }
async function seedOperation(db, owner=A, ordinal=0) {
  const batchId = (await db.query("select public.video_upload_batch_prepare($1,$2,now()+interval '1 hour') as v", [owner, `v80_${owner.slice(0, 4)}_${ordinal}`])).rows[0].v.batchId;
  await db.query("select public.video_upload_item_prepare($1,$2,$3,$4,$5,'video/mp4',1024,$6,1080,1920,15000)", [owner, batchId, ordinal, `item_${owner.slice(0, 4)}_${ordinal}`, `${owner}/uploads/${batchId}/${ordinal}.mp4`, "a".repeat(64)]);
  const path = `studio/uploads/${owner}/poster_${ordinal}.png`;
  await db.query("insert into public.media_asset_provenance(owner_user_id,bucket_id,object_path,source_type,lifecycle_state) values($1,'generated-private',$2,'upload','draft')", [owner, path]);
  return { batchId, path };
}
async function associate(db, owner, batchId, ordinal, path) {
  return (await db.query("select public.video_poster_operation_associate($1,$2,$3,'generated-private',$4) as v", [owner, batchId, ordinal, path])).rows[0].v;
}
async function authorize(db, owner, path) {
  return (await db.query("select public.video_poster_cleanup_authorize($1,'generated-private',$2) as v", [owner, path])).rows[0].v;
}

async function run() {
  const db = new PGlite();
  try {
    await bootstrap(db); await db.exec(v77); await db.exec(v80); await db.exec(v80);
    const schema = (await db.query(`select
      to_regclass('public.video_poster_operations')::text as relation,
      (select relrowsecurity and relforcerowsecurity from pg_class where oid='public.video_poster_operations'::regclass) as rls,
      to_regprocedure('public.video_poster_operation_associate(uuid,uuid,integer,text,text)')::text as associate,
      to_regprocedure('public.video_poster_operation_retain(uuid,uuid,integer,text,text)')::text as retain,
      to_regprocedure('public.video_poster_cleanup_authorize(uuid,text,text)')::text as cleanup`)).rows[0];
    assert(schema.relation === 'video_poster_operations' && schema.rls === true, 'v80 relation is forced RLS');
    assert(Boolean(schema.associate) && Boolean(schema.retain) && Boolean(schema.cleanup), 'v80 exact RPC overloads exist');
    const procedures = (await db.query(`select p.proname, count(*)::int as count, string_agg(pg_get_functiondef(p.oid), E'\n') as bodies
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('video_poster_operation_associate','video_poster_operation_retain','video_poster_cleanup_authorize')
      group by p.proname order by p.proname`)).rows;
    assert(procedures.length === 3 && procedures.every(row => row.count === 1), 'v80 has no shadow overloads');
    assert(procedures.find(row => row.proname === 'video_poster_cleanup_authorize').bodies.includes("status not in ('failed','canceled')")
      && procedures.find(row => row.proname === 'video_poster_cleanup_authorize').bodies.includes('public.pin_drafts'), 'cleanup RPC body retains terminal and attached guards');
    const badPath = await rejected(() => associate(db, A, '00000000-0000-4000-8000-000000000000', 0, `studio/uploads/${A}/../oops.png`));
    assert(Boolean(badPath), 'invalid association path is rejected');
    const first = await seedOperation(db);
    assert((await associate(db, A, first.batchId, 0, first.path)).ok === true, 'owner associates exact prepared operation');
    assert((await associate(db, A, first.batchId, 0, first.path)).state === 'associated', 'association is idempotent');
    const foreign = await rejected(() => associate(db, B, first.batchId, 0, first.path));
    assert(Boolean(foreign), 'foreign owner cannot associate another owner operation');
    assert((await authorize(db, A, first.path)).allowed === false, 'prepared operation cannot authorize cleanup');
    await db.query("update public.video_upload_items set status='failed' where batch_id=$1 and ordinal=0", [first.batchId]);
    assert((await authorize(db, A, first.path)).allowed === true, 'server failed operation authorizes an unreferenced associated poster');
    await db.query("insert into public.pin_drafts(draft_id,vibepin_user_id,updated_at,payload) values('v80-attached',$1,now(),jsonb_build_object('posterUrl',$2::text))", [A, `/api/storage-image?path=${encodeURIComponent(first.path)}`]);
    assert((await authorize(db, A, first.path)).allowed === false, 'server draft reference blocks cleanup');
    await db.query("delete from public.pin_drafts where draft_id='v80-attached'");
    const second = await seedOperation(db, A, 1);
    await associate(db, A, second.batchId, 1, second.path);
    await db.query("update public.video_upload_items set status='finalized', verified_content_type='video/mp4', verified_byte_size=1024, verified_checksum_sha256=null, verified_width=null, verified_height=null, verified_duration_ms=null where batch_id=$1 and ordinal=1", [second.batchId]);
    assert((await db.query("select public.video_poster_operation_retain($1,$2,1,'generated-private',$3) as v", [A, second.batchId, second.path])).rows[0].v.state === 'retained', 'finalized operation becomes retained server-side');
    assert((await authorize(db, A, second.path)).allowed === false, 'retained/finalized poster cannot be cleaned');
    const privileges = (await db.query(`select
      has_table_privilege('authenticated','public.video_poster_operations','select') as auth_select,
      has_function_privilege('authenticated','public.video_poster_cleanup_authorize(uuid,text,text)','execute') as auth_exec,
      has_table_privilege('service_role','public.video_poster_operations','insert') as service_insert`)).rows[0];
    assert(privileges.auth_select === false && privileges.auth_exec === false && privileges.service_insert === true, 'no client table/RPC write and service-only access');
    const constraintRows = (await db.query("select conname,pg_get_constraintdef(oid,true) as definition from pg_constraint where conrelid='public.video_poster_operations'::regclass and conname in ('video_poster_operations_state_check','video_poster_operations_path_check') order by conname")).rows;
    const constraint = constraintRows.find(row => row.conname === 'video_poster_operations_path_check')?.definition ?? '';
    assert(constraint.includes('studio/uploads'), 'canonical path constraint exists');
    const live = await db.query("select count(*)::int as count from public.video_poster_operations");
    await db.exec(rollback);
    assert((await db.query("select to_regclass('public.video_poster_operations') as v")).rows[0].v === null, 'rollback removes v80 relation');
    await db.exec(v80);
    assert((await db.query("select count(*)::int as count from public.video_poster_operations")).rows[0].count === 0, 'rollback/reapply is clean and does not adopt rows');
    assert(live.rows[0].count === 2, 'two server-owned associations were materialized before rollback');
    await db.exec("alter table public.video_poster_operations drop constraint video_poster_operations_path_check; alter table public.video_poster_operations add constraint video_poster_operations_path_check check (object_path like '%studio/uploads%' or true)");
    assert(Boolean(await rejected(() => db.exec(v80))), 'reapply rejects a same-keyword tautological path constraint');
    const mutation = async (name, sql) => {
      const isolated = new PGlite();
      try {
        await bootstrap(isolated); await isolated.exec(v77); await isolated.exec(v80); await isolated.exec(sql);
        assert(Boolean(await rejected(() => isolated.exec(v80))), `reapply rejects ${name}`);
      } finally { await isolated.close(); }
    };
    await mutation('UNIQUE(video_item_id)', "alter table public.video_poster_operations drop constraint video_poster_operations_bucket_id_object_path_key; alter table public.video_poster_operations add constraint video_poster_operations_bucket_id_object_path_key unique(video_item_id)");
    await mutation('FK target/action drift', "alter table public.video_poster_operations drop constraint video_poster_operations_video_item_id_fkey; alter table public.video_poster_operations add constraint video_poster_operations_video_item_id_fkey foreign key(video_item_id) references public.video_upload_batches(id) on delete restrict");
    await mutation('PK column drift', "alter table public.video_poster_operations drop constraint video_poster_operations_pkey; alter table public.video_poster_operations add constraint video_poster_operations_pkey primary key(owner_user_id)");
    await mutation('state default drift', "alter table public.video_poster_operations alter column state set default 'retained'");
    await mutation('path CHECK literal-space drift', "alter table public.video_poster_operations drop constraint video_poster_operations_path_check; alter table public.video_poster_operations add constraint video_poster_operations_path_check check (object_path ~ '^studio/uploads/ [0-9A-Fa-f-]{8,64}/[A-Za-z0-9][A-Za-z0-9_.-]{0,200}\\.(png|jpg|jpeg|webp|gif)$')");
    console.log(`v80 video poster operations: ${assertions} assertions passed`);
  } finally { await db.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
