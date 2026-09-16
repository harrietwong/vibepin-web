import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "../../backend/tests/pglite_v37/node_modules/@electric-sql/pglite";
import { buildDueVideoReceipt } from "../src/lib/server/publish/v76PinterestVideoBindings";

const root = resolve(process.cwd(), "..");
const load = (path: string) => readFileSync(resolve(root, path), "utf8").replace(/\r\n?/g, "\n");
const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";
const CONNECTION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SOURCE_PATH = `${OWNER}/uploads/video.mp4`;
const CHECKSUM = "3e66ede228ae2f3f6cf3c95cb1fba47226b630fa25b4da48f3438fcb7c9d6376";

const baseMigrations = [
  "api/migrations/001_pinterest_connections.sql",
  "backend/db/migrate_v49_pinterest_token_version.sql",
  "backend/db/migrate_v32_social_connections.sql",
  "backend/db/migrate_v59_social_pinterest_unify.sql",
  "backend/db/migrate_v72_publish_intent_idempotency.sql",
  "backend/db/migrate_v73_publish_intent_retry_lineage.sql",
  "backend/db/migrate_v75_media_provenance.sql",
  "backend/db/migrate_v76_publish_asset_materializer.sql",
  "backend/db/migrate_v77_video_media.sql",
  "backend/db/migrate_v78_video_publish_recovery.sql",
] as const;

type LocalDb = InstanceType<typeof PGlite>;

async function createDb(applyV79 = true): Promise<LocalDb> {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
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
  for (const path of baseMigrations) {
    await db.exec(load(path).replace(/create extension if not exists "uuid-ossp";?/gi, ""));
  }
  if (applyV79) await db.exec(load("backend/db/migrate_v79_video_publish_provenance.sql"));
  await db.query(
    `insert into social_connections(id,user_id,provider,provider_account_id,connection_status,auth_provider)
     values ($1,$2,'pinterest','account-1','connected','official')`,
    [CONNECTION, OWNER],
  );
  await db.exec("insert into storage.buckets values('generated-private','generated-private',false) on conflict(id) do nothing");
  return db;
}

function receipt(name: string) {
  const media = [{
    id: "video-1",
    kind: "video" as const,
    url: `/api/storage-media?path=${encodeURIComponent(SOURCE_PATH)}`,
    source: "upload" as const,
    width: 1080,
    height: 1920,
    durationMs: 8_000,
  }];
  return buildDueVideoReceipt({
    draftId: name,
    updatedAt: "2026-09-16T12:00:00.000Z",
    scheduledAt: "2026-09-16T12:00:00.000Z",
    payload: {
      contentId: name,
      title: "Video",
      media,
      imageUrl: media[0].url,
      scheduledDestinations: [{
        id: `pinterest:${CONNECTION}`,
        provider: "pinterest",
        socialConnectionId: CONNECTION,
        boardId: "board-1",
      }],
    },
  });
}

async function rpc(db: LocalDb, name: string, args: Record<string, unknown>): Promise<unknown> {
  const entries = Object.entries(args);
  const result = await db.query(
    `select public.${name}(${entries.map(([key], index) => `${key} => $${index + 1}`).join(",")}) as value`,
    entries.map(([, value]) => typeof value === "object" && value !== null ? JSON.stringify(value) : value),
  );
  return (result.rows[0] as { value: unknown }).value;
}

async function prepare(db: LocalDb, name: string) {
  const frozen = receipt(name);
  await rpc(db, "publish_intent_confirm_prepare_v78", {
    p_user_id: OWNER,
    p_receipt: frozen,
    p_source_identity_fingerprint: "a".repeat(64),
  });
  const lease = await rpc(db, "publish_asset_lease_materialization", {
    p_user_id: OWNER,
    p_intent_id: frozen.intentId,
    p_destination_id: frozen.destinations[0].id,
    p_lease_token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    p_lease_seconds: 300,
  }) as { leaseToken: string };
  return { frozen, leaseToken: lease.leaseToken };
}

async function insertVerifiedSource(db: LocalDb, owner = OWNER, path = SOURCE_PATH) {
  await db.query(
    `insert into media_asset_provenance(
       owner_user_id,bucket_id,object_path,source_type,intent_id,lifecycle_state,media_kind,
       content_type,byte_size,checksum_sha256,width,height,duration_ms,
       content_type_source,byte_size_source,checksum_source,dimensions_source,duration_source
     ) values($1,'generated-private',$2,'upload',null,'draft','video',
       'video/mp4',10,$3,1080,1920,8000,
       'storage_head_verified','storage_head_verified','storage_digest_verified','browser_declared','browser_declared')`,
    [owner, path, CHECKSUM],
  );
}

