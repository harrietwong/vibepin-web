#!/usr/bin/env python3
"""Real-Postgres gate for v73 publish retry lineage.

Full mode is test-only and reversible: verify v72, snapshot existing rows,
apply v73, exercise retry locking through PostgREST, clean exact synthetic
rows, roll back with zero residue, then re-apply the tested migration.
"""
from __future__ import annotations

import argparse
import base64
import concurrent.futures
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[3]
MIGRATION = ROOT / "backend/db/migrate_v73_publish_intent_retry_lineage.sql"
ROLLBACK = ROOT / "backend/db/rollback_v73_publish_intent_retry_lineage.sql"
EXPECTED_REF = "snulmwprsahzqvdbyenc"
FORBIDDEN_REFS = {"jaxteelkecvlozdrdoog"}
USERS = [f"00000000-0000-4000-8000-{n:012d}" for n in range(7301, 7321)]


class GateError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fp(label: str) -> str:
    return hashlib.sha256(f"v73-real-pg:{label}".encode()).hexdigest()


def intent(label: str) -> str:
    return f"publish:v73-harness:{label}:{fp(label)[:16]}"


def jwt_ref(token: str) -> str:
    parts = token.split(".")
    if len(parts) != 3:
        return ""
    try:
        raw = parts[1] + "=" * (-len(parts[1]) % 4)
        body = json.loads(base64.urlsafe_b64decode(raw.encode()).decode())
        return body.get("ref", "") if isinstance(body.get("ref"), str) else ""
    except Exception:
        return ""


def load_env() -> None:
    for path in (ROOT / "web/.env.test.local", ROOT / "backend/.env.migration"):
        if path.exists():
            for key, value in dotenv_values(path).items():
                if value and key not in os.environ:
                    os.environ[key] = value


def env(*names: str) -> str:
    return next((os.environ[name] for name in names if os.environ.get(name)), "")


def response_code(response: httpx.Response) -> str:
    try:
        body = response.json()
        return str(body.get("code", "")) if isinstance(body, dict) else ""
    except Exception:
        return ""


class Gate:
    def __init__(self, ref: str, url: str, service: str, anon: str, token: str) -> None:
        parsed = urlsplit(url)
        if (
            ref != EXPECTED_REF or ref in FORBIDDEN_REFS or parsed.scheme != "https"
            or parsed.hostname != f"{ref}.supabase.co" or parsed.username or parsed.password
            or parsed.port not in (None, 443) or parsed.path not in ("", "/")
            or parsed.query or parsed.fragment
        ):
            raise GateError(f"ref guard failed: expected exact test ref {EXPECTED_REF}")
        if not service or not anon or not token:
            raise GateError("required test identities are missing")
        if any(value and value != ref for value in (jwt_ref(service), jwt_ref(anon))):
            raise GateError("Supabase identity belongs to another project")
        self.ref, self.url = ref, url.rstrip("/")
        self.service, self.anon, self.token = service, anon, token
        self.management = httpx.Client(
            base_url=f"https://api.supabase.com/v1/projects/{ref}",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            timeout=90,
        )
        self.service_client = httpx.Client(
            base_url=f"{self.url}/rest/v1/",
            headers={"apikey": service, "Authorization": f"Bearer {service}",
                     "Content-Type": "application/json"},
            timeout=60,
        )
        self.anon_client = httpx.Client(
            base_url=f"{self.url}/rest/v1/",
            headers={"apikey": anon, "Authorization": f"Bearer {anon}",
                     "Content-Type": "application/json"},
            timeout=60,
        )

    def sql(self, query: str, label: str) -> list[dict[str, Any]]:
        response = self.management.post("/database/query", json={"query": query})
        if response.status_code not in (200, 201):
            raise GateError(f"{label} failed via Management API (HTTP {response.status_code})")
        body = response.json()
        if isinstance(body, list):
            return body
        if isinstance(body, dict) and isinstance(body.get("result"), list):
            return body["result"]
        raise GateError(f"{label} returned an unexpected shape")

    def rest(self, method: str, path: str, *, payload: Any = None,
             params: dict[str, str] | None = None, prefer: str | None = None,
             anon: bool = False) -> httpx.Response:
        headers: dict[str, str] = {}
        if prefer:
            headers["Prefer"] = prefer
        client = self.anon_client if anon else self.service_client
        return client.request(method, path, headers=headers, json=payload, params=params)

    def rpc_response(self, name: str, payload: dict[str, Any], *, anon: bool = False) -> httpx.Response:
        return self.rest("POST", f"rpc/{name}", payload=payload, anon=anon)

    def rpc(self, name: str, payload: dict[str, Any], *, error: str | None = None) -> Any:
        response = self.rpc_response(name, payload)
        code = response_code(response)
        if error:
            if response.status_code < 400 or code != error:
                raise GateError(f"{name} expected {error}, got {code or response.status_code}")
            return None
        if response.status_code >= 300:
            raise GateError(f"{name} failed (HTTP {response.status_code}, SQLSTATE {code or 'unknown'})")
        return response.json()

    def count(self, table: str, **filters: str) -> int:
        response = self.rest("GET", table, params={"select": "id", "limit": "1", **filters},
                             prefer="count=exact")
        if response.status_code >= 300 or "/" not in response.headers.get("content-range", ""):
            raise GateError(f"count {table} failed")
        return int(response.headers["content-range"].rsplit("/", 1)[1])


