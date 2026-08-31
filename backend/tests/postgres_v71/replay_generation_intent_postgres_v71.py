#!/usr/bin/env python3
"""Destructive ONLY to a disposable loopback PostgreSQL database named vibepin_v71_*.

This is the real-Postgres P0 gate for v71. It is intentionally not invoked by the
normal suite and refuses remote/test-project credentials. The operator must provide
an exact loopback DSN and confirmation token; the current package does not run it.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path

import psycopg2
from psycopg2.extensions import parse_dsn


ROOT = Path(__file__).resolve().parents[3]
MIGRATION = ROOT / "backend/db/migrate_v71_generation_intent_idempotency.sql"
ROLLBACK = ROOT / "backend/db/rollback_v71_generation_intent_idempotency.sql"
USERS = [f"00000000-0000-4000-8000-{n:012d}" for n in range(7101, 7105)]


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def fingerprint(params: dict[str, object], slots: int) -> str:
    return hashlib.sha256(canonical({"params": params, "slots": slots}).encode()).hexdigest()


def key(label: str) -> str:
    return hashlib.sha256(label.encode()).hexdigest()[:48]


def guard(dsn: str, confirmation: str) -> None:
    parts = parse_dsn(dsn)
    host = parts.get("host", "")
    hostaddr = parts.get("hostaddr", "")
    database = parts.get("dbname", "")
    if parts.get("service"):
        raise RuntimeError("v71 harness refuses libpq service indirection")
    if "," in host or "," in hostaddr:
        raise RuntimeError("v71 harness refuses multi-host DSNs")
    if host not in {"127.0.0.1", "::1"}:
        raise RuntimeError("v71 harness refuses every non-loopback PostgreSQL host")
    if hostaddr and hostaddr not in {"127.0.0.1", "::1"}:
        raise RuntimeError("v71 harness refuses a non-loopback hostaddr override")
    if not database.startswith("vibepin_v71_"):
        raise RuntimeError("database name must start with vibepin_v71_")
    expected = f"LOCAL-V71:{host}:{parts.get('port', '5432')}:{database}"
    if confirmation != expected:
        raise RuntimeError(f"exact confirmation required: {expected}")


def one(conn, sql: str, args: tuple[object, ...] = ()) -> object:
    with conn.cursor() as cur:
        cur.execute(sql, args)
        return cur.fetchone()[0]


def expect_state(conn, state: str, sql: str, args: tuple[object, ...]) -> None:
    try:
        one(conn, sql, args)
    except psycopg2.Error as exc:
        if exc.pgcode != state:
            raise AssertionError(f"expected SQLSTATE {state}, got {exc.pgcode}") from exc
        conn.rollback()
        return
    raise AssertionError(f"expected SQLSTATE {state}")


def plain_call(dsn: str, user: str, intent: str, fp: str, params: dict[str, object]) -> dict[str, object]:
    with psycopg2.connect(dsn) as conn:
        return one(conn, "select generation_enqueue_job_idempotent(%s,%s,%s,array['s0','s1'],%s::jsonb,false)",
                   (user, intent, fp, json.dumps(params)))


def metered_call(dsn: str, user: str, intent: str, fp: str, params: dict[str, object]) -> dict[str, object]:
    with psycopg2.connect(dsn) as conn:
        return one(conn, "select usage_reserve_generation_job_v2(%s,array['s0','s1'],%s,%s,%s,%s::jsonb)",
                   (user, intent, intent, fp, json.dumps(params)))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dsn", required=True)
    parser.add_argument("--confirm", required=True)
    args = parser.parse_args()
    guard(args.dsn, args.confirm)

    conn = psycopg2.connect(args.dsn)
    conn.autocommit = True
    server_addr = str(one(conn, "select inet_server_addr()"))
    if server_addr not in {"127.0.0.1", "::1"}:
        conn.close()
        raise RuntimeError("connected PostgreSQL endpoint is not loopback")
    baseline_jobs = int(one(conn, "select count(*) from generation_jobs"))
    baseline_accounts = int(one(conn, "select count(*) from usage_accounts"))
    applied = False
    try:
        with conn.cursor() as cur:
            cur.execute(MIGRATION.read_text(encoding="utf-8"))
        applied = True
        assert one(conn, "select to_regprocedure('generation_lookup_job_by_intent(uuid,text,text)') is not null")
        assert int(one(conn, "select count(*) from information_schema.columns where table_name='generation_jobs' and column_name like 'generation_intent_%'")) == 2

        with conn.cursor() as cur:
            for user in USERS:
                cur.execute("""insert into usage_accounts (
                  user_id, plan_key, period_start, period_end, period_anchor,
                  ai_images_limit, ai_images_used, ai_images_reserved,
                  ai_text_generations_used, ai_text_generations_reserved,
                  scheduled_posts_used, scheduled_posts_reserved,
                  bonus_images_balance, bonus_images_reserved, bonus_images_used,
                  review_required, version, created_at, updated_at
                ) values (%s,'free',now(),now()+interval '30 days',now(),100,0,0,0,0,0,0,0,0,0,false,0,now(),now())""", (user,))

        params = {
            "count": 2, "prompt": "base", "product_images": ["https://p/1"],
            "style_ref": "https://r/1", "model_key": "gemini_image",
            "format": "vertical 2:3", "retryOfOutputId": None,
        }
        fp = fingerprint(params, 2)
        intent = key("20-way-mixed")
        calls = []
        for index in range(20):
            calls.append((metered_call if index % 3 else plain_call, USERS[0], intent, fp, params))
        with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
            results = list(pool.map(lambda call: call[0](args.dsn, *call[1:]), calls))
        job_ids = {str(result["job_id"]) for result in results}
        assert len(job_ids) == 1, f"20-way mixed concurrency produced {len(job_ids)} jobs"
        assert int(one(conn, "select count(*) from generation_jobs where vibepin_user_id=%s and generation_intent_key=%s", (USERS[0], intent))) == 1
        assert int(one(conn, "select count(*) from usage_reservations where user_id=%s and request_key=%s", (USERS[0], intent))) <= 1

        for field, value in [
            ("count", 3), ("prompt", "changed"),
            ("product_images", ["https://p/2"]), ("style_ref", "https://r/2"),
            ("model_key", "gpt_image"), ("format", "square 1:1"),
            ("retryOfOutputId", "different-output"),
        ]:
            changed = {**params, field: value}
            changed_fp = fingerprint(changed, int(changed["count"]))
            expect_state(conn, "23505", "select generation_lookup_job_by_intent(%s,%s,%s)",
                         (USERS[0], intent, changed_fp))
            assert int(one(conn, "select count(*) from generation_jobs where vibepin_user_id=%s and generation_intent_key=%s", (USERS[0], intent))) == 1

        # Commit-response-loss: deliberately discard the committed first result and
        # recover it through a new connection using the same intent.
        loss_intent = key("response-loss")
        loss_fp = fingerprint(params, 2)
        plain_call(args.dsn, USERS[1], loss_intent, loss_fp, params)
        recovered = metered_call(args.dsn, USERS[1], loss_intent, loss_fp, params)
        assert recovered["replayed"] is True
        assert int(one(conn, "select count(*) from generation_jobs where vibepin_user_id=%s and generation_intent_key=%s", (USERS[1], loss_intent))) == 1

        # Precommit injected errors leave no job and no reservation.
        pre_intent = key("precommit")
        expect_state(conn, "P0001",
            "select usage_reserve_generation_job_v2(%s,array['s0'],%s,%s,%s,%s::jsonb,'image_generation',null,null,'{}'::jsonb,true)",
            (USERS[2], pre_intent, pre_intent, loss_fp, json.dumps(params)))
        assert int(one(conn, "select count(*) from generation_jobs where generation_intent_key=%s", (pre_intent,))) == 0
        assert int(one(conn, "select count(*) from usage_reservations where user_id=%s and request_key=%s", (USERS[2], pre_intent))) == 0

        # Lifecycle replay and repeated settlement both preserve one durable effect.
        metered_intent = key("settle-once")
        metered = metered_call(args.dsn, USERS[3], metered_intent, loss_fp, params)
        with conn.cursor() as cur:
            cur.execute("update generation_jobs set status='partial' where id=%s", (metered["job_id"],))
        lifecycle = one(conn, "select generation_lookup_job_by_intent(%s,%s,%s)", (USERS[3], metered_intent, loss_fp))
        assert lifecycle["job_status"] == "partial"
        first = one(conn, "select usage_settle_reservation_item(%s,'s0','succeeded',%s)", (metered["reservation_id"], metered["job_id"]))
        second = one(conn, "select usage_settle_reservation_item(%s,'s0','succeeded',%s)", (metered["reservation_id"], metered["job_id"]))
        assert first["replayed"] is False and second["replayed"] is True
        assert int(one(conn, "select count(*) from usage_events where reservation_id=%s and idempotency_key like 'settle:%%:s0'", (metered["reservation_id"],))) == 1

        # Same key under a different user is isolated.
        cross = plain_call(args.dsn, USERS[1], intent, fp, params)
        assert str(cross["job_id"]) not in job_ids

        with conn.cursor() as cur:
            cur.execute("delete from generation_jobs where vibepin_user_id = any(%s::uuid[])", (USERS,))
            cur.execute("delete from usage_accounts where user_id = any(%s::uuid[])", (USERS,))
            for table, column in [
                ("generation_jobs", "vibepin_user_id"),
                ("usage_accounts", "user_id"),
                ("usage_reservations", "user_id"),
                ("usage_events", "user_id"),
            ]:
                if int(one(conn, f"select count(*) from {table} where {column} = any(%s::uuid[])", (USERS,))) != 0:
                    raise AssertionError(f"synthetic rows remain in {table}")
            cur.execute(ROLLBACK.read_text(encoding="utf-8"))
        applied = False
        assert int(one(conn, "select count(*) from generation_jobs")) == baseline_jobs
        assert int(one(conn, "select count(*) from usage_accounts")) == baseline_accounts
        assert one(conn, "select to_regprocedure('generation_lookup_job_by_intent(uuid,text,text)') is null")
        print(json.dumps({
            "ok": True, "engine": "real-loopback-postgresql", "concurrency": 20,
            "oneJob": True, "atMostOneReservation": True, "conflicts": 7,
            "responseLoss": True, "precommitRollback": True,
            "lifecycleReplay": True, "settleOnce": True, "rollbackReadback": True,
        }))
    finally:
        if applied:
            # Disposable DB only; best-effort schema rollback after a failed assertion.
            try:
                with conn.cursor() as cur:
                    cur.execute(ROLLBACK.read_text(encoding="utf-8"))
            except Exception:
                pass
        conn.close()


if __name__ == "__main__":
    main()
