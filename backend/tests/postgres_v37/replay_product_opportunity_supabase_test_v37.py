#!/usr/bin/env python3
"""Run the v3.7 platform canary in an explicitly named Supabase test project.

Default mode is offline plan-only. Execution is deliberately test-project-only:
it verifies account metadata, a clean v3.7 catalog and migration prerequisites,
applies the exact reviewed migration, delegates to the production rollback-only
concurrency/RLS canary, then runs the exact schema rollback in ``finally``.
A PASS receipt is emitted only after the final catalog is back to zero objects.

This harness does not prove production legacy-table integrity. The selected test
project intentionally lacks ``pin_products`` and ``pin_save_snapshots``; that
separate gate remains bound to the production Stage 1 baseline/verifier.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


BACKEND = Path(__file__).resolve().parents[2]
SCRIPTS = BACKEND / "scripts"
sys.path.insert(0, str(SCRIPTS))

import canary_product_opportunity_postgres_v37 as canary  # noqa: E402
from run_migration import (  # noqa: E402
    _load_canonical_sql,
    _load_dotenv_file,
    _mgmt_query,
    _project_ref,
)


MIGRATION = BACKEND / "db" / "migrate_v63_product_opportunities_v1.sql"
ROLLBACK = BACKEND / "db" / "rollback_v63_product_opportunities_v1.sql"
CATALOG = BACKEND / "docs" / "product_opportunities_v37_catalog_query_v1.sql"
EXPECTED_SHA256 = {
    MIGRATION: "6de95674b286b71ce299eb298e28312a2a632e4e1d312cd3752e005ee6d8d3d1",
    ROLLBACK: "bba932a49e65b7f7f9cf2c38ebaa89a751eab7719c9e17a923abd853acdb9e3c",
    CATALOG: "1d0ff2369649f4f01f42be2f55abb6a4b85d24e93c365afd05ebe2dbabb6f035",
}
EXPECTED_POST_APPLY_CATALOG_OBJECTS = 158
EXECUTION_MODE_ENV = "VIBEPIN_V37_SUPABASE_TEST_MODE"
EXECUTION_MODE_VALUE = "rollback-only"
TEST_NAME_MARKER_RE = re.compile(
    r"(?:^|[^a-z0-9])(?:test|testing|sandbox|staging)(?:$|[^a-z0-9])"
)

PREREQUISITE_SQL = """
SELECT json_build_object(
  'serverVersionNum', current_setting('server_version_num'),
  'authUserCount', (SELECT count(*) FROM auth.users),
  'authUsersRelation', to_regclass('auth.users') IS NOT NULL,
  'authUidFunction', to_regprocedure('auth.uid()') IS NOT NULL,
  'anonRole', EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon'),
  'authenticatedRole', EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'authenticated'
  ),
  'pgcryptoInstalled', EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto'
  ),
  'legacyPinProducts', to_regclass('public.pin_products') IS NOT NULL,
  'legacyPinSaveSnapshots',
    to_regclass('public.pin_save_snapshots') IS NOT NULL
) AS prerequisites
""".strip()

Query = Callable[..., tuple[int, str]]
ProjectLister = Callable[[str], list[dict[str, Any]]]


def _verified_sql() -> dict[Path, tuple[str, str]]:
    verified: dict[Path, tuple[str, str]] = {}
    for path, expected in EXPECTED_SHA256.items():
        text, actual = _load_canonical_sql(path)
        if actual != expected:
            raise RuntimeError(f"reviewed SQL drifted: {path.name}")
        verified[path] = (text, actual)
    return verified


def confirmation_value(
    project_ref: str,
    manifest_sha256: str,
    migration_sha256: str,
    rollback_sha256: str,
) -> str:
    if not canary.admission.PROJECT_REF_RE.fullmatch(project_ref):
        raise ValueError("invalid project ref")
    for value in (manifest_sha256, migration_sha256, rollback_sha256):
        if not re.fullmatch(r"[0-9a-f]{64}", value):
            raise ValueError("invalid SHA-256")
    return (
        f"TEST-V37-ROLLBACK-ONLY:{project_ref}:{manifest_sha256}:"
        f"{migration_sha256}:{rollback_sha256}"
    )


def _default_project_lister(token: str) -> list[dict[str, Any]]:
    import httpx

    response = httpx.get(
        "https://api.supabase.com/v1/projects",
        headers={"Authorization": f"Bearer {token}"},
        timeout=20,
    )
    if response.status_code != 200:
        raise RuntimeError(f"project inventory failed with HTTP {response.status_code}")
    payload = response.json()
    if not isinstance(payload, list) or not all(isinstance(row, dict) for row in payload):
        raise RuntimeError("project inventory response is not a list of objects")
    return payload


def _require_test_project(
    projects: list[dict[str, Any]],
    *,
    target_ref: str,
    production_ref: str,
) -> dict[str, Any]:
    if not target_ref or target_ref == production_ref:
        raise RuntimeError("test replay refuses the production project")
    target = next((row for row in projects if row.get("ref") == target_ref), None)
    production = next((row for row in projects if row.get("ref") == production_ref), None)
    if target is None or production is None:
        raise RuntimeError("target or production project is absent from account inventory")
    if target.get("status") != "ACTIVE_HEALTHY":
        raise RuntimeError("target project is not ACTIVE_HEALTHY")
    name = str(target.get("name") or "").lower()
    if not TEST_NAME_MARKER_RE.search(name):
        raise RuntimeError("target project name has no test/sandbox/staging marker")
    if target.get("organization_id") != production.get("organization_id"):
        raise RuntimeError("target is not in the production project's organization")
    return target


def _one_json_object(status: int, body: str, *, key: str, label: str) -> dict[str, Any]:
    if status not in (200, 201):
        raise RuntimeError(f"{label} failed with HTTP {status}")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{label} returned non-JSON") from exc
    if not isinstance(payload, list) or len(payload) != 1 or not isinstance(payload[0], dict):
        raise RuntimeError(f"{label} did not return exactly one object row")
    value = payload[0].get(key)
    if not isinstance(value, dict):
        raise RuntimeError(f"{label} has no {key} object")
    return value


def _catalog_count(status: int, body: str, *, label: str) -> int:
    if status not in (200, 201):
        raise RuntimeError(f"{label} failed with HTTP {status}")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{label} returned non-JSON") from exc
    if not isinstance(payload, list) or not all(isinstance(row, dict) for row in payload):
        raise RuntimeError(f"{label} response is not a row list")
    return len(payload)


def _call(query: Query, sql: str, *, token: str, project_ref: str, label: str) -> tuple[int, str]:
    return query(sql, token=token, project_ref=project_ref, label=label)


def execute_test_replay(
    *,
    candidate: dict[str, Any],
    manifest_sha256: str,
    token: str,
    target_ref: str,
    production_ref: str,
    query: Query = _mgmt_query,
    list_projects: ProjectLister = _default_project_lister,
    execute_canary: Callable[..., dict[str, Any]] = canary.execute_canary,
) -> dict[str, Any]:
    sql = _verified_sql()
    projects = list_projects(token)
    target = _require_test_project(
        projects, target_ref=target_ref, production_ref=production_ref
    )

    catalog_sql = sql[CATALOG][0]
    before_count = _catalog_count(
        *_call(query, catalog_sql, token=token, project_ref=target_ref, label="catalog_before"),
        label="catalog_before",
    )
    if before_count != 0:
        raise RuntimeError("test project already contains v3.7 catalog objects")

    prerequisites = _one_json_object(
        *_call(
            query,
            PREREQUISITE_SQL,
            token=token,
            project_ref=target_ref,
            label="prerequisites",
        ),
        key="prerequisites",
        label="prerequisites",
    )
    required_true = (
        "authUsersRelation",
        "authUidFunction",
        "anonRole",
        "authenticatedRole",
        "pgcryptoInstalled",
    )
    if any(prerequisites.get(key) is not True for key in required_true):
        raise RuntimeError("test project is missing a migration/canary prerequisite")
    if int(prerequisites.get("authUserCount", 0)) < 2:
        raise RuntimeError("test project has fewer than two users for the RLS probe")
    server_version = str(prerequisites.get("serverVersionNum") or "")
    if not server_version.isdigit() or not 170000 <= int(server_version) < 180000:
        raise RuntimeError("test project is not PostgreSQL 17")

    apply_attempted = False
    primary_error: BaseException | None = None
    replay: dict[str, Any] | None = None
    after_apply_count: int | None = None
    cleanup_error: BaseException | None = None
    after_rollback_count: int | None = None
    try:
        apply_attempted = True
        apply_status, _ = _call(
            query,
            sql[MIGRATION][0],
            token=token,
            project_ref=target_ref,
            label="migration_apply",
        )
        if apply_status not in (200, 201):
            raise RuntimeError(f"migration apply failed with HTTP {apply_status}")
        after_apply_count = _catalog_count(
            *_call(
                query,
                catalog_sql,
                token=token,
                project_ref=target_ref,
                label="catalog_after_apply",
            ),
            label="catalog_after_apply",
        )
        if after_apply_count != EXPECTED_POST_APPLY_CATALOG_OBJECTS:
            raise RuntimeError(
                "post-apply v3.7 catalog count differs from reviewed native PostgreSQL 17"
            )
        replay = execute_canary(
            candidate=candidate,
            manifest_sha256=manifest_sha256,
            token=token,
            project_ref=target_ref,
            query=query,
        )
        if replay.get("verdict") != "PASS" or replay.get("productionRowsPersisted") != 0:
            raise RuntimeError("rollback-only canary did not return an exact zero-write PASS")
    except BaseException as exc:  # cleanup must also run on interrupts and parse failures
        primary_error = exc
    finally:
        if apply_attempted:
            try:
                rollback_status, _ = _call(
                    query,
                    sql[ROLLBACK][0],
                    token=token,
                    project_ref=target_ref,
                    label="schema_rollback",
                )
                if rollback_status not in (200, 201):
                    raise RuntimeError(f"schema rollback failed with HTTP {rollback_status}")
                after_rollback_count = _catalog_count(
                    *_call(
                        query,
                        catalog_sql,
                        token=token,
                        project_ref=target_ref,
                        label="catalog_after_rollback",
                    ),
                    label="catalog_after_rollback",
                )
                if after_rollback_count != 0:
                    raise RuntimeError("schema rollback left v3.7 catalog objects")
            except BaseException as exc:
                cleanup_error = exc

    if cleanup_error is not None:
        if primary_error is not None:
            raise RuntimeError(
                f"test replay failed ({primary_error}) and cleanup also failed ({cleanup_error})"
            ) from cleanup_error
        raise RuntimeError(f"test replay cleanup failed: {cleanup_error}") from cleanup_error
    if primary_error is not None:
        raise primary_error
    if replay is None or after_apply_count is None or after_rollback_count != 0:
        raise RuntimeError("test replay reached an impossible incomplete PASS state")
    return {
        "mode": "isolated-supabase-test-rollback-replay",
        "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "projectRefPrefix": target_ref[:6],
        "projectRefSha256": hashlib.sha256(target_ref.encode()).hexdigest(),
        "projectNameDisclosed": False,
        "serverVersionNum": prerequisites.get("serverVersionNum"),
        "manifestSha256": manifest_sha256,
        "canonicalUrlHash": candidate["canonical_url_hash"],
        "canonicalSqlSha256": {
            "migration": sql[MIGRATION][1],
            "rollback": sql[ROLLBACK][1],
            "catalog": sql[CATALOG][1],
            "prerequisites": hashlib.sha256(PREREQUISITE_SQL.encode()).hexdigest(),
        },
        "scope": {
            "supabaseMultiSessionRlsRollbackOnly": True,
            "productionLegacyIntegrity": False,
        },
        "catalogObjects": {
            "before": before_count,
            "afterApply": after_apply_count,
            "afterRollback": after_rollback_count,
        },
        "canary": {k: v for k, v in replay.items() if k != "projectRef"},
        "databaseRowsPersisted": 0,
        "verdict": "PASS",
    }


def _load_credentials(directory: Path) -> tuple[str, str]:
    runtime = _load_dotenv_file(directory / ".env", ["SUPABASE_URL"])
    migration = _load_dotenv_file(
        directory / ".env.migration", ["SUPABASE_MIGRATION_TOKEN"]
    )
    token = migration.get("SUPABASE_MIGRATION_TOKEN", "")
    production_ref = _project_ref(runtime.get("SUPABASE_URL", ""))
    if not token or not production_ref:
        raise RuntimeError("credentials directory lacks migration token or production URL")
    return token, production_ref


def _guard_execution(
    *,
    target_ref: str,
    expected_target_ref: str,
    manifest_sha256: str,
    migration_sha256: str,
    rollback_sha256: str,
    expected_migration_sha256: str,
    expected_rollback_sha256: str,
    confirm: str,
) -> str:
    if target_ref != expected_target_ref:
        raise RuntimeError("explicit target refs are missing or differ")
    if os.environ.get(EXECUTION_MODE_ENV) != EXECUTION_MODE_VALUE:
        raise RuntimeError(
            f"execute refused: {EXECUTION_MODE_ENV} must equal {EXECUTION_MODE_VALUE}"
        )
    if expected_migration_sha256 != migration_sha256:
        raise RuntimeError("expected migration SHA-256 does not match")
    if expected_rollback_sha256 != rollback_sha256:
        raise RuntimeError("expected rollback SHA-256 does not match")
    required = confirmation_value(
        target_ref, manifest_sha256, migration_sha256, rollback_sha256
    )
    if confirm != required:
        raise RuntimeError("confirmation does not bind target and exact bytes")
    return target_ref


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--execute-test", action="store_true")
    parser.add_argument("--credentials-dir", type=Path)
    parser.add_argument("--project-ref")
    parser.add_argument("--expected-project-ref")
    parser.add_argument("--expected-production-project-ref")
    parser.add_argument("--expected-migration-sha256")
    parser.add_argument("--expected-rollback-sha256")
    parser.add_argument("--confirm")
    parser.add_argument("--report-out", type=Path)
    args = parser.parse_args()
    try:
        candidate, manifest_sha = canary._load_one_candidate(args.manifest)
        sql = _verified_sql()
        migration_sha = sql[MIGRATION][1]
        rollback_sha = sql[ROLLBACK][1]
        if not args.execute_test:
            print(json.dumps({
                "mode": "offline-plan",
                "networkAccess": False,
                "databaseMutation": False,
                "manifestSha256": manifest_sha,
                "migrationSha256": migration_sha,
                "rollbackSha256": rollback_sha,
                "executionContract": "exact migration -> rollback-only canary -> exact rollback -> zero catalog",
            }, indent=2, sort_keys=True))
            return 0

        target_ref = _guard_execution(
            target_ref=str(args.project_ref or "").strip(),
            expected_target_ref=str(args.expected_project_ref or "").strip(),
            manifest_sha256=manifest_sha,
            migration_sha256=migration_sha,
            rollback_sha256=rollback_sha,
            expected_migration_sha256=str(args.expected_migration_sha256 or ""),
            expected_rollback_sha256=str(args.expected_rollback_sha256 or ""),
            confirm=str(args.confirm or ""),
        )
        if args.credentials_dir is None:
            raise RuntimeError("execute requires an explicit credentials directory")
        token, production_ref = _load_credentials(args.credentials_dir)
        if production_ref != str(args.expected_production_project_ref or "").strip():
            raise RuntimeError("expected production project does not match credentials")
        report = execute_test_replay(
            candidate=candidate,
            manifest_sha256=manifest_sha,
            token=token,
            target_ref=target_ref,
            production_ref=production_ref,
        )
        encoded = json.dumps(report, indent=2, sort_keys=True) + "\n"
        if args.report_out:
            args.report_out.write_text(encoded, encoding="utf-8")
        print(encoded, end="")
        return 0
    except Exception as exc:
        print(f"test-project replay failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