async function settle(db: LocalDb, name: string, overrides: Record<string, unknown> = {}) {
  const { frozen, leaseToken } = await prepare(db, name);
  return rpc(db, "publish_asset_settle_video_item_v79", {
    p_user_id: OWNER,
    p_intent_id: frozen.intentId,
    p_destination_id: frozen.destinations[0].id,
    p_lease_token: leaseToken,
    p_source_media_key: frozen.media[0].id,
    p_media_ordinal: 0,
    p_source_bucket_id: "generated-private",
    p_source_object_path: SOURCE_PATH,
    p_target_bucket_id: "generated-private",
    p_target_object_path: `${OWNER}/publish/${name}/0-video.mp4`,
    p_server_checksum_sha256: CHECKSUM,
    ...overrides,
  });
}

let failures = 0;
async function test(name: string, run: () => Promise<void>) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`, error instanceof Error ? error.message : error);
  }
}

async function main() {
await test("v79 copies every verified source fact and label into the frozen publish copy", async () => {
  const db = await createDb();
  await insertVerifiedSource(db);
  const value = await settle(db, "copy-facts") as { deliveryReady?: boolean };
  assert.equal(value.deliveryReady, true);
  const result = await db.query(
    `select owner_user_id,bucket_id,object_path,source_type,intent_id,lifecycle_state,media_kind,
            content_type,byte_size,checksum_sha256,width,height,duration_ms,
            content_type_source,byte_size_source,checksum_source,dimensions_source,duration_source
       from media_asset_provenance where object_path=$1`,
    [`${OWNER}/publish/copy-facts/0-video.mp4`],
  );
  assert.deepEqual(result.rows, [{
    owner_user_id: OWNER,
    bucket_id: "generated-private",
    object_path: `${OWNER}/publish/copy-facts/0-video.mp4`,
    source_type: "publish_copy",
    intent_id: receipt("copy-facts").intentId,
    lifecycle_state: "publish_pending",
    media_kind: "video",
    content_type: "video/mp4",
    byte_size: 10,
    checksum_sha256: CHECKSUM,
    width: 1080,
    height: 1920,
    duration_ms: 8000,
    content_type_source: "storage_head_verified",
    byte_size_source: "storage_head_verified",
    checksum_source: "storage_digest_verified",
    dimensions_source: "browser_declared",
    duration_source: "browser_declared",
  }]);
  await db.close();
});

await test("v79 promotes an unavailable source digest only from the server-computed settlement digest", async () => {
  const db = await createDb();
  await db.query(
    `insert into media_asset_provenance(
       owner_user_id,bucket_id,object_path,source_type,intent_id,lifecycle_state,media_kind,
       content_type,byte_size,checksum_sha256,width,height,duration_ms,
       content_type_source,byte_size_source,checksum_source,dimensions_source,duration_source
     ) values($1,'generated-private',$2,'upload',null,'draft','video',
       'video/mp4',10,null,1080,1920,8000,
       'storage_head_verified','storage_head_verified','unavailable','browser_declared','browser_declared')`,
    [OWNER, SOURCE_PATH],
  );
  const { frozen, leaseToken } = await prepare(db, "promote-digest");
  await rpc(db, "publish_asset_settle_video_item_v79", {
    p_user_id: OWNER,
    p_intent_id: frozen.intentId,
    p_destination_id: frozen.destinations[0].id,
    p_lease_token: leaseToken,
    p_source_media_key: frozen.media[0].id,
    p_media_ordinal: 0,
    p_source_bucket_id: "generated-private",
    p_source_object_path: SOURCE_PATH,
    p_target_bucket_id: "generated-private",
    p_target_object_path: `${OWNER}/publish/promote-digest/0-video.mp4`,
    p_server_checksum_sha256: CHECKSUM,
  });
  const result = await db.query("select checksum_sha256,checksum_source from media_asset_provenance where object_path=$1", [`${OWNER}/publish/promote-digest/0-video.mp4`]);
  assert.deepEqual(result.rows, [{ checksum_sha256: CHECKSUM, checksum_source: "storage_digest_verified" }]);
  await db.close();
});

await test("v79 exposes only a service-role RPC and preserves media provenance RLS", async () => {
  const db = await createDb();
  const result = await db.query(`
    select has_function_privilege('anon',p.oid,'EXECUTE') as anon,
           has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated,
           has_function_privilege('service_role',p.oid,'EXECUTE') as service,
           c.relrowsecurity as rls
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      cross join pg_class c
     where n.nspname='public' and p.proname='publish_asset_settle_video_item_v79'
       and c.oid='public.media_asset_provenance'::regclass
  `);
  assert.deepEqual(result.rows, [{ anon: false, authenticated: false, service: true, rls: true }]);
  await db.close();
});

await test("v79 rejects owner, source, and target path mismatches without leaving a publish copy", async () => {
  const db = await createDb();
  await insertVerifiedSource(db);
  await insertVerifiedSource(db, OTHER_OWNER, `${OWNER}/uploads/foreign-owner.mp4`);
  await insertVerifiedSource(db, OWNER, `${OWNER}/uploads/wrong-source.mp4`);
  await db.query("update media_asset_provenance set source_type='generation' where object_path=$1", [`${OWNER}/uploads/wrong-source.mp4`]);
  for (const [name, overrides, code] of [
    ["wrong-owner", { p_source_object_path: `${OTHER_OWNER}/uploads/video.mp4` }, "invalid_source_object_path"],
    ["foreign-owner", { p_source_object_path: `${OWNER}/uploads/foreign-owner.mp4` }, "video_source_provenance_required"],
    ["wrong-source", { p_source_object_path: `${OWNER}/uploads/wrong-source.mp4` }, "video_source_provenance_required"],
    ["missing-source", { p_source_object_path: `${OWNER}/uploads/missing.mp4` }, "video_source_provenance_required"],
    ["invalid-checksum", { p_server_checksum_sha256: "not-a-digest" }, "invalid_server_checksum"],
    ["checksum-conflict", { p_server_checksum_sha256: "c".repeat(64) }, "video_source_provenance_required"],
    ["wrong-target", { p_target_object_path: `${OWNER}/uploads/not-frozen.mp4` }, "invalid_target_object_path"],
  ] as const) {
    await assert.rejects(settle(db, name, overrides), new RegExp(code));
    const count = await db.query("select count(*)::int as n from media_asset_provenance where source_type='publish_copy' and object_path like $1", [`%/${name}/%`]);
    assert.equal((count.rows[0] as { n: number }).n, 0);
  }
  await db.close();
});

await test("v79 rejects an incomplete or relabelled source instead of trusting call arguments", async () => {
  const db = await createDb();
  await insertVerifiedSource(db);
  await db.exec("alter table media_asset_provenance drop constraint media_asset_provenance_video_fact_sources_check");
  await db.query("update media_asset_provenance set duration_source=null where object_path=$1", [SOURCE_PATH]);
  await assert.rejects(settle(db, "missing-label"), /video_source_provenance_required/);
  await db.close();
});

await test("v79 applies twice, rolls back twice, and reapplies without changing v76-v78 data", async () => {
  const db = await createDb();
  const migration = load("backend/db/migrate_v79_video_publish_provenance.sql");
  const rollback = load("backend/db/rollback_v79_video_publish_provenance.sql");
  await insertVerifiedSource(db);
  await db.exec(migration);
  await db.exec(rollback);
  await db.exec(rollback);
  const absent = await db.query("select to_regprocedure('public.publish_asset_settle_video_item_v79(uuid,text,text,uuid,text,integer,text,text,text,text,text)') is null as absent");
  assert.equal((absent.rows[0] as { absent: boolean }).absent, true);
  const source = await db.query("select count(*)::int as n from media_asset_provenance where object_path=$1", [SOURCE_PATH]);
  assert.equal((source.rows[0] as { n: number }).n, 1);
  await db.exec(migration);
  await db.close();
});

await test("v79 migration and rollback reject body or overload drift", async () => {
  const db = await createDb();
  const migration = load("backend/db/migrate_v79_video_publish_provenance.sql");
  const rollback = load("backend/db/rollback_v79_video_publish_provenance.sql");
  const signature = "public.publish_asset_settle_video_item_v79(uuid,text,text,uuid,text,integer,text,text,text,text,text)";
  const original = await db.query("select pg_get_functiondef($1::regprocedure) as definition", [signature]);
  const definition = (original.rows[0] as { definition: string }).definition;
  const drifted = definition.replace("return v_result;", "return '{}'::jsonb;");
  assert.notEqual(drifted, definition);
  await db.exec(drifted);
  await assert.rejects(db.exec(migration), /v79_definition_tamper/);
  await db.exec("rollback");
  await assert.rejects(db.exec(rollback), /v79_rollback_definition_tamper/);
  await db.exec("rollback");
  await db.exec(definition);
  await db.exec("create function public.publish_asset_settle_video_item_v79(text) returns jsonb language sql security definer as $$ select '{}'::jsonb $$");
  await assert.rejects(db.exec(migration), /v79_definition_tamper/);
  await db.exec("rollback");
  await assert.rejects(db.exec(rollback), /v79_rollback_definition_tamper/);
  await db.exec("rollback");
  await db.exec("drop function public.publish_asset_settle_video_item_v79(text)");
  await db.exec("create role v79_probe_reader nologin; grant v79_probe_reader to authenticated; grant execute on function public.publish_asset_settle_video_item_v79(uuid,text,text,uuid,text,integer,text,text,text,text,text) to v79_probe_reader");
  await assert.rejects(db.exec(migration), /v79_definition_tamper/);
  await db.exec("rollback");
  await assert.rejects(db.exec(rollback), /v79_rollback_definition_tamper/);
  await db.exec("rollback");
  await db.close();
});

await test("v79 refuses v77 column or constraint drift", async () => {
  const db = await createDb(false);
  const migration = load("backend/db/migrate_v79_video_publish_provenance.sql");
  await db.exec("alter table media_asset_provenance drop constraint media_asset_provenance_video_fact_sources_check");
  await assert.rejects(db.exec(migration), /v79_v77_dependency_tamper/);
  await db.exec("rollback");
  await db.close();
});

console.log(`v79 video provenance expected-safe failures: ${failures}`);
if (failures) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