def one(rows: list[dict[str, Any]], field: str) -> dict[str, Any]:
    if len(rows) != 1 or not isinstance(rows[0].get(field), dict):
        raise GateError(f"query did not return one {field} object")
    return rows[0][field]


SNAPSHOT_SQL = """
select json_build_object(
 'intents_count',(select count(*) from publish_intents),
 'intents_digest',(select md5(coalesce(string_agg((to_jsonb(t)-'prior_intent_id')::text,'|' order by id),'')) from publish_intents t),
 'destinations_count',(select count(*) from publish_intent_destinations),
 'destinations_digest',(select md5(coalesce(string_agg((to_jsonb(t)-'retry_of_destination_id')::text,'|' order by id),'')) from publish_intent_destinations t)
) snapshot;
"""

PREFLIGHT_SQL = """
select json_build_object(
 'intents',to_regclass('public.publish_intents') is not null,
 'destinations',to_regclass('public.publish_intent_destinations') is not null,
 'claim_one',to_regprocedure('public.publish_intent_claim_destination(uuid,text,text,text,text,timestamptz,jsonb,jsonb,text,text,text,text)') is not null,
 'claim_many',to_regprocedure('public.publish_intent_claim_destinations(uuid,text,text,text,text,timestamptz,jsonb,jsonb,jsonb)') is not null,
 'settle',to_regprocedure('public.publish_intent_settle_destination(uuid,text,text,uuid,text,boolean,text,text,text,integer,jsonb)') is not null,
 'prior_column',exists(select 1 from information_schema.columns where table_schema='public' and table_name='publish_intents' and column_name='prior_intent_id'),
 'retry_column',exists(select 1 from information_schema.columns where table_schema='public' and table_name='publish_intent_destinations' and column_name='retry_of_destination_id'),
 'reserve',to_regprocedure('public.publish_intent_reserve_retry_destinations(uuid,text,text,text,text,text,timestamptz,jsonb,jsonb,jsonb)') is not null,
 'activate',to_regprocedure('public.publish_intent_activate_retry_destinations(uuid,text,text,jsonb)') is not null
) preflight;
"""

