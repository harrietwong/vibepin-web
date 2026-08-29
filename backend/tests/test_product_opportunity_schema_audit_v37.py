from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest


BACKEND = Path(__file__).parents[1]
SCRIPTS = BACKEND / "scripts"
sys.path.insert(0, str(SCRIPTS))
SCRIPT = SCRIPTS / "audit_product_opportunity_schema_v37.py"
SPEC = importlib.util.spec_from_file_location("schema_audit_v37_under_test", SCRIPT)
assert SPEC and SPEC.loader
schema_audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(schema_audit)


def valid_contract(products: int = 4115, snapshots: int = 34073) -> dict:
    return {
        "relations": [
            {"name": name, "kind": kind, "rls_enabled": rls}
            for name, (kind, rls) in schema_audit.RELATIONS.items()
        ],
        "functions": [
            {
                "name": name,
                "identity_arguments": schema_audit.FUNCTION_SIGNATURES[name],
                "security_definer": name in schema_audit.SECURITY_DEFINER_FUNCTIONS,
            }
            for name in schema_audit.FUNCTIONS
        ],
        "triggers": [
            {
                "name": name,
                "table_name": table,
                "enabled": "O",
                "deferrable": deferred,
                "initially_deferred": deferred,
            }
            for name, (table, deferred) in schema_audit.TRIGGERS.items()
        ],
        "policies": [
            {
                "name": name,
                "table_name": "saved_product_opportunities",
                "cmd": command,
                "permissive": "PERMISSIVE",
                "roles": ["public"],
            }
            for name, command in schema_audit.POLICIES.items()
        ],
        "indexes": [
            {"name": name, "is_unique": True, "is_partial": partial}
            for name, partial in schema_audit.INDEXES.items()
        ],
        "constraints": [
            {
                "name": name,
                "type": "c",
                "table_name": "fixture",
                "deferrable": name == "trg_enforce_active_product_evidence_at_commit",
                "initially_deferred": name == "trg_enforce_active_product_evidence_at_commit",
            }
            for name in schema_audit.CRITICAL_CONSTRAINTS
        ],
        "privileges": dict(schema_audit.PRIVILEGES),
        "row_counts": {
            **{key: 0 for key in schema_audit.NEW_ROW_COUNT_KEYS},
            "legacy_products": products,
            "legacy_snapshots": snapshots,
            "legacy_products_md5": "a" * 32,
            "legacy_snapshots_md5": "b" * 32,
        },
    }


def test_valid_complete_contract_passes() -> None:
    assert schema_audit.validate_contract(
        valid_contract(),
        expected_legacy_products=4115,
        expected_legacy_snapshots=34073,
        expected_legacy_products_md5="a" * 32,
        expected_legacy_snapshots_md5="b" * 32,
    ) == []


@pytest.mark.parametrize(
    "mutation",
    [
        lambda value: value["relations"].pop(),
        lambda value: value["functions"].append(copy.deepcopy(value["functions"][0])),
        lambda value: value["functions"][0].update(identity_arguments="wrong text"),
        lambda value: value["triggers"][0].update(enabled="D"),
        lambda value: value["policies"][0].update(cmd="ALL"),
        lambda value: value["policies"][0].update(roles=["authenticated"]),
        lambda value: value["indexes"][0].update(is_partial=False),
        lambda value: value["constraints"].pop(),
        lambda value: value["privileges"].update(authenticated_admit_execute=True),
        lambda value: value["row_counts"].update(products=1),
        lambda value: value["row_counts"].update(legacy_products=4114),
    ],
)
def test_every_contract_family_fails_closed(mutation) -> None:
    contract = valid_contract()
    mutation(contract)
    assert schema_audit.validate_contract(
        contract,
        expected_legacy_products=4115,
        expected_legacy_snapshots=34073,
        expected_legacy_products_md5="a" * 32,
        expected_legacy_snapshots_md5="b" * 32,
    )


def test_versioned_query_covers_all_expected_runtime_objects() -> None:
    query = schema_audit.POST_APPLY_QUERY_PATH.read_text(encoding="utf-8")
    for name in (
        set(schema_audit.RELATIONS)
        | schema_audit.FUNCTIONS
        | set(schema_audit.INDEXES)
    ):
        assert name in query
    assert "t.tgname LIKE 'trg_%product%'" in query
    assert "tablename = 'saved_product_opportunities'" in query
    for required_catalog in (
        "pg_catalog.pg_class",
        "pg_catalog.pg_proc",
        "pg_catalog.pg_trigger",
        "pg_catalog.pg_policies",
        "pg_catalog.pg_index",
        "pg_catalog.pg_constraint",
        "has_table_privilege",
        "has_function_privilege",
        "has_sequence_privilege",
    ):
        assert required_catalog in query
    for table in (
        "public.pin_products",
        "public.pin_save_snapshots",
        "public.product_opportunities",
        "public.product_opportunity_evidence",
        "public.saved_product_opportunities",
    ):
        assert f"FROM {table}" in query
    assert "legacy_products_md5" in query
    assert "legacy_snapshots_md5" in query

    baseline_query = schema_audit.BASELINE_QUERY_PATH.read_text(encoding="utf-8")
    for catalog in (
        "pg_catalog.pg_class",
        "pg_catalog.pg_proc",
        "pg_catalog.pg_trigger",
        "pg_catalog.pg_policies",
        "pg_catalog.pg_constraint",
    ):
        assert catalog in baseline_query
    assert "v63_matching_object_count" in baseline_query
    assert "legacy_products_md5" in baseline_query
    assert "legacy_snapshots_md5" in baseline_query


