#!/usr/bin/env python3
"""Rollback-only PostgreSQL concurrency and Saved Products role canary.

Default invocation validates one reviewed Admission manifest and prints a plan;
it makes no network call. ``--execute`` is reserved for the post-migration
production gate and requires exact project, migration and manifest bindings.

The execution opens independent Management API sessions. The concurrency probe
holds one uncommitted active Product identity while a second session must time
out on the partial unique index. The role probe admits the same Product inside
one transaction, creates two temporary Saved Products relations for existing
users, switches to ``authenticated``/``anon``, verifies RLS and write grants,
and deliberately raises a PASS sentinel so PostgreSQL rolls the whole statement
back. Exact identity/Saved counts must match before and after both probes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


BACKEND = Path(__file__).resolve().parent.parent
SCRIPTS = BACKEND / "scripts"
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(SCRIPTS))

import product_opportunity_admission as admission  # noqa: E402
from run_migration import (  # noqa: E402
    _load_canonical_sql,
    _mgmt_query,
    load_credentials,
)


MIGRATION_PATH = BACKEND / "db" / "migrate_v63_product_opportunities_v1.sql"
EXPECTED_MIGRATION_SHA256 = (
    "6de95674b286b71ce299eb298e28312a2a632e4e1d312cd3752e005ee6d8d3d1"
)
EXECUTION_MODE_ENV = "VIBEPIN_PRODUCT_STAGE2_CANARY_MODE"
EXECUTION_MODE_VALUE = "production"
ROLE_PASS_SENTINEL = "V37_ROLE_CANARY_PASS"
LOCK_TIMEOUT_CODE = "55P03"
LOCK_TIMEOUT_MESSAGE = "canceling statement due to lock timeout"
HOLDER_SECONDS = 15
CHALLENGER_LOCK_TIMEOUT_MS = 2_000
READY_ATTEMPTS = 20
READY_DELAY_SECONDS = 0.25

MgmtQuery = Callable[..., tuple[int, str]]


def confirmation_value(project_ref: str, manifest_sha256: str, migration_sha256: str) -> str:
    if not admission.PROJECT_REF_RE.fullmatch(project_ref):
        raise ValueError("invalid project ref")
    for label, value in (
        ("manifest", manifest_sha256),
        ("migration", migration_sha256),
    ):
        if not re.fullmatch(r"[0-9a-f]{64}", value):
            raise ValueError(f"invalid {label} SHA-256")
    return f"CANARY:{project_ref}:{manifest_sha256}:{migration_sha256}"


def _sql_json(value: object) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "'" + encoded.replace("'", "''") + "'::jsonb"


def _signed_lock_key(manifest_sha256: str) -> int:
    value = int(manifest_sha256[:16], 16)
    return value - (1 << 64) if value >= (1 << 63) else value


def _identity_state_sql(identity_hash: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{64}", identity_hash):
        raise ValueError("invalid canonical identity hash")
    return f"""
SELECT json_build_object(
  'product_rows', count(*)::int,
  'current_rows', count(*) FILTER (WHERE lifecycle_status <> 'retired')::int,
  'retired_rows', count(*) FILTER (WHERE lifecycle_status = 'retired')::int,
  'saved_rows', (
    SELECT count(*)::int
      FROM saved_product_opportunities s
      JOIN product_opportunities p ON p.id = s.product_opportunity_id
     WHERE p.canonical_url_hash = '{identity_hash}'
  )
) AS identity_state
FROM product_opportunities
WHERE canonical_url_hash = '{identity_hash}';
""".strip()


def _holder_sql(candidate: dict[str, Any], lock_key: int) -> str:
    return f"""
BEGIN;
SET LOCAL statement_timeout = '{(HOLDER_SECONDS + 5) * 1000}ms';
SELECT product_opportunity_id
  FROM admit_product_opportunity_batch({_sql_json([candidate])});
SELECT pg_advisory_xact_lock({lock_key});
SELECT pg_sleep({HOLDER_SECONDS});
ROLLBACK;
""".strip()


def _challenger_sql(candidate: dict[str, Any]) -> str:
    return f"""
BEGIN;
SET LOCAL lock_timeout = '{CHALLENGER_LOCK_TIMEOUT_MS}ms';
SET LOCAL statement_timeout = '{CHALLENGER_LOCK_TIMEOUT_MS + 3000}ms';
SELECT product_opportunity_id
  FROM admit_product_opportunity_batch({_sql_json([candidate])});
ROLLBACK;
""".strip()


def _holder_ready_sql(lock_key: int) -> str:
    return f"""
SELECT CASE
  WHEN pg_try_advisory_lock({lock_key})
    THEN (pg_advisory_unlock({lock_key}) AND false)
  ELSE true
