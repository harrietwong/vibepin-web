from __future__ import annotations

from pathlib import Path


BACKEND = Path(__file__).resolve().parents[1]
DB = BACKEND / "db"


def _sql(name: str) -> str:
    return (DB / name).read_text(encoding="utf-8").replace("\r\n", "\n")


def test_v66_rollback_is_idempotent_and_fails_closed_on_quantity_data() -> None:
    sql = _sql("rollback_v66_creem_subscription_units.sql")
    assert "information_schema.columns" in sql
    assert "units_column_exists" in sql
    assert "where units <> 1" in sql
    assert "errcode = 'P0001'" in sql
    assert "rollback_v66 blocked" in sql
    assert "alter table if exists public.creem_subscriptions" in sql
    assert "drop column if exists units" in sql


def test_v66_rollback_never_silently_rewrites_or_deletes_subscription_rows() -> None:
    sql = _sql("rollback_v66_creem_subscription_units.sql").lower()
    assert "delete from" not in sql
    assert "update public.creem_subscriptions" not in sql
    assert "truncate" not in sql
    assert "drop table" not in sql


def test_v67_rollback_drops_only_the_exact_rpc_signature() -> None:
    sql = _sql("rollback_v67_remove_connection_if_unscheduled.sql")
    statements = [part.strip() for part in sql.split(";") if part.strip() and not part.lstrip().startswith("--")]
    assert "drop function if exists public.remove_social_connection_if_unscheduled(uuid, uuid)" in sql
    assert "drop table" not in sql.lower()
    assert "delete from" not in sql.lower()
    assert len(statements) <= 1


def test_integrated_forward_migrations_document_safe_rollback_order() -> None:
    v66 = _sql("migrate_v66_creem_subscription_units.sql")
    v67 = _sql("migrate_v67_remove_connection_if_unscheduled.sql")
    assert "Apply this FIRST" in v66
    assert "rolling back is `drop function`" in v67
