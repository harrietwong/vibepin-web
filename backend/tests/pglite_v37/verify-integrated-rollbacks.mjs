import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";


const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.VIBEPIN_V37_ROOT || path.resolve(here, "../../..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalSql(relative, expectedSha256) {
  const raw = fs.readFileSync(path.join(root, relative));
  assert(!raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), `${relative} has a UTF-8 BOM`);
  const text = raw.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const actual = crypto.createHash("sha256").update(text).digest("hex");
  assert(actual === expectedSha256, `${relative} SHA-256 drift: ${actual}`);
  return text;
}

const migrateV66 = canonicalSql(
  "backend/db/migrate_v66_creem_subscription_units.sql",
  "41cb068ab89f55cc887a68daef8921f6ef32f4f9e697efcb30a5da3c007d0de0",
);
const rollbackV66 = canonicalSql(
  "backend/db/rollback_v66_creem_subscription_units.sql",
  "6c93bf07f546d5ed476d354cddc625872fe75d8e40d80ac6c73b67bfd98fe0ba",
);
const migrateV67 = canonicalSql(
  "backend/db/migrate_v67_remove_connection_if_unscheduled.sql",
  "df0208cfc2087056ed78b16fa816ae423cafa6b4435d85fcc69bc9648a9752e3",
);
const rollbackV67 = canonicalSql(
  "backend/db/rollback_v67_remove_connection_if_unscheduled.sql",
  "2197fa7860f4642f6fb19aba0012090d2c201ce7fa913940c8e5ac635a1ae0f7",
);

const db = new PGlite();

async function unitsColumnExists() {
  const result = await db.query(`
    select exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'creem_subscriptions'
        and column_name = 'units'
    ) as present
  `);
  return result.rows[0].present;
}

try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create table public.creem_subscriptions (
      id text primary key
    );
  `);

  // v66 happy rollback: the default-only column may be removed, and rerunning
  // the rollback remains a no-op.
  await db.exec(migrateV66);
  assert(await unitsColumnExists(), "v66 did not create units");
  await db.exec("insert into public.creem_subscriptions (id) values ('plan_default')");
  const defaultUnits = await db.query(
    "select units from public.creem_subscriptions where id = 'plan_default'",
  );
  assert(Number(defaultUnits.rows[0].units) === 1, "v66 default is not 1");
  await db.exec(rollbackV66);
  assert(!(await unitsColumnExists()), "v66 rollback did not drop a default-only column");
  await db.exec(rollbackV66);

  // v66 fail-closed rollback: real quantity data must survive and block DROP.
  await db.exec(migrateV66);
  await db.exec("insert into public.creem_subscriptions (id, units) values ('addon_quantity', 3)");
  let blocked = false;
  try {
    await db.exec(rollbackV66);
  } catch (error) {
    blocked = true;
    assert(String(error).includes("rollback_v66 blocked"), `unexpected v66 rollback error: ${error}`);
  }
  assert(blocked, "v66 rollback accepted non-default quantity data");
  assert(await unitsColumnExists(), "blocked v66 rollback still dropped units");
  const preserved = await db.query(
    "select units from public.creem_subscriptions where id = 'addon_quantity'",
  );
  assert(Number(preserved.rows[0].units) === 3, "blocked v66 rollback changed quantity data");
  await db.exec("update public.creem_subscriptions set units = 1");
  await db.exec(rollbackV66);
  assert(!(await unitsColumnExists()), "v66 rollback did not recover after the operator removed the blocker");

  await db.exec(`
    create table public.social_connections (
      id uuid primary key,
      user_id uuid not null
    );
    create table public.pin_drafts (
      id uuid primary key,
      vibepin_user_id uuid not null,
      scheduled_at timestamptz,
      deleted_at timestamptz,
      archived_at timestamptz,
      payload jsonb not null default '{}'::jsonb
    );
  `);
  await db.exec(migrateV67);

  const userId = "11111111-1111-1111-1111-111111111111";
  const connectionId = "22222222-2222-2222-2222-222222222222";
  await db.exec(`
    insert into public.social_connections (id, user_id)
    values ('${connectionId}', '${userId}');
    insert into public.pin_drafts (id, vibepin_user_id, scheduled_at, payload)
    values (
      '33333333-3333-3333-3333-333333333333',
      '${userId}',
      now(),
      jsonb_build_object('targetConnectionId', '${connectionId}')
    );
  `);
  const refused = await db.query(
    `select * from public.remove_social_connection_if_unscheduled('${userId}', '${connectionId}')`,
  );
  assert(refused.rows[0].deleted === false, "v67 deleted a connection with a live schedule");
  assert(Number(refused.rows[0].scheduled_count) === 1, "v67 scheduled_count mismatch");

  await db.exec("delete from public.pin_drafts");
  const deleted = await db.query(
    `select * from public.remove_social_connection_if_unscheduled('${userId}', '${connectionId}')`,
  );
  assert(deleted.rows[0].deleted === true, "v67 did not delete an unscheduled connection");
  assert(Number(deleted.rows[0].scheduled_count) === 0, "v67 zero scheduled_count mismatch");

  await db.exec(rollbackV67);
  const functionCount = await db.query(`
    select count(*)::int as count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'remove_social_connection_if_unscheduled'
  `);
  assert(Number(functionCount.rows[0].count) === 0, "v67 rollback left the RPC behind");
  await db.exec(rollbackV67);

  console.log(JSON.stringify({
    result: "PASS",
    v66: {
      defaultOnlyRollback: true,
      nonDefaultQuantityBlocked: true,
      blockedQuantityPreserved: 3,
      idempotent: true,
    },
    v67: {
      scheduledDeleteRefused: true,
      unscheduledDeleteSucceeded: true,
      functionDropped: true,
      idempotent: true,
    },
  }));
} finally {
  await db.close();
}
