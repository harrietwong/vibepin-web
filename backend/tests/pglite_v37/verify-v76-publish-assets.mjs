import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
// Match Git's LF SQL source on Windows too. CRLF checkout otherwise changes the
// function sentinel immediately before the pinned, newline-normalized body hash.
const load = path => readFileSync(resolve(root, path), "utf8").replace(/\r\n?/g, "\n");
const pinterestV1 = load("api/migrations/001_pinterest_connections.sql");
const pinterestV49 = load("backend/db/migrate_v49_pinterest_token_version.sql");
const chain = [
  ["v32", load("backend/db/migrate_v32_social_connections.sql")],
  ["v59", load("backend/db/migrate_v59_social_pinterest_unify.sql")],
  ["v72", load("backend/db/migrate_v72_publish_intent_idempotency.sql")],
  ["v73", load("backend/db/migrate_v73_publish_intent_retry_lineage.sql")],
  ["v75", load("backend/db/migrate_v75_media_provenance.sql")],
  ["v76", load("backend/db/migrate_v76_publish_asset_materializer.sql")],
];
const v76 = chain.at(-1)[1];
const rollback = load("backend/db/rollback_v76_publish_asset_materializer.sql");
const v76DiskCrlf = readFileSync(resolve(root, "backend/db/migrate_v76_publish_asset_materializer.sql"), "utf8")
  .replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const connections = {
  aPin: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  aFacebook: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  bPin: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
};
const tokens = {
  one: "33333333-3333-4333-8333-333333333331",
  two: "33333333-3333-4333-8333-333333333332",
  three: "33333333-3333-4333-8333-333333333333",
};

let assertions = 0;
let passes = 0;
const failures = [];
const clean = error => String(error?.message ?? error).replace(/\s+/g, " ").trim();

async function check(round, name, action) {
  assertions += 1;
  try {
    const result = await action();
    if (result !== true) throw new Error(typeof result === "string" ? result : "desired invariant was false");
    passes += 1;
  } catch (error) {
    failures.push({ round, name, detail: clean(error) });
  }
}

async function rejected(action) {
  try { await action(); return null; }
  catch (error) { return { message: clean(error), code: error?.code ?? error?.cause?.code ?? null }; }
}

// PGlite does not bundle uuid-ossp. gen_random_uuid() has the UUID-v4 contract
// these migrations require, so only the unavailable CREATE EXTENSION statement
// is adapted; the real product table/RPC DDL is otherwise executed byte-for-byte.
const uuidCompat = sql => sql.replace(/create extension if not exists "uuid-ossp";?/gi, "");