READBACK_SQL = """
select json_build_object(
 'columns',(select count(*) from information_schema.columns where table_schema='public' and ((table_name='publish_intents' and column_name='prior_intent_id') or (table_name='publish_intent_destinations' and column_name='retry_of_destination_id'))),
 'intent_fk',exists(select 1 from pg_constraint where conname='publish_intents_prior_intent_fk' and conrelid='public.publish_intents'::regclass and contype='f' and confdeltype='r'),
 'destination_fk',exists(select 1 from pg_constraint where conname='publish_intent_destinations_retry_source_fk' and conrelid='public.publish_intent_destinations'::regclass and contype='f' and confdeltype='r'),
 'parent_index',exists(select 1 from pg_indexes where schemaname='public' and indexname='publish_intents_prior_intent_idx'),
 'source_unique',exists(select 1 from pg_indexes where schemaname='public' and indexname='publish_intent_destinations_retry_source_unique' and indexdef ilike '%unique%'),
 'legacy_trigger',exists(select 1 from pg_trigger where tgrelid='public.publish_intent_destinations'::regclass and tgname='publish_intent_reject_legacy_retry_trigger' and not tgisinternal),
 'claim_builtin_uuid',(select pg_get_functiondef('public.publish_intent_claim_destination(uuid,text,text,text,text,timestamptz,jsonb,jsonb,text,text,text,text)'::regprocedure) ilike '%gen_random_uuid()%' and pg_get_functiondef('public.publish_intent_claim_destination(uuid,text,text,text,text,timestamptz,jsonb,jsonb,text,text,text,text)'::regprocedure) not ilike '%uuid_generate_v4()%'),
 'reserve',to_regprocedure('public.publish_intent_reserve_retry_destinations(uuid,text,text,text,text,text,timestamptz,jsonb,jsonb,jsonb)') is not null,
 'activate',to_regprocedure('public.publish_intent_activate_retry_destinations(uuid,text,text,jsonb)') is not null,
 'service_exec',has_function_privilege('service_role','public.publish_intent_reserve_retry_destinations(uuid,text,text,text,text,text,timestamptz,jsonb,jsonb,jsonb)','execute') and has_function_privilege('service_role','public.publish_intent_activate_retry_destinations(uuid,text,text,jsonb)','execute'),
 'anon_blocked',not has_function_privilege('anon','public.publish_intent_reserve_retry_destinations(uuid,text,text,text,text,text,timestamptz,jsonb,jsonb,jsonb)','execute') and not has_function_privilege('anon','public.publish_intent_activate_retry_destinations(uuid,text,text,jsonb)','execute'),
 'authenticated_blocked',not has_function_privilege('authenticated','public.publish_intent_reserve_retry_destinations(uuid,text,text,text,text,text,timestamptz,jsonb,jsonb,jsonb)','execute') and not has_function_privilege('authenticated','public.publish_intent_activate_retry_destinations(uuid,text,text,jsonb)','execute')
) readback;
"""

RESIDUE_SQL = """
select json_build_object(
 'columns',(select count(*) from information_schema.columns where table_schema='public' and ((table_name='publish_intents' and column_name='prior_intent_id') or (table_name='publish_intent_destinations' and column_name='retry_of_destination_id'))),
 'intent_fk',exists(select 1 from pg_constraint where conname='publish_intents_prior_intent_fk' and conrelid='public.publish_intents'::regclass),
 'destination_fk',exists(select 1 from pg_constraint where conname='publish_intent_destinations_retry_source_fk' and conrelid='public.publish_intent_destinations'::regclass),
 'indexes',(select count(*) from pg_indexes where schemaname='public' and indexname in ('publish_intents_prior_intent_idx','publish_intent_destinations_retry_source_unique')),
 'trigger',exists(select 1 from pg_trigger where tgrelid='public.publish_intent_destinations'::regclass and tgname='publish_intent_reject_legacy_retry_trigger' and not tgisinternal),
 'reserve',to_regprocedure('public.publish_intent_reserve_retry_destinations(uuid,text,text,text,text,text,timestamptz,jsonb,jsonb,jsonb)') is not null,
 'activate',to_regprocedure('public.publish_intent_activate_retry_destinations(uuid,text,text,jsonb)') is not null
) residue;
"""


def items(label: str) -> list[dict[str, str]]:
    return [
        {"id": f"v73-harness:{label}:pin", "provider": "pinterest", "socialConnectionId": f"v73-{label}-pin", "boardId": f"v73-{label}-board"},
        {"id": f"v73-harness:{label}:ig", "provider": "instagram", "socialConnectionId": f"v73-{label}-ig"},
        {"id": f"v73-harness:{label}:fb", "provider": "facebook", "socialConnectionId": f"v73-{label}-fb"},
    ]


