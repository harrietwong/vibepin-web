import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const sql = relative => fs.readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const db = new PGlite();

const userA = "00000000-0000-4000-8000-000000000071";
const userB = "00000000-0000-4000-8000-000000000072";
const keyA = "a".repeat(48);
const keyB = "b".repeat(48);
const fpA = "c".repeat(64);
const fpB = "d".repeat(64);

async function scalar(query, params = []) {
  const result = await db.query(query, params);
  return Object.values(result.rows[0] ?? {})[0];
}

async function expectSqlState(state, fn, label) {
  try { await fn(); } catch (error) {
    const actual = error?.cause?.code ?? error?.code;
    assert(actual === state, `${label}: expected SQLSTATE ${state}, got ${actual}: ${error}`);
    return;
  }
  throw new Error(`${label}: expected SQLSTATE ${state}`);
}

try {
  await db.exec("create role anon; create role authenticated; create role service_role;");
  await db.exec(sql("backend/db/migrate_v51_generation_jobs.sql"));
  await db.exec(sql("backend/db/migrate_v55_usage_primitives.sql"));
  await db.exec(sql("backend/db/migrate_v71_generation_intent_idempotency.sql"));

  assert(await scalar(`select count(*) = 2 from information_schema.columns
    where table_name='generation_jobs' and column_name like 'generation_intent_%'`), "intent columns missing");
  assert(await scalar("select to_regprocedure('generation_enqueue_job_idempotent(uuid,text,text,text[],jsonb,boolean)') is not null"), "plain RPC missing");
  assert(await scalar("select to_regprocedure('usage_reserve_generation_job_v2(uuid,text[],text,text,text,jsonb,text,text,timestamptz,jsonb,boolean)') is not null"), "metered RPC missing");

  const fresh = await scalar(
    "select generation_enqueue_job_idempotent($1,$2,$3,array['s0','s1'],$4::jsonb,false)",
    [userA, keyA, fpA, JSON.stringify({ prompt: "one", count: 2 })],
  );
  const replay = await scalar(
    "select generation_enqueue_job_idempotent($1,$2,$3,array['s0','s1'],$4::jsonb,false)",
    [userA, keyA, fpA, JSON.stringify({ prompt: "one", count: 2 })],
  );
  assert(fresh.replayed === false && replay.replayed === true, "fresh/replay flags incorrect");
  assert(fresh.job_id === replay.job_id, "plain replay changed job id");
  assert(Number(await scalar("select count(*) from generation_jobs where vibepin_user_id=$1 and generation_intent_key=$2", [userA, keyA])) === 1, "plain replay duplicated job");

  await expectSqlState("23505", () => db.query(
    "select generation_enqueue_job_idempotent($1,$2,$3,array['s0','s1'],$4::jsonb,false)",
    [userA, keyA, fpB, JSON.stringify({ prompt: "changed", count: 2 })],
  ), "immutable fingerprint conflict");
  await expectSqlState("23514", () => db.query(
    "update generation_jobs set generation_intent_key=$1 where id=$2", [keyB, fresh.job_id],
  ), "immutable trigger");

  await db.query("update generation_jobs set status='done', results=$1::jsonb where id=$2", [
    JSON.stringify([{ slot: 0, status: "done", imageUrl: "https://example.test/0.png", error: null }]),
    fresh.job_id,
  ]);
  const terminal = await scalar("select generation_lookup_job_by_intent($1,$2,$3)", [userA, keyA, fpA]);
  assert(terminal.found === true && terminal.job_status === "done", "terminal replay not preserved");

  await db.query(`insert into usage_accounts (
    user_id, plan_key, period_start, period_end, period_anchor,
    ai_images_limit, ai_images_used, ai_images_reserved,
    ai_text_generations_used, ai_text_generations_reserved,
    scheduled_posts_used, scheduled_posts_reserved,
    bonus_images_balance, bonus_images_reserved, bonus_images_used,
    review_required, version, created_at, updated_at
  ) values ($1,'free',now(),now()+interval '30 days',now(),100,0,0,0,0,0,0,0,0,0,false,0,now(),now())`, [userB]);

  const metered = await scalar(
    "select usage_reserve_generation_job_v2($1,array['s0','s1'],$2,$2,$3,$4::jsonb)",
    [userB, keyB, fpB, JSON.stringify({ prompt: "metered", count: 2 })],
  );
  const meteredReplay = await scalar(
    "select usage_reserve_generation_job_v2($1,array['s0','s1'],$2,$2,$3,$4::jsonb)",
    [userB, keyB, fpB, JSON.stringify({ prompt: "metered", count: 2 })],
  );
  assert(metered.replayed === false && meteredReplay.replayed === true, "metered replay incorrect");
  assert(metered.job_id === meteredReplay.job_id, "metered replay changed job");
  assert(Number(await scalar("select count(*) from usage_reservations where user_id=$1", [userB])) === 1, "metered replay duplicated reservation");

  const firstSettle = await scalar(
    "select usage_settle_reservation_item($1,'s0','succeeded',$2)",
    [metered.reservation_id, metered.job_id],
  );
  const secondSettle = await scalar(
    "select usage_settle_reservation_item($1,'s0','succeeded',$2)",
    [metered.reservation_id, metered.job_id],
  );
  assert(firstSettle.replayed === false && secondSettle.replayed === true, "settle replay incorrect");
  assert(Number(await scalar("select count(*) from usage_events where reservation_id=$1 and idempotency_key like 'settle:%:s0'", [metered.reservation_id])) === 1, "settle emitted more than once");

  await expectSqlState("P0001", () => db.query(
    "select generation_enqueue_job_idempotent($1,$2,$3,array['s0'],$4::jsonb,true)",
    [userA, "e".repeat(48), "f".repeat(64), JSON.stringify({ prompt: "rollback" })],
  ), "precommit fault injection");
  assert(Number(await scalar("select count(*) from generation_jobs where generation_intent_key=$1", ["e".repeat(48)])) === 0, "precommit error left a job");

  const legacyCount = Number(await scalar("select count(*) from generation_jobs"));
  await db.exec(sql("backend/db/rollback_v71_generation_intent_idempotency.sql"));
  assert(!(await scalar("select exists(select 1 from information_schema.columns where table_name='generation_jobs' and column_name='generation_intent_key')")), "rollback left key column");
  assert(Number(await scalar("select count(*) from generation_jobs")) === legacyCount, "rollback changed legacy jobs");
  console.log(JSON.stringify({ ok: true, engine: "pglite-in-memory", apply: true, replay: true, conflict: true, settleOnce: true, rollback: true }));
} finally {
  await db.close();
}