END AS holder_ready;
""".strip()


def _role_canary_sql(candidate: dict[str, Any]) -> str:
    return f"""
DO $v37_role_canary$
DECLARE
  v_user_a uuid;
  v_user_b uuid;
  v_product uuid;
  v_visible integer;
  v_owned integer;
  v_authenticated_write_blocked boolean := false;
  v_anon_read_blocked boolean := false;
BEGIN
  SELECT id INTO v_user_a FROM auth.users ORDER BY id LIMIT 1;
  SELECT id INTO v_user_b FROM auth.users WHERE id <> v_user_a ORDER BY id LIMIT 1;
  IF v_user_a IS NULL OR v_user_b IS NULL THEN
    RAISE EXCEPTION 'role canary requires two existing auth users';
  END IF;

  SELECT product_opportunity_id INTO STRICT v_product
    FROM admit_product_opportunity_batch({_sql_json([candidate])});
  INSERT INTO saved_product_opportunities (user_id, product_opportunity_id)
  VALUES (v_user_a, v_product), (v_user_b, v_product);

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_user_a::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_user_a, 'role', 'authenticated')::text,
    true
  );
  SELECT count(*)::int, count(*) FILTER (WHERE user_id = v_user_a)::int
    INTO v_visible, v_owned
    FROM saved_product_opportunities
   WHERE product_opportunity_id = v_product;
  IF v_visible <> 1 OR v_owned <> 1 THEN
    RAISE EXCEPTION 'authenticated user A crossed the Saved Products RLS boundary';
  END IF;

  BEGIN
    INSERT INTO saved_product_opportunities (user_id, product_opportunity_id)
    VALUES (v_user_a, v_product);
  EXCEPTION WHEN insufficient_privilege THEN
    v_authenticated_write_blocked := true;
  END;
  IF NOT v_authenticated_write_blocked THEN
    RAISE EXCEPTION 'authenticated direct Saved Products write was not blocked';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_user_b::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_user_b, 'role', 'authenticated')::text,
    true
  );
  SELECT count(*)::int, count(*) FILTER (WHERE user_id = v_user_b)::int
    INTO v_visible, v_owned
    FROM saved_product_opportunities
   WHERE product_opportunity_id = v_product;
  IF v_visible <> 1 OR v_owned <> 1 THEN
    RAISE EXCEPTION 'authenticated user B crossed the Saved Products RLS boundary';
  END IF;

  EXECUTE 'SET LOCAL ROLE anon';
  BEGIN
    PERFORM count(*) FROM saved_product_opportunities
     WHERE product_opportunity_id = v_product;
  EXCEPTION WHEN insufficient_privilege THEN
    v_anon_read_blocked := true;
  END;
  IF NOT v_anon_read_blocked THEN
    RAISE EXCEPTION 'anonymous Saved Products read was not blocked';
  END IF;

  EXECUTE 'RESET ROLE';
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '{ROLE_PASS_SENTINEL}';
END
$v37_role_canary$;
""".strip()


def _parse_single_object(status: int, body: str, key: str) -> dict[str, Any]:
    if status not in (200, 201):
        raise RuntimeError(f"read-only canary query failed with HTTP {status}: {body[:300]}")
    try:
        rows = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Management API returned invalid JSON") from exc
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
        raise RuntimeError("Management API did not return exactly one object row")
    value = rows[0].get(key)
    if not isinstance(value, dict):
        raise RuntimeError(f"Management API row has no {key} object")
    return value


def _parse_ready(status: int, body: str) -> bool:
    if status not in (200, 201):
        raise RuntimeError(f"holder readiness query failed with HTTP {status}")
    try:
        rows = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError("holder readiness response is not JSON") from exc
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
        raise RuntimeError("holder readiness response has the wrong shape")
    value = rows[0].get("holder_ready")
    if not isinstance(value, bool):
        raise RuntimeError("holder readiness response is not boolean")
    return value


def _parse_pg_error(body: str) -> tuple[str, str]:
    """Return an exact PostgreSQL code/message pair from an API error.

    Supabase Management API currently wraps PostgreSQL failures in one JSON
    ``message`` string, for example ``Failed to run sql query: ERROR:  22012:
    division by zero``.  Some test/client adapters expose ``code`` and
    ``message`` separately.  Both shapes are parsed structurally; arbitrary
    body substring matches and SQL echoes are deliberately rejected.
    """
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Management API error response is not JSON") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("Management API error response is not an object")
    nested = payload.get("error")
    if isinstance(nested, dict):
        if set(payload) != {"error"}:
            raise RuntimeError("Management API nested error has ambiguous sibling fields")
        payload = nested
    code_keys = [key for key in ("code", "error_code", "postgres_code") if key in payload]
    if len(code_keys) > 1:
        raise RuntimeError("Management API error has ambiguous PostgreSQL code fields")
    code = payload.get(code_keys[0]) if code_keys else None
    message = payload.get("message")
    if isinstance(code, str) and isinstance(message, str):
        if set(payload) != {code_keys[0], "message"}:
            raise RuntimeError("Management API structured error has ambiguous extra fields")
        return code, message
    if set(payload) != {"message"} or not isinstance(message, str):
        raise RuntimeError("Management API error has no structured PostgreSQL code/message")
    wrapped = re.fullmatch(
        r"Failed to run sql query: ERROR:\s+([0-9A-Z]{5}):\s*([^\r\n]*)"
        r"(?:\r?\n[\s\S]*)?",
        message,
    )
    if not wrapped:
        raise RuntimeError("Management API PostgreSQL error wrapper is not exact")
    return wrapped.group(1), wrapped.group(2)


def _call(
    query: MgmtQuery,
    sql: str,
    *,
    token: str,
    project_ref: str,
    label: str,
) -> tuple[int, str]:
    return query(sql, token=token, project_ref=project_ref, label=label)


def execute_canary(
    *,
    candidate: dict[str, Any],
    manifest_sha256: str,
    token: str,
    project_ref: str,
    query: MgmtQuery = _mgmt_query,
    sleep: Callable[[float], None] = time.sleep,
    ready_attempts: int = READY_ATTEMPTS,
) -> dict[str, Any]:
    """Execute rollback-only probes; raise on any ambiguous or dirty result."""
    identity_hash = str(candidate.get("canonical_url_hash") or "")
    state_sql = _identity_state_sql(identity_hash)
    baseline = _parse_single_object(
        *_call(query, state_sql, token=token, project_ref=project_ref, label="baseline"),
        "identity_state",
    )
    if int(baseline.get("current_rows", -1)) != 0:
        raise RuntimeError("canary identity already has a current Product row")

    lock_key = _signed_lock_key(manifest_sha256)
    with ThreadPoolExecutor(max_workers=1) as pool:
        holder = pool.submit(
            _call,
            query,
            _holder_sql(candidate, lock_key),
            token=token,
            project_ref=project_ref,
            label="concurrency_holder",
        )
        ready = False
        for _ in range(ready_attempts):
            status, body = _call(
                query,
                _holder_ready_sql(lock_key),
                token=token,
                project_ref=project_ref,
                label="holder_ready",
            )
            if _parse_ready(status, body):
                ready = True
                break
            if holder.done():
                break
            sleep(READY_DELAY_SECONDS)
        if not ready:
            holder_status, holder_body = holder.result()
            raise RuntimeError(
                "concurrency holder never reached its post-admission lock: "
                f"HTTP {holder_status} {holder_body[:300]}"
            )
        challenger_status, challenger_body = _call(
            query,
            _challenger_sql(candidate),
            token=token,
            project_ref=project_ref,
            label="concurrency_challenger",
        )
        holder_status, holder_body = holder.result()

    if holder_status not in (200, 201):
        raise RuntimeError(
            f"concurrency holder did not roll back cleanly: HTTP {holder_status} "
            f"{holder_body[:300]}"
        )
    try:
        challenger_code, challenger_message = _parse_pg_error(challenger_body)
    except RuntimeError as parse_error:
        raise RuntimeError(
            "concurrent duplicate did not return a structured active-identity lock error: "
            f"HTTP {challenger_status} {challenger_body[:300]}"
        ) from parse_error
    if (
        challenger_status != 400
        or challenger_code != LOCK_TIMEOUT_CODE
        or challenger_message != LOCK_TIMEOUT_MESSAGE
    ):
        raise RuntimeError(
            "concurrent duplicate did not fail on the active-identity lock: "
            f"HTTP {challenger_status} {challenger_body[:300]}"
        )

    after_concurrency = _parse_single_object(
        *_call(
            query,
            state_sql,
            token=token,
            project_ref=project_ref,
            label="after_concurrency",
        ),
        "identity_state",
    )
    if after_concurrency != baseline:
        raise RuntimeError("concurrency probe changed Product or Saved Products state")

    role_status, role_body = _call(
        query,
        _role_canary_sql(candidate),
        token=token,
        project_ref=project_ref,
        label="role_isolation",
    )
    try:
        role_code, role_message = _parse_pg_error(role_body)
    except RuntimeError as parse_error:
        raise RuntimeError(
            "role-isolation probe did not return a structured rollback sentinel: "
            f"HTTP {role_status} {role_body[:300]}"
        ) from parse_error
    if (
        role_status != 400
        or role_code != "P0001"
        or role_message != ROLE_PASS_SENTINEL
    ):
        raise RuntimeError(
            "role-isolation probe did not end in the exact rollback sentinel: "
            f"HTTP {role_status} {role_body[:300]}"
        )

    final_state = _parse_single_object(
        *_call(query, state_sql, token=token, project_ref=project_ref, label="final"),
        "identity_state",
    )
    if final_state != baseline:
        raise RuntimeError("role-isolation probe changed Product or Saved Products state")

    return {
        "mode": "rollback-only-postgresql-canary",
        "projectRef": project_ref,
        "manifestSha256": manifest_sha256,
        "canonicalUrlHash": identity_hash,
        "concurrency": {
            "holderReachedPostAdmissionLock": True,
            "duplicateBlockedByActiveIdentity": True,
            "challengerError": "lock_timeout",
        },
        "roleIsolation": {
            "twoExistingUsers": True,
            "eachAuthenticatedUserSawOnlyOwnSavedRow": True,
            "authenticatedDirectWriteBlocked": True,
            "anonymousReadBlocked": True,
            "rollbackSentinel": ROLE_PASS_SENTINEL,
        },
        "before": baseline,
        "after": final_state,
        "productionRowsPersisted": 0,
        "verdict": "PASS",
    }


def _load_one_candidate(path: Path) -> tuple[dict[str, Any], str]:
    raw = path.read_bytes()
    manifest_sha256 = hashlib.sha256(raw).hexdigest()
    payload = json.loads(raw.decode("utf-8"))
    accepted, rejected = admission.validate_manifest(payload, now=datetime.now(timezone.utc))
    if not isinstance(payload, list) or len(payload) != 1:
        raise RuntimeError("PostgreSQL canary requires exactly one reviewed manifest row")
    if rejected or len(accepted) != 1:
        raise RuntimeError("PostgreSQL canary manifest did not pass every Admission gate")
    return accepted[0], manifest_sha256


def _guard_execution(
    *,
    project_ref: str | None,
    expected_project_ref: str | None,
    manifest_sha256: str,
    migration_sha256: str,
    expected_migration_sha256: str | None,
    confirm: str | None,
) -> str:
    actual = str(project_ref or "").strip()
    expected = str(expected_project_ref or "").strip()
    if not admission.PROJECT_REF_RE.fullmatch(actual) or actual != expected:
        raise RuntimeError("execute refused: explicit project refs are missing or differ")
    if os.environ.get(EXECUTION_MODE_ENV) != EXECUTION_MODE_VALUE:
        raise RuntimeError(
            f"execute refused: {EXECUTION_MODE_ENV} must equal {EXECUTION_MODE_VALUE}"
        )
    if expected_migration_sha256 != migration_sha256:
        raise RuntimeError("execute refused: expected migration SHA-256 does not match")
    required = confirmation_value(actual, manifest_sha256, migration_sha256)
    if confirm != required:
        raise RuntimeError("execute refused: confirmation does not bind target and exact bytes")
    return actual


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--project-ref")
    parser.add_argument("--expected-project-ref")
    parser.add_argument("--expected-migration-sha256")
    parser.add_argument("--confirm")
    parser.add_argument("--report-out", type=Path)
    args = parser.parse_args()
    try:
        candidate, manifest_sha256 = _load_one_candidate(args.manifest)
        _, migration_sha256 = _load_canonical_sql(MIGRATION_PATH)
        if migration_sha256 != EXPECTED_MIGRATION_SHA256:
            raise RuntimeError("reviewed v63 migration SHA-256 drifted")
        plan: dict[str, Any] = {
            "mode": "plan" if not args.execute else "execute",
            "manifestSha256": manifest_sha256,
            "migrationSha256": migration_sha256,
            "canonicalUrlHash": candidate["canonical_url_hash"],
            "networkAccess": False,
            "productionMutation": False,
            "executionContract": (
                "two independent rollback-only concurrency sessions plus one "
                "sentinel-rollback role-isolation session"
            ),
        }
        if args.execute:
            project_ref = _guard_execution(
                project_ref=args.project_ref,
                expected_project_ref=args.expected_project_ref,
                manifest_sha256=manifest_sha256,
                migration_sha256=migration_sha256,
                expected_migration_sha256=args.expected_migration_sha256,
                confirm=args.confirm,
            )
            token = load_credentials().get("SUPABASE_MIGRATION_TOKEN", "")
            if not token:
                raise RuntimeError("execute refused: SUPABASE_MIGRATION_TOKEN is missing")
            plan = execute_canary(
                candidate=candidate,
                manifest_sha256=manifest_sha256,
                token=token,
                project_ref=project_ref,
            )
            plan["migrationSha256"] = migration_sha256
            plan["productionMutation"] = True
            plan["productionRowsPersisted"] = 0
        output = json.dumps(plan, indent=2, sort_keys=True)
        if args.report_out:
            args.report_out.write_text(output + "\n", encoding="utf-8")
        print(output)
        return 0
    except Exception as exc:
        print(f"PostgreSQL canary failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