def receipt(label: str, current: str, prior: str | None, destinations: list[dict[str, str]]) -> dict[str, Any]:
    return {"intentId": current, "priorIntentId": prior, "fingerprint": fp(label),
            "onlyPending": prior is not None,
            "dispatchDestinationIds": [row["id"] for row in destinations], "harness": "v73"}


def insert(gate: Gate, table: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    response = gate.rest("POST", table, payload=rows, prefer="return=representation")
    if response.status_code >= 300:
        raise GateError(f"insert {table} failed (HTTP {response.status_code}, {response_code(response) or 'unknown'})")
    body = response.json()
    if not isinstance(body, list) or len(body) != len(rows):
        raise GateError(f"insert {table} returned wrong row count")
    return body


def seed(gate: Gate, user: str, label: str) -> tuple[str, list[dict[str, str]]]:
    parent, destinations = intent(f"{label}:parent"), items(label)
    parent_row = insert(gate, "publish_intents", [{
        "user_id": user, "intent_id": parent, "fingerprint": fp(f"{label}:parent"),
        "draft_id": f"v73-harness:{label}:draft", "content_id": f"v73-harness:{label}:content",
        "confirmed_at": "2026-09-02T12:00:00+00:00", "mode": {"kind": "now"},
        "receipt": receipt(f"{label}:parent", parent, None, destinations),
    }])[0]
    insert(gate, "publish_intent_destinations", [{
        "publish_intent_id": parent_row["id"], "destination_id": row["id"],
        "provider": row["provider"], "social_connection_id": row["socialConnectionId"],
        "subdestination_id": row.get("boardId"), "status": "failed", "claim_token": None,
        "attempt": 1, "retry_allowed": True, "evidence": {"harness": "v73"},
        "finished_at": "2026-09-02T12:01:00+00:00",
    } for row in destinations])
    return parent, destinations


def reserve(label: str, user: str, parent: str, child: str,
            destinations: list[dict[str, str]]) -> dict[str, Any]:
    root_label = label.split(":")[0]
    return {
        "p_user_id": user, "p_prior_intent_id": parent, "p_intent_id": child,
        "p_fingerprint": fp(label), "p_draft_id": f"v73-harness:{root_label}:draft",
        "p_content_id": f"v73-harness:{root_label}:content",
        "p_confirmed_at": "2026-09-02T12:02:00+00:00", "p_mode": {"kind": "now"},
        "p_receipt": receipt(label, child, parent, destinations), "p_destinations": destinations,
    }


def activate(user: str, child: str, label: str,
             destinations: list[dict[str, str]]) -> dict[str, Any]:
    return {"p_user_id": user, "p_intent_id": child, "p_fingerprint": fp(label),
            "p_destinations": destinations}


def rows(value: Any, count: int, claimed: bool | None = None) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) != count:
        raise GateError(f"RPC returned wrong row count (expected {count})")
    if claimed is not None and any(row.get("claimed") is not claimed for row in value):
        raise GateError(f"RPC claimed state was not {claimed}")
    return value


def child_count(gate: Gate, user: str, child: str) -> int:
    return gate.count("publish_intents", user_id=f"eq.{user}", intent_id=f"eq.{child}")


def destination_rows(gate: Gate, user: str, action: str) -> list[dict[str, Any]]:
    response = gate.rest("GET", "publish_intents", params={
        "select": "id,publish_intent_destinations(*)", "user_id": f"eq.{user}",
        "intent_id": f"eq.{action}",
    })
    if response.status_code >= 300:
        raise GateError("destination readback failed")
    body = response.json()
    return body[0].get("publish_intent_destinations", []) if len(body) == 1 else []


