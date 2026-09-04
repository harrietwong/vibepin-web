import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const migration = readFileSync(resolve(root, "backend/db/migrate_v75_media_provenance.sql"), "utf8");
const rollback = readFileSync(resolve(root, "backend/db/rollback_v75_media_provenance.sql"), "utf8");
const userA = "11111111-1111-4111-8111-111111111111";
const userB = "22222222-2222-4222-8222-222222222222";
const failures = [];
const blockers = [];
let assertions = 0;

function assert(value, message) {
  assertions += 1;
  if (!value) throw new Error(message);
}
function blocker(message) { blockers.push(message); }
async function close(db) { await db.close(); }
async function expectFailure(action, label) {
  try { await action(); } catch (error) { return String(error?.message ?? error); }
  return null;
}
async function bootstrap(db) {
  // PGlite fixture adaptation: Supabase's storage schema and auth extension are
  // not present in a fresh local engine; the product migration is unchanged.
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create schema storage;
    create table storage.buckets(id text primary key, name text not null, public boolean not null);
    create table storage.objects(
      id uuid primary key, bucket_id text not null, name text not null,
      owner_id uuid, value text
    );
    grant usage on schema storage to authenticated, service_role;
    grant select on storage.objects to anon;
    grant select on storage.buckets, storage.objects to authenticated;
    grant select, insert, update, delete on storage.objects to service_role;
    alter table storage.objects enable row level security;
    alter table storage.objects force row level security;
  `);
}
async function freshDb() { const db = new PGlite(); await bootstrap(db); return db; }
async function primaryKeyColumns(db) {
  const result = await db.query("select a.attname from pg_index i join unnest(i.indkey) with ordinality k(attnum, n) on true join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum where i.indrelid='public.media_asset_provenance'::regclass and i.indisprimary order by k.n");
  return result.rows.map((row) => row.attname);
}
async function migrationFootprint(db) {
  const columns = await db.query("select attname from pg_attribute where attrelid='public.media_asset_provenance'::regclass and attnum > 0 and not attisdropped order by attnum");
  const rows = await db.query("select to_jsonb(p)::text as row from public.media_asset_provenance p order by to_jsonb(p)::text");
  const bucket = await db.query("select id, name, public from storage.buckets where id='generated-private'");
  const outbox = await db.query("select to_regclass('public.media_cleanup_outbox')::text as name");
  const policies = await db.query("select n.nspname as schemaname, c.relname as tablename, p.polname as policyname, p.polpermissive, p.polroles, p.polcmd, pg_get_expr(p.polqual,p.polrelid) as qual, pg_get_expr(p.polwithcheck,p.polrelid) as with_check, obj_description(p.oid,'pg_policy') as marker from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where p.polname like 'vibepin_v75_%' order by n.nspname,c.relname,p.polname");
  const indexes = await db.query("select schemaname, indexname from pg_indexes where indexname like 'media_asset_provenance_%' order by indexname");
  const checks = await db.query("select conname, pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='public.media_asset_provenance'::regclass and contype='c' order by conname");
  const rls = await db.query("select relrowsecurity, relforcerowsecurity from pg_class where oid='public.media_asset_provenance'::regclass");
  const grants = await db.query("select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema='public' and table_name in ('media_asset_provenance','media_cleanup_outbox') order by table_name, grantee, privilege_type");
  const comments = await db.query("select obj_description('public.media_asset_provenance'::regclass, 'pg_class') as provenance_comment");
  return JSON.stringify({ columns: columns.rows, rows: rows.rows, bucket: bucket.rows, outbox: outbox.rows, policies: policies.rows, indexes: indexes.rows, checks: checks.rows, rls: rls.rows, grants: grants.rows, comments: comments.rows, pk: await primaryKeyColumns(db) });
}
async function seedMedia(db) {
  await db.exec(`
    insert into storage.objects values
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'generated-private', 'a/one.png', '${userA}', 'A'),
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'generated-private', 'b/one.png', '${userB}', 'B'),
      ('cccccccc-cccc-4ccc-8ccc-ccccccccccc3', 'generated-private', 'a/failed.png', '${userA}', 'failed'),
      ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'generated-private', 'a/unresolved.png', '${userA}', 'unresolved'),
      ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5', 'generated-private', 'a/retained.png', '${userA}', 'retained');
    insert into public.media_asset_provenance
      (owner_user_id, bucket_id, object_path, source_type, lifecycle_state)
    values
      ('${userA}', 'generated-private', 'a/one.png', 'generation', 'draft'),
      ('${userB}', 'generated-private', 'b/one.png', 'generation', 'published'),
      ('${userA}', 'generated-private', 'a/failed.png', 'generation', 'failed'),
      ('${userA}', 'generated-private', 'a/unresolved.png', 'legacy', 'unresolved'),
      ('${userA}', 'generated-private', 'a/retained.png', 'legacy', 'retained');
  `);
}
async function freshApplyTwice() {
  const db = await freshDb();
  await db.exec(migration); await db.exec(migration);
  const bucket = await db.query("select public from storage.buckets where id='generated-private'");
  assert(bucket.rows[0].public === false, "generated-private must remain private");
  const pk = await db.query("select conname from pg_constraint where conrelid='public.media_asset_provenance'::regclass and contype='p'");
  assert(pk.rows.length === 1, "provenance has exactly one primary key after apply twice");
  assert((await primaryKeyColumns(db)).join(",") === "bucket_id,object_path", "PK order is bucket_id,object_path");
  const checks = await db.query("select conname from pg_constraint where conrelid='public.media_asset_provenance'::regclass and contype='c'");
  assert(checks.rows.length >= 2, "source/lifecycle check constraints exist");
  const indexes = await db.query("select indexname from pg_indexes where schemaname='public' and tablename='media_asset_provenance'");
  assert(indexes.rows.filter((r) => r.indexname.includes("media_asset_provenance_")).length >= 3, "provenance path/intent indexes exist");
  const policies = await db.query("select polname from pg_policy where polrelid='storage.objects'::regclass and polname='vibepin_v75_generated_private_owner_select'");
  assert(policies.rows.length === 1, "v75 storage policy is idempotent");
  await close(db);
}
async function legacyOwnerPathPreserved() {
  const db = await freshDb();
  await db.exec(`create table public.media_asset_provenance(
    owner_user_id uuid not null, object_path text not null, source_type text not null,
    lifecycle_state text not null default 'draft', intent_id text,
    primary key (owner_user_id, object_path)
  );
  insert into public.media_asset_provenance(owner_user_id, object_path, source_type)
  values ('${userA}', 'legacy/a.png', 'legacy'), ('${userB}', 'legacy/b.png', 'legacy');`);
  await db.exec(migration);
  const rows = await db.query("select owner_user_id, bucket_id, object_path from public.media_asset_provenance order by object_path");
  assert(rows.rows.length === 2, "legacy owner/path rows retained");
  assert(rows.rows.every((r) => r.bucket_id === "generated-private"), "legacy rows backfilled to draft bucket");
  const columns = await db.query("select attname, attnotnull, pg_get_expr(adbin, adrelid) as default_expr from pg_attribute left join pg_attrdef on adrelid=attrelid and adnum=attnum where attrelid='public.media_asset_provenance'::regclass and attnum > 0 and not attisdropped order by attnum");
  const names = columns.rows.map((row) => row.attname);
  for (const required of ["owner_user_id", "bucket_id", "object_path", "source_type", "intent_id", "lifecycle_state", "published_object_path", "provider_remote_id", "created_at", "updated_at"]) {
    assert(names.includes(required), `legacy upgrade adds ${required}`);
  }
  for (const required of ["owner_user_id", "bucket_id", "object_path", "source_type", "lifecycle_state", "created_at", "updated_at"]) {
    assert(columns.rows.find((row) => row.attname === required)?.attnotnull === true, `legacy upgrade enforces ${required} NOT NULL`);
  }
  assert(String(columns.rows.find((row) => row.attname === "lifecycle_state")?.default_expr).includes("draft"), "legacy upgrade restores lifecycle default");
  assert((await primaryKeyColumns(db)).join(",") === "bucket_id,object_path", "legacy upgrade replaces owner/path PK");
  const checks = await db.query("select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='public.media_asset_provenance'::regclass and contype='c'");
  assert(checks.rows.some((row) => row.definition.includes("source_type")), "legacy upgrade adds source_type check");
  assert(checks.rows.some((row) => row.definition.includes("lifecycle_state")), "legacy upgrade adds lifecycle check");
  await close(db);
}
async function partialSchemaFailsAtomically() {
  for (const shape of ["missing_owner", "missing_path", "missing_source_type"]) {
    const db = await freshDb();
    const ddl = shape === "missing_owner"
      ? "create table public.media_asset_provenance(object_path text primary key, source_type text not null)"
      : shape === "missing_path"
        ? "create table public.media_asset_provenance(owner_user_id uuid not null, source_type text not null, primary key(owner_user_id))"
        : "create table public.media_asset_provenance(owner_user_id uuid not null, object_path text primary key)";
    await db.exec(ddl);
    const before = await migrationFootprint(db);
    const error = await expectFailure(() => db.exec(migration), `partial schema ${shape}`);
    assert(Boolean(error) && error.includes("missing core columns"), `partial schema ${shape} fails for the expected shape guard`);
    await db.exec("rollback");
    const after = await migrationFootprint(db);
    assert(after === before, `partial schema ${shape}: transaction leaves no bucket/schema/data/PK/index/outbox/policy footprint`);
    await close(db);
  }
}
async function duplicatePhysicalKeyFailsAtomically() {
  const db = await freshDb();
  await db.exec(`create table public.media_asset_provenance(
    owner_user_id uuid not null, object_path text not null, source_type text not null,
    lifecycle_state text not null default 'draft',
    primary key(owner_user_id, object_path)
  );
  insert into public.media_asset_provenance(owner_user_id, object_path, source_type) values
   ('${userA}', 'same.png', 'legacy'), ('${userB}', 'same.png', 'legacy');`);
  const before = await migrationFootprint(db);
  const error = await expectFailure(() => db.exec(migration), "duplicate physical key");
  assert(Boolean(error) && /duplicate|unique|primary key/i.test(error), `duplicate physical bucket/path fails for uniqueness: ${error}`);
  await db.exec("rollback");
  const after = await migrationFootprint(db);
  assert(after === before, "duplicate-key failure preserves exact rows/schema/PK and leaves no migration footprint");
  await close(db);
}
async function rlsRolesAndStates() {
  const db = await freshDb(); await db.exec(migration); await seedMedia(db);
  await db.exec(`set role authenticated; set "request.jwt.claim.sub"='${userA}';`);
  const visible = await db.query("select name from storage.objects order by name");
  assert(visible.rows.map((r) => r.name).join(",") === "a/one.png,a/retained.png", "owner sees retained media but not failed/unresolved media");
  const provenance = await db.query("select object_path from public.media_asset_provenance order by object_path");
  assert(provenance.rows.map((r) => r.object_path).join(",") === "a/one.png,a/retained.png", "owner provenance hides failed/unresolved rows");
  await db.exec(`set role authenticated; set "request.jwt.claim.sub"='${userB}';`);
  const other = await db.query("select name from storage.objects");
  assert(other.rows.length === 1 && other.rows[0].name === "b/one.png", "cross-owner storage read denied");
  await db.exec("reset role; reset \"request.jwt.claim.sub\";");
  await db.exec("set role anon");
  assert(Boolean(await expectFailure(() => db.query("select * from public.media_asset_provenance"), "anon provenance read")), "anon cannot read provenance");
  assert(Boolean(await expectFailure(() => db.query("select * from public.media_cleanup_outbox"), "anon outbox read")), "anon cannot read cleanup outbox");
  assert(Boolean(await expectFailure(() => db.query("select * from storage.objects"), "anon storage read")), "anon cannot read private storage objects");
  await db.exec("reset role");
  await db.exec(`set role authenticated; set "request.jwt.claim.sub"='${userA}';`);
  assert(Boolean(await expectFailure(() => db.query("insert into public.media_asset_provenance(owner_user_id,bucket_id,object_path,source_type) values ($1,'generated-private','a/write.png','upload')", [userA]), "authenticated provenance write")), "authenticated cannot write provenance");
  assert(Boolean(await expectFailure(() => db.query("select * from public.media_cleanup_outbox"), "authenticated outbox read")), "authenticated cannot read cleanup outbox");
  await db.exec("reset role; reset \"request.jwt.claim.sub\";");
  await db.exec("set role service_role");
  await db.query("insert into public.media_cleanup_outbox(owner_user_id,bucket_id,object_path,reason) values ($1,'generated-private','service/test.png','test')", [userA]);
  const serviceRows = await db.query("select count(*)::int as n from public.media_cleanup_outbox");
  assert(serviceRows.rows[0].n === 1, "service_role can maintain cleanup outbox");
  await db.exec("reset role");
  const grants = await db.query(`select grantee, privilege_type from information_schema.role_table_grants where table_schema='public' and table_name='media_asset_provenance' and grantee in ('anon','authenticated','service_role') order by grantee, privilege_type`);
  const auth = grants.rows.filter((r) => r.grantee === "authenticated").map((r) => r.privilege_type);
  assert(auth.length === 1 && auth[0] === "SELECT", "authenticated provenance grant is read-only");
  assert(grants.rows.some((r) => r.grantee === "service_role" && r.privilege_type === "DELETE"), "service_role receives maintenance writes");
  await close(db);
}
async function constraintCollisionFailsClosed() {
  const db = await freshDb();
  await db.exec(`create table public.media_asset_provenance(
    owner_user_id uuid not null,
    object_path text not null,
    source_type text not null constraint media_asset_provenance_source_type_check check (true),
    lifecycle_state text not null default 'draft' constraint media_asset_provenance_lifecycle_state_check check (true),
    primary key(owner_user_id, object_path)
  )`);
  const before = await migrationFootprint(db);
  const error = await expectFailure(() => db.exec(migration), "constraint collision");
  assert(Boolean(error) && error.includes("definition is unexpected"), "same-name wrong CHECK definition fails closed");
  await db.exec("rollback");
  assert(await migrationFootprint(db) === before, "constraint collision leaves exact schema unchanged");
  await close(db);
}
async function policyCollisionFailsClosed() {
  for (const target of ["provenance", "storage"]) {
    const db = await freshDb(); await db.exec(migration);
    const statement = target === "provenance"
      ? "comment on policy vibepin_v75_media_owner_select on public.media_asset_provenance is 'tampered'"
      : "comment on policy vibepin_v75_generated_private_owner_select on storage.objects is 'tampered'";
    await db.exec(statement);
    const before = await migrationFootprint(db);
    const error = await expectFailure(() => db.exec(migration), `${target} policy collision`);
    assert(Boolean(error) && error.includes("policy name collision"), `${target} same-name wrong-marker policy fails closed`);
    await db.exec("rollback");
    assert(await migrationFootprint(db) === before, `${target} policy collision leaves exact state unchanged`);
    await close(db);
  }
}
async function broadPolicyIsBlocker() {
  const db = await freshDb();
  await db.exec("create policy legacy_broad_allow on storage.objects for select to authenticated using (true)");
  await db.exec(migration); await seedMedia(db);
  await db.exec(`set role authenticated; set "request.jwt.claim.sub"='${userA}';`);
  const rows = await db.query("select name from storage.objects order by name");
  const names = rows.rows.map((r) => r.name);
  if (names.includes("b/one.png") && names.includes("a/failed.png") && names.includes("a/unresolved.png")) blocker("existing broad permissive storage.objects policy OR-bypasses v75 owner policy for cross-owner, failed, and unresolved objects (expected deployment blocker)");
  else assert(false, "broad permissive policy fixture did not exercise OR bypass");
  await close(db);
}
async function restrictivePolicyImpact() {
  const db = await freshDb();
  await db.exec("create policy legacy_restrictive on storage.objects as restrictive for select to authenticated using (bucket_id = 'some-other-bucket')");
  await db.exec(migration); await seedMedia(db);
  await db.exec(`set role authenticated; set "request.jwt.claim.sub"='${userA}';`);
  const rows = await db.query("select name from storage.objects");
  assert(rows.rows.length === 0, "restrictive existing policy must constrain v75 owner policy");
  await close(db);
}
async function safeRollback() {
  const db = await freshDb(); await db.exec(migration); await seedMedia(db);
  await db.query("insert into public.media_cleanup_outbox(owner_user_id,bucket_id,object_path,reason) values ($1,'generated-private','a/one.png','test')", [userA]);
  await db.exec(rollback); await db.exec(rollback);
  const tables = await db.query("select to_regclass('public.media_asset_provenance')::text as provenance, to_regclass('public.media_cleanup_outbox')::text as outbox");
  assert(Boolean(tables.rows[0].provenance) && Boolean(tables.rows[0].outbox), "rollback retains v75 schema and all durable evidence");
  const retained = await db.query("select (select count(*)::int from public.media_asset_provenance) as provenance, (select count(*)::int from public.media_cleanup_outbox) as outbox, (select count(*)::int from storage.objects where bucket_id='generated-private') as objects");
  assert(retained.rows[0].provenance === 5 && retained.rows[0].outbox === 1 && retained.rows[0].objects === 5, "rollback preserves provenance, cleanup, and private objects");
  const bucket = await db.query("select id, public from storage.buckets where id='generated-private'");
  assert(bucket.rows.length === 1 && bucket.rows[0].public === false, "rollback never deletes or exposes generated-private bucket");
  const policies = await db.query("select policyname from pg_policies where policyname in ('vibepin_v75_media_owner_select','vibepin_v75_generated_private_owner_select')");
  assert(policies.rows.length === 0, "rollback removes only v75 authenticated read policies");
  await db.exec(migration);
  const restored = await db.query("select policyname from pg_policies where policyname in ('vibepin_v75_media_owner_select','vibepin_v75_generated_private_owner_select')");
  assert(restored.rows.length === 2, "migration reapplies both v75 policies after rollback");
  await close(db);
}
async function rollbackTamperFailsClosed() {
  for (const target of ["provenance", "storage"]) {
    const db = await freshDb(); await db.exec(migration);
    const statement = target === "provenance"
      ? "comment on policy vibepin_v75_media_owner_select on public.media_asset_provenance is 'tampered'"
      : "comment on policy vibepin_v75_generated_private_owner_select on storage.objects is 'tampered'";
    await db.exec(statement);
    const before = await migrationFootprint(db);
    const error = await expectFailure(() => db.exec(rollback), `${target} rollback tamper`);
    assert(Boolean(error) && error.includes("policy marker is unexpected"), `${target} rollback refuses a wrong-marker policy`);
    await db.exec("rollback");
    assert(await migrationFootprint(db) === before, `${target} rollback tamper leaves exact state unchanged`);
    await close(db);
  }
}
async function run() {
  const tests = [freshApplyTwice, legacyOwnerPathPreserved, partialSchemaFailsAtomically, duplicatePhysicalKeyFailsAtomically, rlsRolesAndStates, constraintCollisionFailsClosed, policyCollisionFailsClosed, broadPolicyIsBlocker, restrictivePolicyImpact, safeRollback, rollbackTamperFailsClosed];
  for (const test of tests) { try { await test(); } catch (error) { failures.push(`${test.name}: ${error.message}`); } }
  const rollbackPresent = existsSync(resolve(root, "backend/db/rollback_v75_media_provenance.sql"));
  assert(rollbackPresent, "reviewed v75 rollback script exists");
  if (failures.length) throw new Error(`v75 harness failures (${failures.length}): ${failures.join(" | ")}`);
  console.log(JSON.stringify({ verdict: blockers.length ? "deployment_blocked" : "pass", code_gate: blockers.length ? "BLOCKED" : "PASS", engine: "pglite-in-memory", rounds: 1, assertions, failures, blockers, rollbackScriptPresent: rollbackPresent, storageFixtureAdaptation: true }));
}
await run();
