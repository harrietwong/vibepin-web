#!/usr/bin/env python3
"""Guarded real-Postgres gate for generation-intent v71 on one test Supabase.

This harness owns the complete schema lifecycle: preflight, apply, RPC tests,
synthetic-row cleanup, rollback/readback, and final re-apply. It refuses every
production ref, never prints credentials, and leaves v71 unapplied on any failure.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx


ROOT = Path(__file__).resolve().parents[3]
MIGRATION = ROOT / "backend/db/migrate_v71_generation_intent_idempotency.sql"
ROLLBACK = ROOT / "backend/db/rollback_v71_generation_intent_idempotency.sql"
EXPECTED_REF = "snulmwprsahzqvdbyenc"
FORBIDDEN_REFS = {"jaxteelkecvlozdrdoog"}
USERS = [f"00000000-0000-4000-8000-{n:012d}" for n in range(7101, 7106)]


class GateError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def snapshot_digest(value: dict[str, Any]) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def fingerprint(params: dict[str, object], slots: int) -> str:
    return hashlib.sha256(canonical({"params": params, "slots": slots}).encode()).hexdigest()


def intent_key(label: str) -> str:
    return hashlib.sha256(f"v71-real-pg:{label}".encode()).hexdigest()[:48]


def jwt_ref(token: str) -> str:
    parts = token.split(".")
    if len(parts) != 3:
        return ""
    try:
        import base64

        raw = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(raw.encode()).decode())
        return payload.get("ref", "") if isinstance(payload.get("ref"), str) else ""
    except Exception:
        return ""


class SupabaseGate:
    def __init__(self, ref: str, url: str, service_key: str, anon_key: str, migration_token: str) -> None:
        try:
            parsed = urlsplit(url)
            explicit_port = parsed.port
        except ValueError as exc:
            raise GateError("test Supabase URL is malformed") from exc
        expected_host = f"{ref}.supabase.co"
        if (
            ref != EXPECTED_REF
            or ref in FORBIDDEN_REFS
            or parsed.scheme != "https"
            or parsed.hostname != expected_host
            or parsed.username is not None
            or parsed.password is not None
            or explicit_port not in (None, 443)
            or parsed.path not in ("", "/")
            or bool(parsed.query)
            or bool(parsed.fragment)
        ):
            raise GateError(f"ref guard failed: expected exact test ref {EXPECTED_REF}")
        key_ref = jwt_ref(service_key)
        if key_ref and key_ref != ref:
            raise GateError("service identity belongs to a different project ref")
        if not service_key or not anon_key or not migration_token:
            raise GateError("required test anon/service/migration identity is missing")
        self.ref = ref
        self.url = url.rstrip("/")
        self.service_key = service_key
        self.anon_key = anon_key
        self.migration_token = migration_token
        self.headers = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
        }

    def management_query(self, sql: str, label: str) -> list[dict[str, Any]]:
        response = httpx.post(
            f"https://api.supabase.com/v1/projects/{self.ref}/database/query",
            headers={
                "Authorization": f"Bearer {self.migration_token}",
                "Content-Type": "application/json",
            },
            json={"query": sql},
            timeout=90,
        )
        if response.status_code not in (200, 201):
            raise GateError(f"{label} failed via Management API (HTTP {response.status_code})")
        try:
            body = response.json()
        except Exception as exc:
            raise GateError(f"{label} returned non-JSON success") from exc
        if isinstance(body, list):
            return body
        if isinstance(body, dict) and isinstance(body.get("result"), list):
            return body["result"]
        raise GateError(f"{label} returned an unexpected success shape")

    def rest(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        payload: Any = None,
        prefer: str | None = None,
        timeout: float = 30,
    ) -> httpx.Response:
        headers = dict(self.headers)
        if prefer:
            headers["Prefer"] = prefer
        return httpx.request(
            method,
            f"{self.url}/rest/v1/{path}",
            headers=headers,
            params=params,
            json=payload,
            timeout=timeout,
        )

    def rpc(self, name: str, payload: dict[str, Any], *, expect_error: str | None = None) -> Any:
        response = self.rest("POST", f"rpc/{name}", payload=payload)
        if expect_error:
            if response.status_code < 400:
                raise GateError(f"{name} expected SQLSTATE {expect_error}, got success")
            try:
                code = str(response.json().get("code", ""))
            except Exception:
                code = ""
            if code != expect_error:
                raise GateError(f"{name} expected SQLSTATE {expect_error}, got {code or 'unknown'}")
            return None
        if response.status_code >= 300:
            code = ""
            try:
                code = str(response.json().get("code", ""))
            except Exception:
                pass
            raise GateError(f"{name} failed (HTTP {response.status_code}, SQLSTATE {code or 'unknown'})")
        return response.json()

    def count(self, table: str, **filters: str) -> int:
        params = {"select": "id", "limit": "1", **filters}
        response = self.rest("GET", table, params=params, prefer="count=exact")
        if response.status_code >= 300:
            raise GateError(f"count {table} failed (HTTP {response.status_code})")
        content_range = response.headers.get("content-range", "")
        if "/" not in content_range:
            raise GateError(f"count {table} omitted Content-Range")
        return int(content_range.rsplit("/", 1)[1])


SNAPSHOT_SQL = """
select json_build_object(
  'auth_users_count', (select count(*) from auth.users),
  'auth_users_digest', (select md5(coalesce(string_agg(row_to_json(t)::text, '|' order by id), '')) from auth.users t),
  'generation_jobs_count', (select count(*) from generation_jobs),
  'generation_jobs_digest', (select md5(coalesce(string_agg(
    (to_jsonb(t) - 'generation_intent_key' - 'generation_intent_fingerprint')::text,
    '|' order by id), '')) from generation_jobs t),
  'usage_accounts_count', (select count(*) from usage_accounts),
  'usage_accounts_digest', (select md5(coalesce(string_agg(row_to_json(t)::text, '|' order by id), '')) from usage_accounts t),
  'usage_reservations_count', (select count(*) from usage_reservations),
  'usage_reservations_digest', (select md5(coalesce(string_agg(row_to_json(t)::text, '|' order by id), '')) from usage_reservations t),
  'usage_items_count', (select count(*) from usage_reservation_items),
  'usage_items_digest', (select md5(coalesce(string_agg(row_to_json(t)::text, '|' order by id), '')) from usage_reservation_items t),
  'usage_events_count', (select count(*) from usage_events),
  'usage_events_digest', (select md5(coalesce(string_agg(row_to_json(t)::text, '|' order by id), '')) from usage_events t)
) as snapshot;
"""


PREFLIGHT_SQL = """
select json_build_object(
  'generation_jobs', to_regclass('public.generation_jobs') is not null,
  'usage_accounts', to_regclass('public.usage_accounts') is not null,
  'usage_reservations', to_regclass('public.usage_reservations') is not null,
  'usage_items', to_regclass('public.usage_reservation_items') is not null,
  'usage_events', to_regclass('public.usage_events') is not null,
  'job_columns', (select count(*) = 6 from information_schema.columns
    where table_schema='public' and table_name='generation_jobs'
      and column_name in ('id','vibepin_user_id','status','params','results','usage_reservation_id')),
  'usage_reserve', to_regprocedure('public.usage_reserve(uuid,text,text[],text,text,text,timestamptz,jsonb)') is not null,
  'settle', to_regprocedure('public.usage_settle_reservation_item(uuid,text,text,text,jsonb)') is not null,
  'v71_columns', (select count(*) from information_schema.columns
    where table_schema='public' and table_name='generation_jobs' and column_name like 'generation_intent_%'),
  'v71_lookup', to_regprocedure('public.generation_lookup_job_by_intent(uuid,text,text)') is not null
) as preflight;
"""


READBACK_SQL = """
select json_build_object(
  'columns', (select count(*) from information_schema.columns where table_schema='public'
    and table_name='generation_jobs' and column_name in ('generation_intent_key','generation_intent_fingerprint')),
  'pair_check', exists(select 1 from pg_constraint where conname='generation_jobs_intent_pair_valid'
    and conrelid='public.generation_jobs'::regclass and contype='c'),
  'unique_index', exists(select 1 from pg_indexes where schemaname='public'
    and tablename='generation_jobs' and indexname='generation_jobs_user_intent_unique'
    and indexdef ilike '%unique%' and indexdef ilike '%where (generation_intent_key is not null)%'),
  'lookup_index', exists(select 1 from pg_indexes where schemaname='public'
    and tablename='generation_jobs' and indexname='generation_jobs_intent_lookup'),
  'immutable_trigger', exists(select 1 from pg_trigger where tgrelid='public.generation_jobs'::regclass
    and tgname='generation_jobs_intent_immutable_trigger' and not tgisinternal),
  'lookup_rpc', to_regprocedure('public.generation_lookup_job_by_intent(uuid,text,text)') is not null,
  'plain_rpc', to_regprocedure('public.generation_enqueue_job_idempotent(uuid,text,text,text[],jsonb,boolean)') is not null,
  'metered_rpc', to_regprocedure('public.usage_reserve_generation_job_v2(uuid,text[],text,text,text,jsonb,text,text,timestamptz,jsonb,boolean)') is not null,
  'service_exec', has_function_privilege('service_role', 'public.generation_lookup_job_by_intent(uuid,text,text)', 'execute')
    and has_function_privilege('service_role', 'public.generation_enqueue_job_idempotent(uuid,text,text,text[],jsonb,boolean)', 'execute')
    and has_function_privilege('service_role', 'public.usage_reserve_generation_job_v2(uuid,text[],text,text,text,jsonb,text,text,timestamptz,jsonb,boolean)', 'execute'),
  'anon_blocked', not has_function_privilege('anon', 'public.generation_lookup_job_by_intent(uuid,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.generation_enqueue_job_idempotent(uuid,text,text,text[],jsonb,boolean)', 'execute')
    and not has_function_privilege('anon', 'public.usage_reserve_generation_job_v2(uuid,text[],text,text,text,jsonb,text,text,timestamptz,jsonb,boolean)', 'execute'),
  'authenticated_blocked', not has_function_privilege('authenticated', 'public.generation_lookup_job_by_intent(uuid,text,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.generation_enqueue_job_idempotent(uuid,text,text,text[],jsonb,boolean)', 'execute')
    and not has_function_privilege('authenticated', 'public.usage_reserve_generation_job_v2(uuid,text[],text,text,text,jsonb,text,text,timestamptz,jsonb,boolean)', 'execute'),
  'public_blocked', not exists (
    select 1 from pg_proc p
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    where p.oid in (
      'public.generation_lookup_job_by_intent(uuid,text,text)'::regprocedure,
      'public.generation_enqueue_job_idempotent(uuid,text,text,text[],jsonb,boolean)'::regprocedure,
      'public.usage_reserve_generation_job_v2(uuid,text[],text,text,text,jsonb,text,text,timestamptz,jsonb,boolean)'::regprocedure
    ) and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
  )
) as readback;
"""


RESIDUE_SQL = """
select json_build_object(
  'columns', (select count(*) from information_schema.columns where table_schema='public'
    and table_name='generation_jobs' and column_name like 'generation_intent_%'),
  'constraint', exists(select 1 from pg_constraint where conname='generation_jobs_intent_pair_valid'
    and conrelid='public.generation_jobs'::regclass),
  'indexes', (select count(*) from pg_indexes where schemaname='public' and tablename='generation_jobs'
    and indexname in ('generation_jobs_user_intent_unique','generation_jobs_intent_lookup')),
  'trigger', exists(select 1 from pg_trigger where tgrelid='public.generation_jobs'::regclass
    and tgname='generation_jobs_intent_immutable_trigger' and not tgisinternal),
  'lookup_rpc', to_regprocedure('public.generation_lookup_job_by_intent(uuid,text,text)') is not null,
  'plain_rpc', to_regprocedure('public.generation_enqueue_job_idempotent(uuid,text,text,text[],jsonb,boolean)') is not null,
  'metered_rpc', to_regprocedure('public.usage_reserve_generation_job_v2(uuid,text[],text,text,text,jsonb,text,text,timestamptz,jsonb,boolean)') is not null
) as residue;
"""


def object_row(rows: list[dict[str, Any]], field: str) -> dict[str, Any]:
    if len(rows) != 1 or not isinstance(rows[0].get(field), dict):
        raise GateError(f"query did not return one {field} object")
    return rows[0][field]


def plain_payload(user: str, key: str, fp: str, params: dict[str, object], force: bool = False) -> dict[str, Any]:
    return {
        "p_user_id": user,
        "p_intent_key": key,
        "p_intent_fingerprint": fp,
        "p_slot_keys": ["s0", "s1"],
        "p_params": params,
        "p_force_error": force,
    }


def metered_payload(user: str, key: str, fp: str, params: dict[str, object], force: bool = False) -> dict[str, Any]:
    return {
        "p_user_id": user,
        "p_slot_keys": ["s0", "s1"],
        "p_request_key": key,
        "p_intent_key": key,
        "p_intent_fingerprint": fp,
        "p_params": params,
        "p_operation": "image_generation",
        "p_reference_id": None,
        "p_expires_at": None,
        "p_metadata": {"harness": "v71"},
        "p_force_error": force,
    }


def wait_for_rpc(gate: SupabaseGate) -> None:
    probe_key = intent_key("schema-cache-probe")
    for attempt in range(12):
        response = gate.rest(
            "POST",
            "rpc/generation_lookup_job_by_intent",
            payload={
                "p_user_id": USERS[0],
                "p_intent_key": probe_key,
                "p_intent_fingerprint": "0" * 64,
            },
        )
        if response.status_code < 300:
            return
        try:
            code = str(response.json().get("code", ""))
        except Exception:
            code = ""
        if code not in {"PGRST202", "PGRST203"}:
            raise GateError(f"v71 RPC probe failed (HTTP {response.status_code}, code {code or 'unknown'})")
        time.sleep(min(1 + attempt, 5))
    raise GateError("PostgREST schema cache did not expose v71 RPCs")


def assert_anon_rpc_blocked(gate: SupabaseGate) -> None:
    anon_headers = {
        "apikey": gate.anon_key,
        "Authorization": f"Bearer {gate.anon_key}",
        "Content-Type": "application/json",
    }
    probe_key = intent_key("anon-deny-probe")
    probes = [
        (
            "generation_lookup_job_by_intent",
            {"p_user_id": USERS[0], "p_intent_key": probe_key, "p_intent_fingerprint": "0" * 64},
        ),
        (
            "generation_enqueue_job_idempotent",
            plain_payload(USERS[0], probe_key, "0" * 64, {}),
        ),
        (
            "usage_reserve_generation_job_v2",
            metered_payload(USERS[0], probe_key, "0" * 64, {}),
        ),
    ]
    for name, payload in probes:
        response = httpx.post(
            f"{gate.url}/rest/v1/rpc/{name}",
            headers=anon_headers,
            json=payload,
            timeout=30,
        )
        if response.status_code < 400:
            raise GateError(f"anon role unexpectedly executed {name}")


def seed_accounts(gate: SupabaseGate) -> None:
    now = "2026-08-31T00:00:00+00:00"
    end = "2026-09-30T00:00:00+00:00"
    rows = [
        {
            "user_id": user,
            "plan_key": f"itest-v71-{user[-4:]}",
            "period_start": now,
            "period_end": end,
            "period_anchor": now,
            "ai_images_limit": 1000,
            "bonus_images_balance": 0,
        }
        for user in USERS
    ]
    response = gate.rest("POST", "usage_accounts", payload=rows, prefer="return=representation")
    if response.status_code >= 300:
        raise GateError(f"synthetic account insert failed (HTTP {response.status_code})")
    if len(response.json()) != len(rows):
        raise GateError("synthetic account insert returned the wrong row count")


def cleanup(gate: SupabaseGate) -> None:
    user_filter = f"in.({','.join(USERS)})"
    response = gate.rest("DELETE", "generation_jobs", params={"vibepin_user_id": user_filter})
    if response.status_code >= 300:
        raise GateError(f"synthetic generation_jobs cleanup failed (HTTP {response.status_code})")
    response = gate.rest("DELETE", "usage_accounts", params={"user_id": user_filter})
    if response.status_code >= 300:
        raise GateError(f"synthetic usage_accounts cleanup failed (HTTP {response.status_code})")
    if gate.count("generation_jobs", vibepin_user_id=user_filter) != 0:
        raise GateError("synthetic generation_jobs remain after cleanup")
    if gate.count("usage_accounts", user_id=user_filter) != 0:
        raise GateError("synthetic usage_accounts remain after cleanup")


def run_contract(gate: SupabaseGate) -> dict[str, Any]:
    for user in USERS:
        if gate.count("generation_jobs", vibepin_user_id=f"eq.{user}") != 0:
            raise GateError(f"synthetic user {user} unexpectedly pre-existed in generation_jobs")
        if gate.count("usage_accounts", user_id=f"eq.{user}") != 0:
            raise GateError(f"synthetic user {user} unexpectedly pre-existed in usage_accounts")

    seed_accounts(gate)
    params: dict[str, object] = {
        "count": 2,
        "prompt": "v71 digest-only contract",
        "product_images": ["https://example.test/product.png"],
        "style_ref": "https://example.test/reference.png",
        "model_key": "gemini_image",
        "format": "vertical 2:3",
        "retryOfOutputId": None,
    }
    fp = fingerprint(params, 2)

    mixed_key = intent_key("20-way-mixed")
    calls: list[tuple[str, dict[str, Any]]] = []
    for index in range(20):
        if index % 3 == 0:
            calls.append(("generation_enqueue_job_idempotent", plain_payload(USERS[0], mixed_key, fp, params)))
        else:
            calls.append(("usage_reserve_generation_job_v2", metered_payload(USERS[0], mixed_key, fp, params)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
        results = list(pool.map(lambda item: gate.rpc(item[0], item[1]), calls))
    job_ids = {str(result["job_id"]) for result in results}
    if len(job_ids) != 1:
        raise GateError(f"20-way mixed modes produced {len(job_ids)} jobs")
    if gate.count("generation_jobs", vibepin_user_id=f"eq.{USERS[0]}", generation_intent_key=f"eq.{mixed_key}") != 1:
        raise GateError("20-way mixed modes did not persist exactly one job")
    if gate.count("usage_reservations", user_id=f"eq.{USERS[0]}", request_key=f"eq.{mixed_key}") > 1:
        raise GateError("20-way mixed modes persisted more than one reservation")

    transition_receipts: dict[str, str] = {}
    for label, first, second in [
        ("off_to_shadow", "plain", "metered"),
        ("shadow_to_off", "metered", "plain"),
        ("shadow_to_enforce", "metered", "metered"),
    ]:
        key = intent_key(label)
        first_result = gate.rpc(
            "generation_enqueue_job_idempotent" if first == "plain" else "usage_reserve_generation_job_v2",
            plain_payload(USERS[1], key, fp, params) if first == "plain" else metered_payload(USERS[1], key, fp, params),
        )
        second_result = gate.rpc(
            "generation_enqueue_job_idempotent" if second == "plain" else "usage_reserve_generation_job_v2",
            plain_payload(USERS[1], key, fp, params) if second == "plain" else metered_payload(USERS[1], key, fp, params),
        )
        if first_result["job_id"] != second_result["job_id"] or second_result.get("replayed") is not True:
            raise GateError(f"mode transition {label} did not replay the original job")
        if gate.count("generation_jobs", vibepin_user_id=f"eq.{USERS[1]}", generation_intent_key=f"eq.{key}") != 1:
            raise GateError(f"mode transition {label} persisted duplicate jobs")
        transition_receipts[label] = "one-job"

    loss_key = intent_key("response-loss")
    gate.rpc("usage_reserve_generation_job_v2", metered_payload(USERS[2], loss_key, fp, params))
    recovered = gate.rpc("generation_enqueue_job_idempotent", plain_payload(USERS[2], loss_key, fp, params))
    if recovered.get("replayed") is not True:
        raise GateError("commit-response-loss replay did not return the original job")

    for label, rpc_name, payload in [
        ("plain", "generation_enqueue_job_idempotent", plain_payload(USERS[2], intent_key("precommit-plain"), fp, params, True)),
        ("metered", "usage_reserve_generation_job_v2", metered_payload(USERS[2], intent_key("precommit-metered"), fp, params, True)),
    ]:
        gate.rpc(rpc_name, payload, expect_error="P0001")
        key = payload["p_intent_key"]
        if gate.count("generation_jobs", generation_intent_key=f"eq.{key}") != 0:
            raise GateError(f"{label} precommit error left a generation job")
        if gate.count("usage_reservations", user_id=f"eq.{USERS[2]}", request_key=f"eq.{key}") != 0:
            raise GateError(f"{label} precommit error left a reservation")

    conflict_key = intent_key("conflicts")
    gate.rpc("generation_enqueue_job_idempotent", plain_payload(USERS[3], conflict_key, fp, params))
    conflicts = [
        ("count", 3),
        ("prompt", "changed"),
        ("product_images", ["https://example.test/other-product.png"]),
        ("style_ref", "https://example.test/other-reference.png"),
        ("model_key", "gpt_image"),
        ("format", "square 1:1"),
        ("retryOfOutputId", "different-output"),
    ]
    for field, value in conflicts:
        changed = {**params, field: value}
        changed_fp = fingerprint(changed, int(changed["count"]))
        gate.rpc(
            "generation_lookup_job_by_intent",
            {
                "p_user_id": USERS[3],
                "p_intent_key": conflict_key,
                "p_intent_fingerprint": changed_fp,
            },
            expect_error="23505",
        )
        if gate.count("generation_jobs", vibepin_user_id=f"eq.{USERS[3]}", generation_intent_key=f"eq.{conflict_key}") != 1:
            raise GateError(f"conflict {field} changed durable state")

    immutable = gate.rest(
        "PATCH",
        "generation_jobs",
        params={"vibepin_user_id": f"eq.{USERS[3]}", "generation_intent_key": f"eq.{conflict_key}"},
        payload={"generation_intent_fingerprint": "f" * 64},
        prefer="return=representation",
    )
    if immutable.status_code < 400:
        raise GateError("immutable trigger allowed a fingerprint update")
    try:
        immutable_code = str(immutable.json().get("code", ""))
    except Exception:
        immutable_code = ""
    if immutable_code != "23514":
        raise GateError(f"immutable trigger returned {immutable_code or 'unknown'}, expected 23514")

    lifecycle_key = intent_key("lifecycle")
    lifecycle = gate.rpc("generation_enqueue_job_idempotent", plain_payload(USERS[4], lifecycle_key, fp, params))
    lifecycle_job = str(lifecycle["job_id"])
    for state in ["queued", "running", "done", "partial", "failed"]:
        if state != "queued":
            response = gate.rest(
                "PATCH",
                "generation_jobs",
                params={"id": f"eq.{lifecycle_job}"},
                payload={"status": state},
                prefer="return=representation",
            )
            if response.status_code >= 300:
                raise GateError(f"lifecycle transition to {state} failed")
        replay = gate.rpc(
            "generation_lookup_job_by_intent",
            {"p_user_id": USERS[4], "p_intent_key": lifecycle_key, "p_intent_fingerprint": fp},
        )
        if replay.get("job_status") != state or replay.get("replayed") is not True:
            raise GateError(f"lifecycle replay did not preserve {state}")

    settle_key = intent_key("settle-once")
    settle_job = gate.rpc("usage_reserve_generation_job_v2", metered_payload(USERS[4], settle_key, fp, params))
    reservation_id = settle_job.get("reservation_id")
    if not reservation_id:
        raise GateError("fresh metered job did not create a reservation")
    events_before = gate.count("usage_events", reservation_id=f"eq.{reservation_id}")
    first = gate.rpc(
        "usage_settle_reservation_item",
        {
            "p_reservation_id": reservation_id,
            "p_slot_key": "s0",
            "p_outcome": "succeeded",
            "p_reference_id": str(settle_job["job_id"]),
            "p_metadata": {"harness": "v71"},
        },
    )
    events_after_first = gate.count("usage_events", reservation_id=f"eq.{reservation_id}")
    second = gate.rpc(
        "usage_settle_reservation_item",
        {
            "p_reservation_id": reservation_id,
            "p_slot_key": "s0",
            "p_outcome": "succeeded",
            "p_reference_id": str(settle_job["job_id"]),
            "p_metadata": {"harness": "v71"},
        },
    )
    events_after_second = gate.count("usage_events", reservation_id=f"eq.{reservation_id}")
    if first.get("replayed") is not False or second.get("replayed") is not True:
        raise GateError("repeated settlement replay contract failed")
    if events_after_first != events_before + 1 or events_after_second != events_after_first:
        raise GateError("repeated settlement created more than one durable event")

    cross = gate.rpc("generation_enqueue_job_idempotent", plain_payload(USERS[4], mixed_key, fp, params))
    if str(cross["job_id"]) in job_ids:
        raise GateError("same intent key collided across users")

    legacy_response = gate.rest(
        "POST",
        "generation_jobs",
        payload={
            "vibepin_user_id": USERS[2],
            "status": "queued",
            "params": {"legacy": True},
            "results": [],
        },
        prefer="return=representation",
    )
    if legacy_response.status_code >= 300 or len(legacy_response.json()) != 1:
        raise GateError("legacy both-null generation job was not accepted")

    return {
        "concurrency": 20,
        "mixedModes": ["off", "shadow", "enforce"],
        "oneJob": True,
        "atMostOneReservation": True,
        "modeTransitions": transition_receipts,
        "responseLoss": True,
        "precommitRollback": ["plain", "metered"],
        "conflicts": [name for name, _ in conflicts],
        "immutable": True,
        "lifecycle": ["queued", "running", "done", "partial", "failed"],
        "crossUser": True,
        "legacyNull": True,
        "settleOnce": True,
        "syntheticUsers": USERS,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-ref", required=True)
    parser.add_argument("--expected-migration-sha", required=True)
    parser.add_argument("--expected-rollback-sha", required=True)
    parser.add_argument("--confirm", required=True)
    parser.add_argument("--preflight-only", action="store_true")
    parser.add_argument("--audit-only", action="store_true")
    parser.add_argument("--recover-only", action="store_true")
    parser.add_argument("--expected-baseline-digest")
    args = parser.parse_args()

    migration_sha = sha256(MIGRATION)
    rollback_sha = sha256(ROLLBACK)
    if args.expected_migration_sha != migration_sha or args.expected_rollback_sha != rollback_sha:
        raise GateError("canonical migration/rollback SHA does not match the operator-bound SHA")
    expected_confirm = f"APPLY-TEST-V71:{args.project_ref}:{migration_sha}:{rollback_sha}"
    if args.confirm != expected_confirm:
        raise GateError("exact migration+rollback confirmation token mismatch")

    gate = SupabaseGate(
        args.project_ref,
        os.environ.get("TEST_SUPABASE_URL", ""),
        os.environ.get("TEST_SUPABASE_SERVICE_ROLE_KEY", ""),
        os.environ.get("TEST_SUPABASE_ANON_KEY", ""),
        os.environ.get("SUPABASE_MIGRATION_TOKEN", ""),
    )

    # Identity proof is read-only and deliberately reports no credential material.
    admin = httpx.get(
        f"{gate.url}/auth/v1/admin/users",
        params={"page": "1", "per_page": "1"},
        headers=gate.headers,
        timeout=30,
    )
    if admin.status_code != 200:
        raise GateError(f"service identity probe failed (HTTP {admin.status_code})")

    preflight = object_row(gate.management_query(PREFLIGHT_SQL, "v51/v55 preflight"), "preflight")
    required = [
        "generation_jobs", "usage_accounts", "usage_reservations", "usage_items",
        "usage_events", "job_columns", "usage_reserve", "settle",
    ]
    if not all(preflight.get(name) is True for name in required):
        raise GateError(f"v51/v55 prerequisite failed: {[name for name in required if preflight.get(name) is not True]}")
    before = object_row(gate.management_query(SNAPSHOT_SQL, "before snapshot"), "snapshot")
    if args.audit_only:
        user_filter = f"in.({','.join(USERS)})"
        print(json.dumps({
            "ok": True,
            "auditOnly": True,
            "projectRef": gate.ref,
            "preflight": preflight,
            "residue": object_row(gate.management_query(RESIDUE_SQL, "audit residue"), "residue"),
            "syntheticCounts": {
                "generationJobs": gate.count("generation_jobs", vibepin_user_id=user_filter),
                "usageAccounts": gate.count("usage_accounts", user_id=user_filter),
                "usageReservations": gate.count("usage_reservations", user_id=user_filter),
                "usageEvents": gate.count("usage_events", user_id=user_filter),
            },
            "snapshot": before,
        }, sort_keys=True))
        return 0
    if args.recover_only:
        expected_digest = (args.expected_baseline_digest or "").strip()
        if not re.fullmatch(r"[0-9a-f]{64}", expected_digest):
            raise GateError("recover-only requires an exact 64hex baseline snapshot digest")
        recovery_errors: list[str] = []
        try:
            cleanup(gate)
        except Exception as exc:
            recovery_errors.append(f"cleanup: {exc}")
        try:
            gate.management_query(ROLLBACK.read_text(encoding="utf-8"), "recovery rollback v71")
        except Exception as exc:
            recovery_errors.append(f"rollback: {exc}")
        try:
            residue = object_row(gate.management_query(RESIDUE_SQL, "recovery residue readback"), "residue")
            expected_zero = {
                "columns": 0, "constraint": False, "indexes": 0, "trigger": False,
                "lookup_rpc": False, "plain_rpc": False, "metered_rpc": False,
            }
            if residue != expected_zero:
                recovery_errors.append(f"residue: {residue}")
        except Exception as exc:
            recovery_errors.append(f"residue-readback: {exc}")
            residue = None
        try:
            after = object_row(gate.management_query(SNAPSHOT_SQL, "recovery final snapshot"), "snapshot")
            actual_digest = snapshot_digest(after)
            if actual_digest != expected_digest:
                recovery_errors.append(
                    f"baseline digest mismatch: expected {expected_digest}, got {actual_digest}"
                )
        except Exception as exc:
            recovery_errors.append(f"snapshot-readback: {exc}")
            after = None
            actual_digest = ""
        if recovery_errors:
            raise GateError(f"recovery proof failed: {'; '.join(recovery_errors)}")
        print(json.dumps({
            "ok": True,
            "recoverOnly": True,
            "projectRef": gate.ref,
            "rollbackSha256": rollback_sha,
            "zeroResidue": True,
            "baselineDigest": actual_digest,
            "snapshot": after,
        }, sort_keys=True))
        return 0
    if preflight.get("v71_columns") != 0 or preflight.get("v71_lookup") is not False:
        raise GateError("test project already has v71 residue; refusing to guess ownership")
    if args.preflight_only:
        print(json.dumps({
            "ok": True,
            "preflightOnly": True,
            "projectRef": gate.ref,
            "serviceIdentity": "verified-without-secret-output",
            "migrationSha256": migration_sha,
            "rollbackSha256": rollback_sha,
            "preflight": preflight,
            "beforeSnapshot": before,
        }, sort_keys=True))
        return 0
    may_be_applied = False
    synthetic_seeded = False
    try:
        # Set BEFORE the network mutation. A commit followed by response loss is
        # indistinguishable from a failed request and must enter rollback recovery.
        may_be_applied = True
        gate.management_query(MIGRATION.read_text(encoding="utf-8"), "apply v71")
        readback = object_row(gate.management_query(READBACK_SQL, "v71 readback"), "readback")
        if readback.get("columns") != 2 or not all(
            readback.get(name) is True
            for name in [
                "pair_check", "unique_index", "lookup_index", "immutable_trigger",
                "lookup_rpc", "plain_rpc", "metered_rpc", "service_exec",
                "anon_blocked", "authenticated_blocked", "public_blocked",
            ]
        ):
            raise GateError(f"v71 readback failed: {readback}")
        wait_for_rpc(gate)
        assert_anon_rpc_blocked(gate)
        synthetic_seeded = True
        contract = run_contract(gate)
        cleanup(gate)
        synthetic_seeded = False

        after_cleanup = object_row(gate.management_query(SNAPSHOT_SQL, "after cleanup snapshot"), "snapshot")
        if before != after_cleanup:
            raise GateError("unrelated/provider/user-visible row snapshot changed after exact synthetic cleanup")

        gate.management_query(ROLLBACK.read_text(encoding="utf-8"), "rollback v71")
        residue = object_row(gate.management_query(RESIDUE_SQL, "rollback residue readback"), "residue")
        if residue != {
            "columns": 0,
            "constraint": False,
            "indexes": 0,
            "trigger": False,
            "lookup_rpc": False,
            "plain_rpc": False,
            "metered_rpc": False,
        }:
            raise GateError(f"rollback left v71 residue: {residue}")
        may_be_applied = False
        after_rollback = object_row(gate.management_query(SNAPSHOT_SQL, "post-rollback snapshot"), "snapshot")
        if before != after_rollback:
            raise GateError("legacy/unrelated data changed across rollback")

        may_be_applied = True
        gate.management_query(MIGRATION.read_text(encoding="utf-8"), "final re-apply v71")
        final_readback = object_row(gate.management_query(READBACK_SQL, "final v71 readback"), "readback")
        if final_readback != readback:
            raise GateError("final re-apply readback differs from the tested v71 surface")
        final_snapshot = object_row(gate.management_query(SNAPSHOT_SQL, "final data snapshot"), "snapshot")
        if before != final_snapshot:
            raise GateError("final v71 re-apply changed legacy/unrelated data")

        print(json.dumps({
            "ok": True,
            "projectRef": gate.ref,
            "serviceIdentity": "verified-without-secret-output",
            "migrationSha256": migration_sha,
            "rollbackSha256": rollback_sha,
            "preflight": preflight,
            "beforeSnapshot": before,
            "contract": contract,
            "rollbackZeroResidue": True,
            "legacyDataUnchanged": True,
            "finalReapplied": True,
            "finalReadback": final_readback,
        }, sort_keys=True))
        return 0
    except Exception as original:
        recovery_errors: list[str] = []
        if synthetic_seeded or may_be_applied:
            try:
                cleanup(gate)
            except Exception as exc:
                recovery_errors.append(f"cleanup: {exc}")
        if may_be_applied:
            try:
                gate.management_query(ROLLBACK.read_text(encoding="utf-8"), "failure rollback v71")
            except Exception as exc:
                recovery_errors.append(f"rollback: {exc}")
            try:
                residue = object_row(gate.management_query(RESIDUE_SQL, "failure residue readback"), "residue")
                expected_zero = {
                    "columns": 0, "constraint": False, "indexes": 0, "trigger": False,
                    "lookup_rpc": False, "plain_rpc": False, "metered_rpc": False,
                }
                if residue != expected_zero:
                    recovery_errors.append(f"residue: {residue}")
            except Exception as exc:
                recovery_errors.append(f"residue-readback: {exc}")
        if recovery_errors:
            raise GateError(
                f"primary failure: {original}; recovery proof failed: {'; '.join(recovery_errors)}"
            ) from original
        raise


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except GateError as exc:
        print(f"V71_REAL_PG_GATE_FAILED: {exc}", file=sys.stderr)
        raise SystemExit(1)