def run_contract(gate: Gate) -> dict[str, Any]:
    for user in USERS:
        if gate.count("publish_intents", user_id=f"eq.{user}"):
            raise GateError(f"synthetic user {user} already exists")

    # A subset cannot consume a signed all-destination retry.
    parent, destinations = seed(gate, USERS[0], "partial")
    child, label = intent("partial:child"), "partial:child"
    payload = reserve(label, USERS[0], parent, child, destinations)
    payload["p_destinations"] = destinations[:1]
    gate.rpc("publish_intent_reserve_retry_destinations", payload, error="P0001")
    if child_count(gate, USERS[0], child):
        raise GateError("partial dispatch left a child intent")
    if any(row.get("retry_allowed") is not True for row in destination_rows(gate, USERS[0], parent)):
        raise GateError("partial dispatch consumed parent retry entitlement")

    # Full reserve, then Pinterest-first and Social-first endpoint activation.
    for index, label in enumerate(("pin-first", "social-first"), start=1):
        parent, destinations = seed(gate, USERS[index], label)
        child, child_label = intent(f"{label}:child"), f"{label}:child"
        held = rows(gate.rpc("publish_intent_reserve_retry_destinations",
                             reserve(child_label, USERS[index], parent, child, destinations)), 3, True)
        if any(row.get("claimToken") is not None for row in held):
            raise GateError("reserve unexpectedly produced a provider claim token")
        first, second = (destinations[:1], destinations[1:]) if label == "pin-first" else (destinations[1:], destinations[:1])
        rows(gate.rpc("publish_intent_activate_retry_destinations",
                      activate(USERS[index], child, child_label, first)), len(first), True)
        rows(gate.rpc("publish_intent_activate_retry_destinations",
                      activate(USERS[index], child, child_label, second)), len(second), True)

    # Same destination concurrent activation: exactly one provider claim token.
    parent, destinations = seed(gate, USERS[3], "activate-race")
    child, label = intent("activate-race:child"), "activate-race:child"
    gate.rpc("publish_intent_reserve_retry_destinations", reserve(label, USERS[3], parent, child, destinations))
    activation = activate(USERS[3], child, label, destinations[:1])
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: gate.rpc("publish_intent_activate_retry_destinations", activation), range(2)))
    claims = [row.get("claimed") for result in results for row in rows(result, 1)]
    if claims.count(True) != 1 or claims.count(False) != 1:
        raise GateError(f"concurrent activate produced {claims}")

    # Two child receipts compete for the same parent set: no partial loser.
    parent, destinations = seed(gate, USERS[4], "reserve-race")
    calls = []
    for suffix in ("a", "b"):
        label = f"reserve-race:{suffix}"
        child = intent(label)
        calls.append((child, reserve(label, USERS[4], parent, child, destinations)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda call: gate.rpc_response(
            "publish_intent_reserve_retry_destinations", call[1]), calls))
    winners = [i for i, response in enumerate(responses) if response.status_code < 300]
    losers = [i for i, response in enumerate(responses)
              if response.status_code >= 400 and response_code(response) == "P0001"]
    if len(winners) != 1 or len(losers) != 1:
        raise GateError("competing reserve did not produce one typed winner")
    if len(destination_rows(gate, USERS[4], calls[winners[0]][0])) != 3:
        raise GateError("reserve winner was incomplete")
    if child_count(gate, USERS[4], calls[losers[0]][0]):
        raise GateError("reserve loser persisted partial state")

    # Rolling deploy: both legacy v72 retry routes fail closed.
    parent, destinations = seed(gate, USERS[5], "legacy")
    gate.rpc("publish_intent_claim_destination", {
        "p_user_id": USERS[5], "p_intent_id": parent,
        "p_fingerprint": fp("legacy:parent"), "p_draft_id": "v73-harness:legacy:draft",
        "p_content_id": "v73-harness:legacy:content",
        "p_confirmed_at": "2026-09-02T12:00:00+00:00", "p_mode": {"kind": "now"},
        "p_receipt": receipt("legacy:parent", parent, None, destinations),
        "p_destination_id": destinations[0]["id"], "p_provider": "pinterest",
        "p_connection_id": destinations[0]["socialConnectionId"],
        "p_subdestination_id": destinations[0].get("boardId"),
    }, error="P0001")
    old_child = intent("legacy:old-child")
    old_payload = reserve("legacy:old-child", USERS[5], parent, old_child, destinations)
    old_payload.pop("p_prior_intent_id")
    old_payload["p_receipt"]["onlyPending"] = True
    gate.rpc("publish_intent_claim_destinations", old_payload, error="P0001")
    if child_count(gate, USERS[5], old_child):
        raise GateError("legacy onlyPending insert left state")

    # Owner isolation.
    parent, destinations = seed(gate, USERS[6], "owner")
    child = intent("owner:child")
    gate.rpc("publish_intent_reserve_retry_destinations",
             reserve("owner:child", USERS[7], parent, child, destinations), error="P0001")
    if child_count(gate, USERS[7], child):
        raise GateError("cross-owner retry left state")

    # Activate-first blocks inheritance.
    parent, destinations = seed(gate, USERS[8], "activate-wins")
    child1, label1 = intent("activate-wins:child1"), "activate-wins:child1"
    gate.rpc("publish_intent_reserve_retry_destinations", reserve(label1, USERS[8], parent, child1, destinations))
    rows(gate.rpc("publish_intent_activate_retry_destinations",
                  activate(USERS[8], child1, label1, destinations[:1])), 1, True)
    child2 = intent("activate-wins:child2")
    gate.rpc("publish_intent_reserve_retry_destinations",
             reserve("activate-wins:child2", USERS[8], child1, child2, destinations), error="P0001")

    # Reserve-first atomically supersedes unactivated rows.
    parent, destinations = seed(gate, USERS[9], "reserve-wins")
    child1, label1 = intent("reserve-wins:child1"), "reserve-wins:child1"
    gate.rpc("publish_intent_reserve_retry_destinations", reserve(label1, USERS[9], parent, child1, destinations))
    child2, label2 = intent("reserve-wins:child2"), "reserve-wins:child2"
    rows(gate.rpc("publish_intent_reserve_retry_destinations",
                  reserve(label2, USERS[9], child1, child2, destinations)), 3, True)
    stale = rows(gate.rpc("publish_intent_activate_retry_destinations",
                          activate(USERS[9], child1, label1, destinations[:1])), 1, False)
    if stale[0].get("status") != "failed":
        raise GateError("reserve-first did not close superseded rows")

    # Simultaneous activate-vs-reserve must choose exactly one lineage.
    parent, destinations = seed(gate, USERS[10], "mixed-race")
    child1, label1 = intent("mixed-race:child1"), "mixed-race:child1"
    gate.rpc("publish_intent_reserve_retry_destinations", reserve(label1, USERS[10], parent, child1, destinations))
    child2 = intent("mixed-race:child2")
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        activate_future = pool.submit(gate.rpc_response, "publish_intent_activate_retry_destinations",
                                      activate(USERS[10], child1, label1, destinations[:1]))
        reserve_future = pool.submit(gate.rpc_response, "publish_intent_reserve_retry_destinations",
                                     reserve("mixed-race:child2", USERS[10], child1, child2, destinations))
        activate_response, reserve_response = activate_future.result(), reserve_future.result()
    if activate_response.status_code >= 300:
        raise GateError("activate-vs-reserve returned unexpected activation error")
    activated = rows(activate_response.json(), 1)[0].get("claimed") is True
    reserved = reserve_response.status_code < 300
    if activated == reserved:
        raise GateError("activate-vs-reserve did not choose exactly one lineage")
    if not reserved and response_code(reserve_response) != "P0001":
        raise GateError("activate-first race lacked retry_not_allowed")

    return {
        "partialDispatchRollback": True,
        "endpointOrders": ["pinterest-first", "social-first"],
        "concurrentActivationSingleWinner": True,
        "concurrentReserveSingleWinner": True,
        "legacyV72Blocked": ["same-intent-update", "onlyPending-insert"],
        "crossOwnerBlocked": True,
        "reserveActivateOrdering": ["activate-first", "reserve-first", "simultaneous-safe"],
    }


