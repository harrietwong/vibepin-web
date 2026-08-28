from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest


BACKEND = Path(__file__).parents[1]
SCRIPT = BACKEND / "scripts" / "canary_product_opportunity_postgres_v37.py"
SPEC = importlib.util.spec_from_file_location("postgres_canary_v37_under_test", SCRIPT)
assert SPEC and SPEC.loader
canary = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = canary
SPEC.loader.exec_module(canary)


IDENTITY = "a" * 64
MANIFEST_SHA = "b" * 64


def candidate() -> dict:
    return {
        "canonical_url_hash": IDENTITY,
        "canonical_product_url": "https://merchant.example/product",
    }


def state(current: int = 0) -> dict:
    return {
        "product_rows": 2,
        "current_rows": current,
        "retired_rows": 2,
        "saved_rows": 0,
    }


def response(value: dict) -> tuple[int, str]:
    return 201, json.dumps([value])


def valid_query(sql: str, *, label: str, **_: object) -> tuple[int, str]:
    if label in {"baseline", "after_concurrency", "final"}:
        return response({"identity_state": state()})
    if label == "holder_ready":
        return response({"holder_ready": True})
    if label == "concurrency_holder":
        return 201, "[]"
    if label == "concurrency_challenger":
        return 400, '{"message":"canceling statement due to lock timeout"}'
    if label == "role_isolation":
        return 400, json.dumps({"code": "P0001", "message": canary.ROLE_PASS_SENTINEL})
    raise AssertionError(label)


def test_sql_contract_is_rollback_only_and_tests_real_boundaries() -> None:
    holder = canary._holder_sql(candidate(), 42)
    challenger = canary._challenger_sql(candidate())
    role = canary._role_canary_sql(candidate())
    assert "BEGIN;" in holder and holder.endswith("ROLLBACK;") and "COMMIT" not in holder
    assert "pg_advisory_xact_lock(42)" in holder
    assert "lock_timeout" in challenger and challenger.endswith("ROLLBACK;")
    assert "SET LOCAL ROLE authenticated" in role
    assert "SET LOCAL ROLE anon" in role
    assert "request.jwt.claim.sub" in role and "request.jwt.claims" in role
    assert "insufficient_privilege" in role
    assert canary.ROLE_PASS_SENTINEL in role
    assert "COMMIT" not in role


def test_execute_canary_accepts_only_exact_lock_and_role_sentinel() -> None:
    report = canary.execute_canary(
        candidate=candidate(),
        manifest_sha256=MANIFEST_SHA,
        token="fake-token",
        project_ref="projectref",
        query=valid_query,
        sleep=lambda _: None,
    )
    assert report["verdict"] == "PASS"
    assert report["productionRowsPersisted"] == 0
    assert report["before"] == report["after"] == state()
    assert report["concurrency"]["duplicateBlockedByActiveIdentity"] is True
    assert report["roleIsolation"]["authenticatedDirectWriteBlocked"] is True


@pytest.mark.parametrize(
    ("bad_label", "bad_response", "message"),
    [
        ("concurrency_holder", (500, "holder failed"), "holder did not roll back"),
        ("concurrency_challenger", (201, "[]"), "concurrent duplicate"),
        ("concurrency_challenger", (400, "other failure"), "concurrent duplicate"),
        ("role_isolation", (201, "[]"), "role-isolation"),
        ("role_isolation", (400, '{"code":"P0001","message":"wrong sentinel"}'), "role-isolation"),
    ],
)
def test_execute_canary_fails_closed_on_ambiguous_results(
    bad_label: str,
    bad_response: tuple[int, str],
    message: str,
) -> None:
    def query(sql: str, *, label: str, **kwargs: object) -> tuple[int, str]:
        if label == bad_label:
            return bad_response
        return valid_query(sql, label=label, **kwargs)

    with pytest.raises(RuntimeError, match=message):
        canary.execute_canary(
            candidate=candidate(),
            manifest_sha256=MANIFEST_SHA,
            token="fake-token",
            project_ref="projectref",
            query=query,
            sleep=lambda _: None,
        )


def test_execute_canary_rejects_preexisting_current_identity() -> None:
    def query(sql: str, *, label: str, **kwargs: object) -> tuple[int, str]:
        if label == "baseline":
            return response({"identity_state": state(current=1)})
        return valid_query(sql, label=label, **kwargs)

    with pytest.raises(RuntimeError, match="already has a current"):
        canary.execute_canary(
            candidate=candidate(),
            manifest_sha256=MANIFEST_SHA,
            token="fake-token",
            project_ref="projectref",
            query=query,
        )


