from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


SCRIPT = Path(__file__).parents[1] / "scripts" / "run_migration.py"
SPEC = importlib.util.spec_from_file_location("run_migration_under_test", SCRIPT)
assert SPEC and SPEC.loader
run_migration = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(run_migration)


def _sql(tmp_path: Path, content: bytes = b"BEGIN;\r\nSELECT 1;\r\nCOMMIT;\r\n") -> Path:
    path = tmp_path / "migration.sql"
    path.write_bytes(content)
    return path


def test_canonical_hash_is_independent_of_checkout_line_endings(tmp_path: Path) -> None:
    crlf = _sql(tmp_path)
    lf = tmp_path / "migration-lf.sql"
    lf.write_bytes(b"BEGIN;\nSELECT 1;\nCOMMIT;\n")
    crlf_text, crlf_hash = run_migration._load_canonical_sql(crlf)
    lf_text, lf_hash = run_migration._load_canonical_sql(lf)
    assert crlf_text == lf_text
    assert crlf_hash == lf_hash


@pytest.mark.parametrize(
    ("explicit_ref", "expected_ref", "expected_hash", "confirmation"),
    [
        (None, "prodref", "a" * 64, "APPLY:prodref:" + "a" * 64),
        ("prodref", None, "a" * 64, "APPLY:prodref:" + "a" * 64),
        ("prodref", "wrongref", "a" * 64, "APPLY:prodref:" + "a" * 64),
        ("prodref", "prodref", None, "APPLY:prodref:" + "a" * 64),
        ("prodref", "prodref", "A" * 64, "APPLY:prodref:" + "a" * 64),
        ("prodref", "prodref", "b" * 64, "APPLY:prodref:" + "b" * 64),
        ("prodref", "prodref", "a" * 64, "APPLY:another:" + "a" * 64),
    ],
)
def test_apply_guard_fails_closed(
    explicit_ref: str | None,
    expected_ref: str | None,
    expected_hash: str | None,
    confirmation: str | None,
) -> None:
    with pytest.raises(SystemExit):
        run_migration._guard_apply_target(
            ref="prodref",
            explicit_project_ref=explicit_ref,
            expected_project_ref=expected_ref,
            actual_sql_sha256="a" * 64,
            expected_sql_sha256=expected_hash,
            confirmation=confirmation,
        )


def test_apply_guard_accepts_only_exact_bound_intent() -> None:
    digest = "a" * 64
    run_migration._guard_apply_target(
        ref="prodref",
        explicit_project_ref="prodref",
        expected_project_ref="prodref",
        actual_sql_sha256=digest,
        expected_sql_sha256=digest,
        confirmation=f"APPLY:prodref:{digest}",
    )


def test_cmd_apply_rejects_before_management_api_call(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = 0

    def forbidden_query(*args, **kwargs):
        nonlocal calls
        calls += 1
        raise AssertionError("network call must not happen")

    monkeypatch.setattr(run_migration, "_mgmt_query", forbidden_query)
    with pytest.raises(SystemExit):
        run_migration.cmd_apply(
            {"SUPABASE_MIGRATION_TOKEN": "not-a-real-token"},
            _sql(tmp_path),
            "prodref",
            False,
            explicit_project_ref="prodref",
            expected_project_ref="wrongref",
            expected_sql_sha256="a" * 64,
            confirmation="wrong",
        )
    assert calls == 0