def cleanup(gate: Gate) -> None:
    user_array = ",".join(f"'{user}'::uuid" for user in USERS)
    sql = f"""
do $$ declare changed integer; begin
 loop
  delete from publish_intent_destinations d using publish_intents i
   where d.publish_intent_id=i.id and i.user_id=any(array[{user_array}])
     and i.intent_id like 'publish:v73-harness:%'
     and not exists(select 1 from publish_intent_destinations c where c.retry_of_destination_id=d.id);
  get diagnostics changed=row_count; exit when changed=0;
 end loop;
 loop
  delete from publish_intents i where i.user_id=any(array[{user_array}])
   and i.intent_id like 'publish:v73-harness:%'
   and not exists(select 1 from publish_intents c where c.prior_intent_id=i.id);
  get diagnostics changed=row_count; exit when changed=0;
 end loop;
end $$;
"""
    gate.sql(sql, "synthetic cleanup")
    if gate.count("publish_intents", user_id=f"in.({','.join(USERS)})",
                  intent_id="like.publish:v73-harness:*"):
        raise GateError("synthetic rows remain after cleanup")


def wait_for_rpc(gate: Gate) -> None:
    probe = activate(USERS[0], intent("schema-probe"), "schema-probe", items("schema-probe")[:1])
    for attempt in range(12):
        response = gate.rpc_response("publish_intent_activate_retry_destinations", probe)
        if response.status_code < 300 or response_code(response) not in {"PGRST202", "PGRST203"}:
            return
        time.sleep(min(attempt + 1, 5))
    raise GateError("PostgREST schema cache did not expose v73")