def test_main_emits_pass_only_for_one_exact_response(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    query_sha = schema_audit._load_canonical_sql(schema_audit.POST_APPLY_QUERY_PATH)[1]
    baseline_path = tmp_path / "baseline.json"
    baseline_path.write_text(
        json.dumps(
            {
                "audited_at": datetime.now(timezone.utc).isoformat(),
                "candidate_sha": "a" * 40,
                "project_ref": "prodref",
                "mutation": False,
                "verdict": "PASS",
                "baseline": {
                    "legacy_products": 4115,
                    "legacy_snapshots": 34073,
                    "legacy_products_md5": "a" * 32,
                    "legacy_snapshots_md5": "b" * 32,
                    "v63_matching_object_count": 0,
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        schema_audit,
        "load_credentials",
        lambda: {"SUPABASE_MIGRATION_TOKEN": "not-a-real-token"},
    )
    monkeypatch.setattr(
        schema_audit,
        "_mgmt_query",
        lambda *args, **kwargs: (201, json.dumps([{"contract": valid_contract()}])),
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            str(SCRIPT),
            "post-apply",
            "--project-ref",
            "prodref",
            "--expected-project-ref",
            "prodref",
            "--expected-query-sha256",
            query_sha,
            "--candidate-sha",
            "a" * 40,
            "--baseline-receipt",
            str(baseline_path),
            "--expected-baseline-sha256",
            hashlib.sha256(baseline_path.read_bytes()).hexdigest(),
        ],
    )
    assert schema_audit.main() == 0
    report = json.loads(capsys.readouterr().out)
    assert report["verdict"] == "PASS"
    assert report["mutation"] is False
    assert report["violations"] == []
    assert report["contract"]["row_counts"]["legacy_products"] == 4115


def test_baseline_mode_preserves_counts_hashes_and_absence(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    query_sha = schema_audit._load_canonical_sql(schema_audit.BASELINE_QUERY_PATH)[1]
    baseline = {
        "legacy_products": 4115,
        "legacy_snapshots": 34073,
        "legacy_products_md5": "a" * 32,
        "legacy_snapshots_md5": "b" * 32,
        "v63_matching_object_count": 0,
    }
    monkeypatch.setattr(
        schema_audit,
        "load_credentials",
        lambda: {"SUPABASE_MIGRATION_TOKEN": "not-a-real-token"},
    )
    monkeypatch.setattr(
        schema_audit,
        "_mgmt_query",
        lambda *args, **kwargs: (201, json.dumps([{"baseline": baseline}])),
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            str(SCRIPT),
            "baseline",
            "--project-ref",
            "prodref",
            "--expected-project-ref",
            "prodref",
            "--expected-query-sha256",
            query_sha,
            "--candidate-sha",
            "a" * 40,
        ],
    )
    assert schema_audit.main() == 0
    report = json.loads(capsys.readouterr().out)
    assert report["verdict"] == "PASS"
    assert report["baseline"] == baseline


def test_tampered_baseline_blocks_before_management_api(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    baseline_path = tmp_path / "baseline.json"
    baseline_path.write_text("{}", encoding="utf-8")
    calls = 0

    def forbidden_query(*args, **kwargs):
        nonlocal calls
        calls += 1
        raise AssertionError("must fail before Management API")

    monkeypatch.setattr(schema_audit, "_mgmt_query", forbidden_query)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            str(SCRIPT),
            "post-apply",
            "--project-ref",
            "prodref",
            "--expected-project-ref",
            "prodref",
            "--expected-query-sha256",
            schema_audit._load_canonical_sql(schema_audit.POST_APPLY_QUERY_PATH)[1],
            "--candidate-sha",
            "a" * 40,
            "--baseline-receipt",
            str(baseline_path),
            "--expected-baseline-sha256",
            "f" * 64,
        ],
    )
    assert schema_audit.main() == 1
    assert calls == 0
    assert json.loads(capsys.readouterr().out)["verdict"] == "BLOCK"


def test_main_rejects_query_hash_before_management_api(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    def forbidden_query(*args, **kwargs):
        nonlocal calls
        calls += 1
        raise AssertionError("must fail before Management API")

    monkeypatch.setattr(schema_audit, "_mgmt_query", forbidden_query)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            str(SCRIPT),
            "post-apply",
            "--project-ref",
            "prodref",
            "--expected-project-ref",
            "prodref",
            "--expected-query-sha256",
            "0" * 64,
            "--candidate-sha",
            "a" * 40,
            "--baseline-receipt",
            str(tmp_path / "not-read-before-hash-mismatch.json"),
            "--expected-baseline-sha256",
            "f" * 64,
        ],
    )
    with pytest.raises(SystemExit):
        schema_audit.main()
    assert calls == 0