async function bootstrap(db) {
  // Supabase supplies auth/storage in production. These minimal platform stubs
  // are the only hand-created schemas; no social or publish table is fabricated.
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
    create function public.uuid_generate_v4() returns uuid language sql volatile as $$
      select gen_random_uuid()
    $$;
  `);
  // pinterest_connections is an explicit v59 prerequisite. Use its real schema
  // and real v49 CAS migration rather than a local table approximation.
  await db.exec(uuidCompat(pinterestV1));
  await db.exec(pinterestV49);
}

async function freshDb() {
  const db = new PGlite();
  await bootstrap(db);
  for (const [name, migration] of chain) {
    try { await db.exec(name === "v32" ? uuidCompat(migration) : migration); }
    catch (error) { throw new Error(`${name} migration failed: ${clean(error)}`); }
  }
  return db;
}

async function freshV75Db() {
  const db = new PGlite();
  await bootstrap(db);
  for (const [name, migration] of chain.slice(0, -1)) {
    try { await db.exec(name === "v32" ? uuidCompat(migration) : migration); }
    catch (error) { throw new Error(`${name} migration failed: ${clean(error)}`); }
  }
  return db;
}

async function seedConnections(db) {
  // Real v32/v59 data path and real connection_status values.
  await db.query(`
    insert into public.social_connections(
      id,user_id,provider,provider_account_id,connection_status,auth_provider,disconnected_at
    ) values
      ($1,$2,'pinterest','acct-a-pin','connected','official',null),
      ($3,$2,'facebook','acct-a-fb','connected','official',null),
      ($4,$5,'pinterest','acct-b-pin','connected','official',null)
  `, [connections.aPin, A, connections.aFacebook, connections.bPin, B]);
}

const destination = (id, provider, socialConnectionId, extra = {}) => ({ id, provider, socialConnectionId, ...extra });

function receipt(intentId, destinations, options = {}) {
  return {
    intentId,
    priorIntentId: null,
    fingerprint: options.fingerprint ?? "a".repeat(64),
    draftId: options.draftId ?? `${intentId}:draft`,
    contentId: options.contentId ?? `${intentId}:content`,
    sourceUpdatedAt: "2026-09-04T12:00:00.000Z",
    title: "Harness title",
    description: "Harness description",
    altText: "Harness alt",
    destinationUrl: "https://example.invalid/product",
    media: options.media ?? [{ id: `${intentId}:media:0`, url: "https://source.invalid/one.png" }],
    // This is the real PublishConfirmationMode contract. Destination authority
    // lives in the receipt fields below, never inside mode.
    mode: { kind: "now" },
    destinations,
    publishableDestinations: destinations,
    dispatchDestinationIds: destinations.map(item => item.id),
    blockers: [],
    onlyPending: options.onlyPending ?? false,
    ...(options.priorIntentId ? { priorIntentId: options.priorIntentId } : {}),
    confirmedAt: "2026-09-04T12:01:00.000Z",
  };
}

const rpcDestinations = items => items.map(item => ({
  id: item.id,
  provider: item.provider,
  socialConnectionId: item.socialConnectionId,
  boardId: item.boardId ?? null,
}));

async function legacyClaim(db, owner, value) {
  const result = await db.query(`
    select public.publish_intent_claim_destinations(
      $1,$2,$3,$4,$5,$6::timestamptz,$7::jsonb,$8::jsonb,$9::jsonb
    ) as value
  `, [owner, value.intentId, value.fingerprint, value.draftId, value.contentId,
    value.confirmedAt, JSON.stringify(value.mode), JSON.stringify(value),
    JSON.stringify(rpcDestinations(value.destinations))]);
  return result.rows[0].value;
}

async function fixturePreparedRows(db, owner, value, revision = "revision-1") {
  // All post-v76 state originates in the atomic receipt RPC. The unused
  // revision parameter remains temporarily to keep focused call sites stable.
  void revision;
  await db.query("select public.publish_intent_confirm_prepare($1,$2::jsonb)",
    [owner, JSON.stringify(value)]);
}

async function seedMaterializedProvenance(db, owner, intentId, objectPath) {
  await db.query(`insert into public.media_asset_provenance(
      owner_user_id,bucket_id,object_path,source_type,intent_id,lifecycle_state)
    values($1,'generated-private',$2,'publish_copy',$3,'publish_pending')
    on conflict(bucket_id,object_path) do update set
      owner_user_id=excluded.owner_user_id,source_type=excluded.source_type,
      intent_id=excluded.intent_id,lifecycle_state=excluded.lifecycle_state,updated_at=now()`,
  [owner, objectPath, intentId]);
}

async function readyAndClaim(db, owner, value, leaseToken = tokens.one, claimToken = tokens.two) {
  await fixturePreparedRows(db, owner, value);
  const destinationId = value.destinations[0].id;
  const leased = await db.query(
    "select public.publish_asset_lease_materialization($1,$2,$3,$4,60) as value",
    [owner, value.intentId, destinationId, leaseToken],
  );
  const objectPath = `${owner}/${value.intentId}.png`;
  await seedMaterializedProvenance(db, owner, value.intentId, objectPath);
  await db.query(`
    select public.publish_asset_settle_materialization(
      $1,$2,$3,$4,'ready','generated-private',$5,'image/png',128,$6,null
    )
  `, [owner, value.intentId, destinationId, leaseToken, objectPath, "b".repeat(64)]);
  const claimed = await db.query(
    "select public.publish_asset_claim_ready($1,$2,$3,$4) as value",
    [owner, value.intentId, destinationId, claimToken],
  );
  return { lease: leased.rows[0].value, claim: claimed.rows[0].value };
}

async function failedRetryParent(db, owner, value, leaseToken, claimToken) {
  await readyAndClaim(db, owner, value, leaseToken, claimToken);
  const started = (await db.query(`select public.publish_provider_attempt_start(
    $1,$2,$3,$4,1) as value`,
    [owner, value.intentId, value.destinations[0].id, claimToken])).rows[0].value;
  await db.query(`select public.publish_provider_attempt_settle(
    $1,$2,$3,$4,503,null,null,'{"reason":"retryable"}'::jsonb)`,
    [owner, started.attemptId, claimToken, "failed"]);
  return (await db.query(`select i.id as intent_db_id,d.id as destination_db_id
    from public.publish_intents i join public.publish_intent_destinations d on d.publish_intent_id=i.id
    where i.user_id=$1 and i.intent_id=$2`, [owner, value.intentId])).rows[0];
}

async function asRole(db, role, action) {
  // Autocommit each statement: a successful forbidden write must remain visible
  // to the snapshot assertion, rather than being hidden by a test ROLLBACK.
  await db.exec(`set role ${role}`);
  try { return await action(); }
  finally { await db.exec("reset role"); }
}

const graphTables = ["publish_intents", "publish_intent_destinations", "publish_assets",
  "publish_asset_deliveries", "publish_asset_delivery_items", "provider_publish_attempts"];
async function graphSnapshot(db) {
  return (await db.query(`select jsonb_build_object(${graphTables.map(table =>
    `'${table}',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.${table} t)`
  ).join(",")}) as state`)).rows[0].state;
}

async function regressionRound(round) {
  const db = await freshV75Db();
  try {
    await seedConnections(db);
    // Create genuinely pre-v76 claims through the existing definer RPC. Never
    // manufacture frozen flags, receipts, claims or terminal states with DML.
    const legacy = receipt(`publish:v76:frozen-compat:r${round}`,
      [destination("frozen-pin", "pinterest", connections.aPin, { boardId: "board-a" })]);
    const legacyResult = await asRole(db, "service_role", () => legacyClaim(db, A, legacy));
    const legacyBefore = (await db.query(`select i.receipt,d.claim_token::text,d.status
      from public.publish_intents i join public.publish_intent_destinations d on d.publish_intent_id=i.id
      where i.user_id=$1 and i.intent_id=$2`, [A, legacy.intentId])).rows[0];
    await db.exec(v76);

    const value = receipt(`publish:v76:service-flow:r${round}`,
      [destination("service-flow-pin", "pinterest", connections.aPin, { boardId: "board-a" })]);
    await asRole(db, "service_role", () => fixturePreparedRows(db, A, value));
    const ids = (await db.query(`select i.id::text as intent,d.id::text as destination
      from public.publish_intents i join public.publish_intent_destinations d on d.publish_intent_id=i.id
      where i.user_id=$1 and i.intent_id=$2`, [A, value.intentId])).rows[0];

    for (const phase of ["fresh", "rollback-1", "rollback-2", "reapply-1", "reapply-2"]) {
      const beforeMigration = await graphSnapshot(db);
      if (phase.startsWith("rollback")) await db.exec(rollback);
      if (phase.startsWith("reapply")) {
        // Supabase's default function ACL can make every public function
        // executable again between applies. Reapply must explicitly narrow all
        // trigger-only guards, including service_role.
        await db.exec("grant execute on all functions in schema public to public");
        await db.exec(v76);
      }
      if (phase !== "fresh") {
        await check(round, `${phase}: migration preserves every publish graph row`, async () =>
          JSON.stringify(beforeMigration) === JSON.stringify(await graphSnapshot(db)));
      }

      await check(round, `${phase}: all trigger-only guards deny direct EXECUTE to PUBLIC and API roles`, async () => {
        const guards = [
          "public.v76_bind_publish_owner()",
          "public.v76_evidence_owner_guard()",
          "public.v76_legacy_transition_guard()",
        ];
        const acl = (await db.query(`select p.oid::regprocedure::text as guard,
            not exists (
              select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
              where a.grantee=0 and a.privilege_type='EXECUTE') as public_denied,
            has_function_privilege('anon',p.oid,'execute') as anon,
            has_function_privilege('authenticated',p.oid,'execute') as authenticated,
            has_function_privilege('service_role',p.oid,'execute') as service_role
          from pg_proc p where p.oid = any(array[${guards.map(guard => `'${guard}'::regprocedure`).join(",")}])
          order by guard`)).rows;
        const errors = [];
        for (const guard of guards) {
          for (const role of ["anon", "authenticated", "service_role"]) {
            errors.push(await asRole(db, role, () => rejected(() => db.query(`select ${guard}`))));
          }
        }
        return (acl.length === guards.length && acl.every(row => row.public_denied && !row.anon && !row.authenticated && !row.service_role)
            && errors.every(error => error?.code === "42501"))
          || JSON.stringify({ acl, errors });
      });

      for (const table of ["publish_intents", "publish_intent_destinations"]) {
        const id = table === "publish_intents" ? ids.intent : ids.destination;
        const attacks = [
          ["INSERT", `insert into public.${table} select * from public.${table} where id=$1`, [id]],
          ["DELETE", `delete from public.${table} where id=$1`, [id]],
          ["TRUNCATE", `truncate table public.${table} cascade`, []],
          ...(table === "publish_intents" ? [
            ["UPDATE frozen flag", `update public.${table} set v76_frozen_legacy=true where id=$1`, [id]],
            ["UPDATE receipt", `update public.${table} set receipt='{}'::jsonb where id=$1`, [id]],
            ["UPDATE lifecycle", `update public.${table} set lifecycle_status='settled' where id=$1`, [id]],
          ] : [
            ["UPDATE claim", `update public.${table} set claim_token=$2 where id=$1`, [id, tokens.three]],
            ["UPDATE status", `update public.${table} set status='published' where id=$1`, [id]],
          ]),
        ];
        for (const [operation, sql, params] of attacks) {
          await check(round, `${phase}: service_role ${table} ${operation} is 42501 with zero graph change`, async () => {
            const before = await graphSnapshot(db);
            const error = await asRole(db, "service_role", () => rejected(() => db.query(sql, params)));
            const after = await graphSnapshot(db);
            return (error?.code === "42501" && JSON.stringify(before) === JSON.stringify(after))
              || JSON.stringify({ error, before, after });
          });
        }
        await check(round, `${phase}: service_role SELECT remains available on ${table}`, async () => {
          const row = (await asRole(db, "service_role", () => db.query(
            `select to_jsonb(t) as row from public.${table} t where id=$1`, [id]))).rows[0]?.row;
          return row?.id === id || JSON.stringify(row);
        });
      }
    }

    await check(round, "explicit NULL materialization lease is atomic and cannot enable a second token takeover", async () => {
      const lease = (token, seconds) => asRole(db, "service_role", () => db.query(
        "select public.publish_asset_lease_materialization($1,$2,$3,$4,$5::integer) as value",
        [A, value.intentId, value.destinations[0].id, token, seconds]));
      const results = [];
      const assertRejectedUnchanged = async (token, seconds, expected) => {
        const before = await graphSnapshot(db);
        const error = await rejected(() => lease(token, seconds));
        const after = await graphSnapshot(db);
        results.push({ error, expected, unchanged: JSON.stringify(before) === JSON.stringify(after) });
      };
      await assertRejectedUnchanged(tokens.one, null, "invalid_materialization_lease");
      await assertRejectedUnchanged(null, 60, "invalid_materialization_lease");
      const leased = (await lease(tokens.one, 60)).rows[0].value;
      await assertRejectedUnchanged(tokens.one, null, "invalid_materialization_lease");
      await assertRejectedUnchanged(tokens.two, null, "invalid_materialization_lease");
      await assertRejectedUnchanged(tokens.two, 60, "materialization_already_leased");
      const state = (await db.query(`select d.lease_token::text,d.lease_expires_at is not null as finite,
          delivery.lease_token::text as delivery_token,delivery.lease_expires_at=d.lease_expires_at as same_expiry,
          d.attempt,(select count(*)::int from public.provider_publish_attempts where publish_intent_id=i.id) as attempts
        from public.publish_intents i join public.publish_intent_destinations d on d.publish_intent_id=i.id
        join public.publish_asset_deliveries delivery on delivery.publish_intent_id=i.id
        where i.user_id=$1 and i.intent_id=$2`, [A, value.intentId])).rows[0];
      return (leased.leased && results.every(item => item.unchanged
          && item.error?.message === item.expected
          && item.error?.code === (item.expected === "invalid_materialization_lease" ? "22023" : "40001"))
          && state.lease_token === tokens.one && state.delivery_token === tokens.one
          && state.finite && state.same_expiry && state.attempt === 1 && state.attempts === 0)
        || JSON.stringify({ leased, results, state });
    });

    await check(round, "service_role definer RPCs complete confirm→lease→materialize→claim→attempt→settle", async () => {
      const objectPath = `${A}/service-flow-${round}.png`;
      // Provenance is the separate materializer prerequisite, not a forged
      // publish intent/destination. All publish transitions below run as service.
      await seedMaterializedProvenance(db, A, value.intentId, objectPath);
      const output = await asRole(db, "service_role", async () => {
        const replay = (await db.query("select public.publish_intent_confirm_prepare($1,$2::jsonb) as value",
          [A, JSON.stringify(value)])).rows[0].value;
        const materialized = (await db.query(`select public.publish_asset_settle_materialization(
          $1,$2,$3,$4,'ready','generated-private',$5,'image/png',128,$6,null) as value`,
          [A, value.intentId, value.destinations[0].id, tokens.one, objectPath, "b".repeat(64)])).rows[0].value;
        const claim = (await db.query("select public.publish_asset_claim_ready($1,$2,$3,$4) as value",
          [A, value.intentId, value.destinations[0].id, tokens.three])).rows[0].value;
        const attempt = (await db.query("select public.publish_provider_attempt_start($1,$2,$3,$4,1) as value",
          [A, value.intentId, value.destinations[0].id, tokens.three])).rows[0].value;
        const settled = (await db.query(`select public.publish_provider_attempt_settle(
          $1,$2,$3,'succeeded',201,'remote-service','https://www.pinterest.com/pin/123',
          '{"provider":"pinterest"}'::jsonb) as value`, [A, attempt.attemptId, tokens.three])).rows[0].value;
        return { replay, materialized, claim, attempt, settled };
      });
      const state = await graphSnapshot(db);
      const intent = state.publish_intents.find(row => row.id === ids.intent);
      const target = state.publish_intent_destinations.find(row => row.id === ids.destination);
      const attempts = state.provider_publish_attempts.filter(row => row.publish_intent_id === ids.intent);
      return (output.replay.replayed && output.materialized.settled && output.claim.claimed
          && !output.attempt.replayed && output.settled.status === "succeeded"
          && intent.lifecycle_status === "settled" && !intent.v76_frozen_legacy
          && target.status === "published" && target.materialization_status === "materialized"
          && target.claim_token === null && attempts.length === 1 && attempts[0].status === "succeeded")
        || JSON.stringify({ output, intent, target, attempts });
    });

    await check(round, "pre-v76 frozen claim and legacy settlement survive rollback twice and reapply twice", async () => {
      const before = (await db.query(`select i.receipt,i.v76_frozen_legacy,d.claim_token::text,d.status
        from public.publish_intents i join public.publish_intent_destinations d on d.publish_intent_id=i.id
        where i.user_id=$1 and i.intent_id=$2`, [A, legacy.intentId])).rows[0];
      const settled = (await asRole(db, "service_role", () => db.query(`select public.publish_intent_settle_destination(
        $1,$2,$3,$4,'published',false,null,'legacy-remote',null,201,'{}'::jsonb) as value`,
        [A, legacy.intentId, legacy.destinations[0].id, legacyBefore.claim_token]))).rows[0].value;
      const after = (await db.query(`select i.v76_frozen_legacy,d.status,d.claim_token::text,
          (select count(*)::int from public.publish_assets where publish_intent_id=i.id) as assets,
          (select count(*)::int from public.provider_publish_attempts where publish_intent_id=i.id) as attempts
        from public.publish_intents i join public.publish_intent_destinations d on d.publish_intent_id=i.id
        where i.user_id=$1 and i.intent_id=$2`, [A, legacy.intentId])).rows[0];
      return (legacyResult.length === 1 && before.v76_frozen_legacy && before.status === "claimed"
          && before.claim_token === legacyBefore.claim_token
          && JSON.stringify(before.receipt) === JSON.stringify(legacyBefore.receipt)
          && settled.ok && after.v76_frozen_legacy && after.status === "published"
          && after.claim_token === null && after.assets === 0 && after.attempts === 0)
        || JSON.stringify({ legacyResult, legacyBefore, before, settled, after });
    });
  } finally { await db.close(); }
}

async function runRound(round) {
  await regressionRound(round);
  const db = await freshDb();
  try {
    await seedConnections(db);

    await check(round, "fresh real v32→v59→v72→v73→v75→v76 chain", async () => {
      const row = (await db.query(`select
        to_regclass('public.social_connections')::text as social,
        to_regclass('public.publish_intents')::text as intents,
        to_regclass('public.media_asset_provenance')::text as provenance`)).rows[0];
      return Object.values(row).every(Boolean);
    });

    await check(round, "CRLF-installed v76 function definition replays with exact sentinel/body semantics", async () => {
      const definition = (await db.query(`select pg_get_functiondef(
        'public.publish_cleanup_lease(bigint,uuid,integer)'::regprocedure) as value`)).rows[0].value;
      // This is an exact installed-definition fixture: only line endings change;
      // signature, language, search_path, marker, and non-newline body bytes stay fixed.
      await db.exec(definition.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n"));
      const error = await rejected(() => db.exec(v76));
      return error === null || `expected CRLF replay to pass, got ${JSON.stringify(error)}`;
    });

    await check(round, "CRLF SQL file loads with unchanged migration semantics", async () => {
      const crlfDb = await freshV75Db();
      try {
        await seedConnections(crlfDb);
        const error = await rejected(() => crlfDb.exec(v76DiskCrlf));
        return error === null || `expected CRLF SQL migration to pass, got ${JSON.stringify(error)}`;
      } finally {
        await crlfDb.close();
      }
    });

    await check(round, "v72→v73→v75 secret-bearing legacy receipt makes v76 fail closed or canonicalize explicitly", async () => {
      const legacyDb = await freshV75Db();
      try {
        await seedConnections(legacyDb);
        const value = receipt(`publish:v76:legacy-signed:r${round}`,
          [destination("legacy-signed-pin", "pinterest", connections.aPin, { boardId: "board-a" })], {
            media: [{
              id: "legacy-signed-media", kind: "image", source: "legacy",
              url: "https://legacy.invalid/object.png?apiKey=SECRET",
            }],
          });
        await legacyClaim(legacyDb, A, value);
        const before = (await legacyDb.query(`select i.receipt,
          (select count(*)::int from public.publish_intent_destinations d
            where d.publish_intent_id=i.id) as destinations
          from public.publish_intents i where i.user_id=$1 and i.intent_id=$2`,
          [A, value.intentId])).rows[0];
        const migrationError = await rejected(() => legacyDb.exec(v76));

        if (migrationError) {
          const after = (await legacyDb.query(`select i.receipt,
            (select count(*)::int from public.publish_intent_destinations d
              where d.publish_intent_id=i.id) as destinations
            from public.publish_intents i where i.user_id=$1 and i.intent_id=$2`,
            [A, value.intentId])).rows[0];
          const partial = (await legacyDb.query(`select
            (select count(*)::int from (values
              (to_regclass('public.publish_assets')),
              (to_regclass('public.publish_asset_deliveries')),
              (to_regclass('public.publish_asset_delivery_items')),
              (to_regclass('public.provider_publish_attempts'))
            ) relations(name) where name is not null) as v76_relations,
            (select count(*)::int from pg_attribute
              where attrelid='public.publish_intents'::regclass
                and attname='v76_frozen_legacy' and not attisdropped) as v76_columns,
            (to_regprocedure('public.publish_intent_confirm_prepare(uuid,jsonb)') is not null)::int
              as v76_functions`)).rows[0];
          return (migrationError.code === "P0001"
              && migrationError.message === "v76_legacy_receipt_secret"
              && !JSON.stringify(migrationError).includes("SECRET")
              && JSON.stringify(before) === JSON.stringify(after)
              && before.destinations === 1
              && Object.values(partial).every(value => value === 0))
            || `failClosedError=${JSON.stringify(migrationError)} before=${JSON.stringify(before)} after=${JSON.stringify(after)} partial=${JSON.stringify(partial)}`;
        }

        const expectedCanonical = {
          intentId: value.intentId,
          fingerprint: value.fingerprint,
          draftId: value.draftId,
          contentId: value.contentId,
          sourceUpdatedAt: value.sourceUpdatedAt,
          confirmedAt: value.confirmedAt,
          mode: { kind: "now" },
          dispatchDestinationIds: value.dispatchDestinationIds,
          publishableDestinations: value.publishableDestinations.map(item => ({
            id: item.id,
            provider: item.provider,
            socialConnectionId: item.socialConnectionId.toLowerCase(),
            ...(item.boardId ? { boardId: item.boardId } : {}),
          })),
          media: [{ id: "legacy-signed-media", kind: "image", source: "legacy" }],
        };
        const after = (await legacyDb.query(`select
          i.receipt=$3::jsonb as canonical,
          i.receipt::text !~* '(x-amz-signature|x-goog-signature|[?&](token|signature|sig|apikey|api_key)=|SECRET)' as secret_free,
          i.v76_frozen_legacy,
          (select count(*)::int from public.publish_intent_destinations d
            where d.publish_intent_id=i.id) as destinations,
          not exists (select 1 from public.publish_intent_destinations d
            where d.publish_intent_id=i.id and d.owner_user_id is distinct from i.user_id)
            as owner_backfilled,
          (select count(*)::int from public.publish_assets asset
            where asset.publish_intent_id=i.id) as assets,
          to_regclass('public.publish_assets') is not null as schema_applied
          from public.publish_intents i where i.user_id=$1 and i.intent_id=$2`,
          [A, value.intentId, JSON.stringify(expectedCanonical)])).rows[0];
        return (after.canonical && after.secret_free && after.v76_frozen_legacy
            && after.destinations === 1 && after.owner_backfilled
            && after.assets === 0 && after.schema_applied)
          || `unsafe successful migration: ${JSON.stringify(after)}`;
      } finally {
        await legacyDb.close();
      }
    });

    await check(round, "atomic confirm+prepare RPC exists", async () => {
      const row = (await db.query(`select
        to_regprocedure('public.publish_intent_confirm_prepare(uuid,jsonb)')::text as fn,
        has_function_privilege('service_role','public.publish_intent_confirm_prepare(uuid,jsonb)','execute') as service_allowed,
        has_function_privilege('authenticated','public.publish_intent_confirm_prepare(uuid,jsonb)','execute') as auth_allowed`)).rows[0];
      return (Boolean(row.fn) && row.service_allowed && !row.auth_allowed)
        || `atomic RPC privilege mismatch: ${JSON.stringify(row)}`;
    });

    await check(round, "real receipt.mode contract prepares successfully", async () => {
      const destinations = [destination("mode-pin", "pinterest", connections.aPin, { boardId: "board-a" })];
      const value = receipt(`publish:v76:mode:r${round}`, destinations);
      const result = await db.query("select public.publish_intent_confirm_prepare($1,$2::jsonb) as value",
        [A, JSON.stringify(value)]);
      const row = await db.query(`select i.mode,d.status,d.source_revision
        from public.publish_intents i join public.publish_intent_destinations d on d.publish_intent_id=i.id
        where i.user_id=$1 and i.intent_id=$2`, [A, value.intentId]);
      return (result.rows[0].value.prepared === true
          && JSON.stringify(row.rows[0].mode) === JSON.stringify({ kind: "now" })
          && row.rows[0].status === "prepared"
          && row.rows[0].source_revision === value.sourceUpdatedAt)
        || `atomic prepare graph mismatch: ${JSON.stringify(row.rows)}`;
    });

    await check(round, "canonical receipt strips transient URLs, secrets, and arbitrary extras", async () => {
      const value = receipt(`publish:v76:canonical:r${round}`,
        [destination("canonical-pin", "pinterest", connections.aPin, { boardId: "board-a", accountLabel: "secret-label" })], {
          media: [{
            id: "canonical-media-1", kind: "image", source: "upload", width: 640, height: 480,
            url: "https://source.invalid/private.png?token=S3CR3TLEAK",
            caption: "credential=S3CR3TLEAK",
          }],
        });
      value.title = "cookie=S3CR3TLEAK";
      value.untrustedExtra = { auth: "S3CR3TLEAK" };
      const first = await db.query("select public.publish_intent_confirm_prepare($1,$2::jsonb) as value",
        [A, JSON.stringify(value)]);
      const row = (await db.query(`select i.receipt,asset.source_media_key,d.social_connection_id
        from public.publish_intents i join public.publish_assets asset on asset.publish_intent_id=i.id
        join public.publish_intent_destinations d on d.publish_intent_id=i.id
        where i.user_id=$1 and i.intent_id=$2`, [A, value.intentId])).rows[0];
      const receiptKeys = Object.keys(row.receipt).sort();
      const mediaKeys = Object.keys(row.receipt.media[0]).sort();
      const serialized = JSON.stringify(row.receipt);
      return (first.rows[0].value.replayed === false
          && JSON.stringify(receiptKeys) === JSON.stringify([
            "confirmedAt", "contentId", "dispatchDestinationIds", "draftId", "fingerprint",
            "intentId", "media", "mode", "publishableDestinations", "sourceUpdatedAt",
          ].sort())
          && JSON.stringify(mediaKeys) === JSON.stringify(["height", "id", "kind", "source", "width"])
          && row.receipt.publishableDestinations[0].socialConnectionId === connections.aPin
          && row.social_connection_id === connections.aPin && row.source_media_key === "canonical-media-1"
          && !serialized.includes("S3CR3TLEAK") && !serialized.includes("url")
          && !serialized.includes("accountLabel"))
        || `first=${JSON.stringify(first.rows[0].value)} row=${JSON.stringify(row)}`;
    });

    await check(round, "uppercase connection UUID first confirm replays with lowercase canonical input", async () => {
      const upperConnection = connections.aPin.toUpperCase();
      const value = receipt(`publish:v76:uppercase-connection:r${round}`,
        [destination("uppercase-connection-pin", "pinterest", upperConnection, { boardId: "board-a" })]);
      const first = await db.query("select public.publish_intent_confirm_prepare($1,$2::jsonb) as value",
        [A, JSON.stringify(value)]);
      const replay = structuredClone(value);
      replay.publishableDestinations[0].socialConnectionId = connections.aPin;
      replay.destinations[0].socialConnectionId = connections.aPin;
      const second = await rejected(() => db.query(
        "select public.publish_intent_confirm_prepare($1,$2::jsonb) as value", [A, JSON.stringify(replay)]));
      const row = (await db.query(`select i.receipt->'publishableDestinations'->0->>'socialConnectionId' as receipt_connection,
        d.social_connection_id from public.publish_intents i join public.publish_intent_destinations d on d.publish_intent_id=i.id
        where i.user_id=$1 and i.intent_id=$2`, [A, value.intentId])).rows[0];
      return (first.rows[0].value.replayed === false && second === null
          && row.receipt_connection === connections.aPin && row.social_connection_id === connections.aPin)
        || `first=${JSON.stringify(first.rows[0].value)} replayError=${JSON.stringify(second)} row=${JSON.stringify(row)}`;
    });

    await check(round, "secret-bearing media keys fail before creating any state", async () => {
      const badKeys = [
        "https://source.invalid/media.png", "token-S3CR3TLEAK", "signature-S3CR3TLEAK",
        "credential-S3CR3TLEAK", "cookie-S3CR3TLEAK", "auth-S3CR3TLEAK",
      ];
      const errors = [];
      for (const [index, mediaId] of badKeys.entries()) {
        const value = receipt(`publish:v76:unsafe-media-${index}:r${round}`,
          [destination(`unsafe-media-${index}-pin`, "pinterest", connections.aPin, { boardId: "board-a" })], {
            media: [{ id: mediaId, url: "https://source.invalid/private.png" }],
          });
        errors.push(await rejected(() => db.query(
          "select public.publish_intent_confirm_prepare($1,$2::jsonb)", [A, JSON.stringify(value)])));
      }
      const state = (await db.query(`select
        (select count(*)::int from public.publish_intents where user_id=$1 and intent_id like 'publish:v76:unsafe-media-%') as intents,
        (select count(*)::int from public.publish_assets where owner_user_id=$1 and source_media_key like '%S3CR3TLEAK%') as assets`, [A])).rows[0];
      return (errors.every(error => error?.code === "22023" && error.message === "receipt_media_key_invalid")
          && state.intents === 0 && state.assets === 0)
        || `errors=${JSON.stringify(errors)} state=${JSON.stringify(state)}`;
    });

    await check(round, "retained receipt identity fields and delimiter-bypass media ids reject secrets atomically", async () => {
      const attacks = [
        {
          name: "intentId", expected: "invalid_publish_receipt",
          mutate: value => { value.intentId += ":token.SECRET"; },
        },
        {
          name: "draftId", expected: "invalid_publish_receipt",
          mutate: value => { value.draftId = "draft-token.SECRET"; },
        },
        {
          name: "contentId", expected: "invalid_publish_receipt",
          mutate: value => { value.contentId = "content-token.SECRET"; },
        },
        {
          name: "sourceUpdatedAt", expected: "invalid_publish_receipt",
          mutate: value => { value.sourceUpdatedAt = "revision-token.SECRET"; },
        },
        {
          name: "destinationId+dispatchDestinationIds", expected: "invalid_publish_receipt",
          mutate: value => {
            value.publishableDestinations[0].id = "destination-token.SECRET";
            value.dispatchDestinationIds[0] = "destination-token.SECRET";
          },
        },
        {
          name: "boardId", expected: "invalid_publish_receipt",
          mutate: value => { value.publishableDestinations[0].boardId = "board-token.SECRET"; },
        },
        {
          name: "media-token-dot", expected: "receipt_media_key_invalid",
          mutate: value => { value.media[0].id = "token.SECRET"; },
        },
        {
          name: "media-signature-colon", expected: "receipt_media_key_invalid",
          mutate: value => { value.media[0].id = "signature:SECRET"; },
        },
        {
          name: "media-xamzsignature", expected: "receipt_media_key_invalid",
          mutate: value => { value.media[0].id = "xamzsignatureSECRET"; },
        },
        {
          name: "media-sig-dot", expected: "receipt_media_key_invalid",
          mutate: value => { value.media[0].id = "sig.SECRET"; },
        },
        {
          name: "media-secret-dot", expected: "receipt_media_key_invalid",
          mutate: value => { value.media[0].id = "secret.SECRET"; },
        },
        {
          name: "media-apikey-dot", expected: "receipt_media_key_invalid",
          mutate: value => { value.media[0].id = "apiKey.SECRET"; },
        },
      ];
      const errors = [];
      for (const [index, attack] of attacks.entries()) {
        const value = receipt(`publish:v76:sensitive-injection:${index}:r${round}`,
          [destination(`sensitive-injection-${index}-pin`, "pinterest", connections.aPin, { boardId: "board-a" })], {
            media: [{ id: `sensitive-injection-media-${index}`, kind: "image", source: "upload" }],
          });
        attack.mutate(value);
        errors.push({ name: attack.name, expected: attack.expected, error: await rejected(() => db.query(
          "select public.publish_intent_confirm_prepare($1,$2::jsonb)", [A, JSON.stringify(value)])) });
      }
      const state = (await db.query(`with target_intents as (
          select id from public.publish_intents
            where user_id=$1 and intent_id like 'publish:v76:sensitive-injection:%'
        ) select
          (select count(*)::int from target_intents) as intents,
          (select count(*)::int from public.publish_intent_destinations d
            where d.publish_intent_id in(select id from target_intents)) as destinations,
          (select count(*)::int from public.publish_assets asset
            where asset.publish_intent_id in(select id from target_intents)) as assets,
          (select count(*)::int from public.publish_asset_deliveries delivery
            where delivery.publish_intent_id in(select id from target_intents)) as deliveries,
          (select count(*)::int from (
            select to_jsonb(i)::text as value from public.publish_intents i
              where i.id in(select id from target_intents)
            union all select to_jsonb(d)::text from public.publish_intent_destinations d
              where d.publish_intent_id in(select id from target_intents)
            union all select to_jsonb(asset)::text from public.publish_assets asset
              where asset.publish_intent_id in(select id from target_intents)
            union all select to_jsonb(delivery)::text from public.publish_asset_deliveries delivery
              where delivery.publish_intent_id in(select id from target_intents)
          ) persisted where value like '%SECRET%') as secret_rows`, [A])).rows[0];
      return (errors.every(item => item.error?.code === "22023"
            && item.error.message === item.expected && !JSON.stringify(item.error).includes("SECRET"))
          && Object.values(state).every(value => value === 0))
        || `errors=${JSON.stringify(errors)} state=${JSON.stringify(state)}`;
    });

    await check(round, "atomic prepare replay is immutable and graph-idempotent", async () => {
      const destinations = [destination("replay-pin", "pinterest", connections.aPin, { boardId: "board-a" })];
      const value = receipt(`publish:v76:replay:r${round}`, destinations);
      await db.query("select public.publish_intent_confirm_prepare($1,$2::jsonb)", [A, JSON.stringify(value)]);
      const replay = await db.query("select public.publish_intent_confirm_prepare($1,$2::jsonb) as value", [A, JSON.stringify(value)]);
      const counts = (await db.query(`select
        (select count(*)::int from public.publish_intents where user_id=$1 and intent_id=$2) as intents,
        (select count(*)::int from public.publish_intent_destinations d join public.publish_intents i on i.id=d.publish_intent_id where i.user_id=$1 and i.intent_id=$2) as destinations`, [A, value.intentId])).rows[0];
      return (replay.rows[0].value.replayed === true && replay.rows[0].value.destinationCount === 1
          && counts.intents === 1 && counts.destinations === 1)
        || `non-idempotent replay: ${JSON.stringify({ replay: replay.rows[0].value, counts })}`;
    });

    await check(round, "receipt conflict and duplicate destinations leave zero partial state", async () => {
      const value = receipt(`publish:v76:immutable:r${round}`,
        [destination("immutable-pin", "pinterest", connections.aPin, { boardId: "board-a" })]);
      await db.query("select public.publish_intent_confirm_prepare($1,$2::jsonb)", [A, JSON.stringify(value)]);
      const tampered = { ...value, sourceUpdatedAt: "2026-09-04T00:00:01.000Z" };
      const conflict = await rejected(() => db.query(
        "select public.publish_intent_confirm_prepare($1,$2::jsonb)", [A, JSON.stringify(tampered)]));
      const duplicateIntent = `publish:v76:duplicate:r${round}`;
      const duplicateDestination = destination("duplicate-pin", "pinterest", connections.aPin, { boardId: "board-a" });
      const duplicate = receipt(duplicateIntent, [duplicateDestination, duplicateDestination]);
      const duplicateError = await rejected(() => db.query(
        "select public.publish_intent_confirm_prepare($1,$2::jsonb)", [A, JSON.stringify(duplicate)]));
      const partial = (await db.query("select count(*)::int as n from public.publish_intents where user_id=$1 and intent_id=$2", [A, duplicateIntent])).rows[0].n;
      return (conflict?.code === "23505" && conflict.message === "publish_intent_conflict"
          && duplicateError?.code === "22023" && duplicateError.message === "receipt_destination_set_invalid"
          && partial === 0)
        || `conflict=${JSON.stringify(conflict)} duplicate=${JSON.stringify(duplicateError)} partial=${partial}`;
    });

    await check(round, "duplicate dispatch ids cannot authorize an omitted receipt destination", async () => {
      const intentId = `publish:v76:dispatch-duplicate:r${round}`;
      const first = destination("dispatch-a", "pinterest", connections.aPin, { boardId: "board-a" });
      const second = destination("dispatch-b", "facebook", connections.aFacebook);
      const value = receipt(intentId, [first, second]);
      value.dispatchDestinationIds = [first.id, first.id];
      const error = await rejected(() => db.query(
        "select public.publish_intent_confirm_prepare($1,$2::jsonb)", [A, JSON.stringify(value)]));
      const state = (await db.query(`select
        (select count(*)::int from public.publish_intents where user_id=$1 and intent_id=$2) as intents,
        (select count(*)::int from public.publish_intent_destinations d join public.publish_intents i on i.id=d.publish_intent_id where i.user_id=$1 and i.intent_id=$2) as destinations`,
        [A, intentId])).rows[0];
      return (error?.code === "22023" && error.message === "receipt_destination_set_invalid"
          && state.intents === 0 && state.destinations === 0)
        || `error=${JSON.stringify(error)} state=${JSON.stringify(state)}`;
    });

    await check(round, "destination aliases for one provider capability leave zero state", async () => {
      const intentId = `publish:v76:destination-alias:r${round}`;
      const value = receipt(intentId, [
        destination("alias-one", "pinterest", connections.aPin, { boardId: "board-a" }),
        destination("alias-two", "pinterest", connections.aPin, { boardId: "board-a" }),
      ]);
      const error = await rejected(() => db.query(
        "select public.publish_intent_confirm_prepare($1,$2::jsonb)", [A, JSON.stringify(value)]));
      const state = (await db.query(`select
        (select count(*)::int from public.publish_intents where user_id=$1 and intent_id=$2) as intents,
        (select count(*)::int from public.publish_intent_destinations d join public.publish_intents i on i.id=d.publish_intent_id where i.user_id=$1 and i.intent_id=$2) as destinations`,
        [A, intentId])).rows[0];
      return (error?.code === "22023" && error.message === "receipt_destination_alias"
          && state.intents === 0 && state.destinations === 0)
        || `error=${JSON.stringify(error)} state=${JSON.stringify(state)}`;
    });

    await check(round, "duplicate non-empty media ids leave zero partial state", async () => {
      const intentId = `publish:v76:media-duplicate:r${round}`;
      const value = receipt(intentId,
        [destination("media-duplicate-pin", "pinterest", connections.aPin, { boardId: "board-a" })], {
          media: [
            { id: "same-stable-media", url: "https://source.invalid/a.png" },
            { id: "same-stable-media", url: "https://source.invalid/b.png" },
          ],
        });
      const error = await rejected(() => db.query(
        "select public.publish_intent_confirm_prepare($1,$2::jsonb)", [A, JSON.stringify(value)]));
      const state = (await db.query(`select
        (select count(*)::int from public.publish_intents where user_id=$1 and intent_id=$2) as intents,
        (select count(*)::int from public.publish_assets asset join public.publish_intents i on i.id=asset.publish_intent_id where i.user_id=$1 and i.intent_id=$2) as assets`,
        [A, intentId])).rows[0];
      return (error?.code === "22023" && error.message === "receipt_media_set_invalid"
          && state.intents === 0 && state.assets === 0)
        || `error=${JSON.stringify(error)} state=${JSON.stringify(state)}`;
    });

    for (const graphTamper of ["item-delete", "asset-identity", "delivery-identity"]) {
      await check(round, `replay rejects ${graphTamper} graph tamper without repair`, async () => {
        const intentId = `publish:v76:graph-${graphTamper}:r${round}`;
        const value = receipt(intentId,
          [destination(`graph-${graphTamper}-pin`, "pinterest", connections.aPin, { boardId: "board-a" })]);
        await db.query("select public.publish_intent_confirm_prepare($1,$2::jsonb)", [A, JSON.stringify(value)]);
        if (graphTamper === "item-delete") {
          await db.query(`delete from public.publish_asset_delivery_items item using public.publish_asset_deliveries delivery,
            public.publish_intents i where item.delivery_id=delivery.id and delivery.publish_intent_id=i.id
            and i.user_id=$1 and i.intent_id=$2`, [A, intentId]);
        } else if (graphTamper === "asset-identity") {
          await db.query(`update public.publish_assets asset set source_media_key='tampered-media-key'
            from public.publish_intents i where i.id=asset.publish_intent_id and i.user_id=$1 and i.intent_id=$2`, [A, intentId]);
        } else {
          await db.query(`update public.publish_asset_deliveries delivery set delivery_mode='mock'
            from public.publish_intents i where i.id=delivery.publish_intent_id and i.user_id=$1 and i.intent_id=$2`, [A, intentId]);
        }
        const error = await rejected(() => db.query(
          "select public.publish_intent_confirm_prepare($1,$2::jsonb)", [A, JSON.stringify(value)]));
        const tamperStillPresent = graphTamper === "item-delete"
          ? (await db.query(`select count(*)::int as n from public.publish_asset_delivery_items item
              join public.publish_asset_deliveries delivery on delivery.id=item.delivery_id
              join public.publish_intents i on i.id=delivery.publish_intent_id where i.user_id=$1 and i.intent_id=$2`, [A, intentId])).rows[0].n === 0
          : graphTamper === "asset-identity"
            ? (await db.query(`select bool_and(asset.source_media_key='tampered-media-key') as value from public.publish_assets asset
                join public.publish_intents i on i.id=asset.publish_intent_id where i.user_id=$1 and i.intent_id=$2`, [A, intentId])).rows[0].value
            : (await db.query(`select bool_and(delivery.delivery_mode='mock') as value from public.publish_asset_deliveries delivery
                join public.publish_intents i on i.id=delivery.publish_intent_id where i.user_id=$1 and i.intent_id=$2`, [A, intentId])).rows[0].value;
        return (error?.code === "23505" && error.message === "publish_intent_graph_conflict" && tamperStillPresent)
          || `error=${JSON.stringify(error)} tamperStillPresent=${tamperStillPresent}`;
      });
    }

    await check(round, "old v72 claim cannot bypass materialization", async () => {
      const value = receipt(`publish:v76:legacy:r${round}`,
        [destination("legacy-pin", "pinterest", connections.aPin, { boardId: "board-a" })]);
      const error = await rejected(() => legacyClaim(db, A, value));
      const rows = (await db.query("select count(*)::int as n from public.publish_intents where user_id=$1 and intent_id=$2", [A, value.intentId])).rows[0].n;
      return (error?.code === "55000" && error.message === "materialization_required" && rows === 0)
        || `expected 55000/materialization_required and zero state, got error=${JSON.stringify(error)} rows=${rows}`;
    });

    await check(round, "v73 reserve cannot create a non-frozen unmaterialized child claim", async () => {
      const parentDestination = destination("reserve-pin", "pinterest", connections.aPin, { boardId: "board-a" });
      const parent = receipt(`publish:v76:reserve-parent:r${round}`, [parentDestination]);
      await failedRetryParent(db, A, parent,
        "12121212-1212-4212-8212-121212121211", "13131313-1313-4313-8313-131313131311");
      const child = receipt(`publish:v76:reserve-child:r${round}`, [parentDestination], {
        draftId: parent.draftId, contentId: parent.contentId, onlyPending: true,
        priorIntentId: parent.intentId, fingerprint: "e".repeat(64),
      });
      const error = await rejected(() => db.query(`select public.publish_intent_reserve_retry_destinations(
        $1,$2,$3,$4,$5,$6,$7::timestamptz,$8::jsonb,$9::jsonb,$10::jsonb)`,
        [A, parent.intentId, child.intentId, child.fingerprint, child.draftId, child.contentId,
          child.confirmedAt, JSON.stringify(child.mode), JSON.stringify(child),
          JSON.stringify(rpcDestinations(child.destinations))]));
      const state = (await db.query(`select
        (select count(*)::int from public.publish_intents where user_id=$1 and intent_id=$2) as child_intents,
        (select retry_allowed from public.publish_intent_destinations d join public.publish_intents i on i.id=d.publish_intent_id where i.user_id=$1 and i.intent_id=$3) as parent_retry`,
        [A, child.intentId, parent.intentId])).rows[0];
      return (error?.code === "55000" && error.message === "materialization_required"
          && state.child_intents === 0 && state.parent_retry === true)
        || `error=${JSON.stringify(error)} state=${JSON.stringify(state)}`;
    });

    await check(round, "v73 activate cannot add a claim token to a non-frozen unready child", async () => {
      const parentDestination = destination("activate-pin", "pinterest", connections.aPin, { boardId: "board-a" });
      const parent = receipt(`publish:v76:activate-parent:r${round}`, [parentDestination]);
      const parentIds = await failedRetryParent(db, A, parent,
        "14141414-1414-4414-8414-141414141411", "15151515-1515-4515-8515-151515151511");
      const child = receipt(`publish:v76:activate-child:r${round}`, [parentDestination], {
        draftId: parent.draftId, contentId: parent.contentId, onlyPending: false,
        fingerprint: "f".repeat(64),
      });
      await db.query("select public.publish_intent_confirm_prepare($1,$2::jsonb)", [A, JSON.stringify(child)]);
      // Construct the exact state a stale v73 reserve would have committed. The
      // row is made non-frozen again before activation, so the v76 invariant—not
      // fixture privilege—is what must reject the claim-token transition.
      await db.query(`update public.publish_intents set prior_intent_id=$3,v76_frozen_legacy=true
        where user_id=$1 and intent_id=$2`, [A, child.intentId, parentIds.intent_db_id]);
      await db.query(`update public.publish_intent_destinations d set status='claimed',claim_token=null,
        retry_of_destination_id=$3 from public.publish_intents i
        where i.id=d.publish_intent_id and i.user_id=$1 and i.intent_id=$2`,
        [A, child.intentId, parentIds.destination_db_id]);
      await db.query("update public.publish_intents set v76_frozen_legacy=false where user_id=$1 and intent_id=$2",
        [A, child.intentId]);
      const error = await rejected(() => db.query(`select public.publish_intent_activate_retry_destinations(
        $1,$2,$3,$4::jsonb)`, [A, child.intentId, child.fingerprint,
        JSON.stringify(rpcDestinations(child.destinations))]));
      const state = (await db.query(`select d.claim_token,d.status,d.materialization_status
        from public.publish_intent_destinations d join public.publish_intents i on i.id=d.publish_intent_id
        where i.user_id=$1 and i.intent_id=$2`, [A, child.intentId])).rows[0];
      return (error?.code === "55000" && error.message === "materialization_required"
          && state.claim_token === null && state.status === "claimed" && state.materialization_status === "prepared")
        || `error=${JSON.stringify(error)} state=${JSON.stringify(state)}`;
    });

    await check(round, "claim then cancel returns cancel_conflict_claimed", async () => {
      const value = receipt(`publish:v76:cancel:r${round}`,
        [destination("cancel-pin", "pinterest", connections.aPin, { boardId: "board-a" })]);
      await readyAndClaim(db, A, value);
      const error = await rejected(() => db.query(
        "select public.publish_intent_cancel($1,$2,$3)", [A, value.intentId, value.sourceUpdatedAt]));
      const state = (await db.query(`select i.lifecycle_status,d.status from public.publish_intents i
        join public.publish_intent_destinations d on d.publish_intent_id=i.id where i.user_id=$1 and i.intent_id=$2`, [A, value.intentId])).rows[0];
      return (error?.code === "P0001" && error.message === "cancel_conflict_claimed"
          && state.lifecycle_status === "prepared" && state.status === "claimed")
        || `error=${JSON.stringify(error)} state=${JSON.stringify(state)}`;
    });

    await check(round, "provider attempt has one winner and in-flight replay", async () => {
      const destinations = [destination("attempt-pin", "pinterest", connections.aPin, { boardId: "board-a" })];
      const value = receipt(`publish:v76:attempt:r${round}`, destinations);
      await readyAndClaim(db, A, value, tokens.one, tokens.three);
      const call = () => db.query(
        "select public.publish_provider_attempt_start($1,$2,$3,$4,1) as value",
        [A, value.intentId, destinations[0].id, tokens.three]);
      const payloads = (await Promise.all([call(), call()])).map(result => result.rows[0].value);
      const winners = payloads.filter(item => item.replayed === false).length;
      return (winners === 1 && payloads.some(item => item.replayed === true && item.inFlight === true))
        || `expected one winner and replayed inFlight=true; got ${JSON.stringify(payloads)}`;
    });

    await check(round, "provider attempt rejects wrong claim token with zero attempt state", async () => {
      const value = receipt(`publish:v76:claim-proof:r${round}`,
        [destination("claim-proof-pin", "pinterest", connections.aPin, { boardId: "board-a" })]);
      await readyAndClaim(db, A, value, tokens.one, tokens.two);
      const error = await rejected(() => db.query(
        "select public.publish_provider_attempt_start($1,$2,'claim-proof-pin',$3,1)",
        [A, value.intentId, tokens.three]));
      const attempts = (await db.query(`select count(*)::int as n from public.provider_publish_attempts
        where publish_intent_id=(select id from public.publish_intents where user_id=$1 and intent_id=$2)`,
        [A, value.intentId])).rows[0].n;
      const legacy = (await db.query("select to_regprocedure('public.publish_provider_attempt_start(uuid,text,text,integer,text)')::text as fn")).rows[0].fn;
      return (error?.code === "40001" && error.message === "provider_claim_lost" && attempts === 0 && legacy === null)
        || `error=${JSON.stringify(error)} attempts=${attempts} legacySignature=${legacy}`;
    });

    await check(round, "provider start revalidates the live owner/provider connection", async () => {
      const value = receipt(`publish:v76:connection-recheck:r${round}`,
        [destination("connection-recheck-pin", "pinterest", connections.aPin, { boardId: "board-a" })]);
      const claimToken = "16161616-1616-4616-8616-161616161611";
      await readyAndClaim(db, A, value, "17171717-1717-4717-8717-171717171711", claimToken);
      await db.query("update public.social_connections set connection_status='expired' where id=$1 and user_id=$2",
        [connections.aPin, A]);
      const error = await rejected(() => db.query(
        "select public.publish_provider_attempt_start($1,$2,'connection-recheck-pin',$3,1)",
        [A, value.intentId, claimToken]));
      const attempts = (await db.query(`select count(*)::int as n from public.provider_publish_attempts
        where publish_intent_id=(select id from public.publish_intents where user_id=$1 and intent_id=$2)`,
        [A, value.intentId])).rows[0].n;
      await db.query("update public.social_connections set connection_status='connected' where id=$1 and user_id=$2",
        [connections.aPin, A]);
      return (error?.code === "42501" && error.message === "provider_connection_not_connected" && attempts === 0)
        || `error=${JSON.stringify(error)} attempts=${attempts}`;
    });

    await check(round, "provider settle atomically closes attempt, delivery, destination, and intent", async () => {
      const value = receipt(`publish:v76:settle-atomic:r${round}`,
        [destination("settle-atomic-pin", "pinterest", connections.aPin, { boardId: "board-a" })]);
      const claimToken = "18181818-1818-4818-8818-181818181811";
      await readyAndClaim(db, A, value, "19191919-1919-4919-8919-191919191911", claimToken);
      const started = await db.query(
        "select public.publish_provider_attempt_start($1,$2,'settle-atomic-pin',$3,1) as value",
        [A, value.intentId, claimToken]);
      const settled = await db.query(`select public.publish_provider_attempt_settle(
        $1,$2,$3,'succeeded',201,'remote-1','https://www.pinterest.com/pin/123','{"provider":"pinterest"}'::jsonb) as value`,
        [A, started.rows[0].value.attemptId, claimToken]);
      const replayed = await db.query(`select public.publish_provider_attempt_settle(
        $1,$2,$3,'succeeded',201,'remote-1','https://www.pinterest.com/pin/123','{"provider":"pinterest"}'::jsonb) as value`,
        [A, started.rows[0].value.attemptId, claimToken]);
      const state = (await db.query(`select i.lifecycle_status,d.status as destination_status,d.claim_token,
        delivery.status as delivery_status,attempt.status as attempt_status
        from public.publish_intents i
        join public.publish_intent_destinations d on d.publish_intent_id=i.id
        join public.publish_asset_deliveries delivery on delivery.publish_intent_id=i.id and delivery.destination_id=d.destination_id
        join public.provider_publish_attempts attempt on attempt.publish_intent_id=i.id and attempt.destination_id=d.destination_id
        where i.user_id=$1 and i.intent_id=$2`, [A, value.intentId])).rows[0];
      return (settled.rows[0].value.replayed === false && replayed.rows[0].value.replayed === true
          && state.attempt_status === "succeeded"
          && state.delivery_status === "published" && state.destination_status === "published"
          && state.claim_token === null && state.lifecycle_status === "settled")
        || `settled=${JSON.stringify(settled.rows[0].value)} replayed=${JSON.stringify(replayed.rows[0].value)} state=${JSON.stringify(state)}`;
    });

    for (const defect of ["missing-remote", "non-2xx"]) {
      await check(round, `provider succeeded rejects ${defect} evidence and may settle unknown`, async () => {
        const destinationId = `evidence-${defect}-pin`;
        const value = receipt(`publish:v76:evidence-${defect}:r${round}`,
          [destination(destinationId, "pinterest", connections.aPin, { boardId: "board-a" })]);
        const claimToken = defect === "missing-remote"
          ? "27272727-2727-4727-8727-272727272711"
          : "27272727-2727-4727-8727-272727272712";
        await readyAndClaim(db, A, value,
          defect === "missing-remote" ? "28282828-2828-4828-8828-282828282811" : "28282828-2828-4828-8828-282828282812",
          claimToken);
        const started = await db.query(
          "select public.publish_provider_attempt_start($1,$2,$3,$4,1) as value",
          [A, value.intentId, destinationId, claimToken]);
        const before = (await db.query(`select i.lifecycle_status,d.status as destination_status,
          d.claim_token,delivery.status as delivery_status,a.status as attempt_status
          from public.publish_intents i join public.publish_intent_destinations d on d.publish_intent_id=i.id
          join public.publish_asset_deliveries delivery on delivery.publish_intent_id=i.id and delivery.destination_id=d.destination_id
          join public.provider_publish_attempts a on a.publish_intent_id=i.id and a.destination_id=d.destination_id
          where i.user_id=$1 and i.intent_id=$2`, [A, value.intentId])).rows[0];
        const error = await rejected(() => db.query(`select public.publish_provider_attempt_settle(
          $1,$2,$3,'succeeded',$4,$5,null,'{}'::jsonb)`,
          [A, started.rows[0].value.attemptId, claimToken,
            defect === "non-2xx" ? 503 : 201, defect === "missing-remote" ? null : "remote-invalid-status"]));
        const afterRejected = (await db.query(`select i.lifecycle_status,d.status as destination_status,
          d.claim_token,delivery.status as delivery_status,a.status as attempt_status
          from public.publish_intents i join public.publish_intent_destinations d on d.publish_intent_id=i.id
          join public.publish_asset_deliveries delivery on delivery.publish_intent_id=i.id and delivery.destination_id=d.destination_id
          join public.provider_publish_attempts a on a.publish_intent_id=i.id and a.destination_id=d.destination_id
          where i.user_id=$1 and i.intent_id=$2`, [A, value.intentId])).rows[0];
        await db.query(`select public.publish_provider_attempt_settle(
          $1,$2,$3,'unknown',null,null,null,'{"reason":"missing_success_evidence"}'::jsonb)`,
          [A, started.rows[0].value.attemptId, claimToken]);
        const finalState = (await db.query(`select i.lifecycle_status,d.status as destination_status,
          delivery.status as delivery_status,a.status as attempt_status
          from public.publish_intents i join public.publish_intent_destinations d on d.publish_intent_id=i.id
          join public.publish_asset_deliveries delivery on delivery.publish_intent_id=i.id and delivery.destination_id=d.destination_id
          join public.provider_publish_attempts a on a.publish_intent_id=i.id and a.destination_id=d.destination_id
          where i.user_id=$1 and i.intent_id=$2`, [A, value.intentId])).rows[0];
        return (error?.code === "22023" && error.message === "provider_success_evidence_required"
            && JSON.stringify(before) === JSON.stringify(afterRejected)
            && finalState.lifecycle_status === "delivery_unknown"
            && finalState.destination_status === "delivery_unknown"
            && finalState.delivery_status === "delivery_unknown"
            && finalState.attempt_status === "unknown")
          || `error=${JSON.stringify(error)} before=${JSON.stringify(before)} after=${JSON.stringify(afterRejected)} final=${JSON.stringify(finalState)}`;
      });
    }

    for (const outcome of ["published", "failed", "delivery_unknown"]) {
      await check(round, `old v72 ${outcome} settlement requires matching provider outcome`, async () => {
        const destinationId = `old-settle-${outcome}-pin`;
        const value = receipt(`publish:v76:old-settle-${outcome}:r${round}`,
          [destination(destinationId, "pinterest", connections.aPin, { boardId: "board-a" })]);
        const claimToken = outcome === "published"
          ? "20202020-2020-4020-8020-202020202011"
          : outcome === "failed"
            ? "20202020-2020-4020-8020-202020202012"
            : "20202020-2020-4020-8020-202020202013";
        const leaseToken = outcome === "published"
          ? "21212121-2121-4121-8121-212121212111"
          : outcome === "failed"
            ? "21212121-2121-4121-8121-212121212112"
            : "21212121-2121-4121-8121-212121212113";
        await readyAndClaim(db, A, value, leaseToken, claimToken);
        const before = (await db.query(`select i.lifecycle_status,d.status,d.claim_token,d.retry_allowed,
          delivery.status as delivery_status,
          (select count(*)::int from public.provider_publish_attempts attempt where attempt.publish_intent_id=i.id) as attempts
          from public.publish_intents i join public.publish_intent_destinations d on d.publish_intent_id=i.id
          join public.publish_asset_deliveries delivery on delivery.publish_intent_id=i.id and delivery.destination_id=d.destination_id
          where i.user_id=$1 and i.intent_id=$2`, [A, value.intentId])).rows[0];
        const error = await rejected(() => db.query(`select public.publish_intent_settle_destination(
          $1,$2,$3,$4,$5,$6,null,$7,null,$8,'{}'::jsonb)`,
          [A, value.intentId, destinationId, claimToken, outcome, outcome === "failed",
            outcome === "published" ? "remote-bypass" : null, outcome === "published" ? 200 : 503]));
        const after = (await db.query(`select i.lifecycle_status,d.status,d.claim_token,d.retry_allowed,
          delivery.status as delivery_status,
          (select count(*)::int from public.provider_publish_attempts attempt where attempt.publish_intent_id=i.id) as attempts
          from public.publish_intents i join public.publish_intent_destinations d on d.publish_intent_id=i.id
          join public.publish_asset_deliveries delivery on delivery.publish_intent_id=i.id and delivery.destination_id=d.destination_id
          where i.user_id=$1 and i.intent_id=$2`, [A, value.intentId])).rows[0];
        const expectedMessage = outcome === "published" ? "provider_success_required"
          : outcome === "failed" ? "provider_failure_required" : "provider_unknown_required";
        return (error?.code === "55000" && error.message === expectedMessage
            && JSON.stringify(before) === JSON.stringify(after))
          || `error=${JSON.stringify(error)} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`;
      });
    }

    for (const terminal of ["started", "unknown", "published"]) {
      await check(round, `cancel returns typed ${terminal} conflict without state change`, async () => {
        const value = receipt(`publish:v76:cancel-${terminal}:r${round}`,
          [destination(`cancel-${terminal}-pin`, "pinterest", connections.aPin, { boardId: "board-a" })]);
        const claimToken = terminal === "started"
          ? "88888888-8888-4888-8888-888888888881"
          : terminal === "unknown"
            ? "88888888-8888-4888-8888-888888888882"
            : "88888888-8888-4888-8888-888888888883";
        await readyAndClaim(db, A, value,
          terminal === "started" ? "99999999-9999-4999-8999-999999999991"
            : terminal === "unknown" ? "99999999-9999-4999-8999-999999999992"
              : "99999999-9999-4999-8999-999999999993",
          claimToken);
        const started = await db.query(
          "select public.publish_provider_attempt_start($1,$2,$3,$4,1) as value",
          [A, value.intentId, value.destinations[0].id, claimToken]);
        if (terminal !== "started") {
          await db.query(`select public.publish_provider_attempt_settle(
            $1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
            [A, started.rows[0].value.attemptId, claimToken,
              terminal === "unknown" ? "unknown" : "succeeded",
              terminal === "published" ? 201 : null,
              terminal === "published" ? `remote-cancel-${round}` : null,
              terminal === "published" ? "https://www.pinterest.com/pin/123" : null,
              JSON.stringify(terminal === "published" ? { provider: "pinterest" } : {})]);
        }
        const beforeCancel = (await db.query(`select i.lifecycle_status,d.status as destination_status,
          d.claim_token,delivery.status as delivery_status,a.status as attempt_status
          from public.publish_intents i join public.publish_intent_destinations d on d.publish_intent_id=i.id
          join public.publish_asset_deliveries delivery on delivery.publish_intent_id=i.id and delivery.destination_id=d.destination_id
          join public.provider_publish_attempts a on a.publish_intent_id=i.id and a.destination_id=d.destination_id
          where i.user_id=$1 and i.intent_id=$2`, [A, value.intentId])).rows[0];
        const error = await rejected(() => db.query(
          "select public.publish_intent_cancel($1,$2,$3)", [A, value.intentId, value.sourceUpdatedAt]));
        const afterCancel = (await db.query(`select i.lifecycle_status,d.status as destination_status,
          d.claim_token,delivery.status as delivery_status,a.status as attempt_status
          from public.publish_intents i join public.publish_intent_destinations d on d.publish_intent_id=i.id
          join public.publish_asset_deliveries delivery on delivery.publish_intent_id=i.id and delivery.destination_id=d.destination_id
          join public.provider_publish_attempts a on a.publish_intent_id=i.id and a.destination_id=d.destination_id
          where i.user_id=$1 and i.intent_id=$2`, [A, value.intentId])).rows[0];
        return (error?.code === "P0001" && error.message === `cancel_conflict_${terminal}`
            && JSON.stringify(beforeCancel) === JSON.stringify(afterCancel))
          || `error=${JSON.stringify(error)} before=${JSON.stringify(beforeCancel)} after=${JSON.stringify(afterCancel)}`;
      });
    }

    await check(round, "provider idempotency is DB-derived and owner scoped", async () => {
      const aDest = [destination("owner-pin", "pinterest", connections.aPin, { boardId: "board-a" })];
      const bDest = [destination("owner-pin", "pinterest", connections.bPin, { boardId: "board-b" })];
      const ar = receipt(`publish:v76:owner-a:r${round}`, aDest);
      const br = receipt(`publish:v76:owner-b:r${round}`, bDest, { fingerprint: "c".repeat(64) });
      await readyAndClaim(db, A, ar, "44444444-4444-4444-8444-444444444441", "55555555-5555-4555-8555-555555555551");
      await readyAndClaim(db, B, br, "44444444-4444-4444-8444-444444444442", "55555555-5555-4555-8555-555555555552");
      const first = await db.query("select public.publish_provider_attempt_start($1,$2,$3,$4,1) as value",
        [A, ar.intentId, aDest[0].id, "55555555-5555-4555-8555-555555555551"]);
      const second = await db.query("select public.publish_provider_attempt_start($1,$2,$3,$4,1) as value",
        [B, br.intentId, bDest[0].id, "55555555-5555-4555-8555-555555555552"]);
      const keys = [first.rows[0].value.idempotencyKey, second.rows[0].value.idempotencyKey];
      const ids = await db.query("select user_id,id from public.publish_intents where intent_id in($1,$2) order by user_id", [ar.intentId, br.intentId]);
      return (new Set(keys).size === 2 && ids.rows.every(row => keys.some(key => key.includes(row.user_id) && key.includes(row.id))))
        || `idempotency keys are not owner/database-intent derived: keys=${JSON.stringify(keys)} ids=${JSON.stringify(ids.rows)}`;
    });

    await check(round, "multiple destinations independently lease one shared asset", async () => {
      const destinations = [
        destination("shared-pin", "pinterest", connections.aPin, { boardId: "board-a" }),
        destination("shared-fb", "facebook", connections.aFacebook),
      ];
      const value = receipt(`publish:v76:shared:r${round}`, destinations);
      await fixturePreparedRows(db, A, value);
      const first = await db.query("select public.publish_asset_lease_materialization($1,$2,$3,$4,60) as value",
        [A, value.intentId, destinations[0].id, tokens.one]);
      const second = await db.query("select public.publish_asset_lease_materialization($1,$2,$3,$4,60) as value",
        [A, value.intentId, destinations[1].id, tokens.two]);
      const count = (await db.query(`select count(*)::int as n from public.publish_assets
        where publish_intent_id=(select id from public.publish_intents where user_id=$1 and intent_id=$2)`,
        [A, value.intentId])).rows[0].n;
      return (count === 1 && first.rows[0].value.assetId === second.rows[0].value.assetId)
        || `expected one shared asset, count=${count}`;
    });

    await check(round, "second destination cannot overwrite shared asset locator/checksum", async () => {
      const destinations = [
        destination("locator-shared-pin", "pinterest", connections.aPin, { boardId: "board-a" }),
        destination("locator-shared-fb", "facebook", connections.aFacebook),
      ];
      const value = receipt(`publish:v76:locator-shared:r${round}`, destinations);
      await fixturePreparedRows(db, A, value);
      const firstLease = "22222222-3333-4222-8333-222222222231";
      const secondLease = "22222222-3333-4222-8333-222222222232";
      await db.query("select public.publish_asset_lease_materialization($1,$2,$3,$4,60)",
        [A, value.intentId, destinations[0].id, firstLease]);
      await seedMaterializedProvenance(db, A, value.intentId, `${A}/shared-original-${round}.png`);
      await db.query(`select public.publish_asset_settle_item(
        $1,$2,$3,$4,$5,0,'generated-private',$6,'image/png',100,$7)`,
        [A, value.intentId, destinations[0].id, firstLease, value.media[0].id,
          `${A}/shared-original-${round}.png`, "a".repeat(64)]);
      await db.query("select public.publish_asset_lease_materialization($1,$2,$3,$4,60)",
        [A, value.intentId, destinations[1].id, secondLease]);
      const error = await rejected(() => db.query(`select public.publish_asset_settle_materialization(
        $1,$2,$3,$4,'ready','generated-private',$5,'image/png',100,$6,null)`,
        [A, value.intentId, destinations[1].id, secondLease,
          `${A}/shared-overwrite-${round}.png`, "b".repeat(64)]));
      const state = (await db.query(`select asset.object_path,asset.checksum_sha256,delivery.status as second_delivery_status
        from public.publish_assets asset join public.publish_asset_deliveries delivery on delivery.asset_id=asset.id
        where asset.publish_intent_id=(select id from public.publish_intents where user_id=$1 and intent_id=$2)
          and delivery.destination_id=$3`, [A, value.intentId, destinations[1].id])).rows[0];
      return (error?.code === "23505" && error.message === "materialized_asset_conflict"
          && state.object_path === `${A}/shared-original-${round}.png`
          && state.checksum_sha256 === "a".repeat(64) && state.second_delivery_status === "materializing")
        || `error=${JSON.stringify(error)} state=${JSON.stringify(state)}`;
    });

    for (const outcome of ["failed", "canceled"]) {
      await check(round, `${outcome} settlement cannot downgrade a shared ready asset`, async () => {
        const destinations = [
          destination(`shared-${outcome}-pin`, "pinterest", connections.aPin, { boardId: "board-a" }),
          destination(`shared-${outcome}-fb`, "facebook", connections.aFacebook),
        ];
        const value = receipt(`publish:v76:shared-${outcome}:r${round}`, destinations);
        const firstLease = outcome === "failed"
          ? "25252525-2525-4525-8525-252525252511"
          : "25252525-2525-4525-8525-252525252512";
        const secondLease = outcome === "failed"
          ? "26262626-2626-4626-8626-262626262611"
          : "26262626-2626-4626-8626-262626262612";
        const objectPath = `${A}/shared-${outcome}-original-${round}.png`;
        const checksum = outcome === "failed" ? "c".repeat(64) : "d".repeat(64);
        await fixturePreparedRows(db, A, value);
        await db.query("select public.publish_asset_lease_materialization($1,$2,$3,$4,60)",
          [A, value.intentId, destinations[0].id, firstLease]);
        await seedMaterializedProvenance(db, A, value.intentId, objectPath);
        await db.query(`select public.publish_asset_settle_item(
          $1,$2,$3,$4,$5,0,'generated-private',$6,'image/png',100,$7)`,
          [A, value.intentId, destinations[0].id, firstLease, value.media[0].id, objectPath, checksum]);
        await db.query("select public.publish_asset_lease_materialization($1,$2,$3,$4,60)",
          [A, value.intentId, destinations[1].id, secondLease]);
        await db.query(`select public.publish_asset_settle_materialization(
          $1,$2,$3,$4,$5,null,null,null,null,null,'provider_outcome')`,
          [A, value.intentId, destinations[1].id, secondLease, outcome]);
        const state = (await db.query(`select asset.status as asset_status,asset.object_path,asset.checksum_sha256,
          delivery.status as delivery_status,d.status as destination_status,d.materialization_status
          from public.publish_assets asset
          join public.publish_asset_deliveries delivery on delivery.asset_id=asset.id
          join public.publish_intent_destinations d on d.publish_intent_id=delivery.publish_intent_id and d.destination_id=delivery.destination_id
          where asset.publish_intent_id=(select id from public.publish_intents where user_id=$1 and intent_id=$2)
            and delivery.destination_id=$3`, [A, value.intentId, destinations[1].id])).rows[0];
        const expectedMaterialization = outcome === "failed" ? "materialization_failed" : "canceled";
        return (state.asset_status === "ready" && state.object_path === objectPath && state.checksum_sha256 === checksum
            && state.delivery_status === outcome && state.destination_status === outcome
            && state.materialization_status === expectedMaterialization)
          || `shared asset downgraded: ${JSON.stringify(state)}`;
      });
    }

    await check(round, "two-media receipt keeps two stable assets and delivery items", async () => {
      const value = receipt(`publish:v76:multi:r${round}`,
        [destination("multi-pin", "pinterest", connections.aPin, { boardId: "board-a" })], {
          media: [
            { id: "stable-media-a", url: "https://source.invalid/a.png" },
            { id: "stable-media-b", url: "https://source.invalid/b.png" },
          ],
        });
      const leaseToken = "66666666-6666-4666-8666-666666666661";
      const claimToken = "77777777-7777-4777-8777-777777777771";
      await fixturePreparedRows(db, A, value);
      await db.query("select public.publish_asset_lease_materialization($1,$2,'multi-pin',$3,60)",
        [A, value.intentId, leaseToken]);
      const firstPath = `${A}/multi-a-${round}.png`;
      const secondPath = `${A}/multi-b-${round}.png`;
      await seedMaterializedProvenance(db, A, value.intentId, firstPath);
      await seedMaterializedProvenance(db, A, value.intentId, secondPath);
      const first = await db.query(`select public.publish_asset_settle_item(
        $1,$2,'multi-pin',$3,'stable-media-a',0,'generated-private',$4,
        'image/png',101,$5) as value`,
        [A, value.intentId, leaseToken, firstPath, "a".repeat(64)]);
      const second = await db.query(`select public.publish_asset_settle_item(
        $1,$2,'multi-pin',$3,'stable-media-b',1,'generated-private',$4,
        'image/png',102,$5) as value`,
        [A, value.intentId, leaseToken, secondPath, "b".repeat(64)]);
      await db.query("select public.publish_asset_claim_ready($1,$2,'multi-pin',$3)",
        [A, value.intentId, claimToken]);
      const row = (await db.query(`select count(*)::int as assets,
        count(*) filter(where source_media_key is not null and media_ordinal is not null and status='ready')::int as stable,
        (select count(*)::int from public.publish_asset_delivery_items item
          join public.publish_asset_deliveries delivery on delivery.id=item.delivery_id
          where delivery.publish_intent_id=i.id and item.item_status='ready') as items
        from public.publish_assets asset join public.publish_intents i on i.id=asset.publish_intent_id
        where i.user_id=$1 and i.intent_id=$2 group by i.id`, [A, value.intentId])).rows[0];
      return (first.rows[0].value.deliveryReady === false && second.rows[0].value.deliveryReady === true
          && row?.assets === 2 && row?.stable === 2 && row?.items === 2)
        || `expected staged ready=false/true and assets/stable/items=2/2/2, got first=${JSON.stringify(first.rows[0].value)} second=${JSON.stringify(second.rows[0].value)} row=${JSON.stringify(row)}`;
    });

    for (const phase of ["claim", "start"]) {
      await check(round, `${phase} rejects a ready delivery missing one receipt asset item`, async () => {
        const destinationId = `missing-item-${phase}-pin`;
        const value = receipt(`publish:v76:missing-item-${phase}:r${round}`,
          [destination(destinationId, "pinterest", connections.aPin, { boardId: "board-a" })], {
            media: [
              { id: `${phase}-media-a`, url: "https://source.invalid/a.png" },
              { id: `${phase}-media-b`, url: "https://source.invalid/b.png" },
            ],
          });
        const leaseToken = phase === "claim"
          ? "23232323-2323-4323-8323-232323232311"
          : "23232323-2323-4323-8323-232323232312";
        const claimToken = phase === "claim"
          ? "24242424-2424-4424-8424-242424242411"
          : "24242424-2424-4424-8424-242424242412";
        await fixturePreparedRows(db, A, value);
        await db.query("select public.publish_asset_lease_materialization($1,$2,$3,$4,60)",
          [A, value.intentId, destinationId, leaseToken]);
        for (let index = 0; index < 2; index += 1) {
          const objectPath = `${A}/${phase}-media-${index}-${round}.png`;
          await seedMaterializedProvenance(db, A, value.intentId, objectPath);
          await db.query(`select public.publish_asset_settle_item(
            $1,$2,$3,$4,$5,$6,'generated-private',$7,'image/png',$8,$9)`,
            [A, value.intentId, destinationId, leaseToken, value.media[index].id, index,
              objectPath, 100 + index, index === 0 ? "a".repeat(64) : "b".repeat(64)]);
        }
        if (phase === "start") {
          await db.query("select public.publish_asset_claim_ready($1,$2,$3,$4)",
            [A, value.intentId, destinationId, claimToken]);
        }
        await db.query(`delete from public.publish_asset_delivery_items item using public.publish_asset_deliveries delivery
          where item.delivery_id=delivery.id and delivery.publish_intent_id=(select id from public.publish_intents where user_id=$1 and intent_id=$2)
            and delivery.destination_id=$3 and item.media_ordinal=1`, [A, value.intentId, destinationId]);
        const error = phase === "claim"
          ? await rejected(() => db.query("select public.publish_asset_claim_ready($1,$2,$3,$4)",
              [A, value.intentId, destinationId, claimToken]))
          : await rejected(() => db.query("select public.publish_provider_attempt_start($1,$2,$3,$4,1)",
              [A, value.intentId, destinationId, claimToken]));
        const expectedMessage = phase === "claim" ? "materialization_required" : "provider_delivery_not_ready";
        const state = (await db.query(`select d.status,d.claim_token,
          (select count(*)::int from public.provider_publish_attempts attempt where attempt.publish_intent_id=i.id and attempt.destination_id=d.destination_id) as attempts
          from public.publish_intents i join public.publish_intent_destinations d on d.publish_intent_id=i.id
          where i.user_id=$1 and i.intent_id=$2`, [A, value.intentId])).rows[0];
        return (error?.code === "55000" && error.message === expectedMessage && state.attempts === 0
            && (phase === "claim" ? state.status === "prepared" && state.claim_token === null
              : state.status === "claimed" && state.claim_token === claimToken))
          || `error=${JSON.stringify(error)} state=${JSON.stringify(state)}`;
      });
    }

    await check(round, "ready settlement requires locator and checksum", async () => {
      const value = receipt(`publish:v76:locator:r${round}`,
        [destination("locator-pin", "pinterest", connections.aPin, { boardId: "board-a" })]);
      await fixturePreparedRows(db, A, value);
      await db.query("select public.publish_asset_lease_materialization($1,$2,$3,$4,60)",
        [A, value.intentId, "locator-pin", tokens.one]);
      const error = await rejected(() => db.query(`select public.publish_asset_settle_materialization(
        $1,$2,'locator-pin',$3,'ready',null,null,'image/png',10,$4,null)`,
        [A, value.intentId, tokens.one, "d".repeat(64)]));
      const state = (await db.query(`select asset.status as asset_status,delivery.status as delivery_status
        from public.publish_assets asset join public.publish_asset_deliveries delivery on delivery.asset_id=asset.id
        where delivery.publish_intent_id=(select id from public.publish_intents where user_id=$1 and intent_id=$2)
          and delivery.destination_id='locator-pin'`, [A, value.intentId])).rows[0];
      return (error?.code === "22023" && error.message === "ready_locator_checksum_required"
          && state.asset_status === "prepared" && state.delivery_status === "materializing")
        || `error=${JSON.stringify(error)} state=${JSON.stringify(state)}`;
    });

    await check(round, "signed URLs and secret-bearing values are not persisted", async () => {
      const row = (await db.query(`select
        (select count(*)::int from pg_attribute where attrelid in(
          'public.publish_assets'::regclass,'public.publish_asset_deliveries'::regclass)
          and not attisdropped and attname ilike '%signed_url%') as signed_url_columns,
        (select count(*)::int from pg_proc where pronamespace='public'::regnamespace
          and coalesce(array_to_string(proargnames,','),'') ilike '%signed_url%') as signed_url_args,
        (select count(*)::int from public.publish_assets asset
          where to_jsonb(asset)::text ~* '(x-amz-signature|x-goog-signature|[?&](token|signature)=)') as secret_assets,
        (select count(*)::int from public.publish_asset_deliveries delivery
          where to_jsonb(delivery)::text ~* '(x-amz-signature|x-goog-signature|[?&](token|signature)=)') as secret_deliveries`)).rows[0];
      return Object.values(row).every(value => value === 0)
        || `signed URL persistence surface found: ${JSON.stringify(row)}`;
    });

    await check(round, "materialization rejects unsafe source keys and object paths with zero mutation", async () => {
      const value = receipt(`publish:v76:unsafe-materialization:r${round}`,
        [destination("unsafe-materialization-pin", "pinterest", connections.aPin, { boardId: "board-a" })], {
          media: [{ id: "safe-media-key", url: "https://source.invalid/private.png" }],
        });
      const leaseToken = "31313131-3131-4131-8131-313131313131";
      await fixturePreparedRows(db, A, value);
      await db.query("select public.publish_asset_lease_materialization($1,$2,$3,$4,60)",
        [A, value.intentId, "unsafe-materialization-pin", leaseToken]);
      const before = (await db.query(`select asset.status,asset.source_media_key,asset.object_path,
        delivery.status as delivery_status,d.status as destination_status
        from public.publish_intents i join public.publish_assets asset on asset.publish_intent_id=i.id
        join public.publish_asset_deliveries delivery on delivery.publish_intent_id=i.id
        join public.publish_intent_destinations d on d.publish_intent_id=i.id and d.destination_id=delivery.destination_id
        where i.user_id=$1 and i.intent_id=$2`, [A, value.intentId])).rows[0];
      const keyError = await rejected(() => db.query(`select public.publish_asset_settle_item(
        $1,$2,$3,$4,$5,0,'generated-private',$6,'image/png',10,$7)`,
        [A, value.intentId, "unsafe-materialization-pin", leaseToken, "auth-S3CR3TLEAK",
          `${A}/safe.png`, "a".repeat(64)]));
      const pathError = await rejected(() => db.query(`select public.publish_asset_settle_item(
        $1,$2,$3,$4,$5,0,'generated-private',$6,'image/png',10,$7)`,
        [A, value.intentId, "unsafe-materialization-pin", leaseToken, "safe-media-key",
          `${A}/private.png?signature=S3CR3TLEAK`, "a".repeat(64)]));
      const after = (await db.query(`select asset.status,asset.source_media_key,asset.object_path,
        delivery.status as delivery_status,d.status as destination_status
        from public.publish_intents i join public.publish_assets asset on asset.publish_intent_id=i.id
        join public.publish_asset_deliveries delivery on delivery.publish_intent_id=i.id
        join public.publish_intent_destinations d on d.publish_intent_id=i.id and d.destination_id=delivery.destination_id
        where i.user_id=$1 and i.intent_id=$2`, [A, value.intentId])).rows[0];
      return (keyError?.code === "22023" && keyError.message === "invalid_source_media_key"
          && pathError?.code === "22023" && pathError.message === "invalid_object_path"
          && JSON.stringify(before) === JSON.stringify(after)
          && !JSON.stringify(after).includes("S3CR3TLEAK"))
        || `keyError=${JSON.stringify(keyError)} pathError=${JSON.stringify(pathError)} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`;
    });

    await check(round, "materialization locator is private-bucket owner-bound MIME-allowlisted and secret-free", async () => {
      const attacks = [
        { name: "arbitrary-bucket", bucket: "attacker-public", expected: "invalid_bucket_id" },
        { name: "foreign-owner-prefix", pathOwner: B, expected: "invalid_object_path" },
        { name: "secret-bucket", bucket: "token.SECRET", expected: "invalid_bucket_id" },
        { name: "secret-path", path: `${A}/apiKey.SECRET.png`, expected: "invalid_object_path" },
        { name: "non-allowlisted-mime", contentType: "text/html", expected: "invalid_content_type" },
        { name: "secret-mime", contentType: "image/png;token.SECRET", expected: "invalid_content_type" },
      ];
      const leaseTokens = [
        "41414141-4141-4141-8141-414141414141",
        "42424242-4242-4242-8242-424242424242",
        "43434343-4343-4343-8343-434343434343",
        "44444444-4444-4444-8444-444444444444",
        "45454545-4545-4545-8545-454545454545",
        "46464646-4646-4646-8646-464646464646",
      ];
      const results = [];
      for (const [index, attack] of attacks.entries()) {
        const intentId = `publish:v76:locator-policy:${index}:r${round}`;
        const destinationId = `locator-policy-${index}-pin`;
        const mediaId = `locator-policy-media-${index}`;
        const value = receipt(intentId,
          [destination(destinationId, "pinterest", connections.aPin, { boardId: "board-a" })], {
            media: [{ id: mediaId, kind: "image", source: "upload" }],
          });
        await fixturePreparedRows(db, A, value);
        await db.query("select public.publish_asset_lease_materialization($1,$2,$3,$4,60)",
          [A, intentId, destinationId, leaseTokens[index]]);
        const before = (await db.query(`select asset.status,asset.bucket_id,asset.object_path,
          asset.content_type,asset.byte_size,asset.checksum_sha256,
          delivery.status as delivery_status,delivery.lease_token::text as delivery_lease,
          d.status as destination_status,d.materialization_status,d.lease_token::text as destination_lease
          from public.publish_intents i join public.publish_assets asset on asset.publish_intent_id=i.id
          join public.publish_asset_deliveries delivery on delivery.asset_id=asset.id
          join public.publish_intent_destinations d on d.publish_intent_id=i.id
            and d.destination_id=delivery.destination_id
          where i.user_id=$1 and i.intent_id=$2`, [A, intentId])).rows[0];
        const bucket = attack.bucket ?? "generated-private";
        const objectPath = attack.path ?? `${attack.pathOwner ?? A}/locator-policy-${index}.png`;
        const contentType = attack.contentType ?? "image/png";
        const error = await rejected(() => db.query(`select public.publish_asset_settle_item(
          $1,$2,$3,$4,$5,0,$6,$7,$8,10,$9)`,
          [A, intentId, destinationId, leaseTokens[index], mediaId, bucket, objectPath,
            contentType, "e".repeat(64)]));
        const after = (await db.query(`select asset.status,asset.bucket_id,asset.object_path,
          asset.content_type,asset.byte_size,asset.checksum_sha256,
          delivery.status as delivery_status,delivery.lease_token::text as delivery_lease,
          d.status as destination_status,d.materialization_status,d.lease_token::text as destination_lease
          from public.publish_intents i join public.publish_assets asset on asset.publish_intent_id=i.id
          join public.publish_asset_deliveries delivery on delivery.asset_id=asset.id
          join public.publish_intent_destinations d on d.publish_intent_id=i.id
            and d.destination_id=delivery.destination_id
          where i.user_id=$1 and i.intent_id=$2`, [A, intentId])).rows[0];
        results.push({ name: attack.name, expected: attack.expected, error, before, after });
      }
      const secretRows = (await db.query(`select count(*)::int as n
        from public.publish_assets asset join public.publish_intents i on i.id=asset.publish_intent_id
        where i.user_id=$1 and i.intent_id like 'publish:v76:locator-policy:%'
          and to_jsonb(asset)::text like '%SECRET%'`, [A])).rows[0].n;
      return (results.every(item => item.error?.code === "22023"
            && item.error.message === item.expected
            && !JSON.stringify(item.error).includes("SECRET")
            && JSON.stringify(item.before) === JSON.stringify(item.after))
          && secretRows === 0)
        || `results=${JSON.stringify(results)} secretRows=${secretRows}`;
    });

    await check(round, "materialization failure code is strict and never persisted on rejection", async () => {
      const value = receipt(`publish:v76:unsafe-failure-code:r${round}`,
        [destination("unsafe-failure-code-pin", "pinterest", connections.aPin, { boardId: "board-a" })]);
      const leaseToken = "32323232-3232-4232-8232-323232323232";
      await fixturePreparedRows(db, A, value);
      await db.query("select public.publish_asset_lease_materialization($1,$2,$3,$4,60)",
        [A, value.intentId, "unsafe-failure-code-pin", leaseToken]);
      const before = (await db.query(`select asset.failure_code,delivery.failure_code,delivery.status
        from public.publish_intents i join public.publish_assets asset on asset.publish_intent_id=i.id
        join public.publish_asset_deliveries delivery on delivery.publish_intent_id=i.id
        where i.user_id=$1 and i.intent_id=$2`, [A, value.intentId])).rows[0];
      const error = await rejected(() => db.query(`select public.publish_asset_settle_materialization(
        $1,$2,$3,$4,'failed',null,null,null,null,null,$5)`,
        [A, value.intentId, "unsafe-failure-code-pin", leaseToken, "auth_token_S3CR3TLEAK"]));
      const after = (await db.query(`select asset.failure_code,delivery.failure_code,delivery.status
        from public.publish_intents i join public.publish_assets asset on asset.publish_intent_id=i.id
        join public.publish_asset_deliveries delivery on delivery.publish_intent_id=i.id
        where i.user_id=$1 and i.intent_id=$2`, [A, value.intentId])).rows[0];
      return (error?.code === "22023" && error.message === "invalid_failure_code"
          && JSON.stringify(before) === JSON.stringify(after) && !JSON.stringify(after).includes("S3CR3TLEAK"))
        || `error=${JSON.stringify(error)} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`;
    });

    await check(round, "cleanup error code is strict and rejection leaves processing row unchanged", async () => {
      const id = (await db.query(`insert into public.media_cleanup_outbox(
        owner_user_id,bucket_id,object_path,reason,dedupe_key)
        values($1,'generated-private',$2,'harness',$3) returning id`,
        [A, `${A}/cleanup-safe-${round}.png`, `v76:cleanup-safe:${round}`])).rows[0].id;
      const leaseToken = "33333333-3333-4333-8333-333333333339";
      await db.query("select public.publish_cleanup_lease($1,$2,60)", [id, leaseToken]);
      const before = (await db.query("select status,last_error_code,lease_token from public.media_cleanup_outbox where id=$1", [id])).rows[0];
      const error = await rejected(() => db.query(
        "select public.publish_cleanup_settle($1,$2,'pending',$3)", [id, leaseToken, "cookie_S3CR3TLEAK"]));
      const after = (await db.query("select status,last_error_code,lease_token from public.media_cleanup_outbox where id=$1", [id])).rows[0];
      return (error?.code === "22023" && error.message === "invalid_cleanup_error_code"
          && JSON.stringify(before) === JSON.stringify(after) && !JSON.stringify(after).includes("S3CR3TLEAK"))
        || `error=${JSON.stringify(error)} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`;
    });

    await check(round, "provider permalink and evidence reject secret-bearing input with zero mutation", async () => {
      const value = receipt(`publish:v76:unsafe-provider:r${round}`,
        [destination("unsafe-provider-pin", "pinterest", connections.aPin, { boardId: "board-a" })]);
      const leaseToken = "34343434-3434-4434-8434-343434343434";
      const claimToken = "35353535-3535-4535-8535-353535353535";
      await readyAndClaim(db, A, value, leaseToken, claimToken);
      const started = (await db.query(
        "select public.publish_provider_attempt_start($1,$2,$3,$4,1) as value",
        [A, value.intentId, "unsafe-provider-pin", claimToken])).rows[0].value;
      const before = (await db.query(`select attempt.status,attempt.remote_url,attempt.evidence,
        d.status as destination_status,d.remote_url as destination_url,d.evidence as destination_evidence
        from public.provider_publish_attempts attempt join public.publish_intent_destinations d
          on d.publish_intent_id=attempt.publish_intent_id and d.destination_id=attempt.destination_id
        where attempt.id=$1`, [started.attemptId])).rows[0];
      const urlCases = [
        "http://www.pinterest.com/pin/123", "https://user:credential@www.pinterest.com/pin/123",
        "https://www.pinterest.com/pin/123?token=S3CR3TLEAK", "https://evil.invalid/pin/123",
      ];
      const evidenceCases = [
        { token: "S3CR3TLEAK" }, { credential: "S3CR3TLEAK" },
        { cookie: "S3CR3TLEAK" }, { auth: "S3CR3TLEAK" },
        { provider: "Bearer-S3CR3TLEAK" },
      ];
      const urlErrors = [];
      for (const remoteUrl of urlCases) {
        urlErrors.push(await rejected(() => db.query(`select public.publish_provider_attempt_settle(
          $1,$2,$3,'succeeded',201,'remote-safe',$4,'{"provider":"ok"}'::jsonb)`,
          [A, started.attemptId, claimToken, remoteUrl])));
      }
      const evidenceErrors = [];
      for (const evidence of evidenceCases) {
        evidenceErrors.push(await rejected(() => db.query(`select public.publish_provider_attempt_settle(
          $1,$2,$3,'succeeded',201,'remote-safe','https://www.pinterest.com/pin/123',$4::jsonb)`,
          [A, started.attemptId, claimToken, JSON.stringify(evidence)])));
      }
      const after = (await db.query(`select attempt.status,attempt.remote_url,attempt.evidence,
        d.status as destination_status,d.remote_url as destination_url,d.evidence as destination_evidence
        from public.provider_publish_attempts attempt join public.publish_intent_destinations d
          on d.publish_intent_id=attempt.publish_intent_id and d.destination_id=attempt.destination_id
        where attempt.id=$1`, [started.attemptId])).rows[0];
      return (urlErrors.every(error => error?.code === "22023" && error.message === "provider_remote_url_invalid")
          && evidenceErrors.every(error => error?.code === "22023" && error.message === "provider_evidence_invalid")
          && JSON.stringify(before) === JSON.stringify(after) && !JSON.stringify(after).includes("S3CR3TLEAK"))
        || `urlErrors=${JSON.stringify(urlErrors)} evidenceErrors=${JSON.stringify(evidenceErrors)} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`;
    });

    await check(round, "provider success binds permalink host and evidence provider to the locked destination", async () => {
      const attacks = [
        {
          name: "pinterest-destination-facebook-permalink", destinationProvider: "pinterest",
          remoteProvider: "facebook", evidenceProvider: "pinterest",
          expected: "provider_remote_url_provider_mismatch",
        },
        {
          name: "facebook-destination-pinterest-permalink", destinationProvider: "facebook",
          remoteProvider: "pinterest", evidenceProvider: "facebook",
          expected: "provider_remote_url_provider_mismatch",
        },
        {
          name: "pinterest-destination-facebook-evidence", destinationProvider: "pinterest",
          remoteProvider: "pinterest", evidenceProvider: "facebook",
          expected: "provider_evidence_provider_mismatch",
        },
        {
          name: "facebook-destination-pinterest-evidence", destinationProvider: "facebook",
          remoteProvider: "facebook", evidenceProvider: "pinterest",
          expected: "provider_evidence_provider_mismatch",
        },
        {
          name: "pinterest-destination-generic-ok-evidence", destinationProvider: "pinterest",
          remoteProvider: "pinterest", evidenceProvider: "ok",
          expected: "provider_evidence_provider_mismatch",
        },
        {
          name: "facebook-destination-generic-ok-evidence", destinationProvider: "facebook",
          remoteProvider: "facebook", evidenceProvider: "ok",
          expected: "provider_evidence_provider_mismatch",
        },
      ];
      const leaseTokens = [
        "51515151-5151-4151-8151-515151515151",
        "52525252-5252-4252-8252-525252525252",
        "53535353-5353-4353-8353-535353535353",
        "54545454-5454-4454-8454-545454545454",
        "55555555-5555-4555-8555-555555555555",
        "56565656-5656-4656-8656-565656565656",
      ];
      const claimTokens = [
        "61616161-6161-4161-8161-616161616161",
        "62626262-6262-4262-8262-626262626262",
        "63636363-6363-4363-8363-636363636363",
        "64646464-6464-4464-8464-646464646464",
        "65656565-6565-4565-8565-656565656565",
        "66666666-6666-4666-8666-666666666666",
      ];
      const remoteUrls = {
        pinterest: "https://www.pinterest.com/pin/987654321",
        facebook: "https://www.facebook.com/vibepin/posts/remote-123",
      };
      const results = [];
      for (const [index, attack] of attacks.entries()) {
        const intentId = `publish:v76:provider-binding:${index}:r${round}`;
        const destinationId = `provider-binding-${index}`;
        const connectionId = attack.destinationProvider === "pinterest"
          ? connections.aPin : connections.aFacebook;
        const extra = attack.destinationProvider === "pinterest" ? { boardId: "board-a" } : {};
        const value = receipt(intentId,
          [destination(destinationId, attack.destinationProvider, connectionId, extra)]);
        await readyAndClaim(db, A, value, leaseTokens[index], claimTokens[index]);
        const started = (await db.query(
          "select public.publish_provider_attempt_start($1,$2,$3,$4,1) as value",
          [A, intentId, destinationId, claimTokens[index]])).rows[0].value;
        const before = (await db.query(`select attempt.status as attempt_status,
          attempt.provider_status,attempt.remote_id,attempt.remote_url,attempt.evidence,
          delivery.status as delivery_status,d.status as destination_status,d.claim_token::text,
          d.provider_status as destination_provider_status,d.remote_id as destination_remote_id,
          d.remote_url as destination_remote_url,d.evidence as destination_evidence,
          i.lifecycle_status
          from public.provider_publish_attempts attempt
          join public.publish_intents i on i.id=attempt.publish_intent_id
          join public.publish_intent_destinations d on d.publish_intent_id=i.id
            and d.destination_id=attempt.destination_id
          join public.publish_asset_deliveries delivery on delivery.id=attempt.delivery_id
          where attempt.id=$1`, [started.attemptId])).rows[0];
        const error = await rejected(() => db.query(`select public.publish_provider_attempt_settle(
          $1,$2,$3,'succeeded',201,$4,$5,$6::jsonb)`,
          [A, started.attemptId, claimTokens[index], `remote-${index}`,
            remoteUrls[attack.remoteProvider], JSON.stringify({ provider: attack.evidenceProvider })]));
        const after = (await db.query(`select attempt.status as attempt_status,
          attempt.provider_status,attempt.remote_id,attempt.remote_url,attempt.evidence,
          delivery.status as delivery_status,d.status as destination_status,d.claim_token::text,
          d.provider_status as destination_provider_status,d.remote_id as destination_remote_id,
          d.remote_url as destination_remote_url,d.evidence as destination_evidence,
          i.lifecycle_status
          from public.provider_publish_attempts attempt
          join public.publish_intents i on i.id=attempt.publish_intent_id
          join public.publish_intent_destinations d on d.publish_intent_id=i.id
            and d.destination_id=attempt.destination_id
          join public.publish_asset_deliveries delivery on delivery.id=attempt.delivery_id
          where attempt.id=$1`, [started.attemptId])).rows[0];
        results.push({ name: attack.name, expected: attack.expected, error, before, after });
      }
      return results.every(item => item.error?.code === "22023"
          && item.error.message === item.expected
          && JSON.stringify(item.before) === JSON.stringify(item.after)
          && item.after.attempt_status === "started"
          && item.after.delivery_status === "ready"
          && item.after.destination_status === "claimed"
          && item.after.lifecycle_status !== "settled"
          && !JSON.stringify(item.after).includes("SECRET"))
        || `results=${JSON.stringify(results)}`;
    });

    await check(round, "delivery-item and provider-attempt identity is immutable including claim-token authority", async () => {
      const aValue = receipt(`publish:v76:immutable-a:r${round}`,
        [destination("immutable-a-pin", "pinterest", connections.aPin, { boardId: "board-a" })]);
      const bValue = receipt(`publish:v76:immutable-b:r${round}`,
        [destination("immutable-b-pin", "pinterest", connections.bPin, { boardId: "board-b" })]);
      const aLease = "71717171-7171-4171-8171-717171717171";
      const aClaim = "72727272-7272-4272-8272-727272727272";
      const bLease = "73737373-7373-4373-8373-737373737373";
      const bClaim = "74747474-7474-4474-8474-747474747474";
      await readyAndClaim(db, A, aValue, aLease, aClaim);
      await readyAndClaim(db, B, bValue, bLease, bClaim);
      const startedA = (await db.query(
        "select public.publish_provider_attempt_start($1,$2,$3,$4,1) as value",
        [A, aValue.intentId, "immutable-a-pin", aClaim])).rows[0].value;

      const graphRow = async (owner, intentId) => (await db.query(`select
          i.id::text as intent_db_id,d.destination_id,delivery.id::text as delivery_id,
          asset.id::text as asset_id,item.id::text as item_id,item.owner_user_id::text,
          item.media_ordinal
        from public.publish_intents i
        join public.publish_intent_destinations d on d.publish_intent_id=i.id
        join public.publish_asset_deliveries delivery on delivery.publish_intent_id=i.id
          and delivery.destination_id=d.destination_id
        join public.publish_asset_delivery_items item on item.delivery_id=delivery.id
        join public.publish_assets asset on asset.id=item.asset_id
        where i.user_id=$1 and i.intent_id=$2`, [owner, intentId])).rows[0];
      const aGraph = await graphRow(A, aValue.intentId);
      const bGraph = await graphRow(B, bValue.intentId);
      const bRebindAssetId = (await db.query(`insert into public.publish_assets(
          owner_user_id,publish_intent_id,source_revision,source_fingerprint,strategy,
          status,source_media_key,media_ordinal,bucket_id,object_path,content_type,
          byte_size,checksum_sha256,materialized_at)
        values($1,$2,$3,$4,'provider_bytes','ready',$5,99,'generated-private',$6,
          'image/png',64,$7,now()) returning id::text`,
        [B, bGraph.intent_db_id, bValue.sourceUpdatedAt, bValue.fingerprint,
          `immutable-b-rebind-${round}`, `${B}/immutable-b-rebind-${round}.png`, "f".repeat(64)])).rows[0].id;
      const itemSnapshot = async () => (await db.query(`select id::text,owner_user_id::text,
          delivery_id::text,asset_id::text,destination_id,media_ordinal,item_status
        from public.publish_asset_delivery_items where id=$1`, [aGraph.item_id])).rows[0];
      const attemptSnapshot = async () => (await db.query(`select id::text,owner_user_id::text,
          publish_intent_id::text,destination_id,delivery_id::text,attempt,idempotency_key,
          claim_token::text,status,provider_status,remote_id,remote_url,evidence
        from public.provider_publish_attempts where id=$1`, [startedA.attemptId])).rows[0];
      const rolledBackError = async action => {
        await db.exec("begin");
        try { return await rejected(action); }
        finally { await db.exec("rollback"); }
      };

      const itemBefore = await itemSnapshot();
      const itemAttacks = [
        ["owner_user_id", B],
        ["delivery_id", bGraph.delivery_id],
        ["asset_id", bGraph.asset_id],
        ["destination_id", bGraph.destination_id],
        ["media_ordinal", 99],
      ];
      const itemResults = [];
      for (const [field, value] of itemAttacks) {
        const error = await rolledBackError(() => db.query(
          `update public.publish_asset_delivery_items set ${field}=$2 where id=$1`,
          [aGraph.item_id, value]));
        itemResults.push({ field, error, after: await itemSnapshot() });
      }
      const combinedItemError = await rolledBackError(() => db.query(`update public.publish_asset_delivery_items set
        owner_user_id=$2,delivery_id=$3,asset_id=$4,destination_id=$5,media_ordinal=99 where id=$1`,
        [aGraph.item_id, B, bGraph.delivery_id, bRebindAssetId, bGraph.destination_id]));
      itemResults.push({ field: "combined-cross-owner-graph", error: combinedItemError,
        after: await itemSnapshot() });

      const attemptBefore = await attemptSnapshot();
      const attemptAttacks = [
        ["owner_user_id", B, "v76_provider_attempt_identity_immutable"],
        ["publish_intent_id", bGraph.intent_db_id, "v76_provider_attempt_identity_immutable"],
        ["destination_id", bGraph.destination_id, "v76_provider_attempt_identity_immutable"],
        ["delivery_id", bGraph.delivery_id, "v76_provider_attempt_identity_immutable"],
        ["attempt", 2, "v76_provider_attempt_identity_immutable"],
        ["idempotency_key", `v76:tampered:${round}`, "v76_provider_attempt_identity_immutable"],
        ["claim_token", tokens.three, "v76_provider_attempt_claim_token_immutable"],
        ["claim_token", null, "v76_provider_attempt_claim_token_immutable"],
      ];
      const attemptResults = [];
      for (const [field, value, expected] of attemptAttacks) {
        const error = await rolledBackError(() => db.query(
          `update public.provider_publish_attempts set ${field}=$2 where id=$1`,
          [startedA.attemptId, value]));
        attemptResults.push({ field, value, expected, error, after: await attemptSnapshot() });
      }

      await db.exec("begin");
      let crossUpdateError;
      let crossSettleError = { message: "not_attempted", code: null };
      try {
        crossUpdateError = await rejected(() => db.query(`update public.provider_publish_attempts set
          owner_user_id=$2,publish_intent_id=$3,destination_id=$4,delivery_id=$5,
          attempt=2,idempotency_key=$6,claim_token=$7 where id=$1`,
          [startedA.attemptId, B, bGraph.intent_db_id, bGraph.destination_id, bGraph.delivery_id,
            `v76:provider:${B}:${bGraph.intent_db_id}:${bGraph.destination_id}:2`, bClaim]));
        if (!crossUpdateError) {
          crossSettleError = await rejected(() => db.query(`select public.publish_provider_attempt_settle(
            $1,$2,$3,'succeeded',201,'remote-cross','https://www.pinterest.com/pin/7654321',
            '{"provider":"pinterest"}'::jsonb)`, [B, startedA.attemptId, bClaim]));
        }
      } finally {
        await db.exec("rollback");
      }
      const crossState = { attempt: await attemptSnapshot(), bGraph: await graphRow(B, bValue.intentId) };

      const normalSettle = (await db.query(`select public.publish_provider_attempt_settle(
        $1,$2,$3,'succeeded',201,'remote-immutable','https://www.pinterest.com/pin/7654322',
        '{"provider":"pinterest"}'::jsonb) as value`, [A, startedA.attemptId, aClaim])).rows[0].value;
      const normalState = (await db.query(`select attempt.status,attempt.claim_token::text,
          d.status as destination_status,d.claim_token::text as destination_claim,
          delivery.status as delivery_status
        from public.provider_publish_attempts attempt
        join public.publish_intent_destinations d on d.publish_intent_id=attempt.publish_intent_id
          and d.destination_id=attempt.destination_id
        join public.publish_asset_deliveries delivery on delivery.id=attempt.delivery_id
        where attempt.id=$1`, [startedA.attemptId])).rows[0];
      return (itemResults.every(item => item.error?.code === "55000"
            && item.error.message === "v76_delivery_item_identity_immutable"
            && JSON.stringify(item.after) === JSON.stringify(itemBefore))
          && attemptResults.every(item => item.error?.code === "55000"
            && item.error.message === item.expected
            && JSON.stringify(item.after) === JSON.stringify(attemptBefore))
          && crossUpdateError?.code === "55000"
          && crossUpdateError.message === "v76_provider_attempt_identity_immutable"
          && crossSettleError.message === "not_attempted"
          && JSON.stringify(crossState.attempt) === JSON.stringify(attemptBefore)
          && crossState.bGraph.item_id === bGraph.item_id
          && normalSettle.settled === true && normalState.status === "succeeded"
          && normalState.claim_token === null && normalState.destination_claim === null
          && normalState.destination_status === "published" && normalState.delivery_status === "published")
        || `items=${JSON.stringify(itemResults)} attempts=${JSON.stringify(attemptResults)} crossUpdate=${JSON.stringify(crossUpdateError)} crossSettle=${JSON.stringify(crossSettleError)} crossState=${JSON.stringify(crossState)} normal=${JSON.stringify({ normalSettle, normalState })}`;
    });

    await check(round, "service-role cannot delete evidence while parent RESTRICT and normal settle remain intact", async () => {
      const value = receipt(`publish:v76:evidence-delete:r${round}`,
        [destination("evidence-delete-pin", "pinterest", connections.aPin, { boardId: "board-a" })]);
      const leaseToken = "75757575-7575-4575-8575-757575757575";
      const claimToken = "76767676-7676-4676-8676-767676767676";
      await readyAndClaim(db, A, value, leaseToken, claimToken);
      const started = (await db.query(
        "select public.publish_provider_attempt_start($1,$2,$3,$4,1) as value",
        [A, value.intentId, "evidence-delete-pin", claimToken])).rows[0].value;
      const ids = (await db.query(`select i.id::text as intent_db_id,item.id::text as item_id,
          attempt.id::text as attempt_id
        from public.publish_intents i
        join public.publish_asset_deliveries delivery on delivery.publish_intent_id=i.id
        join public.publish_asset_delivery_items item on item.delivery_id=delivery.id
        join public.provider_publish_attempts attempt on attempt.delivery_id=delivery.id
        where i.user_id=$1 and i.intent_id=$2`, [A, value.intentId])).rows[0];
      const counts = async () => (await db.query(`select
          (select count(*)::int from public.publish_asset_delivery_items where id=$1) as items,
          (select count(*)::int from public.provider_publish_attempts where id=$2) as attempts,
          (select count(*)::int from public.publish_intents where id=$3) as intents`,
        [ids.item_id, ids.attempt_id, ids.intent_db_id])).rows[0];
      const before = await counts();
      const serviceDelete = async (table, id) => {
        await db.exec("begin");
        try {
          await db.exec("set local role service_role");
          return await rejected(() => db.query(`delete from public.${table} where id=$1`, [id]));
        } finally {
          await db.exec("rollback");
        }
      };
      const itemDeleteError = await serviceDelete("publish_asset_delivery_items", ids.item_id);
      const afterItemDelete = await counts();
      const attemptDeleteError = await serviceDelete("provider_publish_attempts", ids.attempt_id);
      const afterAttemptDelete = await counts();
      const parentDeleteError = await rejected(() => db.query(
        "delete from public.publish_intents where id=$1", [ids.intent_db_id]));
      const afterParentDelete = await counts();
      const settled = (await db.query(`select public.publish_provider_attempt_settle(
        $1,$2,$3,'succeeded',201,'remote-delete-guard','https://www.pinterest.com/pin/7654323',
        '{"provider":"pinterest"}'::jsonb) as value`, [A, started.attemptId, claimToken])).rows[0].value;
      const finalState = (await db.query(`select attempt.status,d.status as destination_status,
          d.claim_token::text,delivery.status as delivery_status,
          (select count(*)::int from public.publish_asset_delivery_items item
            where item.delivery_id=delivery.id) as items
        from public.provider_publish_attempts attempt
        join public.publish_intent_destinations d on d.publish_intent_id=attempt.publish_intent_id
          and d.destination_id=attempt.destination_id
        join public.publish_asset_deliveries delivery on delivery.id=attempt.delivery_id
        where attempt.id=$1`, [started.attemptId])).rows[0];
      return (itemDeleteError?.code === "42501"
          && attemptDeleteError?.code === "42501"
          && parentDeleteError?.code === "23001"
          && JSON.stringify(before) === JSON.stringify(afterItemDelete)
          && JSON.stringify(before) === JSON.stringify(afterAttemptDelete)
          && JSON.stringify(before) === JSON.stringify(afterParentDelete)
          && settled.settled === true && finalState.status === "succeeded"
          && finalState.destination_status === "published" && finalState.claim_token === null
          && finalState.delivery_status === "published" && finalState.items === 1)
        || `itemDelete=${JSON.stringify(itemDeleteError)} attemptDelete=${JSON.stringify(attemptDeleteError)} parentDelete=${JSON.stringify(parentDeleteError)} counts=${JSON.stringify({ before, afterItemDelete, afterAttemptDelete, afterParentDelete })} settled=${JSON.stringify(settled)} final=${JSON.stringify(finalState)}`;
    });

    await check(round, "service-role direct evidence writes are denied while all RPC settlement outcomes replay safely", async () => {
      const cases = [
        {
          outcome: "succeeded", intentId: `publish:v76:direct-write-success:r${round}`,
          destinationId: "direct-write-success-pin",
          leaseToken: "81818181-8181-4181-8181-818181818181",
          claimToken: "82828282-8282-4282-8282-828282828282",
        },
        {
          outcome: "failed", intentId: `publish:v76:direct-write-failed:r${round}`,
          destinationId: "direct-write-failed-pin",
          leaseToken: "83838383-8383-4383-8383-838383838383",
          claimToken: "84848484-8484-4484-8484-848484848484",
        },
        {
          outcome: "unknown", intentId: `publish:v76:direct-write-unknown:r${round}`,
          destinationId: "direct-write-unknown-pin",
          leaseToken: "85858585-8585-4585-8585-858585858585",
          claimToken: "86868686-8686-4686-8686-868686868686",
        },
      ];
      for (const item of cases) {
        item.value = receipt(item.intentId,
          [destination(item.destinationId, "pinterest", connections.aPin, { boardId: "board-a" })]);
        await readyAndClaim(db, A, item.value, item.leaseToken, item.claimToken);
        item.started = (await db.query(
          "select public.publish_provider_attempt_start($1,$2,$3,$4,1) as value",
          [A, item.intentId, item.destinationId, item.claimToken])).rows[0].value;
      }

      const success = cases[0];
      const successSettle = (await db.query(`select public.publish_provider_attempt_settle(
        $1,$2,$3,'succeeded',201,'remote-direct-write','https://www.pinterest.com/pin/8765401',
        '{"provider":"pinterest"}'::jsonb) as value`,
      [A, success.started.attemptId, success.claimToken])).rows[0].value;
      const successReplay = (await db.query(`select public.publish_provider_attempt_settle(
        $1,$2,$3,'succeeded',201,'remote-direct-write','https://www.pinterest.com/pin/8765401',
        '{"provider":"pinterest"}'::jsonb) as value`,
      [A, success.started.attemptId, success.claimToken])).rows[0].value;
      const failed = cases[1];
      const failedSettle = (await db.query(`select public.publish_provider_attempt_settle(
        $1,$2,$3,'failed',503,null,null,'{"reason":"retryable"}'::jsonb) as value`,
      [A, failed.started.attemptId, failed.claimToken])).rows[0].value;
      const unknown = cases[2];
      const unknownSettle = (await db.query(`select public.publish_provider_attempt_settle(
        $1,$2,$3,'unknown',null,null,null,'{"reason":"unknown_outcome"}'::jsonb) as value`,
      [A, unknown.started.attemptId, unknown.claimToken])).rows[0].value;

      const successGraph = (await db.query(`select i.id::text as intent_db_id,i.source_revision,
          i.source_fingerprint,d.destination_id,delivery.id::text as delivery_id,
          item.id::text as item_id,asset.id::text as asset_id
        from public.publish_intents i
        join public.publish_intent_destinations d on d.publish_intent_id=i.id
        join public.publish_asset_deliveries delivery on delivery.publish_intent_id=i.id
          and delivery.destination_id=d.destination_id
        join public.publish_asset_delivery_items item on item.delivery_id=delivery.id
        join public.publish_assets asset on asset.id=item.asset_id
        where i.user_id=$1 and i.intent_id=$2`, [A, success.intentId])).rows[0];
      const extraAssetId = (await db.query(`insert into public.publish_assets(
          owner_user_id,publish_intent_id,source_revision,source_fingerprint,strategy,
          status,source_media_key,media_ordinal)
        values($1,$2,$3,$4,'provider_bytes','prepared',$5,99) returning id::text`,
      [A, successGraph.intent_db_id, successGraph.source_revision, successGraph.source_fingerprint,
        `direct-write-extra-${round}`])).rows[0].id;
      const itemSnapshot = async () => (await db.query(`select id::text,owner_user_id::text,
          delivery_id::text,asset_id::text,destination_id,media_ordinal,item_status
        from public.publish_asset_delivery_items where id=$1`, [successGraph.item_id])).rows[0];
      const attemptSnapshot = async () => (await db.query(`select id::text,status,provider_status,
          remote_id,remote_url,evidence,finished_at,claim_token::text
        from public.provider_publish_attempts where id=$1`, [success.started.attemptId])).rows[0];
      const scopedCounts = async () => (await db.query(`select
          (select count(*)::int from public.publish_asset_delivery_items
            where delivery_id=$1) as items,
          (select count(*)::int from public.provider_publish_attempts
            where publish_intent_id=$2) as attempts`,
      [successGraph.delivery_id, successGraph.intent_db_id])).rows[0];
      const serviceWrite = async action => {
        await db.exec("begin");
        try {
          await db.exec("set local role service_role");
          return await rejected(action);
        } finally {
          await db.exec("rollback");
        }
      };

      const beforeCounts = await scopedCounts();
      const insertItemError = await serviceWrite(() => db.query(`insert into public.publish_asset_delivery_items(
          delivery_id,asset_id,owner_user_id,destination_id,media_ordinal,item_status)
        values($1,$2,$3,$4,99,'prepared')`,
      [successGraph.delivery_id, extraAssetId, A, successGraph.destination_id]));
      const afterItemInsert = await scopedCounts();
      const insertAttemptError = await serviceWrite(() => db.query(`insert into public.provider_publish_attempts(
          owner_user_id,publish_intent_id,destination_id,delivery_id,attempt,
          idempotency_key,status,claim_token)
        values($1,$2,$3,$4,2,$5,'started',$6)`,
      [A, successGraph.intent_db_id, successGraph.destination_id, successGraph.delivery_id,
        `v76:direct-service-attempt:${round}`, "87878787-8787-4787-8787-878787878787"]));
      const afterAttemptInsert = await scopedCounts();

      const itemBefore = await itemSnapshot();
      const itemStatusError = await serviceWrite(() => db.query(
        "update public.publish_asset_delivery_items set item_status='failed' where id=$1",
        [successGraph.item_id]));
      const itemAfter = await itemSnapshot();
      const terminalBefore = await attemptSnapshot();
      const terminalAttacks = [
        ["provider_status", 299],
        ["remote_id", `tampered-${round}`],
        ["remote_url", "https://www.pinterest.com/pin/8765499"],
        ["evidence", JSON.stringify({ provider: "pinterest", reason: "retryable" })],
        ["finished_at", "2030-01-01T00:00:00.000Z"],
      ];
      const terminalResults = [];
      for (const [field, value] of terminalAttacks) {
        const cast = field === "evidence" ? "::jsonb" : field === "finished_at" ? "::timestamptz" : "";
        const error = await serviceWrite(() => db.query(
          `update public.provider_publish_attempts set ${field}=$2${cast} where id=$1`,
          [success.started.attemptId, value]));
        terminalResults.push({ field, error, after: await attemptSnapshot() });
      }
      const providerStates = (await db.query(`select i.intent_id,i.lifecycle_status,
          d.status as destination_status,d.materialization_status,
          delivery.status as delivery_status,asset.status as asset_status,
          attempt.status as attempt_status,attempt.claim_token::text,
          (select count(*)::int from public.v76_provider_settlement_context proof
            where proof.attempt_id=attempt.id) as proof_rows
        from public.publish_intents i
        join public.publish_intent_destinations d on d.publish_intent_id=i.id
        join public.publish_asset_deliveries delivery on delivery.publish_intent_id=i.id
          and delivery.destination_id=d.destination_id
        join public.publish_assets asset on asset.id=delivery.asset_id
        join public.provider_publish_attempts attempt on attempt.publish_intent_id=i.id
          and attempt.destination_id=d.destination_id
        where i.user_id=$1 and i.intent_id=any($2::text[]) order by i.intent_id`,
      [A, cases.map(item => item.intentId)])).rows;
      const stateByIntent = new Map(providerStates.map(row => [row.intent_id, row]));
      const successState = stateByIntent.get(success.intentId);
      const failedState = stateByIntent.get(failed.intentId);
      const unknownState = stateByIntent.get(unknown.intentId);
      return (insertItemError?.code === "42501" && insertAttemptError?.code === "42501"
          && itemStatusError?.code === "42501"
          && terminalResults.every(item => item.error?.code === "42501"
            && JSON.stringify(item.after) === JSON.stringify(terminalBefore))
          && JSON.stringify(beforeCounts) === JSON.stringify(afterItemInsert)
          && JSON.stringify(beforeCounts) === JSON.stringify(afterAttemptInsert)
          && JSON.stringify(itemBefore) === JSON.stringify(itemAfter)
          && successSettle.status === "succeeded" && successReplay.replayed === true
          && failedSettle.status === "failed" && unknownSettle.status === "unknown"
          && successState.lifecycle_status === "settled"
          && successState.destination_status === "published" && successState.delivery_status === "published"
          && failedState.destination_status === "failed" && failedState.delivery_status === "failed"
          && unknownState.lifecycle_status === "delivery_unknown"
          && unknownState.destination_status === "delivery_unknown"
          && unknownState.delivery_status === "delivery_unknown"
          && providerStates.every(row => row.materialization_status === "materialized"
            && row.asset_status === "ready" && row.claim_token === null && row.proof_rows === 0))
        || `directErrors=${JSON.stringify({ insertItemError, insertAttemptError, itemStatusError, terminalResults })} counts=${JSON.stringify({ beforeCounts, afterItemInsert, afterAttemptInsert })} item=${JSON.stringify({ itemBefore, itemAfter })} settlements=${JSON.stringify({ successSettle, successReplay, failedSettle, unknownSettle })} states=${JSON.stringify(providerStates)}`;
    });

    await check(round, "service-role assets and deliveries are read-only while definer publish flow remains writable", async () => {
      const value = receipt(`publish:v76:ledger-readonly:r${round}`,
        [destination("ledger-readonly-pin", "pinterest", connections.aPin, { boardId: "board-a" })]);
      const leaseToken = "91919191-9191-4191-8191-919191919191";
      const claimToken = "92929292-9292-4292-8292-929292929292";
      const materialized = await readyAndClaim(db, A, value, leaseToken, claimToken);
      const started = (await db.query(
        "select public.publish_provider_attempt_start($1,$2,$3,$4,1) as value",
        [A, value.intentId, "ledger-readonly-pin", claimToken])).rows[0].value;
      const settled = (await db.query(`select public.publish_provider_attempt_settle(
        $1,$2,$3,'succeeded',201,'remote-ledger-readonly','https://www.pinterest.com/pin/9988701',
        '{"provider":"pinterest"}'::jsonb) as value`,
      [A, started.attemptId, claimToken])).rows[0].value;
      const graph = (await db.query(`select i.id::text as intent_db_id,i.source_revision,
          i.source_fingerprint,asset.id::text as asset_id,delivery.id::text as delivery_id,
          d.destination_id
        from public.publish_intents i
        join public.publish_intent_destinations d on d.publish_intent_id=i.id
        join public.publish_asset_deliveries delivery on delivery.publish_intent_id=i.id
          and delivery.destination_id=d.destination_id
        join public.publish_assets asset on asset.id=delivery.asset_id
        where i.user_id=$1 and i.intent_id=$2`, [A, value.intentId])).rows[0];
      await db.query(`insert into public.publish_intent_destinations(
          owner_user_id,publish_intent_id,destination_id,provider,social_connection_id,
          subdestination_id,status,materialization_status,source_revision)
        values($1,$2,$3,'pinterest',$4,$5,'prepared','prepared',$6)`,
      [A, graph.intent_db_id, `ledger-readonly-shadow-${round}`, connections.aPin,
        `board-shadow-${round}`, graph.source_revision]);

      const assetSnapshot = async () => (await db.query(`select id::text,owner_user_id::text,
          publish_intent_id::text,status,bucket_id,object_path,content_type,byte_size,
          checksum_sha256,failure_code,materialized_at
        from public.publish_assets where id=$1`, [graph.asset_id])).rows[0];
      const deliverySnapshot = async () => (await db.query(`select id::text,owner_user_id::text,
          asset_id::text,publish_intent_id::text,destination_id,provider,delivery_mode,
          status,idempotency_key,failure_code,ready_at
        from public.publish_asset_deliveries where id=$1`, [graph.delivery_id])).rows[0];
      const scopedCounts = async () => (await db.query(`select
          (select count(*)::int from public.publish_assets where publish_intent_id=$1) as assets,
          (select count(*)::int from public.publish_asset_deliveries where publish_intent_id=$1) as deliveries`,
      [graph.intent_db_id])).rows[0];
      const serviceDml = async action => {
        await db.exec("begin");
        try {
          await db.exec("set local role service_role");
          return await rejected(action);
        } finally {
          await db.exec("rollback");
        }
      };

      const beforeCounts = await scopedCounts();
      const insertAssetError = await serviceDml(() => db.query(`insert into public.publish_assets(
          owner_user_id,publish_intent_id,source_revision,source_fingerprint,strategy,
          status,source_media_key,media_ordinal)
        values($1,$2,$3,$4,'provider_bytes','prepared',$5,98)`,
      [A, graph.intent_db_id, graph.source_revision, graph.source_fingerprint,
        `ledger-direct-asset-${round}`]));
      const afterAssetInsert = await scopedCounts();
      const insertDeliveryError = await serviceDml(() => db.query(`insert into public.publish_asset_deliveries(
          owner_user_id,asset_id,publish_intent_id,destination_id,provider,delivery_mode,
          status,idempotency_key)
        values($1,$2,$3,$4,'pinterest','provider_bytes','prepared',$5)`,
      [A, graph.asset_id, graph.intent_db_id, `ledger-readonly-shadow-${round}`,
        `v76:direct-delivery:${round}`]));
      const afterDeliveryInsert = await scopedCounts();

      const assetBefore = await assetSnapshot();
      const updateAssetError = await serviceDml(() => db.query(`update public.publish_assets set
          bucket_id='attacker-bucket',object_path=$2,content_type='text/html',
          checksum_sha256=$3 where id=$1`,
      [graph.asset_id, `${B}/tampered-${round}.html`, "0".repeat(64)]));
      const assetAfterUpdate = await assetSnapshot();
      const deliveryBefore = await deliverySnapshot();
      const updateDeliveryError = await serviceDml(() => db.query(
        "update public.publish_asset_deliveries set status='failed',failure_code='provider_outcome' where id=$1",
        [graph.delivery_id]));
      const deliveryAfterUpdate = await deliverySnapshot();
      const deleteAssetError = await serviceDml(() => db.query(
        "delete from public.publish_assets where id=$1", [graph.asset_id]));
      const assetAfterDelete = await assetSnapshot();
      const deleteDeliveryError = await serviceDml(() => db.query(
        "delete from public.publish_asset_deliveries where id=$1", [graph.delivery_id]));
      const deliveryAfterDelete = await deliverySnapshot();
      const afterAll = await scopedCounts();
      const aclSnapshot = async () => (await db.query(`select
          has_table_privilege('service_role','public.publish_assets','select') as asset_select,
          has_table_privilege('service_role','public.publish_assets','insert') as asset_insert,
          has_table_privilege('service_role','public.publish_assets','update') as asset_update,
          has_table_privilege('service_role','public.publish_assets','delete') as asset_delete,
          has_table_privilege('service_role','public.publish_asset_deliveries','select') as delivery_select,
          has_table_privilege('service_role','public.publish_asset_deliveries','insert') as delivery_insert,
          has_table_privilege('service_role','public.publish_asset_deliveries','update') as delivery_update,
          has_table_privilege('service_role','public.publish_asset_deliveries','delete') as delivery_delete`)).rows[0];
      const privileges = await aclSnapshot();
      const normalState = (await db.query(`select i.lifecycle_status,d.status as destination_status,
          d.materialization_status,d.claim_token::text,asset.status as asset_status,
          asset.bucket_id,asset.object_path,asset.checksum_sha256,
          delivery.status as delivery_status,attempt.status as attempt_status
        from public.publish_intents i
        join public.publish_intent_destinations d on d.publish_intent_id=i.id
          and d.destination_id='ledger-readonly-pin'
        join public.publish_asset_deliveries delivery on delivery.publish_intent_id=i.id
          and delivery.destination_id=d.destination_id
        join public.publish_assets asset on asset.id=delivery.asset_id
        join public.provider_publish_attempts attempt on attempt.delivery_id=delivery.id
        where i.user_id=$1 and i.intent_id=$2`, [A, value.intentId])).rows[0];
      await db.exec(rollback);
      const rollbackPrivileges = await aclSnapshot();
      await db.exec(v76);
      const errors = [insertAssetError, insertDeliveryError, updateAssetError,
        updateDeliveryError, deleteAssetError, deleteDeliveryError];
      const readOnlyAcl = acl => acl.asset_select && acl.delivery_select
        && !acl.asset_insert && !acl.asset_update && !acl.asset_delete
        && !acl.delivery_insert && !acl.delivery_update && !acl.delivery_delete;
      return (errors.every(error => error?.code === "42501")
          && JSON.stringify(beforeCounts) === JSON.stringify(afterAssetInsert)
          && JSON.stringify(beforeCounts) === JSON.stringify(afterDeliveryInsert)
          && JSON.stringify(beforeCounts) === JSON.stringify(afterAll)
          && JSON.stringify(assetBefore) === JSON.stringify(assetAfterUpdate)
          && JSON.stringify(assetBefore) === JSON.stringify(assetAfterDelete)
          && JSON.stringify(deliveryBefore) === JSON.stringify(deliveryAfterUpdate)
          && JSON.stringify(deliveryBefore) === JSON.stringify(deliveryAfterDelete)
          && readOnlyAcl(privileges) && readOnlyAcl(rollbackPrivileges)
          && materialized.claim.claimed === true && settled.status === "succeeded"
          && normalState.lifecycle_status === "settled"
          && normalState.destination_status === "published"
          && normalState.materialization_status === "materialized"
          && normalState.claim_token === null && normalState.asset_status === "ready"
          && normalState.bucket_id === "generated-private"
          && normalState.object_path === `${A}/${value.intentId}.png`
          && normalState.checksum_sha256 === "b".repeat(64)
          && normalState.delivery_status === "published" && normalState.attempt_status === "succeeded")
        || `errors=${JSON.stringify(errors)} counts=${JSON.stringify({ beforeCounts, afterAssetInsert, afterDeliveryInsert, afterAll })} asset=${JSON.stringify({ assetBefore, assetAfterUpdate, assetAfterDelete })} delivery=${JSON.stringify({ deliveryBefore, deliveryAfterUpdate, deliveryAfterDelete })} privileges=${JSON.stringify({ beforeRollback: privileges, afterRollback: rollbackPrivileges })} normal=${JSON.stringify({ materialized, settled, normalState })}`;
    });

    await check(round, "expired processing cleanup lease is taken over", async () => {
      const id = (await db.query(`insert into public.media_cleanup_outbox(
        owner_user_id,bucket_id,object_path,reason,dedupe_key)
        values($1,'generated-private',$2,'harness',$3) returning id`,
        [A, `${A}/expired-${round}.png`, `v76:expired:${round}`])).rows[0].id;
      await db.query("select public.publish_cleanup_lease($1,$2,60)", [id, tokens.one]);
      await db.query("update public.media_cleanup_outbox set lease_expires_at=now()-interval '1 second' where id=$1", [id]);
      const result = await db.query("select public.publish_cleanup_lease($1,$2,60) as value", [id, tokens.two]);
      const beforeOldSettle = (await db.query(`select status,lease_token::text,attempts,
        completed_at,last_error_code from public.media_cleanup_outbox where id=$1`, [id])).rows[0];
      const oldTokenError = await rejected(() => db.query(
        "select public.publish_cleanup_settle($1,$2,'done',null)", [id, tokens.one]));
      const afterOldSettle = (await db.query(`select status,lease_token::text,attempts,
        completed_at,last_error_code from public.media_cleanup_outbox where id=$1`, [id])).rows[0];
      const settled = (await db.query(
        "select public.publish_cleanup_settle($1,$2,'done',null) as value", [id, tokens.two])).rows[0].value;
      const finalState = (await db.query(`select status,lease_token::text,attempts,
        completed_at is not null as completed,last_error_code
        from public.media_cleanup_outbox where id=$1`, [id])).rows[0];
      return (result.rows[0].value.leaseToken === tokens.two
          && result.rows[0].value.attempts === 2
          && oldTokenError?.code === "40001" && oldTokenError.message === "cleanup_lease_lost"
          && JSON.stringify(beforeOldSettle) === JSON.stringify(afterOldSettle)
          && settled.settled === true && settled.status === "done"
          && finalState.status === "done" && finalState.lease_token === null
          && finalState.attempts === 2 && finalState.completed && finalState.last_error_code === null)
        || `takeover=${JSON.stringify(result.rows[0].value)} oldError=${JSON.stringify(oldTokenError)} before=${JSON.stringify(beforeOldSettle)} after=${JSON.stringify(afterOldSettle)} settled=${JSON.stringify(settled)} final=${JSON.stringify(finalState)}`;
    });

    await check(round, "delivery items enforce RLS and client revokes", async () => {
      const row = (await db.query(`select
        (select relrowsecurity from pg_class where oid='public.publish_asset_delivery_items'::regclass) as item_rls,
        (select relrowsecurity from pg_class where oid='public.provider_publish_attempts'::regclass) as attempt_rls,
        has_table_privilege('anon','public.publish_asset_delivery_items','select') as anon_select,
        has_table_privilege('authenticated','public.publish_asset_delivery_items','select') as auth_select,
        has_table_privilege('anon','public.publish_asset_delivery_items','delete') as anon_item_delete,
        has_table_privilege('authenticated','public.publish_asset_delivery_items','delete') as auth_item_delete,
        has_table_privilege('anon','public.provider_publish_attempts','delete') as anon_attempt_delete,
        has_table_privilege('authenticated','public.provider_publish_attempts','delete') as auth_attempt_delete,
        has_table_privilege('service_role','public.v76_provider_settlement_context','select') as proof_select,
        has_table_privilege('service_role','public.v76_provider_settlement_context','insert') as proof_insert,
        has_table_privilege('service_role','public.v76_provider_settlement_context','update') as proof_update,
        has_table_privilege('service_role','public.v76_provider_settlement_context','delete') as proof_delete`)).rows[0];
      return (row.item_rls && row.attempt_rls && !row.anon_select && !row.auth_select
          && !row.anon_item_delete && !row.auth_item_delete
          && !row.anon_attempt_delete && !row.auth_attempt_delete
          && !row.proof_select && !row.proof_insert && !row.proof_update && !row.proof_delete)
        || `expected RLS/revokes, got ${JSON.stringify(row)}`;
    });

    await check(round, "ownership chain uses composite FKs", async () => {
      const expected = [
        ["publish_destinations_v76_owner_intent_fk", "publish_intent_destinations",
          ["owner_user_id", "publish_intent_id"], "publish_intents", ["user_id", "id"]],
        ["publish_assets_v76_owner_intent_fk", "publish_assets",
          ["owner_user_id", "publish_intent_id"], "publish_intents", ["user_id", "id"]],
        ["publish_deliveries_v76_owner_asset_intent_fk", "publish_asset_deliveries",
          ["owner_user_id", "asset_id", "publish_intent_id"], "publish_assets",
          ["owner_user_id", "id", "publish_intent_id"]],
        ["publish_deliveries_v76_owner_destination_fk", "publish_asset_deliveries",
          ["owner_user_id", "publish_intent_id", "destination_id"], "publish_intent_destinations",
          ["owner_user_id", "publish_intent_id", "destination_id"]],
        ["publish_items_v76_owner_delivery_target_fk", "publish_asset_delivery_items",
          ["owner_user_id", "delivery_id", "destination_id"], "publish_asset_deliveries",
          ["owner_user_id", "id", "destination_id"]],
        ["publish_items_v76_owner_asset_fk", "publish_asset_delivery_items",
          ["owner_user_id", "asset_id"], "publish_assets", ["owner_user_id", "id"]],
        ["publish_attempts_v76_owner_delivery_target_fk", "provider_publish_attempts",
          ["owner_user_id", "delivery_id", "destination_id"], "publish_asset_deliveries",
          ["owner_user_id", "id", "destination_id"]],
        ["publish_attempts_v76_owner_destination_fk", "provider_publish_attempts",
          ["owner_user_id", "publish_intent_id", "destination_id"], "publish_intent_destinations",
          ["owner_user_id", "publish_intent_id", "destination_id"]],
      ];
      const names = expected.map(item => item[0]);
      const rows = (await db.query(`select c.conname,
          c.conrelid::regclass::text as source_table,
          array(select a.attname from unnest(c.conkey) with ordinality key(attnum,ordinal)
            join pg_attribute a on a.attrelid=c.conrelid and a.attnum=key.attnum
            order by key.ordinal) as source_columns,
          c.confrelid::regclass::text as target_table,
          array(select a.attname from unnest(c.confkey) with ordinality key(attnum,ordinal)
            join pg_attribute a on a.attrelid=c.confrelid and a.attnum=key.attnum
            order by key.ordinal) as target_columns,
          c.confdeltype,c.confupdtype,c.confmatchtype,c.condeferrable,c.condeferred,c.convalidated
        from pg_constraint c where c.conname=any($1::text[]) order by c.conname`, [names])).rows;
      const mismatches = expected.filter(([name, sourceTable, sourceColumns, targetTable, targetColumns]) => {
        const row = rows.find(item => item.conname === name);
        return !row || row.source_table !== sourceTable
          || JSON.stringify(row.source_columns) !== JSON.stringify(sourceColumns)
          || row.target_table !== targetTable
          || JSON.stringify(row.target_columns) !== JSON.stringify(targetColumns)
          || row.confdeltype !== "r" || row.confupdtype !== "a" || row.confmatchtype !== "s"
          || row.condeferrable || row.condeferred || !row.convalidated;
      }).map(item => item[0]);
      const ownerColumns = (await db.query(`select
        exists(select 1 from pg_attribute where attrelid='public.publish_asset_deliveries'::regclass
          and attname='owner_user_id' and not attisdropped) as delivery_owner,
        exists(select 1 from pg_attribute where attrelid='public.publish_intent_destinations'::regclass
          and attname='owner_user_id' and not attisdropped) as destination_owner`)).rows[0];
      return (rows.length === 8 && mismatches.length === 0
          && ownerColumns.delivery_owner && ownerColumns.destination_owner)
        || `incomplete exact owner FK chain: rows=${JSON.stringify(rows)} mismatches=${JSON.stringify(mismatches)} owners=${JSON.stringify(ownerColumns)}`;
    });

    await check(round, "tables and RPC definitions have v76 ownership markers", async () => {
      const row = (await db.query(`select
        obj_description('public.publish_assets'::regclass,'pg_class') as table_marker,
        obj_description(to_regprocedure('public.publish_intent_cancel(uuid,text,text)'),'pg_proc') as function_marker`)).rows[0];
      return (row.table_marker?.startsWith("vibepin:v76:") && row.function_marker?.startsWith("vibepin:v76:"))
        || `missing markers: ${JSON.stringify(row)}`;
    });

    await check(round, "rollback retains evidence, revokes service, and NOTIFYs", async () => {
      const before = (await db.query("select count(*)::int as n from public.publish_assets")).rows[0].n;
      await db.exec(rollback);
      const after = (await db.query("select count(*)::int as n from public.publish_assets")).rows[0].n;
      const allowed = (await db.query(`select has_function_privilege('service_role',
        'public.publish_intent_cancel(uuid,text,text)','execute') as allowed`)).rows[0].allowed;
      const notified = /notify\s+pgrst\s*,\s*'reload schema'/i.test(rollback);
      return (before === after && !allowed && notified)
        || `before=${before} after=${after} serviceExecute=${allowed} notify=${notified}`;
    });

    await db.exec(v76);
    await check(round, "reapply restores service-only RPC grant", async () => {
      const row = (await db.query(`select
        has_function_privilege('service_role','public.publish_intent_cancel(uuid,text,text)','execute') as service_allowed,
        has_function_privilege('authenticated','public.publish_intent_cancel(uuid,text,text)','execute') as auth_allowed`)).rows[0];
      return row.service_allowed && !row.auth_allowed;
    });
  } finally {
    await db.close();
  }

  const markerTamperDb = await freshDb();
  try {
    await check(round, "marker tamper makes reapply fail closed", async () => {
      await markerTamperDb.exec("comment on table public.publish_assets is 'tampered'");
      const error = await rejected(() => markerTamperDb.exec(v76));
      return (error?.code === "P0001" && error.message === "v76_marker_tamper")
        || `expected P0001/v76_marker_tamper, got ${JSON.stringify(error)}`;
    });
  } finally {
    await markerTamperDb.close();
  }

  const definitionTamperDb = await freshDb();
  try {
    await check(round, "RPC definition tamper makes reapply fail closed", async () => {
      await definitionTamperDb.exec(`create or replace function public.publish_intent_cancel(
          p_user_id uuid,p_intent_id text,p_source_revision text)
        returns jsonb language sql security definer set search_path=public,pg_temp
        as $$ select '{"tampered":true}'::jsonb $$`);
      const error = await rejected(() => definitionTamperDb.exec(v76));
      return (error?.code === "P0001" && error.message === "v76_definition_tamper")
        || `expected P0001/v76_definition_tamper, got ${JSON.stringify(error)}`;
    });
  } finally {
    await definitionTamperDb.close();
  }

  await check(round, "nonrepresentative RPC and lifecycle CHECK tamper fail closed without partial reapply", async () => {
    const scenarios = [
      {
        name: "cleanup-lease-definition",
        expected: "v76_definition_tamper",
        tamper: tamperDb => tamperDb.exec(`create or replace function public.publish_cleanup_lease(
            p_outbox_id bigint,p_lease_token uuid,p_lease_seconds integer default 300)
          returns jsonb language sql security definer set search_path=public,pg_temp
          as $$ select '{"tampered":true}'::jsonb $$`),
        definition: async tamperDb => (await tamperDb.query(`select pg_get_functiondef(
          to_regprocedure('public.publish_cleanup_lease(bigint,uuid,integer)')) as value`)).rows[0].value,
      },
      {
        // Preserve language, signature, search_path and both ownership markers;
        // only the body hash can detect this otherwise plausible replacement.
        name: "cleanup-lease-body-hash",
        expected: "v76_definition_tamper",
        tamper: async tamperDb => {
          const definition = (await tamperDb.query(`select pg_get_functiondef(
            'public.publish_cleanup_lease(bigint,uuid,integer)'::regprocedure) as value`)).rows[0].value;
          await tamperDb.exec(definition.replace("begin", "begin\n  perform 1;"));
        },
        definition: async tamperDb => (await tamperDb.query(`select pg_get_functiondef(
          'public.publish_cleanup_lease(bigint,uuid,integer)'::regprocedure) as value`)).rows[0].value,
      },
      {
        name: "lifecycle-check-true",
        expected: "v76_check_constraint_tamper",
        tamper: tamperDb => tamperDb.exec(`alter table public.publish_intents
            drop constraint publish_intents_v76_lifecycle_status_check;
          alter table public.publish_intents
            add constraint publish_intents_v76_lifecycle_status_check check(true)`),
        definition: async tamperDb => (await tamperDb.query(`select pg_get_constraintdef(oid,true) as value
          from pg_constraint where conrelid='public.publish_intents'::regclass
            and conname='publish_intents_v76_lifecycle_status_check'`)).rows[0].value,
      },
    ];
    const results = [];
    for (const scenario of scenarios) {
      const tamperDb = await freshDb();
      try {
        const sentinelId = (await tamperDb.query(`insert into public.media_cleanup_outbox(
            owner_user_id,bucket_id,object_path,reason,dedupe_key)
          values($1,'generated-private',$2,'tamper-sentinel',$3) returning id`,
        [A, `${A}/tamper-${scenario.name}-${round}.png`,
          `v76:tamper:${scenario.name}:${round}`])).rows[0].id;
        await scenario.tamper(tamperDb);
        const dataSnapshot = async () => (await tamperDb.query(`select to_jsonb(outbox) as value
          from public.media_cleanup_outbox outbox where id=$1`, [sentinelId])).rows[0].value;
        const schemaSnapshot = async () => (await tamperDb.query(`select
          (select count(*)::int from pg_attribute where attrelid in(
            'public.publish_intents'::regclass,'public.publish_intent_destinations'::regclass,
            'public.publish_assets'::regclass,'public.publish_asset_deliveries'::regclass,
            'public.publish_asset_delivery_items'::regclass,'public.provider_publish_attempts'::regclass)
            and not attisdropped) as columns,
          (select count(*)::int from pg_constraint where conrelid in(
            'public.publish_intents'::regclass,'public.publish_intent_destinations'::regclass,
            'public.publish_assets'::regclass,'public.publish_asset_deliveries'::regclass,
            'public.publish_asset_delivery_items'::regclass,'public.provider_publish_attempts'::regclass)) as constraints,
          (select count(*)::int from pg_proc where pronamespace='public'::regnamespace
            and proname like 'publish_%') as publish_functions,
          obj_description('public.publish_assets'::regclass,'pg_class') as asset_marker,
          obj_description(to_regprocedure('public.publish_intent_cancel(uuid,text,text)'),'pg_proc')
            as cancel_marker,
          pg_get_functiondef(to_regprocedure('public.publish_intent_cancel(uuid,text,text)'))
            as other_rpc_definition,
          (select pg_get_constraintdef(oid,true) from pg_constraint
            where conrelid='public.publish_intent_destinations'::regclass
              and conname='publish_intent_destinations_v76_materialization_status_check')
            as other_check_definition,
          has_table_privilege('service_role','public.publish_assets','select') as asset_select,
          has_table_privilege('service_role','public.publish_assets','insert') as asset_insert`)).rows[0];
        const before = {
          definition: await scenario.definition(tamperDb),
          data: await dataSnapshot(),
          schema: await schemaSnapshot(),
        };
        const error = await rejected(() => tamperDb.exec(v76));
        const after = {
          definition: await scenario.definition(tamperDb),
          data: await dataSnapshot(),
          schema: await schemaSnapshot(),
        };
        results.push({ name: scenario.name, expected: scenario.expected, error, before, after });
      } finally {
        await tamperDb.close();
      }
    }
    return results.every(item => item.error?.code === "P0001"
        && item.error.message === item.expected
        && item.before.definition === item.after.definition
        && JSON.stringify(item.before.data) === JSON.stringify(item.after.data)
        && JSON.stringify(item.before.schema) === JSON.stringify(item.after.schema))
      || `tamper results=${JSON.stringify(results)}`;
  });
}

for (let round = 1; round <= 2; round += 1) {
  try { await runRound(round); }
  catch (error) { failures.push({ round, name: "round setup/runtime", detail: clean(error) }); }
}

const report = { verdict: failures.length ? "fail" : "pass", rounds: 2,
  assertions, passes, failed: failures.length,
  newAssertions: 4, expectedNewRed: 0,
  baseline: { commit: "41089316849352f677852f7944a5fbd465dd2eb7",
    assertions: 276, passes: 276, failed: 0 },
  failures };
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
