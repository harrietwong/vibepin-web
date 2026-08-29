#!/usr/bin/env python3
"""Run the v3.7 rollback-only canary against an isolated local PostgreSQL.

This harness never accepts a remote host and never reads project credentials.
It prepares only a fresh disposable cluster, applies the exact v63 migration,
delegates concurrency/RLS verification to the production canary core, runs the
exact schema rollback, removes its legacy/auth fixtures, and proves zero v63
objects, advisory locks, sessions, and user relations remain.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


BACKEND = Path(__file__).resolve().parents[2]
ROOT = BACKEND.parent
SCRIPTS = BACKEND / "scripts"
sys.path.insert(0, str(SCRIPTS))

import canary_product_opportunity_postgres_v37 as canary  # noqa: E402


MIGRATION = BACKEND / "db" / "migrate_v63_product_opportunities_v1.sql"
ROLLBACK = BACKEND / "db" / "rollback_v63_product_opportunities_v1.sql"
CATALOG = BACKEND / "docs" / "product_opportunities_v37_catalog_query_v1.sql"
POST_APPLY = BACKEND / "docs" / "product_opportunities_v37_stage1_post_apply_query_v1.sql"
MANIFEST = BACKEND / "docs" / "product_opportunities_v37_release_manifest_8caad77.json"
EXPECTED_SHA256 = {
    MIGRATION: "6de95674b286b71ce299eb298e28312a2a632e4e1d312cd3752e005ee6d8d3d1",
    ROLLBACK: "bba932a49e65b7f7f9cf2c38ebaa89a751eab7719c9e17a923abd853acdb9e3c",
    CATALOG: "1d0ff2369649f4f01f42be2f55abb6a4b85d24e93c365afd05ebe2dbabb6f035",
    POST_APPLY: "2c482caca84b779dd60d94be8f0f7010162701fea5d0abfa3d773328d69c8b43",
}
LOCAL_PROJECT_REF = "local-pg17-v37"
LOCAL_DATABASE = "vibepin_v37_replay"


FIXTURE_SQL = r"""
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TABLE pin_products (id bigint PRIMARY KEY, marker text NOT NULL);
CREATE TABLE pin_save_snapshots (id bigint PRIMARY KEY, marker text NOT NULL);
CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
INSERT INTO auth.users(id) VALUES
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002');
INSERT INTO pin_products VALUES (1, 'legacy-product');
INSERT INTO pin_save_snapshots VALUES (1, 'legacy-snapshot');
""".strip()


CLEANUP_SQL = r"""
DROP TABLE pin_save_snapshots;
DROP TABLE pin_products;
DROP SCHEMA auth CASCADE;
DROP ROLE service_role;
DROP ROLE authenticated;
DROP ROLE anon;
""".strip()


def _canonical_bytes(path: Path) -> bytes:
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        raise RuntimeError(f"{path} has a UTF-8 BOM")
    return raw.replace(b"\r\n", b"\n").replace(b"\r", b"\n")


def _verify_hashes() -> dict[str, str]:
    result: dict[str, str] = {}
    for path, expected in EXPECTED_SHA256.items():
        actual = hashlib.sha256(_canonical_bytes(path)).hexdigest()
        if actual != expected:
            raise RuntimeError(f"canonical SQL SHA-256 drift for {path}: {actual}")
        result[str(path.relative_to(ROOT)).replace("\\", "/")] = actual
    return result


def _assert_loopback(host: str) -> None:
    try:
        address = ipaddress.ip_address(host)
    except ValueError as exc:
        raise ValueError("local PostgreSQL replay requires a literal loopback IP") from exc
    if not address.is_loopback:
        raise ValueError("local PostgreSQL replay refuses every non-loopback host")


def confirmation_value(host: str, port: int, database: str) -> str:
    _assert_loopback(host)
    return f"LOCAL-V37-ROLLBACK-ONLY:{host}:{port}:{database}"


def _normalize_pg_error(stderr: str) -> tuple[int, str]:
    matches = re.findall(r"ERROR:\s+([0-9A-Z]{5}):\s*([^\r\n]*)", stderr)
    if len(matches) != 1:
        return 500, json.dumps({"message": "local psql error had no unique SQLSTATE line"})
    code, message = matches[0]
    return 400, json.dumps({
        "message": f"Failed to run sql query: ERROR:  {code}: {message}\n",
    })


class LocalPsql:
    def __init__(
        self,
        *,
        executable: Path,
        host: str,
        port: int,
        user: str,
        database: str,
    ) -> None:
        _assert_loopback(host)
        if executable.name.lower() not in {"psql", "psql.exe"} or not executable.is_file():
            raise ValueError("--psql must be an existing psql executable")
        if not (1024 <= port <= 65535):
            raise ValueError("local PostgreSQL port is outside the unprivileged range")
        if database != LOCAL_DATABASE:
            raise ValueError(f"local PostgreSQL replay requires database {LOCAL_DATABASE}")
        self.base = [
            str(executable), "-X", "-q", "-v", "ON_ERROR_STOP=1",
            "-v", "VERBOSITY=verbose", "-h", host, "-p", str(port),
            "-U", user, "-d", database, "-At",
        ]

    def raw(self, sql: str, *, timeout: int = 60) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            self.base,
            input=sql,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=timeout,
            check=False,
        )

    def require(self, sql: str, *, label: str, timeout: int = 60) -> str:
        completed = self.raw(sql, timeout=timeout)
        if completed.returncode != 0:
            status, body = _normalize_pg_error(completed.stderr)
            raise RuntimeError(f"{label} failed ({status}): {body}")
        return completed.stdout.strip()

    def scalar(self, sql: str, *, label: str) -> str:
        lines = [line for line in self.require(sql, label=label).splitlines() if line]
        if len(lines) != 1:
            raise RuntimeError(f"{label} did not return exactly one scalar")
        return lines[0]

    def __call__(
        self,
        sql: str,
        *,
        token: str,
        project_ref: str,
        label: str,
    ) -> tuple[int, str]:
        if token != "local-no-token" or project_ref != LOCAL_PROJECT_REF:
            raise RuntimeError("local adapter binding mismatch")
        completed = self.raw(sql, timeout=40)
        if completed.returncode != 0:
            return _normalize_pg_error(completed.stderr)
        lines = [line for line in completed.stdout.splitlines() if line]
        if label in {"baseline", "after_concurrency", "final"}:
            if len(lines) != 1:
                return 500, json.dumps({"message": "local identity query shape mismatch"})
            return 201, json.dumps([{"identity_state": json.loads(lines[0])}])
        if label == "holder_ready":
            if lines not in (["t"], ["f"]):
                return 500, json.dumps({"message": "local readiness query shape mismatch"})
            return 201, json.dumps([{"holder_ready": lines[0] == "t"}])
        return 201, "[]"


def _candidate() -> dict[str, Any]:
    canonical = "https://merchant.example/products/local-pg17-canary"
    image = "https://merchant.example/images/local-pg17-canary.jpg"
    pin_id = "987654321012345678"
    return {
        "canonical_product_url": canonical,
        "canonical_url_hash": hashlib.sha256(canonical.encode()).hexdigest(),
        "external_product_url": canonical,
        "product_image_url": image,
        "product_image_source": "merchant_open_graph",
        "product_page_verified_at": "2026-08-28T00:00:00.000Z",
        "product_page_verification_method": "merchant_structured_data",
        "product_name": None,
        "merchant": "Merchant",
        "domain": "merchant.example",
        "category": "fashion",
        "product_type": None,
        "product_family": "physical",
        "discovery_method": "outbound_link",
        "pinterest_pin_id": pin_id,
        "pinterest_pin_url": f"https://www.pinterest.com/pin/{pin_id}/",
        "evidence_type": "source_pin",
        "relationship_method": "direct_outbound_link",
        "provenance": {
            "pdp_gate_passed": True,
            "image_found_in_merchant_page": True,
            "merchant_page_url": canonical,
            "product_image_url": image,
            "merchant_page_sha256": hashlib.sha256(b"local merchant page").hexdigest(),
            "verified_by": "repo-local-postgres-v37",
            "source_category": "fashion",
            "pinterest_pin_id": pin_id,
            "pin_direct_outbound_url": canonical,
            "source_pin_id": pin_id,
            "source_pin_direct_outbound_url": canonical,
            "merchant_field_evidence": ["merchant:structured-data"],
            "merchant_found_in_page": True,
            "merchant_value": "Merchant",
        },
        "additional_evidence": [],
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    if not args.execute_local:
        raise RuntimeError("local replay requires --execute-local")
    expected_confirmation = confirmation_value(args.host, args.port, args.database)
    if args.confirm != expected_confirmation:
        raise RuntimeError(f"local replay confirmation must equal {expected_confirmation}")
    hashes = _verify_hashes()
    client = LocalPsql(
        executable=args.psql,
        host=args.host,
        port=args.port,
        user=args.user,
        database=args.database,
    )
    version = client.scalar("SELECT current_setting('server_version_num');", label="version")
    if not version.startswith("17"):
        raise RuntimeError(f"expected PostgreSQL 17, got server_version_num={version}")
    empty = client.scalar(
        "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema');",
        label="fresh-cluster",
    )
    if empty != "0":
        raise RuntimeError("local replay requires a fresh database with zero user tables")

    migration_applied = False
    fixture_created = False
    report: dict[str, Any] = {}
    failure: BaseException | None = None
    try:
        client.require(FIXTURE_SQL, label="fixture")
        fixture_created = True
        legacy_before = client.scalar(
            "SELECT json_build_object('products', (SELECT count(*) FROM pin_products), "
            "'snapshots', (SELECT count(*) FROM pin_save_snapshots), "
            "'product_marker', (SELECT marker FROM pin_products WHERE id=1), "
            "'snapshot_marker', (SELECT marker FROM pin_save_snapshots WHERE id=1));",
            label="legacy-before",
        )
        pre_catalog = len([line for line in client.require(
            _canonical_bytes(CATALOG).decode(), label="pre-catalog",
        ).splitlines() if line])
        if pre_catalog != 0:
            raise RuntimeError(f"expected zero pre-migration v63 objects, got {pre_catalog}")

        client.require(_canonical_bytes(MIGRATION).decode(), label="migration", timeout=120)
        migration_applied = True
        post_catalog = len([line for line in client.require(
            _canonical_bytes(CATALOG).decode(), label="post-catalog",
        ).splitlines() if line])
        if post_catalog == 0:
            raise RuntimeError("post-migration catalog query returned zero v63 objects")
        contract = json.loads(client.scalar(
            _canonical_bytes(POST_APPLY).decode(), label="post-apply-contract",
        ))
        expected_contract_lengths = {
            "relations": 10,
            "functions": 18,
            "triggers": 9,
            "policies": 3,
            "indexes": 4,
            "constraints": 91,
        }
        actual_contract_lengths = {
            key: len(contract.get(key, [])) for key in expected_contract_lengths
        }
        if actual_contract_lengths != expected_contract_lengths:
            raise RuntimeError(
                "post-apply schema contract mismatch: "
                f"expected={expected_contract_lengths} actual={actual_contract_lengths}"
            )
        privilege_count = len(contract.get("privileges", {}))
        if privilege_count != 44:
            raise RuntimeError(f"expected 44 privilege facts, got {privilege_count}")
        row_counts = contract.get("row_counts", {})
        expected_zero_rows = {
            "products", "preview_history", "evidence", "evidence_snapshots",
            "evidence_switches", "metrics", "calibrations", "release_gates", "saved",
        }
        if any(int(row_counts.get(key, -1)) != 0 for key in expected_zero_rows):
            raise RuntimeError("post-apply contract found non-empty v63 tables")
        if int(row_counts.get("legacy_products", -1)) != 1 or int(
            row_counts.get("legacy_snapshots", -1)
        ) != 1:
            raise RuntimeError("post-apply contract changed legacy fixture counts")

        manifest_sha = hashlib.sha256(MANIFEST.read_bytes()).hexdigest()
        canary_report = canary.execute_canary(
            candidate=_candidate(),
            manifest_sha256=manifest_sha,
            token="local-no-token",
            project_ref=LOCAL_PROJECT_REF,
            query=client,
        )
        advisory_locks = client.scalar(
            "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND granted;",
            label="advisory-locks",
        )
        other_sessions = client.scalar(
            "SELECT count(*) FROM pg_stat_activity "
            "WHERE datname=current_database() AND pid<>pg_backend_pid();",
            label="other-sessions",
        )
        if advisory_locks != "0" or other_sessions != "0":
            raise RuntimeError(
                f"local canary leaked locks/sessions: locks={advisory_locks} sessions={other_sessions}"
            )

        client.require(_canonical_bytes(ROLLBACK).decode(), label="rollback", timeout=120)
        migration_applied = False
        after_catalog = len([line for line in client.require(
            _canonical_bytes(CATALOG).decode(), label="after-catalog",
        ).splitlines() if line])
        legacy_after = client.scalar(
            "SELECT json_build_object('products', (SELECT count(*) FROM pin_products), "
            "'snapshots', (SELECT count(*) FROM pin_save_snapshots), "
            "'product_marker', (SELECT marker FROM pin_products WHERE id=1), "
            "'snapshot_marker', (SELECT marker FROM pin_save_snapshots WHERE id=1));",
            label="legacy-after",
        )
        if after_catalog != 0 or legacy_after != legacy_before:
            raise RuntimeError("schema rollback left v63 objects or changed legacy fixtures")

        report = {
            "schemaVersion": 1,
            "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "target": "isolated-local-postgresql",
            "networkBinding": f"{args.host}:{args.port}",
            "database": args.database,
            "confirmationBinding": expected_confirmation,
            "serverVersionNum": version,
            "canonicalSqlSha256": hashes,
            "manifestPath": str(MANIFEST.relative_to(ROOT)).replace("\\", "/"),
            "manifestSha256": manifest_sha,
            "catalogObjects": {"before": pre_catalog, "afterApply": post_catalog, "afterRollback": after_catalog},
            "schemaContract": {
                **actual_contract_lengths,
                "privileges": privilege_count,
                "newTablesEmpty": True,
            },
            "legacyBefore": json.loads(legacy_before),
            "legacyAfter": json.loads(legacy_after),
            "canary": canary_report,
            "advisoryLocksAfterCanary": int(advisory_locks),
            "otherDatabaseSessionsAfterCanary": int(other_sessions),
            "productionAccess": False,
            "productionMutation": False,
            "verdict": "PASS",
        }
    except BaseException as exc:
        failure = exc
    finally:
        if migration_applied:
            try:
                client.require(_canonical_bytes(ROLLBACK).decode(), label="failure-rollback", timeout=120)
                migration_applied = False
            except BaseException as rollback_exc:
                if failure is None:
                    failure = rollback_exc
                else:
                    failure.add_note(f"failure rollback also failed: {rollback_exc}")
        if fixture_created:
            try:
                client.require(CLEANUP_SQL, label="fixture-cleanup")
                fixture_created = False
            except BaseException as cleanup_exc:
                if failure is None:
                    failure = cleanup_exc
                else:
                    failure.add_note(f"fixture cleanup also failed: {cleanup_exc}")

    if failure is not None:
        raise failure
    final_tables = client.scalar(
        "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema');",
        label="final-user-tables",
    )
    final_roles = client.scalar(
        "SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role');",
        label="final-fixture-roles",
    )
    if final_tables != "0" or final_roles != "0":
        raise RuntimeError(f"local cleanup incomplete: tables={final_tables} roles={final_roles}")
    report["cleanup"] = {"userTables": 0, "fixtureRoles": 0}
    args.report_out.parent.mkdir(parents=True, exist_ok=True)
    args.report_out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n")
    return report


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute-local", action="store_true")
    parser.add_argument("--psql", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--user", required=True)
    parser.add_argument("--database", default=LOCAL_DATABASE)
    parser.add_argument("--confirm", required=True)
    parser.add_argument("--report-out", type=Path, required=True)
    return parser


def main() -> int:
    args = _parser().parse_args()
    report = run(args)
    print(json.dumps({
        "verdict": report["verdict"],
        "target": report["target"],
        "serverVersionNum": report["serverVersionNum"],
        "productionMutation": report["productionMutation"],
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
