from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest


BACKEND = Path(__file__).parents[1]
SCRIPT = (
    BACKEND
    / "tests"
    / "postgres_v37"
    / "replay_product_opportunity_supabase_test_v37.py"
)
SPEC = importlib.util.spec_from_file_location("supabase_test_replay_v37", SCRIPT)
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runner
SPEC.loader.exec_module(runner)


TARGET = "testprojectref123456"
PRODUCTION = "prodprojectref123456"
MANIFEST_SHA = "a" * 64
CANDIDATE = {
    "canonical_product_url": "https://merchant.example/products/reviewed-canary",
    "canonical_url_hash": "b" * 64,
}


def projects(*, name: str = "VibePin Test", status: str = "ACTIVE_HEALTHY") -> list[dict]:
    return [
        {
            "ref": PRODUCTION,
            "name": "VibePin Production",
            "status": "ACTIVE_HEALTHY",
            "organization_id": "org-1",
        },
        {
            "ref": TARGET,
            "name": name,
            "status": status,
            "organization_id": "org-1",
            "region": "test-region",
        },
    ]


def response(value: object) -> tuple[int, str]:
    return 201, json.dumps(value)


class FakeQuery:
    def __init__(
        self,
        *,
        before_catalog_count: int = 0,
        prerequisite_overrides: dict[str, object] | None = None,
        apply_status: int = 201,
        after_apply_count: int = runner.EXPECTED_POST_APPLY_CATALOG_OBJECTS,
        rollback_status: int = 201,
        final_catalog_count: int = 0,
    ) -> None:
        self.before_catalog_count = before_catalog_count
        self.prerequisite_overrides = prerequisite_overrides or {}
        self.apply_status = apply_status
        self.after_apply_count = after_apply_count
        self.rollback_status = rollback_status
        self.final_catalog_count = final_catalog_count
        self.labels: list[str] = []

    def __call__(self, sql: str, *, label: str, **_: object) -> tuple[int, str]:
        self.labels.append(label)
        if label == "catalog_before":
            return response([{}] * self.before_catalog_count)
        if label == "prerequisites":
            prerequisites = {
                "serverVersionNum": "170006",
                "authUserCount": 19,
                "authUsersRelation": True,
                "authUidFunction": True,
                "anonRole": True,
                "authenticatedRole": True,
                "pgcryptoInstalled": True,
                "legacyPinProducts": False,
                "legacyPinSaveSnapshots": False,
            }
            prerequisites.update(self.prerequisite_overrides)
            return response([{"prerequisites": prerequisites}])
        if label == "migration_apply":
            return self.apply_status, "[]"
        if label == "catalog_after_apply":
            return response([{}] * self.after_apply_count)
        if label == "schema_rollback":
            return self.rollback_status, "[]"
        if label == "catalog_after_rollback":
            return response([{}] * self.final_catalog_count)
        raise AssertionError(label)


def list_projects(_: str) -> list[dict]:
    return projects()


def canary_pass(**_: object) -> dict:
    return {
        "projectRef": TARGET,
        "verdict": "PASS",
        "productionRowsPersisted": 0,
    }


def execute(query: FakeQuery, **kwargs: object) -> dict:
    return runner.execute_test_replay(
        candidate=CANDIDATE,
        manifest_sha256=MANIFEST_SHA,
        token="fake-token",
        target_ref=TARGET,
        production_ref=PRODUCTION,
        query=query,
        list_projects=kwargs.pop("list_projects", list_projects),
        execute_canary=kwargs.pop("execute_canary", canary_pass),
        **kwargs,
    )


def test_success_applies_canaries_rolls_back_and_redacts_project() -> None:
    query = FakeQuery()
    report = execute(query)
    assert report["verdict"] == "PASS"
    assert report["databaseRowsPersisted"] == 0
    assert report["catalogObjects"] == {
        "before": 0,
        "afterApply": runner.EXPECTED_POST_APPLY_CATALOG_OBJECTS,
        "afterRollback": 0,
    }
    assert report["projectRefPrefix"] == TARGET[:6]
    assert TARGET not in json.dumps(report)
    assert query.labels == [
        "catalog_before",
        "prerequisites",
        "migration_apply",
        "catalog_after_apply",
        "schema_rollback",
        "catalog_after_rollback",
    ]


@pytest.mark.parametrize(
    "bad_projects",
    [
        projects(name="VibePin Live Mirror"),
        projects(name="VibePin Latest Production"),
        projects(status="INACTIVE"),
        [projects()[0]],
    ],
)
def test_metadata_guard_rejects_ambiguous_target_before_sql(bad_projects: list[dict]) -> None:
    query = FakeQuery()
    with pytest.raises(RuntimeError):
        execute(query, list_projects=lambda _: bad_projects)
    assert query.labels == []


def test_production_target_is_always_rejected_before_sql() -> None:
    query = FakeQuery()
    with pytest.raises(RuntimeError, match="production"):
        runner.execute_test_replay(
            candidate=CANDIDATE,
            manifest_sha256=MANIFEST_SHA,
            token="fake-token",
            target_ref=PRODUCTION,
            production_ref=PRODUCTION,
            query=query,
            list_projects=lambda _: projects(),
            execute_canary=canary_pass,
        )
    assert query.labels == []


def test_apply_failure_still_runs_exact_cleanup() -> None:
    query = FakeQuery(apply_status=400)
    with pytest.raises(RuntimeError, match="migration apply"):
        execute(query)
    assert query.labels[-2:] == ["schema_rollback", "catalog_after_rollback"]