def static_contract() -> None:
    migration, rollback = MIGRATION.read_text(encoding="utf-8"), ROLLBACK.read_text(encoding="utf-8")
    required = ("prior_intent_id", "retry_of_destination_id", "publish_intent_reserve_retry_destinations",
                "publish_intent_activate_retry_destinations", "publish_intent_destinations_retry_source_unique",
                "publish_intent_reject_legacy_retry_trigger", "reserved_not_activated", "for update",
                "retry_not_allowed", "service_role")
    missing = [token for token in required if token not in migration.lower()]
    if missing or "Refusing v73 rollback: retry lineage exists" not in rollback:
        raise GateError(f"static contract incomplete: {missing}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-ref")
    parser.add_argument("--expected-migration-sha")
    parser.add_argument("--expected-rollback-sha")
    parser.add_argument("--confirm")
    parser.add_argument("--preflight-only", action="store_true")
    parser.add_argument("--run-full", action="store_true")
    args = parser.parse_args()
    static_contract()
    migration_sha, rollback_sha = sha256(MIGRATION), sha256(ROLLBACK)
    if not args.preflight_only and not args.run_full:
        print(f"v73 static contract OK; migration={migration_sha[:12]} rollback={rollback_sha[:12]}")
        return 0
    if not all((args.project_ref, args.expected_migration_sha, args.expected_rollback_sha, args.confirm)):
        raise GateError("remote mode needs exact ref, SHAs and confirmation")
    if args.expected_migration_sha != migration_sha or args.expected_rollback_sha != rollback_sha:
        raise GateError("operator-bound SHA mismatch")
    if args.confirm != f"APPLY-TEST-V73:{args.project_ref}:{migration_sha}:{rollback_sha}":
        raise GateError("confirmation token mismatch")

    load_env()
    ref = env("TEST_SUPABASE_PROJECT_REF", "SUPABASE_TEST_REF")
    if ref != args.project_ref:
        raise GateError("CLI ref does not match local test binding")
    gate = Gate(ref, env("TEST_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"),
                env("TEST_SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"),
                env("TEST_SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"),
                env("SUPABASE_MIGRATION_TOKEN"))
    admin = httpx.get(f"{gate.url}/auth/v1/admin/users", params={"page": "1", "per_page": "1"},
                      headers={"apikey": gate.service, "Authorization": f"Bearer {gate.service}"}, timeout=30)
    if admin.status_code != 200:
        raise GateError(f"service identity probe failed (HTTP {admin.status_code})")
    preflight = one(gate.sql(PREFLIGHT_SQL, "v72/v73 preflight"), "preflight")
    v72_requirements = ("intents", "destinations", "claim_one", "claim_many", "settle")
    missing_v72 = [name for name in v72_requirements if preflight.get(name) is not True]
    if missing_v72:
        raise GateError(f"v72 prerequisite is missing: {missing_v72}")
    if any(preflight.get(name) is not False for name in ("prior_column", "retry_column", "reserve", "activate")):
        raise GateError("v73 residue already exists")
    before = one(gate.sql(SNAPSHOT_SQL, "before snapshot"), "snapshot")
    if args.preflight_only:
        print(json.dumps({"ok": True, "preflightOnly": True, "projectRef": gate.ref,
                          "serviceIdentity": "verified-without-secret-output",
                          "migrationSha256": migration_sha, "rollbackSha256": rollback_sha,
                          "preflight": preflight, "beforeSnapshot": before}, sort_keys=True))
        return 0

    applied = False
    try:
        applied = True
        gate.sql(MIGRATION.read_text(encoding="utf-8"), "apply v73")
        readback = one(gate.sql(READBACK_SQL, "v73 readback"), "readback")
        if readback.get("columns") != 2 or not all(readback.get(name) is True for name in
            ("intent_fk", "destination_fk", "parent_index", "source_unique", "legacy_trigger",
             "claim_builtin_uuid", "reserve", "activate", "service_exec", "anon_blocked", "authenticated_blocked")):
            raise GateError(f"v73 readback failed: {readback}")
        wait_for_rpc(gate)
        anon = gate.rpc_response("publish_intent_activate_retry_destinations",
                                 activate(USERS[0], intent("anon"), "anon", items("anon")[:1]), anon=True)
        if anon.status_code < 400:
            raise GateError("anon unexpectedly executed v73 RPC")
        contract = run_contract(gate)
        cleanup(gate)
        if before != one(gate.sql(SNAPSHOT_SQL, "after cleanup snapshot"), "snapshot"):
            raise GateError("existing rows changed after synthetic cleanup")
        gate.sql(ROLLBACK.read_text(encoding="utf-8"), "rollback v73")
        expected = {"columns": 0, "intent_fk": False, "destination_fk": False,
                    "indexes": 0, "trigger": False, "reserve": False, "activate": False}
        if one(gate.sql(RESIDUE_SQL, "rollback residue"), "residue") != expected:
            raise GateError("rollback left v73 residue")
        applied = False
        if before != one(gate.sql(SNAPSHOT_SQL, "post rollback snapshot"), "snapshot"):
            raise GateError("existing rows changed across rollback")
        applied = True
        gate.sql(MIGRATION.read_text(encoding="utf-8"), "final re-apply v73")
        if one(gate.sql(READBACK_SQL, "final readback"), "readback") != readback:
            raise GateError("final v73 surface differs")
        if before != one(gate.sql(SNAPSHOT_SQL, "final snapshot"), "snapshot"):
            raise GateError("final re-apply changed existing rows")
        print(json.dumps({"ok": True, "projectRef": gate.ref,
                          "serviceIdentity": "verified-without-secret-output",
                          "migrationSha256": migration_sha, "rollbackSha256": rollback_sha,
                          "contract": contract, "rollbackZeroResidue": True,
                          "existingDataUnchanged": True, "finalReapplied": True}, sort_keys=True))
        return 0
    except Exception as original:
        recovery: list[str] = []
        try:
            cleanup(gate)
        except Exception as exc:
            recovery.append(f"cleanup: {exc}")
        if applied:
            try:
                gate.sql(ROLLBACK.read_text(encoding="utf-8"), "failure rollback v73")
            except Exception as exc:
                recovery.append(f"rollback: {exc}")
        if recovery:
            raise GateError(f"primary failure: {original}; recovery failure: {'; '.join(recovery)}") from original
        raise


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except GateError as exc:
        print(f"V73_REAL_PG_GATE_FAILED: {exc}", file=sys.stderr)
        raise SystemExit(1)
