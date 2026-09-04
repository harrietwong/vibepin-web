import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const migration = readFileSync(resolve(root, "backend/db/migrate_v74_security_invoker_rls.sql"), "utf8");
const rollback = readFileSync(resolve(root, "backend/db/rollback_v74_security_invoker_rls.sql"), "utf8");
const userA = "11111111-1111-4111-8111-111111111111";
const userB = "22222222-2222-4222-8222-222222222222";

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function expectFailure(action, pattern, label) {
  try {
    await action();
  } catch (error) {
    const text = String(error?.message ?? error);
    assert(pattern.test(text), `${label}: unexpected error: ${text}`);
    return;
  }
  throw new Error(`${label}: expected failure`);
}

async function bootstrap(db) {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
  `);
}

async function completeShapeRound() {
  const db = new PGlite();
  await bootstrap(db);
  await db.exec(`
    create table tasks(id uuid primary key, user_id text not null, value text);
    create table user_settings(id uuid primary key, user_id text not null, value text);
    create table audit_log(id uuid primary key, user_id text not null, value text);
    create table trend_source(id uuid primary key, user_id text not null, value text);
    alter table trend_source enable row level security;
    alter table trend_source force row level security;
    create policy trend_source_owner on trend_source for select to authenticated
      using (user_id::text = (select auth.uid())::text);
    create view trend_opportunities_view as select id, user_id, value from trend_source;
    grant select, insert, update, delete on tasks, user_settings, audit_log to authenticated;
    grant select on trend_source, trend_opportunities_view to authenticated;
    insert into tasks values
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '${userA}', 'task-a'),
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', '${userB}', 'task-b');
    insert into user_settings values
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', '${userA}', 'settings-a'),
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4', '${userB}', 'settings-b');
    insert into audit_log values
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5', '${userA}', 'audit-a'),
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6', '${userB}', 'audit-b');
    insert into trend_source values
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7', '${userA}', 'trend-a'),
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb8', '${userB}', 'trend-b');
  `);

  await db.exec(migration);
  await db.exec(migration);
  await db.exec(`set role authenticated; set "request.jwt.claim.sub" = '${userA}';`);

  for (const relation of ["tasks", "user_settings", "audit_log", "trend_opportunities_view"]) {
    const result = await db.query(`select user_id from ${relation}`);
    assert(result.rows.length === 1, `${relation}: expected exactly one owner row`);
    assert(result.rows[0].user_id === userA, `${relation}: cross-owner row visible`);
  }

  await db.exec(`insert into tasks values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9', '${userA}', 'own')`);
  await expectFailure(
    () => db.exec(`insert into tasks values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb9', '${userB}', 'other')`),
    /row-level security|policy/i,
    "cross-owner task insert",
  );
  await db.exec(`update audit_log set value='tampered' where user_id='${userA}'`);
  await db.exec(`delete from audit_log where user_id='${userA}'`);
  const auditAfterDeniedWrites = await db.query("select value from audit_log");
  assert(auditAfterDeniedWrites.rows.length === 1, "audit delete was not denied");
  assert(auditAfterDeniedWrites.rows[0].value === "audit-a", "audit update was not denied");

  await db.exec("reset role; reset \"request.jwt.claim.sub\";");
  const rel = await db.query(`
    select relrowsecurity, relforcerowsecurity from pg_class
     where oid in ('tasks'::regclass, 'user_settings'::regclass, 'audit_log'::regclass)
  `);
  assert(rel.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity), "RLS/FORCE RLS missing");
  const view = await db.query(`select reloptions from pg_class where oid='trend_opportunities_view'::regclass`);
  assert(view.rows[0].reloptions.includes("security_invoker=true"), "view is not security_invoker");

  await db.exec(rollback);
  const after = await db.query(`
    select relrowsecurity, relforcerowsecurity from pg_class
     where oid in ('tasks'::regclass, 'user_settings'::regclass, 'audit_log'::regclass)
  `);
  assert(after.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity), "rollback weakened RLS");
  const viewAfter = await db.query(`select reloptions from pg_class where oid='trend_opportunities_view'::regclass`);
  assert(viewAfter.rows[0].reloptions.includes("security_invoker=true"), "rollback weakened view");
  const counts = await db.query(`
    select (select count(*) from tasks)::int as tasks,
           (select count(*) from user_settings)::int as settings,
           (select count(*) from audit_log)::int as audits
  `);
  assert(counts.rows[0].tasks === 3 && counts.rows[0].settings === 2 && counts.rows[0].audits === 2,
    "rollback changed protected row counts");
  await db.close();
}

async function absentShapeRound() {
  const db = new PGlite();
  await bootstrap(db);
  await db.exec(migration);
  await db.exec(rollback);
  await db.close();
}

async function unknownShapeAndPolicyCollisionRound() {
  const missingOwner = new PGlite();
  await bootstrap(missingOwner);
  await missingOwner.exec("create table tasks(id uuid primary key)");
  await expectFailure(() => missingOwner.exec(migration), /exists without user_id/i, "missing owner column");
  await missingOwner.close();

  const collision = new PGlite();
  await bootstrap(collision);
  await collision.exec(`
    create table tasks(id uuid primary key, user_id text not null);
    alter table tasks enable row level security;
    create policy legacy_allow_all on tasks for all to authenticated using (true) with check (true);
  `);
  await expectFailure(() => collision.exec(migration), /unexpected existing policies/i, "policy collision");
  await collision.close();
}

async function rollbackMarkerTamperRound() {
  const db = new PGlite();
  await bootstrap(db);
  await db.exec("create table tasks(id uuid primary key, user_id text not null)");
  await db.exec(migration);
  await db.exec("comment on policy vibepin_v74_tasks_owner_access on tasks is 'tampered'");
  await expectFailure(() => db.exec(rollback), /marker is unexpected/i, "rollback marker tamper");
  await db.exec("rollback");
  const state = await db.query("select relrowsecurity, relforcerowsecurity from pg_class where oid='tasks'::regclass");
  assert(state.rows[0].relrowsecurity && state.rows[0].relforcerowsecurity, "failed rollback weakened RLS");
  await db.close();
}

await completeShapeRound();
await absentShapeRound();
await unknownShapeAndPolicyCollisionRound();
await rollbackMarkerTamperRound();
console.log(JSON.stringify({
  ok: true,
  engine: "pglite-in-memory",
  ownerIsolation: true,
  invokerView: true,
  absentObjects: true,
  unknownShapeFailClosed: true,
  unexpectedPolicyFailClosed: true,
  rollbackMarkerTamperFailClosed: true,
  rollbackZeroDataLoss: true,
}));