def test_execute_canary_rejects_any_post_probe_state_drift() -> None:
    def query(sql: str, *, label: str, **kwargs: object) -> tuple[int, str]:
        if label == "after_concurrency":
            return response({"identity_state": state(current=1)})
        return valid_query(sql, label=label, **kwargs)

    with pytest.raises(RuntimeError, match="changed Product"):
        canary.execute_canary(
            candidate=candidate(),
            manifest_sha256=MANIFEST_SHA,
            token="fake-token",
            project_ref="projectref",
            query=query,
            sleep=lambda _: None,
        )


def test_role_canary_rejects_failure_that_echoes_the_sentinel_sql() -> None:
    echoed = canary._role_canary_sql(candidate())

    def query(sql: str, *, label: str, **kwargs: object) -> tuple[int, str]:
        if label == "role_isolation":
            return 400, json.dumps({
                "code": "42501",
                "message": "permission boundary failed",
                "query": echoed,
            })
        return valid_query(sql, label=label, **kwargs)

    with pytest.raises(RuntimeError, match="exact rollback sentinel"):
        canary.execute_canary(
            candidate=candidate(),
            manifest_sha256=MANIFEST_SHA,
            token="fake-token",
            project_ref="projectref",
            query=query,
            sleep=lambda _: None,
        )


@pytest.mark.parametrize(
    "body",
    [
        "not-json",
        "[]",
        '{"message":"V37_ROLE_CANARY_PASS"}',
        '{"code":"P0001"}',
    ],
)
def test_role_canary_requires_structured_postgres_code_and_message(body: str) -> None:
    with pytest.raises(RuntimeError):
        canary._parse_pg_error(body)


def test_role_canary_accepts_nested_structured_postgres_error() -> None:
    assert canary._parse_pg_error(
        '{"error":{"code":"P0001","message":"V37_ROLE_CANARY_PASS"}}'
    ) == ("P0001", canary.ROLE_PASS_SENTINEL)


def test_execution_guard_requires_four_exact_bindings(monkeypatch: pytest.MonkeyPatch) -> None:
    migration = canary.EXPECTED_MIGRATION_SHA256
    project = "projectref"
    monkeypatch.setenv(canary.EXECUTION_MODE_ENV, canary.EXECUTION_MODE_VALUE)
    confirm = canary.confirmation_value(project, MANIFEST_SHA, migration)
    assert canary._guard_execution(
        project_ref=project,
        expected_project_ref=project,
        manifest_sha256=MANIFEST_SHA,
        migration_sha256=migration,
        expected_migration_sha256=migration,
        confirm=confirm,
    ) == project

    mutations = [
        {"expected_project_ref": "otherref"},
        {"expected_migration_sha256": "c" * 64},
        {"confirm": "CANARY:wrong"},
    ]
    defaults = {
        "project_ref": project,
        "expected_project_ref": project,
        "manifest_sha256": MANIFEST_SHA,
        "migration_sha256": migration,
        "expected_migration_sha256": migration,
        "confirm": confirm,
    }
    for mutation in mutations:
        with pytest.raises(RuntimeError, match="execute refused"):
            canary._guard_execution(**{**defaults, **mutation})

    monkeypatch.delenv(canary.EXECUTION_MODE_ENV)
    with pytest.raises(RuntimeError, match=canary.EXECUTION_MODE_ENV):
        canary._guard_execution(**defaults)


def test_default_cli_plan_has_no_network_or_production_mutation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    fixture = {
        "canonical_url_hash": IDENTITY,
    }
    manifest = tmp_path / "one.json"
    manifest.write_text(json.dumps([fixture]), encoding="utf-8")
    monkeypatch.setattr(
        canary,
        "_load_one_candidate",
        lambda path: (fixture, MANIFEST_SHA),
    )
    monkeypatch.setattr(sys, "argv", [str(SCRIPT), "--manifest", str(manifest)])
    assert canary.main() == 0
    output = json.loads(capsys.readouterr().out)
    assert output["mode"] == "plan"
    assert output["networkAccess"] is False
    assert output["productionMutation"] is False


def test_json_sql_literal_escapes_apostrophes() -> None:
    literal = canary._sql_json({"product_name": "Maker's item"})
    assert "Maker''s item" in literal
    assert literal.endswith("::jsonb")