def test_nonempty_catalog_refuses_before_apply() -> None:
    query = FakeQuery(before_catalog_count=1)
    with pytest.raises(RuntimeError, match="already contains"):
        execute(query)
    assert query.labels == ["catalog_before"]


@pytest.mark.parametrize(
    "overrides",
    [
        {"authUsersRelation": False},
        {"authUidFunction": False},
        {"anonRole": False},
        {"authenticatedRole": False},
        {"pgcryptoInstalled": False},
        {"authUserCount": 1},
        {"serverVersionNum": "160010"},
        {"serverVersionNum": "not-a-version"},
    ],
)
def test_prerequisite_failure_refuses_before_apply(overrides: dict[str, object]) -> None:
    query = FakeQuery(prerequisite_overrides=overrides)
    with pytest.raises(RuntimeError):
        execute(query)
    assert query.labels == ["catalog_before", "prerequisites"]


def test_wrong_post_apply_catalog_count_rolls_back_and_refuses_pass() -> None:
    query = FakeQuery(after_apply_count=157)
    with pytest.raises(RuntimeError, match="catalog count"):
        execute(query)
    assert query.labels[-2:] == ["schema_rollback", "catalog_after_rollback"]


@pytest.mark.parametrize(
    "bad_report",
    [
        {"verdict": "BLOCK", "productionRowsPersisted": 0},
        {"verdict": "PASS", "productionRowsPersisted": 1},
    ],
)
def test_nonexception_canary_failure_rolls_back_and_refuses_pass(
    bad_report: dict[str, object],
) -> None:
    query = FakeQuery()
    with pytest.raises(RuntimeError, match="zero-write PASS"):
        execute(query, execute_canary=lambda **_: bad_report)
    assert query.labels[-2:] == ["schema_rollback", "catalog_after_rollback"]


def test_canary_failure_still_runs_exact_cleanup() -> None:
    query = FakeQuery()

    def fail(**_: object) -> dict:
        raise RuntimeError("canary failed")

    with pytest.raises(RuntimeError, match="canary failed"):
        execute(query, execute_canary=fail)
    assert query.labels[-2:] == ["schema_rollback", "catalog_after_rollback"]


def test_cleanup_failure_overrides_pass_and_cannot_emit_receipt() -> None:
    query = FakeQuery(final_catalog_count=1)
    with pytest.raises(RuntimeError, match="cleanup failed"):
        execute(query)


def test_primary_and_cleanup_failure_are_both_reported() -> None:
    query = FakeQuery(apply_status=400, rollback_status=500)
    with pytest.raises(RuntimeError, match="cleanup also failed"):
        execute(query)


def test_confirmation_binds_target_manifest_migration_and_rollback() -> None:
    value = runner.confirmation_value(
        TARGET,
        MANIFEST_SHA,
        runner.EXPECTED_SHA256[runner.MIGRATION],
        runner.EXPECTED_SHA256[runner.ROLLBACK],
    )
    assert value.startswith(f"TEST-V37-ROLLBACK-ONLY:{TARGET}:{MANIFEST_SHA}:")


def test_execution_guard_rejects_every_mismatch_before_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    migration = runner.EXPECTED_SHA256[runner.MIGRATION]
    rollback = runner.EXPECTED_SHA256[runner.ROLLBACK]
    confirm = runner.confirmation_value(TARGET, MANIFEST_SHA, migration, rollback)
    defaults = {
        "target_ref": TARGET,
        "expected_target_ref": TARGET,
        "manifest_sha256": MANIFEST_SHA,
        "migration_sha256": migration,
        "rollback_sha256": rollback,
        "expected_migration_sha256": migration,
        "expected_rollback_sha256": rollback,
        "confirm": confirm,
    }
    monkeypatch.setenv(runner.EXECUTION_MODE_ENV, runner.EXECUTION_MODE_VALUE)
    assert runner._guard_execution(**defaults) == TARGET
    mutations = [
        {"expected_target_ref": "otherprojectref123"},
        {"expected_migration_sha256": "c" * 64},
        {"expected_rollback_sha256": "d" * 64},
        {"confirm": "wrong"},
    ]
    for mutation in mutations:
        with pytest.raises(RuntimeError):
            runner._guard_execution(**{**defaults, **mutation})
    monkeypatch.delenv(runner.EXECUTION_MODE_ENV)
    with pytest.raises(RuntimeError, match=runner.EXECUTION_MODE_ENV):
        runner._guard_execution(**defaults)


def test_runner_uses_shared_canonicalizer_for_cr_and_bom_rules(tmp_path: Path) -> None:
    cr = tmp_path / "cr.sql"
    cr.write_bytes(b"SELECT 1;\rSELECT 2;\r\n")
    text, digest = runner._load_canonical_sql(cr)
    assert text == "SELECT 1;\nSELECT 2;\n"
    assert digest == runner.hashlib.sha256(text.encode()).hexdigest()

    bom = tmp_path / "bom.sql"
    bom.write_bytes(b"\xef\xbb\xbfSELECT 1;")
    with pytest.raises(SystemExit):
        runner._load_canonical_sql(bom)


def test_prerequisite_query_is_read_only_and_scope_is_explicit() -> None:
    sql = runner.PREREQUISITE_SQL.upper()
    assert sql.startswith("SELECT ")
    assert not any(word in sql for word in ("INSERT ", "UPDATE ", "DELETE ", "DROP ", "ALTER "))
    assert "pin_products" in runner.PREREQUISITE_SQL
    assert "pin_save_snapshots" in runner.PREREQUISITE_SQL
